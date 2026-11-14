const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const Settings = require("../config/Settings");
const sessionStore = require("../config/sessionStore");
const log = require("../config/log").get();
const { getProvider } = require("../providers/registry");
const { getEnabledDefinitions } = require("../tools/definitions");
const { executeToolCall } = require("../tools/executor");
const { describeShellBrief } = require("../tools/shellInfo");
const { fetchMcpTools, callMcpTool } = require("../mcp/client");
const { planCompaction } = require("../context/compact");
const { formatTokenCount, estimateTextTokens, estimateMessageTokens } = require("../context/estimate");
const { computeBudget, pruneRounds, truncateToolResult, countToolCalls } = require("../context/guard");
const { applyEdit, lastUserMessageIndex } = require("../conversation/edit");
const { createApprovalGate } = require("./approvals");
const { isAbortError } = require("./abort");
const { handleCopyText: copyText } = require("./clipboard");
const { resolveModelId, resolveEffort } = require("./model-choice");

/**
 * @typedef {import("../context/estimate").ConversationMessage} ConversationMessage
 */

/**
 * @typedef {Object} ChatActivityRegistry
 * @property {(chatId: string, title: string, toolName: string, args: Record<string, any>) => void} start
 * @property {(chatId: string) => void} end
 * @property {(chatId: string, toolName: string, args: Record<string, any>) => Array<string>} warningsFor
 */

/**
 * @typedef {Object} ChatControllerHooks
 * @property {(sessionId: string) => boolean} canTakeSession - false when another chat owns it.
 * @property {(sessionId: string) => void} onSessionTaken - register ownership.
 * @property {(sessionId: string) => void} onSessionReleased - release ownership.
 * @property {(sessionId: string) => void} [onSessionUnavailable] - the session is shown by
 *   another chat; the host reveals that chat.
 * @property {(sessionId: string) => boolean} [isSessionBusy] - whether another chat
 *   currently shows this session (the dropdown marks it).
 * @property {() => void} onSessionsChanged - broadcast the session list to every chat.
 * @property {(sessionId: string, fromChatId: string) => void} onSessionDeleted - a chat deleted a session.
 * @property {(title: string) => void} onTitleChanged - update the tab/view title.
 * @property {(msg: Record<string, any>) => void} onMessage - host message not handled here (e.g. configureModels).
 * @property {ChatActivityRegistry} activity - in-flight tool registry shared by all chats.
 * @property {() => { available: number, maximum: number }} [getAgentCapacity]
 * @property {(options: import("./agent-run").AgentRunOptions & { parentChatId: string }) => Promise<string>} [runAgent]
 * @property {() => void} [abortOwnedAgents] - Cancel agents spawned by this chat.
 * @property {() => void} [onSelfStop] - This chat is itself an agent: the user
 *   pressed its own Stop button. Called only from the webview's
 *   `cancelMessage`, never from `abortAll`, so teardown paths cannot recurse.
 */

/**
 * @typedef {Object} ChatControllerOptions
 * @property {string} id - Stable chat id (sidebar chat or panel id).
 * @property {string} [sessionId] - Session to open; omit for a fresh chat.
 * @property {boolean} [restoreCurrent] - Sidebar only: restore the persisted current session.
 * @property {boolean} [persistCurrent] - Sidebar only: mirror session changes into the
 *   persisted "current session" pointer so a reload restores it.
 * @property {boolean} [isAgent] - This chat starts as a sub-agent run in its own tab.
 *   Agent mode is run-scoped: `runAgentTask` sets it and clears it when the run
 *   ends, so a tab the user keeps becomes an ordinary chat.
 * @property {string} [modelId] - Model the chat starts with.
 * @property {string} [reasoningEffort] - Reasoning effort the chat starts with.
 * @property {ChatControllerHooks} hooks
 */

/**
 * One chat: its conversation, its session, its model, its approvals and its
 * request lifecycle. Contains no webview knowledge — messages are pushed
 * through the sink installed by `attach`, which the view replaces whenever the
 * webview is recreated. That is what lets several chats share one extension
 * host without sharing state.
 *
 * @param {ChatControllerOptions} options
 */
function createChatController(options) {
  const { id: chatId, hooks } = options;
  const activity = hooks.activity;
  // Agent mode is *run-scoped*, not a permanent property of the chat: an agent
  // tab that the user keeps (and types into) is an ordinary chat afterwards, so
  // it must get the `agent` tool back and stop forwarding its own Stop to a run
  // that already ended.
  let agentRun = options.isAgent === true;
  const initialModelId = options.modelId;
  /** @type {Set<{ cancel: () => void }>} */
  const ownedAgents = new Set();

  /** @type {((msg: Record<string, any>) => void) | null} */
  let sink = null;
  /** @type {Array<ConversationMessage>} */
  let conversation = [];
  /** @type {AbortController | null} */
  let abortController = null;
  /** @type {string | null} */
  let currentSession = null;
  /** @type {string} */
  let activeModel = Settings.getDefaultModel();
  /** @type {string} */
  let reasoningEffort = Settings.getReasoningEffort() || "medium";
  /** @type {string | null} */
  let summary = null;
  let summaryTurns = 0;
  // Index into conversation of the first message NOT covered by the rolling
  // summary. Compaction is non-destructive: the transcript keeps every
  // message (the UI renders it all); only the model's view starts after this
  // index.
  let summaryCoversUpTo = 0;
  /** @type {string} */
  let title = "Chat";
  /** @type {boolean} */
  let disposed = false;
  // What the current turn produced, kept so a turn that is stopped or fails can
  // report its partial output instead of only its error. `turnStopReason` is
  // "budget" when the loop guard stopped it gracefully (not a failure).
  let turnStreamText = "";
  /** @type {"budget" | null} */
  let turnStopReason = null;
  // Only the sidebar chat mirrors its session into the persisted
  // "current session" pointer — editor tabs must not clobber what the sidebar
  // will restore on reload.
  const persistCurrentPointer = options.persistCurrent === true;

  const approvals = createApprovalGate({
    post: (msg) => post(msg),
    isVisible: () => sink !== null,
    getWarnings: (toolName, args) => activity.warningsFor(chatId, toolName, args),
  });

  // ── transport ──

  /**
   * Deliver a message to this chat's webview. Silently drops messages when no
   * view is attached (the view re-sends full state on attach).
   * @param {Record<string, any>} msg
   */
  function post(msg) {
    if (!sink) return;
    try {
      sink(msg);
    } catch (e) {
      log.appendLine("Chat " + chatId + ": post failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * Tell the webview whether a request is in flight, so the composer shows Stop
   * instead of Send. The webview cannot infer this: a run started by the host
   * (an agent tab) never passes through the UI's own send path.
   * @param {boolean} busy
   * @returns {void}
   */
  function postBusy(busy) {
    post({ type: "busyChanged", busy });
  }

  /**
   * Install (or replace) the message sink and replay the current state so a
   * freshly created webview shows the conversation.
   * @param {(msg: Record<string, any>) => void} nextSink
   */
  function attach(nextSink) {
    sink = nextSink;
    postModels();
    postSessions();
    if (currentSession) {
      post({ type: "sessionSwitched", sessionId: currentSession });
    }
    if (conversation.length > 0) {
      post({ type: "historyRestored", messages: conversation });
    }
    if (hooks.getAgentCapacity) post({ type: "agentCapacityChanged", capacity: hooks.getAgentCapacity() });
    // A recreated webview (tab moved, sidebar re-resolved) must not offer Send
    // while this chat is still working.
    postBusy(abortController !== null);
  }

  /**
   * Drop the sink. Call before the webview is disposed so no post lands on a
   * dead webview; the controller itself stays alive (it is disposable).
   */
  function detach() {
    sink = null;
  }

  // ── models & effort ──

  function postModels() {
    const models = Settings.getModels();
    // A model can be deleted in Settings while a chat is using it. Re-resolve
    // only when the chat's model no longer exists, so the dropdown never shows
    // a stale id — and never flickers away from a model the user just picked
    // (whose session write may still be in flight).
    if (models.length > 0 && !models.some((m) => m.id === activeModel)) {
      const session = findSession(currentSession);
      activeModel = resolveModelId(models, session && session.modelId, Settings.getDefaultModel());
    }
    log.appendLine("Chat " + chatId + ": posting modelsLoaded: " + models.length + " models");
    post({
      type: "modelsLoaded",
      models: models.map((m) => ({ id: m.id, name: m.name })),
      activeModel,
      reasoningEffort,
    });
  }

  /**
   * Re-resolve model and effort against the current configuration and the
   * session's stored values, then tell the webview.
   */
  function refreshModelChoiceFromSession() {
    const session = findSession(currentSession);
    activeModel = resolveModelId(Settings.getModels(), session && session.modelId, Settings.getDefaultModel());
    reasoningEffort = resolveEffort(session && session.reasoningEffort, Settings.getReasoningEffort());
  }

  /**
   * @param {string} modelId
   */
  function setModel(modelId) {
    if (!modelId) return;
    activeModel = modelId;
    // The last model picked anywhere becomes the default for new chats, so a
    // new tab opens with the model you were just using.
    void Settings.setDefaultModel(modelId);
    void persistSessionFields({ modelId });
    postModels();
  }

  /**
   * @param {string} effort
   */
  function setReasoningEffort(effort) {
    if (!effort) return;
    reasoningEffort = effort;
    void Settings.setReasoningEffort(effort);
    void persistSessionFields({ reasoningEffort: effort });
    postModels();
  }

  // ── sessions ──

  /**
   * Mirror the active session into the persisted "current session" pointer.
   * Only the sidebar chat does this (see `persistCurrentPointer`).
   * @param {string} sessionId
   */
  function setCurrentPointer(sessionId) {
    if (!persistCurrentPointer) return;
    void Settings.setCurrentSessionId(sessionId);
  }

  /**
   * @param {string | null} sessionId
   * @returns {import("../config/Settings").Session | undefined}
   */
  function findSession(sessionId) {
    if (!sessionId) return undefined;
    return Settings.getSessions().find((s) => s.id === sessionId);
  }

  /**
   * Load a session's messages/summary into memory. Does not persist anything.
   * @param {string | null} sessionId
   * @param {import("../config/Settings").Session | undefined} session
   */
  function loadIntoMemory(sessionId, session) {
    currentSession = sessionId;
    conversation = (session && session.messages) || [];
    ensureMessageIds();
    summary = (session && session.summary) || null;
    summaryTurns = (session && session.summaryTurns) || 0;
    summaryCoversUpTo = (session && session.summaryCoversUpTo) || 0;
    title = (session && session.title) || "Chat";
    refreshModelChoiceFromSession();
    if (sessionId) hooks.onSessionTaken(sessionId);
    hooks.onTitleChanged(title);
  }

  /**
   * Restore whatever session the workspace was last on (sidebar default).
   */
  function restoreCurrentSession() {
    const sessionId = Settings.getCurrentSessionId() || null;
    if (!sessionId) {
      refreshModelChoiceFromSession();
      return;
    }
    // Another chat may already be showing it (e.g. an editor tab opened during
    // a reload); start fresh rather than stealing the conversation.
    if (!hooks.canTakeSession(sessionId)) {
      currentSession = null;
      refreshModelChoiceFromSession();
      return;
    }
    const session = findSession(sessionId);
    if (!session) {
      refreshModelChoiceFromSession();
      return;
    }
    loadIntoMemory(sessionId, session);
  }

  /**
   * Open a specific session (editor tab created for an existing session).
   * @param {string} sessionId
   * @returns {boolean} false when the session does not exist or is taken.
   */
  function openSession(sessionId) {
    if (!hooks.canTakeSession(sessionId)) return false;
    const session = findSession(sessionId);
    if (!session) return false;
    loadIntoMemory(sessionId, session);
    // The session carries its own model/effort: refresh the dropdown.
    postModels();
    if (conversation.length > 0) {
      post({ type: "sessionSwitched", sessionId });
      post({ type: "historyRestored", messages: conversation });
    }
    postSessions();
    return true;
  }

  /**
   * Assign stable ids to any user messages that lack one (sessions created
   * before message ids existed), so the edit feature can reference them.
   * Mutates the conversation in place; ids are persisted on the next save.
   */
  function ensureMessageIds() {
    conversation.forEach((m, i) => {
      if (m.role === "user" && !m.id) {
        m.id = "msg-" + Date.now() + "-" + i;
      }
    });
  }

  function ensureSession() {
    if (!currentSession) {
      currentSession = sessionStore.newSessionId();
      setCurrentPointer(currentSession);
      hooks.onSessionTaken(currentSession);
    }
    return currentSession;
  }

  /**
   * Write a sub-set of the current session's fields without touching messages.
   * Used for the per-chat model and reasoning effort.
   * @param {Record<string, any>} fields
   * @returns {Promise<void>}
   */
  async function persistSessionFields(fields) {
    if (disposed) return;
    if (!currentSession) return;
    const sessionId = currentSession;
    try {
      await Settings.mutateSessions((sessions) => {
        const existing = sessions.find((s) => s && s.id === sessionId);
        if (!existing) return; // empty session created before the first message
        Object.assign(existing, fields);
      });
    } catch (e) {
      log.appendLine("Chat " + chatId + ": saving session fields failed: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  /**
   * Persist the conversation. Never saves empty sessions. Serialized through
   * Settings.mutateSessions so two chats saving at once cannot drop one
   * another's write.
   * @returns {Promise<void>}
   */
  async function saveSession() {
    // A disposed chat must never write: its tab is gone, and a late save from
    // an aborted turn could otherwise resurrect a session the user deleted.
    if (disposed) return;
    if (conversation.length === 0) return;

    const sessionId = ensureSession();
    const now = new Date().toISOString();
    const messages = conversation;
    const nextTitle = sessionStore.titleFromConversation(messages);

    try {
      await Settings.mutateSessions((sessions) => {
        // Clean out any other empty sessions (placeholders from "new chat").
        const kept = sessionStore.withoutEmptySessions(sessions);
        sessions.length = 0;
        sessions.push(...kept);

        const existing = sessions.find((s) => s && s.id === sessionId);
        const fields = {
          messages,
          summary: summary || undefined,
          summaryTurns: summaryTurns || 0,
          summaryCoversUpTo: summaryCoversUpTo || 0,
          updatedAt: now,
          modelId: activeModel || undefined,
          reasoningEffort,
        };
        if (existing) {
          Object.assign(existing, fields);
          // Auto-title from the first user message while the title is generic.
          if (!existing.title || existing.title.startsWith("Chat ")) {
            existing.title = nextTitle;
          }
        } else {
          sessions.push({
            id: sessionId,
            title: nextTitle,
            createdAt: now,
            ...fields,
          });
        }
        const written = sessions.find((s) => s.id === sessionId);
        if (written && written.title && written.title !== title) {
          title = written.title;
          hooks.onTitleChanged(title);
        }
      });
    } catch (e) {
      log.appendLine("Chat " + chatId + ": save session failed: " + (e instanceof Error ? e.message : String(e)));
      return;
    }
    hooks.onSessionsChanged();
  }

  function postSessions() {
    const sessions = sessionStore.withoutEmptySessions(Settings.getSessions());
    // Sessions another chat is showing right now: the dropdown marks them, so
    // "open in a tab" is not a surprise (it reveals that chat instead).
    const busySessionIds =
      typeof hooks.isSessionBusy === "function"
        ? sessions.map((s) => s.id).filter((id) => id !== currentSession && hooks.isSessionBusy(id))
        : [];
    post({
      type: "sessionsLoaded",
      sessions,
      currentSessionId: currentSession || "",
      busySessionIds,
    });
  }

  function newSession() {
    void saveSession();
    // Pending approvals belong to the old session — deny them all.
    approvals.rejectAll("Session changed");
    approvals.resetSession();
    releaseSession();
    currentSession = null;
    conversation = [];
    summary = null;
    summaryTurns = 0;
    summaryCoversUpTo = 0;
    title = "Chat";
    setCurrentPointer("");
    hooks.onTitleChanged(title);
    refreshModelChoiceFromSession();
    postSessions();
    postModels();
    post({ type: "sessionSwitched", sessionId: "" });
    post({ type: "historyRestored", messages: [] });
  }

  /**
   * @param {string} sessionId
   */
  function switchSession(sessionId) {
    if (sessionId === currentSession) {
      postSessions();
      return;
    }
    if (!hooks.canTakeSession(sessionId)) {
      post({ type: "error", messageId: "", error: "That session is open in another CCE chat. Switch to it there instead." });
      postSessions();
      // Take the user to the chat that already shows it, so the refusal is not
      // a dead end.
      if (hooks.onSessionUnavailable) hooks.onSessionUnavailable(sessionId);
      return;
    }
    void saveSession();
    approvals.rejectAll("Session switched");
    approvals.resetSession();
    const session = findSession(sessionId);
    if (!session) {
      postSessions();
      return;
    }
    releaseSession();
    setCurrentPointer(sessionId);
    loadIntoMemory(sessionId, session);
    postModels();
    post({ type: "sessionSwitched", sessionId });
    post({ type: "historyRestored", messages: conversation });
    postSessions();
  }

  /** Release ownership of the current session (another chat may open it). */
  function releaseSession() {
    if (currentSession) hooks.onSessionReleased(currentSession);
  }

  /**
   * Another chat deleted the session this chat is showing. Drop it here too,
   * otherwise the next save would resurrect the deleted session.
   * @param {string} sessionId
   */
  function forgetSession(sessionId) {
    if (currentSession !== sessionId) return;
    releaseSession();
    currentSession = null;
    conversation = [];
    summary = null;
    summaryTurns = 0;
    summaryCoversUpTo = 0;
    title = "Chat";
    setCurrentPointer("");
    hooks.onTitleChanged(title);
    post({ type: "sessionSwitched", sessionId: "" });
    post({ type: "historyRestored", messages: [] });
    postSessions();
  }

  /**
   * @param {string} sessionId
   */
  function deleteSession(sessionId) {
    const deletingCurrent = currentSession === sessionId;
    if (deletingCurrent) {
      approvals.rejectAll("Session deleted");
      approvals.resetSession();
      releaseSession();
      // Drop the transcript before any save happens: switchSession persists
      // the current chat first, which would otherwise resurrect the entry we
      // are deleting.
      currentSession = null;
      conversation = [];
      summary = null;
      summaryTurns = 0;
      summaryCoversUpTo = 0;
    }
    void Settings.mutateSessions((sessions) => {
      const remaining = sessions.filter((s) => s && s.id !== sessionId);
      sessions.length = 0;
      sessions.push(...remaining);
    }).then(() => {
      const sessions = sessionStore.withoutEmptySessions(Settings.getSessions());
      if (deletingCurrent && sessions.length > 0) {
        switchSession(sessions[0].id);
      } else if (deletingCurrent) {
        title = "Chat";
        setCurrentPointer("");
        hooks.onTitleChanged(title);
        post({ type: "sessionSwitched", sessionId: "" });
        post({ type: "historyRestored", messages: [] });
        postSessions();
      } else {
        postSessions();
      }
      hooks.onSessionDeleted(sessionId, chatId);
    });
  }

  // ── messaging ──

  /**
   * @param {string} messageId
   * @param {string} error
   */
  function postError(messageId, error) {
    post({ type: "error", messageId, error });
  }

  /**
   * Handle a request to start editing a message. Only the most recent user
   * message is editable; anything else is rejected. The webview populates its
   * composer from the returned content — the host is the source of truth, so
   * stale webview state (e.g. after compaction) cannot edit a message the
   * host no longer has.
   * @param {string} messageId
   */
  function handleEditMessage(messageId) {
    if (!messageId) return;
    if (abortController) {
      post({ type: "editRejected", id: messageId, reason: "Wait for the current response to finish before editing." });
      return;
    }
    const idx = lastUserMessageIndex(conversation);
    if (idx < 0 || conversation[idx].id !== messageId) {
      post({ type: "editRejected", id: messageId, reason: "Only the most recent message can be edited." });
      return;
    }
    const msg = conversation[idx];
    post({ type: "editAccepted", id: messageId, content: msg.content || "", images: msg.images || [] });
  }

  /**
   * Run one turn of this conversation.
   *
   * Resolves to an outcome rather than throwing, because a caller that owns
   * something outside this chat (the manager, for a sub-agent run) needs to know
   * *why* the turn ended. Before this, every failure was posted to the webview
   * and forgotten, so a crashed agent run was reported to its parent as a
   * successful empty answer.
   *
   * @param {string} messageId
   * @param {string} text
   * @param {Array<{ id: string, name: string, dataUrl: string, size: number, warning: boolean }>} [images]
   * @param {string} [editingId] - when set, this is an edit confirm: replace
   *   the most recent user message with text/images and regenerate from there
   * @param {AbortSignal} [externalSignal] - the host's own signal (an agent run
   *   owned by the manager); aborting it cancels this request too
   * @returns {Promise<import("./agent-run").TurnOutcome>}
   */
  async function handleSendMessage(messageId, text, images, editingId, externalSignal) {
    /** @param {string} message */
    const fail = (message) => {
      postError(messageId, message);
      return /** @type {import("./agent-run").TurnOutcome} */ ({ ok: false, aborted: false, error: message, text: "" });
    };

    const models = Settings.getModels();
    const modelConfig = models.find((m) => m.id === activeModel) || models[0];
    if (!modelConfig) return fail("No model configured. Click the settings gear to add one.");
    activeModel = modelConfig.id;

    const apiKey = (await Settings.getApiKey(modelConfig.id)) || "";
    const provider = getProvider(modelConfig.provider);
    if (!provider) return fail("Unknown provider: " + modelConfig.provider);
    if (editingId) {
      // Edit confirm: replace the most recent user message in place and drop
      // everything after it (the old reply and any tool activity). The edit
      // is persisted before the request runs, so an aborted regeneration
      // still keeps the truncation. Pending approvals belonged to the turn
      // being discarded, so they are rejected.
      if (abortController) return fail("Wait for the current response to finish before editing.");
      const result = applyEdit(conversation, editingId, text, images || []);
      if (!result.ok) return fail("Can't edit message: " + result.reason);
      approvals.rejectAll("Message edited");
      conversation = result.conversation;
      // Editing truncates the conversation; the summary must not reach past
      // the new end. (The summary may now describe messages that were edited
      // away — mildly stale, but harmless and keeps the compaction benefit.)
      summaryCoversUpTo = Math.min(summaryCoversUpTo, conversation.length);
      ensureSession();
      await saveSession();
      post({ type: "historyRestored", messages: conversation });
    } else {
      conversation.push({ role: "user", content: text, images: images || [], id: messageId });
      ensureSession();
    }
    // Reset the per-turn bookkeeping the outcome report reads.
    turnStreamText = "";
    turnStopReason = null;

    // Gather enabled tools. The manager's capacity callback includes all live
    // agents across every chat, so the model sees current global capacity.
    const toolSettings = { ...Settings.getToolSettings() };
    if (agentRun) toolSettings.agent = false;
    let tools = getEnabledDefinitions(toolSettings, hooks.getAgentCapacity ? hooks.getAgentCapacity() : undefined);

    // Fetch MCP tools (both HTTP and stdio)
    try {
      const mcpTools = await fetchMcpTools();
      tools = tools.concat(mcpTools);
    } catch (e) {
      log.appendLine("MCP fetch FAILED: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
    }

    // Build system prompt with context flags and AGENTS.md
    let systemPrompt = Settings.getSystemPrompt() || "";

    // Inject AGENTS.md content if enabled
    if (Settings.getUseAgentsMd()) {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const agentsPath = path.join(workspaceFolders[0].uri.fsPath, Settings.getAgentsMdPath());
          if (fs.existsSync(agentsPath)) {
            const agentsContent = fs.readFileSync(agentsPath, "utf-8");
            systemPrompt = "<!-- AGENTS.md / Project Instructions -->\n" + agentsContent + "\n\n" + systemPrompt;
          }
        }
      } catch (e) {
        log.appendLine("Failed to read AGENTS.md: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    // Inject context flags
    const contextFlags = Settings.getContextFlags();
    const contextParts = [];
    const now = new Date();
    if (contextFlags.includeDate !== false) {
      contextParts.push("Current date: " + now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
    }
    if (contextFlags.includeOS !== false) {
      contextParts.push("Platform/OS: " + process.platform);
      // Shell used by the run_command tool (child_process.exec), not the user's terminal
      contextParts.push(describeShellBrief());
    }
    if (contextFlags.includeRegion !== false) {
      contextParts.push("Locale: " + (Intl.DateTimeFormat().resolvedOptions().locale || "unknown") + ", Timezone: " + (Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"));
    }
    if (contextParts.length > 0) {
      systemPrompt = "<!-- Context -->\n" + contextParts.join("\n") + "\n\n" + systemPrompt;
    }

    // Tools may require user approval before executing
    if (tools.length > 0) {
      systemPrompt +=
        "\n\nImportant: Some tool calls require user approval. If a tool call is denied or returns an approval error, " +
        "do not retry the same tool call. Adapt your answer based on the information you already have.";
    }

    // The abort controller is created up-front so the user's Stop button also
    // cancels a compaction pass that may run before the main request.
    abortController = new AbortController();
    // Show Stop before the first token can arrive: the provider call, MCP
    // discovery and compaction may all take long enough that no event reaches
    // the webview for a while.
    postBusy(true);
    const abortExternal = () => abortController && abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abortExternal();
      else externalSignal.addEventListener("abort", abortExternal, { once: true });
    }

    // Auto-compaction: fold older turns into a rolling summary when the
    // estimated request size passes the configured threshold. Non-destructive:
    // the summary covers the leading `summaryCoversUpTo` messages and the
    // transcript itself is never trimmed, so only the un-summarized tail is
    // considered here — already-summarized turns are never folded twice.
    const compaction = Settings.getCompaction();
    // The loop guard derives its per-request budget from the same threshold:
    // threshold minus a proportional output/reasoning reserve (OpenCode's
    // formula), so a request is never sent when it would overflow.
    const budget = computeBudget(compaction.threshold);
    if (compaction.mode !== "off") {
      const plan = planCompaction({
        systemPrompt,
        messages: conversation.slice(summaryCoversUpTo),
        threshold: compaction.threshold,
        keepTurns: compaction.keepTurns,
        summary,
      });
      if (plan.shouldCompact) {
        log.appendLine(
          "Compaction: estimate " + plan.estimate + " > threshold " + compaction.threshold +
          ", folding " + plan.old.length + " messages"
        );
        let proceed = true;
        if (compaction.mode === "ask" && !agentRun) {
          const choice = await vscode.window.showWarningMessage(
            "Conversation is ~" + formatTokenCount(plan.estimate) +
            " tokens — over your " + formatTokenCount(compaction.threshold) +
            " compaction threshold. Compact older messages into a summary?",
            { modal: false },
            "Compact",
            "Send anyway"
          );
          proceed = choice === "Compact";
        } else if (compaction.mode === "ask") {
          // An agent tab is unattended: asking would hang the run (and the
          // parent's `agent` tool) on a notification nobody is watching. Compact
          // like "auto" — the tab's own Stop still cancels the run.
          log.appendLine("Compaction: agent run, compacting without asking");
        }
        if (proceed) {
          await compact(plan, modelConfig, apiKey, provider);
          // The user may have hit Stop during the compaction call. Leave the
          // chat settled: a leftover aborted controller would keep `isBusy`
          // true (and the webview on Stop) until the next send.
          if (abortController && abortController.signal.aborted) {
            abortController = null;
            if (externalSignal) externalSignal.removeEventListener("abort", abortExternal);
            post({ type: "responseComplete", messageId });
            postBusy(false);
            return { ok: false, aborted: true, error: null, text: "" };
          }
        }
      }
    }

    const messages = convertToChatMessages(systemPrompt);
    log.appendLine("Chat " + chatId + ": sending " + tools.length + " total tools to model");

    try {
      await chatLoop(messageId, messages, modelConfig, apiKey, provider, tools, budget);
      if (turnStopReason === "budget") {
        // A graceful guard stop is not a failure: the chat has a partial answer
        // and told the user why. The run that owns this turn is told the same.
        return { ok: false, aborted: false, error: null, text: turnStreamText, stopReason: "budget" };
      }
      return { ok: true, aborted: false, error: null, text: turnStreamText };
    } catch (err) {
      if (isAbortError(err)) {
        post({ type: "responseComplete", messageId });
        return { ok: false, aborted: true, error: null, text: turnStreamText };
      }
      const message = err instanceof Error ? err.message : String(err);
      postError(messageId, message);
      return { ok: false, aborted: false, error: message, text: turnStreamText };
    } finally {
      abortController = null;
      if (externalSignal) externalSignal.removeEventListener("abort", abortExternal);
      // Last, so a webview that reacts by sending again sees a settled chat.
      postBusy(false);
    }
  }

  /**
   * Run a rolling-summary compaction: ask the model to fold the old turns
   * into a summary, then advance the model-view boundary past them. The
   * summarization request only contains the previous summary plus the old
   * turns, so it is always small. Never blocks the send — on any failure the
   * conversation is left untouched and the request proceeds as-is.
   * @param {import("../context/compact").CompactionPlan} plan
   * @param {import("../config/Settings").ModelConfig} modelConfig
   * @param {string} apiKey
   * @param {import("../providers/registry").Provider} provider
   * @returns {Promise<void>}
   */
  async function compact(plan, modelConfig, apiKey, provider) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const signal = abortController ? abortController.signal : undefined;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort);
    }
    // A stuck summarization must never block the send forever.
    const timer = setTimeout(() => controller.abort(), 60000);

    post({ type: "toolStatus", text: "Compacting conversation\u2026" });

    try {
      const result = await provider.chat(
        /** @type {Array<import("../providers/openai").ChatMessage>} */ (plan.compactRequest),
        modelConfig.modelId,
        modelConfig.endpoint,
        apiKey,
        () => {}, // no streaming for the summary call
        controller.signal,
        undefined, // no tools — just summarize
        undefined, // no thinking callback
        "off", // no generated reasoning; explicit per-model parameters still apply
        modelConfig.requestParameters
      );
      if (!result.text || !result.text.trim()) {
        log.appendLine("Compaction: model returned an empty summary");
        return;
      }
      const prevSummary = summary; // capture before overwriting
      summary = result.text.trim();
      const oldUserTurns = plan.old.filter((m) => m.role === "user").length;
      summaryTurns += oldUserTurns;
      // Non-destructive: keep the full transcript (the UI renders it all);
      // only the model's view advances past the folded turns.
      summaryCoversUpTo = Math.min(summaryCoversUpTo + plan.old.length, conversation.length);
      await saveSession();
      // True token reduction: previous summary + folded turns − new summary.
      const tokensSaved =
        estimateTextTokens(prevSummary || "") +
        plan.old.reduce((acc, m) => acc + estimateMessageTokens(m), 0) -
        estimateTextTokens(summary);
      log.appendLine("Compaction: summary now covers " + summaryTurns + " turns (messages 0.." + summaryCoversUpTo + " of " + conversation.length + " summarized for the model)");
      post({
        type: "compactionNotice",
        text:
          "Compacted " + plan.old.length + " older message" + (plan.old.length > 1 ? "s" : "") +
          " into a summary (~" + formatTokenCount(Math.max(0, tokensSaved)) +
          " tokens saved). The model now sees a summary of the older part — your full transcript remains visible below.",
      });
    } catch (e) {
      if (!isAbortError(e)) {
        log.appendLine("Compaction failed: " + (e instanceof Error ? e.message : String(e)));
        post({
          type: "compactionNotice",
          text: "Compaction failed \u2014 sending without compacting. (" + (e instanceof Error ? e.message : String(e)) + ")",
        });
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * @param {string} messageId
   * @param {Array<import("../providers/openai").ChatMessage>} messages
   * @param {import("../config/Settings").ModelConfig} modelConfig
   * @param {string} apiKey
   * @param {import("../providers/registry").Provider} provider
   * @param {Array<import("../tools/definitions").ToolDefinition>} tools
   * @param {number} [budget] - per-request token budget from the loop guard
   * @returns {Promise<void>}
   */
  async function chatLoop(messageId, messages, modelConfig, apiKey, provider, tools, budget) {
    const signal = abortController ? abortController.signal : undefined;
    if (signal && signal.aborted) {
      // Stop button was hit between rounds — unwind cleanly instead of
      // calling the provider with a dead signal.
      post({ type: "responseComplete", messageId });
      return;
    }
    // Loop guard: before EVERY model call (first send and each re-send),
    // estimate the request and prune old tool rounds to fit the budget. If
    // even that cannot fit, stop gracefully — a doomed request is never sent.
    if (typeof budget === "number" && budget > 0) {
      const guard = pruneRounds(messages, budget);
      if (guard.droppedRounds > 0) {
        log.appendLine("Loop guard: pruned " + guard.droppedRounds + " tool round(s) (~" + formatTokenCount(guard.freedTokens) + " tokens) to fit budget " + formatTokenCount(budget));
      }
      if (guard.overBudget) {
        const rounds = messages.filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0).length;
        const toolCounts = countToolCalls(messages);
        const toolList = Object.keys(toolCounts).length
          ? Object.entries(toolCounts).map(([n, c]) => n + " ×" + c).join(", ")
          : "none";
        const text =
          "Context budget reached — I stopped before sending a request that would have exceeded it.\n\n" +
          "Estimated request size: ~" + formatTokenCount(guard.estimate) + " tokens (budget: " + formatTokenCount(budget) + " tokens).\n" +
          "Tool rounds executed: " + rounds + (toolList !== "none" ? " (" + toolList + ")" : "") + ".\n\n" +
          "The results gathered so far are shown above. To continue, raise the compaction trigger threshold in settings, or split the request into smaller steps.";
        conversation.push({ role: "assistant", content: text });
        await saveSession();
        turnStopReason = "budget";
        turnStreamText = turnStreamText ? turnStreamText + "\n\n" + text : text;
        post({ type: "partialResponse", messageId, text });
        post({ type: "responseComplete", messageId });
        post({
          type: "contextStopped",
          text:
            "Context budget reached — stopped after " + rounds + " tool round" + (rounds === 1 ? "" : "s") +
            " rather than sending an oversized request (~" + formatTokenCount(guard.estimate) +
            " tokens vs " + formatTokenCount(budget) + " budget). Raise the compaction trigger threshold to allow larger requests.",
        });
        return;
      }
    }
    let requestTools = tools;
    if (hooks.getAgentCapacity && tools.some((tool) => tool.function.name === "agent")) {
      const currentAgentTool = getEnabledDefinitions({ ...Settings.getToolSettings(), agent: true }, hooks.getAgentCapacity())
        .find((tool) => tool.function.name === "agent");
      if (currentAgentTool) {
        requestTools = tools.map((tool) => tool.function.name === "agent" ? currentAgentTool : tool);
      }
    }
    const result = await provider.chat(
      messages, modelConfig.modelId, modelConfig.endpoint, apiKey,
      (chunk) => {
        turnStreamText += chunk;
        post({ type: "partialResponse", messageId, text: chunk });
      },
      signal,
      requestTools.length > 0 ? requestTools : undefined,
      (thinking) => post({ type: "thinkingDelta", messageId, text: thinking }),
      reasoningEffort,
      modelConfig.requestParameters
    );

    if (result.toolCalls && result.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: null, tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        let toolResult, toolArgs;
        try {
          toolArgs = JSON.parse(tc.function.arguments || "{}");
        } catch (e) {
          toolResult = "Error: invalid tool arguments: " + (e instanceof Error ? e.message : String(e));
          toolArgs = {};
        }

        // Approval gate — no tool executes without passing the policy check
        const decision = await approvals.request(tc.function.name, toolArgs);
        if (decision.decision !== "allow") {
          toolResult =
            "Error: user denied approval for tool `" + tc.function.name + "`" +
            (decision.reason ? " (" + decision.reason + ")" : "") +
            ". Do not retry this tool call — adapt your answer without it.";
        } else {
          // Render the tool box up-front with args and a "Running …" line,
          // then finalize it in place once the tool returns. The command is
          // already visible in the box's args body, so the running line only
          // shows the tool name.
          const runningText = "Running " + tc.function.name;
          post({
            type: "toolStart",
            messageId,
            toolId: tc.id,
            toolName: tc.function.name,
            args: JSON.stringify(toolArgs, null, 2),
            runningText,
          });
          // Announce the in-flight tool so other chats can warn about a
          // conflict in their own approval cards.
          activity.start(chatId, title, tc.function.name, toolArgs);
          try {
            // Route MCP tools to the MCP client
            if (tc.function.name.startsWith("mcp__")) {
              const parts = tc.function.name.split("__");
              const serverId = parts[1];
              const toolName = parts.slice(2).join("__");
              toolResult = await callMcpTool(serverId, toolName, toolArgs);
            } else if (tc.function.name === "agent") {
              // The manager reserves available slots atomically before creating
              // visible child chats, and reports each child's outcome back.
              // Approving the `agent` call is not a blanket grant: every child
              // asks for its own tool calls in its own tab, exactly like a chat
              // the user started (and an explicit `deny` policy still wins).
              if (hooks.runAgent && !agentRun) {
                toolResult = await hooks.runAgent({
                  parentChatId: chatId,
                  tasks: toolArgs.tasks || [],
                  modelConfig,
                  reasoningEffort,
                  signal,
                });
              } else if (agentRun) {
                toolResult = "Error: agents cannot recursively spawn sub-agents.";
              } else {
                toolResult = "Error: sub-agents are not available in this chat.";
              }
            } else {
              toolResult = await executeToolCall(
                tc.function.name,
                toolArgs,
                signal,
                (scanned, total) => {
                  post({
                    type: "toolDelta",
                    messageId,
                    toolId: tc.id,
                    runningText: runningText + " — scanned " + scanned + "/" + total + " files",
                  });
                }
              );
            }
          } catch (e) {
            // Aborts must propagate: the request was cancelled, so stop the
            // loop entirely instead of reporting "Error: Aborted" and recursing
            // with a dead signal (which would zombie on past the cancel).
            if (isAbortError(e)) {
              // Finalize the open tool box so it doesn't sit on "Running …"
              // forever after the user cancels mid-tool.
              post({
                type: "toolCall",
                messageId,
                toolId: tc.id,
                toolName: tc.function.name,
                args: JSON.stringify(toolArgs, null, 2),
                result: "Aborted by user",
              });
              throw e;
            }
            toolResult = "Error: " + (e instanceof Error ? e.message : String(e));
          } finally {
            activity.end(chatId);
          }
        }

        // Show tool details in chat
        post({
          type: "toolCall",
          messageId,
          toolId: tc.id,
          toolName: tc.function.name,
          args: JSON.stringify(toolArgs, null, 2),
          result: String(toolResult).slice(0, 2000),
        });

        messages.push({ role: "tool", tool_call_id: tc.id, content: truncateToolResult(toolResult) });
      }
      await chatLoop(messageId, messages, modelConfig, apiKey, provider, tools, budget);
      return;
    }

    conversation.push({ role: "assistant", content: result.text });
    await saveSession();

    log.appendLine("Response: text=" + (result.text ? result.text.length + " chars" : "empty") + ", thinking=" + (result.thinking ? result.thinking.length + " chars" : "none"));

    // If the model only produced thinking/reasoning but no text,
    // send the thinking content as the visible response
    if (!result.text && result.thinking) {
      log.appendLine("Fallback: sending thinking as response");
      post({ type: "partialResponse", messageId, text: result.thinking });
    }
    // A provider that does not stream gives us the answer only here; keep it so
    // the turn's outcome can report what was actually produced.
    if (result.text) turnStreamText = result.text;
    else if (result.thinking) turnStreamText = result.thinking;

    post({ type: "responseComplete", messageId });
  }

  // ── image attachment ──

  async function handleAttachImage() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
      title: "Attach Images",
    });
    if (!uris || uris.length === 0) return;

    const result = await validateAndEncodeImages(uris);
    if (result.images.length > 0) {
      post({ type: "imagesAttached", images: result.images });
    }
    if (result.errors.length > 0) {
      post({ type: "imagesAttachedError", errors: result.errors });
    }
  }

  /**
   * @param {Array<vscode.Uri>} uris
   */
  async function validateAndEncodeImages(uris) {
    const images = [];
    const errors = [];
    const MAX_SOFT = 5 * 1024 * 1024; // 5MB
    const MAX_HARD = 20 * 1024 * 1024; // 20MB

    for (const uri of uris) {
      try {
        const stat = await fs.promises.stat(uri.fsPath);
        if (stat.size > MAX_HARD) {
          errors.push({ name: path.basename(uri.fsPath), error: "File exceeds 20MB limit (" + (stat.size / 1024 / 1024).toFixed(1) + "MB)" });
          continue;
        }
        const ext = path.extname(uri.fsPath).toLowerCase().replace(".", "");
        /** @type {Record<string, string>} */
        const mimeTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
        const mime = mimeTypes[ext] || "image/png";
        const buffer = await fs.promises.readFile(uri.fsPath);
        const dataUrl = "data:" + mime + ";base64," + buffer.toString("base64");
        images.push({
          id: "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          name: path.basename(uri.fsPath),
          dataUrl,
          size: stat.size,
          warning: stat.size > MAX_SOFT,
        });
      } catch (e) {
        errors.push({ name: path.basename(uri.fsPath), error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { images, errors };
  }

  /**
   * Convert the in-memory conversation plus system prompt into
   * OpenAI-style chat messages (including image content parts).
   * @param {string} systemPrompt
   * @returns {Array<import("../providers/openai").ChatMessage>}
   */
  function convertToChatMessages(systemPrompt) {
    const messages = [];
    if (systemPrompt.trim()) {
      messages.push({ role: "system", content: systemPrompt.trim() });
    }
    // The rolling summary of compacted older turns rides along as a second
    // system message. Both providers accept it: Anthropic joins all system
    // messages into its top-level `system` field, OpenAI passes them through.
    // Only the un-summarized tail of the transcript is sent (the summary
    // stands in for everything before `summaryCoversUpTo`).
    if (summary && summaryCoversUpTo > 0) {
      messages.push({
        role: "system",
        content: "Summary of earlier messages (older turns were compacted to save context — the model sees this summary of the older part; the full transcript remains visible in the chat):\n" + summary,
      });
    }
    for (let i = summaryCoversUpTo; i < conversation.length; i++) {
      const m = conversation[i];
      if (m.images && m.images.length > 0) {
        /** @type {Array<import("../providers/openai").ContentPart>} */
        const content = [
          { type: "text", text: typeof m.content === "string" ? m.content : "" },
          ...m.images.map((img) => /** @type {import("../providers/openai").ContentPart} */ ({ type: "image_url", image_url: { url: img.dataUrl } })),
        ];
        messages.push({ role: m.role, content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return messages;
  }

  function handleCancel() {
    if (abortController) {
      // Deliberately NOT nulled here: the request is still unwinding. Keeping
      // the (now aborted) controller means any loop recursion re-captures an
      // aborted signal and stops, instead of continuing with `undefined` and
      // zombie-ing on after the cancel. handleSendMessage's finally nulls it.
      abortController.abort();
    }
    // Any tool calls waiting on approval belong to the cancelled request
    approvals.rejectAll("Request cancelled");
    for (const agent of ownedAgents) agent.cancel();
    activity.end(chatId);
  }

  // ── clipboard ──

  /**
   * Validate a webview copy request and acknowledge only after VS Code writes
   * the clipboard. Never echo clipboard text or raw platform errors to the UI.
   * @param {{ requestId?: unknown, text?: unknown }} msg
   * @param {vscode.Webview} webview The originating webview.
   * @returns {Promise<void>}
   */
  function handleCopyText(msg, webview) {
    return copyText(msg, webview, (text) => vscode.env.clipboard.writeText(text), log);
  }

  // ── message routing ──

  /**
   * Route one message from this chat's webview. Anything the chat itself does
   * not own (`configureModels`, the add-tab button) is forwarded to the
   * manager through `hooks.onMessage`.
   *
   * @param {Record<string, any>} msg
   * @param {vscode.Webview} [webview] - only needed by `copyText`.
   * @returns {void}
   */
  function handleMessage(msg, webview) {
    log.appendLine("Chat " + chatId + " received: " + msg.type);
    switch (msg.type) {
      case "setModel":
        setModel(msg.modelId);
        break;
      case "requestModels":
        postModels();
        break;
      case "requestState":
        // Sent once by the webview when its script is ready. The eager replay
        // in `attach` can race the document load (posts before the webview is
        // listening are dropped), so the view asks for everything again here.
        postModels();
        postSessions();
        if (currentSession) {
          post({ type: "sessionSwitched", sessionId: currentSession });
        }
        post({ type: "historyRestored", messages: conversation });
        if (hooks.getAgentCapacity) post({ type: "agentCapacityChanged", capacity: hooks.getAgentCapacity() });
        postBusy(abortController !== null);
        break;
      case "sendMessage":
        void handleSendMessage(msg.messageId, msg.text, msg.images, msg.editingId);
        break;
      case "editMessage":
        handleEditMessage(msg.id);
        break;
      case "cancelMessage":
        // An agent tab's Stop must reach the run that started it: only the
        // manager holds that signal, and without telling it the run would end
        // "successfully" with a truncated answer. `agentRun` is false once the
        // run ended (the tab may then be an ordinary chat).
        if (agentRun && hooks.onSelfStop) hooks.onSelfStop();
        handleCancel();
        break;
      case "attachImage":
        void handleAttachImage();
        break;
      case "copyText":
        // Reply to the originating webview, even if the view is recreated
        // while the clipboard operation is in flight.
        if (webview) void handleCopyText(msg, webview);
        break;
      case "newSession":
        newSession();
        break;
      case "switchSession":
        switchSession(msg.sessionId);
        break;
      case "deleteSession":
        deleteSession(msg.sessionId);
        break;
      case "setReasoningEffort":
        setReasoningEffort(msg.effort);
        break;
      case "requestSessions":
        postSessions();
        break;
      case "approvalResponse":
        approvals.handleResponse(msg);
        break;
      default:
        hooks.onMessage(msg);
        break;
    }
  }

  // ── lifecycle ──

  /**
   * Abort in-flight work and deny pending approvals. Does not persist — the
   * caller saves first when it wants that.
   */
  function abortAll() {
    handleCancel();
    if (hooks.abortOwnedAgents) hooks.abortOwnedAgents();
    approvals.dispose();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    abortAll();
    activity.end(chatId);
    // Drop ownership so the session can be reopened in another chat after this
    // one goes away (a closed tab must not leave the session locked).
    releaseSession();
    sink = null;
  }

  // ── initial state ──

  if (initialModelId && Settings.getModels().some((model) => model.id === initialModelId)) {
    activeModel = initialModelId;
  }
  if (options.sessionId) {
    const session = findSession(options.sessionId);
    loadIntoMemory(options.sessionId, session);
  } else if (options.restoreCurrent) {
    restoreCurrentSession();
  } else {
    refreshModelChoiceFromSession();
    if (initialModelId && Settings.getModels().some((model) => model.id === initialModelId)) {
      activeModel = initialModelId;
      if (options.reasoningEffort) reasoningEffort = options.reasoningEffort;
    }
  }

  return {
    id: chatId,
    attach,
    detach,
    dispose,
    abortAll,
    handleMessage,
    openSession,
    forgetSession,
    saveSession,
    postModels,
    postSessions,
    getTitle: () => title,
    getSessionId: () => currentSession,
    getModelId: () => activeModel,
    getReasoningEffort: () => reasoningEffort,
    getLastAssistantResponse: () => {
      const lastAssistant = [...conversation].reverse().find((message) => message.role === "assistant");
      return lastAssistant && typeof lastAssistant.content === "string" ? lastAssistant.content : "";
    },
    isBusy: () => abortController !== null,
    registerOwnedAgent: (agent) => {
      ownedAgents.add(agent);
      return () => ownedAgents.delete(agent);
    },
    onAgentCapacityChanged: () => {
      const capacity = hooks.getAgentCapacity ? hooks.getAgentCapacity() : null;
      if (sink && capacity) post({ type: "agentCapacityChanged", capacity });
    },
    /**
     * Run one task in this tab and report how it ended. The manager owns
     * capacity, the tab and cancellation; this only runs the turn.
     * @param {{ task: string, signal?: AbortSignal }} options
     * @returns {Promise<import("./agent-run").TurnOutcome>}
     */
    runAgentTask: async (options) => {
      agentRun = true;
      try {
        return await handleSendMessage("agent-progress", String(options.task), [], undefined, options.signal);
      } finally {
        // The run itself is over either way; the tab lives on as a normal chat.
        agentRun = false;
      }
    },
  };
}

/**
 * Thin wrapper kept so the controller module has a single MCP entry point.
 * @param {string} serverId
 * @param {string} toolName
 * @param {Record<string, any>} args
 * @returns {Promise<string>}
 */
module.exports = { createChatController };

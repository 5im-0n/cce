const vscode = require("vscode");
const Settings = require("../config/Settings");
const ModelConfigPanel = require("../config/ModelConfigPanel");
const log = require("../config/log").get();
const { createChatController } = require("./controller");
const { createActivityRegistry } = require("./activity");
const { createOwnership } = require("./ownership");
const { createSidebarViewHost, createEditorChatPanel, attachEditorChatPanel } = require("./view");
const { withoutEmptySessions } = require("../config/sessionStore");
const { PANEL_VIEW_TYPE, decodePanelState } = require("./panel-state");
const { normalizeTasks, formatAgentReport } = require("./agent-run");

/**
 * Owns every open chat and the rules that keep them from fighting.
 *
 * The sidebar chat is created lazily on first `resolveWebviewView`. Editor-tab
 * chats are created by `openChatTab`. Exactly one chat may own a session at a
 * time: attempting to open a session that another tab already holds reveals
 * that tab instead of forking the conversation.
 */

/** @type {string} */
const SIDEBAR_CHAT_ID = "sidebar";

/**
 * @typedef {import("./controller").ChatController} ChatController
 */

/**
 * @typedef {Object} OpenChat
 * @property {ChatController} controller
 * @property {{ setTitle: (title: string) => void, reveal: () => void, panel: vscode.WebviewPanel } | null} panelHost
 * @property {boolean} [agentRunning]
 * @property {string} [parentChatId]
 * @property {(options?: { closeTab?: boolean, reason?: string }) => void} [cancelAgent]
 * @property {() => void} [onAgentTabClosed] - This chat's tab was closed while it
 *   was still running a sub-agent task: stop the run so the parent is not told
 *   the interrupted work finished.
 */

/**
 * @param {vscode.ExtensionContext} context
 */
function createChatManager(context) {
  /** @type {Map<string, OpenChat>} */
  const chats = new Map();
  const ownership = createOwnership();
  const activity = createActivityRegistry();
  // Reservations belong to jobs, not tabs: a closed chat may still have work
  // unwinding, and it must occupy its slot until that work actually settles.
  let agentJobCount = 0;

  /** @type {string | null} */
  let sidebarChatId = null;
  let nextPanelNumber = 1;
  let disposed = false;
  /** @type {(() => void) | null} */
  let unregisterSettingsListener = null;
  /** @type {(() => void) | null} */
  let unregisterSessionsListener = null;

  // ── broadcasting ──

  /** Push the model list to every open chat (settings changed). */
  function broadcastModels() {
    for (const { controller } of chats.values()) controller.postModels();
  }

  /** Push the session list to every open chat (a session was added/renamed). */
  function broadcastSessions() {
    for (const { controller } of chats.values()) controller.postSessions();
  }

  // The settings panel is a singleton shared by every chat. Register the
  // broadcast once, while the manager is built, so a model that is added,
  // edited, reordered or deleted in Settings reaches every open chat —
  // including chats opened after the panel was already showing.
  unregisterSettingsListener = ModelConfigPanel.addListener(broadcastModels);
  // Deleting a session in Settings must also reach the chats showing it.
  unregisterSessionsListener = ModelConfigPanel.addSessionListener(handleSessionDeletedElsewhere);

  /**
   * @param {string} chatId
   * @param {string} title
   */
  function setChatTitle(chatId, title) {
    const chat = chats.get(chatId);
    if (!chat || !chat.panelHost) return;
    chat.panelHost.setTitle(title || "Chat");
  }

  /** A chat deleted a session: every other chat that had it loaded drops it, so
   * a later save cannot resurrect the deleted entry.
   * @param {string} sessionId
   * @param {string} fromChatId
   */
  function handleSessionDeleted(sessionId, fromChatId) {
    for (const [chatId, chat] of chats) {
      if (chatId === fromChatId) continue;
      chat.controller.forgetSession(sessionId);
    }
    broadcastSessions();
  }

  /**
   * A session was deleted from the Settings panel (or expired). Every chat
   * showing it must drop it, otherwise its next save would resurrect the
   * entry the user just deleted.
   * @param {string} sessionId
   */
  function handleSessionDeletedElsewhere(sessionId) {
    for (const chat of chats.values()) chat.controller.forgetSession(sessionId);
    broadcastSessions();
  }

  // ── chat construction ──

  /** Count live agent jobs, including reserved slots whose tabs are still being created. */
  function getRunningAgentCount() {
    return agentJobCount;
  }

  /** Notify active parent controllers when global agent capacity changes. */
  function refreshAgentCapacity() {
    for (const { controller } of chats.values()) {
      if (typeof controller.onAgentCapacityChanged === "function") controller.onAgentCapacityChanged();
    }
  }

  /**
   * @param {string} parentChatId
   */
  function cancelAgentsForParent(parentChatId) {
    for (const agent of chats.values()) {
      if (agent.parentChatId === parentChatId && agent.agentRunning && agent.cancelAgent) {
        agent.cancelAgent({ reason: "its parent request was stopped" });
      }
    }
  }

  /**
   * Spawn visible agent chats, reserving the available slots synchronously so
   * concurrent parent requests cannot exceed the configured global maximum.
   *
   * Every task is reported individually: a child that failed, was stopped, or
   * never started says so, instead of arriving as an empty answer. Capacity is
   * a hard limit — the tasks that do not fit are reported as not started rather
   * than queued, so the parent model never waits on work nobody is running.
   *
   * @param {import("./agent-run").AgentRunOptions & { parentChatId: string }} options
   * @returns {Promise<string>}
   */
  async function runVisibleAgents(options) {
    const parentChat = chats.get(options.parentChatId);
    if (!parentChat) return "Error: parent chat is no longer open.";
    // A malformed `tasks` argument must not throw inside the tool loop: the
    // model would get a protocol error instead of something it can correct.
    const tasks = normalizeTasks(options.tasks);
    if (tasks.length === 0) {
      return "No agents spawned: the `tasks` argument must be a non-empty array of prompt strings.";
    }
    if (options.signal && options.signal.aborted) {
      return formatAgentReport(
        tasks.map((_, index) => ({ index, outcome: "skipped", reason: "the parent request was cancelled" }))
      );
    }

    const capacity = Settings.getMaxSimultaneousAgents();
    const available = Math.max(0, capacity - getRunningAgentCount());
    if (available === 0) {
      return "No agents spawned: all " + capacity + " simultaneous-agent slot" + (capacity === 1 ? " is" : "s are") +
        " in use, so none of the " + tasks.length + " task(s) started. " +
        "Tell the user agent capacity is full — they can stop an agent or raise the limit in settings — " +
        "or do this work yourself with the normal tools.";
    }
    const accepted = tasks.slice(0, available);

    // Reserve before any async work (MCP discovery/panel setup) to close the
    // race between simultaneous agent tool calls.
    agentJobCount += accepted.length;

    /** @type {Array<Promise<import("./agent-run").AgentTaskReport>>} */
    const jobs = accepted.map(async (task, index) => {
      try {
        refreshAgentCapacity();
        return await spawnVisibleAgent(options, task, index);
      } finally {
        // Neither cancellation nor closing a tab settles the job. Keep its
        // reservation until setup/run/cleanup has actually returned or thrown.
        agentJobCount--;
        refreshAgentCapacity();
      }
    });
    // Settle independently: one child whose construction throws must not erase
    // the results of its siblings, and a rejection must not skip the ones still
    // running.
    const settled = await Promise.allSettled(jobs);

    /** @type {Array<import("./agent-run").AgentTaskReport>} */
    const reports = settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log.appendLine("Agent " + (index + 1) + ": run crashed: " + reason);
      return { index, outcome: "error", reason };
    });
    for (let index = accepted.length; index < tasks.length; index++) {
      reports.push({
        index,
        outcome: "skipped",
        reason: "the simultaneous-agent limit (" + capacity + ") was reached",
      });
    }

    return formatAgentReport(reports);
  }

  /**
   * Create and run one child chat. Its webview receives streamed content and
   * tool updates through the same controller protocol used by ordinary chats,
   * and it asks for its own tool approvals in its own tab — exactly like a chat
   * the user started.
   *
   * @param {import("./agent-run").AgentRunOptions & { parentChatId: string }} options
   * @param {string} task
   * @param {number} index
   * @returns {Promise<import("./agent-run").AgentTaskReport>}
   */
  async function spawnVisibleAgent(options, task, index) {
    const parent = chats.get(options.parentChatId);
    if (disposed || !parent) {
      return { index, outcome: "skipped", reason: "its parent chat closed" };
    }
    if (options.signal && options.signal.aborted) {
      return { index, outcome: "skipped", reason: "the parent request was cancelled" };
    }

    const agentId = newChatId();
    /** @type {import("./controller").ChatController} */
    let agentChat;
    try {
      agentChat = buildController(agentId, {
        isAgent: true,
        modelId: options.modelConfig.id,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { index, outcome: "error", reason: "the agent chat could not be created: " + reason };
    }

    const agentAbortController = new AbortController();
    const abortFromParent = () => agentAbortController.abort();
    const entry = chats.get(agentId);
    if (!entry) {
      agentChat.dispose();
      return { index, outcome: "error", reason: "the agent chat could not be created" };
    }
    entry.agentRunning = true;
    entry.parentChatId = options.parentChatId;

    /** Why the run ended early, when the user caused it. */
    let stoppedBy = /** @type {string | null} */ (null);
    let cancellationHandled = false;
    let tabClosureHandled = false;

    /**
     * Abort this run. Reached from three places, each of which must say why:
     * the tab's own Stop (`onSelfStop`), closing the tab (through `closeChat`),
     * and the parent stopping its agents.
     * @param {{ closeTab?: boolean, reason?: string }} [cancelOptions]
     */
    const cancelAgent = (cancelOptions = {}) => {
      try {
        // The parent's signal can abort this signal before its owned-agent
        // callback runs. That does NOT mean approvals/controller cleanup ran.
        if (!cancellationHandled) {
          cancellationHandled = true; // guard synchronous abort re-entry
          stoppedBy = cancelOptions.reason || "the user stopped it";
          agentAbortController.abort();
          agentChat.abortAll();
        }
      } finally {
        // A later parent stop may still close a tab kept open by its own Stop.
        // Track closure separately from cancellation, and keep the callback
        // registered until the job settles.
        const current = chats.get(agentId);
        if (cancelOptions.closeTab !== false && !tabClosureHandled && current && current.panelHost) {
          tabClosureHandled = true;
          current.panelHost.panel.dispose();
        }
      }
    };
    entry.cancelAgent = cancelAgent;
    // A closed tab means the same thing as Stop. `closeChat` runs *after* the
    // panel is gone, so it is the reliable place to notice it: the panel's own
    // dispose event is the only signal a user-closed agent tab leaves behind.
    entry.onAgentTabClosed = () => {
      if (!entry.agentRunning) return; // auto-close after a finished run
      cancelAgent({ closeTab: false, reason: "the user closed its tab" });
    };
    let unregister = () => {};
    let taskStarted = false;
    try {
      if (options.signal) {
        if (options.signal.aborted) abortFromParent();
        else options.signal.addEventListener("abort", abortFromParent, { once: true });
      }
      // Include registration and panel setup in cleanup: either can throw or
      // synchronously cancel a reserved job before its task ever starts.
      if (typeof parent.controller.registerOwnedAgent === "function") {
        unregister = parent.controller.registerOwnedAgent({
          cancel: () => cancelAgent({ reason: "its parent request was stopped" }),
        });
      }
      if (agentAbortController.signal.aborted) {
        return { index, outcome: "skipped", reason: "the run was cancelled before its tab opened" };
      }

      try {
        entry.panelHost = createEditorChatPanel(context, agentChat, closeChat, { preserveFocus: true });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        return { index, outcome: "skipped", reason: "its tab could not be opened: " + reason };
      }
      setChatTitle(agentId, "Agent " + (index + 1) + ": " + (String(task).slice(0, 48) || "Task"));
      if (agentAbortController.signal.aborted) {
        return { index, outcome: "skipped", reason: "the run was cancelled before its task started" };
      }

      taskStarted = true;
      const outcome = await agentChat.runAgentTask({
        task: String(task),
        signal: agentAbortController.signal,
      });

      // Report before the auto-close check: disposing the panel must not look
      // like the user stopping the run.
      entry.agentRunning = false;
      entry.cancelAgent = undefined;

      /** @type {import("./agent-run").AgentTaskReport} */
      let report;
      if (agentAbortController.signal.aborted || outcome.aborted) {
        report = {
          index,
          outcome: "stopped",
          reason: stoppedBy || "the user stopped it",
          text: outcome.text,
        };
      } else if (outcome.stopReason === "budget") {
        report = { index, outcome: "budget", reason: "it reached the context budget", text: outcome.text };
      } else if (!outcome.ok) {
        report = { index, outcome: "error", reason: outcome.error || "the run failed", text: outcome.text };
      } else {
        report = { index, outcome: "ok", text: extractFinalAgentResponse(agentChat, outcome.text) };
      }

      // A stopped or failed run keeps its tab: the user may want to read it.
      if (report.outcome === "ok" && Settings.getAutoCloseAgents() && entry.panelHost) {
        entry.panelHost.panel.dispose();
      }
      return report;
    } catch (e) {
      // runAgentTask is not supposed to throw; if it does, say so instead of
      // reporting an empty success.
      entry.agentRunning = false;
      entry.cancelAgent = undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (agentAbortController.signal.aborted) {
        return { index, outcome: "stopped", reason: stoppedBy || "the user stopped it" };
      }
      return { index, outcome: "error", reason: message };
    } finally {
      entry.agentRunning = false;
      entry.cancelAgent = undefined;
      entry.onAgentTabClosed = undefined;
      try {
        if (options.signal) options.signal.removeEventListener("abort", abortFromParent);
        unregister();
      } finally {
        if (!taskStarted) {
          // Failed/skipped setup must not leave a controller or reservation
          // behind, even when no panel was attached to trigger closeChat.
          if (entry.panelHost) entry.panelHost.panel.dispose();
          chats.delete(agentId);
          ownership.releaseAll(agentId);
          try {
            agentChat.dispose();
          } catch (e) {
            log.appendLine("Agent " + (index + 1) + ": dispose after setup failed: " + (e instanceof Error ? e.message : String(e)));
          }
        }
      }
    }
  }

  /**
   * Prefer the child transcript's final assistant message over the streamed
   * text: a provider that does not stream only produces the answer there.
   * @param {import("./controller").ChatController} agentChat
   * @param {string} fallback
   * @returns {string}
   */
  function extractFinalAgentResponse(agentChat, fallback) {
    const answer = agentChat.getLastAssistantResponse && agentChat.getLastAssistantResponse();
    return answer || fallback || "";
  }

  /**
   * @param {string} chatId
   * @param {{ sessionId?: string, restoreCurrent?: boolean, persistCurrent?: boolean, isAgent?: boolean, modelId?: string, reasoningEffort?: string }} options
   * @returns {ChatController}
   */
  function buildController(chatId, options) {
    const controller = createChatController({
      id: chatId,
      sessionId: options.sessionId,
      restoreCurrent: options.restoreCurrent,
      persistCurrent: options.persistCurrent,
      isAgent: options.isAgent === true,
      modelId: options.modelId,
      reasoningEffort: options.reasoningEffort,
      hooks: {
        canTakeSession: (sessionId) => ownership.canTake(sessionId, chatId),
        onSessionTaken: (sessionId) => {
          ownership.take(sessionId, chatId);
          // Every other chat's session list marks sessions that are already
          // open somewhere, so refresh them.
          broadcastSessions();
        },
        onSessionReleased: (sessionId) => {
          ownership.release(sessionId, chatId);
          broadcastSessions();
        },
        onSessionUnavailable: (sessionId) => {
          const owner = ownership.ownerOf(sessionId);
          if (owner) revealChat(owner);
        },
        isSessionBusy: (sessionId) => {
          const owner = ownership.ownerOf(sessionId);
          return owner !== null && owner !== chatId;
        },
        onSessionsChanged: () => broadcastSessions(),
        onSessionDeleted: (sessionId, fromChatId) => handleSessionDeleted(sessionId, fromChatId),
        onTitleChanged: (title) => setChatTitle(chatId, title),
        onMessage: (msg) => handleUnhandledMessage(chatId, msg),
        activity,
        runAgent: (agentOptions) => runVisibleAgents({ ...agentOptions, parentChatId: chatId }),
        abortOwnedAgents: () => cancelAgentsForParent(chatId),
        // An agent tab stopping itself must cancel the run the manager owns.
        // Looked up lazily: this hook is created before `chats.set` below.
        onSelfStop: options.isAgent === true
          ? () => {
              const self = chats.get(chatId);
              if (self && self.cancelAgent) self.cancelAgent({ closeTab: false });
            }
          : undefined,
        getAgentCapacity: () => ({
          maximum: Settings.getMaxSimultaneousAgents(),
          available: Math.max(0, Settings.getMaxSimultaneousAgents() - getRunningAgentCount()),
        }),
      },
    });
    chats.set(chatId, { controller, panelHost: null });
    refreshAgentCapacity();
    return controller;
  }

  /**
   * Messages a chat does not own: the settings panel and the "new tab" button.
   * @param {string} chatId
   * @param {Record<string, any>} msg
   */
  function handleUnhandledMessage(chatId, msg) {
    switch (msg.type) {
      case "configureModels": {
        try {
          // Model changes are broadcast to every chat through the listener
          // registered above.
          ModelConfigPanel.createOrShow(context);
        } catch (err) {
          vscode.window.showErrorMessage("CCE: " + (err instanceof Error ? err.message : String(err)));
        }
        break;
      }
      case "openChatTab":
        void openChatTab(msg.sessionId);
        break;
      default:
        log.appendLine("Chat " + chatId + ": unhandled message type " + msg.type);
        break;
    }
  }

  // ── sidebar ──

  /**
   * The sidebar chat, created on first use and reused afterwards.
   * @returns {ChatController}
   */
  function getSidebarChat() {
    if (sidebarChatId) {
      const existing = chats.get(sidebarChatId);
      if (existing) return existing.controller;
    }
    sidebarChatId = SIDEBAR_CHAT_ID;
    return buildController(SIDEBAR_CHAT_ID, { restoreCurrent: true, persistCurrent: true });
  }

  /**
   * Register the sidebar view provider. Must be called once during activate().
   * @returns {vscode.WebviewViewProvider}
   */
  function registerSidebar() {
    return createSidebarViewHost(context, getSidebarChat).provider;
  }

  // ── editor tabs ──

  /**
   * Allocate a chat id that no open chat is using.
   *
   * Restored tabs come back before a user can open new ones, but ids must
   * never collide: the map entry would be overwritten and the first
   * controller would be orphaned while still owning its session.
   *
   * @returns {string}
   */
  function newChatId() {
    let chatId = "tab-" + nextPanelNumber++;
    while (chats.has(chatId)) chatId = "tab-" + nextPanelNumber++;
    return chatId;
  }

  /**
   * Whether a session can be reopened in a restored tab: it must still exist
   * and must not already be shown by another chat.
   *
   * @param {string | null} sessionId
   * @returns {string | null} The session to open, or null for a fresh chat.
   */
  function restorableSessionId(sessionId) {
    if (!sessionId) return null;
    // Another chat already shows it (two tabs restored for one session, or a
    // stale state): falling back to a fresh chat keeps the tab, and the
    // conversation, in the chat that really owns it.
    if (ownership.ownerOf(sessionId)) return null;
    const exists = withoutEmptySessions(Settings.getSessions()).some((s) => s.id === sessionId);
    return exists ? sessionId : null;
  }

  /**
   * Recreate a chat in a panel VS Code restored after a window reload.
   *
   * The webview persisted the id of the session it was showing; the session
   * itself lives in the workspace store, so the conversation comes back as it
   * was last saved. A tab whose session has since been deleted, or that is now
   * owned by another chat, comes back as a fresh chat rather than vanishing.
   *
   * @param {vscode.WebviewPanel} panel
   * @param {any} state - Whatever the webview passed to `setState`.
   * @returns {Promise<void>}
   */
  async function restoreChatPanel(panel, state) {
    if (disposed) {
      panel.dispose();
      return;
    }
    const { sessionId } = decodePanelState(state);
    const chatId = newChatId();
    const controller = buildController(chatId, { sessionId: restorableSessionId(sessionId) || undefined });
    const host = attachEditorChatPanel(context, panel, controller, closeChat);
    const open = chats.get(chatId);
    if (open) open.panelHost = host;
    setChatTitle(chatId, controller.getTitle());
  }

  /**
   * Register the serializer that brings editor-tab chats back after a window
   * reload. Must be called once during activate(); the extension is activated
   * for restoration through the `onWebviewPanel` activation event.
   *
   * @returns {vscode.Disposable}
   */
  function registerPanelSerializer() {
    return vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      deserializeWebviewPanel(panel, state) {
        return restoreChatPanel(panel, state);
      },
    });
  }

  /**
   * Open a chat in an editor tab. Reveals the existing tab when the requested
   * session is already open somewhere instead of creating a second view of the
   * same conversation.
   *
   * @param {string} [sessionId] - Open an existing session; omit for a fresh chat.
   * @returns {Promise<void>}
   */
  async function openChatTab(sessionId) {
    if (disposed) return;
    if (sessionId) {
      const owner = ownership.ownerOf(sessionId);
      if (owner) {
        revealChat(owner);
        return;
      }
      const exists = withoutEmptySessions(Settings.getSessions()).some((s) => s.id === sessionId);
      if (!exists) {
        vscode.window.showWarningMessage("CCE: That session no longer exists.");
        return;
      }
    }

    const chatId = newChatId();
    // Build the chat without a session, then open the requested one through the
    // controller so the panel shows it immediately and a session that vanished
    // between the check above and here cannot leave a half-initialised tab.
    const controller = buildController(chatId, {});
    const host = createEditorChatPanel(context, controller, closeChat);
    const open = chats.get(chatId);
    if (open) open.panelHost = host;
    // The panel follows the controller's title changes; set the initial title
    // now so the tab is labelled before the first save.
    setChatTitle(chatId, controller.getTitle());
    if (sessionId && !controller.openSession(sessionId)) {
      void vscode.window.showWarningMessage("CCE: That session is no longer available.");
      // Closing the panel runs the normal teardown (abort, save, release).
      host.panel.dispose();
    }
  }

  /**
   * Reveal the view that owns a chat.
   * @param {string} chatId
   */
  function revealChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) return;
    if (chat.panelHost) {
      chat.panelHost.reveal();
      return;
    }
    if (chatId === sidebarChatId) {
      void vscode.commands.executeCommand("cce.chatView.focus");
    }
  }

  /**
   * Tear down a closed editor tab: abort the request, deny approvals, save the
   * transcript and release the session so it can be reopened elsewhere.
   * @param {string} chatId
   * @returns {Promise<void>}
   */
  async function closeChat(chatId) {
    const chat = chats.get(chatId);
    if (!chat) return;
    try {
      // Closing a tab that is running an agent job must stop that job: a child
      // that keeps unwinding would report its truncated work as a result.
      if (chat.onAgentTabClosed) chat.onAgentTabClosed();
      chat.controller.abortAll();
      await chat.controller.saveSession();
    } catch (e) {
      log.appendLine("Chat " + chatId + ": close failed: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      chat.controller.dispose();
      // Belt and braces: dispose() releases the session the chat is showing,
      // but a chat that switched sessions must free every session it took.
      ownership.releaseAll(chatId);
      chats.delete(chatId);
      broadcastSessions();
    }
  }

  /**
   * Shut every chat down, persisting first. Called on deactivate, where a
   * message the user just sent (or an assistant reply that landed a moment
   * ago) would otherwise be lost because aborts unwind without saving.
   * @returns {Promise<void>}
   */
  async function shutdown() {
    if (unregisterSettingsListener) {
      unregisterSettingsListener();
      unregisterSettingsListener = null;
    }
    if (unregisterSessionsListener) {
      unregisterSessionsListener();
      unregisterSessionsListener = null;
    }
    for (const [chatId, chat] of chats) {
      try {
        chat.controller.abortAll();
        // `disposed` is not set yet: a controller refuses to save once it has
        // been disposed, and this is the last chance to persist the chat.
        await chat.controller.saveSession();
      } catch (e) {
        log.appendLine("Chat " + chatId + ": shutdown save failed: " + (e instanceof Error ? e.message : String(e)));
      }
      chat.controller.dispose();
    }
    disposed = true;
    chats.clear();
    ownership.clear();
  }

  /** Abort everything without waiting (dispose paths that cannot be async). */
  function dispose() {
    disposed = true;
    if (unregisterSettingsListener) {
      unregisterSettingsListener();
      unregisterSettingsListener = null;
    }
    if (unregisterSessionsListener) {
      unregisterSessionsListener();
      unregisterSessionsListener = null;
    }
    for (const { controller } of chats.values()) controller.dispose();
    chats.clear();
    ownership.clear();
  }

  return {
    registerSidebar,
    registerPanelSerializer,
    getSidebarChat,
    openChatTab,
    broadcastModels,
    broadcastSessions,
    runVisibleAgents,
    getAgentCapacity: () => ({
      maximum: Settings.getMaxSimultaneousAgents(),
      available: Math.max(0, Settings.getMaxSimultaneousAgents() - getRunningAgentCount()),
    }),
    shutdown,
    dispose,
  };
}

module.exports = { createChatManager, SIDEBAR_CHAT_ID };

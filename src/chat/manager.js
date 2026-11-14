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
 * @property {number} [pendingAgentCount]
 * @property {string} [parentChatId]
 * @property {(options?: { closeTab?: boolean }) => void} [cancelAgent]
 */

/**
 * @param {vscode.ExtensionContext} context
 */
function createChatManager(context) {
  /** @type {Map<string, OpenChat>} */
  const chats = new Map();
  const ownership = createOwnership();
  const activity = createActivityRegistry();

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
    let count = 0;
    for (const chat of chats.values()) {
      if (chat.agentRunning) count++;
      count += chat.pendingAgentCount || 0;
    }
    return count;
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
        agent.cancelAgent();
      }
    }
  }

  /**
   * Spawn visible agent chats, reserving the available slots synchronously so
   * concurrent parent requests cannot exceed the configured global maximum.
   * @param {import("./agent").AgentRunOptions & { parentChatId: string }} options
   * @returns {Promise<string>}
   */
  async function runVisibleAgents(options) {
    const parentChat = chats.get(options.parentChatId);
    if (!parentChat) return "Error: parent chat is no longer open.";
    const tasks = Array.isArray(options.tasks) ? options.tasks : [];
    if (tasks.length === 0) return "No tasks provided.";
    if (options.signal && options.signal.aborted) return "No agents spawned: the parent request was cancelled.";

    const capacity = Settings.getMaxSimultaneousAgents();
    const available = Math.max(0, capacity - getRunningAgentCount());
    const accepted = tasks.slice(0, available);
    const rejected = tasks.length - accepted.length;
    if (accepted.length === 0) {
      return "No agents spawned: capacity is full (0 of " + capacity + " available). Wait for an agent to finish and try again.";
    }

    // Reserve before any async work (MCP discovery/panel setup) to close the
    // race between simultaneous agent tool calls.
    parentChat.pendingAgentCount = (parentChat.pendingAgentCount || 0) + accepted.length;
    refreshAgentCapacity();
    const jobs = accepted.map((task, index) => spawnVisibleAgent(options, task, index));
    const results = await Promise.all(jobs);
    const suffix = rejected > 0 ? "\n\n" + rejected + " task(s) were not started because the simultaneous-agent limit was reached." : "";
    return results.join("\n\n") + suffix;
  }

  /**
   * Create and run a child chat. Its webview receives streamed content and
   * tool updates through the same controller protocol used by ordinary chats.
   * @param {import("./agent").AgentRunOptions & { parentChatId: string }} options
   * @param {string} task
   * @param {number} index
   * @returns {Promise<string>}
   */
  async function spawnVisibleAgent(options, task, index) {
    const parent = chats.get(options.parentChatId);
    if (parent) parent.pendingAgentCount = Math.max(0, (parent.pendingAgentCount || 0) - 1);
    if (disposed || !parent) {
      refreshAgentCapacity();
      return "Agent " + (index + 1) + " was not started because its parent chat closed.";
    }

    const agentId = newChatId();
    const agentChat = buildController(agentId, {
      isAgent: true,
      modelId: options.modelConfig.id,
      reasoningEffort: options.reasoningEffort,
    });
    const agentAbortController = new AbortController();
    const abortFromParent = () => agentAbortController.abort();
    const entry = chats.get(agentId);
    if (options.signal) {
      if (options.signal.aborted) abortFromParent();
      else options.signal.addEventListener("abort", abortFromParent, { once: true });
    }
    if (!entry) return "Agent " + (index + 1) + " could not be created.";
    entry.agentRunning = true;
    entry.parentChatId = options.parentChatId;

    const cancelAgent = (cancelOptions = {}) => {
      if (agentAbortController.signal.aborted) return;
      agentAbortController.abort();
      entry.cancelAgent = undefined;
      agentChat.abortAll();
      // Closing the tab is right when the *parent* stopped its agents. When the
      // user pressed Stop inside this tab they want to read the transcript, so
      // the tab stays open (and becomes an ordinary chat).
      if (cancelOptions.closeTab === false) return;
      const current = chats.get(agentId);
      if (current && current.panelHost) current.panelHost.panel.dispose();
    };
    entry.cancelAgent = cancelAgent;
    const unregister = typeof parent.controller.registerOwnedAgent === "function"
      ? parent.controller.registerOwnedAgent({ cancel: cancelAgent })
      : () => {};
    if (agentAbortController.signal.aborted) cancelAgent();

    try {
      const host = createEditorChatPanel(context, agentChat, closeChat, { preserveFocus: true });
      entry.panelHost = host;
      setChatTitle(agentId, "Agent " + (index + 1) + ": " + (String(task).slice(0, 48) || "Task"));
      const result = await agentChat.runAgentTask({
        task: String(task),
        modelConfig: options.modelConfig,
        apiKey: options.apiKey,
        provider: options.provider,
        budget: options.budget,
        reasoningEffort: options.reasoningEffort,
        signal: agentAbortController.signal,
        onProgress: (text) => agentChat.postAgentProgress(text),
      });
      const finalResult = extractFinalAgentResponse(agentChat, result);
      entry.agentRunning = false;
      entry.cancelAgent = undefined;
      refreshAgentCapacity();
      agentChat.onAgentCapacityChanged();
      // Stop landed while the run was unwinding: treat it as a user stop so the
      // tab is not auto-closed and the parent is not told the work finished.
      if (agentAbortController.signal.aborted) {
        return "Agent " + (index + 1) + " was stopped by the user. Its work is incomplete — do not retry it, report the partial result instead.";
      }
      if (Settings.getAutoCloseAgents() && entry.panelHost) entry.panelHost.panel.dispose();
      return "Agent " + (index + 1) + " result:\n" + finalResult;
    } catch (e) {
      entry.agentRunning = false;
      entry.cancelAgent = undefined;
      const message = e instanceof Error ? e.message : String(e);
      // A user stop is not a failure: tell the parent model clearly that the
      // work was interrupted and must not be retried as if it had crashed.
      if (agentAbortController.signal.aborted) {
        return "Agent " + (index + 1) + " was stopped by the user. Its work is incomplete — do not retry it, report the partial result instead.";
      }
      return "Agent " + (index + 1) + " error: " + message;
    } finally {
      if (options.signal) options.signal.removeEventListener("abort", abortFromParent);
      unregister();
      refreshAgentCapacity();
    }
  }

  /**
   * Extract the final assistant content from the child transcript, rather than
   * returning the UI's sentinel completion string to the parent model.
   * @param {string} fallback
   * @returns {string}
   */
  function extractFinalAgentResponse(agentChat, fallback) {
    const answer = agentChat.getLastAssistantResponse && agentChat.getLastAssistantResponse();
    return answer || fallback || "(no output)";
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

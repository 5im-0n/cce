const vscode = require("vscode");
const Settings = require("../config/Settings");
const ModelConfigPanel = require("../config/ModelConfigPanel");
const log = require("../config/log").get();
const { createChatController } = require("./controller");
const { createActivityRegistry } = require("./activity");
const { createOwnership } = require("./ownership");
const { createSidebarViewHost, createEditorChatPanel } = require("./view");
const { withoutEmptySessions } = require("../config/sessionStore");

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

  /**
   * @param {string} chatId
   * @param {{ sessionId?: string, restoreCurrent?: boolean, persistCurrent?: boolean }} options
   * @returns {ChatController}
   */
  function buildController(chatId, options) {
    const controller = createChatController({
      id: chatId,
      sessionId: options.sessionId,
      restoreCurrent: options.restoreCurrent,
      persistCurrent: options.persistCurrent,
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
      },
    });
    chats.set(chatId, { controller, panelHost: null });
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

    const chatId = "tab-" + nextPanelNumber++;
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
    getSidebarChat,
    openChatTab,
    broadcastModels,
    broadcastSessions,
    shutdown,
    dispose,
  };
}

module.exports = { createChatManager, SIDEBAR_CHAT_ID };

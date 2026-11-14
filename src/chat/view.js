const vscode = require("vscode");
const { renderChatHtml } = require("./html");
const { PANEL_VIEW_TYPE } = require("./panel-state");
const log = require("../config/log").get();

/**
 * Webview hosts for a chat.
 *
 * A chat is hosted either by the activity-bar sidebar view or by an editor
 * tab. Both hosts share one document and one controller; they differ only in
 * how messages arrive and when the host is torn down.
 */

/**
 * @typedef {Object} SidebarViewHost
 * @property {vscode.WebviewViewProvider} provider
 * @property {() => vscode.WebviewView | null} current
 */

/**
 * Create the sidebar view provider for the default chat.
 *
 * The provider is stateless: the controller it serves is owned by the manager
 * and survives the view being hidden and re-resolved. On re-resolve the
 * controller replays its state through `attach`.
 *
 * @param {vscode.ExtensionContext} context
 * @param {() => import("./controller").ChatController} getController
 * @returns {SidebarViewHost}
 */
function createSidebarViewHost(context, getController) {
  /** @type {vscode.WebviewView | null} */
  let view = null;
  /** @type {vscode.Disposable | null} */
  let messageListener = null;

  /** @type {vscode.WebviewViewProvider} */
  const provider = {
    resolveWebviewView(webviewView) {
      log.appendLine("resolveWebviewView called");
      view = webviewView;
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.html = renderChatHtml(context.extensionPath);

      const controller = getController();
      controller.attach((msg) => {
        void webviewView.webview.postMessage(msg);
      });

      // The view can be resolved again after being hidden; drop the previous
      // listener first so one click is never handled twice.
      if (messageListener) {
        messageListener.dispose();
        messageListener = null;
      }
      messageListener = webviewView.webview.onDidReceiveMessage((msg) => {
        controller.handleMessage(msg, webviewView.webview);
      });

      webviewView.onDidDispose(() => {
        if (messageListener) {
          messageListener.dispose();
          messageListener = null;
        }
        controller.detach();
        view = null;
      });
    },
  };

  return { provider, current: () => view };
}

/**
 * @typedef {Object} EditorChatHost
 * @property {vscode.WebviewPanel} panel
 * @property {(title: string) => void} setTitle
 * @property {() => void} reveal
 */

/**
 * Wire a chat controller to an existing editor panel.
 *
 * Used both for a panel this extension just created and for a panel VS Code
 * restored after a window reload — the transport is identical, which is why
 * the serialized tab needs no special code path beyond creating the
 * controller first.
 *
 * Closing the tab detaches the sink (so no post lands on a dead webview), then
 * hands off to the manager, which aborts, denies approvals, saves and releases
 * the session.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.WebviewPanel} panel
 * @param {import("./controller").ChatController} controller
 * @param {(chatId: string) => Promise<void>} onClosed
 * @returns {EditorChatHost}
 */
function attachEditorChatPanel(context, panel, controller, onClosed) {
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");
  panel.webview.options = { enableScripts: true };
  panel.webview.html = renderChatHtml(context.extensionPath);

  /** @type {string | null} */
  let lastPersistedSessionId = null;
  let hasPersisted = false;

  /**
   * Tell the webview which session this tab shows.
   *
   * `setState` can only be called from inside the webview, so the host pushes
   * the value down whenever it changes. VS Code keeps it across a window
   * reload and hands it back to the serializer, which reopens that session.
   *
   * @param {boolean} [force] - Post even when the id is unchanged (the webview
   *   asked for the full state and may be newer than our last post).
   * @returns {void}
   */
  function postPanelState(force) {
    const sessionId = controller.getSessionId() || null;
    if (!force && hasPersisted && sessionId === lastPersistedSessionId) return;
    lastPersistedSessionId = sessionId;
    hasPersisted = true;
    void panel.webview.postMessage({ type: "persistPanelState", sessionId });
  }

  const listener = panel.webview.onDidReceiveMessage((msg) => {
    // The webview asks for the full state once its script is live; answer with
    // the panel state too, because the replay in `attach` can precede it.
    if (msg && msg.type === "requestState") postPanelState(true);
    controller.handleMessage(msg, panel.webview);
  });

  controller.attach((msg) => {
    void panel.webview.postMessage(msg);
    // The session changes on switch/new/delete, and a brand-new chat gets its
    // id on the first send — `sessionsLoaded` carries that too, so track both
    // and let the duplicate check keep it to one post per change.
    if (msg && (msg.type === "sessionSwitched" || msg.type === "sessionsLoaded")) postPanelState();
  });

  let closed = false;
  panel.onDidDispose(() => {
    if (closed) return;
    closed = true;
    listener.dispose();
    // Detach first so nothing tries to post to a disposed webview.
    controller.detach();
    void onClosed(controller.id);
  });

  return {
    panel,
    setTitle(title) {
      panel.title = "CCE: " + title;
    },
    reveal() {
      panel.reveal(vscode.ViewColumn.Beside);
    },
  };
}

/**
 * Create a new editor panel beside the active editor and attach the chat to it.
 *
 * @param {vscode.ExtensionContext} context
 * @param {import("./controller").ChatController} controller
 * @param {(chatId: string) => Promise<void>} onClosed
 * @param {{ preserveFocus?: boolean }} [options]
 * @returns {EditorChatHost}
 */
function createEditorChatPanel(context, controller, onClosed, options = {}) {
  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    "CCE: " + controller.getTitle(),
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: options.preserveFocus === true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  return attachEditorChatPanel(context, panel, controller, onClosed);
}

/**
 * @typedef {Object} ChatController
 * @property {string} id
 * @property {() => string} getTitle
 */

module.exports = { createSidebarViewHost, createEditorChatPanel, attachEditorChatPanel };

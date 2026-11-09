const vscode = require("vscode");
const { renderChatHtml } = require("./html");
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
 * Open a chat in an editor tab beside the active editor.
 *
 * Closing the tab aborts in-flight work, denies pending approvals and saves
 * the transcript before the controller is dropped.
 *
 * @param {vscode.ExtensionContext} context
 * @param {import("./controller").ChatController} controller
 * @param {(chatId: string) => Promise<void>} onClosed
 * @returns {{ panel: vscode.WebviewPanel, setTitle: (title: string) => void, reveal: () => void }}
 */
function createEditorChatPanel(context, controller, onClosed) {
  const panel = vscode.window.createWebviewPanel(
    "cceChat",
    "CCE: " + controller.getTitle(),
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");
  panel.webview.html = renderChatHtml(context.extensionPath);

  const listener = panel.webview.onDidReceiveMessage((msg) => {
    controller.handleMessage(msg, panel.webview);
  });

  controller.attach((msg) => {
    void panel.webview.postMessage(msg);
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
 * @typedef {Object} ChatController
 * @property {string} id
 * @property {() => string} getTitle
 */

module.exports = { createSidebarViewHost, createEditorChatPanel };

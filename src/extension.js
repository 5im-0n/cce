const vscode = require("vscode");
const Settings = require("./config/Settings");
const log = require("./config/log").get();
const processManager = require("./mcp/processManager");
const { createChatManager } = require("./chat/manager");
const { whenIdle } = require("./config/sessionStore");

/**
 * Extension entry point.
 *
 * All chat behaviour lives in `src/chat/`: the manager owns every open chat
 * (the sidebar one plus any editor-tab ones), each chat owns its own
 * conversation, session, model and approvals. This file only wires the
 * extension up and tears it down.
 */

/** @type {ReturnType<typeof createChatManager> | null} */
let chatManager = null;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  log.appendLine("CCE activating\u2026");

  Settings.init(context);

  // Delete sessions older than the configured max age
  void Settings.deleteExpiredSessions().catch((e) => {
    log.appendLine("Session expiry failed: " + (e instanceof Error ? e.message : String(e)));
  });

  chatManager = createChatManager(context);

  // Register the chat view (the sidebar chat is created on first resolve)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cce.chatView", chatManager.registerSidebar(), {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Bring editor-tab chats back after a window reload. VS Code calls the
  // serializer with the state the webview saved (`setState`), which is the id
  // of the session that tab was showing.
  context.subscriptions.push(chatManager.registerPanelSerializer());

  // Register the commands. VS Code's generated view-focus command is public
  // API and reveals the activity-bar container when it focuses the view.
  context.subscriptions.push(
    vscode.commands.registerCommand("cce.openChat", () => {
      return vscode.commands.executeCommand("cce.chatView.focus");
    })
  );

  // Open another chat in an editor tab, so several conversations can run at
  // the same time (one per tab).
  context.subscriptions.push(
    vscode.commands.registerCommand("cce.newChatTab", () => {
      return chatManager ? chatManager.openChatTab() : undefined;
    })
  );

  // Start all enabled stdio MCP servers
  _startMcpServers();

  // Restart MCP servers when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cce")) {
        log.appendLine("Config changed, restarting MCP servers\u2026");
        // Restart all stdio servers (stop all, start enabled ones)
        processManager.stopAll();
        _startMcpServers();
      }
    })
  );

  log.appendLine("CCE activated");
}

/**
 * Start all enabled stdio-based MCP servers from settings.
 */
function _startMcpServers() {
  const servers = Settings.getMcpServers();
  for (const server of servers) {
    if (server.enabled !== false && server.command) {
      try {
        processManager.start({
          id: server.id,
          command: server.command,
          args: server.args,
        });
      } catch (e) {
        log.appendLine("Failed to start MCP server \"" + server.name + "\": " + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
}

/**
 * Clean shutdown: abort every chat, flush pending session writes and stop the
 * MCP server processes.
 */
async function deactivate() {
  log.appendLine("CCE deactivating\u2026");
  if (chatManager) {
    // Saves every open chat before its controller is dropped.
    await chatManager.shutdown();
    chatManager = null;
  }
  await whenIdle();
  processManager.stopAll();
  log.appendLine("CCE deactivated");
}

module.exports = { activate, deactivate };

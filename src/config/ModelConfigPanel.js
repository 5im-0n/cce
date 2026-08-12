const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const Settings = require("./Settings");
const processManager = require("../mcp/processManager");
const log = require("./log").get;

/**
 * Manages the CCE Settings webview panel — tabbed UI with
 * "Models", "Context", "Tools", and "MCP" tabs.
 * Opens as a modal-like editor tab.
 */
class ModelConfigPanel {
  /** @type {vscode.WebviewPanel | null} */
  static _panel = null;

  /** @type {(() => void) | null} */
  static _onChanged = null;

  /**
   * Create the panel if not already open, or reveal it.
   * @param {vscode.ExtensionContext} context
   * @param {function(): void} onChanged - called after models are saved/deleted
   */
  static createOrShow(context, onChanged) {
    const vscode = require("vscode");
    const column = vscode.ViewColumn.Active;

    log().appendLine("createOrShow called, existing panel: " + !!ModelConfigPanel._panel);

    if (ModelConfigPanel._panel) {
      log().appendLine("Revealing existing panel");
      ModelConfigPanel._panel.reveal(column);
      return;
    }

    log().appendLine("Creating new panel");

    const panel = vscode.window.createWebviewPanel(
      "cceSettings",
      "CCE Settings",
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    ModelConfigPanel._panel = panel;
    ModelConfigPanel._onChanged = onChanged;

    // Set the CCE icon on the tab
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "icon.png");

    panel.webview.html = fs.readFileSync(path.join(context.extensionPath, "webview-ui", "settings.html"), "utf-8");

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "addModel":
          await ModelConfigPanel._addModel(msg.config);
          break;
        case "updateModel":
          await ModelConfigPanel._updateModel(msg.configId, msg.config);
          break;
        case "deleteModel":
          await ModelConfigPanel._deleteModel(msg.configId);
          break;
        case "moveModel":
          await ModelConfigPanel._moveModel(msg.configId, msg.direction);
          break;
        case "saveSystemPrompt":
          await Settings.setSystemPrompt(msg.prompt);
          break;
        case "setToolEnabled":
          await Settings.setToolEnabled(msg.toolName, msg.enabled);
          break;
        case "setToolApprovalMode":
          await Settings.setToolApprovalMode(msg.toolName, msg.mode);
          break;
        case "setContextFlag":
          await Settings.setContextFlag(msg.flag, msg.enabled);
          break;
        case "setUseAgentsMd":
          await Settings.setUseAgentsMd(msg.enabled);
          break;
        case "setAgentsMdPath":
          await Settings.setAgentsMdPath(msg.path);
          break;
        case "addMcpServer":
          await ModelConfigPanel._addMcp(msg.server);
          break;
        case "updateMcpServer":
          await ModelConfigPanel._updateMcp(msg.serverId, msg.server);
          break;
        case "deleteMcpServer":
          await ModelConfigPanel._deleteMcp(msg.serverId);
          break;
        case "setMcpEnabled":
          await ModelConfigPanel._setMcpEnabled(msg.serverId, msg.enabled);
          break;
        case "setMcpApprovalMode":
          await Settings.setMcpApprovalMode(msg.serverId, msg.mode);
          break;
        case "startMcpServer":
          await ModelConfigPanel._startMcpServer(msg.serverId);
          break;
        case "stopMcpServer":
          await ModelConfigPanel._stopMcpServer(msg.serverId);
          break;
        case "deleteSession":
          await ModelConfigPanel._deleteSession(msg.sessionId, msg.scope);
          break;
        case "setSessionsMaxAge":
          await Settings.setSessionsMaxAge(msg.maxAgeDays);
          break;
        case "setCompaction":
          await Settings.setCompaction(msg.config);
          break;
        case "deleteExpiredSessions":
          await ModelConfigPanel._deleteExpiredSessions();
          break;
        case "requestData":
          ModelConfigPanel._postData();
          break;
        case "requestMcpStatus":
          ModelConfigPanel._postMcpStatus();
          break;
      }
    });

    panel.onDidDispose(() => {
      ModelConfigPanel._panel = null;
    });
  }

  // ── private ──────────────────────────────────────────────

  static _postData() {
    if (!ModelConfigPanel._panel) return;
    ModelConfigPanel._panel.webview.postMessage({
      type: "dataLoaded",
      models: Settings.getModels(),
      systemPrompt: Settings.getSystemPrompt(),
      toolSettings: Settings.getToolSettings(),
      toolApprovalModes: Settings.getToolApprovalModes(),
      mcpApprovalModes: Settings.getMcpApprovalModes(),
      contextFlags: Settings.getContextFlags(),
      useAgentsMd: Settings.getUseAgentsMd(),
      agentsMdPath: Settings.getAgentsMdPath(),
      mcpServers: Settings.getMcpServers(),
      sessions: Settings.getAllSessions(),
      sessionsMaxAge: Settings.getSessionsMaxAge(),
      compaction: Settings.getCompaction(),
    });
    // Also send process status
    ModelConfigPanel._postMcpStatus();
  }

  static _postMcpStatus() {
    if (!ModelConfigPanel._panel) return;
    const running = processManager.getRunningIds();
    /** @type {Record<string, { running: boolean }>} */
    const statuses = {};
    for (const id of running) {
      statuses[id] = { running: true };
    }
    const servers = Settings.getMcpServers();
    for (const s of servers) {
      if (!statuses[s.id]) {
        statuses[s.id] = { running: processManager.isRunning(s.id) };
      }
    }
    ModelConfigPanel._panel.webview.postMessage({
      type: "mcpStatus",
      statuses,
    });
  }

  /**
   * @param {Omit<import('./Settings').ModelConfig, 'id'> & { apiKey?: string }} config
   */
  static async _addModel(config) {
    const models = Settings.getModels();
    const newModel = { id: ModelConfigPanel._uuid(), ...config };
    models.push(newModel);
    await Settings.setModels(models);
    if (config.apiKey) await Settings.setApiKey(newModel.id, config.apiKey);
    if (models.length === 1) await Settings.setDefaultModel(newModel.id);
    ModelConfigPanel._postData();
    if (ModelConfigPanel._onChanged) ModelConfigPanel._onChanged();
  }

  /**
   * @param {string} configId
   * @param {Partial<import('./Settings').ModelConfig> & { apiKey?: string }} config
   */
  static async _updateModel(configId, config) {
    const models = Settings.getModels();
    const idx = models.findIndex((m) => m.id === configId);
    if (idx === -1) return;
    if (config.name !== undefined) models[idx].name = config.name;
    if (config.provider !== undefined) models[idx].provider = config.provider;
    if (config.modelId !== undefined) models[idx].modelId = config.modelId;
    if (config.endpoint !== undefined) models[idx].endpoint = config.endpoint;
    await Settings.setModels(models);
    if (config.apiKey) await Settings.setApiKey(configId, config.apiKey);
    ModelConfigPanel._postData();
    if (ModelConfigPanel._onChanged) ModelConfigPanel._onChanged();
  }

  /** @param {string} configId */
  static async _deleteModel(configId) {
    let models = Settings.getModels();
    models = models.filter((m) => m.id !== configId);
    await Settings.setModels(models);
    await Settings.setApiKey(configId, "");
    if (Settings.getDefaultModel() === configId) {
      await Settings.setDefaultModel(models.length > 0 ? models[0].id : "");
    }
    ModelConfigPanel._postData();
    if (ModelConfigPanel._onChanged) ModelConfigPanel._onChanged();
  }

  /**
   * Reorder a model in the list. Order is the source of truth for the
   * settings list and the chat dropdown, so both follow automatically.
   * @param {string} configId
   * @param {"up" | "down"} direction
   */
  static async _moveModel(configId, direction) {
    const models = Settings.getModels();
    const idx = models.findIndex((m) => m.id === configId);
    if (idx === -1) return;
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= models.length) return;
    const [moved] = models.splice(idx, 1);
    models.splice(target, 0, moved);
    await Settings.setModels(models);
    ModelConfigPanel._postData();
    if (ModelConfigPanel._onChanged) ModelConfigPanel._onChanged();
  }

  /**
   * @param {string} serverId
   */
  static async _deleteMcp(serverId) {
    // Stop the process if running
    processManager.stop(serverId);
    let servers = Settings.getMcpServers();
    servers = servers.filter((s) => s.id !== serverId);
    await Settings.setMcpServers(servers);
    // Drop any approval mode stored for the removed server
    await Settings.clearMcpApprovalMode(serverId);
    ModelConfigPanel._postData();
  }

  /**
   * @param {import('./Settings').McpServer} server
   */
  static async _addMcp(server) {
    const servers = Settings.getMcpServers();
    const newServer = { ...server, id: ModelConfigPanel._uuid() };
    servers.push(newServer);
    await Settings.setMcpServers(servers);
    // Auto-start if it's a stdio server and enabled
    if (server.command && server.enabled !== false) {
      processManager.start(newServer);
    }
    ModelConfigPanel._postData();
  }

  /**
   * @param {string} serverId
   * @param {import('./Settings').McpServer} server
   */
  static async _updateMcp(serverId, server) {
    // Stop existing process if running
    processManager.stop(serverId);
    const servers = Settings.getMcpServers();
    const idx = servers.findIndex((s) => s.id === serverId);
    if (idx === -1) return;
    servers[idx] = { ...servers[idx], ...server };
    await Settings.setMcpServers(servers);
    // Auto-restart if it's a stdio server and enabled
    if (server.command && servers[idx].enabled !== false) {
      processManager.start(servers[idx]);
    }
    ModelConfigPanel._postData();
  }

  /**
   * @param {string} serverId
   * @param {boolean} enabled
   */
  static async _setMcpEnabled(serverId, enabled) {
    const servers = Settings.getMcpServers();
    const idx = servers.findIndex((s) => s.id === serverId);
    if (idx === -1) return;
    servers[idx].enabled = enabled;
    await Settings.setMcpServers(servers);

    if (servers[idx].command) {
      if (enabled) {
        processManager.start(servers[idx]);
      } else {
        processManager.stop(serverId);
      }
    }
    ModelConfigPanel._postData();
  }

  /**
   * @param {string} serverId
   */
  static async _startMcpServer(serverId) {
    const servers = Settings.getMcpServers();
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    if (!server.command) {
      vscode.window.showErrorMessage("CCE: Cannot start — this server has no command configured.");
      return;
    }
    processManager.start(server);
    ModelConfigPanel._postMcpStatus();
  }

  /**
   * @param {string} serverId
   */
  static async _stopMcpServer(serverId) {
    processManager.stop(serverId);
    ModelConfigPanel._postMcpStatus();
  }

  /** @param {string} sessionId @param {"global"|"workspace"} scope */
  static async _deleteSession(sessionId, scope) {
    await Settings.deleteSession(sessionId, scope);
    ModelConfigPanel._postData();
  }

  static async _deleteExpiredSessions() {
    await Settings.deleteExpiredSessions();
    ModelConfigPanel._postData();
  }

  static _uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

module.exports = ModelConfigPanel;

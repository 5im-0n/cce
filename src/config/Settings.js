const vscode = require("vscode");

/**
 * Persistent config backed by VSCode globalState (model definitions, tools, etc.)
 * and secrets (API keys stored in OS keychain).
 *
 * Sessions are stored per-workspace when a workspace/folder is open;
 * otherwise they fall back to globalState (single-file mode).
 */

/** @type {vscode.ExtensionContext} */
let _ctx;

const MODELS_KEY = "cce.models";
const DEFAULT_MODEL_KEY = "cce.defaultModel";
const SYSTEM_PROMPT_KEY = "cce.systemPrompt";
const TOOLS_KEY = "cce.tools";
const CONTEXT_KEY = "cce.contextFlags";
const SESSIONS_KEY = "cce.sessions";
const CURRENT_SESSION_KEY = "cce.currentSessionId";
const MCP_KEY = "cce.mcpServers";
const API_KEY_PREFIX = "cce.apiKey.";

/**
 * Must be called once during activate() with the extension context.
 * @param {vscode.ExtensionContext} context
 */
function init(context) {
  _ctx = context;
}

/**
 * Returns workspaceState when a workspace/folder is open, globalState
 * otherwise.  Used for session storage so each workspace gets its own
 * sessions while single-file windows still persist.
 * @returns {vscode.Memento}
 */
function _getMemento() {
  if (_ctx && vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return _ctx.workspaceState;
  }
  return _ctx.globalState;
}

/**
 * @returns {ModelConfig[]}
 */
function getModels() {
  return _ctx.globalState.get(MODELS_KEY, []);
}

/**
 * @param {ModelConfig[]} models
 */
async function setModels(models) {
  await _ctx.globalState.update(MODELS_KEY, models);
}

/**
 * @returns {string}
 */
function getDefaultModel() {
  return _ctx.globalState.get(DEFAULT_MODEL_KEY, "");
}

/**
 * @param {string} modelId
 */
async function setDefaultModel(modelId) {
  await _ctx.globalState.update(DEFAULT_MODEL_KEY, modelId);
}

/**
 * Retrieve an API key from the OS keychain.
 * @param {string} configId
 * @returns {Promise<string | undefined>}
 */
async function getApiKey(configId) {
  return await _ctx.secrets.get(API_KEY_PREFIX + configId);
}

/**
 * Store or delete an API key in the OS keychain.
 * Pass an empty string to delete.
 * @param {string} configId
 * @param {string} key
 */
async function setApiKey(configId, key) {
  if (key) {
    await _ctx.secrets.store(API_KEY_PREFIX + configId, key);
  } else {
    await _ctx.secrets.delete(API_KEY_PREFIX + configId);
  }
}

/**
 * @typedef {Object} ModelConfig
 * @property {string} id        - Unique config ID (UUID)
 * @property {string} name      - Display name shown in dropdown
 * @property {string} provider  - "openai" | "anthropic" | "ollama"
 * @property {string} modelId   - Actual model identifier (e.g. "gpt-4o")
 * @property {string} endpoint  - API base URL
 */

/**
 * @returns {string}
 */
function getSystemPrompt() {
  return _ctx.globalState.get(SYSTEM_PROMPT_KEY, "");
}

/**
 * @param {string} prompt
 */
async function setSystemPrompt(prompt) {
  await _ctx.globalState.update(SYSTEM_PROMPT_KEY, prompt);
}

/**
 * @returns {Record<string, boolean>}
 */
function getToolSettings() {
  return _ctx.globalState.get(TOOLS_KEY, {});
}

/**
 * @param {string} toolName
 * @param {boolean} enabled
 */
async function setToolEnabled(toolName, enabled) {
  const tools = getToolSettings();
  tools[toolName] = enabled;
  await _ctx.globalState.update(TOOLS_KEY, tools);
}

/**
 * @returns {Record<string, boolean>}
 */
function getContextFlags() {
  return _ctx.globalState.get(CONTEXT_KEY, {});
}

/**
 * @param {string} flag
 * @param {boolean} enabled
 */
async function setContextFlag(flag, enabled) {
  const flags = getContextFlags();
  flags[flag] = enabled;
  await _ctx.globalState.update(CONTEXT_KEY, flags);
}

/** @returns {boolean} */
function getUseAgentsMd() {
  return _ctx.globalState.get("cce.useAgentsMd", true);
}
/** @param {boolean} v */
async function setUseAgentsMd(v) {
  await _ctx.globalState.update("cce.useAgentsMd", v);
}
/** @returns {string} */
function getAgentsMdPath() {
  return _ctx.globalState.get("cce.agentsMdPath", "AGENTS.md");
}
/** @param {string} v */
async function setAgentsMdPath(v) {
  await _ctx.globalState.update("cce.agentsMdPath", v);
}

/**
 * @returns {Session[]}
 */
function getSessions() {
  return _getMemento().get(SESSIONS_KEY, []);
}

/**
 * @param {Session[]} sessions
 */
async function setSessions(sessions) {
  await _getMemento().update(SESSIONS_KEY, sessions);
}

/**
 * @returns {string}
 */
function getCurrentSessionId() {
  return _getMemento().get(CURRENT_SESSION_KEY, "");
}

/**
 * @param {string} id
 */
async function setCurrentSessionId(id) {
  await _getMemento().update(CURRENT_SESSION_KEY, id);
}

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Array<{role:string,content:string}>} messages
 */

/**
 * @typedef {Object} McpServer
 * @property {string} id       - Unique config ID
 * @property {string} name     - Display name
 * @property {string} [url]    - Server URL (for HTTP transport)
 * @property {Record<string, string>} [headers] - Optional HTTP headers
 * @property {string} [command] - Shell command to spawn (for stdio transport)
 * @property {string[]} [args]  - Arguments for the command
 * @property {boolean} [enabled] - Whether the server is active
 */

/**
 * @returns {McpServer[]}
 */
function getMcpServers() {
  return _ctx.globalState.get(MCP_KEY, []);
}

/**
 * @param {McpServer[]} servers
 */
async function setMcpServers(servers) {
  await _ctx.globalState.update(MCP_KEY, servers);
}

module.exports = { init, getModels, setModels, getDefaultModel, setDefaultModel, getApiKey, setApiKey, getSystemPrompt, setSystemPrompt, getToolSettings, setToolEnabled, getContextFlags, setContextFlag, getUseAgentsMd, setUseAgentsMd, getAgentsMdPath, setAgentsMdPath, getSessions, setSessions, getCurrentSessionId, setCurrentSessionId, getMcpServers, setMcpServers };


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
const APPROVAL_MODES_KEY = "cce.toolApprovalModes";
const MCP_APPROVAL_MODES_KEY = "cce.mcpApprovalModes";
const CONTEXT_KEY = "cce.contextFlags";
const SESSIONS_KEY = "cce.sessions";
const CURRENT_SESSION_KEY = "cce.currentSessionId";
const SESSIONS_MAX_AGE_KEY = "cce.sessionsMaxAge";
const REASONING_EFFORT_KEY = "cce.reasoningEffort";
const MCP_KEY = "cce.mcpServers";
const API_KEY_PREFIX = "cce.apiKey.";
const COMPACTION_KEY = "cce.compaction";

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
 * Per-tool approval mode overrides.
 * Map of toolName -> "auto" | "ask" | "deny". Missing entries fall back
 * to the default derived from the tool's risk classification.
 * @returns {Record<string, "auto"|"ask"|"deny">}
 */
function getToolApprovalModes() {
  return _ctx.globalState.get(APPROVAL_MODES_KEY, {});
}

/**
 * Set or clear the approval mode override for a tool.
 * @param {string} toolName
 * @param {"auto"|"ask"|"deny"} mode
 */
async function setToolApprovalMode(toolName, mode) {
  const modes = getToolApprovalModes();
  modes[toolName] = mode;
  await _ctx.globalState.update(APPROVAL_MODES_KEY, modes);
}

/**
 * Per-MCP-server approval mode overrides.
 * Map of serverId -> "auto" | "ask" | "deny". Missing entries fall back
 * to "ask" (MCP tools are classified as dangerous). Applies to every
 * tool exposed by the server; per-tool overrides do not apply to MCP.
 * @returns {Record<string, "auto"|"ask"|"deny">}
 */
function getMcpApprovalModes() {
  return _ctx.globalState.get(MCP_APPROVAL_MODES_KEY, {});
}

/**
 * Set the approval mode override for an MCP server.
 * @param {string} serverId
 * @param {"auto"|"ask"|"deny"} mode
 */
async function setMcpApprovalMode(serverId, mode) {
  const modes = getMcpApprovalModes();
  modes[serverId] = mode;
  await _ctx.globalState.update(MCP_APPROVAL_MODES_KEY, modes);
}

/**
 * Remove any stored approval mode for an MCP server (e.g. on delete).
 * @param {string} serverId
 */
async function clearMcpApprovalMode(serverId) {
  const modes = getMcpApprovalModes();
  if (modes[serverId] === undefined) return;
  delete modes[serverId];
  await _ctx.globalState.update(MCP_APPROVAL_MODES_KEY, modes);
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
 * Max age in days before sessions are auto-deleted. 0 = never.
 * Stored in globalState so it applies everywhere.
 * @returns {number}
 */
function getSessionsMaxAge() {
  return _ctx.globalState.get(SESSIONS_MAX_AGE_KEY, 0);
}

/**
 * @param {number} age - days (0 = never)
 */
async function setSessionsMaxAge(age) {
  await _ctx.globalState.update(SESSIONS_MAX_AGE_KEY, age);
}

/**
 * Return all sessions from BOTH scopes, each tagged with its origin.
 * Workspace sessions are only included when a workspace/folder is open.
 * @returns {Array<Session & { scope: "global" | "workspace" }>}
 */
function getAllSessions() {
  /** @type {Session[]} */
  const globalRaw = _ctx.globalState.get(SESSIONS_KEY, []) || [];
  const globalSessions = globalRaw.map((s) => /** @type {Session & { scope: "global" }} */ ({ ...s, scope: "global" }));
  const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
  if (!hasWorkspace) {
    return globalSessions;
  }
  /** @type {Session[]} */
  const workspaceRaw = _ctx.workspaceState.get(SESSIONS_KEY, []) || [];
  const workspaceSessions = workspaceRaw.map((s) => /** @type {Session & { scope: "workspace" }} */ ({ ...s, scope: "workspace" }));
  // Merge: workspace sessions first (most relevant), then global
  return [...workspaceSessions, ...globalSessions];
}

/**
 * Delete a single session from its scope.
 * @param {string} sessionId
 * @param {"global"|"workspace"} scope
 */
async function deleteSession(sessionId, scope) {
  const storage = scope === "workspace" ? _ctx.workspaceState : _ctx.globalState;
  /** @type {Session[]} */
  let sessions = storage.get(SESSIONS_KEY, []) || [];
  sessions = sessions.filter((s) => s.id !== sessionId);
  await storage.update(SESSIONS_KEY, sessions);
}

/**
 * Delete all sessions (global + workspace) older than the configured maxAgeDays.
 */
async function deleteExpiredSessions() {
  const maxAge = getSessionsMaxAge();
  if (maxAge <= 0) return;
  const cutoff = Date.now() - maxAge * 86400000;

  // Global sessions
  /** @type {Session[]} */
  let globalSessions = _ctx.globalState.get(SESSIONS_KEY, []) || [];
  globalSessions = globalSessions.filter((s) => new Date(s.updatedAt).getTime() >= cutoff);
  await _ctx.globalState.update(SESSIONS_KEY, globalSessions);

  // Workspace sessions (if a workspace is open)
  const hasWorkspace = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0;
  if (hasWorkspace) {
    /** @type {Session[]} */
    let wsSessions = _ctx.workspaceState.get(SESSIONS_KEY, []) || [];
    wsSessions = wsSessions.filter((s) => new Date(s.updatedAt).getTime() >= cutoff);
    await _ctx.workspaceState.update(SESSIONS_KEY, wsSessions);
  }
}

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} title
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Array<{ role: string, content: string | null }>} messages
 * @property {string} [summary] - Rolling summary of compacted messages
 * @property {number} [summaryTurns] - Number of user turns covered by the summary
 */

/**
 * @typedef {Object} CompactionSettings
 * @property {"off"|"auto"|"ask"} mode
 * @property {number} threshold - Trigger threshold in tokens
 * @property {number} keepTurns - Number of recent user turns kept verbatim
 */

/**
 * @returns {CompactionSettings}
 */
function getCompaction() {
  const cfg = _ctx.globalState.get(COMPACTION_KEY, {});
  return {
    mode: cfg.mode === "auto" || cfg.mode === "ask" ? cfg.mode : "off",
    threshold: typeof cfg.threshold === "number" && cfg.threshold > 0 ? cfg.threshold : 300000,
    keepTurns: typeof cfg.keepTurns === "number" && cfg.keepTurns > 0 ? cfg.keepTurns : 10,
  };
}

/**
 * @param {Partial<CompactionSettings>} cfg
 */
async function setCompaction(cfg) {
  const current = getCompaction();
  const next = {
    mode: cfg && (cfg.mode === "auto" || cfg.mode === "ask") ? cfg.mode : "off",
    threshold: cfg && typeof cfg.threshold === "number" && cfg.threshold > 0 ? cfg.threshold : current.threshold,
    keepTurns: cfg && typeof cfg.keepTurns === "number" && cfg.keepTurns > 0 ? cfg.keepTurns : current.keepTurns,
  };
  await _ctx.globalState.update(COMPACTION_KEY, next);
}

/**
 * @returns {string}
 */
function getReasoningEffort() {
  return _ctx.globalState.get(REASONING_EFFORT_KEY, "medium");
}

/**
 * @param {string} effort - "off" | "low" | "medium" | "high" | "max"
 */
async function setReasoningEffort(effort) {
  await _ctx.globalState.update(REASONING_EFFORT_KEY, effort);
}

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

module.exports = { init, getModels, setModels, getDefaultModel, setDefaultModel, getApiKey, setApiKey, getSystemPrompt, setSystemPrompt, getToolSettings, setToolEnabled, getToolApprovalModes, setToolApprovalMode, getMcpApprovalModes, setMcpApprovalMode, clearMcpApprovalMode, getContextFlags, setContextFlag, getUseAgentsMd, setUseAgentsMd, getAgentsMdPath, setAgentsMdPath, getSessions, setSessions, getCurrentSessionId, setCurrentSessionId, getSessionsMaxAge, setSessionsMaxAge, getAllSessions, deleteSession, deleteExpiredSessions, getReasoningEffort, setReasoningEffort, getMcpServers, setMcpServers, getCompaction, setCompaction };


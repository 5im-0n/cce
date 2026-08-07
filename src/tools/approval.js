/**
 * Approval policy for tool execution.
 *
 * Every tool call is classified by risk and then resolved to an approval mode:
 *   - "auto"  → executes immediately, no prompt
 *   - "ask"   → shows an approval card in the chat and waits for the user
 *   - "deny"  → never executes; the model gets a denial result
 *
 * Resolution priority: session override > persisted per-tool mode > default.
 */

/** How long an approval request waits before being auto-denied. */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Tools that only read state and never mutate anything. */
const READ_TOOLS = new Set([
  "read_file",
  "get_selection",
  "search_code",
  "list_files",
  "get_diagnostics",
]);

/** Tools that modify the workspace (files). */
const MODIFY_TOOLS = new Set(["write_file", "edit_file", "delete_files"]);

/** Tools with arbitrary/unbounded side effects (shell, sub-agents). */
const DANGEROUS_TOOLS = new Set(["run_command", "agent"]);

/**
 * Classify a tool by risk level.
 * @param {string} toolName
 * @returns {"read"|"modify"|"dangerous"}
 */
function classifyTool(toolName) {
  if (toolName.startsWith("mcp__")) return "dangerous"; // unknown side effects
  if (READ_TOOLS.has(toolName)) return "read";
  if (MODIFY_TOOLS.has(toolName)) return "modify";
  if (DANGEROUS_TOOLS.has(toolName)) return "dangerous";
  return "dangerous"; // unknown tool — be safe
}

/**
 * Default approval mode for a tool when the user has not overridden it.
 * @param {string} toolName
 * @returns {"auto"|"ask"}
 */
function defaultMode(toolName) {
  return classifyTool(toolName) === "read" ? "auto" : "ask";
}

/**
 * Resolve the effective approval mode for a tool call.
 *
 * @param {string} toolName
 * @param {Set<string>} sessionApprovals - tool names approved for this session
 * @param {Record<string, "auto"|"ask"|"deny">} persistedModes - per-tool overrides
 * @returns {"auto"|"ask"|"deny"}
 */
function resolveMode(toolName, sessionApprovals, persistedModes) {
  if (sessionApprovals.has(toolName)) return "auto";
  const mode = persistedModes[toolName];
  if (mode === "auto" || mode === "ask" || mode === "deny") return mode;
  return defaultMode(toolName);
}

/**
 * Human-readable risk label for the approval card UI.
 * @param {"read"|"modify"|"dangerous"} risk
 * @returns {string}
 */
function riskLabel(risk) {
  switch (risk) {
    case "read":
      return "Read-only";
    case "modify":
      return "Modifies files";
    case "dangerous":
      return "Arbitrary execution";
    default:
      return "Unknown";
  }
}

module.exports = { APPROVAL_TIMEOUT_MS, classifyTool, defaultMode, resolveMode, riskLabel };

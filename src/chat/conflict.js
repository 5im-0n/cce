/**
 * Cross-chat conflict detection for the approval card.
 *
 * Several CCE chats can run at the same time in the same workspace. Nothing
 * here blocks anything: when a tool that modifies the workspace is about to
 * run, the chat asks this module whether another chat is currently touching
 * the same file (or running a shell command), and shows a warning in the
 * approval card so the user can decide. Serialization is deliberately not
 * implemented — the user juggles.
 *
 * Pure module (no `vscode`), so the rules are unit-testable.
 */

/**
 * @typedef {Object} ConflictTarget
 * @property {"file"|"workspace"} type - "file" for path-scoped tools, "workspace"
 *   for tools with unbounded effects (shell commands, sub-agents).
 * @property {string} [path] - Normalized workspace-relative path ("file" only).
 */

/**
 * @typedef {Object} ChatActivity
 * @property {string} chatId
 * @property {string} chatTitle
 * @property {string} toolName
 * @property {Array<ConflictTarget>} targets
 */

/**
 * @typedef {Object} Conflict
 * @property {string} chatId
 * @property {string} chatTitle
 * @property {string} toolName
 * @property {string} target - Human-readable target ("src/a.js" or "the workspace")
 */

/**
 * Normalize a workspace-relative path for comparison: forward slashes, no
 * leading "./" or "/", no trailing slash. Case is folded because the workspace
 * may live on a case-insensitive file system.
 *
 * @param {unknown} filePath
 * @returns {string} Normalized path, or "" when unusable.
 */
function normalizePath(filePath) {
  if (typeof filePath !== "string") return "";
  let p = filePath.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  p = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p.toLowerCase();
}

/**
 * The workspace-relative targets a tool call touches.
 *
 * File tools resolve to their `path` argument. `run_command` and `agent` have
 * unbounded effects, so they report a workspace-wide target.
 *
 * @param {string} toolName
 * @param {Record<string, any>} [args]
 * @returns {Array<ConflictTarget>}
 */
function targets(toolName, args) {
  const a = args && typeof args === "object" ? args : {};
  switch (toolName) {
    case "write_file":
    case "edit_file":
    case "delete_files": {
      const p = normalizePath(a.path);
      return p ? [{ type: "file", path: p }] : [{ type: "workspace" }];
    }
    case "run_command":
    case "agent":
      return [{ type: "workspace" }];
    default:
      // MCP tools have unknown side effects; treat them as workspace-wide.
      return toolName.startsWith("mcp__") ? [{ type: "workspace" }] : [];
  }
}

/**
 * Whether two targets can interfere with each other. A workspace-wide target
 * always interferes; two file targets interfere when they are the same path or
 * one is a parent directory of the other (delete_files targets directories).
 *
 * @param {ConflictTarget} a
 * @param {ConflictTarget} b
 * @returns {boolean}
 */
function overlaps(a, b) {
  if (a.type === "workspace" || b.type === "workspace") return true;
  const p = a.path || "";
  const q = b.path || "";
  if (!p || !q) return true;
  if (p === q) return true;
  return p.startsWith(q + "/") || q.startsWith(p + "/");
}

/**
 * Find in-flight tool calls from *other* chats that overlap this one.
 *
 * @param {Array<ChatActivity>} activity - Tools currently executing, all chats.
 * @param {string} selfChatId - The chat about to run `toolName`.
 * @param {string} toolName
 * @param {Record<string, any>} [args]
 * @returns {Array<Conflict>}
 */
function findConflicts(activity, selfChatId, toolName, args) {
  const mine = targets(toolName, args);
  if (mine.length === 0) return [];
  /** @type {Array<Conflict>} */
  const conflicts = [];
  for (const other of Array.isArray(activity) ? activity : []) {
    if (!other || other.chatId === selfChatId) continue;
    for (const theirs of other.targets || []) {
      const hit = mine.find((t) => overlaps(t, theirs));
      if (!hit) continue;
      conflicts.push({
        chatId: other.chatId,
        chatTitle: other.chatTitle,
        toolName: other.toolName,
        target: (hit.type === "workspace" || theirs.type === "workspace")
          ? "the workspace"
          : (theirs.path || hit.path || "a file"),
      });
      break; // one warning per other chat is enough
    }
  }
  return conflicts;
}

/**
 * Render a conflict as a one-line warning for the approval card.
 *
 * @param {Conflict} conflict
 * @returns {string}
 */
function describeConflict(conflict) {
  const title = conflict.chatTitle || "Another chat";
  const verb = conflict.toolName === "run_command" ? "is running a command in" : "is modifying";
  return "Chat \u201c" + title + "\u201d " + verb + " " + conflict.target + " right now.";
}

module.exports = { targets, overlaps, findConflicts, describeConflict, normalizePath };

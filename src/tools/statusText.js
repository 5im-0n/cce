/**
 * Transient tool-status helpers for the chat webview.
 *
 * Produces the short status lines shown while a tool is pending or running,
 * e.g. "Running run_command: git status". Kept in their own module so the
 * logic can be unit-tested without pulling in the vscode dependency.
 */

// Max length of a command shown in the transient status line. Longer
// commands are truncated; the full command stays visible in the tool
// details block that is rendered after the tool completes.
const MAX_STATUS_COMMAND_LENGTH = 200;

/**
 * Build the trailing part of a tool status line.
 *
 * For `run_command` the exact command is included so the user can see what
 * is being executed (e.g. "Running run_command: git status"). All other
 * tools keep the ellipsis suffix (e.g. "Running read_file…").
 *
 * @param {string} toolName - Name of the tool being executed.
 * @param {{ command?: string }} [args] - Parsed tool arguments.
 * @returns {string} ": <command>" when the command is known, otherwise "\u2026".
 */
function toolStatusSuffix(toolName, args) {
  if (
    toolName === "run_command" &&
    args &&
    typeof args.command === "string" &&
    args.command.trim() !== ""
  ) {
    // Collapse newlines and runs of whitespace so multi-line commands stay
    // readable on the single-line status indicator.
    const cmd = args.command.replace(/\s+/g, " ").trim();
    const shown =
      cmd.length > MAX_STATUS_COMMAND_LENGTH
        ? cmd.slice(0, MAX_STATUS_COMMAND_LENGTH) + "\u2026"
        : cmd;
    return ": " + shown;
  }
  return "\u2026";
}

module.exports = { toolStatusSuffix, MAX_STATUS_COMMAND_LENGTH };

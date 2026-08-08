"use strict";

/**
 * Shell detection for the run_command tool.
 *
 * child_process.exec does NOT use the user's interactive shell, so the model
 * cannot infer the syntax from the user's terminal. This module detects what
 * cp.exec actually spawns and produces model-facing guidance:
 *
 *   - Windows: cmd.exe via %ComSpec%
 *   - POSIX:   /bin/sh (dash on Debian/Ubuntu; bash in POSIX mode elsewhere)
 *
 * The user's $SHELL / VSCode terminal profile is deliberately ignored — it
 * would give the model wrong information about the shell that runs commands.
 */

/**
 * @typedef {Object} ExecShellInfo
 * @property {string} shell    - Path (or name) of the shell cp.exec spawns
 * @property {string} family   - Normalized family: "cmd" | "posix-sh"
 * @property {string} guidance - Model-facing syntax guidance for that shell
 */

/**
 * Detect the shell used by child_process.exec.
 *
 * @param {string} [platform] - Override process.platform (for tests)
 * @param {string} [comSpec]  - Override %ComSpec% (for tests)
 * @returns {ExecShellInfo}
 */
function getExecShellInfo(platform = process.platform, comSpec = process.env.ComSpec) {
  if (platform === "win32") {
    const shell = comSpec || "cmd.exe";
    return {
      shell,
      family: "cmd",
      guidance:
        "Commands run via child_process.exec always use cmd.exe on Windows " +
        "(the value of %ComSpec%) — never PowerShell and never your VSCode terminal profile. " +
        "Write cmd/batch syntax: `dir`, `type`, `copy`, `del`, `cd`, `echo`, `set VAR=value`, " +
        "reference env vars as `%VAR%`, join commands with `&&`. " +
        "Do NOT use bash or PowerShell syntax: no `ls`, `grep`, `cat`, `rm`, `$VAR`, `${VAR}`, " +
        "`$(...)`, backticks, or `export` — cmd.exe will reject them.",
    };
  }

  return {
    shell: "/bin/sh",
    family: "posix-sh",
    guidance:
      "Commands run via child_process.exec use /bin/sh (a plain POSIX shell — dash on " +
      "Debian/Ubuntu, bash in POSIX mode elsewhere), not your interactive shell. " +
      "Write portable POSIX sh: `ls`, `grep`, `cat`, `rm`, `$VAR`, `$(command)`, `&&`/`||`, " +
      "single or double quotes. Avoid bash-only features: arrays, `[[ ]]`, process substitution " +
      "`<(...)`, `&>` redirects, `source` (use `.`), `pushd`/`popd`.",
  };
}

/**
 * Full, one-line summary for the model: "Shell: <shell> — <guidance>".
 * Appended to the run_command tool description so the model sees it whenever
 * the tool is offered.
 *
 * @param {string} [platform]
 * @param {string} [comSpec]
 * @returns {string}
 */
function describeShellForModel(platform, comSpec) {
  const info = getExecShellInfo(platform, comSpec);
  return `Shell: ${info.shell} — ${info.guidance}`;
}

/**
 * Brief label for the system-prompt context block (e.g. next to Platform/OS).
 * Kept short to avoid token cost on every request; the full guidance already
 * travels with the run_command tool definition.
 *
 * @param {string} [platform]
 * @param {string} [comSpec]
 * @returns {string}
 */
function describeShellBrief(platform, comSpec) {
  const info = getExecShellInfo(platform, comSpec);
  const label = info.family === "cmd" ? "Windows cmd.exe (batch)" : "POSIX sh (/bin/sh)";
  return `Shell: ${label}`;
}

module.exports = { getExecShellInfo, describeShellForModel, describeShellBrief };

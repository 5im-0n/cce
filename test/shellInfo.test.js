/**
 * Tests for shell detection used by run_command (src/tools/shellInfo.js)
 * and the guidance injection in tool definitions (src/tools/definitions.js).
 * Run with: node --test test/shellInfo.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getExecShellInfo,
  describeShellForModel,
  describeShellBrief,
} = require("../src/tools/shellInfo");
const { getEnabledDefinitions } = require("../src/tools/definitions");

// ── getExecShellInfo ───────────────────────────────────────

test("win32 resolves to cmd family with ComSpec path", () => {
  const info = getExecShellInfo("win32", "C:\\Windows\\system32\\cmd.exe");
  assert.equal(info.family, "cmd");
  assert.equal(info.shell, "C:\\Windows\\system32\\cmd.exe");
});

test("win32 falls back to cmd.exe when ComSpec is unset", () => {
  const info = getExecShellInfo("win32", "");
  assert.equal(info.shell, "cmd.exe");
  assert.equal(info.family, "cmd");
});

test("cmd guidance names the shell and forbids bash syntax", () => {
  const info = getExecShellInfo("win32");
  assert.match(info.guidance, /cmd\.exe/);
  assert.match(info.guidance, /%VAR%/);
  assert.match(info.guidance, /never PowerShell/i);
  // Must explicitly warn about the syntax traps models fall into
  assert.match(info.guidance, /no `ls`/i);
  assert.match(info.guidance, /\$VAR/);
  assert.match(info.guidance, /backticks/);
});

test("posix resolves to /bin/sh and posix-sh family", () => {
  const info = getExecShellInfo("linux");
  assert.equal(info.family, "posix-sh");
  assert.equal(info.shell, "/bin/sh");
  const darwin = getExecShellInfo("darwin");
  assert.equal(darwin.family, "posix-sh");
});

test("posix guidance warns against bash-only features", () => {
  const info = getExecShellInfo("darwin");
  assert.match(info.guidance, /\/bin\/sh/);
  assert.match(info.guidance, /bash-only/);
  assert.match(info.guidance, /\[\[ \]\]/);
});

// ── describeShellForModel / describeShellBrief ─────────────

test("describeShellForModel starts with Shell: and includes guidance", () => {
  const line = describeShellForModel("win32");
  assert.ok(line.startsWith("Shell: "));
  assert.match(line, /cmd\.exe/);
  assert.match(line, /Commands run via child_process\.exec/);
});

test("describeShellBrief is short and platform-specific", () => {
  assert.equal(describeShellBrief("win32"), "Shell: Windows cmd.exe (batch)");
  assert.equal(describeShellBrief("linux"), "Shell: POSIX sh (/bin/sh)");
});

// ── definition injection ───────────────────────────────────

test("run_command definition carries shell guidance", () => {
  const tools = getEnabledDefinitions({});
  const runCommand = tools.find((t) => t.function.name === "run_command");
  assert.ok(runCommand, "run_command should be enabled by default");
  assert.match(runCommand.function.description, /Shell: /);
  assert.match(runCommand.function.description, /child_process\.exec/);
});

test("run_command command parameter reminds about shell syntax", () => {
  const tools = getEnabledDefinitions({});
  const runCommand = tools.find((t) => t.function.name === "run_command");
  const commandParam = runCommand.function.parameters.properties.command;
  assert.match(commandParam.description, /shell/i);
});

test("other tool definitions are left unchanged", () => {
  const tools = getEnabledDefinitions({});
  for (const t of tools) {
    if (t.function.name === "run_command") continue;
    assert.ok(!t.function.description.includes("Shell: "), `${t.function.name} should not have shell guidance`);
  }
});

test("getEnabledDefinitions still filters and maps as before", () => {
  // 'agent' stays opt-in; read_file stays on by default
  const tools = getEnabledDefinitions({});
  assert.ok(tools.find((t) => t.function.name === "read_file"));
  assert.ok(!tools.find((t) => t.function.name === "agent"));
  const withAgent = getEnabledDefinitions({ agent: true });
  assert.ok(withAgent.find((t) => t.function.name === "agent"));
});

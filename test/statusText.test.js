/**
 * Tests for the transient tool status helpers (src/tools/statusText.js).
 * Run with: node --test test/statusText.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { toolStatusSuffix, MAX_STATUS_COMMAND_LENGTH } = require("../src/tools/statusText");

test("run_command includes the command in the status suffix", () => {
  assert.equal(toolStatusSuffix("run_command", { command: "git status" }), ": git status");
});

test("run_command collapses multi-line and extra whitespace", () => {
  assert.equal(toolStatusSuffix("run_command", { command: "echo a &&\necho b" }), ": echo a && echo b");
  assert.equal(toolStatusSuffix("run_command", { command: "  npm   install  " }), ": npm install");
});

test("run_command with a missing, empty, or non-string command falls back to ellipsis", () => {
  assert.equal(toolStatusSuffix("run_command", {}), "\u2026");
  assert.equal(toolStatusSuffix("run_command", { command: "   " }), "\u2026");
  assert.equal(toolStatusSuffix("run_command", { command: 42 }), "\u2026");
  assert.equal(toolStatusSuffix("run_command", null), "\u2026");
  assert.equal(toolStatusSuffix("run_command", undefined), "\u2026");
});

test("run_command truncates very long commands with an ellipsis", () => {
  const long = "x".repeat(MAX_STATUS_COMMAND_LENGTH + 50);
  const suffix = toolStatusSuffix("run_command", { command: long });
  assert.ok(suffix.startsWith(": " + "x".repeat(MAX_STATUS_COMMAND_LENGTH)));
  assert.ok(suffix.endsWith("\u2026"));
  // ": " (2) + command (200) + "…" (1)
  assert.equal(suffix.length, MAX_STATUS_COMMAND_LENGTH + 3);
});

test("non-command tools keep the ellipsis suffix even with a command-shaped arg", () => {
  assert.equal(toolStatusSuffix("read_file", { path: "src/extension.js" }), "\u2026");
  assert.equal(toolStatusSuffix("agent", { task: "x" }), "\u2026");
  assert.equal(toolStatusSuffix("mcp__server__tool", { command: "not run_command" }), "\u2026");
});

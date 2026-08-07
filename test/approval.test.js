/**
 * Tests for the tool approval policy logic (src/tools/approval.js).
 * Run with: node --test test/approval.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const approval = require("../src/tools/approval");

test("classifyTool returns expected risk levels", () => {
  assert.equal(approval.classifyTool("read_file"), "read");
  assert.equal(approval.classifyTool("get_selection"), "read");
  assert.equal(approval.classifyTool("search_code"), "read");
  assert.equal(approval.classifyTool("list_files"), "read");
  assert.equal(approval.classifyTool("get_diagnostics"), "read");

  assert.equal(approval.classifyTool("write_file"), "modify");
  assert.equal(approval.classifyTool("edit_file"), "modify");
  assert.equal(approval.classifyTool("delete_files"), "modify");

  assert.equal(approval.classifyTool("run_command"), "dangerous");
  assert.equal(approval.classifyTool("agent"), "dangerous");

  // Any MCP tool is dangerous (unknown side effects)
  assert.equal(approval.classifyTool("mcp__server1__tavily_search"), "dangerous");

  // Unknown tools default to dangerous (fail-safe)
  assert.equal(approval.classifyTool("some_future_tool"), "dangerous");
});

test("defaultMode: read tools auto, everything else ask", () => {
  assert.equal(approval.defaultMode("read_file"), "auto");
  assert.equal(approval.defaultMode("write_file"), "ask");
  assert.equal(approval.defaultMode("run_command"), "ask");
  assert.equal(approval.defaultMode("mcp__s__t"), "ask");
  assert.equal(approval.defaultMode("unknown"), "ask");
});

test("resolveMode: session override wins", () => {
  const session = new Set(["run_command"]);
  const persisted = {};
  assert.equal(approval.resolveMode("run_command", session, persisted), "auto");
});

test("resolveMode: persisted mode wins over default", () => {
  const session = new Set();
  assert.equal(approval.resolveMode("run_command", session, { run_command: "deny" }), "deny");
  assert.equal(approval.resolveMode("read_file", session, { read_file: "ask" }), "ask");
  assert.equal(approval.resolveMode("write_file", session, { write_file: "auto" }), "auto");
});

test("resolveMode: falls back to default when no override", () => {
  const session = new Set();
  assert.equal(approval.resolveMode("read_file", session, {}), "auto");
  assert.equal(approval.resolveMode("edit_file", session, {}), "ask");
  // Invalid persisted values are ignored
  assert.equal(approval.resolveMode("read_file", session, { read_file: "banana" }), "auto");
});

test("riskLabel returns a string for every risk level", () => {
  for (const risk of ["read", "modify", "dangerous"]) {
    assert.equal(typeof approval.riskLabel(risk), "string");
    assert.ok(approval.riskLabel(risk).length > 0);
  }
});

test("APPROVAL_TIMEOUT_MS is a positive number", () => {
  assert.equal(typeof approval.APPROVAL_TIMEOUT_MS, "number");
  assert.ok(approval.APPROVAL_TIMEOUT_MS > 0);
});

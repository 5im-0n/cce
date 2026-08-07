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

test("getMcpServerId parses MCP tool names", () => {
  assert.equal(approval.getMcpServerId("mcp__abc-123__tavily_search"), "abc-123");
  assert.equal(approval.getMcpServerId("mcp__abc-123__tool__with__underscores"), "abc-123");
  assert.equal(approval.getMcpServerId("mcp__abc-123"), "abc-123");
  // Non-MCP tools and malformed names
  assert.equal(approval.getMcpServerId("read_file"), null);
  assert.equal(approval.getMcpServerId("mcp__"), null);
});

test("resolveMode: session override wins (non-MCP)", () => {
  const session = new Set(["run_command"]);
  const persisted = {};
  assert.equal(approval.resolveMode("run_command", session, persisted, {}, new Set()), "auto");
});

test("resolveMode: persisted mode wins over default (non-MCP)", () => {
  const session = new Set();
  assert.equal(approval.resolveMode("run_command", session, { run_command: "deny" }, {}, new Set()), "deny");
  assert.equal(approval.resolveMode("read_file", session, { read_file: "ask" }, {}, new Set()), "ask");
  assert.equal(approval.resolveMode("write_file", session, { write_file: "auto" }, {}, new Set()), "auto");
});

test("resolveMode: falls back to default when no override (non-MCP)", () => {
  const session = new Set();
  assert.equal(approval.resolveMode("read_file", session, {}, {}, new Set()), "auto");
  assert.equal(approval.resolveMode("edit_file", session, {}, {}, new Set()), "ask");
  // Invalid persisted values are ignored
  assert.equal(approval.resolveMode("read_file", session, { read_file: "banana" }, {}, new Set()), "auto");
});

test("resolveMode: MCP tools default to ask", () => {
  assert.equal(approval.resolveMode("mcp__s1__some_tool", new Set(), {}, {}, new Set()), "ask");
});

test("resolveMode: MCP server mode applies to every tool of that server", () => {
  const serverModes = { s1: "auto", s2: "deny" };
  assert.equal(approval.resolveMode("mcp__s1__tool_a", new Set(), {}, serverModes, new Set()), "auto");
  assert.equal(approval.resolveMode("mcp__s1__tool_b", new Set(), {}, serverModes, new Set()), "auto");
  assert.equal(approval.resolveMode("mcp__s2__tool_a", new Set(), {}, serverModes, new Set()), "deny");
  // Unknown server falls back to ask
  assert.equal(approval.resolveMode("mcp__s3__tool", new Set(), {}, serverModes, new Set()), "ask");
});

test("resolveMode: per-tool persisted override is ignored for MCP tools", () => {
  // Even if a stale per-tool "auto" entry exists, MCP resolution is
  // strictly server-level and falls back to ask.
  const persisted = { "mcp__s1__tool": "auto", "mcp__s1__other": "deny" };
  assert.equal(approval.resolveMode("mcp__s1__tool", new Set(), persisted, {}, new Set()), "ask");
  assert.equal(approval.resolveMode("mcp__s1__other", new Set(), persisted, {}, new Set()), "ask");
});

test("resolveMode: per-tool session override is ignored for MCP tools", () => {
  // A tool name in the session set does not approve an MCP call — only
  // the server-level session set matters.
  const session = new Set(["mcp__s1__tool"]);
  assert.equal(approval.resolveMode("mcp__s1__tool", session, {}, {}, new Set()), "ask");
});

test("resolveMode: session server approval wins for MCP tools", () => {
  // Session approval is scoped to the server: it beats a persisted deny
  // and applies to every tool the server exposes.
  const sessionServers = new Set(["s1"]);
  const serverModes = { s1: "deny", s2: "deny" };
  assert.equal(approval.resolveMode("mcp__s1__tool_a", new Set(), {}, serverModes, sessionServers), "auto");
  assert.equal(approval.resolveMode("mcp__s1__tool_b", new Set(), {}, serverModes, sessionServers), "auto");
  // Other servers and non-MCP tools are unaffected
  assert.equal(approval.resolveMode("mcp__s2__tool", new Set(), {}, serverModes, sessionServers), "deny");
  assert.equal(approval.resolveMode("run_command", new Set(), {}, {}, sessionServers), "ask");
});

test("resolveMode: session server approval when no server mode set", () => {
  const sessionServers = new Set(["s1"]);
  assert.equal(approval.resolveMode("mcp__s1__tool", new Set(), {}, {}, sessionServers), "auto");
});

test("resolveMode: server modes never affect non-MCP tools", () => {
  const serverModes = { s1: "deny" };
  assert.equal(approval.resolveMode("read_file", new Set(), {}, serverModes, new Set()), "auto");
  assert.equal(approval.resolveMode("run_command", new Set(), {}, serverModes, new Set()), "ask");
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

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeTasks,
  formatAgentReport,
  truncateTaskText,
  taskCharBudget,
  MAX_REPORT_CHARS,
  MIN_TASK_REPORT_CHARS,
} = require("../src/chat/agent-run");

/**
 * The report a sub-agent run hands back to the parent model.
 *
 * A joined string could not express failure: a child that hit a 429, lost its
 * MCP server or was closed by the user arrived as `(no output)`, which the
 * parent model reasonably read as a finished, empty answer. These tests pin the
 * shape that makes each outcome say what it is.
 */

test("tasks are normalised, and a malformed argument yields no tasks", () => {
  assert.deepEqual(normalizeTasks([" a ", "b"]), ["a", "b"]);
  assert.deepEqual(normalizeTasks(["", "   ", "c"]), ["c"]);
  assert.deepEqual(normalizeTasks([1, null, { toString: () => "obj" }]), ["1", "obj"]);
  for (const bad of [undefined, null, "a task", 42, {}, true]) {
    assert.deepEqual(normalizeTasks(bad), [], "tasks=" + String(bad));
  }
});

test("a fully successful run reads exactly like a result list", () => {
  const report = formatAgentReport([
    { index: 0, outcome: "ok", text: "first" },
    { index: 1, outcome: "ok", text: "second" },
  ]);
  assert.equal(report, "Agent 1 result:\nfirst\n\nAgent 2 result:\nsecond");
});

test("a failed agent is named up front and never looks like an empty answer", () => {
  const report = formatAgentReport([
    { index: 0, outcome: "ok", text: "fine" },
    { index: 1, outcome: "error", reason: "429 rate limit" },
  ]);
  assert.match(report, /^1 of 2 sub-agents did not finish: agent 2 failed \(429 rate limit\)\./);
  assert.match(report, /do not present them as completed work/);
  assert.match(report, /Agent 2 output \(incomplete\):\n\(no output\)/);
});

test("a stopped agent reports the work it did instead of nothing", () => {
  const report = formatAgentReport([
    { index: 0, outcome: "stopped", reason: "the user stopped it", text: "found three files" },
  ]);
  assert.match(report, /agent 1 was stopped before it finished/);
  assert.match(report, /found three files/);
});

test("a run stopped at the context budget is reported as partial, not failed", () => {
  const report = formatAgentReport([
    { index: 0, outcome: "budget", reason: "it reached the context budget", text: "half the survey" },
  ]);
  assert.match(report, /agent 1 stopped at the context budget/);
  assert.doesNotMatch(report, /failed/);
  assert.match(report, /half the survey/);
});

test("agents that never started are reported, with their reason, and add no block", () => {
  const report = formatAgentReport([
    { index: 0, outcome: "ok", text: "done" },
    { index: 1, outcome: "skipped", reason: "the simultaneous-agent limit (1) was reached" },
  ]);
  assert.match(report, /1 of 2 sub-agents did not finish: agent 2 was not started/);
  assert.doesNotMatch(report, /Agent 2 result/, "a task that never ran has nothing to show");
  assert.doesNotMatch(report, /Agent 2 output/);
});

test("every agent gets a share of the report, so none is silently dropped", () => {
  const agents = Array.from({ length: 8 }, (_, index) => ({
    index,
    outcome: /** @type {const} */ ("ok"),
    text: "x".repeat(20000),
  }));
  const report = formatAgentReport(agents);

  for (let index = 1; index <= 8; index++) {
    assert.match(report, new RegExp("Agent " + index + " result:"), "agent " + index + " survived");
  }
  const perTask = taskCharBudget(agents.length);
  assert.ok(perTask >= MIN_TASK_REPORT_CHARS, "the floor is never undercut");
  // Comfortably under the tool-result guard's limit, so nothing is cut there.
  assert.ok(report.length <= MAX_REPORT_CHARS, "the report stays within the guard (" + report.length + " chars)");
});

test("truncation is explicit, so the model knows an answer was cut", () => {
  const text = truncateTaskText("abcdef", 4);
  assert.match(text, /^abcd\n\[…truncated — this agent produced 6 chars/);
  assert.equal(truncateTaskText("abc", 4), "abc", "short text is untouched");
  assert.equal(truncateTaskText(undefined, 4), "");
});

test("an empty run list is answered rather than producing an empty result", () => {
  assert.equal(formatAgentReport([]), "No agents ran.");
  assert.equal(formatAgentReport(undefined), "No agents ran.");
});

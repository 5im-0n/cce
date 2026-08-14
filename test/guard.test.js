/**
 * Tests for the loop request-size guard (src/context/guard.js).
 * Pure module — no vscode stub needed.
 * Run with: node --test test/guard.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  computeBudget,
  splitRounds,
  pruneRounds,
  truncateToolResult,
  countToolCalls,
} = require("../src/context/guard");

/**
 * Build a single tool round: assistant(tool_calls) + one tool result.
 * `resultChars` of ~120000 chars ≈ 30K tokens (4 chars/token).
 * @param {string} name
 * @param {number} argChars
 * @param {number} resultChars
 * @returns {Array<{ role: string, content: string | null, tool_calls?: Array<object>, tool_call_id?: string }>}
 */
function roundMsg(name, argChars, resultChars) {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_" + name, type: "function", function: { name, arguments: '{"q":"' + "x".repeat(argChars) + '"}' } }],
    },
    { role: "tool", tool_call_id: "call_" + name, content: "y".repeat(resultChars) },
  ];
}

// ── computeBudget ───────────────────────────────────────────

test("computeBudget reserves 10% of the threshold, with a 4096 floor", () => {
  assert.equal(computeBudget(300000), 270000); // reserve 30000
  assert.equal(computeBudget(10000), 5904); // reserve max(1000, 4096) = 4096
  assert.equal(computeBudget(0), 0);
});

// ── splitRounds ─────────────────────────────────────────────

test("splitRounds finds no rounds when only the user message exists", () => {
  const messages = [{ role: "user", content: "hello" }];
  const { roundsStart, rounds } = splitRounds(messages);
  assert.equal(roundsStart, 1);
  assert.deepEqual(rounds, []);
});

test("splitRounds groups assistant(tool_calls) with its tool results", () => {
  const messages = [
    { role: "user", content: "do it" },
    ...roundMsg("search", 100, 100),
    ...roundMsg("read", 100, 100),
  ];
  const { roundsStart, rounds } = splitRounds(messages);
  assert.equal(roundsStart, 1);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].start, 1);
  assert.equal(rounds[0].end, 3);
  assert.equal(rounds[1].start, 3);
  assert.equal(rounds[1].end, 5);
  assert.ok(rounds[0].tokens > 0);
});

test("splitRounds keeps the system message in the prefix", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "do it" },
    ...roundMsg("search", 100, 100),
  ];
  const { roundsStart, rounds } = splitRounds(messages);
  assert.equal(roundsStart, 2);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].start, 2);
});

// ── pruneRounds ─────────────────────────────────────────────

test("pruneRounds is a no-op under budget", () => {
  const messages = [{ role: "user", content: "hello" }, ...roundMsg("a", 100, 100)];
  const result = pruneRounds(messages, 10000);
  assert.equal(result.overBudget, false);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 3);
});

test("pruneRounds drops oldest whole rounds to fit the budget", () => {
  // 3 rounds of ~30K tokens each; budget fits only the newest round.
  const messages = [
    { role: "user", content: "hello" },
    ...roundMsg("search", 1000, 120000),
    ...roundMsg("read", 1000, 120000),
    ...roundMsg("run", 1000, 120000),
  ];
  const result = pruneRounds(messages, 40000);
  assert.equal(result.overBudget, false);
  assert.equal(result.droppedRounds, 2);
  assert.ok(result.freedTokens >= 20000);
  assert.ok(result.estimate <= 40000);
  // The newest round survives intact, and its tool result still matches.
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].tool_calls[0].function.name, "run");
  assert.equal(messages[2].role, "tool");
  assert.equal(messages[2].tool_call_id, "call_run");
});

test("pruneRounds does not prune when the freed tokens are marginal (< 20K)", () => {
  // Rounds are ~5K tokens each; dropping them frees < 20K so no prune happens.
  const messages = [
    { role: "user", content: "hello" },
    ...roundMsg("a", 100, 20000),
    ...roundMsg("b", 100, 20000),
  ];
  const result = pruneRounds(messages, 6000);
  assert.equal(result.overBudget, true);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 5); // untouched
});

test("pruneRounds cannot prune a single oversized round", () => {
  const messages = [{ role: "user", content: "hello" }, ...roundMsg("big", 1000, 200000)];
  const result = pruneRounds(messages, 10000);
  assert.equal(result.overBudget, true);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 3); // untouched
});

test("pruneRounds reports overBudget when even the newest round alone exceeds the budget", () => {
  const messages = [
    { role: "user", content: "hello" },
    ...roundMsg("a", 1000, 120000),
    ...roundMsg("b", 1000, 120000),
  ];
  const result = pruneRounds(messages, 20000);
  assert.equal(result.overBudget, true);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 5); // untouched
});

test("pruneRounds respects the cushion: keeps ~40K of recent rounds", () => {
  // 6 rounds of ~10K tokens each; the cushion caps the kept tail at ~40K,
  // so 3 rounds survive (~30K) and 3 older ones are dropped.
  const messages = [{ role: "user", content: "hello" }];
  for (let i = 0; i < 6; i++) messages.push(...roundMsg("t" + i, 100, 40000));
  const result = pruneRounds(messages, 50000);
  assert.equal(result.overBudget, false);
  assert.equal(result.droppedRounds, 3);
  assert.ok(result.estimate <= 50000);
  assert.equal(messages.length, 1 + 3 * 2); // user + 3 rounds
  assert.equal(messages[1].tool_calls[0].function.name, "t3");
});

// ── truncateToolResult ──────────────────────────────────────

test("truncateToolResult keeps short results intact", () => {
  assert.equal(truncateToolResult("hello"), "hello");
  assert.equal(truncateToolResult(""), "");
  assert.equal(truncateToolResult(null), "");
  assert.equal(truncateToolResult(42), "42");
});

test("truncateToolResult caps long results at the head with a marker", () => {
  const long = "x".repeat(30000);
  const out = truncateToolResult(long);
  assert.ok(out.length < long.length);
  assert.ok(out.startsWith("x".repeat(25000)));
  assert.match(out, /\[…truncated — result was 30000 chars/);
});

// ── countToolCalls ──────────────────────────────────────────

test("countToolCalls tallies by tool name", () => {
  const messages = [
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "search_code", arguments: "{}" } }] },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "b", type: "function", function: { name: "search_code", arguments: "{}" } },
        { id: "c", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
  ];
  assert.deepEqual(countToolCalls(messages), { search_code: 2, read_file: 1 });
});

test("countToolCalls returns an empty tally for no tool calls", () => {
  assert.deepEqual(countToolCalls([{ role: "user", content: "hi" }]), {});
});

/**
 * Tests for persisted tool rounds (src/context/history.js).
 *
 * Tool rounds are now part of the session transcript, so they must survive a
 * new user message AND stay valid for both providers: every `tool_calls` id
 * needs exactly one `tool` answer, and no `tool` message may appear without
 * its call. These tests pin that contract, plus retention by token budget.
 *
 * Pure module — no vscode stub needed.
 * Run with: node --test test/history.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeRounds,
  alignBoundary,
  closeDanglingRounds,
  shiftBoundary,
  toDisplayTranscript,
  trimRounds,
  collectRounds,
  isRoundStart,
  SKIPPED_TOOL_RESULT,
} = require("../src/context/history");

/**
 * A tool round: assistant(tool_calls) + one tool result per call.
 * @param {string} name
 * @param {number} [resultChars]
 * @returns {Array<Record<string, any>>}
 */
function round(name, resultChars = 10) {
  return [
    { role: "assistant", content: null, tool_calls: [{ id: "call_" + name, type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_" + name, content: "r".repeat(resultChars) },
  ];
}

// ── collectRounds / isRoundStart ─────────────────────────────

test("collectRounds finds rounds in older turns too", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "working" },
    ...round("a"),
    { role: "user", content: "second" },
    ...round("b"),
  ];
  const rounds = collectRounds(messages);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].start, 2);
  assert.equal(rounds[1].start, 5);
  assert.equal(isRoundStart(messages[2]), true);
  assert.equal(isRoundStart(messages[1]), false);
});

// ── normalizeRounds ────────────────────────────────────────

test("normalizeRounds keeps a well-formed round untouched", () => {
  const messages = [{ role: "user", content: "go" }, ...round("read_file")];
  const out = normalizeRounds(messages);
  assert.deepEqual(out, messages);
});

test("normalizeRounds drops a tool result whose call is missing", () => {
  // Exactly what a transcript looks like when an edit truncated the turn.
  const out = normalizeRounds([
    { role: "user", content: "go" },
    { role: "tool", tool_call_id: "call_gone", content: "orphan" },
    { role: "assistant", content: "done" },
  ]);
  assert.deepEqual(out, [
    { role: "user", content: "go" },
    { role: "assistant", content: "done" },
  ]);
});

test("normalizeRounds answers every call a stopped batch left unanswered", () => {
  // A batch of two calls stopped after the first result.
  const messages = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "first" },
  ];
  const out = normalizeRounds(messages);
  assert.equal(out.length, 4);
  assert.equal(out[2].tool_call_id, "c1");
  assert.equal(out[3].tool_call_id, "c2");
  assert.equal(out[3].content, SKIPPED_TOOL_RESULT);
});

test("normalizeRounds does not duplicate or misroute results", () => {
  const messages = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "one" },
    { role: "tool", tool_call_id: "c1", content: "duplicate" },
    { role: "tool", tool_call_id: "c2", content: "two" },
    { role: "tool", tool_call_id: "unknown", content: "stray" },
  ];
  const out = normalizeRounds(messages);
  assert.deepEqual(out.filter((m) => m.role === "tool").map((m) => m.content), ["one", "two"]);
});

test("normalizeRounds drops empty assistant messages but keeps text carriers", () => {
  const out = normalizeRounds([
    { role: "user", content: "go" },
    { role: "assistant", content: "" },
    { role: "assistant", content: null },
    { role: "assistant", content: "real answer" },
    { role: "system", content: "note" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "system"]);
  assert.equal(out[1].content, "real answer");
});

test("normalizeRounds treats a content-part array as text", () => {
  const out = normalizeRounds([
    { role: "assistant", content: [{ type: "text", text: "  " }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ]);
  assert.equal(out.length, 1);
  assert.ok(Array.isArray(out[0].content));
});

// ── alignBoundary ──────────────────────────────────────────

test("alignBoundary never starts the view inside a round", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "answer" },
    ...round("a"), // 2 = carrier, 3 = result
    { role: "user", content: "second" },
  ];
  // A summary boundary at the tool result would send an unpaired result.
  assert.equal(alignBoundary(messages, 3), 2);
  // A boundary at the answer is already clean.
  assert.equal(alignBoundary(messages, 2), 2);
  // A boundary at the next user message is clean too.
  assert.equal(alignBoundary(messages, 4), 4);
});

test("alignBoundary handles degenerate inputs", () => {
  assert.equal(alignBoundary([], 3), 0);
  assert.equal(alignBoundary([{ role: "user", content: "a" }], 0), 0);
  assert.equal(alignBoundary([{ role: "user", content: "a" }], 5), 1);
  assert.equal(alignBoundary([{ role: "user", content: "a" }], -2), 0);
});

// ── storage fidelity ───────────────────────────────────────

test("trimRounds keeps an oversized result whole while the transcript fits", () => {
  // The transcript stores exactly what the request carried: no per-result cap.
  // Only the budget (here 250 000 tokens) decides what survives.
  const messages = [{ role: "user", content: "go" }, ...round("read_file", 150000)];
  const result = trimRounds(messages, 250000);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages[2].content.length, 150000, "no 4 000-char copy is made any more");
  assert.doesNotMatch(messages[2].content, /truncated/);
});

// ── closeDanglingRounds ────────────────────────────────────

test("closeDanglingRounds records the calls an interrupted batch never reached", () => {
  const conversation = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c1", type: "function", function: { name: "a", arguments: "{}" } },
        { id: "c2", type: "function", function: { name: "b", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "Aborted by user" },
    { role: "assistant", content: "stopped" },
  ];
  assert.equal(closeDanglingRounds(conversation), 1);
  assert.equal(conversation.length, 5);
  assert.equal(conversation[3].tool_call_id, "c2");
  assert.equal(conversation[3].content, SKIPPED_TOOL_RESULT);
  // Already-complete rounds are left alone.
  assert.equal(closeDanglingRounds(conversation), 0);
});

// ── shiftBoundary ──────────────────────────────────────────

test("shiftBoundary keeps pointing at the same message and counts the marker", () => {
  // A round at old indexes 2,3 was replaced by a marker at old index 2, new 2.
  const removed = [2, 3];
  assert.equal(shiftBoundary(4, removed, 2, 2), 3, "an index after the removal moves left, then right by the marker");
  assert.equal(shiftBoundary(2, removed, 2, 2), 2, "a removed round start lands on the marker");
  assert.equal(shiftBoundary(0, removed, 2, 2), 0);
  assert.equal(shiftBoundary(1, removed, 2, 2), 1, "messages before the removal keep their index");
  assert.equal(shiftBoundary(3, removed, 2, 2), 2, "the round's tool result collapses onto the marker");
});

test("shiftBoundary accounts for an old marker that was merged away", () => {
  // Old marker at 1 was folded into the new one at old 4 / new 3.
  const removed = [4, 5, 1];
  assert.equal(shiftBoundary(2, removed, 4, 3), 1, "after the folded marker and before the new one");
  assert.equal(shiftBoundary(1, removed, 4, 3), 3, "the old marker itself lands on the merged marker");
  assert.equal(shiftBoundary(6, removed, 4, 3), 4);
});

// ── toDisplayTranscript ────────────────────────────────────

test("toDisplayTranscript keeps user/assistant text and notice markers only", () => {
  const history = toDisplayTranscript([
    { role: "user", content: "hello", id: "m1", images: [] },
    ...round("read_file"),
    { role: "assistant", content: null, tool_calls: [{ id: "x", function: { name: "n", arguments: "{}" } }] },
    { role: "assistant", content: "answer" },
    { role: "system", content: "plain", notice: true },
  ]);
  assert.deepEqual(history, [
    { role: "user", content: "hello", id: "m1", images: [] },
    { role: "assistant", content: "answer" },
    { role: "system", notice: true, content: "plain" },
  ]);
});

// ── trimRounds ─────────────────────────────────────────────

test("trimRounds is a no-op under the budget", () => {
  const messages = [{ role: "user", content: "go" }, ...round("a", 40)];
  const result = trimRounds(messages, 100000);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 3);
});

test("trimRounds drops the oldest rounds by token budget, keeping the newest", () => {
  const messages = [{ role: "user", content: "go" }];
  // ~10000 tokens per round (40000 chars / 4).
  for (let i = 0; i < 4; i++) messages.push(...round("t" + i, 40000));
  const result = trimRounds(messages, 25000);
  assert.ok(result.droppedRounds >= 2, "at least two rounds had to go to fit 25K tokens");
  assert.ok(result.freedTokens > 0);
  const names = messages
    .filter((m) => m.role === "assistant" && m.tool_calls)
    .map((m) => m.tool_calls[0].function.name);
  assert.ok(names.includes("t3"), "the newest round always survives");
  assert.ok(!names.includes("t0"), "the oldest round was removed");
  const marker = messages.find((m) => m.notice === true);
  assert.ok(marker, "a marker records the removal");
  assert.match(marker.content, /removed from the transcript/);
});

test("trimRounds never drops the newest round, even when it alone is oversized", () => {
  const messages = [{ role: "user", content: "go" }, ...round("huge", 400000)];
  const result = trimRounds(messages, 1000);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 3);
});

test("trimRounds gives up when the plain conversation already exceeds the budget", () => {
  // Dropping rounds cannot fix a transcript that is too big without them.
  const messages = [
    { role: "user", content: "u".repeat(400000) },
    ...round("a", 40000),
    ...round("b", 40000),
  ];
  const result = trimRounds(messages, 1000);
  assert.equal(result.droppedRounds, 0);
  assert.equal(messages.length, 5);
});

test("trimRounds ignores a zero/absent budget", () => {
  const messages = [{ role: "user", content: "go" }, ...round("a", 4000), ...round("b", 4000)];
  assert.equal(trimRounds(messages, 0).droppedRounds, 0);
  assert.equal(trimRounds(messages, undefined).droppedRounds, 0);
  assert.equal(messages.length, 5);
});

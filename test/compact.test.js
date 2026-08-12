/**
 * Tests for rolling-summary compaction (src/context/compact.js).
 * Pure module — no vscode stub needed.
 * Run with: node --test test/compact.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { splitAtKeepTurn, buildSummaryRequest, planCompaction, SUMMARY_SYSTEM_PROMPT } = require("../src/context/compact");

/**
 * Build a small alternating user/assistant conversation.
 * @param {number} turns
 * @returns {Array<{ role: string, content: string }>}
 */
function conversation(turns) {
  const msgs = [];
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: "user", content: "user " + i });
    msgs.push({ role: "assistant", content: "assistant " + i });
  }
  return msgs;
}

// ── splitAtKeepTurn ─────────────────────────────────────────

test("splitAtKeepTurn keeps everything when turns <= keepTurns", () => {
  const msgs = conversation(3);
  const { old, keep } = splitAtKeepTurn(msgs, 5);
  assert.deepEqual(old, []);
  assert.deepEqual(keep, msgs);
});

test("splitAtKeepTurn folds everything before the last N user messages", () => {
  const msgs = conversation(5); // 5 user messages
  const { old, keep } = splitAtKeepTurn(msgs, 2);
  // last 2 user messages start at index 6 (user 3)
  assert.equal(old.length, 6);
  assert.equal(old[0].content, "user 0");
  assert.equal(keep.length, 4);
  assert.equal(keep[0].content, "user 3");
  assert.equal(keep[keep.length - 1].content, "assistant 4");
});

test("splitAtKeepTurn handles a dangling user message as one turn", () => {
  const msgs = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" }, // no reply yet
  ];
  const { old, keep } = splitAtKeepTurn(msgs, 1);
  assert.equal(old.length, 2);
  assert.equal(keep.length, 1);
  assert.equal(keep[0].content, "c");
});

// ── buildSummaryRequest ─────────────────────────────────────

test("buildSummaryRequest uses a single user message (provider-safe roles)", () => {
  const req = buildSummaryRequest(null, conversation(1));
  assert.equal(req.length, 2);
  assert.equal(req[0].role, "system");
  assert.equal(req[0].content, SUMMARY_SYSTEM_PROMPT);
  assert.equal(req[1].role, "user");
  assert.match(req[1].content, /user 0/);
  assert.match(req[1].content, /assistant 0/);
  assert.match(req[1].content, /Produce the updated summary now\./);
});

test("buildSummaryRequest includes the existing summary first", () => {
  const req = buildSummaryRequest("PREVIOUS SUMMARY", conversation(1));
  assert.match(req[1].content, /Existing summary:\nPREVIOUS SUMMARY/);
  assert.ok(req[1].content.indexOf("PREVIOUS SUMMARY") < req[1].content.indexOf("user 0"));
});

test("buildSummaryRequest flags images as omitted instead of embedding them", () => {
  const turn = { role: "user", content: "look at this", images: [{ id: "i1", name: "x.png", dataUrl: "data:image/png;base64,AAAA", size: 10 }] };
  const req = buildSummaryRequest(null, [turn]);
  assert.match(req[1].content, /\[image attachment omitted/);
  assert.ok(!req[1].content.includes("base64"));
});

// ── planCompaction ──────────────────────────────────────────

test("planCompaction does nothing below the threshold", () => {
  const plan = planCompaction({ systemPrompt: "sys", messages: conversation(2), threshold: 100000, keepTurns: 2, summary: null });
  assert.equal(plan.shouldCompact, false);
  assert.ok(plan.estimate < 100000);
  assert.equal(plan.compactRequest, null);
});

test("planCompaction triggers above the threshold and splits correctly", () => {
  // ~300-char user messages and a modest threshold force the trigger while
  // keeping the summarization request itself under the threshold.
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: "user", content: "u".repeat(300) });
    msgs.push({ role: "assistant", content: "a".repeat(300) });
  }
  // full estimate ~751 tokens; summary request (old turns only) ~535 tokens
  const plan = planCompaction({ systemPrompt: "sys", messages: msgs, threshold: 700, keepTurns: 2, summary: null });
  assert.equal(plan.shouldCompact, true);
  // 5 users - 2 kept = 3 user turns folded (6 messages)
  assert.equal(plan.old.length, 6);
  assert.equal(plan.keep.length, 4);
  assert.ok(plan.compactRequest, "compactRequest should be built");
  // The summarization request must be small: only the old turns.
  const reqSize = plan.compactRequest[0].content.length + plan.compactRequest[1].content.length;
  assert.ok(reqSize < msgs.length * 300);
});

test("planCompaction skips when recent turns alone exceed the threshold", () => {
  const msgs = [
    { role: "user", content: "x".repeat(100000) },
    { role: "assistant", content: "y".repeat(100000) },
  ];
  const plan = planCompaction({ systemPrompt: "sys", messages: msgs, threshold: 1000, keepTurns: 2, summary: null });
  assert.equal(plan.shouldCompact, false);
  assert.match(plan.skipReason, /recent turns alone/);
});

test("planCompaction skips when the summary request itself would overflow", () => {
  const msgs = [
    { role: "user", content: "huge".repeat(60000) }, // ~240K chars -> 60K tokens
    { role: "assistant", content: "ok" },
    { role: "user", content: "current question" },
  ];
  // threshold 60000: full estimate (~60006) exceeds it, but keepTurns=1 means
  // the huge turn is in `old`, making the summary request itself too big.
  const plan = planCompaction({ systemPrompt: "sys", messages: msgs, threshold: 60000, keepTurns: 1, summary: null });
  assert.equal(plan.shouldCompact, false);
  assert.match(plan.skipReason, /summarization request itself/);
});

test("planCompaction folds previous summary tokens into the estimate", () => {
  const msgs = conversation(2); // small
  const plan = planCompaction({ systemPrompt: "sys", messages: msgs, threshold: 100000, keepTurns: 1, summary: "s".repeat(400000) });
  // The huge summary alone blows the threshold; nothing can be folded (old is empty).
  assert.equal(plan.shouldCompact, false);
  assert.ok(plan.estimate > 100000);
});

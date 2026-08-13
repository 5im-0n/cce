/**
 * Tests for message editing (src/conversation/edit.js).
 * Pure module — no vscode stub needed.
 * Run with: node --test test/edit.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { applyEdit, lastUserMessageIndex, editableMessageId } = require("../src/conversation/edit");

/**
 * A small alternating user/assistant conversation with ids on user messages.
 * @returns {Array<{ role: string, content: string, id?: string }>}
 */
function convo() {
  return [
    { role: "user", content: "a", id: "u1" },
    { role: "assistant", content: "A" },
    { role: "user", content: "b", id: "u2" },
    { role: "assistant", content: "B" },
  ];
}

// ── lastUserMessageIndex ────────────────────────────────────

test("lastUserMessageIndex finds the most recent user message", () => {
  assert.equal(lastUserMessageIndex(convo()), 2);
});

test("lastUserMessageIndex returns -1 for an empty or assistant-only conversation", () => {
  assert.equal(lastUserMessageIndex([]), -1);
  assert.equal(lastUserMessageIndex([{ role: "assistant", content: "x" }]), -1);
});

// ── editableMessageId ───────────────────────────────────────

test("editableMessageId returns the id of the most recent user message", () => {
  assert.equal(editableMessageId(convo()), "u2");
  assert.equal(editableMessageId([]), null);
});

// ── applyEdit ───────────────────────────────────────────────

test("applyEdit replaces the most recent user message and drops what followed", () => {
  const result = applyEdit(convo(), "u2", "b edited");
  assert.equal(result.ok, true);
  const edited = result.conversation;
  assert.equal(edited.length, 3);
  assert.equal(edited[0].content, "a");
  assert.equal(edited[1].content, "A");
  assert.deepEqual(edited[2], { role: "user", content: "b edited", images: [], id: "u2" });
});

test("applyEdit does not mutate the input", () => {
  const input = convo();
  applyEdit(input, "u2", "x");
  assert.equal(input.length, 4);
  assert.equal(input[3].content, "B");
});

test("applyEdit rejects a non-most-recent user message id", () => {
  const result = applyEdit(convo(), "u1", "x");
  assert.equal(result.ok, false);
  assert.match(result.reason, /most recent/);
});

test("applyEdit rejects an unknown id", () => {
  const result = applyEdit(convo(), "nope", "x");
  assert.equal(result.ok, false);
});

test("applyEdit rejects an empty conversation", () => {
  const result = applyEdit([], "u1", "x");
  assert.equal(result.ok, false);
  assert.match(result.reason, /No user message/);
});

test("applyEdit carries images through and keeps the id", () => {
  const images = [{ id: "i1", name: "p.png", dataUrl: "data:image/png;base64,AAAA", size: 10 }];
  const result = applyEdit(convo(), "u2", "look", images);
  assert.equal(result.ok, true);
  assert.equal(result.conversation.length, 3);
  assert.deepEqual(result.conversation[2].images, images);
  assert.equal(result.conversation[2].id, "u2");
});

test("applyEdit handles a dangling user message with no reply", () => {
  const msgs = [
    { role: "user", content: "a", id: "u1" },
    { role: "assistant", content: "A" },
    { role: "user", content: "b", id: "u2" },
  ];
  const result = applyEdit(msgs, "u2", "b edited");
  assert.equal(result.ok, true);
  assert.equal(result.conversation.length, 3);
  assert.equal(result.conversation[2].content, "b edited");
  assert.equal(result.conversation[2].id, "u2");
});

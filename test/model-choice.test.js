const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveModelId, resolveEffort, REASONING_EFFORTS } = require("../src/chat/model-choice");

const MODELS = [
  { id: "m1", name: "First" },
  { id: "m2", name: "Second" },
];

test("a chat keeps its own model when it still exists", () => {
  assert.equal(resolveModelId(MODELS, "m2", "m1"), "m2");
});

test("the global default is used when the chat has no model yet", () => {
  assert.equal(resolveModelId(MODELS, undefined, "m2"), "m2");
  assert.equal(resolveModelId(MODELS, "", "m2"), "m2");
});

test("a deleted model falls back to the first configured model", () => {
  assert.equal(resolveModelId(MODELS, "deleted", "also-deleted"), "m1");
});

test("no models resolves to an empty id", () => {
  assert.equal(resolveModelId([], "m1", "m1"), "");
  assert.equal(resolveModelId(undefined, "m1", "m1"), "");
});

test("effort: session value wins, then the default, then medium", () => {
  assert.equal(resolveEffort("high", "low"), "high");
  assert.equal(resolveEffort(undefined, "low"), "low");
  assert.equal(resolveEffort(undefined, undefined), "medium");
});

test("effort: unknown values fall through", () => {
  assert.equal(resolveEffort("turbo", "low"), "low");
  assert.equal(resolveEffort("turbo", "also-bad"), "medium");
});

test("every accepted effort round-trips", () => {
  for (const effort of REASONING_EFFORTS) {
    assert.equal(resolveEffort(effort, "medium"), effort);
  }
});

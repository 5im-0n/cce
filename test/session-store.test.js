const test = require("node:test");
const assert = require("node:assert/strict");
const {
  mutateSessions,
  upsertSession,
  newSessionId,
  titleFromConversation,
  withoutEmptySessions,
  _resetQueue,
  whenIdle,
} = require("../src/config/sessionStore");

const KEY = "cce.sessions";

/**
 * In-memory memento with an async update, mimicking VSCode's memento contract
 * (get is synchronous, update returns a thenable).
 * @param {Array<any>} initial
 */
function memoryMemento(initial = []) {
  /** @type {any} */
  const store = { [KEY]: initial };
  return {
    get: (key, defaultValue) => (key in store ? store[key] : defaultValue),
    update: async (key, value) => {
      // Yield so interleaved writers really interleave.
      await new Promise((resolve) => setImmediate(resolve));
      store[key] = value;
    },
    peek: () => store[KEY],
  };
}

test("two interleaved mutations both persist", async () => {
  _resetQueue();
  const memento = memoryMemento([{ id: "a", messages: [{ role: "user", content: "a" }] }]);

  const first = mutateSessions(memento, KEY, (sessions) => {
    upsertSession(sessions, "b", { messages: [{ role: "user", content: "b" }] });
  });
  const second = mutateSessions(memento, KEY, (sessions) => {
    upsertSession(sessions, "c", { messages: [{ role: "user", content: "c" }] });
  });
  await Promise.all([first, second]);

  const ids = memento.peek().map((s) => s.id).sort();
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("a mutation that throws does not deadlock later writes", async () => {
  _resetQueue();
  const memento = memoryMemento([]);

  await assert.rejects(mutateSessions(memento, KEY, () => {
    throw new Error("boom");
  }));

  await mutateSessions(memento, KEY, (sessions) => {
    upsertSession(sessions, "after", { messages: [] });
  });
  assert.equal(memento.peek().length, 1);
  assert.equal(memento.peek()[0].id, "after");
});

test("deleting a session during a save does not resurrect it", async () => {
  _resetQueue();
  const memento = memoryMemento([
    { id: "keep", messages: [{ role: "user", content: "keep" }] },
    { id: "gone", messages: [{ role: "user", content: "gone" }] },
  ]);

  const save = mutateSessions(memento, KEY, (sessions) => {
    const kept = sessions.filter((s) => s.id !== "gone");
    sessions.length = 0;
    sessions.push(...kept);
    upsertSession(sessions, "keep", { messages: [{ role: "user", content: "keep2" }] });
  });
  const late = mutateSessions(memento, KEY, (sessions) => {
    // A stale writer that still knows about "gone" must not bring it back:
    // the delete already happened in queue order.
    upsertSession(sessions, "keep", { messages: [{ role: "user", content: "keep3" }] });
  });
  await Promise.all([save, late]);

  const ids = memento.peek().map((s) => s.id);
  assert.deepEqual(ids, ["keep"]);
  assert.equal(memento.peek()[0].messages[0].content, "keep3");
});

test("upsertSession updates in place and appends when missing", () => {
  const sessions = [{ id: "a", title: "A" }];
  const updated = upsertSession(sessions, "a", { title: "A2" });
  assert.equal(updated.title, "A2");
  assert.equal(sessions.length, 1);

  const added = upsertSession(sessions, "b", { title: "B" });
  assert.equal(added.id, "b");
  assert.equal(sessions.length, 2);
});

test("newSessionId returns look-alike UUID v4 values that are unique", () => {
  const first = newSessionId();
  const second = newSessionId();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test("titleFromConversation uses the first user message, collapsed and clipped", () => {
  assert.equal(titleFromConversation([{ role: "assistant", content: "hi" }]), "Chat");
  assert.equal(titleFromConversation([]), "Chat");
  assert.equal(
    titleFromConversation([{ role: "user", content: "line one\nline two" }]),
    "line one line two"
  );
  const long = titleFromConversation([{ role: "user", content: "x".repeat(80) }]);
  assert.equal(long.length, 50);
  assert.equal(titleFromConversation([{ role: "user", content: 42 }]), "Chat");
});

test("withoutEmptySessions drops placeholders without messages", () => {
  const sessions = [
    { id: "a", messages: [{ role: "user" }] },
    { id: "b", messages: [] },
    { id: "c" },
    null,
  ];
  assert.deepEqual(withoutEmptySessions(sessions).map((s) => s.id), ["a"]);
  assert.deepEqual(withoutEmptySessions(undefined), []);
});

test("whenIdle resolves after queued writes settle", async () => {
  _resetQueue();
  const memento = memoryMemento([]);
  mutateSessions(memento, KEY, (sessions) => {
    upsertSession(sessions, "x", { messages: [] });
  });
  await whenIdle();
  assert.equal(memento.peek().length, 1);
});

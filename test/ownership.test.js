const test = require("node:test");
const assert = require("node:assert/strict");
const { createOwnership } = require("../src/chat/ownership");

/**
 * Session ownership between chats: one chat per session, enforced. These tests
 * pin the rules the manager and the controller rely on when several chats are
 * open at the same time.
 */

test("an unowned session can be taken by any chat", () => {
  const ownership = createOwnership();
  assert.equal(ownership.canTake("s1", "sidebar"), true);
  assert.equal(ownership.canTake("s1", "tab-1"), true);
});

test("an empty session id is always allowed", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  // "" means "the fresh, unsaved chat" — never an owned object.
  assert.equal(ownership.canTake("", "sidebar"), true);
  assert.equal(ownership.canTake("", "tab-1"), true);
});

test("a taken session is refused to other chats and allowed to its owner", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  assert.equal(ownership.canTake("s1", "tab-1"), true);
  assert.equal(ownership.canTake("s1", "tab-2"), false);
  assert.equal(ownership.ownerOf("s1"), "tab-1");
});

test("a release frees the session for everybody", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  ownership.release("s1", "tab-1");
  assert.equal(ownership.ownerOf("s1"), null);
  assert.equal(ownership.canTake("s1", "tab-2"), true);
});

test("a stale release cannot steal ownership taken in the meantime", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  ownership.release("s1", "tab-1");
  ownership.take("s1", "tab-2");
  // tab-1 keeps unwinding and releases again; tab-2 must keep the session.
  ownership.release("s1", "tab-1");
  assert.equal(ownership.ownerOf("s1"), "tab-2");
});

test("releaseAll only frees the closing chat's sessions", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  ownership.take("s2", "tab-1");
  ownership.take("s3", "tab-2");
  ownership.releaseAll("tab-1");
  assert.equal(ownership.ownerOf("s1"), null);
  assert.equal(ownership.ownerOf("s2"), null);
  assert.equal(ownership.ownerOf("s3"), "tab-2");
});

test("clear drops every owner (extension shutdown)", () => {
  const ownership = createOwnership();
  ownership.take("s1", "tab-1");
  ownership.take("s2", "sidebar");
  ownership.clear();
  assert.equal(ownership.ownerOf("s1"), null);
  assert.equal(ownership.ownerOf("s2"), null);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { PANEL_VIEW_TYPE, decodePanelState } = require("../src/chat/panel-state");

/**
 * Panel state survives a window reload through the webview: the session id the
 * tab was showing is persisted with `setState` and handed back to the
 * serializer. It arrives from the webview, so decoding must be total — a bad
 * state restores a usable tab, never a crash.
 */

test("the view type matches the one used for chat panels", () => {
  assert.equal(PANEL_VIEW_TYPE, "cceChat");
});

test("a saved session id is preserved", () => {
  assert.deepEqual(decodePanelState({ sessionId: "abc-123" }), { sessionId: "abc-123" });
});

test("surrounding whitespace is trimmed and blank ids mean 'fresh chat'", () => {
  assert.deepEqual(decodePanelState({ sessionId: "  abc-123  " }), { sessionId: "abc-123" });
  assert.deepEqual(decodePanelState({ sessionId: "   " }), { sessionId: null });
  assert.deepEqual(decodePanelState({ sessionId: "" }), { sessionId: null });
});

test("missing, null and malformed state yields a fresh chat", () => {
  for (const state of [undefined, null, {}, { sessionId: 42 }, { sessionId: null }, [], "abc-123", 7, true]) {
    assert.deepEqual(
      decodePanelState(state),
      { sessionId: null },
      "state " + JSON.stringify(state) + " must not reach the session store"
    );
  }
});

test("unknown extra fields are ignored", () => {
  assert.deepEqual(
    decodePanelState({ sessionId: "abc-123", scrollTop: 900, v: 99 }),
    { sessionId: "abc-123" }
  );
});

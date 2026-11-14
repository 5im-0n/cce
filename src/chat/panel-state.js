/**
 * Editor-tab state that survives a window reload.
 *
 * A chat panel is only restored by VS Code when it has a serializer for its
 * view type *and* the webview called `setState`. The webview stores the
 * session id it is showing; on reload the host gets that value back through
 * `deserializeWebviewPanel` and reopens the session.
 *
 * The value arrives from the webview, so it is untrusted: a stale or corrupt
 * state must never throw. Decoding is therefore a pure, total function — this
 * module has no `vscode` import so the rules are unit-testable.
 */

/** View type of editor-tab chats. Must match `createWebviewPanel`. */
const PANEL_VIEW_TYPE = "cceChat";

/**
 * @typedef {Object} PanelState
 * @property {string | null} sessionId - Session the tab was showing, or null.
 */

/**
 * Normalise the state a restored webview handed back.
 *
 * Anything that is not a non-empty string session id yields `null`, which the
 * manager treats as "reopen this tab as a fresh chat" — the tab the user left
 * open comes back even if its conversation is gone.
 *
 * @param {any} raw - Whatever the webview persisted (may be undefined, a
 *   string, an object from an older version, …).
 * @returns {PanelState}
 */
function decodePanelState(raw) {
  if (!raw || typeof raw !== "object") return { sessionId: null };
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId.trim() : "";
  return { sessionId: sessionId || null };
}

module.exports = { PANEL_VIEW_TYPE, decodePanelState };

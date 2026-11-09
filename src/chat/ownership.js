/**
 * Session ownership between chats.
 *
 * Several CCE chats can be open at once (the sidebar chat plus any number of
 * editor tabs). A session may be shown by exactly one chat at a time: two
 * chats editing the same transcript independently would diverge silently and
 * the last save would win. Ownership is therefore enforced, not advised —
 * opening a session another chat already holds reveals that chat instead of
 * forking the conversation.
 *
 * Pure module (no `vscode`), so the rule is unit-testable.
 */

/**
 * @typedef {Object} Ownership
 * @property {(sessionId: string, chatId: string) => boolean} canTake - False when another chat owns it.
 * @property {(sessionId: string, chatId: string) => void} take
 * @property {(sessionId: string, chatId: string) => void} release - No-op unless this chat still owns it.
 * @property {(chatId: string) => void} releaseAll - Drop every session held by a chat.
 * @property {(sessionId: string) => (string | null)} ownerOf
 * @property {() => void} clear
 */

/**
 * Create an empty ownership registry.
 * @returns {Ownership}
 */
function createOwnership() {
  /** @type {Map<string, string>} sessionId → chatId */
  const owners = new Map();

  return {
    /**
     * Whether `chatId` may show this session. An unowned session is free, and
     * a chat may always keep the session it already holds.
     *
     * @param {string} sessionId
     * @param {string} chatId
     * @returns {boolean}
     */
    canTake(sessionId, chatId) {
      if (!sessionId) return true;
      const owner = owners.get(sessionId);
      return !owner || owner === chatId;
    },

    /**
     * Register that `chatId` now shows this session.
     * @param {string} sessionId
     * @param {string} chatId
     */
    take(sessionId, chatId) {
      if (!sessionId) return;
      owners.set(sessionId, chatId);
    },

    /**
     * Give up a session, but only if this chat still holds it — a late release
     * must not steal ownership from whoever took the session next.
     *
     * @param {string} sessionId
     * @param {string} chatId
     */
    release(sessionId, chatId) {
      if (!sessionId) return;
      if (owners.get(sessionId) === chatId) owners.delete(sessionId);
    },

    /**
     * Drop every session a chat holds. Called when its tab closes, so the
     * sessions can be reopened elsewhere immediately.
     *
     * @param {string} chatId
     */
    releaseAll(chatId) {
      for (const [sessionId, owner] of Array.from(owners)) {
        if (owner === chatId) owners.delete(sessionId);
      }
    },

    /**
     * @param {string} sessionId
     * @returns {string | null} The owning chat id, or null when unowned.
     */
    ownerOf(sessionId) {
      return owners.get(sessionId) || null;
    },

    clear() {
      owners.clear();
    },
  };
}

module.exports = { createOwnership };

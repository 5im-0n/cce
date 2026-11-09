/**
 * Session persistence with serialized read-modify-write.
 *
 * Sessions live in a memento (workspaceState or globalState) as one array.
 * Several chats can save at the same time — each save reads the array,
 * mutates its own entry and writes the whole array back. Without
 * serialization the second writer would resurrect a stale copy of every
 * other session (and could drop the first writer's save entirely).
 *
 * `mutateSessions` chains every mutation onto a single promise queue, so
 * mutations are applied one at a time in call order. The memento is injected
 * so this module stays testable without `vscode`.
 */

/** @type {Promise<void>} */
let _queue = Promise.resolve();

/**
 * @typedef {Object} SessionMemento
 * @property {(key: string, defaultValue?: any) => any} get
 * @property {(key: string, value: any) => Thenable<void>} update
 */

/**
 * Run `fn` against the latest stored session array and persist its result.
 *
 * `fn` receives a copy of the stored array and returns the array to persist,
 * or nothing to persist the copy it was given (mutated in place). It must not
 * await anything else — the queue holds the sessions lock for the duration of
 * the call.
 *
 * @template T
 * @param {SessionMemento} memento
 * @param {string} key - Memento key holding the session array.
 * @param {(sessions: Array<any>) => (Array<any> | void)} fn
 * @returns {Promise<Array<any>>} The persisted array.
 */
function mutateSessions(memento, key, fn) {
  /** @type {Promise<Array<any>>} */
  const run = _queue.then(async () => {
    const current = memento.get(key, []);
    const work = Array.isArray(current) ? current.slice() : [];
    const next = fn(work) || work;
    await memento.update(key, next);
    return next;
  });
  // Keep the chain alive even when a mutation throws — a rejected queue would
  // deadlock every later save.
  _queue = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Wait for every queued session mutation to settle. Used on shutdown and by
 * tests; never rejects.
 * @returns {Promise<void>}
 */
function whenIdle() {
  return _queue;
}

/**
 * Reset the internal queue. Test-only helper.
 * @returns {void}
 */
function _resetQueue() {
  _queue = Promise.resolve();
}

/**
 * Copy a session's persisted fields into place, creating the entry when it
 * does not exist yet.
 *
 * @param {Array<any>} sessions - Array to mutate in place.
 * @param {string} sessionId
 * @param {Record<string, any>} fields - Fields written over the stored entry.
 * @returns {any} The written session entry.
 */
function upsertSession(sessions, sessionId, fields) {
  let session = sessions.find((s) => s && s.id === sessionId);
  if (session) {
    Object.assign(session, fields);
    return session;
  }
  session = { id: sessionId, ...fields };
  sessions.push(session);
  return session;
}

/**
 * Generate a random UUID v4 string, used as a session id.
 * @returns {string}
 */
function newSessionId() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Build a chat title from the first user message of a conversation. Both save
 * paths (first message and re-save) use this so titles stay stable.
 *
 * @param {Array<{ role: string, content?: unknown }>} conversation
 * @returns {string}
 */
function titleFromConversation(conversation) {
  const firstUser = (conversation || []).find((m) => m && m.role === "user");
  const text = firstUser && typeof firstUser.content === "string" ? firstUser.content : "";
  const title = text.slice(0, 50).replace(/\n/g, " ").trim();
  return title || "Chat";
}

/**
 * Drop sessions that have no messages. Keeps the list free of placeholders
 * created by "new chat" flows.
 *
 * @param {Array<any>} sessions
 * @returns {Array<any>}
 */
function withoutEmptySessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s && Array.isArray(s.messages) && s.messages.length > 0);
}

module.exports = {
  mutateSessions,
  whenIdle,
  upsertSession,
  newSessionId,
  titleFromConversation,
  withoutEmptySessions,
  _resetQueue,
};

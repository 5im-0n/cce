/**
 * Per-chat model and reasoning-effort resolution.
 *
 * Every chat (sidebar or editor tab) remembers its own model and effort on
 * the session it is attached to. These helpers decide what a chat should use
 * given the session's stored values, the global default and the models that
 * currently exist — without touching `vscode` or any storage, so the rules are
 * unit-testable.
 */

/** Reasoning efforts accepted by the providers, lowest effort first. */
const REASONING_EFFORTS = ["off", "low", "medium", "high", "max"];

/**
 * @typedef {Object} ModelIdentity
 * @property {string} id
 * @property {string} name
 */

/**
 * Pick the model a chat should use.
 *
 * Priority: the chat's own model (if it still exists) → the persisted global
 * default (if it still exists) → the first configured model → "".
 *
 * @param {Array<ModelIdentity>} models - Configured models, in display order.
 * @param {string} [sessionModelId] - Model stored on the chat's session.
 * @param {string} [defaultModelId] - Persisted global default.
 * @returns {string} A model id present in `models`, or "" when none exist.
 */
function resolveModelId(models, sessionModelId, defaultModelId) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return "";
  if (sessionModelId && list.some((m) => m.id === sessionModelId)) return sessionModelId;
  if (defaultModelId && list.some((m) => m.id === defaultModelId)) return defaultModelId;
  return list[0].id;
}

/**
 * Pick the reasoning effort a chat should use.
 *
 * @param {string} [sessionEffort] - Effort stored on the chat's session.
 * @param {string} [defaultEffort] - Persisted global default.
 * @returns {string} One of REASONING_EFFORTS; "medium" when neither is valid.
 */
function resolveEffort(sessionEffort, defaultEffort) {
  if (sessionEffort && REASONING_EFFORTS.includes(sessionEffort)) return sessionEffort;
  if (defaultEffort && REASONING_EFFORTS.includes(defaultEffort)) return defaultEffort;
  return "medium";
}

module.exports = { resolveModelId, resolveEffort, REASONING_EFFORTS };

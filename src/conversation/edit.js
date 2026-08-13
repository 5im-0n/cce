/**
 * Message editing.
 *
 * Only the most recent user message in a conversation is editable. Editing it
 * replaces that message in place (keeping its id so webview state stays
 * coherent) and discards everything that followed it — the assistant's reply
 * and any tool activity in that turn. The model then regenerates from the
 * edited message onward.
 *
 * Pure module (no vscode dependency) so it can run under `node --test`
 * without an extension host.
 */

/**
 * @typedef {import("../context/estimate").ConversationMessage} ConversationMessage
 */

/**
 * Index of the most recent user message in the conversation.
 * @param {ConversationMessage[]} messages
 * @returns {number} - index, or -1 if there is no user message
 */
function lastUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

/**
 * Apply an edit to the conversation: replace the most recent user message
 * with new text/images and drop everything after it. Returns a new array;
 * the input is never mutated. The edited message keeps its original id so
 * the webview can keep targeting it.
 *
 * @param {ConversationMessage[]} messages - current transcript (not mutated)
 * @param {string} editingId - id of the message being edited
 * @param {string} text - replacement content
 * @param {Array<{ id: string, name: string, dataUrl: string, size: number, warning: boolean }>} [images]
 * @returns {{ ok: true, conversation: ConversationMessage[] } | { ok: false, reason: string }}
 */
function applyEdit(messages, editingId, text, images) {
  const idx = lastUserMessageIndex(messages);
  if (idx < 0) {
    return { ok: false, reason: "No user message to edit." };
  }
  if (messages[idx].id !== editingId) {
    return { ok: false, reason: "Only the most recent message can be edited." };
  }
  const conversation = messages.slice(0, idx);
  conversation.push({ role: "user", content: text, images: images || [], id: editingId });
  return { ok: true, conversation };
}

/**
 * Id of the editable message — the most recent user message — if any.
 * @param {ConversationMessage[]} messages
 * @returns {string | null}
 */
function editableMessageId(messages) {
  const idx = lastUserMessageIndex(messages);
  return idx >= 0 ? messages[idx].id || null : null;
}

module.exports = { applyEdit, lastUserMessageIndex, editableMessageId };

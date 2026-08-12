/**
 * Token estimation helpers.
 *
 * These are rough heuristics — good enough to trigger compaction before the
 * API rejects the request, not exact tokenizers. Text counts as ~4 chars per
 * token; images count as a base cost plus a size-proportional cost, since
 * providers downscale images before encoding them.
 *
 * Pure module (no vscode dependency) so it can run under `node --test`
 * without an extension host.
 */

/**
 * @typedef {Object} ConversationMessage
 * @property {string} role
 * @property {string | null} [content]
 * @property {Array<{ id: string, name: string, dataUrl: string, size: number }>} [images]
 */

/**
 * Estimate the token count of a text string (chars / 4).
 * @param {string} text
 * @returns {number}
 */
function estimateTextTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the token cost of an attached image.
 * Images are downscaled by providers, so a base cost plus a linear
 * size-based cost stays in the right order of magnitude.
 * @param {{ size?: number, dataUrl?: string }} image
 * @returns {number}
 */
function estimateImageTokens(image) {
  let bytes = image.size || 0;
  if (!bytes && image.dataUrl) {
    // dataUrl is "data:<mime>;base64,<payload>" — payload chars × 3/4 = bytes
    const comma = image.dataUrl.indexOf(",");
    const payload = comma >= 0 ? image.dataUrl.length - comma - 1 : 0;
    bytes = Math.floor((payload * 3) / 4);
  }
  return Math.ceil(500 + bytes / 2048);
}

/**
 * Estimate the token count of a single conversation message.
 * @param {ConversationMessage} msg
 * @returns {number}
 */
function estimateMessageTokens(msg) {
  let tokens = estimateTextTokens(msg.content || "");
  for (const img of msg.images || []) {
    tokens += estimateImageTokens(img);
  }
  return tokens;
}

/**
 * Estimate the total request size: system prompt + optional rolling summary
 * + conversation messages.
 * @param {string} systemPrompt
 * @param {ConversationMessage[]} messages
 * @param {string} [summary]
 * @returns {number}
 */
function estimateRequestTokens(systemPrompt, messages, summary) {
  let tokens = estimateTextTokens(systemPrompt);
  if (summary) tokens += estimateTextTokens(summary);
  for (const m of messages) {
    tokens += estimateMessageTokens(m);
  }
  return tokens;
}

/**
 * Format a token count for display: 1500 -> "1.5K", 1048576 -> "1.05M".
 * @param {number} n
 * @returns {string}
 */
function formatTokenCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "K";
  return String(n);
}

module.exports = { estimateTextTokens, estimateImageTokens, estimateMessageTokens, estimateRequestTokens, formatTokenCount };

/**
 * Rolling-summary auto-compaction.
 *
 * When a conversation grows past the configured threshold, older turns are
 * folded into a summary so the request stays within the model's context
 * window. The design is *incremental*: the summarization request only ever
 * contains the previous summary plus the turns added since — never the full
 * history — so it is always small and can never fail with a context overflow
 * itself.
 *
 * Pure module (no vscode dependency) so it can run under `node --test`
 * without an extension host.
 */

const { estimateTextTokens, estimateRequestTokens } = require("./estimate");

/**
 * @typedef {import("./estimate").ConversationMessage} ConversationMessage
 */

/**
 * System prompt for the summarization call.
 */
const SUMMARY_SYSTEM_PROMPT =
  "You are a conversation summarizer for a coding assistant. " +
  "Produce a concise but information-dense summary of the conversation: key facts, " +
  "decisions, code discussed (with file paths), open questions, and any constraints. " +
  "Keep it under ~500 words. Preserve specifics the user will need later; drop pleasantries.";

/**
 * Split the conversation at the last `keepTurns` user messages.
 * Returns the messages to fold into the summary (`old`) and the messages to
 * keep verbatim (`keep`). A "turn" is counted by its user message, so a
 * dangling user message without a reply still counts as one turn.
 * @param {ConversationMessage[]} messages
 * @param {number} keepTurns
 * @returns {{ old: ConversationMessage[], keep: ConversationMessage[] }}
 */
function splitAtKeepTurn(messages, keepTurns) {
  /** @type {number[]} */
  const userIdx = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  if (userIdx.length <= keepTurns) {
    return { old: [], keep: messages };
  }
  const cutIdx = userIdx[userIdx.length - keepTurns];
  return { old: messages.slice(0, cutIdx), keep: messages.slice(cutIdx) };
}

/**
 * Build the chat request for the summarization call. Uses a single user
 * message (never alternating roles) so it works with both the OpenAI and
 * Anthropic providers, and omits images — they cannot be summarized.
 * @param {string | null} summary - existing rolling summary, if any
 * @param {ConversationMessage[]} oldTurns - turns to fold in
 * @returns {Array<{ role: string, content: string }>}
 */
function buildSummaryRequest(summary, oldTurns) {
  let body = "";
  if (summary) {
    body += "Existing summary:\n" + summary + "\n\n";
  }
  body += "New conversation turns to fold into the summary:\n\n";
  for (const t of oldTurns) {
    const label = t.role === "user" ? "User" : "Assistant";
    body += label + ": " + (t.content || "");
    if (t.images && t.images.length > 0) {
      body += " [image attachment omitted — cannot be summarized]";
    }
    body += "\n\n";
  }
  body += "Produce the updated summary now.";
  return [
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: body },
  ];
}

/**
 * @typedef {Object} CompactionPlan
 * @property {boolean} shouldCompact
 * @property {number} estimate - Estimated size of the upcoming request in tokens
 * @property {ConversationMessage[]} old - Messages to fold into the summary
 * @property {ConversationMessage[]} keep - Messages kept verbatim
 * @property {Array<{ role: string, content: string }> | null} compactRequest
 * @property {string} [skipReason] - Why compaction was skipped (if shouldCompact is false despite the trigger)
 */

/**
 * Decide whether to compact and, if so, what to do.
 * @param {Object} opts
 * @param {string} opts.systemPrompt
 * @param {ConversationMessage[]} opts.messages - the full conversation (incl. the message about to be sent)
 * @param {number} opts.threshold - trigger threshold in tokens
 * @param {number} opts.keepTurns - recent turns kept verbatim
 * @param {string | null} [opts.summary]
 * @returns {CompactionPlan}
 */
function planCompaction(opts) {
  const estimate = estimateRequestTokens(opts.systemPrompt, opts.messages, opts.summary || undefined);
  if (estimate <= opts.threshold) {
    return { shouldCompact: false, estimate, old: [], keep: opts.messages, compactRequest: null };
  }

  const { old, keep } = splitAtKeepTurn(opts.messages, opts.keepTurns);
  if (old.length === 0) {
    return {
      shouldCompact: false,
      estimate,
      old,
      keep,
      compactRequest: null,
      skipReason: "recent turns alone exceed the threshold — nothing older to compact",
    };
  }

  const compactRequest = buildSummaryRequest(opts.summary || null, old);
  // Guard: the summarization request itself must fit. It only contains the
  // old turns, but a single enormous turn could still blow the threshold.
  const compactEstimate =
    estimateTextTokens(compactRequest[0].content) + estimateTextTokens(compactRequest[1].content);
  if (compactEstimate > opts.threshold) {
    return {
      shouldCompact: false,
      estimate,
      old,
      keep,
      compactRequest: null,
      skipReason: "the summarization request itself would exceed the threshold",
    };
  }

  return { shouldCompact: true, estimate, old, keep, compactRequest };
}

module.exports = { SUMMARY_SYSTEM_PROMPT, splitAtKeepTurn, buildSummaryRequest, planCompaction };

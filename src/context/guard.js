/**
 * Request-size guard for the tool-calling loop.
 *
 * The chat loop grows without bound: every round re-sends the system prompt,
 * the conversation history, AND all accumulated tool rounds. With reasoning
 * models the API checks messages + completion, so hidden thinking tokens can
 * overflow a request whose input alone would fit.
 *
 * This module:
 *   1. computes a per-request budget from the user's compaction trigger
 *      threshold, reserving a proportional slice for output/reasoning tokens
 *      (the OpenCode formula: threshold - max(outputAllowance, buffer));
 *   2. prunes whole tool rounds from the request when it would exceed the
 *      budget (whole rounds keep assistant(tool_calls) -> tool chains valid);
 *   3. reports whether the request is still over budget so the caller can
 *      stop gracefully instead of sending a doomed request.
 *
 * Pure module (no vscode dependency) so it can run under `node --test`.
 */

const { estimateMessages } = require("./estimate");

/** Fraction of the threshold reserved for output/reasoning tokens. */
const RESERVE_RATIO = 0.1;
/** Floor for the reserve so tiny thresholds don't leave zero room. */
const MIN_RESERVE_TOKENS = 4096;
/** Only prune when the freed tokens are worth it (avoid churn). */
const MIN_FREED_TOKENS = 20000;
/** Keep at most this many tokens of recent rounds as a context cushion. */
const KEEP_CUSHION_TOKENS = 40000;
/** Never prune the newest complete round. */
const MIN_KEEP_ROUNDS = 1;
/** Tool results over this many chars are truncated (head kept). */
const TOOL_RESULT_MAX_CHARS = 25000;

/**
 * @typedef {import("./estimate").ConversationMessage} ConversationMessage
 */

/**
 * Per-request budget: threshold minus a proportional output/reasoning reserve.
 * @param {number} threshold - the user's compaction trigger threshold in tokens
 * @returns {number}
 */
function computeBudget(threshold) {
  const reserve = Math.max(Math.round(threshold * RESERVE_RATIO), MIN_RESERVE_TOKENS);
  return Math.max(0, threshold - reserve);
}

/**
 * Split a chat messages array into the prefix (everything up to and including
 * the last user message — system prompt, history, current user message) and
 * the whole tool rounds that follow it. A round is an assistant message with
 * tool_calls plus every immediately-following tool result message.
 * @param {ConversationMessage[]} messages
 * @returns {{ roundsStart: number, rounds: Array<{ start: number, end: number, tokens: number }> }}
 */
function splitRounds(messages) {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  const roundsStart = lastUser + 1;
  /** @type {Array<{ start: number, end: number, tokens: number }>} */
  const rounds = [];
  let i = roundsStart;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool") j++;
      rounds.push({ start: i, end: j, tokens: estimateMessages(messages.slice(i, j)) });
      i = j;
    } else {
      // Defensive: a message in the rounds region that isn't a round start
      // (e.g. a dangling text message) is treated as its own round.
      rounds.push({ start: i, end: i + 1, tokens: estimateMessages([m]) });
      i++;
    }
  }
  return { roundsStart, rounds };
}

/**
 * Prune whole tool rounds from the oldest end of the request when it exceeds
 * the budget. Mutates `messages` in place. Guardrails:
 *   - the newest round is never dropped (MIN_KEEP_ROUNDS);
 *   - at most a ~40K-token cushion of recent rounds is kept;
 *   - pruning only happens when it frees at least MIN_FREED_TOKENS.
 * Returns the resulting estimate and whether the request is still over budget
 * (in which case the caller should stop gracefully — a doomed request must
 * never be sent).
 * @param {ConversationMessage[]} messages - mutated in place
 * @param {number} budget
 * @returns {{ estimate: number, overBudget: boolean, droppedRounds: number, freedTokens: number }}
 */
function pruneRounds(messages, budget) {
  const estimate = estimateMessages(messages);
  if (estimate <= budget) {
    return { estimate, overBudget: false, droppedRounds: 0, freedTokens: 0 };
  }

  const { roundsStart, rounds } = splitRounds(messages);
  if (rounds.length <= MIN_KEEP_ROUNDS) {
    // Nothing droppable — a single round (or none) plus history is over budget.
    return { estimate, overBudget: true, droppedRounds: 0, freedTokens: 0 };
  }

  // Cumulative freed tokens: freed[i] = tokens of rounds[0..i-1].
  /** @type {number[]} */
  const freed = [0];
  for (const r of rounds) freed.push(freed[freed.length - 1] + r.tokens);

  // Cushion cap: how many newest rounds we are willing to keep.
  let cushionKeep = 0;
  let cushionTokens = 0;
  for (let r = rounds.length - 1; r >= 0; r--) {
    if (cushionTokens + rounds[r].tokens > KEEP_CUSHION_TOKENS && cushionKeep >= MIN_KEEP_ROUNDS) break;
    cushionKeep++;
    cushionTokens += rounds[r].tokens;
  }
  cushionKeep = Math.max(cushionKeep, MIN_KEEP_ROUNDS);

  // Prefer the largest keepCount that fits the budget.
  let keepCount = 0;
  for (let k = cushionKeep; k >= MIN_KEEP_ROUNDS; k--) {
    const droppedTokens = freed[rounds.length - k];
    if (estimate - droppedTokens <= budget) {
      keepCount = k;
      break;
    }
  }
  if (keepCount === 0) {
    // Even the newest round alone exceeds the budget.
    return { estimate, overBudget: true, droppedRounds: 0, freedTokens: 0 };
  }

  const dropCount = rounds.length - keepCount;
  if (dropCount === 0) {
    return { estimate, overBudget: true, droppedRounds: 0, freedTokens: 0 };
  }
  const freedTokens = freed[dropCount];
  if (freedTokens < MIN_FREED_TOKENS) {
    // Marginal gain — not worth the context loss; report over budget.
    return { estimate, overBudget: true, droppedRounds: 0, freedTokens: 0 };
  }

  const removeEnd = rounds[dropCount - 1].end;
  messages.splice(roundsStart, removeEnd - roundsStart);
  return { estimate: estimate - freedTokens, overBudget: false, droppedRounds: dropCount, freedTokens };
}

/**
 * Truncate a tool result to its head (first TOOL_RESULT_MAX_CHARS chars) with
 * an explicit marker so the model knows data was cut.
 * @param {unknown} text
 * @returns {string}
 */
function truncateToolResult(text) {
  const str = text == null ? "" : String(text);
  if (str.length <= TOOL_RESULT_MAX_CHARS) return str;
  return (
    str.slice(0, TOOL_RESULT_MAX_CHARS) +
    "\n[…truncated — result was " + str.length + " chars; only the first " + TOOL_RESULT_MAX_CHARS + " chars are kept…]"
  );
}

/**
 * Tally executed tool calls by name, for the graceful-stop message.
 * @param {ConversationMessage[]} messages
 * @returns {Record<string, number>}
 */
function countToolCalls(messages) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const m of messages) {
    for (const tc of m.tool_calls || []) {
      const name = tc && tc.function && tc.function.name ? tc.function.name : "unknown";
      counts[name] = (counts[name] || 0) + 1;
    }
  }
  return counts;
}

module.exports = {
  computeBudget,
  splitRounds,
  pruneRounds,
  truncateToolResult,
  countToolCalls,
  RESERVE_RATIO,
  MIN_RESERVE_TOKENS,
  MIN_FREED_TOKENS,
  KEEP_CUSHION_TOKENS,
  MIN_KEEP_ROUNDS,
  TOOL_RESULT_MAX_CHARS,
};

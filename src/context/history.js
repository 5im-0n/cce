/**
 * Persisted tool rounds.
 *
 * A tool round is an assistant message carrying `tool_calls` plus the `tool`
 * messages that answer those calls. Rounds used to live only in the request
 * array of the turn that produced them, so every new user message started from
 * a transcript that knew nothing about them. They are now persisted with the
 * session, which means the next request replays them and the model remembers
 * what its tools actually returned.
 *
 * That turns the pairing rules into a hard requirement instead of a nicety:
 * OpenAI rejects a `tool` message whose `tool_call_id` has no preceding call,
 * and Anthropic rejects a `tool_result` block without a matching `tool_use`.
 * A turn that is stopped mid-batch, or a transcript restored from an older
 * build, can leave half a round behind — so the transcript is repaired here
 * before it is sent, never at the provider.
 *
 * Retention is by token budget only (never by turn count): old rounds are
 * dropped from storage when the transcript outgrows the budget, leaving a
 * marker that says the results are gone. Compaction and the request guard are
 * separate mechanisms — this module only decides what the transcript keeps.
 *
 * The transcript stores EXACTLY the string the request carried for a call. It
 * used to store a second, much smaller copy (4 000 chars), which made the next
 * turn's model reason about a file it had only partly seen. That copy is gone:
 * the only bound on a stored result is the retention budget above, plus
 * whatever the request itself already did to the string.
 *
 * Pure module (no vscode dependency) so it can run under `node --test`.
 */

const { estimateMessageTokens } = require("./estimate");

/**
 * @typedef {import("./estimate").ConversationMessage} ConversationMessage
 */

/** Result recorded for a call that was persisted without one. */
const SKIPPED_TOOL_RESULT =
  "Error: this tool call was not executed — the turn ended before a result was recorded.";

/** Result recorded for the call that was running when the user stopped it. */
const ABORTED_TOOL_RESULT = "Aborted by user";

/** Never trim the newest round away: it is the one the model just used. */
const MIN_KEEP_ROUNDS = 1;

/**
 * @typedef {Object} Round
 * @property {number} start - index of the assistant(tool_calls) message
 * @property {number} end - index just past its last tool result
 * @property {number} tokens - estimated request tokens of the whole round
 */

/**
 * Sum message token estimates (local, so this module does not depend on
 * `estimateMessages` and stays usable with partially stubbed estimates).
 * @param {ConversationMessage[]} messages
 * @returns {number}
 */
function sumTokens(messages) {
  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return tokens;
}

/**
 * Whether a message introduces a tool round.
 * @param {ConversationMessage | undefined | null} message
 * @returns {boolean}
 */
function isRoundStart(message) {
  return Boolean(
    message && message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
  );
}

/**
 * Locate every tool round in a messages array, oldest first.
 * @param {ConversationMessage[]} messages
 * @returns {Round[]}
 */
function collectRounds(messages) {
  /** @type {Round[]} */
  const rounds = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (isRoundStart(message)) {
      let end = i + 1;
      while (end < messages.length && messages[end] && messages[end].role === "tool") end++;
      rounds.push({ start: i, end, tokens: sumTokens(messages.slice(i, end)) });
      i = end;
    } else {
      i++;
    }
  }
  return rounds;
}

/**
 * Whether a message carries visible text (a bare string or a content-part
 * array). An assistant message with neither text nor tool calls is empty, and
 * providers reject it (Anthropic would send an empty content block).
 * @param {ConversationMessage} message
 * @returns {boolean}
 */
function hasTextContent(message) {
  const content = message.content;
  if (typeof content === "string") return content.trim() !== "";
  if (Array.isArray(content)) {
    return content.some((part) => part && typeof part.text === "string" && part.text.trim() !== "");
  }
  return false;
}

/**
 * Make a request array provider-safe: every `tool_calls` id gets exactly one
 * `tool` answer, orphan results and empty assistant messages are dropped, and
 * message order is otherwise untouched. Never mutates the input.
 *
 * @param {ConversationMessage[]} messages
 * @returns {ConversationMessage[]}
 */
function normalizeRounds(messages) {
  /** @type {ConversationMessage[]} */
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (!message || typeof message !== "object" || typeof message.role !== "string") {
      i++;
      continue;
    }

    if (message.role === "tool") {
      // A result whose carrier is gone (a trimmed round, an edit that
      // truncated the turn, or a session written before rounds were
      // persisted). Its call cannot be reconstructed, so the lone half of the
      // pair goes away instead of reaching the provider.
      i++;
      continue;
    }

    if (isRoundStart(message)) {
      /** @type {string[]} */
      const callIds = [];
      for (const tc of message.tool_calls || []) {
        const id = tc && typeof tc.id === "string" ? tc.id : "";
        if (id) callIds.push(id);
      }
      if (callIds.length === 0) {
        // Calls without ids cannot be paired with any result at all.
        if (hasTextContent(message)) out.push({ role: message.role, content: message.content });
        i++;
        continue;
      }
      out.push(message);
      /** @type {Set<string>} */
      const answered = new Set();
      let j = i + 1;
      while (j < messages.length && messages[j] && messages[j].role === "tool") {
        const result = messages[j];
        const id = typeof result.tool_call_id === "string" ? result.tool_call_id : "";
        // Match by id, in order, and only once: a duplicated result, or one
        // answering a call from another round, is dropped.
        if (id && callIds.includes(id) && !answered.has(id)) {
          out.push(result);
          answered.add(id);
        }
        j++;
      }
      for (const id of callIds) {
        if (answered.has(id)) continue;
        out.push({ role: "tool", tool_call_id: id, content: SKIPPED_TOOL_RESULT });
      }
      i = j;
      continue;
    }

    if (message.role === "assistant" && !hasTextContent(message)) {
      // An empty assistant message is what a stopped or failed turn leaves
      // behind; it is never sent.
      i++;
      continue;
    }

    out.push(message);
    i++;
  }
  return out;
}

/**
 * Move a transcript boundary back to a round boundary, so the model's view
 * never starts inside a round (a leading `tool` result, or tool calls whose
 * results were folded away, is rejected by both providers). Boundaries only
 * ever move back: moving forward would skip a message the summary does not
 * actually cover.
 *
 * @param {ConversationMessage[]} messages
 * @param {number} index - first message NOT covered by the summary
 * @returns {number}
 */
function alignBoundary(messages, index) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  if (!Number.isInteger(index) || index <= 0) return 0;
  if (index >= messages.length) return messages.length;
  let i = index;
  while (i > 0) {
    const at = messages[i];
    const previous = messages[i - 1];
    const splitsRound = Boolean(at && at.role === "tool") || isRoundStart(previous);
    if (!splitsRound) break;
    i--;
  }
  return i;
}

/**
 * Marker left in place of the rounds a trim removed. `notice: true` marks it
 * as transcript furniture: the webview renders it as a notice line, and the
 * model reads it as a system note. `removedRounds` lets a later trim merge into
 * it instead of stacking a second marker next to it.
 * @param {number} count
 * @returns {ConversationMessage}
 */
function removedRoundsMarker(count) {
  return {
    role: "system",
    notice: true,
    removedRounds: count,
    content:
      "[" + count + " older tool round" + (count === 1 ? "" : "s") +
      " removed from the transcript to stay within the context budget. " +
      "Those tool results are no longer available — run the tools again if you still need them.]",
  };
}

/**
 * Record a result for every tool call a persisted round left unanswered —
 * the calls of a batch that a Stop, a close or a crash cut short. The record
 * keeps the round pairable, and tells the model next turn that the call was
 * not executed (rather than letting it assume an empty result).
 *
 * Mutates `messages` in place.
 * @param {ConversationMessage[]} messages
 * @returns {number} how many results were filled in
 */
function closeDanglingRounds(messages) {
  let filled = 0;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!isRoundStart(message)) continue;
    let end = i + 1;
    while (end < messages.length && messages[end] && messages[end].role === "tool") end++;
    /** @type {Set<string>} */
    const answered = new Set();
    for (let j = i + 1; j < end; j++) {
      const id = messages[j].tool_call_id;
      if (typeof id === "string") answered.add(id);
    }
    /** @type {ConversationMessage[]} */
    const missing = [];
    for (const tc of message.tool_calls || []) {
      const id = tc && typeof tc.id === "string" ? tc.id : "";
      if (!id || answered.has(id)) continue;
      missing.push({ role: "tool", tool_call_id: id, content: SKIPPED_TOOL_RESULT });
      answered.add(id);
    }
    if (missing.length > 0) {
      messages.splice(end, 0, ...missing);
      filled += missing.length;
    }
    i = end + missing.length - 1;
  }
  return filled;
}

/**
 * Map a transcript index onto the array that results from removing `removed`
 * and inserting one marker. Both `removed` and `markerAtOld` are expressed in
 * the PRE-removal array; `markerAtNew` is where the marker landed in the new
 * one. An index that was removed (a round that went away, or a marker that was
 * folded into the new one) collapses onto the new marker.
 * Used to keep a summary boundary pointing at the same message.
 * @param {number} index - index in the pre-removal array
 * @param {number[]} removed - pre-removal indexes that went away
 * @param {number} [markerAtOld] - pre-removal index the removal started at
 * @param {number} [markerAtNew] - index of the marker in the new array
 * @returns {number}
 */
function shiftBoundary(index, removed, markerAtOld, markerAtNew) {
  if (!Number.isFinite(index) || index <= 0) return 0;
  const gone = Array.isArray(removed) ? removed : [];
  const markerIndex = Number.isFinite(markerAtNew) ? markerAtNew : Number.isFinite(markerAtOld) ? markerAtOld : -1;
  if (gone.includes(index)) return Math.max(0, markerIndex);
  let shift = 0;
  for (const at of gone) {
    if (at < index) shift++;
  }
  const inserted = Number.isFinite(markerAtOld) && markerAtOld >= 0 && markerAtOld < index ? 1 : 0;
  return Math.max(0, index - shift + inserted);
}

/**
 * The slice of the transcript the webview renders. Tool rounds, tool results
 * and empty carrier messages are dropped — the UI keeps its user/assistant
 * transcript — but removal markers survive as notice lines, so a trimmed
 * conversation still tells the user its older tool activity is gone.
 * @param {ConversationMessage[]} messages
 * @returns {Array<Record<string, any>>}
 */
function toDisplayTranscript(messages) {
  /** @type {Array<Record<string, any>>} */
  const out = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content, id: message.id, images: message.images || [] });
      continue;
    }
    if (message.role === "assistant" && hasTextContent(message)) {
      out.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.notice) {
      out.push({ role: "system", notice: true, content: message.content });
    }
  }
  return out;
}

/**
 * Enforce retention on a transcript: tool rounds are capped by token budget
 * only (never by turn count), oldest first, always keeping the newest round.
 * A marker message records where the removed rounds used to be.
 *
 * Mutates `messages` in place. The marker's own cost is accounted for.
 *
 * @param {ConversationMessage[]} messages - mutated in place
 * @param {number} maxTokens - transcript token budget
 * @returns {{ droppedRounds: number, freedTokens: number, removed: number[], markerAt: number, markerAtOld: number }}
 */
function trimRounds(messages, maxTokens) {
  /** @type {number[]} */
  const removed = [];
  const unchanged = { droppedRounds: 0, freedTokens: 0, removed, markerAt: -1, markerAtOld: -1 };
  if (!(maxTokens > 0) || !Array.isArray(messages) || messages.length === 0) return unchanged;

  const before = sumTokens(messages);
  if (before <= maxTokens) return unchanged;

  const rounds = collectRounds(messages);
  if (rounds.length <= MIN_KEEP_ROUNDS) return unchanged;

  // If the plain conversation (everything that is not a tool round) already
  // exceeds the budget on its own, dropping rounds cannot fix it — that is
  // compaction's job. Trimming here would throw away every result for nothing.
  let roundTokens = 0;
  for (const round of rounds) roundTokens += round.tokens;
  if (before - roundTokens >= maxTokens) return unchanged;

  // Drop the oldest rounds until the transcript fits, keeping the newest one.
  let dropCount = 0;
  let dropTokens = 0;
  while (dropCount < rounds.length - MIN_KEEP_ROUNDS) {
    dropTokens += rounds[dropCount].tokens;
    dropCount++;
    const markerTokens = sumTokens([removedRoundsMarker(dropCount)]);
    if (before - dropTokens + markerTokens <= maxTokens) break;
  }
  if (dropCount === 0) return unchanged;

  /** @type {Set<number>} */
  const remove = new Set();
  for (let r = 0; r < dropCount; r++) {
    for (let i = rounds[r].start; i < rounds[r].end; i++) {
      remove.add(i);
      removed.push(i);
    }
  }
  const markerAt = rounds[0].start;
  // Merge into a marker that is already standing in for earlier removals, so
  // repeated trims leave one notice instead of a growing stack of them.
  let markerCount = dropCount;
  let existingMarkerAt = -1;
  for (let i = 0; i < markerAt; i++) {
    if (messages[i] && messages[i].notice === true) {
      markerCount += typeof messages[i].removedRounds === "number" ? messages[i].removedRounds : 0;
      existingMarkerAt = i;
    }
  }
  const marker = removedRoundsMarker(markerCount);
  /** @type {ConversationMessage[]} */
  const out = [];
  let markerIndex = -1;
  for (let i = 0; i < messages.length; i++) {
    if (i === markerAt) {
      markerIndex = out.length;
      out.push(marker);
    }
    if (i === existingMarkerAt) {
      // The old marker is gone: it is replaced by the merged one.
      removed.push(i);
      continue;
    }
    if (!remove.has(i)) out.push(messages[i]);
  }
  messages.length = 0;
  messages.push(...out);

  const after = sumTokens(messages);
  return {
    droppedRounds: dropCount,
    freedTokens: before - after,
    removed,
    markerAt: markerIndex,
    // Where the removal started in the OLD array — the reference point a
    // caller needs to shift an existing index.
    markerAtOld: markerAt,
  };
}

module.exports = {
  SKIPPED_TOOL_RESULT,
  ABORTED_TOOL_RESULT,
  MIN_KEEP_ROUNDS,
  isRoundStart,
  collectRounds,
  hasTextContent,
  normalizeRounds,
  alignBoundary,
  removedRoundsMarker,
  closeDanglingRounds,
  shiftBoundary,
  toDisplayTranscript,
  trimRounds,
};

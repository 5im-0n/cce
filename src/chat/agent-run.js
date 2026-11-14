/**
 * Sub-agent run bookkeeping: task normalisation and result formatting.
 *
 * The manager owns the run itself (tabs, capacity, cancellation); this module
 * decides only what a run *reports* back to the parent model. It is pure (no
 * `vscode`, no I/O) so the shape the parent reads can be unit-tested without an
 * extension host.
 *
 * The reported shape exists because a joined string cannot express failure: a
 * child that hit a 429, lost its MCP server or was closed by the user used to be
 * indistinguishable from one that answered `(no output)`.
 */

/** Chars allowed for the whole reported run (all agents together). */
const MAX_REPORT_CHARS = 25000;
/** Floor per agent, so an agent's answer is never reduced to a stub. */
const MIN_TASK_REPORT_CHARS = 200;
/**
 * Slack left in the report for the preamble and the per-agent truncation
 * markers, so the tool-result guard (`truncateToolResult`, same 25 000 limit)
 * never has to cut the tail of the last agent's block.
 */
const REPORT_HEADROOM_CHARS = 1500;

/**
 * @typedef {"ok"|"stopped"|"error"|"budget"|"skipped"} AgentOutcome
 *
 *   ok      → the agent produced a final answer
 *   stopped → the user stopped it, or closed its tab
 *   error   → it failed (provider error, dead MCP server, construction failure)
 *   budget  → it stopped at the context budget with a partial answer
 *   skipped → it never started (capacity, cancelled parent, closed parent)
 */

/**
 * One agent's contribution to the parent's tool result.
 * @typedef {Object} AgentTaskReport
 * @property {number} index - zero-based position in the requested task list.
 * @property {AgentOutcome} outcome
 * @property {string} [text] - what the agent produced (may be partial).
 * @property {string} [reason] - why it did not finish, when outcome !== "ok".
 */

/**
 * How one conversational turn ended. Returned by `handleSendMessage` so a
 * caller that owns something outside the chat (the manager, for a sub-agent
 * run) can tell a real answer from a failure, a stop, or a guard stop.
 * @typedef {Object} TurnOutcome
 * @property {boolean} ok - the model produced a final answer.
 * @property {boolean} aborted - the turn was cancelled (parent signal or Stop).
 * @property {string | null} error - failure message, when ok is false.
 * @property {string} text - everything streamed during the turn (may be partial).
 * @property {"budget"} [stopReason] - set when the loop guard stopped it.
 */

/**
 * Options for one agent run.
 * @typedef {Object} AgentRunOptions
 * @property {Array<string>} [tasks] - Tasks to spawn, one visible tab each.
 * @property {import("../config/Settings").ModelConfig} modelConfig
 * @property {string} [reasoningEffort] - "off" | "low" | "medium" | "high" | "max"
 * @property {AbortSignal} [signal] - Parent cancellation signal.
 */

/** How each outcome is described in the preamble the parent model reads. */
const OUTCOME_LABEL = {
  error: "failed",
  stopped: "was stopped before it finished",
  budget: "stopped at the context budget",
  skipped: "was not started",
};

/**
 * Accept only usable task prompts. A malformed `tasks` argument must never
 * throw inside the tool loop: the parent model would get a protocol error
 * instead of a correction it can act on.
 *
 * @param {unknown} tasks
 * @returns {Array<string>} Trimmed, non-empty prompts.
 */
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((task) => {
      if (typeof task === "string") return task;
      if (task == null) return "";
      return String(task);
    })
    .map((task) => task.trim())
    .filter((task) => task.length > 0);
}

/**
 * Chars each agent's block costs beyond its own text: the `Agent N result:`
 * header and the truncation marker.
 */
const BLOCK_OVERHEAD_CHARS = 180;

/**
 * Character allowance for each agent in a run of `count` agents.
 *
 * The whole report is truncated by the tool-result guard, so sharing that
 * budget out per agent is what keeps the last agent from vanishing entirely.
 * Headroom and per-block overhead are withheld so the guard never has to cut
 * the report's tail.
 *
 * @param {number} count
 * @returns {number}
 */
function taskCharBudget(count) {
  const n = Math.max(1, Math.floor(count));
  const available = MAX_REPORT_CHARS - REPORT_HEADROOM_CHARS - n * BLOCK_OVERHEAD_CHARS;
  return Math.max(MIN_TASK_REPORT_CHARS, Math.floor(available / n));
}

/**
 * Truncate one agent's output to its head, with an explicit marker.
 * @param {unknown} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateTaskText(text, maxChars) {
  const str = text == null ? "" : String(text);
  if (str.length <= maxChars) return str;
  return (
    str.slice(0, maxChars) +
    "\n[…truncated — this agent produced " + str.length + " chars; only the first " + maxChars + " are kept…]"
  );
}

/**
 * Describe one non-ok agent for the preamble, e.g.
 * `agent 2 failed (429 rate limit)`.
 * @param {AgentTaskReport} report
 * @returns {string}
 */
function describeOutcome(report) {
  const index = Number.isInteger(report.index) ? report.index : 0;
  const label = OUTCOME_LABEL[report.outcome] || "did not finish";
  const reason = report.reason ? " (" + report.reason + ")" : "";
  return "agent " + (index + 1) + " " + label + reason;
}

/**
 * Render the run as the parent model's tool result.
 *
 * All-ok runs render exactly as before (`Agent N result:` blocks). Any other
 * run leads with one line naming what did not finish, so the model cannot
 * mistake an incomplete run for a complete one — and never sees an error
 * disguised as an empty answer.
 *
 * @param {Array<AgentTaskReport>} reports
 * @returns {string}
 */
function formatAgentReport(reports) {
  const list = Array.isArray(reports) ? reports.filter((report) => report && typeof report === "object") : [];
  if (list.length === 0) return "No agents ran.";
  const perTask = taskCharBudget(list.length);

  const parts = [];
  const incomplete = list.filter((report) => report.outcome !== "ok");
  if (incomplete.length > 0) {
    parts.push(
      incomplete.length + " of " + list.length + " sub-agents did not finish: " +
        incomplete.map(describeOutcome).join("; ") +
        ".\nTheir results are incomplete or missing — do not present them as completed work."
    );
  }

  for (const report of list) {
    // Nothing ran for a task that was never started; the preamble says why and
    // an empty block would only add noise.
    if (report.outcome === "skipped") continue;
    const index = Number.isInteger(report.index) ? report.index : 0;
    const text = truncateTaskText(report.text || "", perTask);
    if (report.outcome === "ok") {
      parts.push("Agent " + (index + 1) + " result:\n" + (text || "(the agent produced no answer)"));
    } else {
      parts.push("Agent " + (index + 1) + " output (incomplete):\n" + (text || "(no output)"));
    }
  }

  return parts.join("\n\n");
}

module.exports = {
  normalizeTasks,
  formatAgentReport,
  truncateTaskText,
  taskCharBudget,
  describeOutcome,
  MAX_REPORT_CHARS,
  MIN_TASK_REPORT_CHARS,
};

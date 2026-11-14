const { getEnabledDefinitions } = require("../tools/definitions");
const { executeToolCall } = require("../tools/executor");
const { fetchMcpTools, callMcpTool } = require("../mcp/client");
const { truncateToolResult, pruneRounds } = require("../context/guard");
const { formatTokenCount } = require("../context/estimate");
const Settings = require("../config/Settings");
const log = require("../config/log").get();

/**
 * Run parallel sub-agents, each with a task and access to tools (except
 * `agent`, which would recurse).
 *
 * Extracted from the chat controller so the controller stays focused on one
 * conversation. Sub-agents deliberately bypass the approval gate: approving
 * the `agent` call is the trust decision.
 */

const MAX_TOOL_ROUNDS = 10; // Prevent infinite loops

/**
 * @typedef {Object} AgentRunOptions
 * @property {Array<string>} [tasks]
 * @property {string} [task] - A single task when run inside a visible agent tab.
 * @property {string} reasoningEffort - "off" | "low" | "medium" | "high" | "max"
 * @property {import("../config/Settings").ModelConfig} modelConfig
 * @property {string} apiKey
 * @property {import("../providers/registry").Provider} provider
 * @property {number} [budget] - per-request token budget from the loop guard
 * @property {AbortSignal} [signal] - Parent cancellation signal.
 * @property {(text: string) => void} [onProgress] - Forward visible progress to the agent chat.
 * @property {(text: string) => void} [onChunk] - Forward streamed model text.
 */
/**
 * Run every task in parallel and join the results.
 *
 * @param {AgentRunOptions} options
 * @returns {Promise<string>}
 */
async function runSubAgents(options) {
  const { tasks, modelConfig, apiKey, provider, budget, reasoningEffort, signal, onProgress, onChunk } = options;
  if (!tasks || tasks.length === 0) return "No tasks provided.";

  let subTools = getEnabledDefinitions(Settings.getToolSettings())
    .filter((t) => t.function.name !== "agent");

  // Also include MCP tools so sub-agents can search the web, etc.
  try {
    const mcpTools = await fetchMcpTools();
    subTools = subTools.concat(mcpTools.filter((t) => t.function.name !== "agent"));
  } catch (e) {
    log.appendLine("Agent: MCP fetch failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }

  log.appendLine("Agent: spawning " + tasks.length + " sub-agents with " + subTools.length + " tools");
  const report = (text) => { if (onProgress) onProgress(text); };
  report("Starting agent run with " + tasks.length + " task(s).");

  const results = await Promise.all(tasks.map(async (task, i) => {
    try {
      /** @type {Array<import("../providers/openai").ChatMessage>} */
      const messages = [{ role: "user", content: String(task) }];
      let round = 0;

      while (round < MAX_TOOL_ROUNDS) {
        round++;
        // Loop guard: sub-agent requests accumulate their own tool rounds,
        // so prune/stop against the same budget as the main loop.
        if (typeof budget === "number" && budget > 0) {
          if (signal && signal.aborted) throw createAbortError();
          const guard = pruneRounds(messages, budget);
          if (guard.overBudget) {
            const roundsDone = messages.filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0).length;
            log.appendLine("Agent task " + (i + 1) + ": context budget reached after " + roundsDone + " rounds, returning partial result");
            return "Task " + (i + 1) + " result (partial — context budget reached after " + roundsDone + " rounds):\n" +
              "The next request would have used ~" + formatTokenCount(guard.estimate) + " tokens (budget " + formatTokenCount(budget) + ").\n" +
              "Gathered so far (shown above). Raise the compaction trigger threshold for larger agent runs.";
          }
        }
        const result = await provider.chat(
          messages,
          modelConfig.modelId, modelConfig.endpoint, apiKey,
          (chunk) => {
            if (onChunk) onChunk(chunk);
            report(chunk);
          },
          signal || new AbortController().signal,
          subTools.length > 0 ? subTools : undefined,
          undefined, // no thinking callback for sub-agents
          reasoningEffort,
          modelConfig.requestParameters
        );

        // If the model returned tool calls, execute them and loop
        if (result.toolCalls && result.toolCalls.length > 0) {
          const summary = "Agent task " + (i + 1) + " round " + round + ": " + result.toolCalls.length + " tool call(s)";
          log.appendLine(summary);
          report("\n\n" + summary + "\n");
          messages.push({ role: "assistant", content: null, tool_calls: result.toolCalls });

          for (const tc of result.toolCalls) {
            let toolResult, toolArgs;
            try {
              toolArgs = JSON.parse(tc.function.arguments || "{}");

              // Route MCP tools to the MCP client
              if (tc.function.name.startsWith("mcp__")) {
                const parts = tc.function.name.split("__");
                const serverId = parts[1];
                const toolName = parts.slice(2).join("__");
                toolResult = await callMcpTool(serverId, toolName, toolArgs);
              } else {
                toolResult = await executeToolCall(tc.function.name, toolArgs);
              }
            } catch (e) {
              toolResult = "Error: " + (e instanceof Error ? e.message : String(e));
              toolArgs = {};
            }

            messages.push({ role: "tool", tool_call_id: tc.id, content: truncateToolResult(toolResult) });
          }

          // Continue the loop to let the model process tool results
          continue;
        }

        // No tool calls — model produced a final answer
        return "Task " + (i + 1) + " result:\n" + (result.text || "(no output)");
      }

      // Exhausted max rounds — ask model for one final summary (no tools)
      log.appendLine("Agent task " + (i + 1) + ": max rounds reached, requesting final summary");
      if (typeof budget === "number" && budget > 0) {
        const guard = pruneRounds(messages, budget);
        if (guard.overBudget) {
          const roundsDone = messages.filter((m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0).length;
          return "Task " + (i + 1) + " result (partial — context budget reached after " + roundsDone + " rounds):\n" +
            "The next request would have used ~" + formatTokenCount(guard.estimate) + " tokens (budget " + formatTokenCount(budget) + ").\n" +
            "Gathered so far (shown above). Raise the compaction trigger threshold for larger agent runs.";
        }
      }
      const finalResult = await provider.chat(
        messages.concat([{ role: "user", content: "You have reached the maximum number of tool-calling rounds. Please provide your best answer now based on the information gathered so far. Do not call any more tools." }]),
        modelConfig.modelId, modelConfig.endpoint, apiKey,
        () => {},
        new AbortController().signal,
        undefined, // no tools available for final summary
        undefined, // no thinking callback for sub-agents
        reasoningEffort,
        modelConfig.requestParameters
      );
      return "Task " + (i + 1) + " result (max rounds reached):\n" + (finalResult.text || "(no output)");
    } catch (e) {
      if (signal && signal.aborted) throw createAbortError();
      return "Task " + (i + 1) + " error: " + (e instanceof Error ? e.message : String(e));
    }
  }));

  return results.join("\n\n");
}

function createAbortError() {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

module.exports = { runSubAgents, MAX_TOOL_ROUNDS };

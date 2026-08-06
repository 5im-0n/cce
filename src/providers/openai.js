const vscode = require("vscode");
const log = require("../config/log").get();

/**
 * @typedef {Object} ChatMessage
 * @property {"system" | "user" | "assistant" | "tool"} role
 * @property {string} [content]
 * @property {Array<object>} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * OpenAI-compatible chat completions provider.
 * Supports streaming text and tool calls via SSE.
 * Uses /v1/chat/completions by default; switches to /v1/responses when
 * reasoning is active (GPT-5.6+), because /v1/chat/completions rejects
 * the combination of tools + reasoning_effort for reasoning models.
 */
const openaiProvider = {
  id: "openai",
  displayName: "OpenAI",

  /**
   * Send a streaming chat request.
   * @param {ChatMessage[]} messages
   * @param {string} modelId
   * @param {string} endpoint - Base URL (e.g. https://api.openai.com/v1)
   * @param {string} apiKey
   * @param {function(string): void} onPartial - Called with each text token chunk
   * @param {AbortSignal} [signal]
   * @param {Array<object>} [tools] - OpenAI tool definitions
   * @param {function(string): void} [onThinking] - Called with reasoning/thinking tokens
   * @param {string} [reasoningEffort] - "off" | "low" | "medium" | "high" (GPT-5.6+)
   * @returns {Promise<{ text: string, thinking?: string, toolCalls?: Array }>}
   */
  async chat(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking, reasoningEffort) {
    const hasReasoning = reasoningEffort && reasoningEffort !== "off";

    if (hasReasoning) {
      return this._chatResponses(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking, reasoningEffort);
    }

    return this._chatCompletions(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking);
  },

  // ───────────────────────────────
  //  Chat Completions path (no reasoning)
  // ───────────────────────────────

  /**
   * Send via /v1/chat/completions (existing behaviour, unchanged).
   */
  async _chatCompletions(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking) {
    const url = endpoint.replace(/\/+$/, "") + "/chat/completions";

    /** @type {object} */
    const body = {
      model: modelId,
      messages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      log.appendLine(
        `OpenAI error ${response.status}: ${response.statusText}${errText ? " — " + errText.slice(0, 500) : ""}`
      );
      throw new ProviderError(
        `API error ${response.status}: ${response.statusText}${errText ? " — " + errText.slice(0, 500) : ""}`,
        response.status,
        errText
      );
    }

    let fullText = "";
    let thinking = "";
    /** @type {Map<number, { id: string, name: string, arguments: string }>} */
    const toolCalls = new Map();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          // Text token
          if (delta?.content) {
            fullText += delta.content;
            onPartial(delta.content);
          }

          // Thinking/reasoning token (o1, o3, DeepSeek-R1, etc.)
          if (delta?.reasoning_content && onThinking) {
            thinking += delta.reasoning_content;
            onThinking(delta.reasoning_content);
          }

          // Tool call deltas (accumulate incrementally)
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) {
                toolCalls.set(idx, { id: "", name: "", arguments: "" });
              }
              const entry = toolCalls.get(idx);
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name += tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
        } catch {
          // Skip unparseable chunks
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              onPartial(delta.content);
            }
            if (delta?.reasoning_content && onThinking) {
              thinking += delta.reasoning_content;
              onThinking(delta.reasoning_content);
            }
          } catch { /* skip */ }
        }
      }
    }

    const result = fullText
      ? { text: fullText }
      : { text: "" };

    if (thinking) result.thinking = thinking;

    if (toolCalls.size > 0) {
      result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }));
    }

    return result;
  },

  // ───────────────────────────────
  //  Responses path (reasoning active)
  // ───────────────────────────────

  /**
   * Send via /v1/responses (GPT-5.6+ reasoning models).
   * The Responses API supports reasoning + tools together natively.
   */
  async _chatResponses(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking, reasoningEffort) {
    const url = endpoint.replace(/\/+$/, "") + "/responses";

    // ── Convert messages ─────────────────

    /** @type {string} */
    let instructions = "";
    /** @type {Array<object>} */
    const input = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        instructions += (instructions ? "\n" : "") + (msg.content || "");
        continue;
      }

      if (msg.role === "user") {
        input.push({ role: "user", content: msg.content || "" });
        continue;
      }

      if (msg.role === "assistant") {
        // If the assistant message has tool_calls, emit function_call items
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id || "",
              name: tc.function?.name || "",
              arguments: tc.function?.arguments || "",
            });
          }
        }
        // If it also has text content, emit an assistant message item
        if (msg.content) {
          input.push({ role: "assistant", content: msg.content });
        }
        continue;
      }

      if (msg.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id || "",
          output: msg.content || "",
        });
        continue;
      }
    }

    // ── Convert tools ────────────────────

    /** @type {Array<object> | undefined} */
    let responseTools;
    if (tools && tools.length > 0) {
      responseTools = tools.map((t) => ({
        type: "function",
        name: t.function?.name || t.name || "",
        description: t.function?.description || t.description || "",
        parameters: t.function?.parameters || t.parameters || {},
      }));
    }

    // ── Build request ────────────────────

    /** @type {object} */
    const body = {
      model: modelId,
      input,
      stream: true,
      store: false,
      reasoning: {
        effort: reasoningEffort,
        summary: "auto",
      },
    };

    if (instructions) {
      body.instructions = instructions;
    }
    if (responseTools && responseTools.length > 0) {
      body.tools = responseTools;
    }

    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    log.appendLine(`CCE (Responses): ${url} — model=${modelId} reasoning=${reasoningEffort} tools=${responseTools?.length || 0}`);

    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      log.appendLine(
        `OpenAI Responses error ${response.status}: ${response.statusText}${errText ? " — " + errText.slice(0, 500) : ""}`
      );
      throw new ProviderError(
        `API error ${response.status}: ${response.statusText}${errText ? " — " + errText.slice(0, 500) : ""}`,
        response.status,
        errText
      );
    }

    // ── Parse SSE stream ────────────────

    let fullText = "";
    let thinking = "";

    /**
     * Track output items by output_index.
     * @type {Map<number, { type: string, call_id?: string, name?: string, arguments: string }>}
     */
    const outputItems = new Map();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;

        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        // If this line is already a text/thinking delta (some proxies bundle this)
        // it will be handled separately via specific event types below.
        switch (parsed.type) {
          // ── Text delta ──
          case "response.output_text.delta": {
            const delta = parsed.delta || "";
            fullText += delta;
            onPartial(delta);
            break;
          }

          // ── Thinking/reasoning delta ──
          case "response.reasoning_text.delta": {
            const delta = parsed.delta || "";
            thinking += delta;
            if (onThinking) onThinking(delta);
            break;
          }

          // ── New output item ──
          case "response.output_item.added": {
            const item = parsed.item || {};
            outputItems.set(parsed.output_index, {
              type: item.type,
              call_id: item.call_id,
              name: item.name,
              arguments: item.arguments || "",
            });
            break;
          }

          // ── Reasoning summary part (Azure) ──
          case "response.reasoning_summary_part.added": {
            // Azure emits reasoning summaries via summary parts instead of
            // raw response.reasoning_text.delta events. Start a new part.
            break;
          }

          // ── Reasoning summary text delta (Azure) ──
          case "response.reasoning_summary_text.delta": {
            const delta = parsed.delta || "";
            thinking += delta;
            if (onThinking) onThinking(delta);
            break;
          }

          // ── Function call argument deltas ──
          case "response.function_call_arguments.delta": {
            const idx = parsed.output_index;
            const item = outputItems.get(idx);
            if (item) {
              item.arguments += parsed.delta || "";
            }
            break;
          }

          // ── Function call arguments done ──
          case "response.function_call_arguments.done": {
            const idx = parsed.output_index;
            const item = outputItems.get(idx);
            if (item) {
              // Use the final complete arguments string if available
              if (parsed.arguments) {
                item.arguments = parsed.arguments;
              }
            }
            break;
          }

          // ── Stream complete ──
          case "response.completed": {
            // Extract usage if needed (available on parsed.response.usage)
            break;
          }

          // ── Error ──
          case "response.failed":
          case "error": {
            const msg = parsed.error?.message || parsed.message || "Unknown error";
            log.appendLine(`OpenAI Responses stream error: ${msg}`);
            throw new ProviderError(
              `Stream error: ${msg}`,
              parsed.error?.code || 0,
              JSON.stringify(parsed)
            );
          }

          default:
            // Unknown event — log for debugging
            log.appendLine(`CCE (Responses) unknown event: ${parsed.type}`);
            break;
        }
      }
    }

    // ── Build result ────────────────────

    const result = fullText
      ? { text: fullText }
      : { text: "" };

    if (thinking) result.thinking = thinking;

    // Extract function_call items from outputItems
    const functionCalls = Array.from(outputItems.values())
      .filter((item) => item.type === "function_call" && item.call_id);

    if (functionCalls.length > 0) {
      result.toolCalls = functionCalls.map((item) => ({
        id: item.call_id,
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments,
        },
      }));
    }

    return result;
  },
};

/**
 * Provider-level error.
 */
class ProviderError extends Error {
  /** @param {string} message @param {number} [status] @param {string} [body] */
  constructor(message, status, body) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

module.exports = openaiProvider;

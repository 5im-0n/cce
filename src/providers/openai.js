const log = require("../config/log").get();

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {Object} function
 * @property {string} function.name
 * @property {string} function.arguments
 */

/**
 * @typedef {Object} ContentPart
 * @property {"text" | "image_url"} [type]
 * @property {string} [text]
 * @property {{ url?: string }} [image_url]
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} role
 * @property {string | Array<ContentPart> | null} [content]
 * @property {Array<ToolCall>} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @typedef {Object} ToolDefinition
 * @property {"function"} type
 * @property {Object} function
 * @property {string} function.name
 * @property {string} function.description
 * @property {object} function.parameters
 * @property {string} [_mcpServerId]
 * @property {string} [_mcpToolName]
 */

/**
 * @typedef {Object} ChatResult
 * @property {string} text
 * @property {string} [thinking]
 * @property {Array<ToolCall>} [toolCalls]
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
   * @param {Array<ToolDefinition>} [tools] - OpenAI tool definitions
   * @param {function(string): void} [onThinking] - Called with reasoning/thinking tokens
   * @param {string} [reasoningEffort] - "off" | "low" | "medium" | "high" | "max"
   * @returns {Promise<ChatResult>}
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
   * @param {ChatMessage[]} messages
   * @param {string} modelId
   * @param {string} endpoint
   * @param {string} apiKey
   * @param {function(string): void} onPartial
   * @param {AbortSignal} [signal]
   * @param {Array<ToolDefinition>} [tools]
   * @param {function(string): void} [onThinking]
   * @returns {Promise<ChatResult>}
   */
  async _chatCompletions(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking) {
    const url = endpoint.replace(/\/+$/, "") + "/chat/completions";

    /** @type {Record<string, any>} */
    const body = {
      model: modelId,
      messages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    /** @type {Record<string, string>} */
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

    if (!response.body) {
      throw new ProviderError("Empty response body from API", response.status);
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
              let entry = toolCalls.get(idx);
              if (!entry) {
                entry = { id: "", name: "", arguments: "" };
                toolCalls.set(idx, entry);
              }
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

    /** @type {ChatResult} */
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
   * Convert chat-completions-style content (bare string or array of
   * {type:"text"|"image_url"} parts) into Responses API content.
   *
   * The Responses API rejects chat-completions part types ("text",
   * "image_url") — it only accepts item types such as "input_text",
   * "input_image" and "output_text". Bare strings are kept as-is (the
   * API accepts the string shorthand and that is what already works).
   *
   * @param {string | Array<ContentPart> | null | undefined} content
   * @param {"user" | "assistant"} role
   * @returns {string | Array<object>}
   */
  _convertResponsesContent(content, role) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content);

    const textType = role === "assistant" ? "output_text" : "input_text";
    /** @type {Array<object>} */
    const items = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text") {
        items.push({ type: textType, text: part.text || "" });
      } else if (part.type === "image_url") {
        const url = part.image_url?.url || "";
        if (url) {
          items.push({ type: "input_image", image_url: url });
        }
      } else {
        // Already Responses-shaped (input_text, input_image, ...) or
        // unknown — pass through untouched rather than guessing.
        items.push(part);
      }
    }
    return items;
  },

  /**
   * Send via /v1/responses (GPT-5.6+ reasoning models).
   * The Responses API supports reasoning + tools together natively.
   * @param {ChatMessage[]} messages
   * @param {string} modelId
   * @param {string} endpoint
   * @param {string} apiKey
   * @param {function(string): void} onPartial
   * @param {AbortSignal} [signal]
   * @param {Array<ToolDefinition>} [tools]
   * @param {function(string): void} [onThinking]
   * @param {string} [reasoningEffort]
   * @returns {Promise<ChatResult>}
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
        instructions += (instructions ? "\n" : "") + String(msg.content || "");
        continue;
      }

      if (msg.role === "user") {
        input.push({
          role: "user",
          content: this._convertResponsesContent(msg.content, "user"),
        });
        continue;
      }

      if (msg.role === "assistant") {
        // Emit the assistant message (text) before its function calls —
        // canonical order: the model speaks first, then invokes tools.
        if (msg.content) {
          const content = this._convertResponsesContent(msg.content, "assistant");
          if (Array.isArray(content)) {
            for (const item of content) {
              input.push(item);
            }
          } else {
            input.push({ role: "assistant", content });
          }
        }
        // If it also has tool_calls, emit function_call items after the text
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
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
    }

    // ── Build request ────────────────────

    /** @type {Record<string, any>} */
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

    /** @type {Record<string, string>} */
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
      // This path is only reached when reasoning is active, so a 400 here
      // often means the model doesn't support the Responses API / reasoning.
      // Hint the user accordingly (plain-text append, no protocol change).
      // "Off" only stops sending the reasoning parameter (and switches to
      // the standard chat endpoint) — the model may still reason internally.
      const hint =
        response.status === 400
          ? '\n\n — Hint: this request was sent with the reasoning parameter enabled. Setting the Reasoning effort to "Off" stops sending that parameter (the request then uses the standard chat endpoint), which may avoid this 400 if the model rejects the reasoning request format. Note: "Off" only skips the parameter — the model may still reason internally on its own.'
          : "";
      throw new ProviderError(
        `API error ${response.status}: ${response.statusText}${errText ? " — " + errText.slice(0, 500) : ""}${hint}`,
        response.status,
        errText
      );
    }

    if (!response.body) {
      throw new ProviderError("Empty response body from API", response.status);
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

    /** @type {ChatResult} */
    const result = fullText
      ? { text: fullText }
      : { text: "" };

    if (thinking) result.thinking = thinking;

    // Extract function_call items from outputItems
    const functionCalls = Array.from(outputItems.values())
      .filter((item) => item.type === "function_call" && item.call_id);

    if (functionCalls.length > 0) {
      result.toolCalls = functionCalls.map((item) => ({
        id: item.call_id || "",
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

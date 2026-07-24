const vscode = require("vscode");

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
   * @returns {Promise<{ text: string, thinking?: string, toolCalls?: Array }>}
   */
  async chat(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking) {
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

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new ProviderError(
        `API error ${response.status}: ${response.statusText}`,
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

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
 * Anthropic Messages API provider.
 * Supports streaming text, thinking/reasoning, and tool calls via SSE.
 *
 * Key differences vs OpenAI:
 * - Auth via x-api-key header (not Bearer)
 * - Requires anthropic-version header
 * - System prompt is a top-level field, not a message role
 * - Tool calls arrive as content_block_start + content_block_delta events
 * - Thinking tokens arrive as thinking_delta events
 */
const anthropicProvider = {
  id: "anthropic",
  displayName: "Anthropic",

  /**
   * Send a streaming chat request to the Anthropic Messages API.
   *
   * @param {ChatMessage[]} messages - Conversation (may include system-role messages)
   * @param {string} modelId - e.g. "claude-sonnet-4-20250514"
   * @param {string} endpoint - Base URL (e.g. https://api.anthropic.com)
   * @param {string} apiKey
   * @param {function(string): void} onPartial - Called with each text token chunk
   * @param {AbortSignal} [signal]
   * @param {Array<ToolDefinition>} [tools] - OpenAI-format tool definitions
   * @param {function(string): void} [onThinking] - Called with thinking/reasoning tokens
   * @returns {Promise<ChatResult>}
   */
  async chat(messages, modelId, endpoint, apiKey, onPartial, signal, tools, onThinking) {
    const url = endpoint.replace(/\/+$/, "") + "/messages";

    // ── 1. Extract system messages ──────────────────────────────
    // Anthropic uses a top-level "system" field instead of a message role.
    const systemMessages = messages.filter((m) => m.role === "system");
    const systemPrompt = systemMessages
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter(Boolean)
      .join("\n\n");

    // ── 2. Convert conversation messages (everything except system) ──
    const conversationMessages = messages
      .filter((m) => m.role !== "system")
      .map((m) => this._convertMessage(m));

    // ── 3. Build request body ───────────────────────────────────
    /** @type {Record<string, any>} */
    const body = {
      model: modelId,
      messages: conversationMessages,
      stream: true,
      max_tokens: 4096,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => this._convertTool(t));
      log.appendLine(
        "Anthropic: sending " + body.tools.length + " tools"
      );
    }

    // ── 4. Send request ─────────────────────────────────────────
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };

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

    if (!response.body) {
      throw new ProviderError("Empty response body from API", response.status);
    }

    // ── 5. Stream SSE events ────────────────────────────────────
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
        if (!data) continue;

        try {
          const event = JSON.parse(data);

          switch (event.type) {

            // Tool use block begins — capture id + name
            case "content_block_start": {
              const block = event.content_block;
              if (block.type === "tool_use") {
                toolCalls.set(event.index, {
                  id: block.id,
                  name: block.name,
                  arguments: "",
                });
              }
              break;
            }

            // Delta on the current content block
            case "content_block_delta": {
              const delta = event.delta;

              if (delta.type === "text_delta") {
                fullText += delta.text;
                onPartial(delta.text);
              } else if (delta.type === "thinking_delta" && onThinking) {
                thinking += delta.thinking;
                onThinking(delta.thinking);
              } else if (delta.type === "input_json_delta") {
                // Accumulate tool arguments across multiple deltas
                const entry = toolCalls.get(event.index);
                if (entry) {
                  entry.arguments += delta.partial_json;
                }
              }
              break;
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
        if (data) {
          try {
            const event = JSON.parse(data);
            if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (delta?.type === "text_delta") {
                fullText += delta.text;
                onPartial(delta.text);
              } else if (delta?.type === "thinking_delta" && onThinking) {
                thinking += delta.thinking;
                onThinking(delta.thinking);
              }
            }
          } catch {
            /* skip */
          }
        }
      }
    }

    // ── 6. Build result ─────────────────────────────────────────
    /** @type {ChatResult} */
    const result = fullText ? { text: fullText } : { text: "" };

    if (thinking) {
      result.thinking = thinking;
    }

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

  /**
   * Convert a single ChatMessage (OpenAI-style) to Anthropic message format.
   *
   * Handles:
   * - Plain text user/assistant messages
   * - User messages with images (content array with image_url blocks)
   * - Assistant messages with tool_calls
   * - Tool result messages
   *
   * @param {ChatMessage} msg
   * @returns {object} Anthropic-formatted message
   */
  _convertMessage(msg) {
    // ── User message with images (content is an array) ──
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const anthropicContent = msg.content
        .map((part) => {
          if (part.type === "text") {
            return { type: "text", text: part.text };
          }
          if (part.type === "image_url") {
            const dataUrl = part.image_url?.url || "";
            // Parse "data:<mime>;base64,<payload>"
            const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1],
                  data: match[2],
                },
              };
            }
            // URL-based images (not base64) — skip for now
            return null;
          }
          return null;
        })
        .filter(Boolean);
      return { role: "user", content: anthropicContent };
    }

    // ── Tool result message ──
    if (msg.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content || "",
          },
        ],
      };
    }

    // ── Assistant message with tool calls ──
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const content = [];
      // Include text content if present
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      // Append tool_use blocks
      for (const tc of msg.tool_calls) {
        let input;
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      return { role: "assistant", content };
    }

    // ── Plain text message ──
    return { role: msg.role, content: msg.content || "" };
  },

  /**
   * Convert an OpenAI tool definition to Anthropic tool format.
   *
   * OpenAI:  { type: "function", function: { name, description, parameters } }
   * Anthropic: { name, description, input_schema }
   *
   * @param {ToolDefinition} tool - OpenAI-format tool definition
   * @returns {object} Anthropic-format tool definition
   */
  _convertTool(tool) {
    return {
      name: tool.function.name,
      description: tool.function.description || "",
      input_schema: tool.function.parameters || {
        type: "object",
        properties: {},
      },
    };
  },
};

/**
 * Provider-level error with HTTP status.
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

module.exports = anthropicProvider;

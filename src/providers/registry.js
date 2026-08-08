const openaiProvider = require("./openai");
const anthropicProvider = require("./anthropic");

/**
 * @typedef {Object} ChatResult
 * @property {string} text
 * @property {string} [thinking]
 * @property {Array<{ id: string, function: { name: string, arguments: string } }>} [toolCalls]
 */

/**
 * @typedef {Object} Provider
 * @property {string} id
 * @property {string} displayName
 * @property {(messages: import('./openai').ChatMessage[], modelId: string, endpoint: string, apiKey: string, onPartial: (text: string) => void, signal?: AbortSignal, tools?: import('../tools/definitions').ToolDefinition[], onThinking?: (text: string) => void, reasoningEffort?: string) => Promise<ChatResult>} chat
 */

/**
 * Provider registry — maps provider type strings to provider objects.
 * Add new providers here as they are implemented.
 *
 * @type {Record<string, Provider>}
 */
const registry = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * Get a provider by its type string.
 * @param {string} type - "openai" | "anthropic" (Ollama works via the OpenAI-compatible endpoint)
 * @returns {Provider | undefined}
 */
function getProvider(type) {
  return registry[type];
}

module.exports = { getProvider };

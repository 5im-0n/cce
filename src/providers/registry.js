const openaiProvider = require("./openai");
const anthropicProvider = require("./anthropic");

/**
 * Provider registry — maps provider type strings to provider objects.
 * Add new providers here as they are implemented.
 *
 * @type {Record<string, import("./openai").default>}
 */
const registry = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * Get a provider by its type string.
 * @param {string} type - "openai" | "anthropic" | "ollama"
 * @returns {object | undefined}
 */
function getProvider(type) {
  return registry[type];
}

module.exports = { getProvider };

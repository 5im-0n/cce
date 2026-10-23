/** Common error surfaced by model providers. */
class ProviderError extends Error {
  /**
   * @param {string} message - User-facing error description.
   * @param {number} [status] - HTTP status, when available.
   * @param {string} [body] - API error response, when available.
   */
  constructor(message, status, body) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
    this.body = body;
  }
}

module.exports = ProviderError;

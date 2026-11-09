/**
 * Abort helpers shared by the chat controller and the sub-agent runner.
 *
 * Kept dependency-free so it can be unit-tested without pulling in `vscode`
 * and so both call sites agree on what "the request was cancelled" means.
 */

/**
 * Check whether an unknown thrown value represents request cancellation.
 * Supports both Error and DOMException abort values without assuming a shape
 * for arbitrary values thrown by providers or tools.
 *
 * @param {unknown} err
 * @returns {err is { name: string }}
 */
function isAbortError(err) {
  return typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";
}

module.exports = { isAbortError };

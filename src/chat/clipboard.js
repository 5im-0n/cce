/**
 * Clipboard handling for the chat transcript.
 *
 * Kept apart from the controller so the validation and redaction rules are
 * testable without `vscode`, and so every chat (sidebar or editor tab) goes
 * through exactly the same path. Never echoes clipboard text or raw platform
 * errors back to the UI.
 */

/** Maximum number of characters accepted in a single copy request. */
const MAX_COPY_LENGTH = 10 * 1024 * 1024;

/**
 * Validate a webview copy request and acknowledge only after the clipboard
 * write resolves.
 *
 * @param {{ requestId?: unknown, text?: unknown }} msg
 * @param {{ postMessage: (msg: any) => Promise<unknown> }} webview - The webview
 *   that asked; the acknowledgement must go back to it even if the chat's view
 *   was recreated in the meantime.
 * @param {(text: string) => Promise<unknown>} writeText - Clipboard writer.
 * @param {{ appendLine: (line: string) => void }} log
 * @returns {Promise<void>}
 */
async function handleCopyText(msg, webview, writeText, log) {
  if (typeof msg.requestId !== "string" || !/^copy-[a-z0-9-]{1,80}$/.test(msg.requestId)) return;
  let error;
  // Bound IPC payloads; empty/invalid requests must not clear the clipboard.
  if (typeof msg.text !== "string" || msg.text.length === 0 || msg.text.length > MAX_COPY_LENGTH) {
    error = "Nothing to copy, or the text exceeds the 10,485,760-character limit.";
  } else {
    try {
      await writeText(msg.text);
    } catch {
      log.appendLine("Clipboard write failed");
      error = "Could not write to the clipboard. Please try again.";
    }
  }
  try {
    await webview.postMessage({ type: "copyResult", requestId: msg.requestId, ok: !error, error });
  } catch {
    // The originating webview may have been disposed during the write.
    log.appendLine("Clipboard result could not be delivered to the webview");
  }
}

module.exports = { handleCopyText, MAX_COPY_LENGTH };

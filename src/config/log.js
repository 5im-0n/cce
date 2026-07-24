const vscode = require("vscode");

/** @type {vscode.OutputChannel} */
let _channel;

/**
 * Get the shared CCE output channel (creates on first call).
 * @returns {vscode.OutputChannel}
 */
function get() {
  if (!_channel) _channel = vscode.window.createOutputChannel("CCE");
  return _channel;
}

module.exports = { get };

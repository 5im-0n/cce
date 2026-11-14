const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Run the real error handler with observable UI operations. */
function handleError(message) {
  const html = fs.readFileSync(path.join(__dirname, "../webview-ui/chat.html"), "utf8");
  const start = '} else if (m.type === "error") {';
  const end = '} else if (m.type === "editAccepted") {';
  const source = html.slice(html.indexOf(start) + start.length, html.indexOf(end));
  const calls = [];
  const context = { m: message };
  for (const name of ["finalizeResponses", "closeStream", "hideThinking", "cancelPendingApprovalCards", "setBusy", "addMsg"]) {
    context[name] = (...args) => calls.push([name, ...args]);
  }
  vm.runInNewContext(`(function () {${source}})()`, context);
  return calls;
}

test("rejecting an overlapping send preserves the active stream, approvals and Stop button", () => {
  assert.deepEqual(handleError({ error: "Wait for the current response", turnRejected: true }), [
    ["addMsg", "error", "Error: Wait for the current response"],
  ]);
});

test("a real turn failure still finalizes the UI and clears busy", () => {
  assert.deepEqual(handleError({ error: "Provider failed" }), [
    ["finalizeResponses", false],
    ["closeStream"],
    ["hideThinking"],
    ["cancelPendingApprovalCards"],
    ["setBusy", false],
    ["addMsg", "error", "Error: Provider failed"],
  ]);
});

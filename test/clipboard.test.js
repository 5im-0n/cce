const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");

/** Load the real controller/message route with a stub VS Code clipboard and webview. */
function setup(writeText) {
  const filename = path.resolve(__dirname, "../src/extension.js");
  const localRequire = createRequire(filename);
  const posted = [];
  const logs = [];
  const stubs = {
    vscode: { env: { clipboard: { writeText } } },
    "./config/Settings": { getModels: () => [] },
    "./config/log": { get: () => ({ appendLine: line => logs.push(line) }) },
    "./config/ModelConfigPanel": {},
    "./providers/registry": {},
    "./tools/executor": {},
    "./mcp/processManager": {},
    "./mcp/client": {},
  };
  const sandbox = {
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
    module: { exports: {} },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nmodule.exports.Controller = ChatViewProvider;", sandbox, { filename });
  const chat = Object.create(sandbox.module.exports.Controller.prototype);
  chat._context = { extensionPath: path.resolve(__dirname, "..") };
  let listener;
  const webview = {
    postMessage: message => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: handler => { listener = handler; return { dispose() {} }; },
  };
  chat.resolveWebviewView({ webview });
  posted.length = 0;
  logs.length = 0;
  return { chat, webview, posted, logs, receive: message => listener(message) };
}

test("copyText route writes exact text and only acknowledges after clipboard resolution", async () => {
  let resolveWrite;
  const writes = [];
  const h = setup(text => {
    writes.push(text);
    return new Promise(resolve => { resolveWrite = resolve; });
  });
  const text = "## Response\n\n```js\n  a < b;\n```\n🧪\t";
  h.receive({ type: "copyText", requestId: "copy-one", text });
  assert.deepEqual(writes, [text]);
  assert.equal(h.posted.length, 0);
  // A recreated view must not receive the old request's acknowledgement.
  h.chat._view = { webview: { postMessage() { assert.fail("wrong webview"); } } };
  resolveWrite();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.posted[0].type, "copyResult");
  assert.equal(h.posted[0].requestId, "copy-one");
  assert.equal(h.posted[0].ok, true);
  assert.equal(JSON.stringify(h.posted).includes(text), false);
  assert.equal(h.logs.some(line => line.includes(text)), false);
});

test("clipboard failures are caught, sanitized and acknowledged as failures", async () => {
  for (const writeText of [
    async () => { throw new Error("private platform detail"); },
    () => { throw new Error("private platform detail"); },
  ]) {
    const h = setup(writeText);
    await h.chat._handleCopyText({ requestId: "copy-fail", text: "secret text" }, h.webview);
    assert.equal(h.posted[0].ok, false);
    assert.match(h.posted[0].error, /try again/);
    assert.doesNotMatch(JSON.stringify([h.posted, h.logs]), /private platform detail|secret text/);
  }
});

test("invalid IDs are ignored and invalid/empty/oversized text never clears the clipboard", async () => {
  const h = setup(() => { assert.fail("must not write"); });
  for (const requestId of [undefined, null, {}, "", "wrong", "copy-" + "x".repeat(81)]) {
    await h.chat._handleCopyText({ requestId, text: "text" }, h.webview);
  }
  assert.equal(h.posted.length, 0);
  for (const text of [undefined, null, 123, {}, "", "x".repeat(10 * 1024 * 1024 + 1)]) {
    await h.chat._handleCopyText({ requestId: "copy-invalid", text }, h.webview);
    assert.equal(h.posted.at(-1).ok, false);
  }
});

test("disposed webview delivery failures do not reject or repeat clipboard writes", async () => {
  let writes = 0;
  const h = setup(async () => { writes++; });
  h.webview.postMessage = async () => { throw new Error("disposed"); };
  await h.chat._handleCopyText({ requestId: "copy-disposed", text: "text" }, h.webview);
  assert.equal(writes, 1);
});

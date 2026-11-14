const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");

/**
 * Load the real chat controller with stubbed dependencies (VS Code, settings,
 * tools) so the clipboard route can be exercised as the webview sees it.
 *
 * @param {(text: string) => Promise<unknown>} writeText - Clipboard writer.
 */
function setup(writeText) {
  const filename = path.resolve(__dirname, "../src/chat/controller.js");
  const localRequire = createRequire(filename);
  const posted = [];
  const logs = [];

  const stubs = {
    vscode: { env: { clipboard: { writeText } } },
    "../config/Settings": {
      getModels: () => [],
      getDefaultModel: () => "",
      getReasoningEffort: () => "medium",
      getSessions: () => [],
      getCurrentSessionId: () => "",
      setCurrentSessionId: () => {},
      getToolApprovalModes: () => ({}),
      getMcpApprovalModes: () => ({}),
      getMcpServers: () => [],
      mutateSessions: async () => [],
    },
    "../config/sessionStore": {
      newSessionId: () => "session-1",
      withoutEmptySessions: (sessions) => sessions,
      titleFromConversation: () => "Chat",
      mutateSessions: async () => [],
    },
    "../config/log": { get: () => ({ appendLine: (line) => logs.push(line) }) },
    "../providers/registry": { getProvider: () => null },
    "../tools/definitions": { getEnabledDefinitions: () => [] },
    "../tools/executor": { executeToolCall: async () => "" },
    "../tools/shellInfo": { describeShellBrief: () => "" },
    "../mcp/client": { fetchMcpTools: async () => [], callMcpTool: async () => "" },
    "../context/compact": { planCompaction: () => ({ shouldCompact: false }) },
    "../context/estimate": {
      formatTokenCount: (n) => String(n),
      estimateTextTokens: () => 0,
      estimateMessageTokens: () => 0,
    },
    "../context/guard": {
      computeBudget: () => 0,
      pruneRounds: () => ({ droppedRounds: 0, overBudget: false, estimate: 0, freedTokens: 0 }),
      truncateToolResult: (text) => text,
      countToolCalls: () => ({}),
    },
    "../conversation/edit": { applyEdit: () => ({ ok: false }), lastUserMessageIndex: () => -1 },
    "./approvals": {
      createApprovalGate: () => ({
        request: async () => ({ decision: "allow", mode: "auto" }),
        handleResponse: () => {},
        rejectAll: () => {},
        resetSession: () => {},
        dispose: () => {},
      }),
    },
  };

  const sandbox = {
    require: (name) => (Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name)),
    module: { exports: {} },
    console,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nmodule.exports.createChatController = createChatController;", sandbox, { filename });

  const controller = sandbox.module.exports.createChatController({
    id: "test-chat",
    hooks: {
      canTakeSession: () => true,
      onSessionTaken: () => {},
      onSessionReleased: () => {},
      onSessionsChanged: () => {},
      onSessionDeleted: () => {},
      onTitleChanged: () => {},
      onMessage: () => {},
      activity: { start: () => {}, end: () => {}, warningsFor: () => [] },
    },
  });

  return { controller, posted, logs };
}

/**
 * @param {Array<any>} posted
 */
function webviewOf(posted) {
  return {
    postMessage: (message) => {
      posted.push(message);
      return Promise.resolve(true);
    },
  };
}

test("copyText route writes exact text and only acknowledges after clipboard resolution", async () => {
  let resolveWrite;
  const writes = [];
  const h = setup((text) => {
    writes.push(text);
    return new Promise((resolve) => { resolveWrite = resolve; });
  });
  const webviewPosts = [];
  const webview = webviewOf(webviewPosts);

  const text = "## Response\n\n```js\n  a < b;\n```\n🧪\t";
  h.controller.handleMessage({ type: "copyText", requestId: "copy-one", text }, webview);

  assert.deepEqual(writes, [text]);
  assert.equal(webviewPosts.length, 0);

  resolveWrite();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(webviewPosts[0].type, "copyResult");
  assert.equal(webviewPosts[0].requestId, "copy-one");
  assert.equal(webviewPosts[0].ok, true);
  // The acknowledgement must go to the asking webview, never to the chat sink.
  assert.equal(h.posted.some((m) => m.type === "copyResult"), false);
  assert.equal(JSON.stringify(h.posted).includes(text), false);
  assert.equal(h.logs.some((line) => line.includes(text)), false);
});

test("clipboard failures are caught, sanitized and acknowledged as failures", async () => {
  for (const writeText of [
    async () => { throw new Error("private platform detail"); },
    () => { throw new Error("private platform detail"); },
  ]) {
    const h = setup(writeText);
    const webviewPosts = [];
    await h.controller.handleMessage({ type: "copyText", requestId: "copy-fail", text: "secret text" }, webviewOf(webviewPosts));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(webviewPosts[0].ok, false);
    assert.match(webviewPosts[0].error, /try again/);
    assert.doesNotMatch(JSON.stringify([webviewPosts, h.logs]), /private platform detail|secret text/);
  }
});

test("invalid IDs are ignored and invalid/empty/oversized text never clears the clipboard", async () => {
  let writes = 0;
  const h = setup(async () => { writes++; });
  const webviewPosts = [];
  const webview = webviewOf(webviewPosts);

  for (const requestId of [undefined, null, {}, "", "wrong", "copy-" + "x".repeat(81)]) {
    await h.controller.handleMessage({ type: "copyText", requestId, text: "text" }, webview);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(webviewPosts.length, 0);
  assert.equal(writes, 0);

  for (const text of [undefined, null, 123, {}, "", "x".repeat(10 * 1024 * 1024 + 1)]) {
    await h.controller.handleMessage({ type: "copyText", requestId: "copy-invalid", text }, webview);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
  const results = webviewPosts.filter((m) => m.type === "copyResult");
  assert.equal(results.length, 6);
  assert.ok(results.every((m) => m.ok === false));
});

test("disposed webview delivery failures do not reject or repeat clipboard writes", async () => {
  let writes = 0;
  const h = setup(async () => { writes++; });
  const webview = {
    postMessage: async () => { throw new Error("disposed"); },
  };
  await h.controller.handleMessage({ type: "copyText", requestId: "copy-disposed", text: "text" }, webview);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);
});

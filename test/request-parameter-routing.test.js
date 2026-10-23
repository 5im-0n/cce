const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");

/** Load the internal chat controller with dependencies stubbed, without exporting it in production. */
function controller() {
  const filename = path.resolve(__dirname, "../src/extension.js");
  const localRequire = createRequire(filename);
  const stubs = {
    vscode: {},
    "./config/Settings": { getToolSettings: () => ({}) },
    "./config/log": { get: () => ({ appendLine() {} }) },
    "./config/ModelConfigPanel": {},
    "./providers/registry": {},
    "./tools/definitions": { getEnabledDefinitions: () => [] },
    "./tools/executor": { executeToolCall: async () => "tool result" },
    "./mcp/client": { fetchMcpTools: async () => [] },
    "./mcp/processManager": {},
  };
  const sandbox = {
    require: name => Object.hasOwn(stubs, name) ? stubs[name] : localRequire(name),
    module: { exports: {} }, AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\nmodule.exports.Controller = ChatViewProvider;", sandbox, { filename });
  const result = Object.create(sandbox.module.exports.Controller.prototype);
  result._view = null;
  result._abortController = null;
  result._reasoningEffort = "high";
  result._conversation = [];
  result._summary = null;
  result._summaryTurns = 0;
  result._summaryCoversUpTo = 0;
  result._saveSession = async () => {};
  result._requestApproval = async () => ({ decision: "deny" });
  return result;
}

const model = { modelId: "test", endpoint: "https://example.com", requestParameters: { provider: { quantizations: ["fp16", "bf16"] } } };

/** Verify the selected model's parameters and connection fields reach the provider. */
function checkArguments(args, effort) {
  assert.equal(args[1], model.modelId);
  assert.equal(args[2], model.endpoint);
  assert.equal(args[3], "key");
  assert.equal(args[8], effort);
  assert.equal(args[9], model.requestParameters);
}

test("main chat and recursive tool-loop sends both receive per-model parameters", async () => {
  const chat = controller();
  const requests = [];
  const provider = { chat: async (...args) => {
    checkArguments(args, "high");
    requests.push(JSON.parse(JSON.stringify(args[0])));
    if (requests.length === 1) return { text: "", toolCalls: [{ id: "call", function: { name: "read_file", arguments: "{}" } }] };
    return { text: "Finished" };
  } };
  await chat._chatLoop("message", [{ role: "user", content: "Read" }], model, "key", provider, []);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].length, 1);
  assert.equal(requests[1][2].role, "tool");
});

test("compaction passes parameters despite turning off generated reasoning", async () => {
  const chat = controller();
  chat._conversation = [{ role: "user", content: "Old" }];
  let called = false;
  const provider = { chat: async (...args) => {
    checkArguments(args, "off");
    assert.equal(args[6], undefined);
    assert.equal(args[7], undefined);
    called = true;
    return { text: "Summary" };
  } };
  await chat._compact({ compactRequest: [{ role: "user", content: "Summarize" }], old: chat._conversation }, model, "key", provider);
  assert.equal(called, true);
  assert.equal(chat._summary, "Summary");
});

test("every sub-agent round and final max-rounds summary receives parameters", async () => {
  const chat = controller();
  let calls = 0;
  const provider = { chat: async (...args) => {
    checkArguments(args, "high");
    calls++;
    if (calls <= 10) return { text: "", toolCalls: [{ id: "call" + calls, function: { name: "read_file", arguments: "{}" } }] };
    assert.equal(args[6], undefined);
    return { text: "Final summary" };
  } };
  const result = await chat._runAgent({ tasks: ["Read"] }, model, "key", provider);
  assert.equal(calls, 11);
  assert.match(result, /Final summary/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * Model and reasoning effort are remembered per chat (per session), while a
 * new chat starts from the global default. These tests drive the real
 * controller with stubbed storage to pin that behaviour, including the
 * fallbacks when a session's model was deleted or a chat restores the session
 * the workspace was last on.
 */

const ROOT = path.resolve(__dirname, "..");
const file = (rel) => path.join(ROOT, rel);

const MODELS = [
  { id: "m-one", name: "One", provider: "openai", modelId: "one", endpoint: "https://example.com" },
  { id: "m-two", name: "Two", provider: "openai", modelId: "two", endpoint: "https://example.com" },
  { id: "m-three", name: "Three", provider: "openai", modelId: "three", endpoint: "https://example.com" },
];

/** @type {Record<string, any>} resolved-path → module stub */
let stubs = {};
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === "vscode") return stubs.vscode || {};
  if (parent && parent.filename) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      resolved = null;
    }
    if (resolved && stubs[resolved]) return stubs[resolved];
  }
  return originalLoad(request, parent, isMain);
};

test.after(() => {
  Module._load = originalLoad;
});

/**
 * Build a controller over an in-memory session list.
 *
 * @param {Object} options
 * @param {Array<any>} [options.sessions] - Stored sessions.
 * @param {string} [options.currentSessionId] - Persisted "current session".
 * @param {string} [options.defaultModel] - Persisted global default model.
 * @param {string} [options.defaultEffort] - Persisted global reasoning effort.
 * @param {Array<any>} [options.models] - Configured models.
 * @param {{ sessionId?: string, restoreCurrent?: boolean, persistCurrent?: boolean }} [options.open]
 * @returns {{ controller: any, posted: Array<any>, writes: Array<any> }}
 */
function setup(options = {}) {
  const sessions = options.sessions || [];
  const models = options.models || MODELS;
  const posted = [];
  const writes = [];

  stubs = {
    vscode: { workspace: { workspaceFolders: undefined }, env: { clipboard: { writeText: async () => {} } } },
    [file("src/config/Settings.js")]: {
      getModels: () => models,
      getDefaultModel: () => (options.defaultModel !== undefined ? options.defaultModel : models[0].id),
      getReasoningEffort: () => (options.defaultEffort !== undefined ? options.defaultEffort : "medium"),
      setDefaultModel: () => {},
      setReasoningEffort: () => {},
      getApiKey: async () => "key",
      getSystemPrompt: () => "",
      getUseAgentsMd: () => false,
      getContextFlags: () => ({}),
      getToolSettings: () => ({}),
      getCompaction: () => ({ mode: "off", threshold: 300000, keepTurns: 10 }),
      getSessions: () => sessions,
      getCurrentSessionId: () => options.currentSessionId || "",
      setCurrentSessionId: () => {},
      mutateSessions: async (fn) => {
        // Apply the mutation to the in-memory store, like Settings does, so a
        // test can assert what a chat actually persisted.
        writes.push(fn);
        fn(sessions);
        return sessions;
      },
      getToolApprovalModes: () => ({}),
      getMcpApprovalModes: () => ({}),
      getMcpServers: () => [],
    },
    [file("src/config/log.js")]: { get: () => ({ appendLine() {} }) },
    [file("src/providers/registry.js")]: { getProvider: () => null },
    [file("src/tools/definitions.js")]: { getEnabledDefinitions: () => [] },
    [file("src/tools/executor.js")]: { executeToolCall: async () => "" },
    [file("src/tools/shellInfo.js")]: { describeShellBrief: () => "" },
    [file("src/mcp/client.js")]: { fetchMcpTools: async () => [], callMcpTool: async () => "" },
    [file("src/context/compact.js")]: { planCompaction: () => ({ shouldCompact: false }) },
    [file("src/context/estimate.js")]: {
      formatTokenCount: (n) => String(n),
      estimateTextTokens: () => 0,
      estimateMessageTokens: () => 0,
    },
    [file("src/context/guard.js")]: {
      computeBudget: () => 0,
      pruneRounds: () => ({ droppedRounds: 0, overBudget: false, estimate: 0, freedTokens: 0 }),
      truncateToolResult: (text) => text,
      countToolCalls: () => ({}),
    },
    [file("src/conversation/edit.js")]: { applyEdit: () => ({ ok: false }), lastUserMessageIndex: () => -1 },
    [file("src/chat/approvals.js")]: {
      createApprovalGate: () => ({
        request: async () => ({ decision: "allow", mode: "auto" }),
        handleResponse: () => {},
        rejectAll: () => {},
        resetSession: () => {},
        dispose: () => {},
      }),
    },
    [file("src/chat/agent.js")]: { runSubAgents: async () => "" },
  };

  const controllerPath = file("src/chat/controller.js");
  delete require.cache[controllerPath];
  const { createChatController } = require(controllerPath);

  const controller = createChatController({
    id: "test-chat",
    ...(options.open || {}),
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

  controller.attach((msg) => posted.push(msg));
  return { controller, posted, writes };
}

/** @param {Array<any>} posted */
function lastModelsMessage(posted) {
  const messages = posted.filter((m) => m.type === "modelsLoaded");
  return messages[messages.length - 1];
}

test("a fresh chat starts from the global default model and effort", () => {
  const { controller, posted } = setup({ defaultModel: "m-two", defaultEffort: "high" });
  assert.equal(controller.getModelId(), "m-two");
  assert.equal(controller.getReasoningEffort(), "high");
  const message = lastModelsMessage(posted);
  assert.equal(message.activeModel, "m-two");
  assert.equal(message.reasoningEffort, "high");
});

test("restoring a session restores the model and effort stored on it", () => {
  const { controller, posted } = setup({
    sessions: [{ id: "s1", title: "Old", messages: [{ role: "user", content: "hi" }], modelId: "m-two", reasoningEffort: "low" }],
    currentSessionId: "s1",
    defaultModel: "m-one",
    defaultEffort: "high",
    open: { restoreCurrent: true },
  });
  assert.equal(controller.getSessionId(), "s1");
  assert.equal(controller.getModelId(), "m-two");
  assert.equal(controller.getReasoningEffort(), "low");
  const message = lastModelsMessage(posted);
  assert.equal(message.activeModel, "m-two");
  assert.equal(message.reasoningEffort, "low");
});

test("switching to another session swaps in that session's model and effort", () => {
  const { controller, posted } = setup({
    sessions: [
      { id: "s1", messages: [{ role: "user", content: "a" }], modelId: "m-one", reasoningEffort: "off" },
      { id: "s2", messages: [{ role: "user", content: "b" }], modelId: "m-two", reasoningEffort: "max" },
    ],
    currentSessionId: "s1",
    open: { restoreCurrent: true },
  });
  assert.equal(controller.getModelId(), "m-one");

  controller.handleMessage({ type: "switchSession", sessionId: "s2" });
  assert.equal(controller.getSessionId(), "s2");
  assert.equal(controller.getModelId(), "m-two");
  assert.equal(lastModelsMessage(posted).activeModel, "m-two");
  assert.equal(lastModelsMessage(posted).reasoningEffort, "max");

  controller.handleMessage({ type: "switchSession", sessionId: "s1" });
  assert.equal(controller.getModelId(), "m-one");
  assert.equal(lastModelsMessage(posted).reasoningEffort, "off");
});

test("a session whose model was deleted falls back instead of keeping a dead id", () => {
  const { controller } = setup({
    sessions: [{ id: "s1", messages: [{ role: "user", content: "hi" }], modelId: "deleted-model" }],
    currentSessionId: "s1",
    defaultModel: "m-two",
    open: { restoreCurrent: true },
  });
  assert.equal(controller.getModelId(), "m-two");
});

test("picking a model in one chat persists only that chat's session", async () => {
  const sessions = [
    { id: "s1", messages: [{ role: "user", content: "a" }], modelId: "m-one" },
    { id: "s2", messages: [{ role: "user", content: "b" }], modelId: "m-two" },
  ];
  // Two chats over the same stored state, each restoring a different session.
  const first = setup({ sessions, currentSessionId: "s1", open: { restoreCurrent: true } });
  assert.equal(first.controller.getModelId(), "m-one");

  const second = setup({ sessions, currentSessionId: "s2", open: { restoreCurrent: true } });
  assert.equal(second.controller.getModelId(), "m-two");

  // The second chat picks another model: only its own session records it.
  second.controller.handleMessage({ type: "setModel", modelId: "m-three" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(second.controller.getModelId(), "m-three");
  assert.equal(sessions.find((s) => s.id === "s1").modelId, "m-one");
  assert.equal(sessions.find((s) => s.id === "s2").modelId, "m-three");
  // The other chat is not dragged along by the choice.
  assert.equal(first.controller.getModelId(), "m-one");
});

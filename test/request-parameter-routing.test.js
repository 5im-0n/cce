const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * Drive the real chat controller end-to-end with stubbed dependencies, so the
 * assertions cover the arguments the *provider* receives (per-model request
 * parameters, reasoning effort) rather than an internal method signature.
 *
 * Dependencies are stubbed by resolved absolute path with a Module._load hook,
 * which also intercepts the controller's transitive requires.
 */

const ROOT = path.resolve(__dirname, "..");
const file = (rel) => path.join(ROOT, rel);

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

const model = {
  id: "cfg",
  name: "Config",
  provider: "openai",
  modelId: "test",
  endpoint: "https://example.com",
  requestParameters: { provider: { quantizations: ["fp16", "bf16"] } },
};

/**
 * @param {Object} options
 * @param {any} options.provider - Fake provider whose `chat` records calls.
 * @param {any} [options.compaction] - Compaction settings.
 * @param {any} [options.plan] - Compaction plan returned by planCompaction.
 * @param {(options: any) => Promise<string>} [options.runAgent] - Host agent runner.
 */
function setupController(options) {
  const settings = {
    getModels: () => [model],
    getDefaultModel: () => model.id,
    getReasoningEffort: () => "high",
    getApiKey: async () => "key",
    getSystemPrompt: () => "",
    getUseAgentsMd: () => false,
    getContextFlags: () => ({ includeDate: false, includeOS: false, includeRegion: false }),
    getToolSettings: () => ({}),
    getCompaction: () => options.compaction || { mode: "off", threshold: 300000, keepTurns: 10 },
    getSessions: () => [],
    getCurrentSessionId: () => "",
    setCurrentSessionId: () => {},
    mutateSessions: async () => [],
    getToolApprovalModes: () => ({}),
    getMcpApprovalModes: () => ({}),
    getMcpServers: () => [],
  };

  stubs = {
    vscode: { workspace: { workspaceFolders: undefined }, window: { showWarningMessage: async () => undefined } },
    [file("src/config/Settings.js")]: settings,
    [file("src/config/log.js")]: { get: () => ({ appendLine() {} }) },
    [file("src/config/sessionStore.js")]: {
      newSessionId: () => "session-1",
      withoutEmptySessions: (sessions) => sessions,
      titleFromConversation: () => "Chat",
    },
    [file("src/providers/registry.js")]: { getProvider: () => options.provider },
    [file("src/tools/definitions.js")]: { getEnabledDefinitions: () => [] },
    [file("src/tools/executor.js")]: { executeToolCall: async () => "tool result" },
    [file("src/tools/shellInfo.js")]: { describeShellBrief: () => "" },
    [file("src/mcp/client.js")]: { fetchMcpTools: async () => [], callMcpTool: async () => "mcp result" },
    [file("src/mcp/processManager.js")]: { getRunningIds: () => [], isRunning: () => false },
    [file("src/context/compact.js")]: { planCompaction: () => options.plan || { shouldCompact: false } },
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
  };

  // Reload the controller so it picks up this test's stubs.
  const controllerPath = file("src/chat/controller.js");
  delete require.cache[controllerPath];
  const { createChatController } = require(controllerPath);

  const controller = createChatController({
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
      runAgent: options.runAgent
        ? (agentOptions) => options.runAgent(agentOptions)
        : undefined,
    },
  });

  return { controller };
}

/** Verify the selected model's parameters and connection fields reach the provider. */
function checkArguments(args, effort) {
  assert.equal(args[1], model.modelId);
  assert.equal(args[2], model.endpoint);
  assert.equal(args[3], "key");
  assert.equal(args[8], effort);
  assert.equal(args[9], model.requestParameters);
}

test.after(() => {
  Module._load = originalLoad;
});

test("main chat and recursive tool-loop sends both receive per-model parameters", async () => {
  const requests = [];
  const provider = {
    chat: async (...args) => {
      checkArguments(args, "high");
      requests.push(JSON.parse(JSON.stringify(args[0])));
      if (requests.length === 1) {
        return { text: "", toolCalls: [{ id: "call", function: { name: "read_file", arguments: "{}" } }] };
      }
      return { text: "Finished" };
    },
  };
  const { controller } = setupController({ provider });
  controller.handleMessage({ type: "sendMessage", messageId: "message", text: "Read" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  const toolMessage = requests[1].find((m) => m.role === "tool");
  assert.equal(toolMessage.content, "tool result");
});

test("compaction passes parameters despite turning off generated reasoning", async () => {
  let compactionCall = null;
  const provider = {
    chat: async (...args) => {
      if (compactionCall === null) {
        compactionCall = args;
        // Summarization turns generated reasoning off but still sends the
        // model's explicit request parameters.
        checkArguments(args, "off");
        assert.equal(args[6], undefined);
        assert.equal(args[7], undefined);
        return { text: "Summary" };
      }
      return { text: "Finished" };
    },
  };
  const { controller } = setupController({
    provider,
    compaction: { mode: "auto", threshold: 1000, keepTurns: 5 },
    plan: {
      shouldCompact: true,
      estimate: 2000,
      old: [{ role: "user", content: "Old" }],
      compactRequest: [{ role: "user", content: "Summarize" }],
    },
  });
  controller.handleMessage({ type: "sendMessage", messageId: "message", text: "Hello" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(compactionCall, "compaction provider call happened");
});

test("the agent tool delegates to the host instead of running sub-agents here", async () => {
  // Sub-agents are ordinary chats in their own tabs, owned by the manager: the
  // controller must not run them itself (there is only one implementation, and
  // it is the visible one). Their provider calls therefore carry the same
  // per-model parameters as any chat, which the tests above pin.
  let agentSpawned = false;
  /** @type {Array<Record<string, any>>} */
  const hostCalls = [];
  const provider = {
    chat: async (...args) => {
      checkArguments(args, "high");
      if (!agentSpawned) {
        agentSpawned = true;
        return {
          text: "",
          toolCalls: [{ id: "agent-call", function: { name: "agent", arguments: JSON.stringify({ tasks: ["Read A", "Read B"] }) } }],
        };
      }
      return { text: "Finished" };
    },
  };
  const { controller } = setupController({
    provider,
    runAgent: async (agentOptions) => {
      hostCalls.push(agentOptions);
      return "Agent 1 result:\nA";
    },
  });
  controller.handleMessage({ type: "sendMessage", messageId: "message", text: "Investigate" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hostCalls.length, 1, "the host owns the run");
  assert.deepEqual(hostCalls[0].tasks, ["Read A", "Read B"]);
  assert.equal(hostCalls[0].modelConfig, model);
  assert.equal(hostCalls[0].reasoningEffort, "high");
  assert.ok(hostCalls[0].signal, "the run is cancellable by the parent's Stop");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * The host is the single source of truth for "a request is in flight".
 *
 * The webview cannot infer it: a run started by the host (an agent tab) never
 * goes through the UI's own send path, so without an explicit `busyChanged`
 * message the composer would keep offering Send while the agent works — and
 * the Stop button would be unreachable. These tests drive the real controller
 * with stubbed storage and a controllable provider.
 */

const ROOT = path.resolve(__dirname, "..");
const file = (rel) => path.join(ROOT, rel);

const MODEL = { id: "m-one", name: "One", provider: "openai", modelId: "one", endpoint: "https://example.com" };

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

/** Let the controller's awaited chain (keys, MCP discovery, save) run. */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {Object} [options]
 * @param {(signal: AbortSignal | undefined) => Promise<{ text: string }>} [options.chat]
 * @param {boolean} [options.isAgent]
 */
function setup(options = {}) {
  const sessions = [];
  const provider = { chat: options.chat || (async () => ({ text: "done" })) };
  let selfStops = 0;

  stubs = {
    vscode: { workspace: { workspaceFolders: undefined }, env: { clipboard: { writeText: async () => {} } } },
    [file("src/config/Settings.js")]: {
      getModels: () => [MODEL],
      getDefaultModel: () => MODEL.id,
      getReasoningEffort: () => "medium",
      setDefaultModel: () => {},
      setReasoningEffort: () => {},
      getApiKey: async () => "key",
      getSystemPrompt: () => "",
      getUseAgentsMd: () => false,
      getContextFlags: () => ({ includeDate: false, includeOS: false, includeRegion: false }),
      getToolSettings: () => ({}),
      getCompaction: () => ({ mode: "off", threshold: 300000, keepTurns: 10 }),
      getSessions: () => sessions,
      getCurrentSessionId: () => "",
      setCurrentSessionId: () => {},
      mutateSessions: async (fn) => {
        fn(sessions);
        return sessions;
      },
      getToolApprovalModes: () => ({}),
      getMcpApprovalModes: () => ({}),
      getMcpServers: () => [],
    },
    [file("src/config/log.js")]: { get: () => ({ appendLine() {} }) },
    [file("src/providers/registry.js")]: { getProvider: () => provider },
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
  };

  const controllerPath = file("src/chat/controller.js");
  delete require.cache[controllerPath];
  const { createChatController } = require(controllerPath);

  const controller = createChatController({
    id: "tab-1",
    isAgent: options.isAgent === true,
    hooks: {
      canTakeSession: () => true,
      onSessionTaken: () => {},
      onSessionReleased: () => {},
      onSessionsChanged: () => {},
      onSessionDeleted: () => {},
      onTitleChanged: () => {},
      onMessage: () => {},
      activity: { start: () => {}, end: () => {}, warningsFor: () => [] },
      onSelfStop: options.isAgent ? () => { selfStops++; } : undefined,
    },
  });

  const posted = [];
  controller.attach((msg) => posted.push(msg));
  return { controller, posted, selfStops: () => selfStops };
}

/** @param {Array<any>} posted */
function busySequence(posted, from = 0) {
  return posted.slice(from).filter((m) => m.type === "busyChanged").map((m) => m.busy);
}

test("a send reports busy before the first token and idle when it settles", async () => {
  const { controller, posted } = setup();
  const before = posted.length;

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "hi" });
  await settle();

  // Stop must be reachable during the dead time before the first chunk, so the
  // busy notice cannot wait for streamed content.
  assert.deepEqual(busySequence(posted, before), [true, false]);
  assert.equal(controller.isBusy(), false);
});

test("a webview attached mid-request is told the chat is still busy", async () => {
  /** @type {AbortSignal | undefined} */
  let seen;
  // The provider signature is (messages, modelId, endpoint, apiKey, onChunk,
  // signal, …): hold the request open until the chat is cancelled.
  const { controller, posted } = setup({
    chat: (...args) => new Promise((resolve, reject) => {
      const signal = args[5];
      seen = signal;
      const onAbort = () => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal && signal.aborted) onAbort();
      else if (signal) signal.addEventListener("abort", onAbort, { once: true });
    }),
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "hi" });
  await settle();
  assert.equal(controller.isBusy(), true);
  assert.ok(seen, "the provider request is in flight");

  // The old webview went away (tab moved, sidebar re-resolved) and a new one
  // asks for the state. It must show Stop, not Send.
  const replay = [];
  controller.attach((msg) => replay.push(msg));
  assert.deepEqual(busySequence(replay), [true], "attach replays the busy state");

  const afterRequestState = [];
  controller.detach();
  controller.attach((msg) => afterRequestState.push(msg));
  controller.handleMessage({ type: "requestState" });
  // attach replays it once, then requestState again — the webview may miss the
  // first posts if they precede its script, and both say the same thing.
  assert.deepEqual(busySequence(afterRequestState), [true, true], "requestState replays the busy state");

  // Stop from the recreated webview settles the chat.
  controller.handleMessage({ type: "cancelMessage" });
  await settle();
  assert.equal(controller.isBusy(), false);
  assert.deepEqual(busySequence(afterRequestState), [true, true, false]);
  assert.equal(posted.filter((m) => m.type === "busyChanged" && m.busy).length, 1, "busy is posted once per run");
});

test("an agent tab forwards its own Stop to the host that started the run", () => {
  const { controller, selfStops } = setup({ isAgent: true });

  controller.handleMessage({ type: "cancelMessage" });

  assert.equal(selfStops(), 1, "the manager is asked to cancel the run");
});

test("an ordinary chat does not report a self-stop", () => {
  const { controller, selfStops } = setup();

  controller.handleMessage({ type: "cancelMessage" });

  assert.equal(selfStops(), 0, "only agent tabs own a run to cancel");
});

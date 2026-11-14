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

/** Create a controllable promise for holding startup at an exact await. */
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * @param {Object} [options]
 * @param {import("../src/providers/registry").Provider["chat"]} [options.chat]
 * @param {boolean} [options.isAgent]
 * @param {() => Promise<string>} [options.getApiKey]
 * @param {() => Promise<Array<any>>} [options.fetchMcpTools]
 * @param {() => string} [options.getSystemPrompt]
 * @param {() => { mode: string, threshold: number, keepTurns: number }} [options.getCompaction]
 * @param {(options: any) => any} [options.planCompaction]
 * @param {(...args: any[]) => Promise<string | undefined>} [options.showWarningMessage]
 * @param {() => Promise<void>} [options.beforeSave]
 */
function setup(options = {}) {
  const sessions = [];
  const provider = { chat: options.chat || (async () => ({ text: "done" })) };
  let selfStops = 0;

  stubs = {
    vscode: {
      workspace: { workspaceFolders: undefined },
      env: { clipboard: { writeText: async () => {} } },
      window: { showWarningMessage: options.showWarningMessage || (async () => "Send anyway") },
    },
    [file("src/config/Settings.js")]: {
      getModels: () => [MODEL],
      getDefaultModel: () => MODEL.id,
      getReasoningEffort: () => "medium",
      setDefaultModel: () => {},
      setReasoningEffort: () => {},
      getApiKey: options.getApiKey || (async () => "key"),
      getSystemPrompt: options.getSystemPrompt || (() => ""),
      getUseAgentsMd: () => false,
      getContextFlags: () => ({ includeDate: false, includeOS: false, includeRegion: false }),
      getToolSettings: () => ({}),
      getCompaction: options.getCompaction || (() => ({ mode: "off", threshold: 300000, keepTurns: 10 })),
      getSessions: () => sessions,
      getCurrentSessionId: () => "",
      setCurrentSessionId: () => {},
      mutateSessions: async (fn) => {
        if (options.beforeSave) await options.beforeSave();
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
    [file("src/mcp/client.js")]: {
      fetchMcpTools: options.fetchMcpTools || (async () => []),
      callMcpTool: async () => "",
    },
    [file("src/context/compact.js")]: {
      planCompaction: options.planCompaction || (() => ({ shouldCompact: false })),
    },
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

// Exercise both entry points while startup is suspended, not just while the
// provider is already running. Rejected sends must never own the turn's finally.
for (const stage of ["getApiKey", "fetchMcpTools"]) {
  for (const startedBy of ["ordinary", "agent"]) {
    for (const finish of ["Stop", "complete"]) {
      test(`${startedBy} send held at ${stage}: overlapping sends cannot steal the turn (${finish})`, async (t) => {
        const startup = deferred();
        const startupCalls = [];
        const providerCalls = [];
        const startupValue = stage === "getApiKey" ? "key" : [];
        const { controller, posted } = setup({
          isAgent: startedBy === "agent",
          getApiKey: async () => {
            startupCalls.push("getApiKey");
            return stage === "getApiKey" ? startup.promise : "key";
          },
          fetchMcpTools: async () => {
            startupCalls.push("fetchMcpTools");
            return stage === "fetchMcpTools" ? startup.promise : [];
          },
          chat: async (messages, modelId, endpoint, apiKey, onChunk, signal) => {
            providerCalls.push({ messages, signal });
            return { text: "done" };
          },
        });
        const before = posted.length;
        const firstId = startedBy === "agent" ? "agent-progress" : "m1";
        const firstTurn = startedBy === "agent"
          ? controller.runAgentTask({ task: "first request" })
          : controller.handleMessage({ type: "sendMessage", messageId: firstId, text: "first request" });
        t.after(async () => {
          controller.abortAll();
          startup.resolve(startupValue);
          await firstTurn;
          await settle();
          controller.dispose();
        });

        // No microtask or discovery result is needed to make Stop reachable.
        assert.equal(controller.isBusy(), true);
        assert.deepEqual(busySequence(posted, before), [true]);
        await settle();
        const expectedStartup = stage === "getApiKey" ? ["getApiKey"] : ["getApiKey", "fetchMcpTools"];
        assert.deepEqual(startupCalls, expectedStartup, "the selected startup await is still pending");
        assert.equal(providerCalls.length, 0);

        controller.handleMessage({ type: "sendMessage", messageId: "m2", text: "overlapping user request" });
        const rejectedSignal = new AbortController();
        const rejected = await controller.runAgentTask({
          task: "overlapping agent request",
          signal: rejectedSignal.signal,
        });
        assert.equal(rejected.ok, false);
        assert.equal(rejected.aborted, false);
        assert.equal(rejected.text, "");
        assert.match(rejected.error, /Wait for the current response/);
        const userError = posted.find((m) => m.type === "error" && m.messageId === "m2");
        assert.ok(userError, "the ordinary overlap is explicitly rejected too");
        assert.match(userError.error, /Wait for the current response/);
        assert.equal(userError.turnRejected, true, "the UI must preserve the active turn");

        // The rejected agent's signal must not become the active cancellation
        // source. In the complete case the original turn must still succeed.
        rejectedSignal.abort();
        await settle();
        assert.equal(controller.isBusy(), true);
        assert.deepEqual(startupCalls, expectedStartup, "overlaps never enter startup");
        assert.deepEqual(busySequence(posted, before), [true], "rejection never posts idle");

        if (finish === "Stop") {
          controller.handleMessage({ type: "cancelMessage" });
          controller.handleMessage({ type: "sendMessage", messageId: "m3", text: "send while unwinding" });
          const lateError = posted.find((m) => m.type === "error" && m.messageId === "m3");
          assert.ok(lateError, "Stop retains ownership until startup unwinds");
          assert.match(lateError.error, /Wait for the current response/);
          assert.equal(controller.isBusy(), true);
          assert.deepEqual(busySequence(posted, before), [true]);
        }

        startup.resolve(startupValue);
        const outcome = await firstTurn;
        await settle();
        assert.equal(controller.isBusy(), false);
        assert.deepEqual(busySequence(posted, before), [true, false], "only the original turn releases busy");
        if (startedBy === "agent") {
          assert.equal(outcome.ok, finish === "complete");
          assert.equal(outcome.aborted, finish === "Stop");
          assert.equal(outcome.error, null);
        }
        assert.equal(providerCalls.length, finish === "Stop" ? 0 : 1, "Stop prevents the provider from starting");
        if (finish === "complete") {
          assert.ok(providerCalls[0].signal);
          assert.equal(providerCalls[0].signal.aborted, false, "a rejected agent cannot cancel the accepted request");
          assert.deepEqual(providerCalls[0].messages.filter((m) => m.role === "user"), [
            { role: "user", content: "first request" },
          ]);
        }
        assert.ok(posted.some((m) => m.type === "responseComplete" && m.messageId === firstId));
        assert.deepEqual(
          posted.filter((m) => m.type === "error").map((m) => m.messageId),
          finish === "Stop" ? ["m2", "agent-progress", "m3"] : ["m2", "agent-progress"],
          "the accepted request is not reported as an error"
        );

        // Read the host's transcript only after checking busy transitions:
        // requestState deliberately posts another busyChanged replay.
        controller.handleMessage({ type: "requestState" });
        const history = posted.filter((m) => m.type === "historyRestored").at(-1).messages;
        assert.deepEqual(
          history.filter((m) => m.role === "user").map((m) => ({ id: m.id, content: m.content })),
          finish === "Stop" && stage === "getApiKey" ? [] : [{ id: firstId, content: "first request" }],
          "neither overlapping send appends a user message"
        );
      });
    }
  }
}

for (const stage of ["getApiKey", "fetchMcpTools"]) {
  test(`external cancellation during ${stage} stops an agent before the provider`, async (t) => {
    const startup = deferred();
    const external = new AbortController();
    let providerCalls = 0;
    let startupCalls = 0;
    const value = stage === "getApiKey" ? "key" : [];
    const { controller, posted } = setup({
      [stage]: () => {
        startupCalls++;
        return startup.promise;
      },
      chat: async () => {
        providerCalls++;
        return { text: "unexpected" };
      },
    });
    const before = posted.length;
    const turn = controller.runAgentTask({ task: "cancel at startup", signal: external.signal });
    t.after(async () => {
      controller.abortAll();
      startup.resolve(value);
      await turn;
      controller.dispose();
    });

    assert.equal(controller.isBusy(), true);
    assert.deepEqual(busySequence(posted, before), [true]);
    await settle();
    assert.equal(startupCalls, 1);
    external.abort();
    assert.equal(controller.isBusy(), true, "the cancelled startup still owns its turn");
    assert.deepEqual(busySequence(posted, before), [true]);
    startup.resolve(value);

    assert.deepEqual(await turn, { ok: false, aborted: true, error: null, text: "" });
    assert.equal(providerCalls, 0);
    assert.equal(controller.isBusy(), false);
    assert.deepEqual(busySequence(posted, before), [true, false]);
  });
}

for (const failure of [
  { name: "API key rejection", hook: "getApiKey", async: true, recover: () => Promise.resolve("key") },
  { name: "system prompt throw", hook: "getSystemPrompt", recover: () => "" },
  {
    name: "compaction settings throw",
    hook: "getCompaction",
    recover: () => ({ mode: "off", threshold: 300000, keepTurns: 10 }),
  },
  {
    name: "compaction planning throw",
    hook: "planCompaction",
    options: { getCompaction: () => ({ mode: "auto", threshold: 300000, keepTurns: 10 }) },
    recover: () => ({ shouldCompact: false }),
  },
  {
    name: "compaction prompt rejection",
    hook: "showWarningMessage",
    async: true,
    options: {
      getCompaction: () => ({ mode: "ask", threshold: 300000, keepTurns: 10 }),
      planCompaction: () => ({
        shouldCompact: true,
        estimate: 300001,
        old: [{ role: "user", content: "older turn" }],
        keep: [],
        compactRequest: [],
      }),
    },
    recover: () => Promise.resolve("Send anyway"),
  },
]) {
  test(`${failure.name} releases busy and allows the next send`, async (t) => {
    const error = new Error(failure.name);
    let attempts = 0;
    let providerCalls = 0;
    const { controller, posted } = setup({
      ...failure.options,
      [failure.hook]: () => {
        attempts++;
        if (attempts > 1) return failure.recover();
        if (failure.async) return Promise.reject(error);
        throw error;
      },
      chat: async () => {
        providerCalls++;
        return { text: "recovered" };
      },
    });
    t.after(() => controller.dispose());
    const before = posted.length;

    // Use the webview path so ask-mode compaction actually shows its prompt;
    // agents intentionally skip that prompt. Any escaped rejection fails test.
    controller.handleMessage({ type: "sendMessage", messageId: "failed", text: "first attempt" });
    assert.equal(controller.isBusy(), true);
    assert.deepEqual(busySequence(posted, before), [true]);
    await settle();
    assert.equal(attempts, 1, "the intended failure path was reached");
    assert.equal(providerCalls, 0, "startup failed before the provider");
    assert.equal(controller.isBusy(), false);
    assert.deepEqual(busySequence(posted, before), [true, false]);
    assert.deepEqual(posted.filter((m) => m.type === "error"), [
      { type: "error", messageId: "failed", error: failure.name },
    ]);

    controller.handleMessage({ type: "sendMessage", messageId: "retry", text: "try again" });
    assert.equal(controller.isBusy(), true);
    assert.deepEqual(busySequence(posted, before), [true, false, true]);
    await settle();
    assert.equal(attempts, 2);
    assert.equal(providerCalls, 1, "the next send is accepted after startup fails");
    assert.equal(controller.getLastAssistantResponse(), "recovered");
    assert.equal(controller.isBusy(), false);
    assert.deepEqual(busySequence(posted, before), [true, false, true, false]);
    assert.ok(posted.some((m) => m.type === "responseComplete" && m.messageId === "retry"));
    assert.equal(posted.filter((m) => m.type === "error").length, 1);
  });
}

test("Stop during edit persistence still replays the committed history", async (t) => {
  const saving = deferred();
  let holdSave = false;
  let calls = 0;
  const { controller, posted } = setup({
    beforeSave: async () => { if (holdSave) await saving.promise; },
    chat: async () => { calls++; return { text: "original answer" }; },
  });
  t.after(() => { saving.resolve(); controller.dispose(); });
  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "original prompt" });
  await settle();
  holdSave = true;
  const before = posted.length;
  controller.handleMessage({ type: "sendMessage", messageId: "edited", editingId: "m1", text: "edited prompt" });
  await settle();
  assert.equal(controller.isBusy(), true);
  controller.handleMessage({ type: "cancelMessage" });
  saving.resolve();
  await settle();
  const history = posted.slice(before).find((m) => m.type === "historyRestored");
  assert.ok(history, "the cancelled regeneration still displays the committed edit");
  assert.deepEqual(history.messages, [{ role: "user", id: "m1", content: "edited prompt", images: [] }]);
  assert.equal(calls, 1, "Stop prevents regeneration");
  assert.equal(controller.isBusy(), false);
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

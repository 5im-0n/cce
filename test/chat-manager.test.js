const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { getEventListeners } = require("node:events");

/**
 * Chat manager orchestration, with VS Code and the controller stubbed.
 *
 * The manager is what makes several chats coexist: it routes commands, keeps
 * one chat per session, reveals an existing tab instead of duplicating a
 * conversation, and tears a tab down completely when it closes. These tests
 * pin that behaviour without a real webview — the controller itself is covered
 * by chat-sessions.test.js and chat-model-choice.test.js.
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

test.after(() => {
  Module._load = originalLoad;
});

/**
 * Build a manager over stubbed storage and a stubbed controller.
 *
 * @param {Object} [options]
 * @param {Array<any>} [options.sessions] - Sessions the store knows about.
 * @param {(sessionId: string) => boolean} [options.openSessionFails] -
 *   Force `openSession` to fail, simulating a session deleted in between.
 * @param {(options: any) => Promise<any>} [options.agentTaskRunner] - Resolves
 *   to a TurnOutcome (or a string, treated as a completed turn with that text).
 * @param {boolean} [options.autoCloseAgents] - The `AutoCloseAgents` setting.
 * @param {number} [options.maxAgents] - Global agent capacity.
 * @param {(config: any) => void} [options.onCreateController] - Controller setup hook.
 * @param {() => void} [options.onCreatePanel] - Panel setup hook.
 * @param {(agent: { cancel: () => void }) => void} [options.onRegisterOwnedAgent] - Registration hook.
 */
function setup(options = {}) {
  const sessions = options.sessions || [];
  const openSessionFails = options.openSessionFails || (() => false);
  const agentTaskRunner = options.agentTaskRunner || (async () => "fake result");
  const autoCloseAgents = options.autoCloseAgents === true;
  let maxAgents = options.maxAgents || 3;
  const panels = [];
  const revealed = [];
  const warnings = [];
  /** @type {Map<string, any>} */
  const controllers = new Map();
  /** @type {{ deserializeWebviewPanel: (panel: any, state: any) => Promise<void> } | null} */
  let serializer = null;

  stubs = {
    vscode: {
      window: {
        registerWebviewPanelSerializer: (viewType, nextSerializer) => {
          assert.equal(viewType, "cceChat");
          serializer = nextSerializer;
          return { dispose() {} };
        },
        createWebviewPanel: (viewType, title, column, panelOptions) => {
          if (options.onCreatePanel) options.onCreatePanel();
          const panel = {
            viewType,
            title,
            column,
            panelOptions,
            disposed: false,
            posts: [],
            /** @type {((msg: any) => void) | null} */
            receiver: null,
            webview: {
              html: "",
              options: {},
              onDidReceiveMessage: (handler) => {
                panel.receiver = handler;
                return {
                  dispose: () => {
                    panel.receiver = null;
                  },
                };
              },
              postMessage: async (msg) => {
                panel.posts.push(msg);
                return true;
              },
            },
            onDidDispose(handler) {
              panel._onDispose = handler;
              return { dispose() {} };
            },
            dispose() {
              if (panel.disposed) return;
              panel.disposed = true;
              if (panel._onDispose) panel._onDispose();
            },
            reveal() {
              revealed.push({ kind: "panel", id: panel.title });
            },
          };
          panels.push(panel);
          return panel;
        },
        showWarningMessage: async (message) => {
          warnings.push(message);
        },
        showErrorMessage: async () => {},
      },
      commands: {
        executeCommand: async () => {},
      },
      Uri: { joinPath: () => ({ path: "icon" }) },
      ViewColumn: { Beside: -2 },
      workspace: { workspaceFolders: undefined },
    },
    [file("src/config/Settings.js")]: {
      getSessions: () => sessions,
      getDefaultModel: () => "m-one",
      getModels: () => [{ id: "m-one", name: "One" }],
      getReasoningEffort: () => "medium",
      setDefaultModel: () => {},
      setReasoningEffort: () => {},
      getCurrentSessionId: () => "",
      setCurrentSessionId: () => {},
      getMaxSimultaneousAgents: () => maxAgents,
      getAutoCloseAgents: () => autoCloseAgents,
      getToolApprovalModes: () => ({}),
      getMcpApprovalModes: () => ({}),
      getMcpServers: () => [],
      mutateSessions: async (fn) => {
        fn(sessions);
        return sessions;
      },
    },
    [file("src/config/log.js")]: { get: () => ({ appendLine() {} }) },
    [file("src/config/ModelConfigPanel.js")]: {
      addListener: () => () => {},
      addSessionListener: () => () => {},
      createOrShow: () => {},
    },
    [file("src/config/sessionStore.js")]: {
      withoutEmptySessions: (list) => list.filter((s) => s.messages && s.messages.length > 0),
    },
    [file("src/chat/controller.js")]: {
      createChatController: (config) => {
        if (options.onCreateController) options.onCreateController(config);
        const ownedAgents = new Set();
        const state = {
          id: config.id,
          sessionId: config.sessionId || null,
          title: "Chat",
          disposed: false,
          saved: 0,
          abortCalls: 0,
          pendingApprovals: 0,
          ownedAgents,
          sink: null,
        };
        if (config.sessionId) config.hooks.onSessionTaken(config.sessionId);
        const emit = (msg) => {
          if (state.sink) state.sink(msg);
        };
        const controller = {
          id: config.id,
          state,
          // Mirrors the real controller: attach replays the state, and opening
          // or clearing a session notifies the webview.
          attach: (sink) => {
            state.sink = sink;
            emit({ type: "modelsLoaded", models: [], activeModel: null });
            emit({ type: "sessionsLoaded", sessions: [], currentSessionId: state.sessionId || "" });
            if (state.sessionId) emit({ type: "sessionSwitched", sessionId: state.sessionId });
          },
          detach: () => {
            state.sink = null;
          },
          handleMessage: (msg) => {
            // Mirrors the real controller: only an agent tab forwards its own
            // Stop to the host, and the host owns the run's signal.
            if (msg && msg.type === "cancelMessage" && config.hooks.onSelfStop) config.hooks.onSelfStop();
          },
          onAgentCapacityChanged: () => {},
          registerOwnedAgent: (agent) => {
            if (options.onRegisterOwnedAgent) options.onRegisterOwnedAgent(agent);
            ownedAgents.add(agent);
            return () => { ownedAgents.delete(agent); };
          },
          // Mirrors the real controller: resolves to a TurnOutcome. A string
          // runner result is shorthand for a completed turn with that text.
          runAgentTask: async (agentOptions) => {
            controller.state.task = agentOptions.task;
            controller.state.agentRunning = true;
            let outcome;
            try {
              outcome = await agentTaskRunner(agentOptions);
            } finally {
              controller.state.agentRunning = false;
            }
            if (typeof outcome === "string") {
              controller.state.answer = outcome;
              return { ok: true, aborted: false, error: null, text: outcome };
            }
            if (outcome && typeof outcome.text === "string") controller.state.answer = outcome.text;
            return outcome;
          },
          getLastAssistantResponse: () => state.answer || "",
          postModels: () => emit({ type: "modelsLoaded", models: [], activeModel: null }),
          postSessions: () => emit({ type: "sessionsLoaded", sessions: [], currentSessionId: state.sessionId || "" }),
          abortAll: () => {
            state.abortCalls++;
            // The real parent aborts its request signal BEFORE cancelling owned
            // agents. Signal propagation alone does not deny child approvals.
            if (state.requestAbortController) state.requestAbortController.abort();
            state.pendingApprovals = 0;
            for (const agent of ownedAgents) agent.cancel();
            if (config.hooks.abortOwnedAgents) config.hooks.abortOwnedAgents();
          },
          forgetSession: () => {},
          isBusy: () => false,
          getTitle: () => state.title,
          getSessionId: () => state.sessionId,
          saveSession: async () => {
            state.saved++;
          },
          dispose: () => {
            state.disposed = true;
          },
          openSession: (sessionId) => {
            if (openSessionFails(sessionId)) return false;
            state.sessionId = sessionId;
            config.hooks.onSessionTaken(sessionId);
            emit({ type: "sessionSwitched", sessionId });
            return true;
          },
        };
        controllers.set(config.id, controller);
        return controller;
      },
    },
  };

  const managerPath = file("src/chat/manager.js");
  // Drop the manager and its chat modules so each test gets this setup's
  // stubs (the module cache would otherwise keep the first setup's closures).
  for (const rel of ["src/chat/manager.js", "src/chat/controller.js", "src/chat/view.js", "src/chat/activity.js", "src/chat/ownership.js", "src/chat/panel-state.js"]) {
    delete require.cache[file(rel)];
  }
  const { createChatManager } = require(managerPath);
  const manager = createChatManager({ extensionUri: { path: ROOT }, extensionPath: ROOT });

  return { manager, panels, revealed, warnings, sessions, controllers, serializer: () => serializer };
}

/**
 * A `vscode.WebviewView` double for the sidebar provider.
 * @returns {any}
 */
function sidebarWebviewView() {
  const listeners = [];
  return {
    webview: {
      html: "",
      options: {},
      postMessage: async () => true,
      onDidReceiveMessage: (handler) => {
        listeners.push(handler);
        return { dispose: () => listeners.splice(listeners.indexOf(handler), 1) };
      },
    },
    onDidDispose: () => ({ dispose() {} }),
  };
}

test("the sidebar chat is created once and reused", () => {
  const { manager, controllers } = setup();
  const provider = manager.registerSidebar();
  const view = sidebarWebviewView();
  provider.resolveWebviewView(view);
  provider.resolveWebviewView(view);

  // The provider is stateless: re-resolving the view must serve the same chat
  // rather than creating a second one.
  assert.deepEqual(Array.from(controllers.keys()), ["sidebar"]);
  assert.ok(view.webview.html.length > 0, "the chat document is rendered");
});

test("visible sub-agents reserve the configured capacity and return results", async () => {
  let finishTask;
  const taskResult = new Promise((resolve) => { finishTask = resolve; });
  const { manager, panels } = setup({ maxAgents: 1, agentTaskRunner: () => taskResult });
  manager.getSidebarChat();

  const run = manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["inspect A", "inspect B"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(panels.length, 1, "only the available slot starts an agent tab");
  assert.deepEqual(manager.getAgentCapacity(), { maximum: 1, available: 0 });
  finishTask("analysis complete");
  const result = await run;
  assert.match(result, /Agent 1 result:\nanalysis complete/);
  assert.match(result, /1 of 2 sub-agents did not finish/);
  assert.match(result, /agent 2 was not started/);
  assert.deepEqual(manager.getAgentCapacity(), { maximum: 1, available: 1 });
});

test("stopping an agent from its own tab keeps the tab and reports it as stopped", async () => {
  /** @type {AbortSignal | undefined} */
  let seen;
  const { manager, panels, controllers } = setup({
    maxAgents: 2,
    autoCloseAgents: true,
    // Mirrors the real controller: an aborted turn resolves with `aborted`,
    // carrying whatever the agent had produced so far.
    agentTaskRunner: (agentOptions) => new Promise((resolve) => {
      seen = agentOptions.signal;
      const onAbort = () => resolve({ ok: false, aborted: true, error: null, text: "partial findings" });
      if (agentOptions.signal.aborted) onAbort();
      else agentOptions.signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  manager.getSidebarChat();

  const run = manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["inspect A"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(panels.length, 1, "the agent got its own tab");
  assert.deepEqual(manager.getAgentCapacity(), { maximum: 2, available: 1 });

  // The user presses Stop inside the agent tab.
  controllers.get("tab-1").handleMessage({ type: "cancelMessage" });

  const result = await run;
  assert.ok(seen.aborted, "the run the manager owns was aborted");
  assert.match(result, /stopped before it finished/);
  assert.match(result, /partial findings/, "the parent gets what the agent had produced");
  assert.doesNotMatch(result, /failed/, "a stop is not reported as a failure");
  assert.equal(panels[0].disposed, false, "the tab stays open so its transcript can be read");
  assert.deepEqual(manager.getAgentCapacity(), { maximum: 2, available: 2 }, "the slot is freed");
});

test("closing an agent tab mid-run reports a stop, not a finished result", async () => {
  const { manager, panels } = setup({
    maxAgents: 2,
    autoCloseAgents: true,
    agentTaskRunner: (agentOptions) => new Promise((resolve) => {
      const onAbort = () => resolve({ ok: false, aborted: true, error: null, text: "half done" });
      if (agentOptions.signal.aborted) onAbort();
      else agentOptions.signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  manager.getSidebarChat();

  const run = manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["inspect A"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
  });
  await new Promise((resolve) => setImmediate(resolve));

  // The user closes the stuck agent's tab instead of pressing Stop.
  panels[0].dispose();

  const result = await run;
  assert.match(result, /closed its tab/, "the parent is told why it stopped");
  assert.match(result, /half done/);
  assert.doesNotMatch(result, /^Agent 1 result:/m, "the interrupted work is not reported as a result");
});

test("stopping the parent still cancels and closes its agent tabs", async () => {
  const { manager, panels, controllers } = setup({
    maxAgents: 2,
    agentTaskRunner: (agentOptions) => new Promise((resolve) => {
      const onAbort = () => resolve({ ok: false, aborted: true, error: null, text: "" });
      if (agentOptions.signal.aborted) onAbort();
      else agentOptions.signal.addEventListener("abort", onAbort, { once: true });
    }),
  });
  manager.getSidebarChat();

  const run = manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["inspect A"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
  });
  await new Promise((resolve) => setImmediate(resolve));

  // Stop in the parent tab: its agents are torn down with it.
  controllers.get("sidebar").abortAll();
  const result = await run;

  assert.equal(panels[0].disposed, true, "the agent tab is closed with the request that spawned it");
  assert.match(result, /stopped before it finished/);
  assert.match(result, /parent request was stopped/);
});

/** Build ordinary visible-agent options for manager lifecycle regressions. */
function agentRunOptions(overrides = {}) {
  return {
    parentChatId: "sidebar",
    tasks: ["inspect A"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
    ...overrides,
  };
}

/** A job that ignores cancellation until the test explicitly settles it. */
function deferredJob() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

test("parent signal aborts first but owned-agent cancellation still cleans approvals and closes the tab", async () => {
  const job = deferredJob();
  let childSignal;
  const { manager, panels, controllers } = setup({
    maxAgents: 1,
    agentTaskRunner: ({ signal }) => {
      childSignal = signal;
      return job.promise;
    },
  });
  const parent = manager.getSidebarChat();
  parent.state.requestAbortController = new AbortController();
  const run = manager.runVisibleAgents(agentRunOptions({ signal: parent.state.requestAbortController.signal }));
  const child = controllers.get("tab-1");
  child.state.pendingApprovals = 1;

  // This mirrors handleCancel: first abort the request (and hence the child's
  // signal), then invoke registered cancellations and the manager hook.
  parent.abortAll();
  assert.equal(childSignal.aborted, true);
  assert.ok(child.state.abortCalls > 0, "an already-aborted signal must not skip abortAll");
  assert.equal(child.state.pendingApprovals, 0, "pending approval is denied");
  assert.equal(panels[0].disposed, true, "parent cancellation still closes the tab");
  const abortCalls = child.state.abortCalls;
  parent.abortAll();
  assert.equal(child.state.abortCalls, abortCalls, "repeated cancellation does not repeat cleanup");
  assert.equal(child.state.saved, 1, "tab closure is not repeated");

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.state.disposed, true);
  assert.equal(manager.getAgentCapacity().available, 0, "abort/closure does not settle the job");
  assert.equal(parent.state.ownedAgents.size, 1, "retain cancellation ownership until settlement");
  job.resolve("late result");
  assert.match(await run, /parent request was stopped/);
  assert.equal(parent.state.ownedAgents.size, 0);
  assert.equal(manager.getAgentCapacity().available, 1);
});

test("agent Stop is idempotent and a later parent Stop can still close its tab", async () => {
  const job = deferredJob();
  const { manager, panels, controllers } = setup({ maxAgents: 1, agentTaskRunner: () => job.promise });
  const parent = manager.getSidebarChat();
  const run = manager.runVisibleAgents(agentRunOptions());
  const child = controllers.get("tab-1");
  child.state.pendingApprovals = 1;

  child.handleMessage({ type: "cancelMessage" });
  child.handleMessage({ type: "cancelMessage" });
  assert.equal(child.state.abortCalls, 1);
  assert.equal(child.state.pendingApprovals, 0);
  assert.equal(panels[0].disposed, false, "local Stop keeps the transcript");
  parent.abortAll();
  assert.equal(panels[0].disposed, true, "parent Stop may escalate to tab closure");
  const abortCalls = child.state.abortCalls;
  parent.abortAll();
  assert.equal(child.state.abortCalls, abortCalls);
  assert.equal(child.state.saved, 1);
  job.resolve("late result");
  assert.match(await run, /the user stopped it/, "keep the first cancellation reason");
  assert.equal(manager.getAgentCapacity().available, 1);
});

for (const closeParent of [false, true]) {
  for (const rejects of [false, true]) {
    test(`closing the ${closeParent ? "parent" : "agent"} tab retains capacity until the job ${rejects ? "rejects" : "resolves"}`, async () => {
      const job = deferredJob();
      const { manager, panels, controllers } = setup({ maxAgents: 1, agentTaskRunner: () => job.promise });
      manager.getSidebarChat();
      await manager.openChatTab();
      const run = manager.runVisibleAgents(agentRunOptions({ parentChatId: "tab-1" }));
      assert.equal(panels.length, 2);
      assert.equal(manager.getAgentCapacity().available, 0);

      panels[closeParent ? 0 : 1].dispose();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(controllers.get("tab-2").state.disposed, true, "agent is removed from open chats");
      assert.equal(manager.getAgentCapacity().available, 0, "unsettled work still consumes its slot");
      const denied = await manager.runVisibleAgents(agentRunOptions());
      assert.match(denied, /No agents spawned: all 1 simultaneous-agent slot is in use/);
      assert.equal(panels.length, 2, "another parent cannot bypass the occupied slot");

      if (rejects) job.reject(new Error("late failure"));
      else job.resolve("late result");
      assert.match(await run, /stopped before it finished/);
      assert.equal(manager.getAgentCapacity().available, 1);
      await manager.runVisibleAgents(agentRunOptions());
      assert.equal(panels.length, 3, "a new job can start only after settlement");
      assert.equal(manager.getAgentCapacity().available, 1);
    });
  }
}

test("all accepted slots are reserved before controller setup and concurrent parent calls", async () => {
  const jobs = [deferredJob(), deferredJob()];
  let manager;
  let competingRun;
  let setups = 0;
  let started = 0;
  const env = setup({
    maxAgents: 2,
    onCreateController: (config) => {
      if (!config.isAgent) return;
      assert.equal(manager.getAgentCapacity().available, 0, "the entire batch was reserved before construction");
      if (setups++ === 0) competingRun = manager.runVisibleAgents(agentRunOptions({ parentChatId: "tab-1" }));
    },
    agentTaskRunner: () => jobs[started++].promise,
  });
  manager = env.manager;
  manager.getSidebarChat();
  await manager.openChatTab();
  const run = manager.runVisibleAgents(agentRunOptions({ tasks: ["A", "B"] }));
  assert.match(await competingRun, /No agents spawned/);
  assert.equal(started, 2);
  assert.equal(env.panels.length, 3);
  jobs[0].resolve("first result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getAgentCapacity().available, 1, "each job releases independently of its sibling");
  jobs[1].resolve("second result");
  await run;
  assert.equal(manager.getAgentCapacity().available, 2);
});

for (const failure of ["controller", "registration", "panel"]) {
  test(`${failure} setup failure releases only its reservation and does not lose a running sibling`, async () => {
    const job = deferredJob();
    let failOnce = true;
    const fail = () => {
      if (!failOnce) return;
      failOnce = false;
      throw new Error(failure + " setup failed");
    };
    const { manager, panels, controllers } = setup({
      maxAgents: 2,
      onCreateController: (config) => { if (config.isAgent && failure === "controller") fail(); },
      onRegisterOwnedAgent: () => { if (failure === "registration") fail(); },
      onCreatePanel: () => { if (failure === "panel") fail(); },
      agentTaskRunner: () => job.promise,
    });
    const parent = manager.getSidebarChat();
    const signal = new AbortController().signal;
    const run = manager.runVisibleAgents(agentRunOptions({ tasks: ["fails setup", "keeps running"], signal }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(manager.getAgentCapacity().available, 1);
    assert.equal(panels.length, 1);
    assert.equal(parent.state.ownedAgents.size, 1, "only the live sibling stays registered");
    if (failure !== "controller") assert.equal(controllers.get("tab-1").state.disposed, true);
    assert.equal(getEventListeners(signal, "abort").length, 1);

    job.resolve("sibling result");
    const result = await run;
    assert.match(result, new RegExp(failure + " setup failed"));
    assert.match(result, /Agent 2 result:\nsibling result/);
    assert.equal(manager.getAgentCapacity().available, 2);
    assert.equal(parent.state.ownedAgents.size, 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    await manager.runVisibleAgents(agentRunOptions({ tasks: ["retry A", "retry B"] }));
    assert.equal(panels.length, 3, "all failed-setup capacity can be reused");
  });
}

test("cancellation during registration releases skipped jobs and removes their listeners", async () => {
  const parentAbort = new AbortController();
  let started = 0;
  const { manager, panels, controllers } = setup({
    maxAgents: 2,
    onRegisterOwnedAgent: () => parentAbort.abort(),
    agentTaskRunner: async () => { started++; return "unexpected"; },
  });
  const parent = manager.getSidebarChat();
  const result = await manager.runVisibleAgents(agentRunOptions({ tasks: ["A", "B"], signal: parentAbort.signal }));
  assert.match(result, /2 of 2 sub-agents did not finish/);
  assert.equal(started, 0);
  assert.equal(panels.length, 0);
  assert.equal(controllers.get("tab-1").state.disposed, true);
  assert.equal(parent.state.ownedAgents.size, 0);
  assert.equal(getEventListeners(parentAbort.signal, "abort").length, 0);
  assert.equal(manager.getAgentCapacity().available, 2);
});

test("closing a parent during panel setup releases cancelled reservations without starting work", async () => {
  const parentAbort = new AbortController();
  let manager;
  let parentPanel;
  let panelsCreated = 0;
  let started = 0;
  const env = setup({
    maxAgents: 2,
    onCreatePanel: () => {
      if (++panelsCreated !== 2) return;
      parentPanel.dispose();
      assert.equal(manager.getAgentCapacity().available, 0, "closing a parent does not discard reserved slots");
    },
    agentTaskRunner: async () => { started++; return "unexpected"; },
  });
  manager = env.manager;
  await manager.openChatTab();
  env.controllers.get("tab-1").state.requestAbortController = parentAbort;
  parentPanel = env.panels[0];
  const result = await manager.runVisibleAgents(agentRunOptions({
    parentChatId: "tab-1", tasks: ["A", "B"], signal: parentAbort.signal,
  }));
  assert.match(result, /2 of 2 sub-agents did not finish/);
  assert.equal(started, 0);
  assert.equal(env.panels.length, 2, "the second cancelled task never opens a panel");
  assert.ok(env.panels.every((panel) => panel.disposed), "the panel created during cancellation is also closed");
  assert.equal(env.controllers.get("tab-1").state.ownedAgents.size, 0);
  assert.equal(getEventListeners(parentAbort.signal, "abort").length, 0);
  assert.equal(manager.getAgentCapacity().available, 2);
});

test("a cancelled parent leaves no agent tab behind", async () => {
  const { manager, panels } = setup({ maxAgents: 2 });
  manager.getSidebarChat();
  const controller = new AbortController();
  controller.abort();

  const result = await manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["inspect A", "inspect B"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
    signal: controller.signal,
  });

  assert.equal(panels.length, 0, "no tab is opened for a run that never started");
  assert.match(result, /2 of 2 sub-agents did not finish/);
  assert.match(result, /parent request was cancelled/);
  assert.deepEqual(manager.getAgentCapacity(), { maximum: 2, available: 2 }, "no slot is leaked");
});

test("a failing agent says so, and its siblings still report their results", async () => {
  const { manager } = setup({
    maxAgents: 3,
    agentTaskRunner: async (agentOptions) => {
      if (agentOptions.task === "boom") throw new Error("429 rate limit");
      return "found it";
    },
  });
  manager.getSidebarChat();

  const result = await manager.runVisibleAgents({
    parentChatId: "sidebar",
    tasks: ["good", "boom", "also good"],
    modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
    apiKey: "",
    provider: {},
    reasoningEffort: "medium",
  });

  assert.match(result, /1 of 3 sub-agents did not finish: agent 2 failed \(429 rate limit\)/);
  assert.match(result, /Agent 1 result:\nfound it/, "a sibling's result is not lost");
  assert.match(result, /Agent 3 result:\nfound it/);
  assert.match(result, /Agent 2 output \(incomplete\)/);
});

test("a malformed tasks argument is answered, not thrown into the tool loop", async () => {
  const { manager, panels } = setup();
  manager.getSidebarChat();

  for (const tasks of ["inspect A", 42, null, [], ["", "   "]]) {
    const result = await manager.runVisibleAgents({
      parentChatId: "sidebar",
      tasks,
      modelConfig: { id: "m-one", modelId: "model-one", endpoint: "https://example.invalid" },
      apiKey: "",
      provider: {},
      reasoningEffort: "medium",
    });
    assert.match(result, /must be a non-empty array/, "tasks=" + JSON.stringify(tasks));
  }
  assert.equal(panels.length, 0);
});

test("each call opens another independent chat tab", async () => {
  const { manager, panels } = setup();
  await manager.openChatTab();
  await manager.openChatTab();

  assert.equal(panels.length, 2);
  assert.equal(panels[0].viewType, "cceChat");
  assert.notEqual(panels[0], panels[1]);
});

test("opening a session another tab shows reveals that tab instead of duplicating it", async () => {
  const { manager, panels, revealed } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");
  assert.equal(panels.length, 1);

  await manager.openChatTab("s1");
  assert.equal(panels.length, 1, "no second view of the same conversation");
  assert.equal(revealed.length, 1, "the existing tab is brought to the front");
});

test("opening a session that no longer exists warns and opens nothing", async () => {
  const { manager, panels, warnings } = setup({ sessions: [] });
  await manager.openChatTab("gone");
  assert.equal(panels.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no longer exists/);
});

test("a session that disappears between the check and the open closes the new tab", async () => {
  const { manager, panels, warnings, controllers } = setup({
    sessions: [{ id: "s1", title: "T", messages: [{ role: "user", content: "a" }] }],
    openSessionFails: () => true,
  });

  await manager.openChatTab("s1");

  assert.equal(panels.length, 1, "the tab is created…");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no longer available/);
  // Closing the panel runs the normal teardown: the controller is dropped.
  assert.equal(controllers.get("tab-1").state.disposed, true);
});

test("closing a tab aborts, saves and releases its session", async () => {
  const { manager, panels, controllers } = setup({
    sessions: [{ id: "s1", title: "T", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");
  const controller = controllers.get("tab-1");
  assert.equal(controller.state.sessionId, "s1");

  // The user clicks the tab's close button.
  panels[0].dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.state.saved, 1, "the transcript is persisted");
  assert.equal(controller.state.disposed, true);

  // The session is free again: opening it in a new tab does not reveal the
  // closed one.
  await manager.openChatTab("s1");
  assert.equal(panels.length, 2, "a fresh tab opens instead of a reveal");
  assert.equal(panels[1].disposed, false);
});

test("shutdown saves every open chat before disposing it", async () => {
  const { manager, controllers, panels } = setup({
    sessions: [{ id: "s1", title: "T", messages: [{ role: "user", content: "a" }] }],
  });
  manager.registerSidebar().resolveWebviewView(sidebarWebviewView(panels));
  await manager.openChatTab("s1");

  await manager.shutdown();

  for (const controller of controllers.values()) {
    assert.equal(controller.state.saved, 1, controller.state.id + " was saved");
    assert.equal(controller.state.disposed, true, controller.state.id + " was disposed");
  }
});

// ── restored tabs (window reload) ──

/**
 * A panel double handed to the serializer, as VS Code does after a reload.
 * @returns {any}
 */
function restoredPanel() {
  const panel = {
    viewType: "cceChat",
    title: "CCE: Chat",
    disposed: false,
    posts: [],
    /** @type {((msg: any) => void) | null} */
    receiver: null,
    webview: {
      html: "",
      options: {},
      onDidReceiveMessage: (handler) => {
        panel.receiver = handler;
        return { dispose: () => { panel.receiver = null; } };
      },
      postMessage: async (msg) => {
        panel.posts.push(msg);
        return true;
      },
    },
    onDidDispose(handler) {
      panel._onDispose = handler;
      return { dispose() {} };
    },
    dispose() {
      if (panel.disposed) return;
      panel.disposed = true;
      if (panel._onDispose) panel._onDispose();
    },
    reveal() {},
  };
  return panel;
}

test("a restored tab reopens the session its webview saved", async () => {
  const { manager, controllers, serializer } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  manager.registerPanelSerializer();
  const panel = restoredPanel();

  await serializer().deserializeWebviewPanel(panel, { sessionId: "s1" });

  const controller = controllers.get("tab-1");
  assert.equal(controller.state.sessionId, "s1", "the conversation comes back");
  assert.equal(controller.state.sink !== null, true, "the restored panel is wired to it");
  assert.ok(panel.webview.html.length > 0, "the restored panel renders the chat");
});

test("the serializer is registered for the chat view type", () => {
  const { manager, serializer } = setup();
  manager.registerPanelSerializer();
  assert.ok(serializer(), "registerWebviewPanelSerializer was called with cceChat");
});

test("a stale or malformed panel state restores a fresh chat instead of failing", async () => {
  const { manager, controllers, serializer } = setup({ sessions: [] });
  manager.registerPanelSerializer();

  for (const state of [undefined, null, {}, { sessionId: 42 }, "s1"]) {
    const panel = restoredPanel();
    await serializer().deserializeWebviewPanel(panel, state);
    assert.ok(panel.webview.html.length > 0, "the tab comes back for state " + JSON.stringify(state));
  }
  for (const controller of controllers.values()) {
    assert.equal(controller.state.sessionId, null, "no conversation is invented");
  }
});

test("a restored tab whose session was deleted comes back empty", async () => {
  const { manager, controllers, serializer } = setup({ sessions: [] });
  manager.registerPanelSerializer();

  await serializer().deserializeWebviewPanel(restoredPanel(), { sessionId: "gone" });

  assert.equal(controllers.get("tab-1").state.sessionId, null);
});

test("restoring a tab for a session another chat already shows does not fork it", async () => {
  const { manager, controllers, serializer } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");
  assert.equal(controllers.get("tab-1").state.sessionId, "s1");

  manager.registerPanelSerializer();
  await serializer().deserializeWebviewPanel(restoredPanel(), { sessionId: "s1" });

  // A second view of the same transcript would diverge silently, so the
  // restored tab opens as a fresh chat instead.
  assert.equal(controllers.get("tab-2").state.sessionId, null);
});

test("closing a restored tab runs the normal teardown", async () => {
  const { manager, controllers, serializer } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  manager.registerPanelSerializer();
  const panel = restoredPanel();
  await serializer().deserializeWebviewPanel(panel, { sessionId: "s1" });

  panel.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  const controller = controllers.get("tab-1");
  assert.equal(controller.state.saved, 1, "the transcript is persisted");
  assert.equal(controller.state.disposed, true);
});

// ── panel state fed back to the webview ──

/** Panel-state posts a panel received, in order. */
const statesOf = (panel) => panel.posts.filter((m) => m.type === "persistPanelState");

test("a tab opened on a session tells its webview to remember that session", async () => {
  const { manager, panels } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");

  // The panel was built empty and then opened the session, so the state moves
  // from null to s1 rather than repeating.
  assert.deepEqual(
    statesOf(panels[0]).map((m) => m.sessionId),
    [null, "s1"]
  );
});

test("a fresh tab reports a null session so the reload restores an empty chat", async () => {
  const { manager, panels } = setup();
  await manager.openChatTab();

  assert.deepEqual(
    statesOf(panels[0]).map((m) => m.sessionId),
    [null]
  );
});

test("the panel state is posted once per change, not once per message", async () => {
  const { manager, panels } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");
  const before = statesOf(panels[0]).length;

  // Session list refreshes are broadcast on every save; they must not each
  // re-post the same state.
  manager.broadcastSessions();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(statesOf(panels[0]).length, before);
});

test("the webview can ask for the panel state again when its script starts", async () => {
  const { manager, panels } = setup({
    sessions: [{ id: "s1", title: "Login", messages: [{ role: "user", content: "a" }] }],
  });
  await manager.openChatTab("s1");
  panels[0].posts.length = 0;

  // `attach`'s replay can precede the document load, so the webview asks once
  // more — and must get the state even though nothing changed.
  panels[0].receiver({ type: "requestState" });

  assert.deepEqual(statesOf(panels[0]), [{ type: "persistPanelState", sessionId: "s1" }]);
});

test("the sidebar chat is not asked to persist panel state", () => {
  const { manager } = setup();
  const view = sidebarWebviewView();
  const posts = [];
  view.webview.postMessage = async (msg) => {
    posts.push(msg);
    return true;
  };
  manager.registerSidebar().resolveWebviewView(view);

  assert.equal(posts.some((m) => m.type === "persistPanelState"), false);
});

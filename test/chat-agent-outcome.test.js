const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * What a chat tells the host when a turn ends.
 *
 * `handleSendMessage` used to swallow failures into `postError` and resolve to
 * nothing, so the manager could not tell a real answer from a crash — an agent
 * whose provider returned a 429 reached its parent as "(no output)", reading
 * like a finished, empty answer. These tests drive the real controller and pin
 * the outcome it returns.
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
async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {Object} [options]
 * @param {(signal: AbortSignal | undefined) => Promise<any>} [options.chat]
 * @param {boolean} [options.isAgent]
 * @param {boolean} [options.overBudget] - The loop guard reports over budget.
 * @param {"ask"|"auto"|"off"} [options.compactionMode]
 */
function setup(options = {}) {
  const sessions = [];
  const provider = { chat: options.chat || (async () => ({ text: "done" })) };
  /** @type {Array<Record<string, boolean>>} */
  const toolSettingsSeen = [];
  const warnings = [];

  stubs = {
    vscode: {
      workspace: { workspaceFolders: undefined },
      env: { clipboard: { writeText: async () => {} } },
      window: { showWarningMessage: async (...args) => { warnings.push(args[0]); return "Compact"; } },
    },
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
      getToolSettings: () => ({ agent: true, read_file: true }),
      getCompaction: () => ({ mode: options.compactionMode || "off", threshold: 1000, keepTurns: 5 }),
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
    [file("src/tools/definitions.js")]: {
      getEnabledDefinitions: (settings) => {
        toolSettingsSeen.push({ ...settings });
        return [];
      },
    },
    [file("src/tools/executor.js")]: { executeToolCall: async () => "" },
    [file("src/tools/shellInfo.js")]: { describeShellBrief: () => "" },
    [file("src/mcp/client.js")]: { fetchMcpTools: async () => [], callMcpTool: async () => "" },
    [file("src/context/compact.js")]: {
      planCompaction: () => ({
        shouldCompact: Boolean(options.compactionMode && options.compactionMode !== "off"),
        estimate: 2000,
        old: [{ role: "user", content: "Old" }],
        compactRequest: [{ role: "user", content: "Summarize" }],
      }),
    },
    [file("src/context/estimate.js")]: {
      formatTokenCount: (n) => String(n),
      estimateTextTokens: () => 0,
      estimateMessageTokens: () => 0,
    },
    [file("src/context/guard.js")]: {
      computeBudget: () => 1000,
      pruneRounds: () => ({
        droppedRounds: 0,
        overBudget: options.overBudget === true,
        estimate: options.overBudget === true ? 5000 : 0,
        freedTokens: 0,
      }),
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
    },
  });

  const posted = [];
  controller.attach((msg) => posted.push(msg));
  return { controller, posted, toolSettingsSeen, warnings };
}

test("a finished turn reports ok with the streamed answer", async () => {
  const { controller } = setup({
    chat: async (...args) => {
      args[4]("Hello ");
      args[4]("world");
      return { text: "Hello world" };
    },
  });

  const outcome = await controller.runAgentTask({ task: "say hello" });

  assert.deepEqual(
    { ok: outcome.ok, aborted: outcome.aborted, error: outcome.error, text: outcome.text },
    { ok: true, aborted: false, error: null, text: "Hello world" }
  );
});

test("a provider failure is an error outcome, not an empty answer", async () => {
  const { controller, posted } = setup({
    chat: async () => {
      throw new Error("429 rate limit");
    },
  });

  const outcome = await controller.runAgentTask({ task: "do work" });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, false);
  assert.match(outcome.error, /429 rate limit/);
  assert.equal(outcome.text, "", "nothing was produced");
  // The tab still shows the failure to whoever is looking at it.
  assert.ok(posted.some((m) => m.type === "error"), "the agent's own tab shows the error");
});

test("a cancelled run reports the partial work it produced", async () => {
  const { controller } = setup({
    chat: (...args) => new Promise((resolve, reject) => {
      args[4]("partial findings");
      const signal = args[5];
      const onAbort = () => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal && signal.aborted) onAbort();
      else if (signal) signal.addEventListener("abort", onAbort, { once: true });
    }),
  });

  const run = controller.runAgentTask({ task: "do work" });
  await settle();
  controller.handleMessage({ type: "cancelMessage" });
  const outcome = await run;

  assert.equal(outcome.aborted, true);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, null, "a stop is not an error");
  assert.equal(outcome.text, "partial findings", "the parent can report what was found");
});

test("a context-budget stop is reported as a stop, not a failure", async () => {
  const { controller } = setup({ overBudget: true });

  const outcome = await controller.runAgentTask({ task: "survey the repo" });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.error, null, "hitting the budget is not an error");
  assert.equal(outcome.stopReason, "budget");
  assert.match(outcome.text, /Context budget reached/);
});

test("agent mode ends with the run: an adopted tab gets the agent tool back", async () => {
  const { controller, toolSettingsSeen } = setup();

  await controller.runAgentTask({ task: "do work" });
  assert.equal(toolSettingsSeen[0].agent, false, "an agent cannot spawn sub-agents while it runs");

  // The user keeps the tab and types into it.
  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "now you do it" });
  await settle();

  assert.equal(toolSettingsSeen[toolSettingsSeen.length - 1].agent, true, "an ordinary chat can spawn agents");
});

test("an agent run compacts without asking, so it cannot hang on a prompt", async () => {
  const { controller, warnings } = setup({ isAgent: true, compactionMode: "ask" });

  await controller.runAgentTask({ task: "do work" });

  assert.equal(warnings.length, 0, "nobody is watching an agent tab, so nothing is asked");
});

test("an ordinary chat still asks before compacting in ask mode", async () => {
  const { controller, warnings } = setup({ compactionMode: "ask" });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "hello" });
  await settle();

  assert.equal(warnings.length, 1, "the user is asked");
});

test("an agent run refuses to spawn sub-agents, and says why", async () => {
  /** @type {Array<Array<any>>} */
  const requests = [];
  let rounds = 0;
  const { controller } = setup({
    isAgent: true,
    chat: async (...args) => {
      requests.push(args[0]);
      rounds++;
      if (rounds === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", function: { name: "agent", arguments: JSON.stringify({ tasks: ["nested"] }) } }],
        };
      }
      return { text: "no nesting" };
    },
  });

  const outcome = await controller.runAgentTask({ task: "do work" });
  await settle();

  assert.equal(outcome.ok, true);
  const toolMessage = requests[requests.length - 1].find((m) => m.role === "tool");
  assert.match(String(toolMessage.content), /cannot recursively spawn sub-agents/);
});

test("the outcome of a real run maps onto the report the parent model reads", async () => {
  const { formatAgentReport } = require("../src/chat/agent-run");
  const failing = setup({
    chat: async () => {
      throw new Error("502 bad gateway");
    },
  });
  const working = setup();

  const failed = await failing.controller.runAgentTask({ task: "a" });
  const ok = await working.controller.runAgentTask({ task: "b" });

  const report = formatAgentReport([
    { index: 0, outcome: failed.ok ? "ok" : "error", reason: failed.error || "", text: failed.text },
    { index: 1, outcome: ok.ok ? "ok" : "error", text: ok.text },
  ]);
  assert.match(report, /1 of 2 sub-agents did not finish: agent 1 failed \(502 bad gateway\)/);
  assert.match(report, /Agent 2 result:\ndone/);
});

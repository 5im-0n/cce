const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const { truncateToolResult } = require("../src/context/guard");

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
 * @param {string} [options.toolResult] - Result returned by built-in and MCP tool stubs.
 * @param {boolean} [options.overBudget] - The loop guard reports over budget.
 * @param {"ask"|"auto"|"off"} [options.compactionMode]
 * @param {() => Promise<string>} [options.callMcpTool]
 * @param {(name: string) => Promise<string>} [options.executeToolCall]
 * @param {boolean} [options.realApprovals] - Exercise the real pending approval gate.
 * @param {() => Promise<string>} [options.showWarningMessage]
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
      window: { showWarningMessage: async (...args) => {
        warnings.push(args[0]);
        return options.showWarningMessage ? options.showWarningMessage() : "Compact";
      } },
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
    [file("src/tools/executor.js")]: { executeToolCall: options.executeToolCall || (async () => options.toolResult || "") },
    [file("src/tools/shellInfo.js")]: { describeShellBrief: () => "" },
    [file("src/mcp/client.js")]: { fetchMcpTools: async () => [], callMcpTool: options.callMcpTool || (async () => options.toolResult || "") },
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
      truncateToolResult,
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

  if (options.realApprovals) {
    delete stubs[file("src/chat/approvals.js")];
    delete require.cache[file("src/chat/approvals.js")];
  }
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

/** A manually settled dependency, modelling an MCP call that ignores Stop. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** @param {string} name */
function toolCall(name) {
  return { id: name, function: { name, arguments: "{}" } };
}

for (const stop of ["Stop", "close", "external"]) {
  for (const completion of ["resolve", "reject"]) {
    test(`${stop} during MCP (${completion}) prevents later writes and model rounds`, async (t) => {
      const mcp = deferred();
      const external = new AbortController();
      const executed = [];
      let calls = 0;
      let mcpCalls = 0;
      const { controller, posted } = setup({
        chat: async (...args) => {
          calls++;
          args[4]("partial findings");
          return { text: "", toolCalls: [toolCall("mcp__server__slow"), toolCall("write_file")] };
        },
        callMcpTool: () => { mcpCalls++; return mcp.promise; },
        executeToolCall: async (name) => { executed.push(name); return "written"; },
      });
      t.after(() => { mcp.resolve("late result"); controller.dispose(); });
      const run = controller.runAgentTask({ task: "work", signal: external.signal });
      await settle();
      assert.equal(mcpCalls, 1);
      if (stop === "Stop") controller.handleMessage({ type: "cancelMessage" });
      else if (stop === "close") controller.dispose();
      else external.abort();
      assert.equal(controller.isBusy(), true, "uncancellable work is still unwinding");
      if (completion === "resolve") mcp.resolve("late result");
      else mcp.reject(new Error("remote call failed after cancellation"));
      const outcome = await run;
      assert.deepEqual(outcome, { ok: false, aborted: true, error: null, text: "partial findings" });
      assert.deepEqual(executed, [], "no new built-in dispatch after Stop");
      assert.equal(calls, 1, "no extra model request");
      assert.equal(controller.isBusy(), false);
      assert.equal(posted.filter((m) => m.type === "toolStart").length, 1);
      if (stop !== "close") {
        assert.ok(posted.some((m) => m.type === "toolCall" && m.result === "Aborted by user"));
      }
    });
  }
}

for (const approveFirst of [false, true]) {
  test(`external cancellation releases real approval waits (already approved: ${approveFirst})`, async (t) => {
    const external = new AbortController();
    const executed = [];
    let calls = 0;
    const { controller, posted } = setup({
      realApprovals: true,
      chat: async () => {
        calls++;
        return { text: "", toolCalls: [toolCall("write_file"), toolCall("delete_files")] };
      },
      executeToolCall: async (name) => { executed.push(name); return "written"; },
    });
    t.after(() => controller.dispose());
    const run = controller.runAgentTask({ task: "work", signal: external.signal });
    await settle();
    const card = posted.find((m) => m.type === "approvalRequest");
    assert.ok(card, "a real approval is pending");
    if (approveFirst) {
      // Resolve approval and cancel before its awaiting continuation dispatches.
      controller.handleMessage({ type: "approvalResponse", approvalId: card.approvalId, decision: "allow" });
    }
    external.abort();
    await settle();
    assert.equal(controller.isBusy(), false, "external abort must settle the pending approval");
    const outcome = await run;
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.ok, false);
    assert.deepEqual(executed, []);
    assert.equal(calls, 1);
    assert.equal(posted.filter((m) => m.type === "approvalRequest").length, 1);
  });
}

test("an already cancelled external signal returns aborted without starting work", async () => {
  let calls = 0;
  const { controller } = setup({ chat: async () => { calls++; return { text: "done" }; } });
  const external = new AbortController();
  external.abort();
  const outcome = await controller.runAgentTask({ task: "work", signal: external.signal });
  assert.deepEqual(outcome, { ok: false, aborted: true, error: null, text: "" });
  assert.equal(calls, 0);
  assert.equal(controller.isBusy(), false);
});

test("a provider that resolves normally after cancellation cannot start tools or report success", async (t) => {
  const pending = deferred();
  const executed = [];
  const { controller } = setup({
    chat: () => pending.promise,
    executeToolCall: async (name) => { executed.push(name); return "written"; },
  });
  t.after(() => { pending.resolve({ text: "" }); controller.dispose(); });
  const run = controller.runAgentTask({ task: "work" });
  await settle();
  controller.handleMessage({ type: "cancelMessage" });
  pending.resolve({ text: "", toolCalls: [toolCall("write_file")] });
  assert.equal((await run).aborted, true);
  assert.deepEqual(executed, []);
});

for (const choice of ["Compact", "Send anyway"]) {
  test(`Stop during compaction prompt blocks ${choice} from starting another request`, async (t) => {
    const prompt = deferred();
    let calls = 0;
    const { controller, posted, warnings } = setup({
      compactionMode: "ask",
      showWarningMessage: () => prompt.promise,
      chat: async () => { calls++; return { text: "done" }; },
    });
    t.after(() => { prompt.resolve(choice); controller.dispose(); });
    controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "work" });
    await settle();
    assert.equal(warnings.length, 1);
    controller.handleMessage({ type: "cancelMessage" });
    prompt.resolve(choice);
    await settle();
    assert.equal(calls, 0);
    assert.equal(controller.isBusy(), false);
    assert.ok(posted.some((m) => m.type === "responseComplete"));
    assert.equal(posted.some((m) => m.type === "error"), false);
  });
}

test("Stop during compaction returns an aborted outcome even if the provider ignores it", async (t) => {
  const compacting = deferred();
  let calls = 0;
  const { controller } = setup({
    compactionMode: "auto",
    chat: () => { calls++; return compacting.promise; },
  });
  t.after(() => { compacting.resolve({ text: "late summary" }); controller.dispose(); });
  const run = controller.runAgentTask({ task: "work" });
  await settle();
  controller.handleMessage({ type: "cancelMessage" });
  compacting.resolve({ text: "late summary" });
  const outcome = await run;
  assert.equal(outcome.aborted, true);
  assert.equal(outcome.ok, false);
  assert.equal(calls, 1);
  assert.equal(controller.isBusy(), false);
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

test("a rejected overlapping agent run cannot clear the active agent mode", async (t) => {
  const pending = deferred();
  const { controller, toolSettingsSeen } = setup({ callMcpTool: () => pending.promise,
    chat: async () => ({ text: "", toolCalls: [toolCall("mcp__server__slow")] }),
  });
  t.after(() => { pending.resolve("done"); controller.dispose(); });
  const run = controller.runAgentTask({ task: "first" });
  const rejected = await controller.runAgentTask({ task: "overlap" });
  await settle();
  assert.equal(rejected.ok, false);
  assert.equal(toolSettingsSeen[0].agent, false, "the first run must remain an agent");
  controller.handleMessage({ type: "cancelMessage" });
  pending.resolve("done");
  assert.equal((await run).aborted, true);
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

for (const toolName of ["read_file", "search_code", "mcp__server__read_file"]) {
  test(`${toolName} applies the correct result limit in the next provider request`, async (t) => {
    const toolResult = Array.from({ length: 500 }, (_, i) => `${i + 1}: ${"x".repeat(80)}`).join("\n");
    assert.ok(toolResult.length > 25000);
    let rounds = 0;
    let received;
    const { controller, posted } = setup({
      toolResult,
      chat: async (...args) => {
        rounds++;
        if (rounds === 1) {
          return {
            text: "",
            toolCalls: [{ id: "read-result", function: { name: toolName, arguments: "{}" } }],
          };
        }
        received = args[0].find((m) => m.role === "tool" && m.tool_call_id === "read-result");
        return { text: "done" };
      },
    });
    t.after(() => controller.dispose());

    const outcome = await controller.runAgentTask({ task: "read the tool result" });

    assert.equal(outcome.ok, true);
    assert.equal(rounds, 2);
    assert.ok(received, "the provider must receive the tool response");
    if (toolName === "read_file") {
      assert.equal(received.content, toolResult, "every requested line reaches the model intact");
    } else {
      assert.equal(received.content, truncateToolResult(toolResult));
      assert.notEqual(received.content, toolResult, "other tools keep their character cap");
      assert.match(received.content, /truncated/);
    }
    const preview = posted.find((m) => m.type === "toolCall" && m.toolId === "read-result");
    assert.equal(preview.result, toolResult.slice(0, 2000), "the UI preview limit is unchanged");
  });
}

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

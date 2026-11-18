const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * Tool rounds are part of the transcript now.
 *
 * Before this, the tool loop was stateful only inside one turn: a new user
 * message rebuilt the request from user/assistant text alone, so the model had
 * to re-read every file it had already read. These tests drive the real
 * controller and pin both halves of the contract:
 *   - the next turn's request carries the previous turn's tool calls/results;
 *   - the webview history still shows only the user/assistant transcript.
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
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * @param {Object} options
 * @param {(messages: Array<any>, call: number) => any} options.chat
 * @param {string} [options.toolResult]
 * @param {(name: string, args: any, signal?: AbortSignal) => Promise<string>} [options.executeToolCall]
 * @param {"allow" | "deny"} [options.decision]
 * @param {number} [options.threshold] - compaction threshold (also the retention budget)
 */
function setup(options) {
  const sessions = [];
  const provider = { chat: async (messages) => options.chat(messages, provider.calls++) };
  provider.calls = 0;

  stubs = {
    vscode: {
      workspace: { workspaceFolders: undefined },
      env: { clipboard: { writeText: async () => {} } },
      window: { showWarningMessage: async () => "Compact" },
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
      getToolSettings: () => ({}),
      getCompaction: () => ({ mode: "off", threshold: options.threshold || 300000, keepTurns: 10 }),
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
    [file("src/tools/executor.js")]: {
      executeToolCall: options.executeToolCall || (async () => options.toolResult || "tool output"),
    },
    [file("src/tools/shellInfo.js")]: { describeShellBrief: () => "" },
    [file("src/mcp/client.js")]: { fetchMcpTools: async () => [], callMcpTool: async () => "" },
    [file("src/context/compact.js")]: { planCompaction: () => ({ shouldCompact: false }) },
    [file("src/chat/approvals.js")]: {
      createApprovalGate: () => ({
        request: async () => ({ decision: options.decision || "allow", mode: "auto" }),
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
    hooks: {
      canTakeSession: () => true,
      onSessionTaken: () => {},
      onSessionReleased: () => {},
      onSessionsChanged: () => {},
      onSessionDeleted: () => {},
      onTitleChanged: () => {},
      onMessage: () => {},
      activity: { start: () => {}, end: () => {}, warnfor: () => [], warningsFor: () => [] },
    },
  });

  const posted = [];
  controller.attach((msg) => posted.push(msg));
  return { controller, posted, provider, sessions };
}

/** A provider result that asks for one tool call. */
function toolCall(id, name) {
  return { text: "", toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify({ path: "src/a.js" }) } }] };
}

test("the next turn's request carries the previous turn's tool round", async () => {
  const requests = [];
  const { controller } = setup({
    chat: (messages, call) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (call === 0) return toolCall("call-1", "read_file");
      if (call === 1) return { text: "The file says hi." };
      return { text: "You already asked." };
    },
    toolResult: "line one\nline two",
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "read src/a.js" });
  await settle();
  assert.equal(requests.length, 2, "one tool round then the answer");

  // The tool round is in the transcript: the delta is a second user message.
  controller.handleMessage({ type: "sendMessage", messageId: "m2", text: "what did it say?" });
  await settle();
  assert.equal(requests.length, 3);

  const second = requests[2];
  const carrier = second.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  assert.ok(carrier, "turn 1's tool call is replayed to the model");
  assert.equal(carrier.tool_calls[0].id, "call-1");
  assert.equal(carrier.tool_calls[0].function.name, "read_file");

  const result = second.find((m) => m.role === "tool");
  assert.ok(result, "turn 1's tool result is replayed to the model");
  assert.equal(result.tool_call_id, "call-1");
  assert.equal(result.content, "line one\nline two");

  // Order matters: user, call, result, assistant answer, user.
  assert.deepEqual(second.map((m) => m.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.equal(second[3].content, "The file says hi.");
  assert.equal(second[4].content, "what did it say?");
});

test("the webview history stays user/assistant only", async () => {
  const { controller, posted } = setup({
    chat: (messages, call) => (call === 0 ? toolCall("call-1", "read_file") : { text: "done" }),
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "read it" });
  await settle();
  controller.handleMessage({ type: "requestState" });

  const history = posted.filter((m) => m.type === "historyRestored").at(-1).messages;
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant"]);
  assert.ok(history.every((m) => !m.tool_calls && m.role !== "tool"), "no tool messages reach the webview");
  assert.equal(history[1].content, "done");
});

test("a denied tool call is recorded, so the model does not retry it blindly", async () => {
  const requests = [];
  const { controller } = setup({
    decision: "deny",
    chat: (messages, call) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (call === 0) return toolCall("call-1", "run_command");
      if (call === 1) return { text: "I cannot run that." };
      return { text: "still cannot" };
    },
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "run it" });
  await settle();
  controller.handleMessage({ type: "sendMessage", messageId: "m2", text: "try again" });
  await settle();

  const replayed = requests.at(-1).find((m) => m.role === "tool");
  assert.ok(replayed, "the denial is part of the transcript");
  assert.match(replayed.content, /user denied approval/);
});

test("an aborted tool batch is closed, so the next turn's request stays valid", async () => {
  // The first call resolves, the second waits on the signal so Stop unwinds
  // the turn mid-batch. A turn stopped like this is not saved by the abort
  // path itself — the next send is what persists it, and it must not leave a
  // call without a result (both providers reject the unpaired half).
  let markSecondStarted;
  const secondStarted = new Promise((resolve) => { markSecondStarted = resolve; });
  let calls = 0;
  const requests = [];
  const { controller, sessions } = setup({
    chat: (messages, call) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      if (call === 0) {
        return {
          text: "",
          toolCalls: [
            { id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } },
          ],
        };
      }
      return { text: "second answer" };
    },
    executeToolCall: async (name, args, signal) => {
      calls++;
      if (calls === 1) return "first result";
      markSecondStarted();
      await new Promise((_resolve, reject) => {
        const fail = () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal && signal.aborted) fail();
        else if (signal) signal.addEventListener("abort", fail, { once: true });
      });
      return "never";
    },
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "read both" });
  await secondStarted;
  controller.handleMessage({ type: "cancelMessage" });
  await settle();
  assert.equal(controller.isBusy(), false, "the stopped turn released the chat");

  controller.handleMessage({ type: "sendMessage", messageId: "m2", text: "what happened?" });
  await settle();

  const stored = sessions[0] && sessions[0].messages;
  assert.ok(stored, "the transcript was saved by the next send");
  const ids = stored.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(ids, ["c1", "c2"], "both calls have a recorded result");

  // And the request the model receives is pairable: call, then two results.
  const replayed = requests.at(-1);
  assert.deepEqual(replayed.map((m) => m.role), ["user", "assistant", "tool", "tool", "user"]);
});

test("a long tool result is stored whole, exactly as the request carried it", async () => {
  // The transcript used to keep a 4 000-char copy, so the next turn's model
  // reasoned about a file it had only partly seen. It now stores the request
  // string verbatim: what this turn saw is what the next turn sees.
  const longResult = "x".repeat(40000);
  const requests = [];
  const { controller, sessions } = setup({
    chat: (messages, call) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      return call === 0 ? toolCall("call-1", "read_file") : { text: "done" };
    },
    toolResult: longResult,
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "read it" });
  await settle();

  const inTurn = requests[1].find((m) => m.role === "tool");
  const stored = sessions[0].messages.find((m) => m.role === "tool");
  assert.equal(inTurn.content, longResult, "read_file is not character-capped in the request");
  assert.equal(stored.content, inTurn.content, "the stored copy is byte-identical to the request copy");
  assert.doesNotMatch(stored.content, /truncated/);
});

test("a capped tool result is stored with the same cap the request used", async () => {
  // Non-read_file tools still hit the 25 000-char request guard. The transcript
  // must store that same string, not a second, different reduction — otherwise
  // turn 2 sees a result turn 1 never saw.
  const longResult = "y".repeat(60000);
  const requests = [];
  const { controller, sessions } = setup({
    chat: (messages, call) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      return call === 0 ? toolCall("call-1", "search_code") : { text: "done" };
    },
    toolResult: longResult,
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "search" });
  await settle();

  const inTurn = requests[1].find((m) => m.role === "tool");
  const stored = sessions[0].messages.find((m) => m.role === "tool");
  assert.ok(inTurn.content.length < longResult.length, "the request cap still applies");
  assert.match(inTurn.content, /truncated/);
  assert.equal(stored.content, inTurn.content, "the stored copy carries the request's own cap, verbatim");
});

test("the last assistant answer is not an empty tool-call carrier", async () => {
  // A run stopped right after a tool round leaves a carrier as the newest
  // assistant message; the parent model must still get the real answer.
  const { controller } = setup({
    chat: (messages, call) => (call === 0 ? toolCall("call-1", "read_file") : { text: "the answer" }),
  });

  controller.handleMessage({ type: "sendMessage", messageId: "m1", text: "read it" });
  await settle();

  assert.equal(controller.getLastAssistantResponse(), "the answer");
});

test("retention trims old rounds, merges its markers and keeps requests pairable", async () => {
  // Budget: 8000 - 4096 reserve = 3904 tokens. Each stored round is a
  // 4000-char result (~1000 tokens), so a few turns of rounds cannot all fit
  // and the oldest are dropped.
  const requests = [];
  const issued = [];
  const { controller, posted, sessions } = setup({
    threshold: 8000,
    chat: (messages, n) => {
      requests.push(JSON.parse(JSON.stringify(messages)));
      const id = "call-" + n;
      issued.push(id);
      return toolCall(id, "read_file");
    },
    toolResult: "z".repeat(4000),
  });

  for (let turn = 0; turn < 5; turn++) {
    controller.handleMessage({ type: "sendMessage", messageId: "m" + turn, text: "turn " + turn });
    await settle();
  }

  const stored = sessions[0].messages;
  const rounds = stored.filter((m) => m.role === "assistant" && m.tool_calls);
  assert.ok(rounds.length < issued.length, "older rounds were dropped to stay within the budget");
  assert.ok(rounds.length >= 1, "the newest round is kept");

  assert.equal(stored.filter((m) => m.notice === true).length, 1, "repeated trims merge into a single marker");

  // The user was told on the spot, not only on the next reload.
  assert.ok(
    posted.some((m) => m.type === "compactionNotice" && /removed from the transcript/.test(m.text)),
    "a notice is posted when rounds are trimmed"
  );

  // And the requests stay pairable: no orphan tool result ever reaches a
  // provider. (Both providers reject an unpaired half.) Every call also keeps
  // its one result.
  for (const request of requests) {
    const results = request.filter((m) => m.role === "tool");
    for (const tool of results) {
      const carrier = request.find(
        (m) => m.role === "assistant" && (m.tool_calls || []).some((tc) => tc.id === tool.tool_call_id)
      );
      assert.ok(carrier, "tool result " + tool.tool_call_id + " has its call");
    }
    for (const carrier of request.filter((m) => m.role === "assistant" && m.tool_calls)) {
      for (const tc of carrier.tool_calls) {
        assert.ok(
          results.some((r) => r.tool_call_id === tc.id),
          "call " + tc.id + " has its result"
        );
      }
    }
  }
});

test("a restored history shows a trimmed-rounds marker as a notice line", async () => {
  // A trimmed transcript still explains itself on reload: the marker is part
  // of the display transcript, as a notice line rather than a message.
  const { controller, posted } = setup({
    threshold: 8000,
    chat: (messages, n) => (n % 2 === 0 ? toolCall("call-" + n, "read_file") : { text: "answer " + n }),
    toolResult: "z".repeat(4000),
  });

  for (let turn = 0; turn < 6; turn++) {
    controller.handleMessage({ type: "sendMessage", messageId: "m" + turn, text: "turn " + turn });
    await settle();
  }
  controller.handleMessage({ type: "requestState" });

  const history = posted.filter((m) => m.type === "historyRestored").at(-1).messages;
  const notices = history.filter((m) => m.notice === true);
  assert.equal(notices.length, 1, "the marker survives the trip to the webview");
  assert.match(notices[0].content, /removed from the transcript/);
  assert.ok(
    history.every((m) => m.role !== "system" || m.notice === true),
    "only notice markers may be system messages in the UI history"
  );
  assert.equal(history.filter((m) => m.role === "user").length, 6, "the user's own turns all remain");
});

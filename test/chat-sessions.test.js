const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * Chat-level session behaviour with several chats open: which sessions are
 * reported as "open elsewhere", what happens when a chat tries to open a
 * session another chat holds, and that a disposed chat stops writing.
 *
 * Drives the real controller with stubbed storage, like a webview would.
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

/**
 * @param {Object} options
 * @param {Array<any>} options.sessions - Stored sessions (mutated by saves).
 * @param {Array<string>} [options.ownedElsewhere] - Sessions other chats show.
 * @param {string} [options.openSessionId] - Session this chat opens on start.
 */
function setup(options) {
  const sessions = options.sessions || [];
  const posted = [];
  const reveals = [];
  /** @type {Array<string>} */
  const released = [];

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
      getContextFlags: () => ({}),
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

  const ownedElsewhere = new Set(options.ownedElsewhere || []);
  const controller = createChatController({
    id: "tab-1",
    ...(options.openSessionId ? { sessionId: options.openSessionId } : {}),
    hooks: {
      canTakeSession: (sessionId) => !ownedElsewhere.has(sessionId),
      onSessionTaken: () => {},
      onSessionReleased: (sessionId) => released.push(sessionId),
      onSessionUnavailable: (sessionId) => reveals.push(sessionId),
      onSessionsChanged: () => {},
      onSessionDeleted: () => {},
      onTitleChanged: () => {},
      onMessage: () => {},
      isSessionBusy: (sessionId) => ownedElsewhere.has(sessionId),
      activity: { start: () => {}, end: () => {}, warningsFor: () => [] },
    },
  });

  controller.attach((msg) => posted.push(msg));
  return { controller, posted, reveals, released, sessions };
}

/** @param {Array<any>} posted */
function lastSessionsMessage(posted) {
  const messages = posted.filter((m) => m.type === "sessionsLoaded");
  return messages[messages.length - 1];
}

test("the session list reports sessions other chats are showing", () => {
  const { posted } = setup({
    sessions: [
      { id: "s1", messages: [{ role: "user", content: "a" }] },
      { id: "s2", messages: [{ role: "user", content: "b" }] },
    ],
    openSessionId: "s1",
    ownedElsewhere: ["s2"],
  });

  const message = lastSessionsMessage(posted);
  // s1 is this chat's own session, so it is not "elsewhere".
  assert.deepEqual(message.busySessionIds, ["s2"]);
  assert.equal(message.currentSessionId, "s1");
});

test("an owned session is never reported as busy for its own chat", () => {
  const { posted } = setup({
    sessions: [{ id: "s1", messages: [{ role: "user", content: "a" }] }],
    openSessionId: "s1",
    ownedElsewhere: ["s1"],
  });
  assert.deepEqual(lastSessionsMessage(posted).busySessionIds, []);
});

test("switching to a session another chat holds is refused and reveals that chat", () => {
  const { controller, posted, reveals } = setup({
    sessions: [
      { id: "s1", messages: [{ role: "user", content: "a" }] },
      { id: "s2", messages: [{ role: "user", content: "b" }] },
    ],
    openSessionId: "s1",
    ownedElsewhere: ["s2"],
  });

  controller.handleMessage({ type: "switchSession", sessionId: "s2" });

  assert.equal(controller.getSessionId(), "s1", "the chat keeps its own session");
  assert.deepEqual(reveals, ["s2"], "the owning chat is revealed instead");
  const error = posted.find((m) => m.type === "error");
  assert.ok(error, "the user is told why nothing happened");
  assert.match(error.error, /another CCE chat/);
});

test("closing a chat releases its session and refuses to save afterwards", async () => {
  const { controller, sessions, released } = setup({
    sessions: [{ id: "s1", messages: [{ role: "user", content: "a" }] }],
    openSessionId: "s1",
  });

  controller.dispose();
  assert.deepEqual(released, ["s1"], "the session is free for other chats");

  // A save that lands after disposal must not write: the tab is gone and the
  // user may have deleted the session in the meantime.
  await controller.saveSession();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].messages.length, 1);
});

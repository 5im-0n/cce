const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

/**
 * The editor-tab host: what it posts to the webview and how it tears down.
 *
 * The panel host is what makes a tab survive a window reload — it pushes the
 * session id down so the webview can `setState` it, and answers again when the
 * webview's script starts (the initial replay races the document load). The
 * controller is faked here so these rules are tested without a request loop.
 */

const ROOT = path.resolve(__dirname, "..");

/** @type {any} */
let vscodeStub = {};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscodeStub;
  return originalLoad(request, parent, isMain);
};

test.after(() => {
  Module._load = originalLoad;
});

/**
 * @param {{ sessionId?: string | null }} [options]
 */
function setup(options = {}) {
  const posts = [];
  let detaches = 0;
  let closedWith = null;
  /** @type {Array<any>} */
  const handled = [];
  /** @type {((msg: any) => void) | null} */
  let receiver = null;
  /** @type {(() => void) | null} */
  let disposeHandler = null;
  let sink = null;
  let sessionId = options.sessionId === undefined ? null : options.sessionId;

  vscodeStub = {
    Uri: { joinPath: () => ({ path: "icon" }) },
    ViewColumn: { Beside: -2 },
    window: {
      createWebviewPanel: () => panel,
      createOutputChannel: () => ({ appendLine() {} }),
    },
  };

  const panel = {
    title: "CCE: Chat",
    webview: {
      html: "",
      options: {},
      onDidReceiveMessage: (handler) => {
        receiver = handler;
        return {
          dispose: () => {
            receiver = null;
          },
        };
      },
      postMessage: async (msg) => {
        posts.push(msg);
        return true;
      },
    },
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose() {} };
    },
    reveal() {},
    dispose() {
      if (disposeHandler) disposeHandler();
    },
  };

  const controller = {
    id: "tab-1",
    attach: (nextSink) => {
      sink = nextSink;
      // The real controller replays its state on attach.
      nextSink({ type: "modelsLoaded", models: [] });
      nextSink({ type: "sessionsLoaded", sessions: [] });
      if (sessionId) nextSink({ type: "sessionSwitched", sessionId });
    },
    detach: () => {
      detaches++;
      sink = null;
    },
    handleMessage: (msg) => {
      handled.push(msg);
    },
    getSessionId: () => sessionId,
    getTitle: () => "Chat",
  };

  delete require.cache[path.join(ROOT, "src/chat/view.js")];
  const { attachEditorChatPanel } = require(path.join(ROOT, "src/chat/view.js"));
  const host = attachEditorChatPanel(
    { extensionUri: { path: ROOT }, extensionPath: ROOT },
    panel,
    controller,
    async (chatId) => {
      closedWith = chatId;
    }
  );

  return {
    host,
    panel,
    posts,
    handled,
    states: () => posts.filter((m) => m.type === "persistPanelState"),
    emit: (msg) => sink && sink(msg),
    ask: (msg) => receiver && receiver(msg),
    setSessionId: (id) => {
      sessionId = id;
    },
    counters: () => ({ detaches, closedWith }),
  };
}

test("attaching a panel tells the webview which session to remember", () => {
  const { states } = setup({ sessionId: "s1" });
  assert.deepEqual(states(), [{ type: "persistPanelState", sessionId: "s1" }]);
});

test("a tab with no session persists null so it reopens empty rather than not at all", () => {
  const { states } = setup({ sessionId: null });
  assert.deepEqual(states(), [{ type: "persistPanelState", sessionId: null }]);
});

test("the state is posted only when it changes", () => {
  const h = setup({ sessionId: null });
  assert.equal(h.states().length, 1);

  // Repeated session-list broadcasts (every save triggers one) must not flood
  // the webview with the same state.
  h.emit({ type: "sessionsLoaded", sessions: [] });
  h.emit({ type: "sessionsLoaded", sessions: [] });
  assert.equal(h.states().length, 1);

  h.setSessionId("s1");
  h.emit({ type: "sessionSwitched", sessionId: "s1" });
  assert.deepEqual(
    h.states().map((m) => m.sessionId),
    [null, "s1"]
  );
  assert.equal(h.states().length, 2);
});

test("a new chat that gets its id on the first send is persisted too", () => {
  const h = setup({ sessionId: null });
  // A fresh chat only receives a session id once the first message is saved;
  // only `sessionsLoaded` reports that, so it must be tracked as well.
  h.setSessionId("fresh-1");
  h.emit({ type: "sessionsLoaded", sessions: [] });

  assert.deepEqual(
    h.states().map((m) => m.sessionId),
    [null, "fresh-1"]
  );
});

test("the webview can ask for the state again even when it has not changed", () => {
  const h = setup({ sessionId: "s1" });
  h.posts.length = 0;

  // The replay above can precede the document load; this is the guarantee that
  // a reload still knows the session.
  h.ask({ type: "requestState" });

  assert.deepEqual(h.states(), [{ type: "persistPanelState", sessionId: "s1" }]);
});

test("incoming messages still reach the controller", () => {
  const h = setup({ sessionId: "s1" });

  // The panel state is answered and the message is still forwarded, in that
  // order — a requestState is not swallowed by the host.
  h.ask({ type: "requestState" });
  h.ask({ type: "sendMessage", text: "hi" });

  assert.deepEqual(
    h.handled.map((m) => m.type),
    ["requestState", "sendMessage"]
  );
  assert.equal(h.states().length, 2, "state is re-posted for the asking webview");
});

test("closing the panel detaches first, then reports the closed chat", () => {
  const h = setup({ sessionId: "s1" });
  h.panel.dispose();

  const { detaches, closedWith } = h.counters();
  assert.equal(detaches, 1);
  assert.equal(closedWith, "tab-1");
});

test("a second dispose event does not close the chat twice", () => {
  const h = setup({ sessionId: "s1" });
  h.panel.dispose();
  h.panel.dispose();

  assert.equal(h.counters().detaches, 1);
});

test("the tab title follows the session title", () => {
  const h = setup({ sessionId: "s1" });
  h.host.setTitle("Login flow");
  assert.equal(h.panel.title, "CCE: Login flow");
});

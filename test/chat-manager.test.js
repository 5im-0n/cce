const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

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
 */
function setup(options = {}) {
  const sessions = options.sessions || [];
  const openSessionFails = options.openSessionFails || (() => false);
  const panels = [];
  const revealed = [];
  const warnings = [];
  /** @type {Map<string, any>} */
  const controllers = new Map();

  stubs = {
    vscode: {
      window: {
        createWebviewPanel: (viewType, title, column, panelOptions) => {
          const panel = {
            viewType,
            title,
            column,
            panelOptions,
            disposed: false,
            webview: {
              html: "",
              options: {},
              onDidReceiveMessage: () => ({ dispose() {} }),
              postMessage: async () => true,
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
        const state = { id: config.id, sessionId: null, title: "Chat", disposed: false, saved: 0 };
        const controller = {
          id: config.id,
          state,
          attach: () => {},
          detach: () => {},
          handleMessage: () => {},
          postModels: () => {},
          postSessions: () => {},
          abortAll: () => {},
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
  for (const rel of ["src/chat/manager.js", "src/chat/controller.js", "src/chat/view.js", "src/chat/activity.js", "src/chat/ownership.js"]) {
    delete require.cache[file(rel)];
  }
  const { createChatManager } = require(managerPath);
  const manager = createChatManager({ extensionUri: { path: ROOT }, extensionPath: ROOT });

  return { manager, panels, revealed, warnings, sessions, controllers };
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

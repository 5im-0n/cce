/**
 * Pre-dispatch cancellation tests for the actual tool executor.
 * Only vscode is stubbed; mutations use isolated temporary workspaces.
 * Run with: node --test test/executor-abort.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

/**
 * Load an executor with a vscode stub, immediately restoring loader and cache.
 * @param {object} vscodeStub - Workspace API needed by these tools.
 * @returns {typeof import("../src/tools/executor").executeToolCall}
 */
function loadExecutor(vscodeStub) {
  const executorPath = require.resolve("../src/tools/executor");
  const cached = require.cache[executorPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscodeStub;
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[executorPath];
  try {
    return require(executorPath).executeToolCall;
  } finally {
    Module._load = originalLoad;
    if (cached) require.cache[executorPath] = cached;
    else delete require.cache[executorPath];
  }
}

/**
 * Create a temporary workspace with automatic cleanup.
 * @param {import("node:test").TestContext} t - Owning test.
 * @returns {{ root: string,
 *   executeToolCall: typeof import("../src/tools/executor").executeToolCall }}
 */
function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cce-executor-abort-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executeToolCall = loadExecutor({
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
  });
  return { root, executeToolCall };
}

/**
 * Create a signal cancelled with the standard AbortError reason.
 * @returns {AbortSignal}
 */
function abortedSignal() {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

for (const toolName of [
  "read_file", "write_file", "edit_file", "delete_files", "get_selection",
  "search_code", "list_files", "get_diagnostics", "run_command",
]) {
  test(`${toolName} rejects an already-aborted signal before accessing the workspace`, async () => {
    const executeToolCall = loadExecutor({
      get workspace() {
        throw new Error("A cancelled tool must not reach workspace access or dispatch");
      },
    });
    const signal = abortedSignal();
    await assert.rejects(executeToolCall(toolName, {}, signal), (error) => {
      assert.equal(error, signal.reason);
      assert.equal(error.name, "AbortError");
      return true;
    });
  });
}

test("pre-dispatch cancellation preserves a custom abort reason", async (t) => {
  const { executeToolCall } = createFixture(t);
  const controller = new AbortController();
  const reason = new Error("Request stopped");
  controller.abort(reason);
  await assert.rejects(executeToolCall("read_file", { path: "missing.txt" }, controller.signal), (error) => {
    assert.equal(error, reason);
    return true;
  });
});

test("aborted write_file creates neither a file nor its parent directories", async (t) => {
  const { root, executeToolCall } = createFixture(t);
  await assert.rejects(executeToolCall("write_file", {
    path: "new/nested/file.txt", content: "must not be written",
  }, abortedSignal()), { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(root), []);
});

test("aborted write_file does not overwrite an existing file", async (t) => {
  const { root, executeToolCall } = createFixture(t);
  const file = path.join(root, "existing.txt");
  fs.writeFileSync(file, "original", "utf8");
  await assert.rejects(executeToolCall("write_file", {
    path: "existing.txt", content: "replacement",
  }, abortedSignal()), { name: "AbortError" });
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("aborted edit_file leaves matching content untouched", async (t) => {
  const { root, executeToolCall } = createFixture(t);
  const file = path.join(root, "existing.txt");
  fs.writeFileSync(file, "before original after", "utf8");
  await assert.rejects(executeToolCall("edit_file", {
    path: "existing.txt", oldText: "original", newText: "replacement",
  }, abortedSignal()), { name: "AbortError" });
  assert.equal(fs.readFileSync(file, "utf8"), "before original after");
});

test("aborted delete_files preserves a file", async (t) => {
  const { root, executeToolCall } = createFixture(t);
  const file = path.join(root, "existing.txt");
  fs.writeFileSync(file, "original", "utf8");
  await assert.rejects(executeToolCall("delete_files", {
    path: "existing.txt",
  }, abortedSignal()), { name: "AbortError" });
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("aborted recursive delete_files preserves a directory and its descendants", async (t) => {
  const { root, executeToolCall } = createFixture(t);
  const dir = path.join(root, "existing", "nested");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "file.txt"), "original", "utf8");
  await assert.rejects(executeToolCall("delete_files", {
    path: "existing", recursive: true,
  }, abortedSignal()), { name: "AbortError" });
  assert.deepEqual(fs.readdirSync(root), ["existing"]);
  assert.deepEqual(fs.readdirSync(path.join(root, "existing")), ["nested"]);
  assert.deepEqual(fs.readdirSync(dir), ["file.txt"]);
  assert.equal(fs.readFileSync(path.join(dir, "file.txt"), "utf8"), "original");
});

for (const withSignal of [false, true]) {
  test(`normal dispatch works ${withSignal ? "with a live signal" : "without a signal"}`, async (t) => {
    const { root, executeToolCall } = createFixture(t);
    const signal = withSignal ? new AbortController().signal : undefined;
    const filePath = "nested/file.txt";
    const fullPath = path.join(root, filePath);
    assert.equal(await executeToolCall("write_file", {
      path: filePath, content: "original",
    }, signal), `Created ${filePath} (8 bytes)`);
    assert.equal(fs.readFileSync(fullPath, "utf8"), "original");
    assert.equal(await executeToolCall("write_file", {
      path: filePath, content: "updated",
    }, signal), `Overwrote ${filePath} (7 bytes)`);
    assert.equal(fs.readFileSync(fullPath, "utf8"), "updated");
    assert.equal(await executeToolCall("edit_file", {
      path: filePath, oldText: "updated", newText: "edited",
    }, signal), `Edited ${filePath}: replaced 7 chars with 6 chars (-1).`);
    assert.equal(fs.readFileSync(fullPath, "utf8"), "edited");
    assert.equal(await executeToolCall("read_file", {
      path: filePath,
    }, signal), `File: ${filePath} (1 lines total)\n1: edited`);
    assert.equal(await executeToolCall("delete_files", {
      path: filePath,
    }, signal), `Deleted file: ${filePath}`);
    assert.equal(fs.existsSync(fullPath), false);
    fs.writeFileSync(fullPath, "delete recursively", "utf8");
    assert.equal(await executeToolCall("delete_files", {
      path: "nested", recursive: true,
    }, signal), "Deleted directory: nested");
    assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(await executeToolCall("unknown", {}, signal), "Unknown tool: unknown");
  });
}

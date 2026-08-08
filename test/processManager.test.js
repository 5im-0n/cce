/**
 * Tests for stdio MCP server process lifecycle (src/mcp/processManager.js):
 * start/stop/stopAll, the SIGTERM-then-SIGKILL force-kill path, and the
 * exit-handler cleanup.
 * Run with: node --test test/processManager.test.js
 *
 * The module under test pulls in src/config/log.js, which requires the
 * `vscode` namespace — unavailable outside the extension host — so we
 * intercept Module._load and hand out a minimal stub before requiring it.
 */
const Module = require("node:module");
const _originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      window: {
        createOutputChannel: () => ({ appendLine() {} }),
      },
    };
  }
  return _originalLoad(request, parent, isMain);
};

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pm = require("../src/mcp/processManager");

// ── fixtures ────────────────────────────────────────────────
// Real child processes are used so the tests exercise actual signal
// delivery. Both fixtures keep themselves alive via stdin; both also
// self-terminate after 10s as a bound in case a signal is lost (e.g. the
// shell wrapper dies but the child survives — the bounded lifetime keeps
// any orphaned process from leaking indefinitely).

const COOP_FIXTURE = [
  'const fs = require("node:fs");',
  "const marker = process.argv[2];",
  'process.on("SIGTERM", () => {',
  '  fs.writeFileSync(marker, "sigterm");',
  "  process.exit(0);",
  "});",
  "process.stdin.resume();",
  "setTimeout(() => process.exit(0), 10000);",
].join("\n");

const STUBBORN_FIXTURE = [
  'const fs = require("node:fs");',
  "const marker = process.argv[2];",
  'process.on("SIGTERM", () => {',
  '  fs.writeFileSync(marker, "sigterm");',
  "  // deliberately do NOT exit — simulate a server that ignores SIGTERM",
  "});",
  "process.stdin.resume();",
  "setTimeout(() => process.exit(0), 10000);",
].join("\n");

let tmpDir;
let coopPath;
let stubbornPath;

const markerFor = (id) => path.join(tmpDir, "marker-" + id + ".txt");

function startServer(id, fixturePath) {
  return pm.start({
    id,
    command: process.execPath,
    args: [fixturePath, markerFor(id)],
  });
}

// ── helpers ─────────────────────────────────────────────────

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    // setImmediate stays real when only setTimeout is mocked.
    await new Promise((resolve) => setImmediate(resolve));
  }
  return predicate();
}

const waitUntilDead = (pid, timeoutMs) => waitFor(() => !isAlive(pid), timeoutMs);
const waitForFile = (file, timeoutMs) => waitFor(() => fs.existsSync(file), timeoutMs);

// ── hooks ───────────────────────────────────────────────────

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cce-pm-"));
  coopPath = path.join(tmpDir, "cooperative.js");
  stubbornPath = path.join(tmpDir, "stubborn.js");
  fs.writeFileSync(coopPath, COOP_FIXTURE);
  fs.writeFileSync(stubbornPath, STUBBORN_FIXTURE);
});

test.after(() => {
  pm.stopAll();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── start ───────────────────────────────────────────────────

test("start spawns the server process and registers it", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pid = startServer("s1", coopPath);
  assert.equal(typeof pid, "number");
  assert.ok(pm.isRunning("s1"));
  assert.ok(pm.getRunningIds().includes("s1"));

  pm.stop("s1");
  t.mock.timers.tick(3000);
  assert.ok(!pm.isRunning("s1"));
});

test("start is a no-op for an already running server id", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.ok(startServer("dup", coopPath));
  const again = pm.start({
    id: "dup",
    command: process.execPath,
    args: [coopPath, markerFor("dup")],
  });
  assert.equal(again, undefined);
  assert.equal(pm.getRunningIds().filter((id) => id === "dup").length, 1);

  pm.stop("dup");
  t.mock.timers.tick(3000);
});

test("start with no command is a no-op", () => {
  const pid = pm.start({ id: "nocommand", args: [] });
  assert.equal(pid, undefined);
  assert.equal(pm.isRunning("nocommand"), false);
});

// ── stop / force-kill ───────────────────────────────────────

test("stop terminates a cooperative process with SIGTERM", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pid = startServer("coop", coopPath);
  assert.ok(pid);

  pm.stop("coop");
  // The entry is removed from the registry immediately so restarts work.
  assert.equal(pm.isRunning("coop"), false);
  assert.ok(await waitUntilDead(pid, 3000), "cooperative server should exit on SIGTERM");

  if (process.platform !== "win32") {
    assert.ok(fs.existsSync(markerFor("coop")), "server should have received SIGTERM");
  }
  // Flush the grace timer (no-op: the process already exited).
  t.mock.timers.tick(3000);
});

test("stop force-kills a server that ignores SIGTERM", async (t) => {
  if (process.platform === "win32") {
    return t.skip(
      "Windows has no POSIX signals: kill('SIGTERM') terminates the process outright, so the force-kill branch is unreachable"
    );
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pid = startServer("stubborn", stubbornPath);
  assert.ok(pid);

  pm.stop("stubborn");
  assert.equal(pm.isRunning("stubborn"), false);

  // Prove the server received SIGTERM and chose to stay alive…
  assert.ok(
    await waitForFile(markerFor("stubborn"), 2000),
    "server should have received SIGTERM before SIGKILL"
  );
  // …then the grace timer must escalate to SIGKILL.
  t.mock.timers.tick(3000);
  assert.ok(await waitUntilDead(pid, 3000), "stubborn server should be dead after SIGKILL");
});

test("exit handler deregisters the server when the process dies", async () => {
  const pid = startServer("exit", coopPath);
  assert.ok(pid);
  assert.ok(pm.isRunning("exit"));

  process.kill(pid); // SIGTERM on POSIX; terminates the process on Windows
  assert.ok(await waitFor(() => !pm.isRunning("exit"), 3000), "exit handler should remove the entry");
  assert.ok(!pm.getRunningIds().includes("exit"));

  if (process.platform !== "win32") {
    assert.ok(await waitForFile(markerFor("exit"), 2000));
  }
});

test("stop on an unknown id is a no-op", () => {
  assert.doesNotThrow(() => pm.stop("ghost"));
  assert.equal(pm.isRunning("ghost"), false);
});

test("stopAll terminates every running server", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p1 = startServer("all-a", coopPath);
  const p2 = startServer("all-b", stubbornPath);
  assert.ok(p1 && p2);

  pm.stopAll();
  assert.deepEqual(pm.getRunningIds(), []);

  assert.ok(await waitUntilDead(p1, 3000), "cooperative server should exit on SIGTERM");
  if (process.platform !== "win32") {
    assert.ok(await waitForFile(markerFor("all-a"), 2000));
    assert.ok(await waitForFile(markerFor("all-b"), 2000));
    t.mock.timers.tick(3000); // stubborn server: escalate to SIGKILL
  }
  assert.ok(await waitUntilDead(p2, 3000), "stubborn server should be dead");
});

// ── sendRequest ─────────────────────────────────────────────

test("sendRequest rejects for a server that is not running", async () => {
  await assert.rejects(pm.sendRequest("ghost", "tools/list", {}), /not running/);
});

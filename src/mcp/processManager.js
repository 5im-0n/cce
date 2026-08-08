const { spawn } = require("child_process");
const log = require("../config/log").get();

/**
 * Manages child processes for stdio-based MCP servers.
 * Each server gets its own spawned process; requests are sent via stdin
 * and responses are read from stdout using JSON-RPC 2.0.
 *
 * @type {Map<string, { process: import("child_process").ChildProcess, pending: Map<string, { resolve: function, reject: function, timer: NodeJS.Timeout }>, buffer: string }>}
 */
const processes = new Map();

const REQUEST_TIMEOUT = 30_000;

/**
 * Start a stdio MCP server process.
 * @param {{ id: string, command?: string, args?: string[] }} server
 * @returns {number|undefined} - pid of the spawned process, or undefined if
 *   the server was already running or has no command configured.
 */
function start(server) {
  if (processes.has(server.id)) {
    log.appendLine(`MCP process already running for "${server.id}"`);
    return;
  }
  if (!server.command) {
    log.appendLine(`MCP: cannot start "${server.id}" — no command configured`);
    return;
  }

  const args = server.args || [];
  log.appendLine(`MCP: spawning "${server.command}" with args [${args.join(", ")}]`);

  /** @type {import("child_process").ChildProcess} */
  const proc = spawn(server.command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    shell: true,
    env: { ...process.env },
  });

  const entry = {
    process: proc,
    pending: new Map(),
    buffer: "",
  };

  proc.stdout?.on("data", (data) => {
    entry.buffer += data.toString();
    // Process complete lines from buffer
    let newlineIdx;
    while ((newlineIdx = entry.buffer.indexOf("\n")) !== -1) {
      const line = entry.buffer.slice(0, newlineIdx).trim();
      entry.buffer = entry.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        const pending = entry.pending.get(response.id);
        if (pending) {
          clearTimeout(pending.timer);
          entry.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(JSON.stringify(response.error)));
          } else {
            pending.resolve(response.result || {});
          }
        }
      } catch (e) {
        log.appendLine(
          `MCP: failed to parse response: ${e instanceof Error ? e.message : String(e)} — line: ${line.slice(0, 200)}`
        );
      }
    }
  });

  proc.stderr?.on("data", (data) => {
    log.appendLine(`MCP stderr [${server.id}]: ${data.toString().trim()}`);
  });

  proc.on("error", (err) => {
    log.appendLine(`MCP process error [${server.id}]: ${err.message}`);
  });

  proc.on("exit", (code, signal) => {
    log.appendLine(`MCP process exited [${server.id}]: code=${code} signal=${signal}`);
    // Reject all pending requests
    for (const [, pending] of entry.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Process exited with code ${code}`));
    }
    processes.delete(server.id);
  });

  processes.set(server.id, entry);
  log.appendLine(`MCP: process started for "${server.id}" (pid ${proc.pid})`);
  return proc.pid;
}

/**
 * Stop a stdio MCP server process.
 * @param {string} serverId
 */
function stop(serverId) {
  const entry = processes.get(serverId);
  if (!entry) return;
  log.appendLine(`MCP: stopping process "${serverId}"`);
  entry.process.kill("SIGTERM");
  // Force kill after 3s if the process has not exited yet.
  // The entry is removed from the map immediately (so restarts work),
  // so capture it in the closure instead of looking it up again.
  setTimeout(() => {
    const exited =
      entry.process.exitCode !== null || entry.process.signalCode !== null;
    if (!exited) {
      log.appendLine(`MCP: process "${serverId}" did not exit within 3s, sending SIGKILL`);
      entry.process.kill("SIGKILL");
    }
  }, 3000);
  processes.delete(serverId);
}

/**
 * Stop all running stdio MCP processes.
 */
function stopAll() {
  for (const serverId of processes.keys()) {
    stop(serverId);
  }
}

/**
 * Send a JSON-RPC request to a running stdio MCP process.
 * @param {string} serverId
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>} - JSON-RPC result payload (shape depends on the method)
 */
function sendRequest(serverId, method, params) {
  const entry = processes.get(serverId);
  if (!entry) {
    return Promise.reject(new Error(`MCP server "${serverId}" is not running`));
  }

  return new Promise((resolve, reject) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`MCP request timeout for "${method}" on "${serverId}"`));
    }, REQUEST_TIMEOUT);

    entry.pending.set(id, { resolve, reject, timer });
    entry.process.stdin?.write(request);
  });
}

/**
 * Check if a stdio server process is running.
 * @param {string} serverId
 * @returns {boolean}
 */
function isRunning(serverId) {
  const entry = processes.get(serverId);
  return !!entry && entry.process.killed === false;
}

/**
 * Get IDs of all running stdio servers.
 * @returns {string[]}
 */
function getRunningIds() {
  return Array.from(processes.keys()).filter(isRunning);
}

module.exports = { start, stop, stopAll, sendRequest, isRunning, getRunningIds };

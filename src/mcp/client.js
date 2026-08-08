const Settings = require("../config/Settings");
const processManager = require("./processManager");

/**
 * MCP (Model Context Protocol) client.
 * Supports HTTP transport (JSON-RPC over POST) and stdio transport
 * (JSON-RPC over child process stdin/stdout).
 */

/**
 * @typedef {Object} McpToolInfo
 * @property {string} name
 * @property {string} [description]
 * @property {object} [inputSchema]
 */

/**
 * @typedef {Object} McpRpcResult
 * @property {Array<McpToolInfo>} [tools]
 * @property {Array<{ type: string, text?: string }>} [content]
 */

/**
 * @typedef {Object} McpToolDefinition
 * @property {"function"} type
 * @property {Object} function
 * @property {string} function.name
 * @property {string} function.description
 * @property {object} function.parameters
 * @property {string} _mcpServerId
 * @property {string} _mcpToolName
 */

/**
 * @returns {Promise<Array<McpToolDefinition>>}
 */
async function fetchMcpTools() {
  const servers = Settings.getMcpServers().filter((s) => s.enabled !== false);
  if (servers.length === 0) return [];

  const allTools = [];
  for (const server of servers) {
    try {
      /** @type {McpRpcResult} */
      let result;
      if (_isStdio(server)) {
        result = await processManager.sendRequest(server.id, "tools/list", {});
      } else {
        result = await _httpRpcCall(server, "tools/list", {});
      }
      const tools = (result.tools || []).map((t) =>
        /** @type {McpToolDefinition} */ ({
          type: "function",
          function: {
            name: "mcp__" + server.id + "__" + t.name,
            description: t.description || "",
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
          _mcpServerId: server.id,
          _mcpToolName: t.name,
        })
      );
      allTools.push(...tools);
    } catch (e) {
      // Re-throw with server name for logging in extension.js
      throw new Error(server.name + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }
  return allTools;
}

/**
 * @param {string} serverId
 * @param {string} toolName
 * @param {object} args
 * @returns {Promise<string>}
 */
async function callMcpTool(serverId, toolName, args) {
  const servers = Settings.getMcpServers();
  const server = servers.find((s) => s.id === serverId);
  if (!server) return "Error: MCP server not found.";

  let result;
  try {
    if (_isStdio(server)) {
      result = await processManager.sendRequest(server.id, "tools/call", {
        name: toolName,
        arguments: args,
      });
    } else {
      result = await _httpRpcCall(server, "tools/call", {
        name: toolName,
        arguments: args,
      });
    }
  } catch (e) {
    return "MCP error: " + (e instanceof Error ? e.message : String(e));
  }

  /** @type {McpRpcResult} */
  const content = result || {};
  return (content.content || [])
    .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n") || "(no output)";
}

/**
 * Check if an MCP server uses stdio transport.
 * @param {{ command?: string, url?: string }} server
 * @returns {boolean}
 */
function _isStdio(server) {
  return !!(server.command);
}

/**
 * JSON-RPC call over HTTP POST.
 * @param {{ url?: string, headers?: Record<string, string> }} server
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>} - JSON-RPC result payload (shape depends on the method)
 */
async function _httpRpcCall(server, method, params) {
  if (!server.url) {
    throw new Error("MCP server has no URL configured");
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers || {}),
  };

  const body = {
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method,
    params,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const text = await response.text();

    // Try plain JSON first
    if (text.trim().startsWith("{")) {
      const data = JSON.parse(text);
      return data.result || data;
    }

    // Parse SSE: "event: message\ndata: {...}\n\n"
    const events = text.split(/\n\n/).filter(Boolean);
    for (const evt of events) {
      const dataLine = evt.split("\n").find(l => l.startsWith("data:"));
      if (dataLine) {
        const json = dataLine.slice(5).trim();
        if (json) {
          const parsed = JSON.parse(json);
          if (parsed.result || parsed.error) return parsed.result || parsed;
        }
      }
    }

    throw new Error("No valid JSON-RPC response in SSE stream");
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchMcpTools, callMcpTool };


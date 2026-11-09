const approval = require("../tools/approval");
const Settings = require("../config/Settings");
const { toolStatusSuffix } = require("../tools/statusText");
const { isAbortError } = require("./abort");
const log = require("../config/log").get();

/**
 * Per-chat tool approval gate.
 *
 * Each chat owns its own pending-approval map, so an approval card answered in
 * one chat can never release a tool call belonging to another. The gate is a
 * factory rather than a class method collection because it has to run for both
 * the sidebar chat and every editor-tab chat, and because the webview sink is
 * swapped whenever a view is recreated.
 *
 * The gate never touches `vscode` directly except through Settings; it posts
 * through the injected `post` callback so it stays inert when the chat has no
 * visible webview (approvals are then denied, as before).
 */

/**
 * @typedef {Object} ApprovalDecision
 * @property {"allow"|"deny"} decision
 * @property {"auto"|"ask"|"deny"} mode
 * @property {string} [reason]
 */

/**
 * @typedef {Object} ApprovalGateOptions
 * @property {(msg: Record<string, any>) => void} post - Deliver a message to this chat's webview.
 * @property {() => boolean} isVisible - Whether the chat currently has a webview to ask.
 * @property {(toolName: string, args: Record<string, any>) => Array<string>} [getWarnings] -
 *   Cross-chat conflict warnings shown inside the approval card.
 */

/**
 * Create the approval gate for one chat.
 * @param {ApprovalGateOptions} options
 * @returns {{ request: (toolName: string, args: Record<string, any>) => Promise<ApprovalDecision>, handleResponse: (msg: any) => void, rejectAll: (reason: string) => void, resetSession: () => void, dispose: () => void }}
 */
function createApprovalGate(options) {
  const { post, isVisible, getWarnings } = options;

  // approvalId -> { resolve, timer, toolName }
  const pending = new Map();
  // Tool names approved "for this session" (cleared on session change)
  const sessionApprovals = new Set();
  // MCP server ids approved "for this session" (server-level scope)
  const sessionServerApprovals = new Set();

  /**
   * Gate a tool call behind user approval. Resolves to a decision object:
   *   { decision: "allow", mode }  → run the tool
   *   { decision: "deny", mode, reason } → do not run it
   *
   * Auto-approved when the resolved policy is "auto"; denied immediately
   * when it is "deny", when no webview is available, or on timeout.
   *
   * @param {string} toolName
   * @param {Record<string, any>} args
   * @returns {Promise<ApprovalDecision>}
   */
  function request(toolName, args) {
    const mode = approval.resolveMode(
      toolName,
      sessionApprovals,
      Settings.getToolApprovalModes(),
      Settings.getMcpApprovalModes(),
      sessionServerApprovals
    );

    if (mode === "auto") return Promise.resolve({ decision: "allow", mode });
    if (mode === "deny") {
      log.appendLine("Approval: " + toolName + " denied by policy");
      return Promise.resolve({ decision: "deny", mode, reason: "Denied by approval policy" });
    }
    if (!isVisible()) {
      log.appendLine("Approval: no chat view, auto-denying " + toolName);
      return Promise.resolve({ decision: "deny", mode, reason: "Chat view is not available" });
    }

    return new Promise((resolve) => {
      const approvalId = "apr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const risk = approval.classifyTool(toolName);
      const timer = setTimeout(() => {
        log.appendLine("Approval: " + approvalId + " (" + toolName + ") timed out");
        pending.delete(approvalId);
        resolve({ decision: "deny", mode, reason: "Approval request timed out" });
      }, approval.APPROVAL_TIMEOUT_MS);

      pending.set(approvalId, { resolve, timer, toolName });

      log.appendLine("Approval: requesting approval for " + toolName + " (" + approvalId + ")");
      post({ type: "toolStatus", text: "Awaiting approval: " + toolName + toolStatusSuffix(toolName, args) });

      // Include the server name for MCP tools so the card can show a
      // readable label and offer server-level actions.
      const serverId = approval.getMcpServerId(toolName);
      const server = serverId
        ? (Settings.getMcpServers().find((s) => s.id === serverId) || null)
        : null;

      let warnings = [];
      try {
        warnings = typeof getWarnings === "function" ? getWarnings(toolName, args) || [] : [];
      } catch {
        warnings = [];
      }

      post({
        type: "approvalRequest",
        approvalId,
        toolName,
        args: JSON.stringify(args || {}, null, 2),
        risk,
        riskLabel: approval.riskLabel(risk),
        serverId: serverId || undefined,
        serverLabel: server ? server.name : undefined,
        // Optional additive field: other chats currently modifying the same
        // target. Rendered as a warning row by the webview.
        conflicts: warnings.length > 0 ? warnings : undefined,
      });
    });
  }

  /**
   * Handle an approval response from the webview.
   * @param {{ approvalId: string, decision: "allow"|"allowSession"|"alwaysAllow"|"deny" }} msg
   */
  function handleResponse(msg) {
    const entry = pending.get(msg.approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.approvalId);

    const serverId = approval.getMcpServerId(entry.toolName);
    const isMcp = serverId !== null;

    switch (msg.decision) {
      case "allow":
        log.appendLine("Approval: " + entry.toolName + " allowed");
        entry.resolve({ decision: "allow", mode: "ask" });
        break;
      case "allowSession":
        if (isMcp) {
          // MCP session approval is server-level: approving one tool
          // approves every tool this server exposes for the session.
          log.appendLine("Approval: MCP server " + serverId + " allowed for session");
          sessionServerApprovals.add(serverId);
        } else {
          log.appendLine("Approval: " + entry.toolName + " allowed for session");
          sessionApprovals.add(entry.toolName);
        }
        entry.resolve({ decision: "allow", mode: "ask" });
        break;
      case "alwaysAllow":
        if (isMcp) {
          log.appendLine("Approval: MCP server " + serverId + " set to always allow");
          void Settings.setMcpApprovalMode(serverId, "auto");
          entry.resolve({ decision: "allow", mode: "auto" });
        } else {
          log.appendLine("Approval: " + entry.toolName + " set to always allow");
          void Settings.setToolApprovalMode(entry.toolName, "auto");
          sessionApprovals.add(entry.toolName);
          entry.resolve({ decision: "allow", mode: "auto" });
        }
        break;
      case "deny":
      default:
        log.appendLine("Approval: " + entry.toolName + " denied");
        entry.resolve({ decision: "deny", mode: "ask", reason: "Denied by user" });
        break;
    }
  }

  /**
   * Deny every pending approval request (e.g. on cancel or session change).
   * @param {string} reason
   */
  function rejectAll(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ decision: "deny", mode: "ask", reason });
    }
    pending.clear();
  }

  /** Drop session-scoped approvals — the user is moving to another session. */
  function resetSession() {
    sessionApprovals.clear();
    sessionServerApprovals.clear();
  }

  return {
    request,
    handleResponse,
    rejectAll,
    resetSession,
    dispose: () => rejectAll("Chat closed"),
  };
}

module.exports = { createApprovalGate, isAbortError };

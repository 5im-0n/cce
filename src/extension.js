const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const Settings = require("./config/Settings");
const log = require("./config/log").get();
const ModelConfigPanel = require("./config/ModelConfigPanel");
const { getProvider } = require("./providers/registry");
const { getEnabledDefinitions } = require("./tools/definitions");
const { executeToolCall } = require("./tools/executor");
const { describeShellBrief } = require("./tools/shellInfo");
const { toolStatusSuffix } = require("./tools/statusText");
const approval = require("./tools/approval");
const { fetchMcpTools, callMcpTool } = require("./mcp/client");
const processManager = require("./mcp/processManager");

/**
 * @typedef {Object} ConversationMessage
 * @property {string} role
 * @property {string | null} content
 * @property {Array<{ id: string, name: string, dataUrl: string, size: number, warning: boolean }>} [images]
 * @property {Array<{ id: string, type: string, function: { name: string, arguments: string } }>} [tool_calls]
 * @property {string} [tool_call_id]
 */

/**
 * @implements {vscode.WebviewViewProvider}
 */
class ChatViewProvider {
  /**
   * @param {vscode.ExtensionContext} context
   */
  constructor(context) {
    /** @type {vscode.ExtensionContext} */
    this._context = context;
    /** @type {vscode.WebviewView | null} */
    this._view = null;
    /** @type {Array<ConversationMessage>} */
    this._conversation = [];
    /** @type {AbortController | null} */
    this._abortController = null;
    /** @type {vscode.Disposable | null} */
    this._msgListener = null;
    this._currentSession = null;
    this._activeModel = Settings.getDefaultModel();
    this._reasoningEffort = Settings.getReasoningEffort() || "medium";
    // approvalId -> { resolve, timer, toolName } for pending approval requests
    this._pendingApprovals = new Map();
    // Tool names approved "for this session" (cleared on session change)
    this._sessionApprovals = new Set();
    // MCP server ids approved "for this session" (server-level scope)
    this._sessionServerApprovals = new Set();
    this._restoreSession();
  }

  /**
   * @param {vscode.WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    log.appendLine("resolveWebviewView called");
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };
    const htmlPath = path.join(this._context.extensionPath, "webview-ui", "chat.html");
    const markedPath = path.join(this._context.extensionPath, "webview-ui", "marked.js");
    let html = fs.readFileSync(htmlPath, "utf-8");
    const markedJs = fs.readFileSync(markedPath, "utf-8");
    html = html.replace("</head>", "<script>" + markedJs + "</script></head>");
    webviewView.webview.html = html;
    this._postModels();

    // Restore saved session messages in the webview
    if (this._currentSession && this._conversation.length > 0) {
      webviewView.webview.postMessage({ type: "sessionSwitched", sessionId: this._currentSession });
      webviewView.webview.postMessage({ type: "historyRestored", messages: this._conversation });
    }
    // Remove old listener before adding new one (prevents duplicates)
    if (this._msgListener) this._msgListener.dispose();
    this._msgListener = webviewView.webview.onDidReceiveMessage((msg) => {
      log.appendLine("Received: " + msg.type);
      switch (msg.type) {
        case "configureModels":
          try {
            ModelConfigPanel.createOrShow(this._context, () => {
              this._postModels();
            });
          } catch (err) {
            vscode.window.showErrorMessage("CCE: " + (err instanceof Error ? err.message : String(err)));
          }
          break;
        case "setModel":
          if (msg.modelId) {
            this._activeModel = msg.modelId;
            Settings.setDefaultModel(msg.modelId);
            this._postModels();
          }
          break;
        case "requestModels":
          this._postModels();
          break;
        case "sendMessage":
          this._handleSendMessage(msg.messageId, msg.text, msg.images);
          break;
        case "cancelMessage":
          this._handleCancel();
          break;
        case "attachImage":
          this._handleAttachImage();
          break;
        case "newSession":
          this._newSession();
          break;
        case "switchSession":
          this._switchSession(msg.sessionId);
          break;
        case "deleteSession":
          this._deleteSession(msg.sessionId);
          break;
        case "setReasoningEffort":
          this._reasoningEffort = msg.effort;
          Settings.setReasoningEffort(msg.effort);
          break;
        case "requestSessions":
          this._postSessions();
          break;
        case "approvalResponse":
          this._handleApprovalResponse(msg);
          break;
      }
    });
  }

  _postModels() {
    if (!this._view) return;
    const models = Settings.getModels();
    log.appendLine("Posting modelsLoaded: " + models.length + " models");
    this._view.webview.postMessage({
      type: "modelsLoaded",
      models: models.map((m) => ({ id: m.id, name: m.name })),
      activeModel: this._activeModel,
      reasoningEffort: this._reasoningEffort,
    });
  }

  // ── sessions ──

  _restoreSession() {
    this._currentSession = Settings.getCurrentSessionId();
    if (this._currentSession) {
      const sessions = Settings.getSessions();
      const session = sessions.find((s) => s.id === this._currentSession);
      if (session) {
        this._conversation = session.messages || [];
      }
    }
  }

  _ensureSession() {
    if (!this._currentSession) {
      const id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
      this._currentSession = id;
      Settings.setCurrentSessionId(id);
    }
  }

  async _saveSession() {
    // Never save empty sessions
    if (!this._conversation || this._conversation.length === 0) return;

    this._ensureSession();
    const sessionId = /** @type {string} */ (this._currentSession);

    let sessions = Settings.getSessions();
    // Clean out any other empty sessions
    sessions = sessions.filter((s) => s.messages && s.messages.length > 0);
    let session = sessions.find((s) => s.id === sessionId);

    if (session) {
      session.messages = this._conversation;
      session.updatedAt = new Date().toISOString();
      // Auto-title from first user message if still generic
      if (session.title && session.title.startsWith("Chat ")) {
        const firstUser = this._conversation.find((m) => m.role === "user");
        if (firstUser) {
          session.title = (firstUser.content || "").slice(0, 50).replace(/\n/g, " ");
        }
      }
    } else {
      const now = new Date().toISOString();
      const firstUser = this._conversation.find((m) => m.role === "user");
      const title = firstUser ? (firstUser.content || "").slice(0, 50).replace(/\n/g, " ") : "Chat";
      sessions.push({
        id: sessionId,
        title,
        createdAt: now,
        updatedAt: now,
        messages: this._conversation,
      });
    }

    await Settings.setSessions(sessions);
  }

  _postSessions() {
    if (!this._view) return;
    // Filter out empty sessions when displaying
    const sessions = Settings.getSessions().filter((s) => s.messages && s.messages.length > 0);
    this._view.webview.postMessage({
      type: "sessionsLoaded",
      sessions,
      currentSessionId: this._currentSession,
    });
  }

  _newSession() {
    // Save current session first if it has content
    this._saveSession();
    // Reject any pending approvals — the user is moving on
    this._rejectAllPendingApprovals("Session changed");
    this._sessionApprovals.clear();
    this._sessionServerApprovals.clear();
    // Start fresh — session will be persisted only when first message is sent
    this._currentSession = null;
    this._conversation = [];
    Settings.setCurrentSessionId("");
    this._postSessions();
    if (this._view) {
      this._view.webview.postMessage({ type: "sessionSwitched", sessionId: "" });
      this._view.webview.postMessage({ type: "historyRestored", messages: [] });
    }
  }

  /**
   * @param {string} sessionId
   */
  _switchSession(sessionId) {
    // Save current session before switching away
    this._saveSession();
    // Pending approvals belong to the old session — deny them all
    this._rejectAllPendingApprovals("Session switched");
    this._sessionApprovals.clear();
    this._sessionServerApprovals.clear();
    const sessions = Settings.getSessions();
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    this._currentSession = sessionId;
    Settings.setCurrentSessionId(sessionId);
    this._conversation = session.messages || [];
    if (this._view) {
      this._view.webview.postMessage({ type: "sessionSwitched", sessionId });
      this._view.webview.postMessage({ type: "historyRestored", messages: this._conversation });
    }
  }

  /**
   * @param {string} sessionId
   */
  _deleteSession(sessionId) {
    let sessions = Settings.getSessions();
    sessions = sessions.filter((s) => s.id !== sessionId);
    Settings.setSessions(sessions);
    if (this._currentSession === sessionId) {
      if (sessions.length > 0) {
        this._switchSession(sessions[0].id);
      } else {
        this._currentSession = null;
        this._conversation = [];
        Settings.setCurrentSessionId("");
        if (this._view) this._view.webview.postMessage({ type: "historyRestored", messages: [] });
      }
    }
    this._postSessions();
  }

  // ── messaging ──

  /**
   * @param {string} messageId
   * @param {string} error
   */
  _postError(messageId, error) {
    if (this._view) this._view.webview.postMessage({ type: "error", messageId, error });
  }

  /**
   * @param {string} messageId
   * @param {string} text
   * @param {Array<{ id: string, name: string, dataUrl: string, size: number, warning: boolean }>} [images]
   * @returns {Promise<void>}
   */
  async _handleSendMessage(messageId, text, images) {
    const models = Settings.getModels();
    const modelConfig = models.find((m) => m.id === this._activeModel) || models[0];
    if (!modelConfig) {
      this._postError(messageId, "No model configured. Click the settings gear to add one.");
      return;
    }
    this._activeModel = modelConfig.id;

    const apiKey = (await Settings.getApiKey(modelConfig.id)) || "";
    const provider = getProvider(modelConfig.provider);
    if (!provider) {
      this._postError(messageId, "Unknown provider: " + modelConfig.provider);
      return;
    }
    this._conversation.push({ role: "user", content: text, images: images || [] });
    this._ensureSession();

    // Gather enabled tools
    let tools = getEnabledDefinitions(Settings.getToolSettings());

    // Fetch MCP tools (both HTTP and stdio)
    try {
      const mcpTools = await fetchMcpTools();
      tools = tools.concat(mcpTools);
    } catch (e) {
      log.appendLine("MCP fetch FAILED: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
    }

    // Build system prompt with context flags and AGENTS.md
    let systemPrompt = Settings.getSystemPrompt() || "";

    // Inject AGENTS.md content if enabled
    if (Settings.getUseAgentsMd()) {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
          const agentsPath = path.join(workspaceFolders[0].uri.fsPath, Settings.getAgentsMdPath());
          if (fs.existsSync(agentsPath)) {
            const agentsContent = fs.readFileSync(agentsPath, "utf-8");
            systemPrompt = "<!-- AGENTS.md / Project Instructions -->\n" + agentsContent + "\n\n" + systemPrompt;
          }
        }
      } catch (e) {
        log.appendLine("Failed to read AGENTS.md: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    // Inject context flags
    const contextFlags = Settings.getContextFlags();
    const contextParts = [];
    const now = new Date();
    if (contextFlags.includeDate !== false) {
      contextParts.push("Current date: " + now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }));
    }
    if (contextFlags.includeOS !== false) {
      contextParts.push("Platform/OS: " + process.platform);
      // Shell used by the run_command tool (child_process.exec), not the user's terminal
      contextParts.push(describeShellBrief());
    }
    if (contextFlags.includeRegion !== false) {
      contextParts.push("Locale: " + (Intl.DateTimeFormat().resolvedOptions().locale || "unknown") + ", Timezone: " + (Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"));
    }
    if (contextParts.length > 0) {
      systemPrompt = "<!-- Context -->\n" + contextParts.join("\n") + "\n\n" + systemPrompt;
    }

    // Tools may require user approval before executing
    if (tools.length > 0) {
      systemPrompt +=
        "\n\nImportant: Some tool calls require user approval. If a tool call is denied or returns an approval error, " +
        "do not retry the same tool call. Adapt your answer based on the information you already have.";
    }

    const messages = this._convertToChatMessages(systemPrompt);
    log.appendLine("Sending " + tools.length + " total tools to model");
    this._abortController = new AbortController();

    try {
      await this._chatLoop(messageId, messages, modelConfig, apiKey, provider, tools);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (this._view) this._view.webview.postMessage({ type: "responseComplete", messageId });
        return;
      }
      this._postError(messageId, err instanceof Error ? err.message : String(err));
    } finally {
      this._abortController = null;
    }
  }

  /**
   * @param {string} messageId
   * @param {Array<import("./providers/openai").ChatMessage>} messages
   * @param {import("./config/Settings").ModelConfig} modelConfig
   * @param {string} apiKey
   * @param {import("./providers/registry").Provider} provider
   * @param {Array<import("./tools/definitions").ToolDefinition>} tools
   * @returns {Promise<void>}
   */
  async _chatLoop(messageId, messages, modelConfig, apiKey, provider, tools) {
    const signal = this._abortController ? this._abortController.signal : undefined;
    const result = await provider.chat(
      messages, modelConfig.modelId, modelConfig.endpoint, apiKey,
      (chunk) => { if (this._view) this._view.webview.postMessage({ type: "partialResponse", messageId, text: chunk }); },
      signal,
      tools.length > 0 ? tools : undefined,
      (thinking) => { if (this._view) this._view.webview.postMessage({ type: "thinkingDelta", messageId, text: thinking }); },
      this._reasoningEffort
    );

    if (result.toolCalls && result.toolCalls.length > 0) {
      messages.push({ role: "assistant", content: null, tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        let toolResult, toolArgs;
        try {
          toolArgs = JSON.parse(tc.function.arguments || "{}");
        } catch (e) {
          toolResult = "Error: invalid tool arguments: " + (e instanceof Error ? e.message : String(e));
          toolArgs = {};
        }

        // Approval gate — no tool executes without passing the policy check
        const decision = await this._requestApproval(tc.function.name, toolArgs);
        if (decision.decision !== "allow") {
          toolResult =
            "Error: user denied approval for tool `" + tc.function.name + "`" +
            (decision.reason ? " (" + decision.reason + ")" : "") +
            ". Do not retry this tool call — adapt your answer without it.";
        } else {
          if (this._view) this._view.webview.postMessage({ type: "toolStatus", text: "Running " + tc.function.name + toolStatusSuffix(tc.function.name, toolArgs) });
          try {
            // Route MCP tools to the MCP client
            if (tc.function.name.startsWith("mcp__")) {
              const parts = tc.function.name.split("__");
              const serverId = parts[1];
              const toolName = parts.slice(2).join("__");
              toolResult = await callMcpTool(serverId, toolName, toolArgs);
            } else if (tc.function.name === "agent") {
              // Approving the agent call trusts everything its sub-agents do
              toolResult = await this._runAgent(toolArgs, modelConfig, apiKey, provider);
            } else {
              toolResult = await executeToolCall(tc.function.name, toolArgs);
            }
          } catch (e) {
            toolResult = "Error: " + (e instanceof Error ? e.message : String(e));
          }
        }

        // Show tool details in chat
        if (this._view) {
          this._view.webview.postMessage({
            type: "toolCall",
            messageId,
            toolName: tc.function.name,
            args: JSON.stringify(toolArgs, null, 2),
            result: String(toolResult).slice(0, 2000),
          });
        }

        messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
      }
      await this._chatLoop(messageId, messages, modelConfig, apiKey, provider, tools);
      return;
    }

    this._conversation.push({ role: "assistant", content: result.text });
    await this._saveSession();

    log.appendLine("Response: text=" + (result.text ? result.text.length + " chars" : "empty") + ", thinking=" + (result.thinking ? result.thinking.length + " chars" : "none"));

    // If the model only produced thinking/reasoning but no text,
    // send the thinking content as the visible response
    if (!result.text && result.thinking && this._view) {
      log.appendLine("Fallback: sending thinking as response");
      this._view.webview.postMessage({ type: "partialResponse", messageId, text: result.thinking });
    }

    if (this._view) this._view.webview.postMessage({ type: "responseComplete", messageId });
  }

  /**
   * Run parallel sub-agents, each with a task and access to tools (except `agent`).
   * @param {{ tasks?: Array<string> }} args
   * @param {import("./config/Settings").ModelConfig} modelConfig
   * @param {string} apiKey
   * @param {import("./providers/registry").Provider} provider
   * @returns {Promise<string>}
   */
  async _runAgent(args, modelConfig, apiKey, provider) {
    const tasks = args.tasks || [];
    if (!tasks.length) return "No tasks provided.";

    // Give sub-agents all tools except 'agent' (prevents infinite recursion)
    let subTools = getEnabledDefinitions(Settings.getToolSettings())
      .filter(t => t.function.name !== "agent");

    // Also include MCP tools so sub-agents can search the web, etc.
    try {
      const mcpTools = await fetchMcpTools();
      subTools = subTools.concat(mcpTools.filter(t => t.function.name !== "agent"));
    } catch (e) {
      log.appendLine("Agent: MCP fetch failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
    }

    log.appendLine("Agent: spawning " + tasks.length + " sub-agents with " + subTools.length + " tools");

    const MAX_TOOL_ROUNDS = 10; // Prevent infinite loops

    const results = await Promise.all(tasks.map(async (task, i) => {
      try {
        /** @type {Array<import("./providers/openai").ChatMessage>} */
        const messages = [{ role: "user", content: String(task) }];
        let round = 0;

        while (round < MAX_TOOL_ROUNDS) {
          round++;
          const result = await provider.chat(
            messages,
            modelConfig.modelId, modelConfig.endpoint, apiKey,
            () => {}, // no streaming for sub-agents
            new AbortController().signal,
            subTools.length > 0 ? subTools : undefined,
            undefined, // no thinking callback for sub-agents
            this._reasoningEffort
          );

          // If the model returned tool calls, execute them and loop
          if (result.toolCalls && result.toolCalls.length > 0) {
            log.appendLine("Agent task " + (i + 1) + " round " + round + ": " + result.toolCalls.length + " tool call(s)");
            messages.push({ role: "assistant", content: null, tool_calls: result.toolCalls });

            for (const tc of result.toolCalls) {
              let toolResult, toolArgs;
              try {
                toolArgs = JSON.parse(tc.function.arguments || "{}");

                // Route MCP tools to the MCP client
                if (tc.function.name.startsWith("mcp__")) {
                  const parts = tc.function.name.split("__");
                  const serverId = parts[1];
                  const toolName = parts.slice(2).join("__");
                  toolResult = await callMcpTool(serverId, toolName, toolArgs);
                } else {
                  toolResult = await executeToolCall(tc.function.name, toolArgs);
                }
              } catch (e) {
                toolResult = "Error: " + (e instanceof Error ? e.message : String(e));
                toolArgs = {};
              }

              messages.push({ role: "tool", tool_call_id: tc.id, content: String(toolResult) });
            }

            // Continue the loop to let the model process tool results
            continue;
          }

          // No tool calls — model produced a final answer
          return "Task " + (i + 1) + " result:\n" + (result.text || "(no output)");
        }

        // Exhausted max rounds — ask model for one final summary (no tools)
        log.appendLine("Agent task " + (i + 1) + ": max rounds reached, requesting final summary");
        const finalResult = await provider.chat(
          messages.concat([{ role: "user", content: "You have reached the maximum number of tool-calling rounds. Please provide your best answer now based on the information gathered so far. Do not call any more tools." }]),
          modelConfig.modelId, modelConfig.endpoint, apiKey,
          () => {},
          new AbortController().signal,
          undefined, // no tools available for final summary
          undefined, // no thinking callback for sub-agents
          this._reasoningEffort
        );
        return "Task " + (i + 1) + " result (max rounds reached):\n" + (finalResult.text || "(no output)");
      } catch (e) {
        return "Task " + (i + 1) + " error: " + (e instanceof Error ? e.message : String(e));
      }
    }));

    return results.join("\n\n");
  }

  // ── image attachment ──

  async _handleAttachImage() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
      title: "Attach Images",
    });
    if (!uris || uris.length === 0) return;

    const result = await this._validateAndEncodeImages(uris);
    if (this._view) {
      if (result.images.length > 0) {
        this._view.webview.postMessage({ type: "imagesAttached", images: result.images });
      }
      if (result.errors.length > 0) {
        this._view.webview.postMessage({ type: "imagesAttachedError", errors: result.errors });
      }
    }
  }

  /**
   * @param {Array<vscode.Uri>} uris
   */
  async _validateAndEncodeImages(uris) {
    const images = [];
    const errors = [];
    const MAX_SOFT = 5 * 1024 * 1024; // 5MB
    const MAX_HARD = 20 * 1024 * 1024; // 20MB

    for (const uri of uris) {
      try {
        const stat = await fs.promises.stat(uri.fsPath);
        if (stat.size > MAX_HARD) {
          errors.push({ name: path.basename(uri.fsPath), error: "File exceeds 20MB limit (" + (stat.size / 1024 / 1024).toFixed(1) + "MB)" });
          continue;
        }
        const ext = path.extname(uri.fsPath).toLowerCase().replace(".", "");
        /** @type {Record<string, string>} */
        const mimeTypes = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
        const mime = mimeTypes[ext] || "image/png";
        const buffer = await fs.promises.readFile(uri.fsPath);
        const dataUrl = "data:" + mime + ";base64," + buffer.toString("base64");
        images.push({
          id: "img-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
          name: path.basename(uri.fsPath),
          dataUrl,
          size: stat.size,
          warning: stat.size > MAX_SOFT,
        });
      } catch (e) {
        errors.push({ name: path.basename(uri.fsPath), error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { images, errors };
  }

  /**
   * Convert the in-memory conversation plus system prompt into
   * OpenAI-style chat messages (including image content parts).
   * @param {string} systemPrompt
   * @returns {Array<import("./providers/openai").ChatMessage>}
   */
  _convertToChatMessages(systemPrompt) {
    const messages = [];
    if (systemPrompt.trim()) {
      messages.push({ role: "system", content: systemPrompt.trim() });
    }
    for (const m of this._conversation) {
      if (m.images && m.images.length > 0) {
        /** @type {Array<import("./providers/openai").ContentPart>} */
        const content = [
          { type: "text", text: m.content || "" },
          ...m.images.map((img) => /** @type {import("./providers/openai").ContentPart} */ ({ type: "image_url", image_url: { url: img.dataUrl } })),
        ];
        messages.push({ role: m.role, content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }
    return messages;
  }

  _handleCancel() {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    // Any tool calls waiting on approval belong to the cancelled request
    this._rejectAllPendingApprovals("Request cancelled");
  }

  // ── tool approval gate ──

  /**
   * Gate a tool call behind user approval. Resolves to a decision object:
   *   { decision: "allow", mode }  → run the tool
   *   { decision: "deny", mode, reason } → do not run it
   *
   * Auto-approved when the resolved policy is "auto"; denied immediately
   * when it is "deny", when no webview is available, or on timeout.
   *
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<{ decision: "allow"|"deny", mode: "auto"|"ask"|"deny", reason?: string }>}
   */
  async _requestApproval(toolName, args) {
    const mode = approval.resolveMode(
      toolName,
      this._sessionApprovals,
      Settings.getToolApprovalModes(),
      Settings.getMcpApprovalModes(),
      this._sessionServerApprovals
    );

    if (mode === "auto") {
      return { decision: "allow", mode };
    }
    if (mode === "deny") {
      log.appendLine("Approval: " + toolName + " denied by policy");
      return { decision: "deny", mode, reason: "Denied by approval policy" };
    }
    if (!this._view) {
      log.appendLine("Approval: no chat view, auto-denying " + toolName);
      return { decision: "deny", mode, reason: "Chat view is not available" };
    }
    const view = this._view;

    return new Promise((resolve) => {
      const approvalId = "apr-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      const risk = approval.classifyTool(toolName);
      const timer = setTimeout(() => {
        log.appendLine("Approval: " + approvalId + " (" + toolName + ") timed out");
        this._pendingApprovals.delete(approvalId);
        resolve({ decision: "deny", mode, reason: "Approval request timed out" });
      }, approval.APPROVAL_TIMEOUT_MS);

      this._pendingApprovals.set(approvalId, { resolve, timer, toolName });

      log.appendLine("Approval: requesting approval for " + toolName + " (" + approvalId + ")");
      view.webview.postMessage({ type: "toolStatus", text: "Awaiting approval: " + toolName + toolStatusSuffix(toolName, args) });

      // Include the server name for MCP tools so the card can show a
      // readable label and offer server-level actions.
      const serverId = approval.getMcpServerId(toolName);
      const server = serverId
        ? (Settings.getMcpServers().find((s) => s.id === serverId) || null)
        : null;

      view.webview.postMessage({
        type: "approvalRequest",
        approvalId,
        toolName,
        args: JSON.stringify(args || {}, null, 2),
        risk,
        riskLabel: approval.riskLabel(risk),
        serverId: serverId || undefined,
        serverLabel: server ? server.name : undefined,
      });
    });
  }

  /**
   * Handle an approval response from the webview.
   * @param {{ approvalId: string, decision: "allow"|"allowSession"|"alwaysAllow"|"deny" }} msg
   */
  _handleApprovalResponse(msg) {
    const pending = this._pendingApprovals.get(msg.approvalId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingApprovals.delete(msg.approvalId);

    const serverId = approval.getMcpServerId(pending.toolName);
    const isMcp = serverId !== null;

    switch (msg.decision) {
      case "allow":
        log.appendLine("Approval: " + pending.toolName + " allowed");
        pending.resolve({ decision: "allow", mode: "ask" });
        break;
      case "allowSession":
        if (isMcp) {
          // MCP session approval is server-level: approving one tool
          // approves every tool this server exposes for the session.
          log.appendLine("Approval: MCP server " + serverId + " allowed for session");
          this._sessionServerApprovals.add(serverId);
          pending.resolve({ decision: "allow", mode: "ask" });
        } else {
          log.appendLine("Approval: " + pending.toolName + " allowed for session");
          this._sessionApprovals.add(pending.toolName);
          pending.resolve({ decision: "allow", mode: "ask" });
        }
        break;
      case "alwaysAllow":
        if (isMcp) {
          log.appendLine("Approval: MCP server " + serverId + " set to always allow");
          Settings.setMcpApprovalMode(serverId, "auto");
          pending.resolve({ decision: "allow", mode: "auto" });
        } else {
          log.appendLine("Approval: " + pending.toolName + " set to always allow");
          Settings.setToolApprovalMode(pending.toolName, "auto");
          this._sessionApprovals.add(pending.toolName);
          pending.resolve({ decision: "allow", mode: "auto" });
        }
        break;
      case "deny":
      default:
        log.appendLine("Approval: " + pending.toolName + " denied");
        pending.resolve({ decision: "deny", mode: "ask", reason: "Denied by user" });
        break;
    }
  }

  /**
   * Deny every pending approval request (e.g. on cancel or session change).
   * @param {string} reason
   */
  _rejectAllPendingApprovals(reason) {
    for (const [, pending] of this._pendingApprovals) {
      clearTimeout(pending.timer);
      pending.resolve({ decision: "deny", mode: "ask", reason });
    }
    this._pendingApprovals.clear();
  }

  // ── clean up ──

  dispose() {
    this._rejectAllPendingApprovals("Extension disposed");
    if (this._msgListener) this._msgListener.dispose();
  }
}

// ── extension entry points ──

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  log.appendLine("CCE activating\u2026");

  Settings.init(context);

  // Delete sessions older than the configured max age
  Settings.deleteExpiredSessions();

  // Register the chat view
  const chatProvider = new ChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("cce.chatView", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Register config panel command
  context.subscriptions.push(
    vscode.commands.registerCommand("cce.openChat", () => {
      vscode.commands.executeCommand("cce.chatView.focus");
    })
  );

  // Start all enabled stdio MCP servers
  _startMcpServers();

  // Restart MCP servers when config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cce")) {
        log.appendLine("Config changed, restarting MCP servers\u2026");
        // Restart all stdio servers (stop all, start enabled ones)
        processManager.stopAll();
        _startMcpServers();
      }
    })
  );

  log.appendLine("CCE activated");
}

/**
 * Start all enabled stdio-based MCP servers from settings.
 */
function _startMcpServers() {
  const servers = Settings.getMcpServers();
  for (const server of servers) {
    if (server.enabled !== false && server.command) {
      try {
        processManager.start({
          id: server.id,
          command: server.command,
          args: server.args,
        });
      } catch (e) {
        log.appendLine("Failed to start MCP server \"" + server.name + "\": " + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
}

/**
 * Clean shutdown: stop MCP server processes.
 */
function deactivate() {
  log.appendLine("CCE deactivating\u2026");
  processManager.stopAll();
  log.appendLine("CCE deactivated");
}

module.exports = { activate, deactivate };

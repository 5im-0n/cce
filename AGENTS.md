# AGENTS.md

## Project Overview

**CCE** (Code Chat Extension) is a VSCode extension that provides an AI-powered coding assistant inside the editor. Users converse with different LLM models to get help with code: ask questions, request refactors, generate tests, explain code, and more.

The assistant is agentic: it can act on the workspace through tools (read, edit, search, run commands) gated by a risk-based approval policy, and MCP servers can be registered to extend its tool set. Conversations persist as sessions and can be restored.

Several chats can be open at once: the sidebar chat plus any number of editor tabs, each with its own conversation, session, model, reasoning effort, Stop button and approval cards. A session is owned by one chat at a time. Editor tabs survive a window reload: each remembers the session it was showing (`setState`) and is recreated by a `WebviewPanelSerializer`. All chats share the workspace, so cross-chat tool conflicts are detected and surfaced as warnings in the approval card. The model dropdown is per chat and supports switching at runtime without restart.

> Note: this file is read by the extension and injected into the assistant's system prompt as project context — keep it accurate and concise.

## Tech Stack

- **Language:** Vanilla JavaScript (CommonJS)
- **Build:** None — files are used as-is
- **UI:** Plain HTML/CSS/JS in a VSCode Webview (marked.js inlined at runtime)
- **Testing:** Node built-in test runner (`node --test`)
- **Linting:** ESLint
- **Type checking:** JSDoc + jsconfig (`checkJs`)
- **Runtime:** Node.js (LTS, target VSCode's built-in Node)
- **VSCode API:** vscode namespace only (no unofficial/internal APIs)

## Coding Conventions

- **Vanilla JavaScript.** CommonJS (`require`/`module.exports`) throughout.
- **JSDoc** on all public functions and objects. Describe parameters, return types, and purpose.
- **No implicit returns** that are unclear — prefer explicit `return` statements.
- **Error handling:** Providers must catch and wrap their errors into a common `ProviderError` class. The UI must never see raw provider errors.
- **Naming:** PascalCase for classes, camelCase for variables/functions, kebab-case for file names.
- **No classes unless necessary** — prefer plain objects and factory functions over `class` syntax.
- **One concern per file** — each file does one thing well.
- **Logging:** Use `vscode.window.createOutputChannel("CCE")` for logs. Never `console.log`.

## Key Design Decisions

1. **Webview UI is plain HTML/CSS/JS.** No framework overhead.
2. **No secrets in the webview.** API keys stay in the extension host.
3. **Model selection is a dropdown in the chat header.** Each chat remembers its model and reasoning effort on its session; changing the model mid-conversation is allowed — subsequent messages use the new model. The last model picked anywhere also becomes the default for new chats.
4. **Conversation history lives on the extension host side** and persists as sessions; the webview only renders what it's told.
5. **Abort support:** every chat request supports an AbortSignal so the user can cancel a long response. Closing a chat tab aborts it, denies its pending approvals and saves the transcript.
6. **Extension size matters.** Keep dependencies minimal; prefer built-in Node modules.
7. **One chat = one controller.** `src/chat/manager.js` owns the open chats (sidebar + editor tabs) and session ownership; `src/chat/controller.js` is one chat's brain and never touches a webview directly — it posts through the sink installed by `attach()`. `src/chat/view.js` hosts a controller in either the sidebar view or an editor panel.
8. **Sessions are written through `Settings.mutateSessions`.** Never write the whole session array: several chats save concurrently and a blind write would drop another chat's save.
9. **Restorable UI state belongs to the webview.** The webview persists what it needs with `setState` (currently the session id of an editor tab); the host decodes it defensively in `src/chat/panel-state.js` and reopens accordingly. Never trust that state — a deleted session or a malformed value must fall back to a usable view, not an error.
10. **Sub-agents are ordinary chats, and only one implementation exists.** The `agent` tool is handled by the manager (`runVisibleAgents`), which opens one editor tab per task; there is no hidden runner. A child is therefore a normal chat: same tools, same approval cards (in its own tab — approving `agent` is *not* a blanket grant), same session rules, its own Stop button, and no tool-round cap (the request budget stops it gracefully). `src/chat/agent-run.js` is the pure part: task normalisation and the report shape.
11. **A run reports per-agent outcomes, never a bare string.** `handleSendMessage` resolves to a `TurnOutcome` (`ok` / `aborted` / `error` / `stopReason`) so the manager can tell a real answer from a crash, a stop or a budget stop; `formatAgentReport` then names every agent that did not finish. Closing an agent tab means the same as pressing its Stop. Never let a failure reach the parent model as an empty result.

## Before Implementing

**M.O.:** You act like Socrates. Always question the user's intent, probe for clarity, and surface tradeoffs and edge cases before writing any code. Before implementing, write out a clear plan — what files will change, what the architecture looks like, what risks exist. **Never implement until the user explicitly and unequivocally approves the plan.**

When the plan is approved, then:

1. Read the existing code first. Understand current patterns.
2. Check if a provider, type, or utility already exists before creating a new one.
3. Follow the existing message protocol — don't add new message types without keeping the extension host and webview in sync.
4. Keep the provider interface stable. New optional fields are OK; breaking changes require a migration plan.
5. Write tests for the code you implement. UI tests are optional.
6. Check the code is valid with `get_diagnostics`.

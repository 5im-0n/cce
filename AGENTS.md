# AGENTS.md

## Project Overview

**CCE** (Code Chat Extension) is a VSCode extension that provides an AI-powered coding assistant inside the editor. Users converse with different LLM models to get help with code: ask questions, request refactors, generate tests, explain code, and more.

The assistant is agentic: it can act on the workspace through tools (read, edit, search, run commands) gated by a risk-based approval policy, and MCP servers can be registered to extend its tool set. Conversations persist as sessions and can be restored.

The assistant panel lives in the VSCode sidebar and supports switching between models at runtime without restart.

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
3. **Model selection is a dropdown in the chat header.** Changing the model mid-conversation is allowed — subsequent messages use the new model.
4. **Conversation history lives on the extension host side** and persists as sessions; the webview only renders what it's told.
5. **Abort support:** every chat request supports an AbortSignal so the user can cancel a long response.
6. **Extension size matters.** Keep dependencies minimal; prefer built-in Node modules.

## Before Implementing

**M.O.:** You act like Socrates. Always question the user's intent, probe for clarity, and surface tradeoffs and edge cases before writing any code. Before implementing, write out a clear plan — what files will change, what the architecture looks like, what risks exist. **Never implement until the user explicitly and unequivocally approves the plan.**

When the plan is approved, then:

1. Read the existing code first. Understand current patterns.
2. Check if a provider, type, or utility already exists before creating a new one.
3. Follow the existing message protocol — don't add new message types without keeping the extension host and webview in sync.
4. Keep the provider interface stable. New optional fields are OK; breaking changes require a migration plan.
5. Write tests for providers and protocol logic. UI tests are optional.

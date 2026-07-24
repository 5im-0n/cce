# AGENTS.md

## Project Overview

**CCE** (Code Chat Extension) is a VSCode extension that provides an AI-powered chatbot inside the editor. Users can converse with different LLM models to get help with code: ask questions, request refactors, generate tests, explain code, and more.

The chatbot panel lives in the VSCode sidebar and supports switching between multiple model providers (OpenAI, Anthropic, local models via Ollama, etc.) at runtime without restart.

## Tech Stack

- **Language:** Vanilla JavaScript (ES modules, CommonJS where required by VSCode)
- **Runtime:** Node.js (LTS, target VSCode's built-in Node)
- **UI:** Plain HTML, CSS, and vanilla JavaScript in a VSCode Webview — no frameworks
- **Build:** None or minimal (copy files as-is; bundle only if needed)
- **Testing:** Node built-in test runner or mocha + @vscode/test-electron
- **Linting:** ESLint
- **VSCode API:** vscode namespace (no unofficial/internal APIs)

## Architecture Principles

### 1. Provider Abstraction
All model backends MUST implement a common `IModelProvider` interface. The chat logic must never depend on a specific provider. Adding a new provider means implementing the interface and registering it — zero changes to chat/UI code.

### 2. Extension Host / Webview Separation
- **Extension host** (Node.js process): all heavy lifting — calling LLM APIs, streaming responses, file system access, VSCode workspace APIs.
- **Webview** (browser context): rendering chat UI only. No direct API calls to LLMs. Communication via `postMessage` with a typed message protocol.

### 3. Streaming First
All model interactions must support streaming (tokens arrive incrementally). The message protocol must carry partial responses so the UI can render progressively.

### 4. Context Awareness
The chatbot can optionally include the current file, selection, or open tabs as context. Context injection is handled by the extension host before sending prompts to the model.

## Project Structure

```
cce/
├── AGENTS.md                  # This file
├── package.json               # Extension manifest & deps
├── jsconfig.json              # Basic JS config (checkJs, target)
├── .vscodeignore
├── src/
│   ├── extension.js           # activate/deactivate entry point
│   ├── chat/
│   │   ├── ChatPanel.js       # Webview panel management
│   │   └── MessageProtocol.js # Message type constants & helpers
│   ├── providers/
│   │   ├── registry.js        # Provider registry
│   │   ├── openai.js
│   │   ├── anthropic.js
│   │   └── ollama.js
│   ├── context/
│   │   └── ContextCollector.js # Gather file/selection/tab context
│   └── config/
│       └── Settings.js        # VSCode settings reader
├── webview-ui/                # Plain HTML/CSS/JS chat UI (no framework)
│   ├── index.html             # Main webview page
│   ├── styles.css             # Chat styling
│   ├── chat.js                # Chat UI logic
│   ├── renderer.js            # Message rendering helpers
│   └── protocol.js            # Message protocol constants
└── test/
    └── ...
```

## The Provider Contract

Every model provider is a plain object following this contract (documented with JSDoc in the code):

```js
/**
 * @typedef {Object} ModelProvider
 * @property {string} id           - Unique provider ID
 * @property {string} displayName  - Shown in the model picker
 * @property {function(): Promise<ModelInfo[]>} listModels - Return available models
 * @property {function(ChatMessage[], string, ChatOptions, function(string): void, AbortSignal=): Promise<ChatResult>} chat - Send a streaming chat request
 */
```

Every provider module exports an object with `id`, `displayName`, `listModels()`, and `chat()`.

The `chat` method calls `onPartial(text)` repeatedly as tokens arrive, and returns a final `{ text, usage }` result. It must respect the optional `AbortSignal`.

## Message Protocol (Extension Host ↔ Webview)

All messages are JSON-serializable plain objects with a `type` discriminant. The protocol shape is documented via JSDoc in `src/chat/MessageProtocol.js` and mirrored as constants in `webview-ui/protocol.js`.

**Host → Webview:**
- `{ type: "partialResponse", messageId, text }` — Streaming token chunk
- `{ type: "responseComplete", messageId }` — Final token received
- `{ type: "error", messageId, error }` — Request failed
- `{ type: "modelsLoaded", models }` — Available models list
- `{ type: "contextAttached", files }` — Context files added

**Webview → Host:**
- `{ type: "sendMessage", messageId, text, model }` — User sent a message
- `{ type: "cancelMessage", messageId }` — User cancelled
- `{ type: "requestModels" }` — Request model list
- `{ type: "requestContext", include }` — Request context injection

## Configuration

Controlled via VSCode settings (`contributes.configuration` in package.json):

| Setting | Type | Default | Description |
|---|---|---|---|
| `cce.openai.apiKey` | string | `""` | OpenAI API key |
| `cce.anthropic.apiKey` | string | `""` | Anthropic API key |
| `cce.ollama.endpoint` | string | `"http://localhost:11434"` | Ollama server URL |
| `cce.defaultModel` | string | `"gpt-4o"` | Default model ID |
| `cce.context.includeCurrentFile` | boolean | `true` | Auto-include active file |
| `cce.context.includeSelection` | boolean | `true` | Auto-include selection |
| `cce.context.maxTokens` | number | `8000` | Max context tokens |

## Coding Conventions

- **Vanilla JavaScript.** Use ES modules (`import`/`export`) in extension code. Webview code uses `<script>` tags since webviews don't support ES modules directly.
- **JSDoc** on all public functions and objects. Describe parameters, return types, and purpose.
- **No implicit returns** that are unclear — prefer explicit `return` statements.
- **Error handling:** Providers must catch and wrap their errors into a common `ProviderError` class. The UI must never see raw provider errors.
- **Naming:** PascalCase for classes, camelCase for variables/functions, kebab-case for file names.
- **No classes unless necessary** — prefer plain objects and factory functions over `class` syntax.
- **One concern per file** — each file does one thing well.
- **Logging:** Use `vscode.window.createOutputChannel("CCE")` for logs. Never `console.log`.

## Key Design Decisions

1. **Webview UI is plain HTML/CSS/JS.** No framework overhead. The chat UI is simple enough (message list, input box, model dropdown) that a framework adds unnecessary complexity and bundle size.

2. **No secrets in webview.** API keys stay in the extension host. The webview never sees them. It only sends user message text.

3. **Model selection is a dropdown in the chat header**, populated from the provider registry. Changing the model mid-conversation is allowed — subsequent messages use the new model.

4. **Conversation history** is kept in memory on the extension host side, not in the webview. The webview only renders what it's told to render. This prevents drift between what the model sees and what the user sees.

5. **Abort support:** Every chat request supports an AbortSignal so the user can cancel a long response.

6. **Extension size matters.** Keep dependencies minimal. Prefer VSCode's built-in Node modules when possible. Bundle all code into a single `.js` file.

## Commands

The extension contributes these commands to the command palette:

- `cce.openChat` — Opens/focuses the chat panel
- `cce.explainCode` — Sends selection to chat with "Explain this code" prompt
- `cce.refactorCode` — Sends selection to chat with "Refactor this code" prompt
- `cce.generateTests` — Sends selection to chat with "Generate tests for this code" prompt
- `cce.clearChat` — Clears conversation history

## Before Implementing

**M.O.:** You act like Socrates. Always question the user's intent, probe for clarity, and surface tradeoffs and edge cases before writing any code. Before implementing, write out a clear plan — what files will change, what the architecture looks like, what risks exist. **Never implement until the user explicitly and unequivocally approves the plan.**

When the plan is approved, then:

1. Read the existing code first. Understand current patterns.
2. Check if a provider, type, or utility already exists before creating a new one.
3. Follow the existing message protocol — don't add new message types without updating this document.
4. Keep the provider interface stable. New optional fields are OK; breaking changes require a migration plan.
5. Write tests for providers and protocol logic. UI tests are optional.

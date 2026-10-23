const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return { window: { createOutputChannel: () => ({ appendLine() {} }) } };
  }
  return originalLoad(request, parent, isMain);
};
const openai = require("../src/providers/openai");
const anthropic = require("../src/providers/anthropic");
const ProviderError = require("../src/providers/provider-error");
Module._load = originalLoad;

const messages = [{ role: "system", content: "Be helpful" }, { role: "user", content: "Hi" }];
const tools = [{ type: "function", function: { name: "read_file", description: "Read", parameters: { type: "object" } } }];

/** Stub fetch with a real SSE stream and capture the outgoing JSON. */
function captureRequests(t, events = []) {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200, headers: { "Content-Type": "text/event-stream" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });
  return requests;
}

test("Chat Completions passes OpenRouter parameters and explicit thinking with reasoning Off", async (t) => {
  const requests = captureRequests(t, [{ choices: [{ delta: { content: "Hello" } }] }]);
  const signal = new AbortController().signal;
  const parameters = { provider: { quantizations: ["fp16", "bf16"] }, reasoning: { effort: "xHigh" }, temperature: 0.3 };
  const chunks = [];
  const result = await openai.chat(messages, "model", "https://openrouter.ai/api/v1/", "secret", chunk => chunks.push(chunk),
    signal, tools, undefined, "off", parameters);
  assert.equal(requests[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(requests[0].body, { model: "model", messages, stream: true, tools, ...parameters });
  assert.equal(requests[0].headers.Authorization, "Bearer secret");
  assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(chunks, ["Hello"]);
  assert.equal(result.text, "Hello");
  assert.equal(parameters.reasoning.effort, "xHigh");
});

test("Responses overrides generated effort unchanged and preserves summary and converted tools", async (t) => {
  const requests = captureRequests(t, [{ type: "response.output_text.delta", delta: "Hello" }]);
  const parameters = { reasoning: { effort: "xHigh" }, max_output_tokens: 5000 };
  const result = await openai.chat(messages, "model", "https://api.example.com/v1", "secret", () => {},
    undefined, tools, undefined, "high", parameters);
  const body = requests[0].body;
  assert.match(requests[0].url, /\/responses$/);
  assert.deepEqual(body.reasoning, { effort: "xHigh", summary: "auto" });
  assert.equal(body.instructions, "Be helpful");
  assert.deepEqual(body.input, [{ role: "user", content: "Hi" }]);
  assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "Read", parameters: { type: "object" } }]);
  assert.equal(body.max_output_tokens, 5000);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(result.text, "Hello");
});

test("Anthropic accepts custom thinking and max_tokens after constructing Messages body", async (t) => {
  const requests = captureRequests(t, [{ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }]);
  const parameters = { thinking: { type: "enabled", budget_tokens: 6000 }, max_tokens: 8192, output_config: { effort: "custom" } };
  const result = await anthropic.chat(messages, "claude", "https://api.anthropic.com/v1", "secret", () => {},
    undefined, tools, undefined, "high", parameters);
  assert.match(requests[0].url, /\/messages$/);
  assert.deepEqual(requests[0].body, {
    model: "claude", messages: [{ role: "user", content: "Hi" }], stream: true, system: "Be helpful",
    tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }], ...parameters,
  });
  assert.equal(requests[0].headers["x-api-key"], "secret");
  assert.equal(requests[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(result.text, "Hello");
});

test("all API paths retain legacy behavior when parameters are omitted", async (t) => {
  const requests = captureRequests(t);
  await openai.chat(messages, "model", "https://example.com", "", () => {});
  await openai.chat(messages, "model", "https://example.com", "", () => {}, undefined, undefined, undefined, "medium");
  await anthropic.chat(messages, "model", "https://example.com", "", () => {});
  assert.deepEqual(requests[0].body, { model: "model", messages, stream: true });
  assert.deepEqual(requests[1].body, {
    model: "model", input: [{ role: "user", content: "Hi" }], stream: true, store: false,
    reasoning: { effort: "medium", summary: "auto" }, instructions: "Be helpful",
  });
  assert.deepEqual(requests[2].body, { model: "model", messages: [{ role: "user", content: "Hi" }], stream: true,
    max_tokens: 4096, system: "Be helpful" });
});

test("all API paths reject bad or managed parameters as common ProviderError before fetch", async (t) => {
  const requests = captureRequests(t);
  for (const [provider, effort] of [[openai, "off"], [openai, "high"], [anthropic, "off"]]) {
    for (const parameters of [{ stream: false }, { tools: [] }, [], { a: undefined }, JSON.parse('{"provider":{"__proto__":{}}}')]) {
      await assert.rejects(provider.chat(messages, "model", "https://example.com", "", () => {},
        undefined, undefined, undefined, effort, parameters), err => {
        assert.ok(err instanceof ProviderError);
        return true;
      });
    }
  }
  assert.equal(requests.length, 0);
});

test("common ProviderError wraps transport failures but preserves abort cancellation", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  for (const provider of [openai, anthropic]) {
    global.fetch = async () => { throw new TypeError("Network unavailable"); };
    await assert.rejects(provider.chat([], "model", "https://example.com", "", () => {}), err => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.message, "Network unavailable");
      return true;
    });
    const abort = new Error("Cancelled");
    abort.name = "AbortError";
    global.fetch = async () => { throw abort; };
    await assert.rejects(provider.chat([], "model", "https://example.com", "", () => {}), err => err === abort);
  }
});

test("later tool-loop requests use current conversation without mutating saved overrides", async (t) => {
  const requests = captureRequests(t);
  const parameters = { provider: { quantizations: ["fp16", "bf16"] } };
  const conversation = [{ role: "user", content: "Read" }];
  await openai.chat(conversation, "model", "https://example.com", "", () => {}, undefined, tools, undefined, "off", parameters);
  conversation.push({ role: "assistant", content: null, tool_calls: [{ id: "call", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call", content: "result" });
  await openai.chat(conversation, "model", "https://example.com", "", () => {}, undefined, tools, undefined, "off", parameters);
  assert.equal(requests[0].body.messages.length, 1);
  assert.equal(requests[1].body.messages.length, 3);
  assert.equal(requests[1].body.messages[2].content, "result");
  for (const request of requests) assert.deepEqual(request.body.provider, parameters.provider);
  assert.deepEqual(parameters, { provider: { quantizations: ["fp16", "bf16"] } });
});

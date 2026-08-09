/**
 * Tests for the Responses API content conversion in src/providers/openai.js
 * (_chatResponses). The Responses API rejects chat-completions part types
 * ("text", "image_url") — CCE must translate them to "input_text" /
 * "input_image" before sending, and emit assistant text before
 * function_call items. These tests capture the request body and assert on
 * the `input` array.
 * Run with: node --test test/openaiResponsesContent.test.js
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
const { ReadableStream } = require("node:stream/web");

const provider = require("../src/providers/openai");

// ── helpers ─────────────────────────────────────────────────

/** Build a fake streaming fetch Response that emits the given SSE events. */
function sseResponse(events) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      }
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: "OK", body };
}

/**
 * Run a chat call (reasoning active → /v1/responses) against a fetch stub
 * that captures the request body and returns a clean stream, then return
 * the parsed request body.
 * @param {Array<object>} messages
 * @returns {Promise<Record<string, any>>}
 */
async function captureResponsesBody(messages) {
  let captured;
  global.fetch = async (url, opts) => {
    assert.match(url, /\/responses$/);
    captured = JSON.parse(opts.body);
    return sseResponse([{ type: "response.completed" }]);
  };

  try {
    await provider.chat(
      messages,
      "gpt-5.6",
      "https://api.example.com/v1",
      "sk-test",
      () => {},
      undefined,
      undefined,
      undefined,
      "medium"
    );
  } finally {
    delete global.fetch;
  }
  return captured;
}

// ── tests ───────────────────────────────────────────────────

test("user message with an image becomes input_text + input_image with the data URL intact", async () => {
  const body = await captureResponsesBody([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ]);

  assert.equal(body.input.length, 1);
  assert.equal(body.input[0].role, "user");
  assert.deepEqual(body.input[0].content, [
    { type: "input_text", text: "What is in this image?" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ]);
  // No chat-completions part types may leak into the request
  const types = body.input[0].content.map((p) => p.type);
  assert.ok(!types.includes("text"));
  assert.ok(!types.includes("image_url"));
});

test("plain-text user message is left as the string shorthand", async () => {
  const body = await captureResponsesBody([{ role: "user", content: "hello" }]);
  assert.deepEqual(body.input, [{ role: "user", content: "hello" }]);
});

test("assistant text is emitted before function_call items", async () => {
  const body = await captureResponsesBody([
    {
      role: "assistant",
      content: "I will search for that.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search", arguments: '{"q":"x"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "results" },
  ]);

  const input = body.input;
  assert.equal(input.length, 3);
  // Assistant text comes first (canonical order: speak, then act)
  assert.deepEqual(input[0], { role: "assistant", content: "I will search for that." });
  assert.deepEqual(input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "search",
    arguments: '{"q":"x"}',
  });
  assert.deepEqual(input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "results",
  });
});

test("already Responses-shaped content items pass through untouched", async () => {
  const body = await captureResponsesBody([
    {
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    },
  ]);
  assert.deepEqual(body.input[0].content, [{ type: "input_text", text: "hi" }]);
});

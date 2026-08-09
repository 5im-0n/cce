/**
 * Tests for the reasoning hint appended to OpenAI /v1/responses HTTP 400
 * errors (src/providers/openai.js). The hint only fires when reasoning is
 * active (the _chatResponses path), never for the chat-completions path or
 * other status codes.
 * Run with: node --test test/openaiErrorHint.test.js
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

const provider = require("../src/providers/openai");

// ── helpers ─────────────────────────────────────────────────

/** Minimal fetch response shape for the error path (no body stream needed). */
function errorResponse(status, body) {
  return {
    ok: false,
    status,
    statusText: status === 400 ? "Bad Request" : "Internal Server Error",
    text: async () => JSON.stringify(body),
  };
}

/**
 * Run a chat call and return the rejected error (asserting it rejected).
 * @param {Promise<unknown>} promise
 * @returns {Promise<Error>}
 */
async function captureRejection(promise) {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected the chat call to reject");
  return err;
}

/** A real 400 body reported by an OpenAI-compatible endpoint. */
const REASONING_400_BODY = {
  error: {
    message:
      "Codex integration with deepseek-v4-pro will be available starting early August 2026. Please use deepseek-v4-flash\n  instead for now.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_request_error",
  },
};

const HINT = 'Reasoning effort to "Off"';

// ── tests ───────────────────────────────────────────────────

test("400 with reasoning active includes the hint and preserves the API message", async (t) => {
  t.after(() => {
    delete global.fetch;
  });
  global.fetch = async (url) => {
    assert.match(url, /\/responses$/);
    return errorResponse(400, REASONING_400_BODY);
  };

  const err = await captureRejection(
    provider.chat(
      [],
      "deepseek-v4-pro",
      "https://api.example.com/v1",
      "sk-test",
      () => {},
      undefined,
      undefined,
      undefined,
      "high"
    )
  );

  assert.equal(err.name, "ProviderError");
  assert.equal(err.status, 400);
  assert.match(err.message, /API error 400/);
  // The API's own guidance must still be visible.
  assert.match(err.message, /Please use deepseek-v4-flash/);
  assert.match(err.message, new RegExp(HINT));
  // The hint must explain that "Off" only skips the parameter and the
  // model may still reason internally — not that reasoning gets disabled.
  assert.match(err.message, /may still reason internally on its own/);
  assert.match(err.message, /stops sending that parameter/);
  assert.equal(err.body, JSON.stringify(REASONING_400_BODY));
});

test("400 with reasoning off (chat completions path) does not include the hint", async (t) => {
  t.after(() => {
    delete global.fetch;
  });
  global.fetch = async (url) => {
    assert.match(url, /\/chat\/completions$/);
    return errorResponse(400, REASONING_400_BODY);
  };

  const err = await captureRejection(
    provider.chat(
      [],
      "deepseek-v4-pro",
      "https://api.example.com/v1",
      "sk-test",
      () => {},
      undefined,
      undefined,
      undefined,
      "off"
    )
  );

  assert.equal(err.name, "ProviderError");
  assert.equal(err.status, 400);
  assert.doesNotMatch(err.message, /Hint:/);
});

test("500 with reasoning active does not include the hint", async (t) => {
  t.after(() => {
    delete global.fetch;
  });
  global.fetch = async () =>
    errorResponse(500, { error: { message: "upstream exploded", code: "server_error" } });

  const err = await captureRejection(
    provider.chat(
      [],
      "deepseek-v4-pro",
      "https://api.example.com/v1",
      "sk-test",
      () => {},
      undefined,
      undefined,
      undefined,
      "high"
    )
  );

  assert.equal(err.name, "ProviderError");
  assert.equal(err.status, 500);
  assert.doesNotMatch(err.message, /Hint:/);
});

/**
 * Tests for token estimation (src/context/estimate.js).
 * Pure module — no vscode stub needed.
 * Run with: node --test test/estimate.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateTextTokens,
  estimateImageTokens,
  estimateMessageTokens,
  estimateRequestTokens,
  formatTokenCount,
} = require("../src/context/estimate");

test("estimateTextTokens counts ~4 chars per token, 0 for empty", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("abcdefgh"), 2);
  assert.equal(estimateTextTokens("a"), 1); // rounds up
});

test("estimateImageTokens uses the size field when present", () => {
  // 500 base + 2048/2048 = 500 + 1 = 501
  assert.equal(estimateImageTokens({ size: 2048 }), 501);
  // 500 + 1024/2048 = 500.5 -> ceil 501
  assert.equal(estimateImageTokens({ size: 1024 }), 501);
  // 500 + 1048576/2048 = 500 + 512 = 1012
  assert.equal(estimateImageTokens({ size: 1048576 }), 1012);
});

test("estimateImageTokens derives bytes from the dataUrl when size is missing", () => {
  // "data:image/png;base64," prefix then 4 base64 chars = 3 bytes
  const dataUrl = "data:image/png;base64,AAAA";
  // bytes = 3 -> 500 + 3/2048 = 500.001... -> ceil 501
  assert.equal(estimateImageTokens({ dataUrl }), 501);
});

test("estimateMessageTokens sums text and all images", () => {
  const msg = {
    role: "user",
    content: "0123456789", // 10 chars -> 3 tokens (ceil 2.5)
    images: [{ size: 2048 }, { size: 2048 }],
  };
  // 3 + 501 + 501 = 1005
  assert.equal(estimateMessageTokens(msg), 1005);
});

test("estimateMessageTokens tolerates missing images field", () => {
  assert.equal(estimateMessageTokens({ role: "user", content: "abcd" }), 1);
  assert.equal(estimateMessageTokens({ role: "assistant", content: null }), 0);
});

test("estimateRequestTokens sums system prompt, summary, and messages", () => {
  const messages = [
    { role: "user", content: "0123456789" }, // 3
    { role: "assistant", content: "0123456789" }, // 3
  ];
  // system "abcd" -> 1, summary "abcd" -> 1, messages 6 -> total 8
  assert.equal(estimateRequestTokens("abcd", messages, "abcd"), 8);
  // without summary -> 7
  assert.equal(estimateRequestTokens("abcd", messages), 7);
});

test("formatTokenCount renders human-friendly magnitudes", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1500), "2K");
  assert.equal(formatTokenCount(1048576), "1.05M");
  assert.equal(formatTokenCount(0), "0");
});

/**
 * Tests for search_code matching logic (src/tools/search.js)
 * and the search_code tool definition (src/tools/definitions.js).
 * Run with: node --test test/search.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildFileGlob,
  findMatchesInLines,
  looksBinary,
} = require("../src/tools/search");
const { getEnabledDefinitions } = require("../src/tools/definitions");

// ── findMatchesInLines ─────────────────────────────────────

test("matches every line containing the pattern (lastIndex regression)", () => {
  // With the old `g`-flag implementation, RegExp#test carried lastIndex across
  // lines and silently skipped line 2. All matches must be reported.
  const matches = findMatchesInLines(["alpha beta", "beta", "alpha"], "beta");
  assert.deepEqual(
    matches.map((m) => m.line),
    [1, 2]
  );
});

test("returns 1-based line numbers with full line text", () => {
  const matches = findMatchesInLines(["zero", "hit here", "miss"], "hit");
  assert.deepEqual(matches, [{ line: 2, text: "hit here" }]);
});

test("treats the pattern as a literal string, not a regex", () => {
  const matches = findMatchesInLines(["a.b", "axb"], "a.b");
  assert.deepEqual(
    matches.map((m) => m.line),
    [1] // "a.b" must not match "axb"
  );
});

test("regex metacharacter patterns do not throw", () => {
  for (const p of ["[", "(", "a|b", "*", "\\", "?"]) {
    assert.doesNotThrow(() => findMatchesInLines(["x", p, "a|b"], p));
  }
});

test("matching is case-insensitive", () => {
  const matches = findMatchesInLines(["Hello World", "nope"], "hello");
  assert.equal(matches.length, 1);
});

test("no matches returns an empty array", () => {
  assert.deepEqual(findMatchesInLines(["a", "b"], "zzz"), []);
});

// ── buildFileGlob ──────────────────────────────────────────

test("no fileTypes returns the catch-all glob", () => {
  assert.equal(buildFileGlob(), "**/*");
  assert.equal(buildFileGlob(""), "**/*");
  assert.equal(buildFileGlob("   "), "**/*");
});

test("normalizes dots, whitespace and empty entries", () => {
  assert.equal(buildFileGlob(".js,.ts"), "**/*.{js,ts}");
  assert.equal(buildFileGlob(" js , ts ,,"), "**/*.{js,ts}");
});

test("single extension produces a single-entry brace glob", () => {
  assert.equal(buildFileGlob("py"), "**/*.{py}");
});

// ── looksBinary ────────────────────────────────────────────

test("detects NUL bytes as binary", () => {
  assert.equal(looksBinary(Buffer.from([0x48, 0x69])), false);
  assert.equal(looksBinary(Buffer.from([0x48, 0x00, 0x69])), true);
});

// ── definition sync ────────────────────────────────────────

test("search_code definition documents literal search, not ripgrep", () => {
  const tools = getEnabledDefinitions({});
  const searchCode = tools.find((t) => t.function.name === "search_code");
  assert.ok(searchCode, "search_code should be enabled by default");
  assert.ok(!/ripgrep/i.test(searchCode.function.description));
  assert.match(searchCode.function.description, /literal/i);
});

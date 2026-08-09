/**
 * Tests for search_code matching logic (src/tools/search.js)
 * and the search_code tool definition (src/tools/definitions.js).
 * Run with: node --test test/search.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  splitGlobs,
  buildIncludeGlob,
  buildExcludeGlob,
  findMatchesInLines,
  formatMatchLines,
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

test("limit stops early and signals at-least semantics", () => {
  const matches = findMatchesInLines(["a", "a", "a", "b"], "a", 2);
  assert.equal(matches.length, 2); // "at least 2" — caller treats this as capped
  // No limit collects everything
  assert.equal(findMatchesInLines(["a", "a", "a", "b"], "a").length, 3);
  // A limit larger than the match count returns all matches (not capped)
  assert.equal(findMatchesInLines(["a", "b"], "a", 5).length, 1);
});

// ── splitGlobs ─────────────────────────────────────────────

test("splits comma-separated globs, respecting brace groups", () => {
  assert.deepEqual(splitGlobs("{src/a.js,src/b.js}, src/**/*.ts"), [
    "{src/a.js,src/b.js}",
    "src/**/*.ts",
  ]);
  assert.deepEqual(splitGlobs("*.ts,  , **/*.js"), ["*.ts", "**/*.js"]);
});

test("a comma inside braces is not a separator", () => {
  assert.deepEqual(splitGlobs("**/*.{js,ts}"), ["**/*.{js,ts}"]);
});

test("empty, missing and non-string values yield no globs", () => {
  assert.deepEqual(splitGlobs(), []);
  assert.deepEqual(splitGlobs(null), []);
  assert.deepEqual(splitGlobs(""), []);
  assert.deepEqual(splitGlobs("   "), []);
  assert.deepEqual(splitGlobs(42), []);
});

// ── buildIncludeGlob ───────────────────────────────────────

test("include defaults to the all-files glob", () => {
  assert.equal(buildIncludeGlob(), "**/*");
  assert.equal(buildIncludeGlob(""), "**/*");
});

test("single include glob passes through verbatim (VSCode semantics)", () => {
  // No magic prefixing: "*.ts" is root-level only, exactly like VSCode search.
  assert.equal(buildIncludeGlob("*.ts"), "*.ts");
  assert.equal(buildIncludeGlob("**/*.ts"), "**/*.ts");
});

test("multiple include globs become a brace union", () => {
  assert.equal(buildIncludeGlob("*.ts, src/**/*.js"), "{*.ts,src/**/*.js}");
});

// ── buildExcludeGlob ───────────────────────────────────────

test("exclude defaults to undefined (files.exclude setting applies)", () => {
  assert.equal(buildExcludeGlob(), undefined);
  assert.equal(buildExcludeGlob(""), undefined);
});

test("exclude globs pass through or become a brace union", () => {
  assert.equal(
    buildExcludeGlob("**/node_modules/**"),
    "**/node_modules/**"
  );
  assert.equal(
    buildExcludeGlob("**/dist, **/.git/**"),
    "{**/dist,**/.git/**}"
  );
});

// ── formatMatchLines ───────────────────────────────────────

test("under-cap results pass through verbatim", () => {
  assert.equal(
    formatMatchLines(["a:1: x", "b:2: y"], 500, 500),
    "a:1: x\nb:2: y"
  );
});

test("exactly-at-cap results get no suffix", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `f${i}:1: x`);
  const out = formatMatchLines(lines, 500, 500);
  assert.ok(!out.includes("matches total"));
  assert.equal(out.split("\n").length, 500);
});

test("over-cap results get an honest summary suffix", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `f${i}:1: x`);
  const out = formatMatchLines(lines, 500, 500);
  assert.ok(out.includes("... (600 matches total; showing first 500"));
  assert.equal(out.split("\n").length, 501);
});

test("capped results report 500+ and files searched", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `f${i}:1: x`);
  const out = formatMatchLines(lines, 500, 500, { capped: true, filesSearched: 47 });
  assert.ok(
    out.includes("... (500+ matches in 47 files searched; showing first 500"),
    "suffix must say 500+ and name the file count"
  );
  // An explicit under-count: never claims "N matches total" when we stopped early.
  assert.ok(!out.includes("matches total"));
});

test("capped results without a file count omit the files part", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `f${i}:1: x`);
  const out = formatMatchLines(lines, 500, 500, { capped: true });
  assert.ok(out.includes("... (500+ matches; showing first 500"));
});

test("not capped at exactly maxShown gets no suffix", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `f${i}:1: x`);
  const out = formatMatchLines(lines, 500, 500, { capped: false });
  assert.ok(!out.includes("..."));
});

test("long lines are truncated per line", () => {
  const long = "x".repeat(1000);
  const out = formatMatchLines([`a:1: ${long}`], 500, 500);
  assert.ok(out.length < 550);
  assert.ok(out.endsWith("…"));
});

// ── looksBinary ────────────────────────────────────────────

test("detects NUL bytes as binary", () => {
  assert.equal(looksBinary(Buffer.from([0x48, 0x69])), false);
  assert.equal(looksBinary(Buffer.from([0x48, 0x00, 0x69])), true);
});

// ── definition sync ────────────────────────────────────────

test("search_code definition documents glob semantics and no fileTypes", () => {
  const tools = getEnabledDefinitions({});
  const searchCode = tools.find((t) => t.function.name === "search_code");
  assert.ok(searchCode, "search_code should be enabled by default");
  assert.ok(!/ripgrep/i.test(searchCode.function.description));
  assert.match(searchCode.function.description, /literal/i);

  const props = searchCode.function.parameters.properties;
  assert.ok(!("fileTypes" in props), "fileTypes should be removed");
  assert.ok("include" in props, "include should be documented");
  assert.ok("exclude" in props, "exclude should be documented");

  // Teaches the model how the tool works.
  assert.match(searchCode.function.description, /\*\*/, "teaches ** globs");
  assert.match(
    searchCode.function.description,
    /node_modules/,
    "warns nothing is auto-excluded"
  );
  assert.match(
    searchCode.function.description,
    /500\+/,
    "teaches that a capped result means more matches exist"
  );
});

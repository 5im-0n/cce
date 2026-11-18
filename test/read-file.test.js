/**
 * Integration tests for read_file through the actual tool executor.
 * Only vscode is stubbed; reads use real temporary files cleaned by node:test.
 * Run with: node --test test/read-file.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

/**
 * Load a fresh executor with a minimal vscode stub, restoring the loader and
 * module cache immediately so neither leaks into other tests.
 * @param {object} vscodeStub - Workspace/editor API needed by these tools.
 * @returns {typeof import("../src/tools/executor").executeToolCall}
 */
function loadExecutor(vscodeStub) {
  const executorPath = require.resolve("../src/tools/executor");
  const cached = require.cache[executorPath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return vscodeStub;
    return originalLoad(request, parent, isMain);
  };
  delete require.cache[executorPath];
  try {
    return require(executorPath).executeToolCall;
  } finally {
    Module._load = originalLoad;
    if (cached) require.cache[executorPath] = cached;
    else delete require.cache[executorPath];
  }
}

/**
 * Make distinguishable content lines without a trailing newline.
 * @param {number} count - Number of file-content lines.
 * @returns {string[]}
 */
function makeLines(count) {
  return Array.from({ length: count }, (_, index) => `content ${index + 1}`);
}

/**
 * Create an isolated workspace and register cleanup before writing its fixture.
 * @param {import("node:test").TestContext} t - Owning test, including cleanup.
 * @param {string[]} [lines] - File content split on newlines.
 * @returns {{ root: string, filePath: string, lines: string[], vscodeStub: any,
 *   executeToolCall: typeof import("../src/tools/executor").executeToolCall }}
 */
function createFixture(t, lines = makeLines(2600)) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cce-read-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = "sample.txt";
  fs.writeFileSync(path.join(root, filePath), lines.join("\n"), "utf8");
  const vscodeStub = {
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
    window: { activeTextEditor: undefined },
  };
  return { root, filePath, lines, vscodeStub, executeToolCall: loadExecutor(vscodeStub) };
}

/** Marker that starts the trailing "you did not see the rest" line. */
const UNREAD_FOOTER = "[End of returned range:";

/**
 * Assert every returned content line and its number, independently of the
 * header. Partial reads must advertise exactly the range actually returned —
 * in the header AND in a trailing line, so a model skimming the end of a long
 * result cannot mistake it for the whole file.
 * @param {string} result - Actual executor output.
 * @param {{ filePath: string, lines: string[] }} fixture - Original file.
 * @param {number} first - Expected first line (1-based).
 * @param {number} count - Expected number of returned file-content lines.
 * @returns {void}
 */
function assertReadRange(result, fixture, first, count) {
  const separator = result.indexOf("\n");
  assert.ok(separator >= 0, "file header must be separate from its content");
  const header = result.slice(0, separator);
  const rest = result.slice(separator + 1);
  const footerAt = rest.startsWith(UNREAD_FOOTER) ? 0 : rest.indexOf("\n" + UNREAD_FOOTER);
  const body = footerAt === -1 ? rest : rest.slice(0, footerAt);
  const footer = footerAt === -1 ? "" : rest.slice(footerAt + (footerAt === 0 ? 0 : 1));
  assert.ok(header.startsWith(`File: ${fixture.filePath} (${fixture.lines.length} lines total`));
  const expected = fixture.lines.slice(first - 1, first - 1 + count)
    .map((line, index) => `${first + index}: ${line}`).join("\n");
  assert.equal(body.split("\n").length, count, "header must not consume a content-line slot");
  // Check length first to keep failures for very long lines readable.
  assert.equal(body.length, expected.length, "file content must not be character-truncated");
  assert.equal(body, expected, "all content and original line numbers must be preserved");
  if (count < fixture.lines.length || header.includes("showing lines")) {
    const range = header.match(/showing lines (\d+)-(\d+)/);
    assert.ok(range, "partial reads must report their actual range");
    assert.equal(Number(range[1]), first);
    assert.equal(Number(range[2]), first + count - 1);
  }
  // A partial read says at the end which lines it left out; a complete one
  // says nothing (there is nothing to warn about).
  const isPartial = first > 1 || first + count - 1 < fixture.lines.length;
  assert.equal(Boolean(footer), isPartial && count > 0, "the unread-range footer appears exactly on partial reads");
  if (footer) {
    assert.match(footer, new RegExp(`lines ${first}-${first + count - 1} of ${fixture.lines.length}`));
    assert.match(footer, /were NOT read/);
    const missing = first > 1 ? `1-${first - 1}` : "";
    const trailing = first + count - 1 < fixture.lines.length ? `${first + count}-${fixture.lines.length}` : "";
    const expectedRanges = [missing, trailing].filter(Boolean).join(" and ");
    assert.ok(footer.includes(expectedRanges), `footer must name the unread lines (${expectedRanges})`);
  }
}

for (const total of [501, 2600]) {
  test(`read_file defaults to 500 content lines in a ${total}-line file`, async (t) => {
    const fixture = createFixture(t, makeLines(total));
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath });
    assertReadRange(result, fixture, 1, 500);
  });
}

for (const [limit, count] of [[230, 230], [2000, 2000], [5000, 2000], [Number.MAX_VALUE, 2000]]) {
  test(`read_file explicit limit ${limit} returns ${count} content lines`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath, limit });
    assertReadRange(result, fixture, 1, count);
  });
}

for (const { offset, limit, count } of [
  { offset: 321, limit: undefined, count: 500 },
  { offset: 137, limit: 230, count: 230 },
  { offset: 301, limit: 2000, count: 2000 },
  { offset: 301, limit: 5000, count: 2000 },
  { offset: 2598, limit: 230, count: 3 },
  { offset: 2600, limit: 230, count: 1 },
]) {
  test(`read_file offset ${offset}, limit ${limit} preserves numbering and range`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath, offset, limit });
    assertReadRange(result, fixture, offset, count);
  });
}

for (const limit of [undefined, 230, 2000]) {
  test(`read_file short file with limit ${limit} returns only its actual lines`, async (t) => {
    const fixture = createFixture(t, ["first", "second", "third"]);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath, limit });
    assertReadRange(result, fixture, 1, 3);
  });
}

for (const offset of [2601, 9000, Number.MAX_VALUE]) {
  test(`read_file offset ${offset} beyond EOF has no content or misleading numeric range`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath, offset, limit: 230 });
    const [header, ...body] = result.split("\n");
    assert.ok(header.startsWith(`File: ${fixture.filePath} (2600 lines total`));
    assert.equal(body.join("\n"), "");
    // Require an empty-range indication without pinning its exact wording.
    assert.match(header, /\b(?:no|zero|empty)\b|\b0 lines\b/i);
    assert.doesNotMatch(header, /showing lines\s+\d+\s*-\s*\d+/i);
    assert.doesNotMatch(result, /^\d+: /m);
  });
}

for (const { label, lines } of [
  { label: "empty file", lines: [""] },
  { label: "trailing newline", lines: ["first", "second", ""] },
]) {
  test(`read_file preserves existing split-on-newline semantics for ${label}`, async (t) => {
    const fixture = createFixture(t, lines);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath });
    assertReadRange(result, fixture, 1, lines.length);
  });
}

const invalidNumbers = [
  { label: "zero", value: 0 },
  { label: "negative", value: -5 },
  { label: "negative fraction", value: -0.3 },
  { label: "NaN", value: NaN },
  { label: "Infinity", value: Infinity },
  { label: "-Infinity", value: -Infinity },
  { label: "null", value: null },
  { label: "numeric string", value: "230" },
  { label: "boolean", value: true },
  { label: "object", value: {} },
  { label: "array", value: [] },
];

for (const { label, value } of invalidNumbers) {
  test(`read_file ${label} limit falls back to 500`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", {
      path: fixture.filePath, offset: 31, limit: value,
    });
    assertReadRange(result, fixture, 31, 500);
  });

  test(`read_file ${label} offset falls back to line 1`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", {
      path: fixture.filePath, offset: value, limit: 3,
    });
    assertReadRange(result, fixture, 1, 3);
  });
}

for (const [limit, count] of [[230.9, 230], [0.2, 1], [2000.9, 2000], [5000.9, 2000]]) {
  test(`read_file positive fractional limit ${limit} normalizes to ${count}`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", { path: fixture.filePath, limit });
    assertReadRange(result, fixture, 1, count);
  });
}

for (const [offset, first] of [[2.9, 2], [0.2, 1]]) {
  test(`read_file positive fractional offset ${offset} normalizes to line ${first}`, async (t) => {
    const fixture = createFixture(t);
    const result = await fixture.executeToolCall("read_file", {
      path: fixture.filePath, offset, limit: 2.9,
    });
    assertReadRange(result, fixture, first, 2);
  });
}

for (const length of [9001, 26001]) {
  for (const offsetOnly of [false, true]) {
    test(`read_file preserves a ${length}-character line (${offsetOnly ? "offset" : "default"} read)`, async (t) => {
      const longLine = "x".repeat(length) + " END-OF-LONG-LINE";
      const fixture = createFixture(t, ["before", longLine, "after"]);
      const args = offsetOnly
        ? { path: fixture.filePath, offset: 2, limit: 1 }
        : { path: fixture.filePath };
      const result = await fixture.executeToolCall("read_file", args);
      assertReadRange(result, fixture, offsetOnly ? 2 : 1, offsetOnly ? 1 : 3);
      assert.ok(result.includes(longLine), "even the end of a long line must survive");
    });
  }
}

test("read_file preserves a default page whose combined content exceeds 25000 characters", async (t) => {
  const fixture = createFixture(t, makeLines(600).map((line) => `${line} ${"x".repeat(70)}`));
  const result = await fixture.executeToolCall("read_file", { path: fixture.filePath });
  assertReadRange(result, fixture, 1, 500);
  assert.ok(result.length > 25000);
});

test("read_file returns a useful error for a missing file", async (t) => {
  const fixture = createFixture(t);
  const result = await fixture.executeToolCall("read_file", { path: "missing.txt" });
  assert.match(result, /^Error:/);
  assert.match(result, /not found/i);
  assert.ok(result.includes("missing.txt"));
});

test("read_file returns a useful error for a directory", async (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(path.join(fixture.root, "folder"));
  const result = await fixture.executeToolCall("read_file", { path: "folder" });
  assert.match(result, /^Error:/);
  assert.match(result, /directory/i);
  assert.ok(result.includes("folder"));
});

test("get_selection retains its existing 4000-character truncation", async (t) => {
  const fixture = createFixture(t);
  const text = "s".repeat(9000) + " END-OF-SELECTION";
  fixture.vscodeStub.window.activeTextEditor = {
    document: { fileName: "selection.txt", getText: () => text },
    selection: { isEmpty: false, start: { line: 0 }, end: { line: 0 } },
  };
  const result = await fixture.executeToolCall("get_selection", {});
  assert.equal(result, `File: selection.txt\nLines: 1-1\n\`\`\`\n${text.slice(0, 4000)}\n... (truncated)\n\`\`\``);
  assert.ok(!result.includes("END-OF-SELECTION"));
});

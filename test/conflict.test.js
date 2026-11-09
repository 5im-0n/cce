const test = require("node:test");
const assert = require("node:assert/strict");
const {
  targets,
  overlaps,
  findConflicts,
  describeConflict,
  normalizePath,
} = require("../src/chat/conflict");
const { createActivityRegistry } = require("../src/chat/activity");

test("file tools target their path, run_command and agent target the workspace", () => {
  assert.deepEqual(targets("write_file", { path: "src/a.js" }), [{ type: "file", path: "src/a.js" }]);
  assert.deepEqual(targets("edit_file", { path: "src/a.js" }), [{ type: "file", path: "src/a.js" }]);
  assert.deepEqual(targets("delete_files", { path: "src/" }), [{ type: "file", path: "src" }]);
  assert.deepEqual(targets("run_command", { command: "npm test" }), [{ type: "workspace" }]);
  assert.deepEqual(targets("agent", { tasks: ["x"] }), [{ type: "workspace" }]);
  assert.deepEqual(targets("read_file", { path: "src/a.js" }), []);
  assert.deepEqual(targets("mcp__server__tool", {}), [{ type: "workspace" }]);
});

test("file tools without a usable path are treated as workspace-wide", () => {
  assert.deepEqual(targets("write_file", {}), [{ type: "workspace" }]);
  assert.deepEqual(targets("write_file", { path: "   " }), [{ type: "workspace" }]);
  assert.deepEqual(targets("edit_file", null), [{ type: "workspace" }]);
});

test("normalizePath folds separators, leading dots and case", () => {
  assert.equal(normalizePath("src\\Auth\\Login.js"), "src/auth/login.js");
  assert.equal(normalizePath("./src//a.js"), "src/a.js");
  assert.equal(normalizePath("/src/a.js/"), "src/a.js");
  assert.equal(normalizePath(42), "");
});

test("overlaps: same path, nested path, and any workspace target", () => {
  const file = (path) => ({ type: "file", path });
  assert.equal(overlaps(file("src/a.js"), file("src/a.js")), true);
  assert.equal(overlaps(file("src"), file("src/a.js")), true);
  assert.equal(overlaps(file("src/a.js"), file("src/b.js")), false);
  assert.equal(overlaps({ type: "workspace" }, file("src/a.js")), true);
  assert.equal(overlaps(file("src/a.js"), { type: "workspace" }), true);
});

test("no conflict when the other chat is yourself or idle", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Login", "edit_file", { path: "src/login.js" });
  assert.deepEqual(registry.warningsFor("chat-a", "edit_file", { path: "src/login.js" }), []);
  assert.deepEqual(registry.warningsFor("chat-b", "edit_file", { path: "src/other.js" }), []);
});

test("a conflict is reported with the other chat's title and target", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Login", "edit_file", { path: "src/login.js" });
  const warnings = registry.warningsFor("chat-b", "write_file", { path: "src/login.js" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Login/);
  assert.match(warnings[0], /src\/login\.js/);
});

test("a workspace-wide tool warns about any other activity", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Report", "write_file", { path: "src/report.md" });
  const warnings = registry.warningsFor("chat-b", "run_command", { command: "npm test" });
  assert.equal(warnings.length, 1);
  // The warning describes what the *other* chat is doing.
  assert.match(warnings[0], /Report/);
  assert.match(warnings[0], /is modifying the workspace/);
});

test("a file conflict against a running command names the command", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Build", "run_command", { command: "npm test" });
  const warnings = registry.warningsFor("chat-b", "write_file", { path: "src/login.js" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /running a command/);
  assert.match(warnings[0], /the workspace/);
});

test("finishing a tool clears its conflict", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Login", "write_file", { path: "src/login.js" });
  registry.end("chat-a");
  assert.deepEqual(registry.warningsFor("chat-b", "write_file", { path: "src/login.js" }), []);
});

test("read tools never register activity", () => {
  const registry = createActivityRegistry();
  registry.start("chat-a", "Login", "read_file", { path: "src/login.js" });
  assert.deepEqual(registry.warningsFor("chat-b", "write_file", { path: "src/login.js" }), []);
});

test("one warning per conflicting chat, even with several overlapping targets", () => {
  const activity = [
    { chatId: "a", chatTitle: "A", toolName: "write_file", targets: targets("write_file", { path: "src" }) },
    { chatId: "b", chatTitle: "B", toolName: "write_file", targets: targets("write_file", { path: "src/a.js" }) },
  ];
  const conflicts = findConflicts(activity, "self", "delete_files", { path: "src/a.js" });
  assert.equal(conflicts.length, 2);
});

test("describeConflict names the chat, the action and the target", () => {
  const line = describeConflict({ chatTitle: "Report", toolName: "write_file", target: "src/q3.md" });
  assert.equal(line, "Chat \u201cReport\u201d is modifying src/q3.md right now.");
  const shell = describeConflict({ chatTitle: "", toolName: "run_command", target: "the workspace" });
  assert.equal(shell, "Chat \u201cAnother chat\u201d is running a command in the workspace right now.");
});

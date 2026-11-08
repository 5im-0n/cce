const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

/** Exercise the actual inline helpers with small DOM/selection/timer doubles, no UI dependency. */
function setup() {
  const html = fs.readFileSync(path.join(__dirname, "../webview-ui/chat.html"), "utf8");
  const helpers = html.slice(html.indexOf("    // ── selection-safe rendering"), html.indexOf("    // ── send ──"));
  const closeStream = html.slice(html.indexOf("    function closeStream()"), html.indexOf("    function renderSessions("));
  const elements = new Set();
  const selected = new Set();
  const listeners = {};
  const timers = new Map();
  let timerId = 0;
  const posted = [];
  const status = { textContent: "", hidden: true, classList: { remove() {}, toggle() {} } };
  const messages = {
    contains: el => elements.has(el),
    addEventListener: (name, fn) => { listeners[name] = fn; },
    scrollTop: 0, scrollHeight: 1000, clientHeight: 200,
  };
  const sandbox = {
    messagesEl: messages,
    document: {
      activeElement: null,
      getElementById: () => status,
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    window: {
      getSelection: () => ({
        isCollapsed: selected.size === 0,
        rangeCount: selected.size ? 1 : 0,
        getRangeAt: () => ({ intersectsNode: el => selected.has(el) || (el === messages && selected.size > 0) }),
      }),
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => { timers.delete(id); },
    renderMD: text => "rendered:" + text,
    vscode: { postMessage: message => posted.push(message) },
  };
  vm.createContext(sandbox);
  vm.runInContext(helpers + closeStream, sandbox);
  function content(thinking = false) {
    const el = {
      _rt: "first", innerHTML: "first", scrollTop: 0, scrollHeight: 500,
      contains: node => node === el.focusedButton,
      classList: { contains: name => thinking && name === "tc" },
      querySelectorAll: () => [],
    };
    elements.add(el);
    return el;
  }
  return { sandbox, elements, selected, listeners, timers, posted, status, messages, content };
}

test("selected content survives chunks and completion, then renders the latest buffered text", () => {
  const h = setup();
  const el = h.content();
  h.selected.add(el);
  el._rt = "first second";
  h.sandbox.renderTranscriptContent(el);
  el._rt += " final";
  h.sandbox.renderTranscriptContent(el);
  assert.equal(el.innerHTML, "first");
  h.sandbox.streamingEl = el;
  h.sandbox.closeStream();
  assert.equal(h.sandbox.streamingEl, null);
  h.sandbox.flushDeferredRenders();
  assert.equal(el.innerHTML, "first");
  h.selected.clear();
  h.listeners.selectionchange();
  assert.equal(el.innerHTML, "rendered:first second final");
  assert.equal(h.sandbox.deferredRenders.size, 0);
});

test("cross-block selections protect all intersected blocks but not unrelated content", () => {
  const h = setup();
  const first = h.content();
  const second = h.content(true);
  const other = h.content();
  h.selected.add(first);
  h.selected.add(second);
  [first, second, other].forEach(el => h.sandbox.renderTranscriptContent(el));
  assert.equal(first.innerHTML, "first");
  assert.equal(second.innerHTML, "first");
  assert.equal(second.scrollTop, 0);
  assert.equal(other.innerHTML, "rendered:first");
  h.sandbox.scrollToBottom();
  assert.equal(h.messages.scrollTop, 0);
  h.selected.clear();
  h.listeners.selectionchange();
  assert.equal(second.innerHTML, "rendered:first");
  assert.equal(second.scrollTop, 500);
  h.sandbox.scrollToBottom();
  assert.equal(h.messages.scrollTop, 1000);
});

test("pointer drag and focused code-copy controls pause rendering until released", () => {
  const h = setup();
  const el = h.content();
  h.listeners.pointerdown({ button: 0 });
  h.sandbox.renderTranscriptContent(el);
  h.sandbox.scrollToBottom();
  assert.equal(el.innerHTML, "first");
  assert.equal(h.messages.scrollTop, 0);
  h.listeners.pointerup();
  for (const fn of h.timers.values()) fn();
  assert.equal(el.innerHTML, "rendered:first");
  el._rt = "updated";
  el.focusedButton = {};
  h.sandbox.document.activeElement = el.focusedButton;
  h.sandbox.renderTranscriptContent(el);
  assert.equal(el.innerHTML, "rendered:first");
  h.sandbox.document.activeElement = null;
  h.sandbox.flushDeferredRenders();
  assert.equal(el.innerHTML, "rendered:updated");
});

test("detached content and replaced sessions do not retain deferred work or pending timers", () => {
  const h = setup();
  const el = h.content();
  h.selected.add(el);
  h.sandbox.renderTranscriptContent(el);
  h.elements.delete(el);
  h.sandbox.flushDeferredRenders();
  assert.equal(h.sandbox.deferredRenders.size, 0);
  h.sandbox.requestCopy("text", { textContent: "Copy response" });
  assert.equal(h.timers.size, 1);
  h.sandbox.resetTranscriptCopyState();
  assert.equal(h.sandbox.pendingCopies.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.status.hidden, true);
  h.sandbox.finishCopy({ requestId: h.posted[0].requestId, ok: true });
  assert.equal(h.status.hidden, true);
});

test("copy preserves text, waits for the matching acknowledgement, and restores controls", () => {
  const h = setup();
  const button = { textContent: "Copy code", disabled: false };
  const text = '  x < y && z;\n\t🧪\n';
  h.sandbox.requestCopy(text, button);
  assert.equal(h.posted[0].type, "copyText");
  assert.equal(h.posted[0].text, text);
  assert.equal(button.disabled, true);
  assert.equal(h.status.textContent, "Copying…");
  h.sandbox.finishCopy({ requestId: "copy-unknown", ok: true });
  assert.equal(h.status.textContent, "Copying…");
  h.sandbox.finishCopy({ requestId: h.posted[0].requestId, ok: true });
  assert.equal(h.status.textContent, "Copied");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Copy code");
  assert.equal(h.timers.size, 0);
});

test("failure, timeout and out-of-order replies cannot display a false success", () => {
  const h = setup();
  const first = { textContent: "Copy response" };
  const second = { textContent: "Copy code" };
  h.sandbox.requestCopy("first", first);
  h.sandbox.requestCopy("second", second);
  h.sandbox.finishCopy({ requestId: h.posted[1].requestId, ok: false, error: "Write failed" });
  h.sandbox.finishCopy({ requestId: h.posted[0].requestId, ok: true });
  assert.equal(h.status.textContent, "Write failed");
  assert.equal(first.disabled, false);
  assert.equal(second.disabled, false);
  h.sandbox.requestCopy("third", first);
  [...h.timers.values()][0]();
  assert.match(h.status.textContent, /No clipboard confirmation/);
  assert.equal(first.disabled, false);
  h.sandbox.finishCopy({ requestId: h.posted[2].requestId, ok: true });
  assert.match(h.status.textContent, /No clipboard confirmation/);
});

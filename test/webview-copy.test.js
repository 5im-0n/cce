const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// ── minimal DOM double ──
// Just enough tree structure to exercise the real transcript helpers: class
// based selectors, parent/child links and event listeners.

/** Create a DOM-like element. */
function node(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    disabled: false,
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    _children: [],
    _parent: null,
    _listeners: {},
    classList: {
      contains: name => el.className.split(/\s+/).indexOf(name) !== -1,
      add: name => { if (!el.classList.contains(name)) el.className = (el.className + " " + name).trim(); },
      remove: name => { el.className = el.className.split(/\s+/).filter(n => n && n !== name).join(" "); },
      toggle: () => {},
    },
    /** @param {object} child */
    appendChild(child) {
      detach(child);
      child._parent = el;
      el._children.push(child);
      return child;
    },
    /** @param {object} child @param {object} ref */
    insertBefore(child, ref) {
      detach(child);
      child._parent = el;
      const at = el._children.indexOf(ref);
      if (at === -1) el._children.push(child);
      else el._children.splice(at, 0, child);
      return child;
    },
    remove() {
      detach(el);
      el._parent = null;
    },
    replaceWith: () => {},
    /** @param {object} other */
    contains: other => nodeContains(el, other),
    /** @param {string} selector */
    querySelector: selector => {
      const found = el.querySelectorAll(selector);
      return found.length ? found[0] : null;
    },
    /** @param {string} selector - class-only selectors, e.g. ".message.assistant" */
    querySelectorAll: selector => descendants(el).filter(child => matches(child, selector)),
    /** @param {string} name @param {Function} fn */
    addEventListener(name, fn) {
      (el._listeners[name] = el._listeners[name] || []).push(fn);
    },
    scrollIntoView: () => {},
  };
  return el;
}

/** Unlink a node from its current parent. */
function detach(child) {
  if (!child._parent) return;
  const at = child._parent._children.indexOf(child);
  if (at !== -1) child._parent._children.splice(at, 1);
  child._parent = null;
}

/** Depth-first list of every child beneath a node. */
function descendants(root, found = []) {
  for (const child of root._children) {
    found.push(child);
    descendants(child, found);
  }
  return found;
}

/** Only class selectors are needed by the helpers under test. */
function matches(el, selector) {
  return selector.split(".").filter(Boolean).every(name => el.classList.contains(name));
}

/** Whether `other` is a strict descendant of `root`. */
function nodeContains(root, other) {
  return Boolean(other) && descendants(root).indexOf(other) !== -1;
}

/** Exercise the actual inline helpers with small DOM/selection/timer doubles, no UI dependency. */
function setup() {
  const html = fs.readFileSync(path.join(__dirname, "../webview-ui/chat.html"), "utf8");
  const helpers = html.slice(html.indexOf("    // ── selection-safe rendering"), html.indexOf("    // ── send ──"));
  const closeStream = html.slice(html.indexOf("    function closeStream()"), html.indexOf("    function renderSessions("));
  const addMsgSource = html.slice(html.indexOf("    // ── message rendering ──"), html.indexOf("    // ── thinking indicator ──"));
  const elements = new Set();
  const selected = new Set();
  const listeners = {};
  const timers = new Map();
  let timerId = 0;
  const posted = [];
  const status = { textContent: "", hidden: true, classList: { remove() {}, toggle() {} } };
  const messages = node("div");
  messages.contains = el => elements.has(el) || nodeContains(messages, el);
  messages.addEventListener = (name, fn) => { listeners[name] = fn; };
  messages.scrollTop = 0;
  messages.scrollHeight = 1000;
  messages.clientHeight = 200;
  const sandbox = {
    messagesEl: messages,
    document: {
      activeElement: null,
      createElement: tag => node(tag),
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
  vm.runInContext(helpers + closeStream + addMsgSource, sandbox);
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
  /** An assistant message as created by the first partialResponse, still streaming. */
  function assistant() {
    const el = node("div");
    el.className = "message assistant";
    el._rt = "";
    messages.appendChild(el);
    elements.add(el);
    return el;
  }
  return { sandbox, elements, selected, listeners, timers, posted, status, messages, content, assistant };
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

test("the copy response control appears only when a finished response has text", () => {
  const h = setup();
  const el = h.assistant();

  // Streaming renders never create the control, even once text arrived.
  el._rt = "partial";
  h.sandbox.renderAssistant(el);
  assert.equal(el.querySelector(".response-actions"), null);

  // Completion adds exactly one control, above the body.
  h.sandbox.renderAssistant(el, true);
  const actions = el.querySelector(".response-actions");
  assert.ok(actions);
  assert.equal(el._children.indexOf(actions), 0);
  assert.equal(actions.querySelector(".copy-btn").textContent, "Copy response");

  // Re-finalizing must not stack duplicates.
  h.sandbox.renderAssistant(el, true);
  h.sandbox.finalizeResponses();
  assert.equal(el.querySelectorAll(".response-actions").length, 1);
});

test("a finished response without text offers nothing to copy", () => {
  for (const empty of ["", "   \n\t "]) {
    const h = setup();
    const el = h.assistant();
    el._rt = empty;
    h.sandbox.renderAssistant(el, true);
    assert.equal(el.querySelector(".response-actions"), null);
    // The Markdown body still exists so the message is not left structurally broken.
    assert.ok(el.querySelector(".message-content"));
  }
});

test("restored history shows the control only for assistant turns with text", () => {
  const h = setup();
  h.sandbox.addMsg("assistant", "  \n ");
  h.sandbox.addMsg("assistant", "restored text");
  const [empty, full] = h.messages._children;
  assert.equal(empty.querySelector(".response-actions"), null);
  assert.ok(full.querySelector(".response-actions"));
});

test("finalizing covers responses that a tool call interrupted mid-stream", () => {
  const h = setup();
  const before = h.assistant();
  before._rt = "text before the tool call";
  h.sandbox.renderAssistant(before);
  // A tool call closes the stream; the next chunk opens a new assistant block.
  h.sandbox.closeStream();
  const after = h.assistant();
  after._rt = "text after";
  h.sandbox.renderAssistant(after);
  h.sandbox.renderAssistant(after, true);

  h.sandbox.finalizeResponses();
  assert.ok(before.querySelector(".response-actions"));
  assert.ok(after.querySelector(".response-actions"));
});

test("a failed response never gains a copy control afterwards", () => {
  const h = setup();
  const el = h.assistant();
  el._rt = "half an answer";
  h.sandbox.renderAssistant(el);
  // The host reports an error instead of responseComplete.
  h.sandbox.finalizeResponses(false);
  assert.equal(el.querySelector(".response-actions"), null);
  // A later completion for another message must not resurrect this one.
  const next = h.assistant();
  next._rt = "next answer";
  h.sandbox.renderAssistant(next);
  h.sandbox.finalizeResponses();
  assert.equal(el.querySelector(".response-actions"), null);
  assert.ok(next.querySelector(".response-actions"));
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

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRequestParameters, applyRequestParameters } = require("../src/providers/request-parameters");

/** Freeze all inputs so mutation errors cannot go unnoticed. */
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("empty and legacy parameters leave the generated body unchanged", () => {
  const body = freeze({ model: "test", messages: [{ role: "user", content: "Hi" }], stream: true });
  for (const parameters of [undefined, "", " \n ", "{}", {}]) {
    assert.deepEqual(parseRequestParameters(parameters), {});
    const merged = applyRequestParameters(body, parameters);
    assert.deepEqual(merged, body);
    assert.notEqual(merged, body);
    assert.notEqual(merged.messages, body.messages);
  }
});

test("OpenRouter options pass through and nested objects merge without mutation", () => {
  const body = freeze({
    model: "test", stream: true,
    reasoning: { effort: "high", summary: "auto" },
    provider: { order: ["old"], quantizations: ["int8"], nested: { keep: 1 } },
    temperature: 1,
  });
  const parameters = freeze({
    reasoning: { effort: "xHigh" },
    provider: { quantizations: ["fp16", "bf16"], nested: { added: true } },
    temperature: 0,
    custom_option: { enabled: false },
  });
  const merged = applyRequestParameters(body, parameters);
  assert.deepEqual(merged, {
    model: "test", stream: true,
    reasoning: { effort: "xHigh", summary: "auto" },
    provider: { order: ["old"], quantizations: ["fp16", "bf16"], nested: { keep: 1, added: true } },
    temperature: 0,
    custom_option: { enabled: false },
  });
  merged.provider.quantizations.push("other");
  merged.provider.nested.keep = 2;
  assert.deepEqual(parameters.provider.quantizations, ["fp16", "bf16"]);
  assert.equal(body.provider.nested.keep, 1);
});

test("arrays, scalars, null and object type changes replace generated values", () => {
  assert.deepEqual(applyRequestParameters({ a: [1, 2], b: { old: 1 }, c: 1, d: { old: true } },
    { a: [], b: null, c: { new: 2 }, d: "replacement" }),
  { a: [], b: null, c: { new: 2 }, d: "replacement" });
  assert.deepEqual(applyRequestParameters({ thinking: { type: "enabled" } }, { thinking: false }),
    { thinking: false });
});

test("rejects invalid syntax, non-object roots and non-JSON values", () => {
  for (const value of ["{", '{"a":1,}', "// comment", "[]", "null", "true", '"text"', "2", null, [], 2, true]) {
    assert.throws(() => parseRequestParameters(value), /JSON/);
  }
  for (const value of [{ a: undefined }, { a: NaN }, { a: Infinity }, { a: () => {} }, { a: new Date() },
    { a: BigInt(1) }, { a: Symbol("x") }, '{"a":1e999}']) {
    assert.throws(() => parseRequestParameters(value), /JSON values/);
  }
  const circular = {};
  circular.self = circular;
  assert.throws(() => parseRequestParameters(circular), /circular/);
});

test("rejects managed fields even when omitted in the generated body", () => {
  for (const key of ["model", "messages", "input", "system", "instructions", "tools", "functions", "stream",
    "previous_response_id", "conversation", "prompt"]) {
    assert.throws(() => applyRequestParameters({}, { [key]: null }), /managed by CCE/);
  }
  // Only top-level API fields are protected, not provider-specific nested names.
  assert.deepEqual(parseRequestParameters({ provider: { model: "nested" } }), { provider: { model: "nested" } });
});

test("rejects unsafe keys at every nesting depth, including inside arrays", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    for (const json of [`{"${key}":{}}`, `{"provider":{"${key}":{}}}`, `{"a":[{"${key}":{}}]}`]) {
      assert.throws(() => parseRequestParameters(json), /Unsafe request parameter key/);
    }
  }
  assert.equal({}.polluted, undefined);
});

test("generated tool schemas retain special property names without prototype changes", () => {
  const body = JSON.parse('{"tools":[{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}]}');
  const result = applyRequestParameters(body, { temperature: 0.5 });
  assert.deepEqual(result.tools, body.tools);
  assert.equal(Object.getPrototypeOf(result.tools[0].properties), Object.prototype);
  assert.equal(Object.hasOwn(result.tools[0].properties, "__proto__"), true);
});

test("parsing returns an independent object suitable for persistence", () => {
  const original = { provider: { quantizations: ["fp16", "bf16"] }, nullable: null };
  const parsed = parseRequestParameters(JSON.stringify(original));
  assert.deepEqual(parsed, original);
  const cloned = parseRequestParameters(original);
  cloned.provider.quantizations.pop();
  assert.equal(original.provider.quantizations.length, 2);
});

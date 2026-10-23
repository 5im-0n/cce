/** Fields controlled by CCE's conversation and streaming pipeline. */
const MANAGED_FIELDS = new Set([
  "model", "messages", "input", "system", "instructions", "tools", "functions",
  "stream", "previous_response_id", "conversation", "prompt",
]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parse and validate per-model request parameters. Empty text or an omitted
 * field means no overrides. Unknown API parameters and JSON null pass through.
 * @param {unknown} value - JSON editor text or an already parsed JSON object.
 * @returns {Record<string, any>} A validated, independent copy.
 * @throws {Error} If the JSON is invalid or contains managed/unsafe fields.
 */
function parseRequestParameters(value) {
  if (value === undefined || (typeof value === "string" && !value.trim())) {
    return {};
  }
  let parameters = value;
  if (typeof value === "string") {
    try {
      parameters = JSON.parse(value);
    } catch {
      throw new Error("Request parameters must be valid JSON (no comments or trailing commas).");
    }
  }
  if (!isObject(parameters)) {
    throw new Error("Request parameters must be a JSON object, not an array or scalar.");
  }
  for (const key of Object.keys(parameters)) {
    if (MANAGED_FIELDS.has(key)) {
      throw new Error(`Request parameter "${key}" is managed by CCE and cannot be overridden.`);
    }
  }
  return copyJson(parameters, "requestParameters", new Set());
}

/**
 * Merge validated parameters after the provider constructs its API-specific
 * body. Objects merge recursively; arrays, scalars, and null replace values.
 * Neither the body nor the saved parameters are modified.
 * @param {Record<string, any>} body - Generated API request.
 * @param {unknown} [parameters] - Per-model overrides.
 * @returns {Record<string, any>} Merged API request.
 */
function applyRequestParameters(body, parameters) {
  return mergeObjects(body, parseRequestParameters(parameters));
}

/** @param {any} value @returns {boolean} Whether value is a plain JSON object. */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/**
 * Validate recursively, including objects inside arrays, while cloning.
 * @param {any} value
 * @param {string} path
 * @param {Set<object>} ancestors
 * @returns {any}
 */
function copyJson(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))) {
    return value;
  }
  if (!Array.isArray(value) && !isObject(value)) {
    throw new Error(`Request parameter "${path}" must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new Error("Request parameters cannot contain circular references.");
  }
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => copyJson(item, `${path}[${index}]`, ancestors));
  } else {
    result = {};
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        throw new Error(`Unsafe request parameter key "${key}" is not allowed (${path}).`);
      }
      result[key] = copyJson(value[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

/**
 * Merge objects without retaining mutable references to either input.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overrides
 * @returns {Record<string, any>}
 */
function mergeObjects(base, overrides) {
  const result = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(overrides)])) {
    const original = base[key];
    const value = Object.hasOwn(overrides, key) ? overrides[key] : original;
    const merged = isObject(value)
      ? mergeObjects(isObject(original) ? original : {}, value) : cloneValue(value);
    // Generated tool schemas may legitimately contain properties named
    // __proto__/constructor. Preserve them as own keys, never invoke setters.
    Object.defineProperty(result, key, {
      value: merged, enumerable: true, configurable: true, writable: true,
    });
  }
  return result;
}

/** @param {any} value @returns {any} Independent copy of a generated JSON value. */
function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isObject(value)) return mergeObjects({}, value);
  return value;
}

module.exports = { parseRequestParameters, applyRequestParameters };

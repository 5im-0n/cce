const Module = require("node:module");
const test = require("node:test");
const assert = require("node:assert/strict");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return { workspace: {}, window: { createOutputChannel: () => ({ appendLine() {} }) } };
  if (request === "../mcp/processManager") return { getRunningIds: () => [], isRunning: () => false };
  return originalLoad(request, parent, isMain);
};
const Settings = require("../src/config/Settings");
const ModelConfigPanel = require("../src/config/ModelConfigPanel");
Module._load = originalLoad;

/** In-memory extension storage with JSON roundtrips matching persisted settings. */
function setup(t, initialModels = []) {
  const state = new Map([["cce.models", initialModels]]);
  const secrets = new Map();
  const posted = [];
  let changes = 0;
  Settings.init({
    globalState: {
      get: (key, fallback) => JSON.parse(JSON.stringify(state.has(key) ? state.get(key) : fallback)),
      update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); },
    },
    secrets: {
      get: async key => secrets.get(key),
      store: async (key, value) => { secrets.set(key, value); },
      delete: async key => { secrets.delete(key); },
    },
  });
  ModelConfigPanel._panel = { webview: { postMessage: message => posted.push(message) } };
  ModelConfigPanel._onChanged = () => { changes++; };
  t.after(() => { ModelConfigPanel._panel = null; ModelConfigPanel._onChanged = null; });
  return { state, secrets, posted, changes: () => changes };
}

const config = { name: "Router", provider: "openai", modelId: "test", endpoint: "https://openrouter.ai/api/v1" };
const parameters = { provider: { quantizations: ["fp16", "bf16"] }, reasoning: { effort: "xHigh" } };

test("adding a model persists parameters and acknowledges saving without exposing its key", async (t) => {
  const storage = setup(t);
  await ModelConfigPanel._addModel({ ...config, apiKey: "secret", requestParameters: parameters });
  const models = Settings.getModels();
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].requestParameters, parameters);
  assert.equal(Settings.getDefaultModel(), models[0].id);
  assert.equal(await Settings.getApiKey(models[0].id), "secret");
  assert.equal(Object.hasOwn(models[0], "apiKey"), false);
  const loaded = storage.posted.find(message => message.type === "dataLoaded");
  assert.deepEqual(loaded.modelSave, { saved: true });
  assert.deepEqual(loaded.models, models);
  assert.equal(JSON.stringify(loaded).includes("secret"), false);
  assert.equal(storage.changes(), 1);
});

test("editing persists overrides, omitted values retain them and empty object clears them", async (t) => {
  const storage = setup(t, [{ id: "one", ...config }, { id: "two", ...config, requestParameters: { temperature: 0.8 } }]);
  await ModelConfigPanel._updateModel("one", { requestParameters: parameters });
  assert.deepEqual(Settings.getModels()[0].requestParameters, parameters);
  await ModelConfigPanel._updateModel("one", { name: "Renamed" });
  assert.deepEqual(Settings.getModels()[0].requestParameters, parameters);
  await ModelConfigPanel._updateModel("one", { requestParameters: {} });
  assert.deepEqual(Settings.getModels()[0].requestParameters, {});
  assert.deepEqual(Settings.getModels()[1].requestParameters, { temperature: 0.8 });
  assert.equal(storage.changes(), 3);
});

test("legacy models load unchanged and can save without request parameters", async (t) => {
  setup(t, [{ id: "old", ...config }]);
  assert.equal(Settings.getModels()[0].requestParameters, undefined);
  await ModelConfigPanel._updateModel("old", { name: "Renamed" });
  assert.equal(Settings.getModels()[0].requestParameters, undefined);
  await ModelConfigPanel._addModel(config);
  assert.deepEqual(Settings.getModels()[1].requestParameters, {});
});

test("invalid add is rejected on the host without creating a model or storing its key", async (t) => {
  const storage = setup(t);
  for (const invalid of ["{", [], null, { stream: false }, JSON.parse('{"a":[{"constructor":{}}]}')]) {
    await ModelConfigPanel._addModel({ ...config, apiKey: "secret", requestParameters: invalid });
    assert.deepEqual(Settings.getModels(), []);
    assert.equal(storage.secrets.size, 0);
    assert.equal(storage.changes(), 0);
    assert.ok(storage.posted.filter(message => message.type === "dataLoaded").at(-1).modelSave.error);
  }
});

test("invalid edit leaves the stored model, key and overrides intact", async (t) => {
  const initial = { id: "one", ...config, requestParameters: parameters };
  const storage = setup(t, [initial]);
  await Settings.setApiKey("one", "old-key");
  await ModelConfigPanel._updateModel("one", { name: "Should not change", apiKey: "new-key", requestParameters: { messages: [] } });
  assert.deepEqual(Settings.getModels(), [initial]);
  assert.equal(await Settings.getApiKey("one"), "old-key");
  assert.equal(storage.changes(), 0);
  assert.match(storage.posted.find(message => message.type === "dataLoaded").modelSave.error, /managed by CCE/);
});

test("editing a missing model reports an error so the editor does not stay pending", async (t) => {
  const storage = setup(t);
  await ModelConfigPanel._updateModel("missing", { name: "New" });
  assert.match(storage.posted.find(message => message.type === "dataLoaded").modelSave.error, /no longer exists/);
});

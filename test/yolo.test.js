import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAcceptConfidence, detectionFloor, postprocess } from "../public/yolo.js";

test("threshold: default, limits, rounding and invalid saved/API values", () => {
  for (const value of [undefined, null, "", " ", "bad", NaN, Infinity, -1, 0, 0.09, 0.91, true, [], {}]) {
    assert.equal(normalizeAcceptConfidence(value), 0.35);
  }
  for (const value of [0.1, 0.35, 0.9]) assert.equal(normalizeAcceptConfidence(value), value);
  assert.equal(normalizeAcceptConfidence("0.456"), 0.46);
  assert.equal(detectionFloor(0.1), 0.1);
  assert.equal(detectionFloor(0.9), 0.25);
});

test("threshold: lowering below 0.25 actually admits weaker detections", () => {
  const output = new Float32Array([10, 30, 50, 10, 10, 10, 8, 8, 8, 8, 8, 8, 0.2, 0.4, 0.8]);
  const run = (threshold) => postprocess(output, ["0m"], threshold, detectionFloor(threshold), 1, 0, 0, 100, 100);
  assert.equal(run(0.35).accepted.length, 2);
  assert.equal(run(0.5).accepted.length, 1);
  assert.equal(run(0.5).low.length, 1);
  assert.equal(run(0.1).accepted.length, 3);
  assert.ok(run(0.1).accepted.every((x) => x.tile === "m5"));
});

function mockBrowser(t, native = false) {
  const keys = ["location", "document", "ort", "fetch"];
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const state = { scripts: [], calls: [], fail: false, modelStatus: 200 };
  const makeRuntime = () => ({ env: { wasm: {} }, InferenceSession: { create: async (bytes, options) => {
    state.calls.push({ bytes, options, wasm: { ...globalThis.ort.env.wasm } });
    if (state.fail) throw new Error("shared memory unavailable");
    return { inputNames: ["images"], outputNames: ["output0"] };
  } } });
  globalThis.location = new URL(native ? "https://appassets.androidplatform.net/?apk=3" : "http://localhost:4180/");
  globalThis.ort = makeRuntime();
  globalThis.document = {
    createElement: () => ({ remove() {} }),
    head: { append: (script) => {
      state.scripts.push(script.src);
      globalThis.ort = makeRuntime();
      queueMicrotask(() => script.onload());
    } },
  };
  globalThis.fetch = async () => ({ ok: state.modelStatus === 200, status: state.modelStatus,
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
  return state;
}

test("model initialization: shared singleton, absolute assets, model bytes", async (t) => {
  const state = mockBrowser(t);
  const { loadYoloModel } = await import("../public/yolo.js?singleton");
  const first = loadYoloModel();
  assert.equal(loadYoloModel(), first);
  assert.equal(await loadYoloModel(), await first);
  assert.equal(state.calls.length, 1);
  assert.ok(state.calls[0].bytes instanceof Uint8Array);
  assert.equal(state.calls[0].wasm.wasmPaths, "http://localhost:4180/vendor/");
  assert.equal(state.calls[0].wasm.numThreads, 1);
});

test("Android selects genuine single-thread WASM and never server fallback", async (t) => {
  const state = mockBrowser(t, true);
  const { loadYoloModel, isAndroidApp } = await import("../public/yolo.js?android");
  assert.equal(isAndroidApp(), true);
  await loadYoloModel();
  assert.deepEqual(state.scripts, ["/vendor/ort-1.17.3/ort.wasm.min.js"]);
  assert.equal(state.calls[0].wasm.wasmPaths, "https://appassets.androidplatform.net/vendor/ort-1.17.3/");
  assert.equal(state.calls[0].wasm.numThreads, 1);
  assert.equal(state.calls[0].wasm.proxy, false);
});

test("failed runtime is discarded so a new attempt can initialize", async (t) => {
  const state = mockBrowser(t);
  const { loadYoloModel } = await import("../public/yolo.js?retry");
  state.fail = true;
  await assert.rejects(loadYoloModel(), /shared memory unavailable/);
  state.fail = false;
  await loadYoloModel();
  assert.deepEqual(state.scripts, ["/vendor/ort.min.js"]);
  assert.equal(state.calls.length, 2);
});

test("model HTTP failures retain their real cause and can retry", async (t) => {
  const state = mockBrowser(t);
  const { loadYoloModel } = await import("../public/yolo.js?missing-model");
  state.modelStatus = 404;
  await assert.rejects(loadYoloModel(), /HTTP 404/);
  assert.equal(state.calls.length, 0);
  state.modelStatus = 200;
  await loadYoloModel();
  assert.equal(state.calls.length, 1);
});

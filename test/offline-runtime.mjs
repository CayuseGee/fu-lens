// Real WASM/model regression under an APK-like origin and blocked shared memory.
// Requires a dedicated headless Edge/Chrome with CDP on port 9223.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const cdp = "http://127.0.0.1:9223";
const origin = "https://appassets.androidplatform.net";
const root = resolve(process.env.FU_LENS_ASSET_ROOT || "public");
const artifactRoot = resolve(process.env.FU_LENS_ARTIFACT_ROOT || "artifacts/r3-verification");
const noSimd = process.env.FU_LENS_NO_SIMD === "1";
await mkdir(artifactRoot, { recursive: true });
const tab = await fetch(`${cdp}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
let nextId = 0;
const pending = new Map();
const requests = [];
const interceptErrors = [];
let failModel = false;
const send = (method, params = {}) => new Promise((done, fail) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { done, fail, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.fail(new Error(JSON.stringify(message.error)));
    else call.done(message.result);
  } else if (message.method === "Fetch.requestPaused") {
    const { request, requestId } = message.params;
    requests.push(request.url);
    try {
      const url = new URL(request.url);
      if (url.origin !== origin) {
        await send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" });
        return;
      }
      const path = resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
      assert.ok(path.startsWith(root + sep));
      let body, responseCode = 200;
      try {
        if (failModel && path.endsWith(".onnx")) throw new Error("Injected model read failure");
        body = await readFile(path);
      } catch { body = Buffer.from("Not found"); responseCode = 404; }
      const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm",
        ".onnx": "application/octet-stream", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml",
        ".webmanifest": "application/manifest+json" }[extname(path)] || "text/html";
      await send("Fetch.fulfillRequest", { requestId, responseCode, body: body.toString("base64"),
        responseHeaders: [{ name: "Content-Type", value: mime }, { name: "Cache-Control", value: "no-store" }] });
    } catch (error) { interceptErrors.push(error.message); }
  }
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const until = async (expression) => {
  for (let i = 0; i < 300; i++) {
    if (await evaluate(expression)) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Condition timed out: ${expression}`);
};
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const report = { assetRoot: root, realAndroidDevice: false, noSimd, validation: "Desktop browser with APK asset interception and shared-memory restriction" };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    globalThis.sharedMemoryAttempts = 0;
    const OriginalMemory = WebAssembly.Memory;
    WebAssembly.Memory = new Proxy(OriginalMemory, { construct(target, args) {
      if (args[0]?.shared) { sharedMemoryAttempts++; throw new TypeError("Shared WebAssembly.Memory unavailable in test WebView"); }
      return Reflect.construct(target, args);
    } });
    Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
    ${noSimd ? "WebAssembly.validate = () => false;" : ""}
  ` });
  await send("Page.navigate", { url: origin + "/?apk=3" });
  await until(`document.readyState === 'complete' && !!globalThis.ort && localStorage.getItem('fu-lens-yolo-threshold') !== null`);
  // Reproduce the old ORT 1.21 failure while retaining real WASM execution.
  report.oldRuntimeError = await evaluate(`(async () => {
    ort.env.wasm.wasmPaths = location.origin + '/vendor/'; ort.env.wasm.numThreads = 1;
    try { await ort.InferenceSession.create('/models/nano/mahjong-yolon-best.onnx', {executionProviders:['wasm']}); return null; }
    catch (error) { return error.message; }
  })()`);
  assert.match(report.oldRuntimeError, noSimd ? /WebAssembly SIMD is not supported/ : /Shared WebAssembly.Memory unavailable/);
  assert.equal(await evaluate(`document.querySelector('#recognitionSettings').open`), false);
  await evaluate(`document.querySelector('#resetRecognitionThreshold').click()`);
  assert.equal(await evaluate(`document.querySelector('#recognitionThreshold').value`), "0.35");
  await click("#recognitionSettings summary");
  await evaluate(`const slider = document.querySelector('#recognitionThreshold'); slider.value = '0.55'; slider.dispatchEvent(new Event('input', {bubbles:true}));`);
  assert.equal(await evaluate(`document.querySelector('#recognitionThresholdValue').value`), "0.55");
  await send("Page.reload");
  await until(`document.querySelector('#recognitionThreshold')?.value === '0.55'`);
  report.thresholdPersisted = true;

  const dom = await send("DOM.getDocument");
  const input = await send("DOM.querySelector", { nodeId: dom.root.nodeId, selector: "#galleryInput" });
  await send("DOM.setFileInputFiles", { nodeId: input.nodeId, files: [resolve("test/detected-final.png")] });
  await until(`document.querySelector('#recognizeButton').disabled === false`);
  failModel = true;
  await click("#recognizeButton");
  await until(`!document.querySelector('#recognizeButton').disabled`);
  report.modelReadError = await evaluate(`document.querySelector('#recognitionStatus').textContent`);
  assert.match(report.modelReadError, /HTTP 404/);
  assert.doesNotMatch(report.modelReadError, /更新 Android System WebView/);
  failModel = false;
  await click("#resetRecognitionThreshold");
  await click("#recognizeButton");
  await until(`!document.querySelector('#recognizeButton').disabled`);
  report.uiRecognition = await evaluate(`({status:document.querySelector('#recognitionStatus').textContent,
    count:document.querySelectorAll('#poolStrip .mahjong-tile').length, runtime:ort.env.versions.web})`);
  assert.match(report.uiRecognition.status, /识别完成/);
  assert.ok(report.uiRecognition.count > 0);
  assert.equal(report.uiRecognition.runtime, "1.17.3");
  assert.equal(await evaluate("sharedMemoryAttempts"), 0);
  report.retrySuccessful = true;
  const fixture = "data:image/png;base64," + (await readFile("test/detected-final.png")).toString("base64");
  report.thresholdCounts = await evaluate(`(async () => {
    const {detectLocal} = await import('/yolo.js?v=23'); const rows = [];
    for (const threshold of [0.1, 0.35, 0.9]) {
      const result = await detectLocal(${JSON.stringify(fixture)}, threshold);
      rows.push({threshold, accepted:result.count, low:result.low_count});
    } return rows;
  })()`);
  assert.ok(report.thresholdCounts[0].accepted >= report.thresholdCounts[1].accepted);
  assert.ok(report.thresholdCounts[1].accepted > report.thresholdCounts[2].accepted);
  report.blockedExternalFetch = await evaluate(`fetch('https://offline-probe.invalid/test').then(() => false, () => true)`);
  assert.equal(report.blockedExternalFetch, true);
  assert.ok(!requests.some((url) => url.includes("/api/")));

  const assertRecognizedPool = async (name) => {
    const state = await evaluate(`({
      pool:[...document.querySelectorAll('#poolStrip .mahjong-tile')].map(t => t.dataset.code),
      recognized:[...document.querySelectorAll('#recognizedTiles .mahjong-tile:not(.low-conf)')].map(t => t.dataset.code)
    })`);
    assert.deepEqual(state.recognized, state.pool, `Recognized display must match the actual pool: ${name}`);
    report.recognizedDisplay.push({name, count:state.pool.length, matches:true});
  };
  report.recognizedDisplay = [];
  await assertRecognizedPool("actual YOLO result");
  await click("#clearPoolButton");
  await assertRecognizedPool("empty pool");
  assert.doesNotMatch(await evaluate(`document.querySelector('#breakdown').textContent`), /自风雀头|场风雀头/);
  await click("#recognizedTiles .low-conf");
  await assertRecognizedPool("accepted manual correction");
  await evaluate(`document.querySelector('#recognitionThreshold').value = '0.10'; document.querySelector('#recognitionThreshold').dispatchEvent(new Event('input', {bubbles:true}));`);
  await click("#recognizeButton");
  await until(`!document.querySelector('#recognizeButton').disabled`);
  assert.match(await evaluate(`document.querySelector('#recognitionStatus').textContent`), /识别完成/);
  assert.equal(await evaluate(`document.querySelectorAll('#recognizedTiles .low-conf').length`), 0);
  await assertRecognizedPool("all detections above threshold");
  await send("Emulation.setDeviceMetricsOverride", {width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('#recognizedStrip').scrollIntoView({behavior:'instant',block:'start'})`);
  const recognizedScreenshot = await send("Page.captureScreenshot", {format:"png"});
  await writeFile(resolve(artifactRoot, 'recognized-display-390.png'), Buffer.from(recognizedScreenshot.data, 'base64'));
  for (const [name, tiles] of [
    ["incomplete hand without east", ["m1", "m2", "m3"]],
    ["regular hand with genuine east pair", ["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "s7", "s8", "s9", "z1", "z1"]],
    ["seven pairs", ["m1", "m1", "m2", "m2", "m3", "m3", "p4", "p4", "p5", "p5", "s6", "s6", "s7", "s7"]],
    ["thirteen orphans", ["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"]],
  ]) {
    await click("#clearPoolButton");
    for (const tile of tiles) await click(`#poolPicker [data-code="${tile}"]`);
    await assertRecognizedPool(name);
  }
  await click("#resetRecognitionThreshold");

  await click("#manualButton");
  await click("#clearPoolButton");
  for (const rank of "11123455678999") await click(`#poolPicker [data-code="m${rank}"]`);
  await click('#seatWindControl [data-value="z2"]');
  await click("#winTileButton");
  await click('#winPickerTiles [data-code="m5"]');
  report.pureNineGates = await evaluate(`({yaku:document.querySelector('#yakuList').textContent, han:document.querySelector('#totalHan').textContent, ron:document.querySelector('#ronPoints').textContent})`);
  assert.match(report.pureNineGates.yaku, /纯正九莲宝灯/);
  assert.match(report.pureNineGates.han, /26/);
  assert.match(report.pureNineGates.ron.replaceAll(',', ''), /64000/);
  await click("#winTileButton");
  await click('#winPickerTiles [data-code="m1"]');
  report.nineGates = await evaluate(`({yaku:document.querySelector('#yakuList').textContent, han:document.querySelector('#totalHan').textContent, ron:document.querySelector('#ronPoints').textContent})`);
  assert.match(report.nineGates.yaku, /九莲宝灯/);
  assert.doesNotMatch(report.nineGates.yaku, /纯正/);
  assert.match(report.nineGates.han, /13/);
  assert.match(report.nineGates.ron.replaceAll(',', ''), /32000/);
  report.layouts = [];
  for (const [width, height] of [[320, 800], [390, 844], [1024, 900]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
    await evaluate(`document.querySelector('#recognitionSettings').open = true; window.scrollTo({top:0,behavior:'instant'});`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(resolve(artifactRoot, `settings-${width}.png`), Buffer.from(screenshot.data, "base64"));
    report.layouts.push({ width, height, noOverflow: true });
  }
  assert.deepEqual(interceptErrors, []);
  report.wasmRequests = [...new Set(requests.filter((url) => url.endsWith(".wasm")))];
  await writeFile(resolve(artifactRoot, noSimd ? "offline-runtime-no-simd.json" : "offline-runtime.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws.close();
  await fetch(`${cdp}/json/close/${tab.id}`);
}

// Run only against the separate debug package's forwarded WebView CDP socket.
// No request interception, external model server, or mocked inference is used.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const endpoint = process.env.FU_LENS_DEVICE_CDP || "http://127.0.0.1:9225";
const output = resolve("artifacts/r4-verification");
await mkdir(output, { recursive: true });
const tabs = await fetch(`${endpoint}/json/list`).then(r => r.json());
const tab = tabs.find(t => t.url.startsWith("https://appassets.androidplatform.net/"));
assert.ok(tab, "FuLens WebView must be open in the separate debug app");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
let nextId = 0;
const pending = new Map();
const responses = [];
const exceptions = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.fail(new Error(JSON.stringify(message.error)));
    else call.done(message.result);
  } else if (message.method === "Network.responseReceived") {
    const { url, status, fromDiskCache } = message.params.response;
    responses.push({ url, status, fromDiskCache });
  } else if (message.method === "Runtime.exceptionThrown") {
    exceptions.push(message.params.exceptionDetails);
  }
};
const send = (method, params = {}) => new Promise((done, fail) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 60000);
  pending.set(id, { done, fail, timer });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const until = async expression => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Condition timed out: ${expression}`);
};
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const screenshot = async name => {
  const data = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(output, name), Buffer.from(data.data, "base64"));
};
const report = { realAndroidDevice: true, mockedResources: false, fixtureAccuracyBenchmark: false };
try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  report.userAgent = await evaluate("navigator.userAgent");
  assert.match(report.userAgent, /Android/);
  assert.match(report.userAgent, /; wv\)/);
  await send("Page.reload", { ignoreCache: true });
  await until(`document.readyState === 'complete' && !!document.querySelector('#recognitionThreshold')`);
  assert.equal(await evaluate(`document.querySelector('#recognitionSettings').open`), false);
  await click("#recognitionSettings summary");
  await evaluate(`const slider = document.querySelector('#recognitionThreshold'); slider.value = '0.55'; slider.dispatchEvent(new Event('input', {bubbles:true}));`);
  await send("Page.reload", { ignoreCache: true });
  await until(`document.querySelector('#recognitionThreshold')?.value === '0.55'`);
  report.thresholdPersisted = true;
  await click("#resetRecognitionThreshold");
  const base64 = (await readFile("test/detected-final.png")).toString("base64");
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0));
    const data = new DataTransfer(); data.items.add(new File([bytes], 'fu-lens-test.png', {type:'image/png'}));
    const input = document.querySelector('#galleryInput'); input.files = data.files;
    input.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  await until(`document.querySelector('#recognizeButton').disabled === false`);
  await click("#cropButton");
  await until(`!document.querySelector('#cropBackdrop').hidden && document.querySelector('#cropImage').naturalWidth > 0`);
  await click("#cropCancelButton");
  report.cropOpensAndCancels = await evaluate(`document.querySelector('#cropBackdrop').hidden`);
  await click("#recognizeButton");
  await until(`!document.querySelector('#recognizeButton').disabled`);
  report.uiRecognition = await evaluate(`({status:document.querySelector('#recognitionStatus').textContent,
    count:document.querySelectorAll('#poolStrip .mahjong-tile').length, runtime:ort.env.versions.web})`);
  assert.match(report.uiRecognition.status, /识别完成/);
  assert.ok(report.uiRecognition.count > 0);
  assert.equal(report.uiRecognition.runtime, "1.17.3");
  await screenshot("android-recognition.png");
  report.thresholdCounts = await evaluate(`(async () => {
    const {detectLocal} = await import('/yolo.js?v=22'); const rows = [];
    for (const threshold of [0.1, 0.35, 0.9]) {
      const result = await detectLocal('data:image/png;base64,' + ${JSON.stringify(base64)}, threshold);
      rows.push({threshold, accepted:result.count, low:result.low_count, latency_ms:result.latency_ms});
    } return rows;
  })()`);
  assert.ok(report.thresholdCounts[0].accepted >= report.thresholdCounts[1].accepted);
  assert.ok(report.thresholdCounts[1].accepted > report.thresholdCounts[2].accepted);
  report.externalFetch = await evaluate(`fetch('https://example.com/?fu-lens-offline-probe=1', {signal:AbortSignal.timeout(5000)}).then(r => ({blocked:!r.ok,status:r.status}), error => ({blocked:true,error:error.message}))`);
  assert.equal(report.externalFetch.blocked, true);
  await click("#manualButton");
  await click("#clearPoolButton");
  for (const rank of "11123455678999") await click(`#poolPicker [data-code="m${rank}"]`);
  await click('#seatWindControl [data-value="z2"]');
  await click("#winTileButton");
  await click('#winPickerTiles [data-code="m5"]');
  const score = `({yaku:document.querySelector('#yakuList').textContent,han:document.querySelector('#totalHan').textContent,ron:document.querySelector('#ronPoints').textContent})`;
  report.pureNineGates = await evaluate(score);
  assert.match(report.pureNineGates.yaku, /纯正九莲宝灯/);
  assert.equal(report.pureNineGates.ron.replaceAll(',', ''), "64000");
  await click("#winTileButton");
  await click('#winPickerTiles [data-code="m1"]');
  report.nineGates = await evaluate(score);
  assert.match(report.nineGates.yaku, /九莲宝灯/);
  assert.doesNotMatch(report.nineGates.yaku, /纯正/);
  assert.equal(report.nineGates.ron.replaceAll(',', ''), "32000");
  await evaluate(`document.querySelector('#recognitionSettings').open = true; window.scrollTo({top:0,behavior:'instant'});`);
  report.noHorizontalOverflow = await evaluate("document.documentElement.scrollWidth <= innerWidth");
  assert.equal(report.noHorizontalOverflow, true);
  await screenshot("android-threshold.png");
  report.localResourceResponses = responses.filter(r => /\.(wasm|onnx)$|ort.*\.js$/.test(r.url));
  for (const suffix of ['/vendor/ort-1.17.3/ort.wasm.min.js', '/vendor/ort-1.17.3/ort-wasm-simd.wasm', '/models/nano/mahjong-yolon-best.onnx']) {
    assert.ok(report.localResourceResponses.some(r => r.url.endsWith(suffix) && r.status === 200), `Missing successful real resource response: ${suffix}`);
  }
  assert.ok(!responses.some(r => r.url.includes('/api/')));
  assert.deepEqual(exceptions, []);
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(resolve(output, 'android-device.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  ws.close();
}

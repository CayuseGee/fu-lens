import assert from "node:assert/strict";

const cdp = "http://127.0.0.1:9223";
const url = process.env.FU_LENS_TEST_URL || "http://localhost:4173/";
const tab = await fetch(`${cdp}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(r => r.json());
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(JSON.stringify(message.error)));
  else call.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const messageId = ++id;
  const timer = setTimeout(() => { pending.delete(messageId); reject(new Error(`Timeout: ${method}`)); }, 15000);
  pending.set(messageId, { resolve, reject, timer });
  ws.send(JSON.stringify({ id: messageId, method, params }));
});
const evaluate = async expression => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const pairs = codes => codes.split(" ").flatMap(t => [t, t]);
try {
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(document.querySelector('#poolPicker .mahjong-tile'))")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate("document.querySelector('script[type=module]').getAttribute('src')"), "/app.js?v=24");
  const cases = [
    [pairs("m1 m2 m3 m7 m8 m9 m5"), ["两杯口", "清一色"], 9, false],
    ["m1 m1 m1 m1 m2 m2 m3 m3 m7 m7 m8 m8 m9 m9".split(" "), ["两杯口", "清一色", "纯全带幺九"], 12, false],
    [pairs("m1 m2 m3 p7 p8 p9 z7"), ["两杯口", "混全带幺九"], 5, false],
    [pairs("m1 m2 m3 m7 m8 m9 z7"), ["两杯口", "混一色", "混全带幺九"], 8, false],
    [pairs("m1 m2 m3 p7 p8 p9 s9"), ["两杯口", "纯全带幺九"], 6, false],
    [pairs("m1 m2 m3 m4 m5 m8 m9"), ["七对子", "清一色"], 8, true],
    [pairs("m1 m2 m4 m6 m8 z2 z7"), ["七对子", "混一色"], 5, true],
    [pairs("m2 m3 p4 p5 s6 s7 s8"), ["七对子", "断幺九"], 3, true],
    [pairs("m1 m9 p1 p9 s1 s9 z7"), ["七对子", "混老头"], 4, true],
    [pairs("m1 m9 z1 z2 z3 z4 z7"), ["七对子", "混老头", "混一色"], 7, true],
    ["m1 m2 m3 m1 m2 m3 p4 p5 p6 s7 s8 s9 z7 z7".split(" "), ["一杯口"], 1, false],
  ];
  for (const [tiles, names, han, sevenPairs] of cases) {
    await click("#manualButton");
    await click("#clearPoolButton");
    for (const tile of tiles) await click(`#poolPicker [data-code="${tile}"]`);
    await click("#winTileButton");
    await click(`#winPickerTiles [data-code="${tiles.at(-1)}"]`);
    await click('#waitTypeControl [data-value="tanki"]');
    const state = await evaluate(`({ yaku: document.querySelector('#yakuList').textContent, han: document.querySelector('#totalHan').textContent, fu: document.querySelector('#totalFu').textContent })`);
    for (const name of names) assert.ok(state.yaku.includes(name), JSON.stringify({ names, state }));
    assert.equal(parseInt(state.han), han, JSON.stringify(state));
    if (sevenPairs) assert.equal(parseInt(state.fu), 25);
    else assert.ok(!state.yaku.includes("七对子"));
    if (names.includes("两杯口")) assert.ok(!state.yaku.includes("一杯口"));
    if (names.some(n => n.includes("杯口"))) {
      await click("#closedToggle");
      assert.ok(!(await evaluate("document.querySelector('#yakuList').textContent")).includes("杯口"));
      await click("#closedToggle");
      assert.ok((await evaluate("document.querySelector('#yakuList').textContent")).includes(names[0]));
    }
  }
  console.log(JSON.stringify({ url, cacheVersion: 24, yakuUiCases: cases.length, closedToggleVerified: true, passed: true }));
} finally {
  ws.close();
  await fetch(`${cdp}/json/close/${tab.id}`);
}

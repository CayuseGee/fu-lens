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
try {
  for (let i = 0; i < 100; i++) {
    if (await evaluate("Boolean(document.querySelector('#poolPicker .mahjong-tile'))")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate("document.querySelector('script[type=module]').getAttribute('src')"), "/app.js?v=24");
  await click("#manualButton");
  await click("#clearPoolButton");
  for (const rank of "11123455678999") await click(`#poolPicker [data-code="m${rank}"]`);
  let checked = 0;
  for (const [winTile, mult] of [["m1", 1], ["m5", 2]]) {
    await click("#winTileButton");
    await click(`#winPickerTiles [data-code="${winTile}"]`);
    for (const [seat, base] of [["z2", 32000], ["z1", 48000]]) {
      await click(`#seatWindControl [data-value="${seat}"]`);
      for (const method of ["ron", "tsumo"]) {
        await click(`#winMethodControl [data-value="${method}"]`);
        for (const honba of [0, 1, 2, 3, 2, 1, 0]) {
          const current = await evaluate("Number(document.querySelector('#honbaValue').textContent)");
          if (current !== honba) await click(`#honbaStepper [data-step="${honba > current ? 1 : -1}"]`);
          const actual = await evaluate(`document.querySelector('${method === "ron" ? "#ronPoints" : "#tsumoPoints"}').textContent`);
          const expected = method === "ron" ? (base * mult + 300 * honba).toLocaleString("zh-CN")
            : seat === "z1" ? String(base * mult / 3 + 100 * honba)
            : `${base * mult / 4 + 100 * honba} / ${base * mult / 2 + 100 * honba}`;
          assert.equal(actual, expected, JSON.stringify({ winTile, seat, method, honba }));
          checked++;
        }
      }
    }
  }
  console.log(JSON.stringify({ url, cacheVersion: 24, honbaUiCases: checked, passed: true }));
} finally {
  ws.close();
  await fetch(`${cdp}/json/close/${tab.id}`);
}

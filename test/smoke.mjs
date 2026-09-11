// 符镜 UI 冒烟测试：无头 Chrome + CDP，真实点击验证牌库录入功能
const CDP = "http://127.0.0.1:9223";
const APP_URL = process.env.FU_LENS_TEST_URL || "http://localhost:4173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // CDP 浏览器未运行时优雅跳过（headless Chrome/Edge 需手动启动）
  try {
    await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.log(`SKIP: 未检测到 CDP 浏览器（${CDP}）。可用 --headless=new --remote-debugging-port=9223 启动后运行。`);
    process.exit(0);
  }

  const tab = await fetch(`${CDP}/json/new?${encodeURIComponent(APP_URL)}`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  await new Promise((r) => { ws.onopen = r; });
  await send("Runtime.enable");
  await sleep(1500);

  const evalJs = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };

  // 1. 点击"手动录入"进入编辑界面
  await evalJs(`document.querySelector("#manualButton").click(); true`);
  await sleep(400);

  const snapshot = () => evalJs(`JSON.stringify({
    poolTiles: document.querySelectorAll("#poolStrip .mahjong-tile").length,
    pickerTiles: document.querySelectorAll("#poolPicker .mahjong-tile").length,
    groupRows: document.querySelectorAll("#groupList .group-row").length,
    badges: [...document.querySelectorAll(".group-type-badge")].map((b) => b.textContent),
    poolEmoji: document.querySelector("#poolStrip .mahjong-tile")?.textContent.length === 2,
    winMark: document.querySelectorAll("#poolStrip .win-mark").length,
    winTileLabel: document.querySelector("#winTileButton")?.textContent,
    totalFu: document.querySelector("#totalFu")?.textContent,
    status: document.querySelector("#poolStatus")?.textContent,
  })`);

  console.log("[1] 初始状态:", await snapshot());

  // 2. 雀头行无明暗开关，刻子行有
  const toggleInfo = await evalJs(`JSON.stringify([...document.querySelectorAll("#groupList .group-row")].map((r) => {
    const badge = r.querySelector(".group-type-badge")?.textContent;
    const toggle = r.querySelector(".mini-toggle");
    return { badge, toggleShown: toggle ? !toggle.hidden : null };
  }))`);
  console.log("[2] 结构行(徽章/明暗开关):", toggleInfo);

  // 3. 默认和牌张 p6 → 双碰听自动识别
  console.log("[3] 听牌型自动识别:", await evalJs(`JSON.stringify({
    activeWait: document.querySelector("#waitTypeControl button.active")?.textContent,
    breakdown: document.querySelector("#breakdown").textContent.slice(0, 90),
  })`));

  // 4. 风位：自风改为南 → 自风雀头加符消失
  await evalJs(`document.querySelector("#seatWindControl button[data-value='z2']").click(); true`);
  await sleep(300);
  console.log("[4] 自风=南后:", await evalJs(`JSON.stringify({
    activeSeat: document.querySelector("#seatWindControl button.active")?.textContent,
    breakdown: document.querySelector("#breakdown").textContent.slice(0, 120),
  })`));

  // 5. 打开和牌张选择弹层 → 点选 s6（两面听）
  await evalJs(`document.querySelector("#winTileButton").click(); true`);
  await sleep(300);
  await evalJs(`[...document.querySelectorAll("#winPickerTiles .mahjong-tile")].find((t) => t.dataset.code === "s6").click(); true`);
  await sleep(300);
  console.log("[5] 弹层选择和牌张后:", await evalJs(`JSON.stringify({
    winTile: document.querySelector("#winTileButton")?.textContent,
    activeWait: document.querySelector("#waitTypeControl button.active")?.textContent,
    winMark: document.querySelectorAll("#poolStrip .win-mark").length,
    pickerClosed: document.querySelector("#winPickerBackdrop").hidden,
  })`));

  // 6. 加入第 15 张（m5）→ 无杠子应报错、结构清空
  await evalJs(`[...document.querySelectorAll("#poolPicker .mahjong-tile")].find((t) => t.dataset.code === "m5").click(); true`);
  await sleep(300);
  console.log("[6] 15张无杠:", await snapshot());

  // 7. 移除一张 → 恢复 14 张有效
  await evalJs(`document.querySelector("#poolStrip .mahjong-tile").click(); true`);
  await sleep(300);
  console.log("[7] 移除后:", await snapshot());

  // 8. 门清时明暗开关禁用；解除后勾选明刻 → 明刻 +2 符
  const disabledWhenClosed = await evalJs(`(() => {
    const row = [...document.querySelectorAll("#groupList .group-row")].find((r) => r.querySelector(".group-type-badge")?.textContent.includes("刻子"));
    return row.querySelector(".group-open").disabled;
  })(); true`);
  await evalJs(`document.querySelector("#closedToggle").click(); true`);
  await sleep(200);
  await evalJs(`(() => {
    const row = [...document.querySelectorAll("#groupList .group-row")].find((r) => r.querySelector(".group-type-badge")?.textContent.includes("刻子"));
    row.querySelector(".group-open").click();
    return true;
  })(); true`);
  await sleep(300);
  console.log("[8] 门清时开关禁用:", disabledWhenClosed, "→ 解除后勾选明刻:", await evalJs(`JSON.stringify({
    closed: document.querySelector("#closedToggle").checked,
    openFlag: [...document.querySelectorAll("#groupList .group-row")].find((r) => r.querySelector(".group-type-badge")?.textContent.includes("刻子")).querySelector(".group-open")?.checked,
    breakdown: document.querySelector("#breakdown").textContent.slice(0, 90),
  })`));

  ws.close();
  console.log("SMOKE OK");
  process.exit(0);
}

main().catch((e) => { console.error("SMOKE FAIL:", e.message); process.exit(1); });

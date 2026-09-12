// 符镜 · 主控制器（浏览器端，ES Module）
// 职责：UI 状态机 + 事件绑定 + 渲染。编排以下模块：
//   fu.js    牌库录入 → 面子拆分 → 符数明细
//   yaku.js  番数（役种检测，含役满/复合/累计役满）与点数（查表 + 本场）
//   yolo.js  前端本地 YOLO 推理（onnxruntime-web / WASM，离线识别主路径）
//   tiles.js 牌码（m1..z7）→ emoji / 中文名
// 识别流程：拍照/相册 → 前端 ORT 推理（detectLocal）→ 失败回退 /api/recognize
//           （服务端 Python YOLO → Ollama 本地兜底，无任何云端 LLM API）
// 状态约定：pool[] 牌库牌码；hand 结构见 fu.js normalizeHand；
//           winTile 和牌张；handType 自动派生（regular/chiitoitsu/kokushi）
// 交互约束（联动开关）：立直↔门清、门清↔明刻、抢杠/海底/岭上三选一、
//           岭上→自摸、抢杠→荣和、一发→立直（计算层另有防御，见 yaku.js）
import {
  calculateFu, groupFu, normalizeHand, decomposePool, detectWaitType,
  isTerminalOrHonorTile, pairFu, GROUP_TYPES,
} from "./fu.js?v=24";
import { TILE_LABELS, TILE_CODES, TILE_EMOJI } from "./tiles.js?v=24";
import { detectLocal, annotateLocal, YOLO_ACCEPT_CONF, normalizeAcceptConfidence, isAndroidApp } from "./yolo.js?v=24";
import { detectYaku, calculatePoints, isDealerByWinds, sequencePairCount } from "./yaku.js?v=24";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const thresholdStorageKey = "fu-lens-yolo-threshold";
let recognitionThreshold = YOLO_ACCEPT_CONF;
try { recognitionThreshold = normalizeAcceptConfidence(localStorage.getItem(thresholdStorageKey)); } catch { /* Storage may be unavailable. */ }
function updateRecognitionThreshold(value) {
  recognitionThreshold = normalizeAcceptConfidence(value);
  $("#recognitionThreshold").value = recognitionThreshold;
  $("#recognitionThresholdValue").value = recognitionThreshold.toFixed(2);
  try { localStorage.setItem(thresholdStorageKey, String(recognitionThreshold)); } catch { /* Keep the in-memory setting. */ }
}
updateRecognitionThreshold(recognitionThreshold);
$("#recognitionThreshold").addEventListener("input", (event) => updateRecognitionThreshold(event.target.value));
$("#resetRecognitionThreshold").addEventListener("click", () => updateRecognitionThreshold(YOLO_ACCEPT_CONF));

const defaultHand = () => ({
  handType: "regular",
  winMethod: "ron",
  closed: true,
  waitType: "shanpon",
  roundWind: "z1",
  seatWind: "z1",
  pair: { tile: "z1", dragon: false, seatWind: false, roundWind: false },
  groups: [
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["m2", "m3", "m4"] },
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["p3", "p4", "p5"] },
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["s6", "s7", "s8"] },
    { type: "triplet", open: false, terminalOrHonor: false, tiles: ["p6", "p6", "p6"] },
    { type: "pair", open: false, terminalOrHonor: false, tiles: ["z1", "z1"] },
  ],
  customFu: [],
  confidence: 0,
  notes: "",
});

const DEFAULT_POOL = [
  "m2", "m3", "m4", "p3", "p4", "p5", "s6", "s7", "s8", "p6", "p6", "p6", "z1", "z1",
];

let hand = defaultHand();
let pool = [...DEFAULT_POOL];
let groupOpenFlags = [false, false, false, false, false];
let decompIndex = 0;
let winTile = "p6";
let imageData = "";
let objectUrl = "";
let lowConfidence = [];      // 置信度低于阈值的未识别牌（不入库，供人工校对）
let recognizedFromPhoto = false;
// 番数/点数状态
let honba = 0;               // 本场数（连庄）
let riichi = false;
let ippatsu = false;
let chankan = false;         // 抢杠
let haitei = false;          // 海底/河底
let rinshan = false;         // 岭上开花
let doraCount = 0;           // 宝牌（统一计数，不区分表宝/里宝）

function tileElement(code, extraClass = "") {
  const tile = document.createElement("span");
  tile.className = `mahjong-tile ${extraClass}`.trim();
  tile.dataset.suit = code?.[0] || "z";
  tile.dataset.code = code;
  tile.textContent = TILE_EMOJI[code] || "?";
  tile.title = TILE_LABELS[code] || code || "未知牌张";
  return tile;
}

// 从牌库自动判断牌型：
// - 恰好 7 种牌各 2 张 → 七对子
// - 14 张 = 13 种幺九牌（1m9m1p9p1s9s+z1-7）+ 其中 1 种重复 → 国士无双
// - 否则普通型（平和自摸由计算层自动判定）
const KOKUSHI_YAOCHU = ["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"];
function deriveHandType(pool) {
  // 国士：13 张（听牌）或 14 张（和牌）= 13 种幺九 + 至多 1 种重复
  if (pool.length === 13 || pool.length === 14) {
    const counts = new Map();
    for (const tile of pool) counts.set(tile, (counts.get(tile) || 0) + 1);
    const isKokushi = [...counts.entries()].every(([tile, n]) => KOKUSHI_YAOCHU.includes(tile) && n <= 2)
      && [...counts.values()].filter((n) => n === 2).length <= 1;
    if (isKokushi) return "kokushi";
  }
  if (pool.length !== 14) return "regular";
  const counts = new Map();
  for (const tile of pool) counts.set(tile, (counts.get(tile) || 0) + 1);
  if (counts.size === 7 && [...counts.values()].every((n) => n === 2)) {
    // 两杯口与七对子不复合；可拆成两杯口时使用四面子结构计算符数与复合役。
    if (decomposePool(pool).solutions.some((groups) => sequencePairCount(groups) === 2)) return "regular";
    return "chiitoitsu";
  }
  return "regular";
}

function groupsFromMelds(melds) {
  if (groupOpenFlags.length !== melds.length) groupOpenFlags = melds.map(() => false);
  return melds.map((meld, index) => ({
    type: meld.type,
    open: Boolean(groupOpenFlags[index]),
    terminalOrHonor: meld.type === "sequence" || meld.type === "pair"
      ? false
      : meld.tiles.every(isTerminalOrHonorTile),
    tiles: meld.tiles,
  }));
}

function syncPairFromGroups() {
  const pairMeld = hand.groups.find((group) => group.type === "pair");
  hand.pair.tile = pairMeld?.tiles[0] || "";
}

function syncWaitType() {
  // 特殊牌型：国士固定"特殊"（十三面/单骑听）
  if (hand.handType === "kokushi") {
    hand.waitType = "special";
    return;
  }
  if (!winTile) return;
  const detected = detectWaitType(hand.groups, winTile);
  if (detected) hand.waitType = detected;
}

// 牌张排序：万字 1-9 → 饼子 1-9 → 索子 1-9 → 字牌（东南西北白发中）
const SUIT_ORDER = { m: 0, p: 1, s: 2, z: 3 };
const tileOrder = (a, b) => {
  const sa = SUIT_ORDER[a?.[0]] ?? 4;
  const sb = SUIT_ORDER[b?.[0]] ?? 4;
  if (sa !== sb) return sa - sb;
  return Number(a?.[1]) - Number(b?.[1]);
};

function applyPool() {
  pool.sort(tileOrder); // 牌库自动排序（万→饼→索→字）
  hand.handType = deriveHandType(pool); // 自动判断：七对子 / 国士（含听牌）/ 普通型
  hand.pool = pool.slice(); // 供役种检测（国士等特殊牌型）
  decompIndex = 0;
  if (hand.handType === "kokushi") {
    // 国士：无面子结构，直接构造单张组（供役种检测统计）
    hand.groups = pool.map((tile) => ({ type: "single", open: false, tiles: [tile] }));
    hand.pair.tile = pool[0] || "z1";
  } else if (hand.handType === "chiitoitsu") {
    // 七对子：构造 7 组对子结构（供役种检测与显示）
    const counts = new Map();
    for (const tile of pool) counts.set(tile, (counts.get(tile) || 0) + 1);
    hand.groups = [...counts].map(([tile]) => ({
      type: "pair", open: false, terminalOrHonor: false, tiles: [tile, tile],
    }));
    hand.pair.tile = [...counts.keys()][0] || "z1";
  } else {
    const { solutions } = decomposePool(pool);
    const ryanpeikouIndex = solutions.findIndex((groups) => sequencePairCount(groups) === 2);
    decompIndex = ryanpeikouIndex >= 0 ? ryanpeikouIndex : 0;
    hand.groups = solutions.length ? groupsFromMelds(solutions[decompIndex]) : [];
    syncPairFromGroups();
  }
  if (winTile && !pool.includes(winTile)) winTile = null;
  syncWaitType();
  return 0;
}

function cycleDecomposition() {
  const { solutions } = decomposePool(pool);
  if (solutions.length < 2) return;
  decompIndex = (decompIndex + 1) % solutions.length;
  hand.groups = groupsFromMelds(solutions[decompIndex]);
  syncPairFromGroups();
  syncWaitType();
  render();
}

function renderWinTile() {
  const button = $("#winTileButton");
  if (winTile && pool.includes(winTile)) {
    button.textContent = TILE_EMOJI[winTile];
    button.title = `${TILE_LABELS[winTile]} · 点击选择和牌张`;
    button.classList.remove("empty");
    button.setAttribute("aria-label", `和牌张为 ${TILE_LABELS[winTile]}，点击选择`);
  } else {
    winTile = null;
    button.textContent = "?";
    button.title = "和牌张 · 点击选择";
    button.classList.add("empty");
    button.setAttribute("aria-label", "和牌张未选择，点击选择");
  }
}

function renderPool() {
  const strip = $("#poolStrip");
  strip.replaceChildren(...pool.map((code, index) => {
    const tile = tileElement(code, "pool-tile");
    tile.title = `${TILE_LABELS[code] || code} · 点击移除`;
    tile.setAttribute("role", "button");
    if (code === winTile) {
      const mark = document.createElement("i");
      mark.className = "win-mark";
      mark.textContent = "胡";
      tile.append(mark);
    }
    tile.addEventListener("click", () => {
      pool.splice(index, 1);
      applyPool();
      render();
    });
    return tile;
  }));

  const { solutions } = decomposePool(pool);
  const status = $("#poolStatus");
  if (hand.handType === "kokushi") {
    status.textContent = pool.length === 13
      ? "国士无双听牌：13 种幺九（差 1 张可和，役满）"
      : "国士无双：13 种幺九牌各 1 张 + 任意 1 张重复（役满）";
    status.classList.toggle("error", false);
  } else if (hand.handType === "chiitoitsu") {
    status.textContent = "七对子：7 种牌各 2 张（固定 25 符）";
    status.classList.toggle("error", false);
  } else if (pool.length < 14) {
    status.textContent = `还需 ${14 - pool.length} 张牌（共 14 张：面子 12 张 + 雀头 2 张，每含 1 组杠子多 1 张）`;
    status.classList.toggle("error", false);
  } else if (pool.length > 18) {
    status.textContent = "牌库最多 18 张（4 组杠子）";
    status.classList.toggle("error", true);
  } else if (!solutions.length) {
    status.textContent = pool.length === 14
      ? "这 14 张牌无法拆分为四组面子与雀头，请增删调整"
      : `已 ${pool.length} 张 · 需含 ${pool.length - 14} 组杠子且能拆分`;
    status.classList.toggle("error", true);
  } else {
    status.textContent = `已 ${pool.length} 张 · 自动拆分完成（雀头与听牌型已识别）${solutions.length > 1 ? `（另有 ${solutions.length - 1} 种拆法）` : ""}`;
    status.classList.toggle("error", false);
  }

  const picker = $("#poolPicker");
  picker.replaceChildren(...TILE_CODES.map((code) => {
    const tile = tileElement(code);
    const used = pool.filter((t) => t === code).length;
    const locked = used >= 4 || pool.length >= 18;
    tile.classList.toggle("disabled", locked);
    tile.setAttribute("role", "button");
    tile.title = locked ? `${TILE_LABELS[code]} · 已达上限` : `加入 ${TILE_LABELS[code]}`;
    tile.addEventListener("click", () => {
      if (locked) return;
      pool.push(code);
      applyPool();
      render();
    });
    return tile;
  }));

  $("#cycleDecompButton").hidden = solutions.length < 2 || hand.handType !== "regular";
  $("#groupList").hidden = hand.handType !== "regular";
}

function setActive(container, value) {
  container.querySelectorAll("button[data-value]").forEach((button) => {
    button.classList.toggle("active", button.dataset.value === value);
  });
}

function renderRecognizedTiles() {
  const strip = $("#recognizedStrip");
  if (!recognizedFromPhoto) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  // 显示实际牌库，不从拆分结果或默认雀头补牌。
  const tiles = [...pool];
  // 低置信度牌（未入库）以红色样式展示，点击可加入牌库人工校对
  const tileList = tiles.map((code) => tileElement(code));
  for (const det of lowConfidence) {
    const code = det.tile;
    if (!code) continue;
    const tile = tileElement(code, "low-conf");
    tile.title = `${TILE_LABELS[code] || code} · 置信度 ${det.confidence.toFixed(2)}，点击加入牌库`;
    tile.setAttribute("role", "button");
    tile.addEventListener("click", () => {
      if (pool.filter((t) => t === code).length >= 4 || pool.length >= 18) return;
      pool.push(code);
      applyPool();
      lowConfidence = lowConfidence.filter((item) => item !== det);
      render();
    });
    tileList.push(tile);
  }
  $("#recognizedTiles").replaceChildren(...tileList);
  const note = $("#modelNote");
  note.textContent = hand.notes;
  note.hidden = !hand.notes;
}

function renderGroups() {
  const list = $("#groupList");
  list.replaceChildren();
  const ordered = hand.groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => (a.group.type === "pair" ? -1 : b.group.type === "pair" ? 1 : 0));
  let meldNo = 0;
  for (const { group, index } of ordered) {
    const row = $("#groupTemplate").content.firstElementChild.cloneNode(true);
    const isPair = group.type === "pair";
    row.querySelector(".group-index").textContent = isPair ? "雀头" : `面子 ${String(++meldNo).padStart(2, "0")}`;
    const badge = row.querySelector(".group-type-badge");
    if (isPair) {
      badge.textContent = "雀头";
      badge.classList.remove("sequence");
    } else {
      badge.textContent = GROUP_TYPES[group.type] + (group.type !== "sequence" && group.terminalOrHonor ? " · 幺九" : "");
      badge.classList.toggle("sequence", group.type === "sequence");
    }
    const toggle = row.querySelector(".mini-toggle");
    const open = row.querySelector(".group-open");
    if (group.type === "sequence" || isPair) {
      toggle.hidden = true;
    } else {
      toggle.hidden = false;
      open.checked = group.open;
      // 明刻/明杠开关始终可点：点击"明"自动取消门清（门清开启时自动清明刻由 closedToggle 事件处理）
      open.addEventListener("change", (event) => {
        group.open = event.target.checked;
        groupOpenFlags[index] = event.target.checked;
        if (group.open) {
          // 明刻/明杠 = 副露：取消门清，立直随之失效
          hand.closed = false;
          riichi = false;
        }
        render();
      });
    }
    row.querySelector(".mini-tiles").replaceChildren(...(group.tiles || []).map((code) => tileElement(code)));
    const value = isPair ? pairFu(hand.pair) : groupFu(group);
    row.querySelector(".group-fu").textContent = value ? `+${value} 符` : "0 符";
    list.append(row);
  }
}

function renderResult() {
  const result = calculateFu(hand);
  $("#totalFu").textContent = result.total;
  $("#breakdown").replaceChildren(...result.items.map((item) => {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    row.innerHTML = `<span></span><strong></strong>`;
    row.querySelector("span").textContent = item.label;
    row.querySelector("strong").textContent = `${item.fu > 0 ? "+" : ""}${item.fu} 符`;
    return row;
  }));

  if (result.fixed) {
    if (hand.handType === "kokushi") {
      $("#formula").textContent = "国士无双（役满）· 不计符数";
      $("#resultNote").textContent = "国士无双为役满牌型，固定 13 番 / 役满点数（子 32000 / 亲 48000）。";
    } else {
      $("#formula").textContent = "固定符数 · 不进位";
      $("#resultNote").textContent = hand.handType === "chiitoitsu"
        ? "七对子按固定 25 符计算。"
        : "平和自摸按固定 20 符计算，自摸 2 符不另计。";
    }
  } else {
    $("#formula").textContent = result.raw === result.total
      ? `合计 ${result.raw} 符`
      : `原始 ${result.raw} 符 · 十位进位`;
    $("#resultNote").textContent = result.raw === 20 && result.total === 30
      ? "副露且没有其他加符的荣和牌形，按最低 30 符计算。"
      : "符数按各项相加后向上取整到 10 符。";
  }
}

function renderYakuPoints() {
  hand.winTile = winTile; // 供国士十三面 / 纯正九莲判断
  const yakuResult = detectYaku(hand, { dora: doraCount, riichi, ippatsu, chankan, haitei, rinshan });
  const list = $("#yakuList");
  list.replaceChildren(...yakuResult.yaku.map((y) => {
    const chip = document.createElement("div");
    chip.className = `yaku-chip${y.yakuman ? " yakuman" : ""}`;
    const name = document.createElement("span");
    name.className = "yaku-name";
    name.textContent = y.name;
    const han = document.createElement("span");
    han.className = "yaku-han";
    han.textContent = y.yakuman ? (y.mult > 1 ? `役满×${y.mult}` : "役满") : `+${y.han} 番`;
    chip.append(name, han);
    return chip;
  }));
  if (!yakuResult.yaku.length) {
    const chip = document.createElement("div");
    chip.className = "yaku-chip";
    chip.innerHTML = `<span class="yaku-name">${yakuResult.incomplete ? "牌型未完成（牌数不足或无法拆分）" : "无役"}</span>`;
    list.append(chip);
  }
  $("#totalHan").textContent = yakuResult.han;
  const hanNote = $("#hanNote");
  hanNote.textContent = yakuResult.yakuman
    ? (yakuResult.yakumanCount > 1 ? `役满×${yakuResult.yakumanCount}（${yakuResult.han} 番）` : "役满")
    : yakuResult.han >= 13
      ? `累计役满（${yakuResult.han} 番）`
      : yakuResult.han >= 5
        ? `${yakuResult.han} 番 → ${["", "", "", "", "", "满贯", "跳满", "跳满", "倍满", "倍满", "倍满", "三倍满", "三倍满"][Math.min(yakuResult.han, 12)] || ""}`
        : "点数按符数 × 番数查表";

  const fu = hand.handType === "kokushi" ? 30 : calculateFu(hand).total;
  const isDealer = isDealerByWinds(hand.seatWind, hand.roundWind);
  const points = yakuResult.han > 0
    ? calculatePoints({ fu, han: yakuResult.han, winMethod: hand.winMethod, isDealer, honba, yakumanCount: yakuResult.yakumanCount || 1, yakuman: yakuResult.yakuman })
    : null;

  $("#ronPointsRow").hidden = hand.winMethod !== "ron";
  $("#tsumoPointsRow").hidden = hand.winMethod !== "tsumo";
  if (points && points.ron) {
    const effRon = points.honbaBonus ? points.honbaBonus.ron : points.ron;
    $("#ronPoints").textContent = effRon.toLocaleString("zh-CN");
  } else {
    $("#ronPoints").textContent = "—";
  }
  if (points && points.tsumo) {
    const effTsumo = points.honbaBonus ? points.honbaBonus.tsumo : points.tsumo;
    // 自摸：每家公司相同则只显示一个数字（不换行）；不同（子家 500/1000）保留差异
    $("#tsumoPoints").textContent = [...new Set(effTsumo)].join(" / ");
  } else {
    $("#tsumoPoints").textContent = "—";
  }
}

function render() {
  $("#workspace").hidden = false;
  setActive($("#winMethodControl"), hand.winMethod);
  setActive($("#roundWindControl"), hand.roundWind);
  setActive($("#seatWindControl"), hand.seatWind);
  setActive($("#waitTypeControl"), hand.waitType);
  $("#closedToggle").checked = hand.closed;
  $("#closedToggle").disabled = hand.handType !== "regular";
  $("#riichiToggle").checked = riichi;
  $("#ippatsuToggle").checked = ippatsu;
  $("#ippatsuToggle").disabled = !riichi;
  if (!riichi && ippatsu) ippatsu = false;
  $("#chankanToggle").checked = chankan;
  $("#haiteiToggle").checked = haitei;
  $("#rinshanToggle").checked = rinshan;
  $("#honbaValue").textContent = honba;
  $("#doraValue").textContent = doraCount;
  // 特殊牌型（七对子）隐藏听牌形区；国士显示并锁定"特殊"
  $("#waitBlock").hidden = hand.handType !== "regular" && hand.handType !== "kokushi";
  $$("#waitTypeControl button").forEach((btn) => {
    const isSpecial = btn.dataset.value === "special";
    btn.disabled = hand.handType === "kokushi" && !isSpecial;
  });
  // 雀头役牌自动识别：三元牌 / 自风 / 场风
  hand.pair.dragon = ["z5", "z6", "z7"].includes(hand.pair.tile);
  hand.pair.seatWind = hand.pair.tile === hand.seatWind;
  hand.pair.roundWind = hand.pair.tile === hand.roundWind;
  const badge = $("#confidenceBadge");
  badge.hidden = !hand.confidence;
  badge.textContent = hand.confidence ? `识别 ${Math.round(hand.confidence * 100)}%` : "";
  renderRecognizedTiles();
  renderWinTile();
  renderPool();
  renderGroups();
  renderYakuPoints();
  renderResult();
}

function openManual() {
  hand = defaultHand();
  pool = [...DEFAULT_POOL];
  groupOpenFlags = [false, false, false, false, false];
  decompIndex = 0;
  winTile = "p6";
  lowConfidence = [];
  recognizedFromPhoto = false;
  applyPool();
  render();
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleSegment(container, callback) {
  container.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (button) callback(button.dataset.value);
  });
}

handleSegment($("#winMethodControl"), (value) => { hand.winMethod = value; render(); });
handleSegment($("#roundWindControl"), (value) => { hand.roundWind = value; render(); });
handleSegment($("#seatWindControl"), (value) => { hand.seatWind = value; render(); });
handleSegment($("#waitTypeControl"), (value) => { hand.waitType = value; render(); });

$("#closedToggle").addEventListener("change", (event) => {
  hand.closed = event.target.checked;
  if (hand.closed) {
    hand.groups.forEach((group) => { group.open = false; });
    groupOpenFlags = groupOpenFlags.map(() => false);
  } else {
    // 副露后立直不成立
    riichi = false;
  }
  render();
});

function openWinPicker() {
  const distinct = [...new Set(pool)].sort(tileOrder);
  if (!distinct.length) return;
  const container = $("#winPickerTiles");
  container.replaceChildren(...distinct.map((code) => {
    const tile = tileElement(code);
    tile.classList.toggle("active", code === winTile);
    tile.setAttribute("role", "button");
    tile.title = `选择 ${TILE_LABELS[code]} 为和牌张`;
    tile.addEventListener("click", () => {
      winTile = code;
      syncWaitType();
      closeWinPicker();
      render();
    });
    return tile;
  }));
  $("#winPickerBackdrop").hidden = false;
}

function closeWinPicker() {
  $("#winPickerBackdrop").hidden = true;
}

$("#winTileButton").addEventListener("click", openWinPicker);
$("#winPickerClose").addEventListener("click", closeWinPicker);
$("#winPickerBackdrop").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeWinPicker();
});

$("#cycleDecompButton").addEventListener("click", cycleDecomposition);

$("#honbaStepper").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-step]");
  if (!button) return;
  honba = Math.max(0, Math.min(99, honba + Number(button.dataset.step)));
  render();
});

$("#clearPoolButton").addEventListener("click", () => {
  pool.length = 0;
  winTile = null;
  applyPool();
  render();
  setStatus("牌库已清空");
});

$("#riichiToggle").addEventListener("change", (event) => {
  riichi = event.target.checked;
  if (riichi) {
    // 立直必须门清：强制门清并清除所有明刻/明杠
    hand.closed = true;
    hand.groups.forEach((group) => { group.open = false; });
    groupOpenFlags = groupOpenFlags.map(() => false);
  }
  if (!riichi) ippatsu = false;
  render();
});
$("#ippatsuToggle").addEventListener("change", (event) => {
  ippatsu = event.target.checked;
  render();
});
$("#chankanToggle").addEventListener("change", (event) => {
  chankan = event.target.checked;
  if (chankan) {
    // 特殊和牌方式互斥（不可能同时发生）；抢杠为荣和
    haitei = false;
    rinshan = false;
    hand.winMethod = "ron";
  }
  render();
});
$("#haiteiToggle").addEventListener("change", (event) => {
  haitei = event.target.checked;
  if (haitei) {
    // 海底与抢杠/岭上互斥
    chankan = false;
    rinshan = false;
  }
  render();
});
$("#rinshanToggle").addEventListener("change", (event) => {
  rinshan = event.target.checked;
  if (rinshan) {
    // 岭上开花必须自摸；与抢杠/海底互斥
    chankan = false;
    haitei = false;
    hand.winMethod = "tsumo";
  }
  render();
});

document.querySelectorAll(".dora-block .stepper button").forEach((button) => {
  button.addEventListener("click", () => {
    doraCount = Math.max(0, Math.min(10, doraCount + Number(button.dataset.dora)));
    render();
  });
});

$("#cameraButton").addEventListener("click", () => {
  // 弹出选择：拍照 / 从相册选择
  $("#capturePickerBackdrop").hidden = false;
});
$("#capturePickerCancel").addEventListener("click", () => {
  $("#capturePickerBackdrop").hidden = true;
});
$("#capturePickerBackdrop").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) $("#capturePickerBackdrop").hidden = true;
});
$("#captureTakeButton").addEventListener("click", () => {
  $("#capturePickerBackdrop").hidden = true;
  $("#photoInput").click();
});
$("#captureGalleryButton").addEventListener("click", () => {
  $("#capturePickerBackdrop").hidden = true;
  $("#galleryInput").click();
});
$("#replacePhotoButton").addEventListener("click", () => $("#photoInput").click());
$("#manualButton").addEventListener("click", openManual);

async function handlePhotoChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus("请选择图片文件。", true);
    return;
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  const preview = $("#photoPreview");
  preview.src = objectUrl;
  preview.hidden = false;
  $("#cameraEmpty").hidden = true;
  $("#recognizeButton").disabled = true;
  setStatus("正在整理照片…");
  try {
    imageData = await resizeImage(file);
    $("#recognizeButton").disabled = false;
    $("#cropButton").disabled = false;
    setStatus("照片已就绪，可裁剪聚焦或直接识别");
  } catch {
    imageData = "";
    setStatus("无法读取这张照片，请更换后重试。", true);
  }
}
$("#photoInput").addEventListener("change", handlePhotoChange);
$("#galleryInput").addEventListener("change", handlePhotoChange);

// === 照片裁剪（手动聚焦识别区域）===
let cropState = null;
let cropDrag = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function renderCropBox() {
  const box = $("#cropBox");
  const { x, y, w, h } = cropState.box;
  box.style.left = `${x}px`;
  box.style.top = `${y}px`;
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
}

function openCrop() {
  const wrap = $("#cropCanvasWrap");
  const img = $("#cropImage");
  img.src = objectUrl || imageData;
  $("#cropBackdrop").hidden = false;
  img.onload = () => {
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const scale = Math.min(wrapW / img.naturalWidth, wrapH / img.naturalHeight);
    const dispW = img.naturalWidth * scale;
    const dispH = img.naturalHeight * scale;
    const dispX = (wrapW - dispW) / 2;
    const dispY = (wrapH - dispH) / 2;
    cropState = {
      imgW: img.naturalWidth, imgH: img.naturalHeight,
      dispX, dispY, dispW, dispH,
      box: { x: dispX, y: dispY, w: dispW, h: dispH },
    };
    renderCropBox();
  };
}

function closeCrop() {
  $("#cropBackdrop").hidden = true;
  cropState = null;
  cropDrag = null;
}

$("#cropButton").addEventListener("click", () => {
  if (!imageData && !objectUrl) return;
  openCrop();
});
$("#cropCancelButton").addEventListener("click", closeCrop);

const cropBoxEl = $("#cropBox");
cropBoxEl.addEventListener("pointerdown", (event) => {
  if (!cropState) return;
  const handle = event.target.closest("i")?.dataset.handle || "move";
  cropDrag = { handle, startX: event.clientX, startY: event.clientY, box: { ...cropState.box } };
  cropBoxEl.setPointerCapture(event.pointerId);
  event.preventDefault();
});
cropBoxEl.addEventListener("pointermove", (event) => {
  if (!cropDrag || !cropState) return;
  const dx = event.clientX - cropDrag.startX;
  const dy = event.clientY - cropDrag.startY;
  const b = { ...cropDrag.box };
  const { dispX, dispY, dispW, dispH } = cropState;
  const min = 48;
  if (cropDrag.handle === "move") {
    b.x = clamp(b.x + dx, dispX, dispX + dispW - b.w);
    b.y = clamp(b.y + dy, dispY, dispY + dispH - b.h);
  } else {
    if (cropDrag.handle.includes("w")) {
      const nx = clamp(b.x + dx, dispX, b.x + b.w - min);
      b.w = b.w - (nx - b.x);
      b.x = nx;
    }
    if (cropDrag.handle.includes("e")) b.w = clamp(b.w + dx, min, dispX + dispW - b.x);
    if (cropDrag.handle.includes("n")) {
      const ny = clamp(b.y + dy, dispY, b.y + b.h - min);
      b.h = b.h - (ny - b.y);
      b.y = ny;
    }
    if (cropDrag.handle.includes("s")) b.h = clamp(b.h + dy, min, dispY + dispH - b.y);
  }
  cropState.box = b;
  renderCropBox();
});
cropBoxEl.addEventListener("pointerup", () => { cropDrag = null; });
cropBoxEl.addEventListener("pointercancel", () => { cropDrag = null; });

$("#cropConfirmButton").addEventListener("click", () => {
  if (!cropState) return;
  const { imgW, imgH, dispX, dispY, dispW, dispH, box } = cropState;
  const sx = ((box.x - dispX) / dispW) * imgW;
  const sy = ((box.y - dispY) / dispH) * imgH;
  const sw = (box.w / dispW) * imgW;
  const sh = (box.h / dispH) * imgH;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  canvas.getContext("2d", { alpha: false }).drawImage($("#cropImage"), sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  imageData = canvas.toDataURL("image/jpeg", 0.9);
  const preview = $("#photoPreview");
  preview.src = imageData;
  preview.hidden = false;
  $("#cameraEmpty").hidden = true;
  $("#recognizeButton").disabled = false;
  closeCrop();
  setStatus("已裁剪，可开始识别");
});

function setStatus(message, error = false) {
  $("#recognitionStatus").textContent = message;
  $("#recognitionStatus").classList.toggle("error", error);
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const maxSide = 1600;
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", .86));
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image decode failed")); };
    image.src = url;
  });
}

$("#recognizeButton").addEventListener("click", async () => {
  if (!imageData) return;
  const threshold = recognitionThreshold;
  $("#recognizeButton").disabled = true;
  $("#recognitionThreshold").disabled = true;
  $("#resetRecognitionThreshold").disabled = true;
  $("#scanLine").hidden = false;
  setStatus("正在本地识别牌张…");
  try {
    let result = null;
    let annotated = "";
    let backend = "";
    // ① 优先：前端 onnxruntime-web 推理（完全离线，SW 缓存后断网可用）
    try {
      result = await detectLocal(imageData, threshold);
      backend = "yolo-web";
    } catch (error) {
      if (isAndroidApp()) throw error;
      console.warn("前端推理不可用，回退服务端识别:", error.message);
    }
    if (result) {
      annotated = await annotateLocal(imageData, result.accepted, result.lowConfidence);
    } else {
      // ② 回退：服务端本地 YOLO（需可访问后端）
      const response = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: imageData, accept_threshold: threshold }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "识别服务暂不可用");
      if (data.backend === "ollama") {
        // 兜底：保留的本地 Ollama 端口（不涉及云端 API）
        hand = { ...normalizeHand(data.hand), customFu: [] };
        if (hand.handType === "pinfu") hand.handType = "regular"; // 平和并入普通型自动判定
        pool = [...hand.groups.flatMap((group) => group.tiles), hand.pair.tile, hand.pair.tile];
        groupOpenFlags = hand.groups.map((group) => group.open);
        decompIndex = 0;
        winTile = null;
        lowConfidence = [];
        recognizedFromPhoto = true;
        render();
        setStatus("识别完成（Ollama 本地模型），请校对牌姿");
        $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      result = { accepted: data.accepted, lowConfidence: data.lowConfidence, accept_threshold: data.accept_threshold ?? threshold, model: data.model };
      annotated = data.annotated || "";
      backend = data.backend;
    }
    // 应用 YOLO 识别结果：牌库 = 置信度达标牌；荣和/自摸与和牌张由用户手动指定
    const acceptConf = result.accept_threshold ?? threshold;
    const poolFromDetections = result.accepted
      .map((detection) => detection.tile)
      .filter((tile) => tile && /^(?:[mps][1-9]|z[1-7])$/.test(tile));
    const lowCount = (result.lowConfidence || []).length;
    hand = {
      ...defaultHand(),
      notes: lowCount
        ? `红框标注的 ${lowCount} 张牌置信度低于 ${acceptConf}，未加入牌库，请人工校对`
        : `全部 ${poolFromDetections.length} 张牌置信度达标，已加入牌库`,
    };
    pool = [...poolFromDetections];
    groupOpenFlags = [false, false, false, false, false];
    decompIndex = 0;
    winTile = null; // 和牌张手动指定
    lowConfidence = [...(result.lowConfidence || [])];
    recognizedFromPhoto = true;
    applyPool();
    render();
    if (annotated) {
      const preview = $("#photoPreview");
      preview.src = annotated; // 标注图：绿框=已入库，红框=未识别待校对
      preview.hidden = false;
      $("#cameraEmpty").hidden = true;
    }
    const lowMsg = lowCount ? `，${lowCount} 张未识别牌已标红` : "";
    setStatus(`识别完成（${backend === "yolo-web" ? "离线" : "本地"} YOLO nano${lowMsg}），请手动指定荣和/自摸与和牌张`);
    $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error("Local recognition:", error.message);
    setStatus(`${error.message}。可先使用手动录入。`, true);
  } finally {
    $("#recognizeButton").disabled = false;
    $("#recognitionThreshold").disabled = false;
    $("#resetRecognitionThreshold").disabled = false;
    $("#scanLine").hidden = true;
  }
});

$("#resetButton").addEventListener("click", () => {
  hand = defaultHand();
  pool = [...DEFAULT_POOL];
  groupOpenFlags = [false, false, false, false, false];
  decompIndex = 0;
  winTile = "p6";
  lowConfidence = [];
  recognizedFromPhoto = false;
  applyPool();
  imageData = "";
  $("#workspace").hidden = true;
  $("#photoPreview").hidden = true;
  $("#photoPreview").removeAttribute("src");
  $("#cameraEmpty").hidden = false;
  $("#recognizeButton").disabled = true;
  $("#cropButton").disabled = true;
  $("#photoInput").value = "";
  setStatus("");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

if ("serviceWorker" in navigator && !isAndroidApp()) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// APK assets are already offline. Remove PWA caches left by earlier APK versions.
if ("serviceWorker" in navigator && isAndroidApp()) {
  navigator.serviceWorker.getRegistrations().then(async (registrations) => {
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("fu-lens-")).map((key) => caches.delete(key)));
  }).catch((error) => console.warn("APK cache cleanup:", error.message));
}

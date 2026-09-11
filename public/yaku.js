// 符镜 · 番数/点数引擎（纯函数，浏览器与 Node 双端可用）
// 职责：手牌结构 + 选项 → 役种列表 / 番数 / 荣和与自摸点数
//   detectYaku(hand, opts) 役种检测。opts: dora/riichi/ippatsu/chankan/haitei/rinshan
//     - 普通役：立直/一发/门清自摸/平和/断幺/一杯口/二杯口/三色同顺刻/一气通贯/
//       对对和/三暗刻/三杠子/小三元/混老头/带幺九/混一色/清一色/役牌/宝牌 等
//     - 役满（收集式，可复合叠加）：字一色/清老头/绿一色/四杠子/大三元/
//       四暗刻（单骑=2 倍）/国士（十三面=2 倍，由 winTile 判定）
//     - 特殊：手牌总番 ≥13 且无役满牌型 → 累计役满（点数同役满）
//     - 防御性约束：抢杠>海底>岭上 三选一；立直要求门清
//   calculatePoints() 点数表（子/亲独立标准表 + 满贯以上档位 + 本场 + 多倍役满）
//   注意：hand.winTile 用于国士十三面判定；handType="kokushi" 时 groups 为
//         每张牌一个 {type:"single"} 的组（analyze 不适用，国士分支自行统计）
const SUITS = { m: "万", p: "饼", s: "索" };

function isHonor(tile) { return tile[0] === "z"; }
function isTerminal(tile) { return tile[1] === "1" || tile[1] === "9"; }
function isYaochu(tile) { return isHonor(tile) || isTerminal(tile); }
function isDragon(tile) { return tile === "z5" || tile === "z6" || tile === "z7"; }
function isWind(tile) { return tile[0] === "z" && tile[1] !== "5" && tile[1] !== "6" && tile[1] !== "7"; }

// 手牌拆解：groups（含 pair 组）→ 统计
function analyze(hand) {
  const groups = hand.groups || [];
  const pairGroup = groups.find((g) => g.type === "pair");
  const melds = groups.filter((g) => g.type !== "pair");
  const pairTile = pairGroup?.tiles?.[0] || hand.pair?.tile || "";
  // tiles = 全部组展开（七对子的 7 组对子也计入）+ 无 pair 组时补雀头
  const tiles = [
    ...groups.flatMap((g) => g.tiles || []),
    ...(pairGroup ? [] : [pairTile, pairTile]),
  ].filter(Boolean);
  const counts = new Map();
  for (const t of tiles) counts.set(t, (counts.get(t) || 0) + 1);
  return { melds, pairTile, tiles, counts };
}

function sameSequence(a, b) {
  return a.type === "sequence" && b.type === "sequence" && a.tiles[0] === b.tiles[0];
}

// 役种检测 → [{ name, han, yakuman }]
export function detectYaku(hand, { dora = 0, riichi = false, ippatsu = false, chankan = false, haitei = false, rinshan = false } = {}) {
  const yaku = [];
  const { melds, pairTile, tiles, counts } = analyze(hand);

  // 计算层防御：抢杠/海底/岭上开花不可能同时发生（UI 已约束，此处兜底，优先级 抢杠 > 海底 > 岭上）
  if (chankan) {
    haitei = false;
    rinshan = false;
  } else if (haitei) {
    rinshan = false;
  }
  // 计算层防御：立直必须门清（UI 已约束，此处兜底）
  if (riichi && hand.closed === false) riichi = false;

  // 特殊牌型：国士 / 七对子（无面子结构）
  if (hand.handType === "kokushi") {
    // 国士：13 种幺九（听牌 13 张 / 和牌 14 张）。直接用全部牌统计（analyze 的补雀头逻辑不适用）
    const kokushiTiles = ["m1", "m9", "p1", "p9", "s1", "s9", "z1", "z2", "z3", "z4", "z5", "z6", "z7"];
    const allTiles = (hand.groups || []).flatMap((g) => g.tiles || []);
    const tileCounts = new Map();
    for (const t of kokushiTiles) tileCounts.set(t, allTiles.filter((x) => x === t).length);
    const listening = allTiles.length === 13;
    // 十三面：和牌时去掉和牌张后 13 种各 1；听牌时 13 张恰好 13 种各 1
    const thirteenFace = listening
      ? kokushiTiles.every((t) => tileCounts.get(t) === 1)
      : (() => {
          const win = hand.winTile;
          if (!win || !tileCounts.has(win) || tileCounts.get(win) < 1) return kokushiTiles.every((t) => tileCounts.get(t) === 1);
          const withoutWin = new Map(tileCounts);
          withoutWin.set(win, withoutWin.get(win) - 1);
          return kokushiTiles.every((t) => withoutWin.get(t) === 1);
        })();
    const name = thirteenFace ? "国士无双（十三面）" : "国士无双";
    return {
      yaku: [{ name, han: 13 * (thirteenFace ? 2 : 1), yakuman: true, mult: thirteenFace ? 2 : 1 }],
      han: 13 * (thirteenFace ? 2 : 1),
      yakuman: true,
      yakumanCount: thirteenFace ? 2 : 1,
      listening,
    };
  }
  if (hand.handType === "chiitoitsu") {
    // 特殊情况：字牌七对子 = 字一色（役满），优先级高于普通七对子
    if (tiles.every(isHonor)) {
      yaku.push({ name: "字一色（七对子）", han: 13, yakuman: true, mult: 1 });
      return { yaku, han: 13, yakuman: true, yakumanCount: 1 };
    }
    yaku.push({ name: "七对子", han: 2 });
    if (riichi) yaku.push({ name: "立直", han: 1 });
    if (ippatsu) yaku.push({ name: "一发", han: 1 });
    if (chankan) yaku.push({ name: "抢杠", han: 1 });
    if (haitei) yaku.push({ name: "海底/河底", han: 1 });
    if (rinshan) yaku.push({ name: "岭上开花", han: 1 });
    if (hand.winMethod === "tsumo") yaku.push({ name: "门清自摸", han: 1 });
    if (dora > 0) yaku.push({ name: "宝牌", han: dora });
    return { yaku, han: yaku.reduce((s, y) => s + y.han, 0), yakuman: false };
  }
  if (melds.length !== 4) {
    return { yaku, han: 0, yakuman: false, incomplete: true };
  }

  const closed = hand.closed !== false;
  const tsumo = hand.winMethod === "tsumo";
  const meldTypes = melds.map((m) => m.type);
  const allSequences = meldTypes.every((t) => t === "sequence");
  const quads = meldTypes.filter((t) => t === "quad").length;
  const triplets = melds.filter((m) => m.type !== "sequence");
  const darkMelds = melds.filter((m) => !m.open && m.type !== "sequence");
  const seqs = melds.filter((m) => m.type === "sequence");
  const suitsUsed = new Set(tiles.filter((t) => !isHonor(t)).map((t) => t[0]));
  const honorCount = tiles.filter(isHonor).length;

  // === 役满（收集式：可复合叠加，如 字一色+大三元+四暗刻 = 3 倍役满）===
  const yakuman = [];
  // 九莲按完整牌姿判定，不依赖拆分；纯正必须移除实际和牌张后恰为 1112345678999。
  if (closed && !melds.some((m) => m.open) && !quads && tiles.length === 14
      && tiles.every((t) => /^[mps][1-9]$/.test(t)) && suitsUsed.size === 1) {
    const suit = tiles[0][0];
    const base = [3, 1, 1, 1, 1, 1, 1, 1, 3];
    if (base.every((n, i) => (counts.get(suit + (i + 1)) || 0) >= n)) {
      const pure = base.every((n, i) => {
        const tile = suit + (i + 1);
        return counts.get(tile) - (hand.winTile === tile ? 1 : 0) === n;
      });
      yakuman.push({ name: pure ? "纯正九莲宝灯" : "九莲宝灯", mult: pure ? 2 : 1 });
    }
  }
  // 字一色：全部字牌
  if (honorCount === tiles.length) yakuman.push({ name: "字一色", mult: 1 });
  // 清老头：全部幺九（无字）
  if (!honorCount && tiles.every(isTerminal)) yakuman.push({ name: "清老头", mult: 1 });
  // 绿一色：2s3s4s6s8s + 發
  if (tiles.every((t) => ["s2", "s3", "s4", "s6", "s8", "z6"].includes(t))) yakuman.push({ name: "绿一色", mult: 1 });
  // 四杠子
  if (quads === 4) yakuman.push({ name: "四杠子", mult: 1 });
  // 大三元：z5/z6/z7 三组刻子
  if (["z5", "z6", "z7"].every((d) => counts.get(d) >= 3)) yakuman.push({ name: "大三元", mult: 1 });
  // 四暗刻 / 四暗刻单骑（单骑听牌 = 双倍）
  if (darkMelds.length === 4) {
    if (hand.waitType === "tanki") yakuman.push({ name: "四暗刻单骑", mult: 2 });
    else yakuman.push({ name: "四暗刻", mult: 1 });
  }
  if (yakuman.length) {
    const total = yakuman.reduce((s, y) => s + y.mult, 0);
    return {
      yaku: yakuman.map((y) => ({ name: y.name, han: 13 * y.mult, yakuman: true, mult: y.mult })),
      han: 13 * total,
      yakuman: true,
      yakumanCount: total,
    };
  }

  // === 普通役 ===
  // 立直（手动标记）/ 一发
  if (riichi) yaku.push({ name: "立直", han: 1 });
  if (ippatsu) yaku.push({ name: "一发", han: 1 });
  // 抢杠 / 海底河底 / 岭上开花（杠后自摸）
  if (chankan) yaku.push({ name: "抢杠", han: 1 });
  if (haitei) yaku.push({ name: "海底/河底", han: 1 });
  if (rinshan) yaku.push({ name: "岭上开花", han: 1 });
  // 门清自摸
  if (closed && tsumo) yaku.push({ name: "门清自摸", han: 1 });
  // 役牌：三元 / 自风 / 场风
  for (const d of ["z5", "z6", "z7"]) {
    if ((counts.get(d) || 0) >= 3) yaku.push({ name: d === "z5" ? "白" : d === "z6" ? "發" : "中", han: 1 });
  }
  const seatWindCode = hand.seatWind || "z1";
  const roundWindCode = hand.roundWind || "z1";
  const WIND_NAMES = { z1: "东", z2: "南", z3: "西", z4: "北" };
  // 连风（自风==场风）：场风与自风各 +1 番，叠加为 2 番
  if ((counts.get(seatWindCode) || 0) >= 3) {
    yaku.push({ name: `自风${WIND_NAMES[seatWindCode]}`, han: 1 });
  }
  if ((counts.get(roundWindCode) || 0) >= 3) {
    yaku.push({ name: `场风${WIND_NAMES[roundWindCode]}`, han: 1 });
  }

  // 平和：四顺子 + 非役牌雀头 + 两面听（必须门清）
  const pairFuOk = !isDragon(pairTile) && pairTile !== seatWindCode && pairTile !== roundWindCode;
  const ryanmenWait = hand.waitType === "ryanmen";
  if (closed && allSequences && pairFuOk && ryanmenWait) {
    yaku.push({ name: "平和", han: 1 });
  }

  // 断幺九：无幺九
  if (tiles.every((t) => !isYaochu(t))) yaku.push({ name: "断幺九", han: 1 });

  // 一杯口 / 二杯口（门清限定）
  if (closed) {
    const seqPairs = new Set();
    for (let i = 0; i < seqs.length; i++) {
      for (let j = i + 1; j < seqs.length; j++) {
        if (sameSequence(seqs[i], seqs[j])) seqPairs.add(seqs[i].tiles[0]);
      }
    }
    if (seqPairs.size >= 2) {
      yaku.push({ name: "二杯口", han: 3 });
    } else if (seqPairs.size === 1) {
      yaku.push({ name: "一杯口", han: 1 });
    }
  }

  // 三色同顺 / 三色同刻
  const seqByNum = new Map();
  for (const s of seqs) {
    const key = Number(s.tiles[0][1]);
    const set = seqByNum.get(key) || new Set();
    set.add(s.tiles[0][0]);
    seqByNum.set(key, set);
  }
  for (const [, suits] of seqByNum) {
    if (suits.size === 3) {
      yaku.push({ name: closed ? "三色同顺" : "三色同顺（副露）", han: closed ? 2 : 1 });
      break;
    }
  }
  const tripByNum = new Map();
  for (const t of triplets) {
    const key = Number(t.tiles[0][1]);
    const set = tripByNum.get(key) || new Set();
    set.add(t.tiles[0][0]);
    tripByNum.set(key, set);
  }
  for (const [, suits] of tripByNum) {
    if (suits.size === 3) {
      yaku.push({ name: "三色同刻", han: 2 });
      break;
    }
  }

  // 一气通贯：同花色 1-9 各一张（三组顺子）
  for (const suit of ["m", "p", "s"]) {
    const nums = new Set();
    for (const s of seqs) {
      if (s.tiles[0][0] === suit) s.tiles.forEach((t) => nums.add(Number(t[1])));
    }
    if ([1, 2, 3, 4, 5, 6, 7, 8, 9].every((n) => nums.has(n))) {
      yaku.push({ name: closed ? "一气通贯" : "一气通贯（副露）", han: closed ? 2 : 1 });
      break;
    }
  }

  // 对对和
  if (meldTypes.every((t) => t !== "sequence")) yaku.push({ name: "对对和", han: 2 });
  // 三暗刻
  if (darkMelds.length === 3) yaku.push({ name: "三暗刻", han: 2 });
  // 三杠子
  if (quads === 3) yaku.push({ name: "三杠子", han: 2 });
  // 小三元：两组三元刻 + 三元雀头
  const dragonMelds = triplets.filter((m) => isDragon(m.tiles[0]));
  if (dragonMelds.length === 2 && isDragon(pairTile)) {
    yaku.push({ name: "小三元", han: 2 });
  }
  // 混老头：全部幺九且含字（对对和/七对子通常伴随；这里指全幺九）
  if (honorCount > 0 && tiles.every(isYaochu)) yaku.push({ name: "混老头", han: 2 });

  // 带幺九
  const meldAllYaochu = melds.every((m) => m.type === "sequence" ? m.tiles.every(isYaochu) : isYaochu(m.tiles[0]));
  if (meldAllYaochu && isYaochu(pairTile)) {
    if (honorCount === 0) yaku.push({ name: closed ? "纯全带幺九" : "纯全带幺九（副露）", han: closed ? 3 : 2 });
    else yaku.push({ name: closed ? "混全带幺九" : "混全带幺九（副露）", han: closed ? 2 : 1 });
  }

  // 混一色 / 清一色
  if (suitsUsed.size === 1) {
    if (honorCount > 0) yaku.push({ name: closed ? "混一色" : "混一色（副露）", han: closed ? 3 : 2 });
    else yaku.push({ name: closed ? "清一色" : "清一色（副露）", han: closed ? 6 : 5 });
  }

  // 宝牌（表宝 + 里宝）
  if (dora > 0) yaku.push({ name: "宝牌", han: dora });

  const han = yaku.reduce((sum, y) => sum + y.han, 0);
  return { yaku, han, yakuman: false };
}

// === 点数表 ===
// 子家：[ron, (自摸 子, 自摸 亲)]；亲家：[ron, 自摸各家支付]
const KO_POINTS = {
  20: { 1: [null, null], 2: [700, [400, 700]], 3: [1300, [700, 1300]], 4: [2600, [1300, 2600]] },
  25: { 1: [1600, null], 2: [3200, null], 3: [6400, null], 4: [8000, [2000, 4000]] },
  30: { 1: [1000, [300, 500]], 2: [2000, [500, 1000]], 3: [3900, [1000, 2000]], 4: [7700, [2000, 3900]] },
  40: { 1: [1300, [400, 700]], 2: [2600, [700, 1300]], 3: [5200, [1300, 2600]], 4: [8000, [2000, 4000]] },
  50: { 1: [1600, [400, 800]], 2: [3200, [800, 1600]], 3: [6400, [1600, 3200]], 4: [8000, [2000, 4000]] },
  60: { 1: [2000, [500, 1000]], 2: [3900, [1000, 2000]], 3: [7700, [2000, 3900]], 4: [8000, [2000, 4000]] },
  70: { 1: [2300, [600, 1200]], 2: [4500, [1200, 2300]], 3: [8000, [2000, 4000]], 4: [8000, [2000, 4000]] },
  80: { 1: [2600, [700, 1300]], 2: [5200, [1300, 2600]], 3: [8000, [2000, 4000]], 4: [8000, [2000, 4000]] },
  90: { 1: [2900, [800, 1500]], 2: [5800, [1500, 2900]], 3: [8000, [2000, 4000]], 4: [8000, [2000, 4000]] },
  100: { 1: [3200, [800, 1600]], 2: [6400, [1600, 3200]], 3: [8000, [2000, 4000]], 4: [8000, [2000, 4000]] },
  110: { 1: [3600, [900, 1800]], 2: [7100, [1800, 3600]], 3: [8000, [2000, 4000]], 4: [8000, [2000, 4000]] },
};

// 亲家独立表：[ron, 自摸各家支付]
const OYA_POINTS = {
  20: { 1: [null, null], 2: [1300, 700], 3: [2600, 1300], 4: [5200, 2600] },
  25: { 1: [2400, null], 2: [4800, null], 3: [9600, null], 4: [12000, 4000] },
  30: { 1: [1500, 500], 2: [2900, 1000], 3: [5800, 2000], 4: [11600, 3900] },
  40: { 1: [2000, 700], 2: [3900, 1300], 3: [7700, 2600], 4: [12000, 4000] },
  50: { 1: [2400, 800], 2: [4800, 1600], 3: [9600, 3200], 4: [12000, 4000] },
  60: { 1: [2900, 1000], 2: [5800, 2000], 3: [11600, 3900], 4: [12000, 4000] },
  70: { 1: [3400, 1200], 2: [6800, 2300], 3: [12000, 4000], 4: [12000, 4000] },
  80: { 1: [3900, 1300], 2: [7700, 2600], 3: [12000, 4000], 4: [12000, 4000] },
  90: { 1: [4400, 1500], 2: [8700, 2900], 3: [12000, 4000], 4: [12000, 4000] },
  100: { 1: [4800, 1600], 2: [9600, 3200], 3: [12000, 4000], 4: [12000, 4000] },
  110: { 1: [5300, 1800], 2: [10600, 3600], 3: [12000, 4000], 4: [12000, 4000] },
};

const MANGAN = [
  { min: 5, name: "满贯", ko: 8000, oya: 12000 },
  { min: 6, name: "跳满", ko: 12000, oya: 18000 },
  { min: 8, name: "倍满", ko: 16000, oya: 24000 },
  { min: 11, name: "三倍满", ko: 24000, oya: 36000 },
  { min: 13, name: "役满", ko: 32000, oya: 48000 },
];

export function calculatePoints({ fu, han, winMethod, isDealer, sanma = false, honba = 0, yakumanCount = 1, yakuman = false }) {
  // 满贯以上档位
  let bracket = null;
  if (han >= 13) bracket = MANGAN[4];
  else if (han >= 11) bracket = MANGAN[3];
  else if (han >= 8) bracket = MANGAN[2];
  else if (han >= 6) bracket = MANGAN[1];
  else if (han >= 5) bracket = MANGAN[0];

  if (bracket) {
    // 多倍役满：役满点数 × 倍数；普通役合计 13 番+ = 累计役满（点数同役满）
    const isYakumanBracket = bracket.min >= 13;
    const mult = isYakumanBracket ? yakumanCount : 1;
    const ron = (isDealer ? bracket.oya : bracket.ko) * mult;
    let name = bracket.name;
    if (isYakumanBracket) {
      name = yakuman ? (mult > 1 ? `役满×${mult}` : "役满") : "累计役满";
    }
    return {
      bracket: name,
      ron,
      tsumo: distributeTsumo(ron, isDealer),
      yakuman: isYakumanBracket,
    };
  }

  const table = isDealer ? OYA_POINTS : KO_POINTS;
  let row = table[Math.min(fu, 110)]?.[Math.min(han, 4)];
  if (!row || row[0] === null) {
    // 20 符 1 番等无对应项：按 30 符处理
    row = table[30]?.[Math.min(han, 4)];
    if (!row || row[0] === null) return { ron: null, tsumo: null, error: `无对应点数（${fu}符${han}番）` };
  }
  const ron = row[0];
  // 自摸分配与四麻一致（三麻不再计算自摸损，按用户需求统一显示 子家/亲家）
  const tsumo = isDealer
    ? (typeof row[1] === "number" ? [row[1], row[1]] : distributeTsumo(ron, true))
    : (Array.isArray(row[1]) ? [row[1][0], row[1][1]] : distributeTsumo(ron, false));
  // 本场数（连庄数）：荣和 放铳者 +300×n；自摸 每家 +100×n
  const honbaBonus = honba > 0
    ? { ron: ron + 300 * honba, tsumo: tsumo.map((v) => v + 100 * honba) }
    : null;
  return { ron, tsumo, bracket: null, honbaBonus };
}

// 自摸分配（四麻标准）：子家 (子,子,亲)；亲家 (每家)
function distributeTsumo(ron, isDealer) {
  const ceil100 = (n) => Math.ceil(n / 100) * 100;
  if (isDealer) return [ceil100(ron / 3), ceil100(ron / 3)];
  return [ceil100(ron / 4), ceil100(ron / 4), ceil100(ron / 2)];
}

// 亲家判定：自风 == 场风
export function isDealerByWinds(seatWind, roundWind) {
  return seatWind === roundWind;
}

// 符镜 · 符数引擎（纯函数，浏览器与 Node 双端可用）
// 职责：和牌结构 → 符数
//   normalizeHand(input)   校验/规整手牌输入（牌码 m1..z7、面子类型、听牌形）
//   decomposePool(pool)    牌库（14-18 张）→ 全部"四面子+雀头"拆分方案
//   detectWaitType(groups) 由结构推导听牌形（两面/双碰/单骑/嵌张/边张）
//   groupFu / pairFu       面子/雀头加符；calculateFu 汇总（含七对子 25 符、
//                           国士 0 符役满、平和自摸 20 符、副露荣和最低 30 符）
// 约定：hand.handType = "regular" | "chiitoitsu" | "kokushi" | "pinfu"
//       group.open = true 表示副露（明刻/明杠）
export const GROUP_TYPES = {
  sequence: "顺子",
  triplet: "刻子",
  quad: "杠子",
};

export const WAIT_TYPES = {
  ryanmen: "两面听",
  shanpon: "双碰听",
  tanki: "单骑听",
  kanchan: "嵌张听",
  penchan: "边张听",
  special: "特殊听（国士等）",
};

const WAIT_FU = new Set(["tanki", "kanchan", "penchan"]);

export function groupFu(group) {
  if (!group || group.type === "sequence") return 0;

  const terminalMultiplier = group.terminalOrHonor ? 2 : 1;
  if (group.type === "triplet") {
    return (group.open ? 2 : 4) * terminalMultiplier;
  }
  if (group.type === "quad") {
    return (group.open ? 8 : 16) * terminalMultiplier;
  }
  return 0;
}

export function pairFuItems(pair = {}) {
  const items = [];
  if (pair.dragon) items.push({ label: "三元牌雀头", fu: 2 });
  if (pair.seatWind) items.push({ label: "自风雀头", fu: 2 });
  if (pair.roundWind) items.push({ label: "场风雀头", fu: 2 });
  return items;
}

export function pairFu(pair = {}) {
  return pairFuItems(pair).reduce((sum, item) => sum + item.fu, 0);
}

export function calculateFu(hand) {
  if (hand.handType === "kokushi") {
    return {
      raw: 0,
      total: 0,
      fixed: true,
      items: [{ label: "国士无双（役满）", fu: 0 }],
    };
  }

  if (hand.handType === "chiitoitsu") {
    return {
      raw: 25,
      total: 25,
      fixed: true,
      items: [{ label: "七对子固定符", fu: 25 }],
    };
  }

  if (hand.handType === "pinfu" && hand.winMethod === "tsumo") {
    return {
      raw: 20,
      total: 20,
      fixed: true,
      items: [{ label: "平和自摸固定符", fu: 20 }],
    };
  }

  // 普通型自动判定平和自摸：门清 + 四组顺子 + 两面听 + 非役牌雀头 + 自摸 → 固定 20 符
  const melds = (hand.groups || []).filter((group) => group.type !== "pair");
  const pinfuTsumo = hand.handType === "regular"
    && hand.winMethod === "tsumo"
    && hand.closed
    && hand.waitType === "ryanmen"
    && pairFu(hand.pair) === 0
    && melds.length === 4
    && melds.every((group) => group.type === "sequence");
  if (pinfuTsumo) {
    return {
      raw: 20,
      total: 20,
      fixed: true,
      items: [{ label: "平和自摸固定符", fu: 20 }],
    };
  }

  const items = [{ label: "副底", fu: 20 }];

  if (hand.winMethod === "ron" && hand.closed) {
    items.push({ label: "门清荣和", fu: 10 });
  } else if (hand.winMethod === "tsumo") {
    items.push({ label: "自摸", fu: 2 });
  }

  items.push(...pairFuItems(hand.pair));

  if (WAIT_FU.has(hand.waitType)) {
    items.push({ label: `${WAIT_TYPES[hand.waitType]}听牌`, fu: 2 });
  }

  for (const [index, group] of (hand.groups || []).entries()) {
    const fu = groupFu(group);
    if (!fu) continue;
    const state = group.open ? "明" : "暗";
    const kind = group.terminalOrHonor ? "幺九/字牌" : "中张牌";
    items.push({
      label: `${index + 1}组 · ${state}${GROUP_TYPES[group.type]} · ${kind}`,
      fu,
    });
  }

  for (const custom of hand.customFu || []) {
    const fu = Number(custom.fu);
    if (!Number.isFinite(fu) || fu === 0) continue;
    items.push({ label: custom.label?.trim() || "自定义附加符", fu });
  }

  const raw = items.reduce((sum, item) => sum + item.fu, 0);
  let total = Math.ceil(raw / 10) * 10;

  // A non-pinfu open hand with no other fu is scored as 30 fu.
  if (!hand.closed && hand.winMethod === "ron" && raw === 20) {
    total = 30;
  }

  return { raw, total, fixed: false, items };
}

export function isTerminalOrHonorTile(code) {
  return code[0] === "z" || code[1] === "1" || code[1] === "9";
}

/**
 * 把牌库（14–18 张牌，含雀头）自动拆分为四组面子 + 一组雀头。
 * 总数 = 14 + 杠子数，因此 15–18 张分别要求含 1–4 组杠子。
 * 返回 { solutions }：每种拆法是一组 { type, tiles } 结构数组（type ∈ pair/sequence/triplet/quad），
 * 顺子优先回溯；无法拆分时 solutions 为空数组。maxSolutions 用于限制回溯数量。
 */
export function decomposePool(pool = [], maxSolutions = 12) {
  const tiles = [...pool].sort();
  const total = tiles.length;
  if (total < 14 || total > 18) return { solutions: [] };

  const counts = new Map();
  for (const tile of tiles) counts.set(tile, (counts.get(tile) || 0) + 1);

  const numQuads = total - 14;
  const quadCandidates = [...counts].filter(([, count]) => count >= 4).map(([tile]) => tile);
  const targetMelds = 4 - numQuads; // 去掉杠子后剩余 12 - 3×杠子数 张牌，对应 4 - 杠子数 组面子

  // 把剩余牌拆成 targetMelds 组面子（顺子优先），收集全部拆法
  const collectMelds = (c, melds, out) => {
    if (melds.length === targetMelds) {
      if ([...c.values()].every((n) => n === 0)) out.push([...melds]);
      return out.length < maxSolutions;
    }
    const first = [...c].find(([, n]) => n > 0);
    if (!first) return true;
    const [tile, n] = first;
    const suit = tile[0];
    const rank = Number(tile[1]);

    if (suit !== "z" && rank <= 7) {
      const t2 = `${suit}${rank + 1}`;
      const t3 = `${suit}${rank + 2}`;
      if ((c.get(t2) || 0) > 0 && (c.get(t3) || 0) > 0) {
        c.set(tile, n - 1);
        c.set(t2, c.get(t2) - 1);
        c.set(t3, c.get(t3) - 1);
        melds.push({ type: "sequence", tiles: [tile, t2, t3] });
        if (!collectMelds(c, melds, out)) return false;
        melds.pop();
        c.set(tile, n);
        c.set(t2, c.get(t2) + 1);
        c.set(t3, c.get(t3) + 1);
      }
    }
    if (n >= 3) {
      c.set(tile, n - 3);
      melds.push({ type: "triplet", tiles: [tile, tile, tile] });
      if (!collectMelds(c, melds, out)) return false;
      melds.pop();
      c.set(tile, n);
    }
    return true;
  };

  const solutions = [];
  const pairCandidates = [...counts].filter(([, count]) => count >= 2).map(([tile]) => tile);

  for (const pairTile of pairCandidates) {
    if (solutions.length >= maxSolutions) break;
    const c0 = new Map(counts);
    c0.set(pairTile, c0.get(pairTile) - 2);

    const chooseQuads = (start, chosen) => {
      if (solutions.length >= maxSolutions) return;
      if (chosen.length === numQuads) {
        const c = new Map(c0);
        for (const tile of chosen) c.set(tile, c.get(tile) - 4);
        const meldSets = [];
        collectMelds(c, [], meldSets);
        for (const melds of meldSets) {
          const quadMelds = chosen.map((tile) => ({ type: "quad", tiles: [tile, tile, tile, tile] }));
          solutions.push([{ type: "pair", tiles: [pairTile, pairTile] }, ...quadMelds, ...melds]);
          if (solutions.length >= maxSolutions) return;
        }
        return;
      }
      for (let i = start; i < quadCandidates.length; i++) {
        chooseQuads(i + 1, [...chosen, quadCandidates[i]]);
      }
    };
    chooseQuads(0, []);
  }

  for (const solution of solutions) {
    solution.sort((a, b) => (a.tiles[0] < b.tiles[0] ? -1 : 1));
  }
  return { solutions };
}

/**
 * 根据当前拆分与和牌张识别听牌型：
 * - 和牌张构成雀头 → 单骑听（tanki）
 * - 和牌张构成刻子 → 双碰听（shanpon）
 * - 和牌张在顺子中间 → 嵌张听（kanchan）
 * - 和牌张补 [1,2] 或 [8,9] 边 → 边张听（penchan）
 * - 其余顺子两端 → 两面听（ryanmen）
 */
export function detectWaitType(solution = [], winTile) {
  if (!winTile) return null;
  for (const meld of solution) {
    if (meld.type === "pair" && meld.tiles[0] === winTile) return "tanki";
    if (meld.type === "triplet" && meld.tiles[0] === winTile) return "shanpon";
    if (meld.type === "sequence") {
      const idx = meld.tiles.indexOf(winTile);
      if (idx < 0) continue;
      const midRank = Number(meld.tiles[1][1]);
      if (idx === 1) return "kanchan";
      return (idx === 0 ? midRank === 8 : midRank === 2) ? "penchan" : "ryanmen";
    }
  }
  return null;
}

export function normalizeHand(input = {}) {
  const validGroups = new Set(Object.keys(GROUP_TYPES));
  const validWaits = new Set(Object.keys(WAIT_TYPES));
  const validHandTypes = new Set(["regular", "chiitoitsu", "pinfu", "kokushi"]);
  const validTiles = /^(?:[mps][1-9]|z[1-7])$/;

  return {
    handType: validHandTypes.has(input.handType) ? input.handType : "regular",
    winMethod: input.winMethod === "tsumo" ? "tsumo" : "ron",
    closed: input.closed !== false,
    waitType: validWaits.has(input.waitType) ? input.waitType : "ryanmen",
    pair: {
      tile: validTiles.test(input.pair?.tile || "") ? input.pair.tile : "z1",
      dragon: Boolean(input.pair?.dragon),
      seatWind: Boolean(input.pair?.seatWind),
      roundWind: Boolean(input.pair?.roundWind),
    },
    groups: Array.isArray(input.groups)
      ? input.groups.slice(0, 4).map((group) => ({
          type: validGroups.has(group?.type) ? group.type : "sequence",
          open: Boolean(group?.open),
          terminalOrHonor: Boolean(group?.terminalOrHonor),
          tiles: Array.isArray(group?.tiles)
            ? group.tiles.filter((tile) => validTiles.test(tile)).slice(0, 4)
            : [],
        }))
      : [],
    customFu: [],
    confidence: Math.min(1, Math.max(0, Number(input.confidence) || 0)),
    notes: typeof input.notes === "string" ? input.notes.slice(0, 240) : "",
  };
}

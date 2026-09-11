// 番数/点数引擎单元测试（含役满复合/累计役满/互斥约束用例）
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectYaku, calculatePoints, isDealerByWinds } from "../public/yaku.js";
import { decomposePool } from "../public/fu.js";

const hand = (over = {}) => ({
  handType: "regular",
  winMethod: "ron",
  closed: true,
  waitType: "ryanmen",
  seatWind: "z1",
  roundWind: "z1",
  pair: { tile: "z5" },
  groups: [],
  ...over,
});

function nineGates(suit, extra, win = extra) {
  const tiles = [..."1112345678999", String(extra)].map((n) => suit + n);
  const { solutions } = decomposePool(tiles);
  assert.ok(solutions.length, tiles.join(" "));
  return solutions.map((groups) => hand({ groups, winTile: win ? suit + win : null }));
}

for (const suit of ["m", "p", "s"]) {
  test(`纯正九莲宝灯 ${suit}: all nine winning tiles and all decompositions`, () => {
    for (let rank = 1; rank <= 9; rank++) {
      for (const h of nineGates(suit, rank)) {
        const y = detectYaku(h, { riichi: true, dora: 9 });
        assert.deepEqual(y.yaku.map((x) => x.name), ["纯正九莲宝灯"]);
        assert.equal(y.han, 26);
        assert.equal(y.yakumanCount, 2);
        assert.equal(calculatePoints({ ...y, fu: 40, isDealer: false }).ron, 64000);
        assert.equal(calculatePoints({ ...y, fu: 40, isDealer: true }).ron, 96000);
      }
    }
  });
  test(`九莲宝灯 ${suit}: a different winning tile is single yakuman`, () => {
    for (let rank = 1; rank <= 9; rank++) {
      for (const h of nineGates(suit, rank, rank === 1 ? 9 : 1)) {
        const y = detectYaku(h);
        assert.deepEqual(y.yaku.map((x) => x.name), ["九莲宝灯"]);
        assert.equal(y.yakumanCount, 1);
        assert.equal(calculatePoints({ ...y, fu: 40, isDealer: false }).ron, 32000);
      }
    }
  });
}

test("九莲宝灯: missing or invalid winning tile never grants double yakuman", () => {
  const h = nineGates("m", 5, null)[0];
  for (const winTile of [null, "", "p5", "m0", "1m"]) {
    assert.equal(detectYaku({ ...h, winTile }).yakumanCount, 1);
  }
  const pairGroup = h.groups.find((g) => g.type === "pair");
  assert.equal(detectYaku({ ...h, groups: h.groups.filter((g) => g.type !== "pair"),
    pair: { tile: pairGroup.tiles[0] } }).yakumanCount, 1);
});

test("九莲宝灯: reject exposed, quad, mixed, incomplete and invalid counts", () => {
  const base = nineGates("s", 5)[0];
  const variants = [];
  variants.push({ ...base, closed: false });
  const exposed = structuredClone(base);
  exposed.groups[0].open = true;
  variants.push(exposed);
  const quad = structuredClone(base);
  const triplet = quad.groups.find((g) => g.type === "triplet");
  triplet.type = "quad";
  triplet.tiles.push(triplet.tiles[0]);
  variants.push(quad);
  for (const replacement of ["z1", "m1", "s5", "s0", "s10"]) {
    const invalid = structuredClone(base);
    invalid.groups[0].tiles[0] = replacement;
    variants.push(invalid);
  }
  const short = structuredClone(base);
  short.groups[0].tiles.pop();
  variants.push(short);
  for (const h of variants) {
    assert.ok(!detectYaku(h).yaku.some((y) => y.name.includes("九莲宝灯")));
  }
});

test("国士无双：识别 + 役满点数", () => {
  const kokushi = hand({ handType: "kokushi", winMethod: "ron" });
  const y = detectYaku(kokushi);
  assert.equal(y.yakuman, true);
  assert.equal(y.han, 13);
  assert.equal(y.yaku[0].name, "国士无双");
  const p = calculatePoints({ fu: 30, han: 13, winMethod: "ron", isDealer: false, yakuman: true, yakumanCount: 1 });
  assert.equal(p.bracket, "役满");
  assert.equal(p.ron, 32000);
  const oya = calculatePoints({ fu: 30, han: 13, winMethod: "ron", isDealer: true, yakuman: true, yakumanCount: 1 });
  assert.equal(oya.ron, 48000);
});

test("七对子：25符2番 3200（荣和2番 / 自摸3番）", () => {
  const pairs = [
    ["m1", "m1"], ["p2", "p2"], ["s3", "s3"], ["m4", "m4"],
    ["p5", "p5"], ["s6", "s6"], ["z7", "z7"],
  ].map((tiles) => ({ type: "pair", tiles }));
  const y = detectYaku(hand({ handType: "chiitoitsu", groups: pairs, pair: { tile: "z7" } }));
  assert.equal(y.han, 2); // 七对子2（荣和无自摸）
  const y2 = detectYaku(hand({ handType: "chiitoitsu", winMethod: "tsumo", groups: pairs, pair: { tile: "z7" } }));
  assert.equal(y2.han, 3); // 七对子2 + 门清自摸1
  const p = calculatePoints({ fu: 25, han: 2, winMethod: "ron", isDealer: false });
  assert.equal(p.ron, 3200);
});

test("平和自摸：20符2番 子家 400/700", () => {
  const p = calculatePoints({ fu: 20, han: 2, winMethod: "tsumo", isDealer: false });
  assert.deepEqual(p.tsumo, [400, 700]);
  assert.equal(p.ron, 700);
});

test("30符2番：子家荣和 2000 / 自摸 500-1000", () => {
  const p = calculatePoints({ fu: 30, han: 2, winMethod: "ron", isDealer: false });
  assert.equal(p.ron, 2000);
  assert.deepEqual(p.tsumo, [500, 1000]);
  const oya = calculatePoints({ fu: 30, han: 2, winMethod: "ron", isDealer: true });
  assert.equal(oya.ron, 2900);
  assert.deepEqual(oya.tsumo, [1000, 1000]);
});

test("三麻自摸与四麻一致（无自摸损，按用户需求）", () => {
  // 子家 30符2番：四麻/三麻自摸均为 500/1000
  const ko4 = calculatePoints({ fu: 30, han: 2, winMethod: "tsumo", isDealer: false, sanma: false });
  const ko3 = calculatePoints({ fu: 30, han: 2, winMethod: "tsumo", isDealer: false, sanma: true });
  assert.deepEqual(ko4.tsumo, [500, 1000]);
  assert.deepEqual(ko3.tsumo, ko4.tsumo);
  // 亲家 30符2番：均为 1000/1000
  const oya4 = calculatePoints({ fu: 30, han: 2, winMethod: "tsumo", isDealer: true, sanma: false });
  const oya3 = calculatePoints({ fu: 30, han: 2, winMethod: "tsumo", isDealer: true, sanma: true });
  assert.deepEqual(oya4.tsumo, [1000, 1000]);
  assert.deepEqual(oya3.tsumo, oya4.tsumo);
});

test("满贯档位：5番满贯 / 6番跳满 / 8番倍满 / 11番三倍满 / 13番役满", () => {
  assert.equal(calculatePoints({ fu: 30, han: 5, isDealer: false }).ron, 8000);
  assert.equal(calculatePoints({ fu: 30, han: 5, isDealer: false }).bracket, "满贯");
  assert.equal(calculatePoints({ fu: 30, han: 6, isDealer: false }).ron, 12000);
  assert.equal(calculatePoints({ fu: 30, han: 8, isDealer: false }).ron, 16000);
  assert.equal(calculatePoints({ fu: 30, han: 11, isDealer: false }).ron, 24000);
  assert.equal(calculatePoints({ fu: 30, han: 13, isDealer: false }).ron, 32000);
  assert.equal(calculatePoints({ fu: 30, han: 5, isDealer: true }).ron, 12000);
});

test("普通役：混一色（门清3番）+ 宝牌 = 5番", () => {
  // 全索子 + 字牌雀头 z1；仅 1 组暗刻（s2），避免三暗刻干扰
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    waitType: "shanpon",
    groups: [
      { type: "triplet", open: false, tiles: ["s2", "s2", "s2"] },
      { type: "sequence", open: false, tiles: ["s4", "s5", "s6"] },
      { type: "sequence", open: false, tiles: ["s6", "s7", "s8"] },
      { type: "sequence", open: false, tiles: ["s5", "s6", "s7"] },
      { type: "pair", open: false, tiles: ["z1", "z1"] },
    ],
  });
  const y = detectYaku(h, { dora: 2 });
  const names = y.yaku.map((x) => x.name);
  assert.ok(names.includes("混一色"), names.join(","));
  assert.ok(names.includes("宝牌"));
  assert.ok(!names.includes("断幺九")); // 混一色与断幺九互斥
  assert.equal(y.han, 5);
});

test("大三元役满", () => {
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z5", "z5", "z5"] },
      { type: "triplet", open: false, tiles: ["z6", "z6", "z6"] },
      { type: "triplet", open: false, tiles: ["z7", "z7", "z7"] },
      { type: "sequence", open: false, tiles: ["m1", "m2", "m3"] },
      { type: "pair", open: false, tiles: ["m9", "m9"] },
    ],
  });
  const y = detectYaku(h);
  assert.equal(y.yakuman, true);
  assert.equal(y.yaku[0].name, "大三元");
});

test("一气通贯 + 平和 + 门清自摸 = 4番", () => {
  const h = hand({
    winMethod: "tsumo",
    groups: [
      { type: "sequence", open: false, tiles: ["m1", "m2", "m3"] },
      { type: "sequence", open: false, tiles: ["m4", "m5", "m6"] },
      { type: "sequence", open: false, tiles: ["m7", "m8", "m9"] },
      { type: "sequence", open: false, tiles: ["p2", "p3", "p4"] },
      { type: "pair", open: false, tiles: ["s5", "s5"] },
    ],
  });
  const y = detectYaku(h);
  const names = y.yaku.map((x) => x.name);
  assert.ok(names.includes("一气通贯"), names.join(","));
  assert.ok(names.includes("平和"));
  assert.ok(names.includes("门清自摸"));
  assert.equal(y.han, 4);
});

test("亲家判定：自风==场风", () => {
  assert.equal(isDealerByWinds("z1", "z1"), true);
  assert.equal(isDealerByWinds("z2", "z1"), false);
});

test("字一色七对子 = 役满（优先级高于普通七对子）", () => {
  const h = hand({ handType: "chiitoitsu", winMethod: "tsumo" });
  // 构造 7 种字牌对子（直接复用 detectYaku 的 tiles 逻辑需要 analyze 读 groups/pair）
  h.groups = [];
  h.pair = { tile: "z1" };
  h.groups = [
    { type: "pair", tiles: ["z1", "z1"] }, { type: "pair", tiles: ["z2", "z2"] },
    { type: "pair", tiles: ["z3", "z3"] }, { type: "pair", tiles: ["z4", "z4"] },
    { type: "pair", tiles: ["z5", "z5"] }, { type: "pair", tiles: ["z6", "z6"] },
    { type: "pair", tiles: ["z7", "z7"] },
  ];
  const y = detectYaku(h, { dora: 3 });
  assert.equal(y.yakuman, true);
  assert.equal(y.yaku[0].name, "字一色（七对子）");
  assert.equal(y.han, 13); // 宝牌不叠加在役满上
});

test("多役满复合：字一色 + 大三元 + 四暗刻 = 3 倍役满", () => {
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z1", "z1", "z1"] },
      { type: "triplet", open: false, tiles: ["z5", "z5", "z5"] },
      { type: "triplet", open: false, tiles: ["z6", "z6", "z6"] },
      { type: "triplet", open: false, tiles: ["z7", "z7", "z7"] },
      { type: "pair", open: false, tiles: ["z2", "z2"] },
    ],
  });
  const y = detectYaku(h);
  assert.equal(y.yakuman, true);
  assert.equal(y.yakumanCount, 3);
  assert.deepEqual(y.yaku.map((x) => x.name).sort(), ["字一色", "大三元", "四暗刻"].sort());
  const p = calculatePoints({ fu: 30, han: 39, isDealer: false, yakumanCount: 3, yakuman: true });
  assert.equal(p.ron, 96000);
  assert.equal(p.bracket, "役满×3");
  const oya = calculatePoints({ fu: 30, han: 39, isDealer: true, yakumanCount: 3, yakuman: true });
  assert.equal(oya.ron, 144000);
});

test("四暗刻单骑 = 2 倍役满（单骑听牌）", () => {
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    waitType: "tanki",
    groups: [
      { type: "triplet", open: false, tiles: ["m1", "m1", "m1"] },
      { type: "triplet", open: false, tiles: ["m9", "m9", "m9"] },
      { type: "triplet", open: false, tiles: ["p1", "p1", "p1"] },
      { type: "triplet", open: false, tiles: ["s9", "s9", "s9"] },
      { type: "pair", open: false, tiles: ["z7", "z7"] },
    ],
  });
  const y = detectYaku(h);
  assert.equal(y.yakumanCount, 2);
  assert.equal(y.yaku[0].name, "四暗刻单骑");
  const p = calculatePoints({ fu: 30, han: 26, isDealer: false, yakumanCount: 2 });
  assert.equal(p.ron, 64000);
});

test("四杠子役满（4 组暗杠 = 四杠子 + 四暗刻，双倍役满）", () => {
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "quad", open: false, tiles: ["m1", "m1", "m1", "m1"] },
      { type: "quad", open: false, tiles: ["m9", "m9", "m9", "m9"] },
      { type: "quad", open: false, tiles: ["p1", "p1", "p1", "p1"] },
      { type: "quad", open: false, tiles: ["s9", "s9", "s9", "s9"] },
      { type: "pair", open: false, tiles: ["z5", "z5"] },
    ],
  });
  const y = detectYaku(h);
  assert.equal(y.yakuman, true);
  assert.equal(y.yakumanCount, 2); // 四杠子 + 四暗刻 复合
  assert.ok(y.yaku.some((x) => x.name === "四杠子"));
  assert.ok(y.yaku.some((x) => x.name === "四暗刻"));
});

test("国士十三面 = 2 倍役满（和牌张决定）", () => {
  // 13 种幺九各 1 + 和牌张 m1（重复）→ 去掉 m1 后 13 种各 1 → 十三面
  const h = hand({ handType: "kokushi", winTile: "m1", winMethod: "ron" });
  h.groups = ["m1","m9","p1","p9","s1","s9","z1","z2","z3","z4","z5","z6","z7","m1"]
    .map((tile) => ({ type: "single", open: false, tiles: [tile] }));
  const y = detectYaku(h);
  assert.equal(y.yakumanCount, 2);
  assert.equal(y.yaku[0].name, "国士无双（十三面）");
  const p = calculatePoints({ fu: 30, han: 26, isDealer: false, yakumanCount: 2 });
  assert.equal(p.ron, 64000);
});

test("国士 13 张听牌：识别为役满（听牌）", () => {
  const h = hand({ handType: "kokushi", winMethod: "ron" });
  h.groups = ["m1","m9","p1","p9","s1","s9","z1","z2","z3","z4","z5","z6","z7"]
    .map((tile) => ({ type: "single", open: false, tiles: [tile] }));
  const y = detectYaku(h);
  assert.equal(y.yakuman, true);
  assert.equal(y.listening, true);
  assert.equal(y.yakumanCount, 2); // 13 种各 1 = 十三面听
});

test("累计役满：普通役合计 13 番+（无役满牌型）按役满点数", () => {
  // 构造：清一色6 + 一气通贯2 + 一杯口1 + 平和1 + 门清自摸1 + 立直1 + 宝牌2 = 14 番
  const h = hand({
    winMethod: "tsumo",
    groups: [
      { type: "sequence", open: false, tiles: ["m1", "m2", "m3"] },
      { type: "sequence", open: false, tiles: ["m1", "m2", "m3"] },
      { type: "sequence", open: false, tiles: ["m4", "m5", "m6"] },
      { type: "sequence", open: false, tiles: ["m7", "m8", "m9"] },
      { type: "pair", open: false, tiles: ["m9", "m9"] },
    ],
  });
  const y = detectYaku(h, { dora: 2, riichi: true });
  assert.equal(y.yakuman, false);
  assert.equal(y.han, 14); // 清一色6+一气2+一杯口1+平和1+自摸1+立直1+宝牌2
  const p = calculatePoints({ fu: 30, han: 14, isDealer: false, yakuman: false });
  assert.equal(p.ron, 32000);
  assert.equal(p.bracket, "累计役满");
  // 真役满仍是"役满"
  const yk = calculatePoints({ fu: 30, han: 13, isDealer: false, yakuman: true, yakumanCount: 1 });
  assert.equal(yk.bracket, "役满");
});

test("连风役牌叠加：自风=场风=东时 东刻子 +2 番", () => {
  // 东风局东家：z1 刻子 = 场风东 + 自风东 = 2 番（顺子数字错开，避免三色同顺干扰）
  const h = hand({
    seatWind: "z1", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z1", "z1", "z1"] },
      { type: "sequence", open: false, tiles: ["m2", "m3", "m4"] },
      { type: "sequence", open: false, tiles: ["p5", "p6", "p7"] },
      { type: "sequence", open: false, tiles: ["s2", "s3", "s4"] },
      { type: "pair", open: false, tiles: ["s9", "s9"] },
    ],
  });
  const y = detectYaku(h, { riichi: true });
  const names = y.yaku.map((x) => x.name);
  assert.ok(names.includes("自风东"), names.join(","));
  assert.ok(names.includes("场风东"), names.join(","));
  assert.equal(y.han, 3); // 场风东1 + 自风东1 + 立直1
  // 非连风：自风南 场风东 各 1 番
  const h2 = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z2", "z2", "z2"] },
      { type: "sequence", open: false, tiles: ["m2", "m3", "m4"] },
      { type: "sequence", open: false, tiles: ["p5", "p6", "p7"] },
      { type: "sequence", open: false, tiles: ["s2", "s3", "s4"] },
      { type: "pair", open: false, tiles: ["s9", "s9"] },
    ],
  });
  const y2 = detectYaku(h2);
  assert.equal(y2.han, 1); // 仅自风南
});

test("抢杠/海底/岭上开花各 +1 番（分别验证，互斥不可同时）", () => {
  const base = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z2", "z2", "z2"] },
      { type: "sequence", open: false, tiles: ["m2", "m3", "m4"] },
      { type: "sequence", open: false, tiles: ["p5", "p6", "p7"] },
      { type: "sequence", open: false, tiles: ["s2", "s3", "s4"] },
      { type: "pair", open: false, tiles: ["s9", "s9"] },
    ],
  });
  const y1 = detectYaku(base, { chankan: true });
  assert.ok(y1.yaku.some((x) => x.name === "抢杠"));
  assert.equal(y1.han, 2); // 自风南1 + 抢杠1
  const y2 = detectYaku(base, { haitei: true });
  assert.ok(y2.yaku.some((x) => x.name === "海底/河底"));
  assert.equal(y2.han, 2);
  const y3 = detectYaku(base, { rinshan: true });
  assert.ok(y3.yaku.some((x) => x.name === "岭上开花"));
  assert.equal(y3.han, 2);
  // 七对子也可叠加（互斥组内单独成立）
  const pairs = [["m1","m1"],["p2","p2"],["s3","s3"],["m4","m4"],["p5","p5"],["s6","s6"],["z7","z7"]]
    .map((tiles) => ({ type: "pair", tiles }));
  const y4 = detectYaku(hand({ handType: "chiitoitsu", groups: pairs, pair: { tile: "z7" } }), { haitei: true });
  assert.equal(y4.han, 3); // 七对子2 + 海底1
});

test("特殊和牌役互斥：抢杠/海底/岭上开花不可同时（计算层防御）", () => {
  const base = hand({
    seatWind: "z2", roundWind: "z1",
    groups: [
      { type: "triplet", open: false, tiles: ["z2", "z2", "z2"] },
      { type: "sequence", open: false, tiles: ["m2", "m3", "m4"] },
      { type: "sequence", open: false, tiles: ["p5", "p6", "p7"] },
      { type: "sequence", open: false, tiles: ["s2", "s3", "s4"] },
      { type: "pair", open: false, tiles: ["s9", "s9"] },
    ],
  });
  // 同时传三个：只保留优先级最高的抢杠
  const y = detectYaku(base, { chankan: true, haitei: true, rinshan: true });
  const names = y.yaku.map((x) => x.name);
  assert.ok(names.includes("抢杠"));
  assert.ok(!names.includes("海底/河底"));
  assert.ok(!names.includes("岭上开花"));
  assert.equal(y.han, 2); // 自风南1 + 抢杠1
  // 海底+岭上：只保留海底
  const y2 = detectYaku(base, { haitei: true, rinshan: true });
  const names2 = y2.yaku.map((x) => x.name);
  assert.ok(names2.includes("海底/河底"));
  assert.ok(!names2.includes("岭上开花"));
  assert.equal(y2.han, 2);
});

test("立直必须门清：副露时立直失效（计算层防御）", () => {
  const base = hand({
    seatWind: "z2", roundWind: "z1",
    closed: false, // 副露
    groups: [
      { type: "triplet", open: true, tiles: ["z2", "z2", "z2"] },
      { type: "sequence", open: false, tiles: ["m2", "m3", "m4"] },
      { type: "sequence", open: false, tiles: ["p5", "p6", "p7"] },
      { type: "sequence", open: false, tiles: ["s2", "s3", "s4"] },
      { type: "pair", open: false, tiles: ["s9", "s9"] },
    ],
  });
  const y = detectYaku(base, { riichi: true });
  const names = y.yaku.map((x) => x.name);
  assert.ok(!names.includes("立直"));
  assert.equal(y.han, 1); // 仅自风南（副露无自摸/立直）
  // 门清时立直正常
  const y2 = detectYaku(hand({ ...base, closed: true }), { riichi: true });
  assert.ok(y2.yaku.some((x) => x.name === "立直"));
});

test("满贯以上本场加点覆盖亲子家、荣和自摸、多倍及累计役满", () => {
  const cases = [
    { han: 5, ko: 8000, oya: 12000 },
    { han: 6, ko: 12000, oya: 18000 },
    { han: 8, ko: 16000, oya: 24000 },
    { han: 11, ko: 24000, oya: 36000 },
    { han: 13, ko: 32000, oya: 48000 },
    { han: 13, yakuman: true, ko: 32000, oya: 48000 },
    { han: 26, yakuman: true, yakumanCount: 2, ko: 64000, oya: 96000 },
    { han: 39, yakuman: true, yakumanCount: 3, ko: 96000, oya: 144000 },
  ];
  for (const c of cases) for (const isDealer of [false, true]) {
    for (const winMethod of ["ron", "tsumo"]) for (const honba of [0, 1, 3, 99]) {
      const points = calculatePoints({ ...c, fu: 30, isDealer, winMethod, honba });
      const ron = isDealer ? c.oya : c.ko;
      const tsumo = isDealer ? [ron / 3, ron / 3] : [ron / 4, ron / 4, ron / 2];
      assert.equal(points.ron, ron);
      assert.deepEqual(points.tsumo, tsumo);
      assert.deepEqual(points.honbaBonus, honba === 0 ? null : {
        ron: ron + 300 * honba, tsumo: tsumo.map((v) => v + 100 * honba),
      }, JSON.stringify({ ...c, isDealer, winMethod, honba }));
    }
  }
});

test("副露减番：混一色副露 2番", () => {
  const h = hand({
    seatWind: "z2", roundWind: "z1",
    closed: false,
    groups: [
      { type: "triplet", open: true, tiles: ["s2", "s2", "s2"] },
      { type: "sequence", open: true, tiles: ["s4", "s5", "s6"] },
      { type: "triplet", open: false, tiles: ["s7", "s7", "s7"] },
      { type: "sequence", open: true, tiles: ["s6", "s7", "s8"] },
      { type: "pair", open: false, tiles: ["z1", "z1"] },
    ],
  });
  const y = detectYaku(h);
  const names = y.yaku.map((x) => x.name);
  assert.ok(names.includes("混一色（副露）"), names.join(","));
  assert.equal(y.han, 2);
});

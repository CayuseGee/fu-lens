// 符数引擎单元测试（node --test 收集；npm test 的一部分）
import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateFu, groupFu, normalizeHand, decomposePool, detectWaitType, isTerminalOrHonorTile,
} from "../public/fu.js";

const base = {
  handType: "regular",
  winMethod: "ron",
  closed: true,
  waitType: "ryanmen",
  pair: {},
  groups: [],
  customFu: [],
};

test("menzen ron is 30 fu", () => {
  const result = calculateFu(base);
  assert.equal(result.raw, 30);
  assert.equal(result.total, 30);
});

test("chiitoitsu is fixed at 25 fu", () => {
  const result = calculateFu({ ...base, handType: "chiitoitsu" });
  assert.deepEqual({ raw: result.raw, total: result.total }, { raw: 25, total: 25 });
});

test("pinfu tsumo is fixed at 20 fu", () => {
  const result = calculateFu({ ...base, handType: "pinfu", winMethod: "tsumo" });
  assert.equal(result.total, 20);
});

test("open pinfu-shaped ron hand has a 30 fu floor", () => {
  const result = calculateFu({ ...base, closed: false });
  assert.deepEqual({ raw: result.raw, total: result.total }, { raw: 20, total: 30 });
});

test("meld values follow open, closed, simple and terminal multipliers", () => {
  assert.equal(groupFu({ type: "triplet", open: true, terminalOrHonor: false }), 2);
  assert.equal(groupFu({ type: "triplet", open: false, terminalOrHonor: true }), 8);
  assert.equal(groupFu({ type: "quad", open: true, terminalOrHonor: true }), 16);
  assert.equal(groupFu({ type: "quad", open: false, terminalOrHonor: true }), 32);
});

test("wait, double-wind pair, group and custom fu are rounded up", () => {
  const result = calculateFu({
    ...base,
    waitType: "tanki",
    pair: { seatWind: true, roundWind: true },
    groups: [{ type: "triplet", open: false, terminalOrHonor: true }],
    customFu: [{ label: "本地规则", fu: 3 }],
  });
  assert.equal(result.raw, 47);
  assert.equal(result.total, 50);
});

test("recognition payload is normalized", () => {
  const hand = normalizeHand({
    winMethod: "bad",
    confidence: 4,
    groups: [{ type: "bad", tiles: ["m1", "invalid"] }],
  });
  assert.equal(hand.winMethod, "ron");
  assert.equal(hand.confidence, 1);
  assert.deepEqual(hand.groups[0].tiles, ["m1"]);
});

test("14-tile pool decomposes into 4 melds + pair, sequence-first", () => {
  const { solutions } = decomposePool([
    "m1", "m1", "m1", "m2", "m2", "m2", "m3", "m3", "m3", "m4", "m5", "m6", "z1", "z1",
  ]);
  assert.equal(solutions.length, 2); // 雀头z1 + 123×3+456 或 111+222+333+456
  assert.equal(solutions[0].length, 5);
  assert.equal(solutions[0].filter((g) => g.type === "pair").length, 1);
  assert.ok(solutions[0].every((g) => g.type === "pair" || g.type === "sequence"));
});

test("15-tile pool requires one quad", () => {
  const { solutions } = decomposePool([
    "m1", "m1", "m1", "m1", "m2", "m2", "m2", "m3", "m3", "m3", "s4", "s5", "s6", "z1", "z1",
  ]);
  assert.equal(solutions.length, 1);
  assert.deepEqual(solutions[0].map((g) => g.type).sort(), ["pair", "quad", "sequence", "triplet", "triplet"]);
});

test("pair can be any tile with count 2, including inside a sequence", () => {
  // 111 222 333 444 55：雀头可为 m5（123×3+444），也可为 m2（111+234+345+345）
  const { solutions } = decomposePool([
    "m1", "m1", "m1", "m2", "m2", "m2", "m3", "m3", "m3", "m4", "m4", "m4", "m5", "m5",
  ]);
  assert.ok(solutions.length >= 2);
  const pairs = new Set(solutions.map((solution) => solution.find((g) => g.type === "pair").tiles[0]));
  assert.ok(pairs.has("m5"));
  assert.ok(pairs.size >= 2);
});

test("invalid pools have no decomposition", () => {
  // 13 张（不足 14）
  assert.equal(decomposePool(["m1", "m1", "m1", "m2", "m2", "m2", "m3", "m3", "m3", "m4", "m5", "m6", "z1"]).solutions.length, 0);
  // 14 张但杂字牌无法成组
  assert.equal(decomposePool(["m1", "m2", "m3", "p1", "p2", "p3", "s1", "s2", "s3", "z1", "z2", "z3", "z1", "z1"]).solutions.length, 0);
  // 15 张但不含杠子
  assert.equal(decomposePool(["m1", "m1", "m1", "m2", "m2", "m2", "m3", "m3", "m3", "m4", "m4", "m4", "s1", "z1", "z1"]).solutions.length, 0);
  // 超过 18 张
  assert.equal(decomposePool(Array(19).fill("m1")).solutions.length, 0);
});

test("wait type is detected from winning tile", () => {
  const solution = [
    { type: "sequence", tiles: ["m2", "m3", "m4"] },
    { type: "sequence", tiles: ["p3", "p4", "p5"] },
    { type: "sequence", tiles: ["s6", "s7", "s8"] },
    { type: "triplet", tiles: ["p6", "p6", "p6"] },
    { type: "pair", tiles: ["z1", "z1"] },
  ];
  assert.equal(detectWaitType(solution, "p6"), "shanpon");
  assert.equal(detectWaitType(solution, "z1"), "tanki");
  assert.equal(detectWaitType(solution, "m3"), "kanchan");
  assert.equal(detectWaitType(solution, "m4"), "ryanmen");
  assert.equal(detectWaitType(solution, "p9"), null);
  assert.equal(detectWaitType(solution, null), null);
});

test("edge waits are penchan, others ryanmen", () => {
  assert.equal(detectWaitType([{ type: "sequence", tiles: ["m1", "m2", "m3"] }], "m3"), "penchan");
  assert.equal(detectWaitType([{ type: "sequence", tiles: ["s7", "s8", "s9"] }], "s7"), "penchan");
  assert.equal(detectWaitType([{ type: "sequence", tiles: ["p2", "p3", "p4"] }], "p2"), "ryanmen");
  assert.equal(detectWaitType([{ type: "sequence", tiles: ["p7", "p8", "p9"] }], "p9"), "ryanmen");
});

test("regular pinfu-shaped tsumo is fixed at 20 fu", () => {
  const groups = [
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["m2", "m3", "m4"] },
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["m5", "m6", "m7"] },
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["p2", "p3", "p4"] },
    { type: "sequence", open: false, terminalOrHonor: false, tiles: ["s6", "s7", "s8"] },
  ];
  const result = calculateFu({
    ...base, winMethod: "tsumo", waitType: "ryanmen", pair: { tile: "m8", dragon: false, seatWind: false, roundWind: false }, groups,
  });
  assert.deepEqual({ raw: result.raw, total: result.total, fixed: result.fixed }, { raw: 20, total: 20, fixed: true });
});

test("non-pinfu tsumo (tanki wait) is not fixed", () => {
  const result = calculateFu({
    ...base, winMethod: "tsumo", waitType: "tanki", pair: { tile: "m8", dragon: false, seatWind: false, roundWind: false },
    groups: [{ type: "sequence", open: false, terminalOrHonor: false, tiles: ["m2", "m3", "m4"] }],
  });
  assert.equal(result.raw, 24); // 20 + 自摸2 + 单骑2
  assert.equal(result.total, 30);
  assert.equal(result.fixed, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectYaku, calculatePoints } from "../public/yaku.js";

const makeHand = (codes, pair, { quads = 0, open = 0, method = "ron", win = pair, closed = open === 0 } = {}) => ({
  handType: "regular", closed, winMethod: method, winTile: win, waitType: "shanpon",
  groups: [...codes.map((t, i) => ({
    type: quads & (1 << i) ? "quad" : "triplet", open: Boolean(open & (1 << i)),
    tiles: Array(quads & (1 << i) ? 4 : 3).fill(t),
  })), { type: "pair", tiles: [pair, pair] }],
});
const names = result => result.yaku.map(y => y.name).sort();

for (const [label, codes, pair, base] of [
  ["字一色大四喜", ["z1", "z2", "z3", "z4"], "z5", { "字一色": 1, "大四喜": 2 }],
  ["字一色小四喜", ["z1", "z2", "z3", "z5"], "z4", { "字一色": 1, "小四喜": 1 }],
  ["字一色大三元", ["z1", "z5", "z6", "z7"], "z2", { "字一色": 1, "大三元": 1 }],
  ["清老头", ["m1", "m9", "p1", "p9"], "s1", { "清老头": 1 }],
  ["绿一色", ["s2", "s4", "s6", "s8"], "z6", { "绿一色": 1 }],
  ["非字一色大四喜", ["z1", "z2", "z3", "z4"], "m5", { "大四喜": 2 }],
  ["非字一色小四喜", ["z1", "z2", "z3", "m5"], "z4", { "小四喜": 1 }],
]) {
  test(`${label}: 明暗刻杠、和牌张、荣和自摸的复合矩阵`, () => {
    for (let quads = 0; quads < 16; quads++) for (let open = 0; open < 16; open++) {
      const firstTriplet = codes.find((_, i) => !(quads & (1 << i)));
      for (const win of [pair, ...(firstTriplet ? [firstTriplet] : [])]) for (const method of ["ron", "tsumo"]) {
        const h = makeHand(codes, pair, { quads, open, win, method });
        const expected = { ...base };
        if (quads === 15) expected["四杠子"] = 1;
        if (!open && (method === "tsumo" || win === pair)) expected[win === pair ? "四暗刻单骑" : "四暗刻"] = win === pair ? 2 : 1;
        const result = detectYaku(h, { dora: 10, riichi: true, ippatsu: true, haitei: true });
        const context = JSON.stringify({ label, quads, open, win, method });
        assert.deepEqual(names(result), Object.keys(expected).sort(), context);
        for (const y of result.yaku) assert.equal(y.mult, expected[y.name], context);
        const total = Object.values(expected).reduce((s, n) => s + n, 0);
        assert.equal(result.yakumanCount, total, context);
        assert.equal(result.han, total * 13, context);
        for (const isDealer of [false, true]) {
          const p = calculatePoints({ ...result, fu: 40, isDealer, winMethod: method, honba: 2 });
          const ron = total * (isDealer ? 48000 : 32000);
          assert.equal(p.honbaBonus.ron, ron + 600);
          assert.deepEqual(p.honbaBonus.tsumo, isDealer ? [ron / 3 + 200, ron / 3 + 200] : [ron / 4 + 200, ron / 4 + 200, ron / 2 + 200]);
        }
      }
    }
  });
}

test("小四喜要求三组不同风刻杠和第四种风雀头；顺子可副露", () => {
  for (const pair of ["z1", "z2", "z3", "z4"]) {
    const winds = ["z1", "z2", "z3", "z4"].filter(t => t !== pair);
    const h = makeHand([...winds, "m2"], pair, { open: 15 });
    h.groups[3] = { type: "sequence", open: true, tiles: ["m2", "m3", "m4"] };
    assert.deepEqual(names(detectYaku(h)), ["小四喜"]);
    h.groups[4].tiles = ["z5", "z5"];
    assert.ok(!detectYaku(h).yaku.some(y => y.name.includes("四喜")));
  }
});

test("四暗刻不得在双碰荣和、副露或仅手动单骑标签时误复合", () => {
  const h = makeHand(["z1", "z5", "z6", "z7"], "z2");
  for (const win of ["z1", "m1", null]) {
    const result = detectYaku({ ...h, winTile: win, waitType: "tanki" });
    assert.deepEqual(names(result), ["大三元", "字一色"].sort());
  }
  for (const closed of [true, false]) {
    const result = detectYaku({ ...h, closed });
    assert.equal(result.yakumanCount, closed ? 4 : 2);
  }
  h.groups[0].open = true;
  assert.deepEqual(names(detectYaku(h)), ["大三元", "字一色"].sort());
});

test("不完整/非法牌形不能冒充字一色、四喜、七对子或国士役满", () => {
  const good = makeHand(["z1", "z2", "z3", "z4"], "z5", { open: 15 });
  const variants = [];
  const missing = structuredClone(good); missing.groups.pop(); variants.push(missing);
  const short = structuredClone(good); short.groups[0].tiles.pop(); variants.push(short);
  const duplicate = structuredClone(good); duplicate.groups[3] = structuredClone(duplicate.groups[0]); variants.push(duplicate);
  variants.push({ handType: "chiitoitsu", groups: [] });
  variants.push({ handType: "kokushi", groups: [] });
  variants.push({ handType: "kokushi", groups: [{ type: "single", tiles: Array(14).fill("z1") }] });
  for (const h of variants) assert.equal(detectYaku(h).yakuman, false);
});

test("字牌七对子不能复合四喜、大三元或四暗刻", () => {
  const groups = ["z1", "z2", "z3", "z4", "z5", "z6", "z7"].map(t => ({ type: "pair", tiles: [t, t] }));
  assert.deepEqual(names(detectYaku({ handType: "chiitoitsu", groups })), ["字一色（七对子）"]);
});

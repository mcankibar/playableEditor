import test from "node:test";
import assert from "node:assert/strict";
import {
  columnCount,
  findMatches,
  findSquares,
  parseBoard,
  randomFill,
  resizeGrid,
  serializeBoard,
  setCell
} from "../web/src/components/boardLogic.js";

const EDITOR = { rows: "|", cells: ",", levels: "&" };
const MATCH = new Set(["1", "2", "3", "4", "5"]);
const isMatch = (t) => MATCH.has(t);

// Small deterministic PRNG so failures are reproducible.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test("parse / serialize round-trips, unknown tokens and ragged rows included", () => {
  const value = "5,3,1|O1,S5-3,2&1,1|2";
  const levels = parseBoard(value, EDITOR);
  assert.deepEqual(levels, [
    [
      ["5", "3", "1"],
      ["O1", "S5-3", "2"]
    ],
    [["1", "1"], ["2"]]
  ]);
  assert.equal(serializeBoard(levels, EDITOR), value);
  assert.equal(columnCount(levels[1]), 2);
  // Default separators.
  assert.equal(serializeBoard(parseBoard(value, {}), {}), value);
  assert.deepEqual(parseBoard("", EDITOR), [[[""]]]);
});

test("findMatches finds horizontal and vertical runs of match tokens only", () => {
  const grid = [
    ["1", "1", "1", "2"],
    ["2", "O1", "3", "2"],
    ["3", "O1", "4", "2"],
    ["4", "O1", "5", "1"]
  ];
  const { cells, count } = findMatches(grid, isMatch);
  assert.equal(count, 2); // row 0 of "1", column 3 of "2"; the O1 column is not a match token
  assert.deepEqual([...cells].sort(), ["0,0", "0,1", "0,2", "0,3", "1,3", "2,3"].sort());
  assert.equal(findMatches([["1", "1"], ["1"]], isMatch).count, 0);
  assert.equal(findMatches([], isMatch).count, 0);
});

test("randomFill leaves no starting matches or 2x2 squares and keeps other cells", () => {
  const grid = resizeGrid(
    [
      ["O1", "1"],
      ["1", "S5-3"]
    ],
    9,
    8,
    "1"
  );
  for (let seed = 1; seed < 40; seed++) {
    const out = randomFill(grid, isMatch, ["1", "2", "3"], rng(seed));
    assert.equal(findMatches(out, isMatch).count, 0);
    assert.equal(findSquares(out, isMatch), 0);
    assert.equal(out[0][0], "O1");
    assert.equal(out[1][1], "S5-3");
    for (const row of out) for (const t of row) assert.ok(t === "O1" || t === "S5-3" || ["1", "2", "3"].includes(t));
  }
  // Input untouched.
  assert.equal(grid[2][2], "1");
});

test("resizeGrid and setCell", () => {
  const grid = [
    ["1", "2", "3"],
    ["4", "5"]
  ];
  assert.deepEqual(resizeGrid(grid, 3, 2, "9"), [
    ["1", "2"],
    ["4", "5"],
    ["9", "9"]
  ]);
  assert.equal(setCell(grid, 0, 0, "1"), grid);
  assert.deepEqual(setCell(grid, 1, 2, "7"), [
    ["1", "2", "3"],
    ["4", "5", "7"]
  ]);
  assert.equal(setCell(grid, 5, 0, "7"), grid);
});

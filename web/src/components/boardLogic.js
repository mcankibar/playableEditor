// Pure helpers for the board (level layout) editor: no React, no DOM, so they run under node:test.

/** Separators of a board field, with the defaults the games use. */
export function separators(editor = {}) {
  return { levels: editor.levels ?? "&", rows: editor.rows ?? "|", cells: editor.cells ?? "," };
}

/** "a,b|c,d&…" → levels[] of rows[] of cells[] (tokens are kept verbatim, unknown ones included). */
export function parseBoard(value, editor) {
  const sep = separators(editor);
  const text = typeof value === "string" ? value : "";
  return text.split(sep.levels).map((level) => level.split(sep.rows).map((row) => row.split(sep.cells)));
}

export function serializeBoard(levels, editor) {
  const sep = separators(editor);
  return levels.map((level) => level.map((row) => row.join(sep.cells)).join(sep.rows)).join(sep.levels);
}

/** Widest row: ragged rows are shown padded but kept as they are until edited. */
export const columnCount = (grid) => grid.reduce((n, row) => Math.max(n, row.length), 0);

export const cloneGrid = (grid) => grid.map((row) => [...row]);

/** Adds / removes cells at the right and bottom; new cells get `fill`. */
export function resizeGrid(grid, rows, cols, fill) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const src = grid[r] ?? [];
    const row = src.slice(0, cols);
    while (row.length < cols) row.push(fill);
    out.push(row);
  }
  return out;
}

/** Sets one cell (padding a short row with `pad`); returns the same grid when nothing changes. */
export function setCell(grid, r, c, token, pad = "") {
  if (!grid[r] || grid[r][c] === token) return grid;
  const next = [...grid];
  const row = [...next[r]];
  while (row.length < c) row.push(pad);
  row[c] = token;
  next[r] = row;
  return next;
}

/**
 * Runs of 3+ identical match tokens, horizontally or vertically.
 * → { cells: Set of "r,c", count: number of runs }
 */
export function findMatches(grid, isMatch) {
  const cells = new Set();
  let count = 0;
  const at = (r, c) => grid[r]?.[c];
  const scan = (lines) => {
    for (const line of lines) {
      if (!line.length) continue;
      let start = 0;
      for (let i = 1; i <= line.length; i++) {
        const [r0, c0] = line[start];
        const t = at(r0, c0);
        if (i < line.length && at(...line[i]) === t) continue;
        if (i - start >= 3 && t !== undefined && isMatch(t)) {
          count++;
          for (let k = start; k < i; k++) cells.add(line[k].join(","));
        }
        start = i;
      }
    }
  };
  const rows = grid.length;
  const cols = columnCount(grid);
  scan(Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => [r, c])));
  scan(Array.from({ length: cols }, (_, c) => Array.from({ length: rows }, (_, r) => [r, c])));
  return { cells, count };
}

/** Would `token` at (r, c) complete a 3-in-a-row to the left / above, or a 2×2 square to the up-left? */
function conflicts(grid, r, c, token) {
  const at = (rr, cc) => grid[rr]?.[cc];
  if (at(r, c - 1) === token && at(r, c - 2) === token) return true;
  if (at(r - 1, c) === token && at(r - 2, c) === token) return true;
  return at(r, c - 1) === token && at(r - 1, c) === token && at(r - 1, c - 1) === token;
}

/**
 * Re-fills every cell holding a match token with a random one of `tokens`, avoiding starting 3-in-a-rows and
 * 2×2 squares; other cells (obstacles, boosters, unknown tokens) stay. Filled in reading order, so checking
 * left / up is enough. With too few tokens to avoid every pattern, the cell takes any token.
 */
export function randomFill(grid, isMatch, tokens, random = Math.random) {
  if (!tokens.length) return cloneGrid(grid);
  const out = cloneGrid(grid);
  const pick = (list) => list[Math.floor(random() * list.length) % list.length];
  for (let r = 0; r < out.length; r++) {
    for (let c = 0; c < out[r].length; c++) {
      if (!isMatch(out[r][c])) continue;
      const ok = tokens.filter((t) => !conflicts(out, r, c, t));
      out[r][c] = pick(ok.length ? ok : tokens);
    }
  }
  return out;
}

/** 2×2 squares of the same match token (only used by tests / diagnostics). */
export function findSquares(grid, isMatch) {
  let count = 0;
  for (let r = 1; r < grid.length; r++)
    for (let c = 1; c < (grid[r]?.length ?? 0); c++) {
      const t = grid[r][c];
      if (isMatch(t) && grid[r][c - 1] === t && grid[r - 1]?.[c] === t && grid[r - 1]?.[c - 1] === t) count++;
    }
  return count;
}

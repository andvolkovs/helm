/**
 * Grid row tracks a panel `height` px tall takes, plus the gap below it, over tracks of `row` px.
 * At least one, so a panel not laid out yet still gets a place.
 */
export function rowSpan(height: number, gap: number, row: number): number {
  return Math.max(1, Math.ceil((Math.max(0, height) + gap) / row));
}

/** How many columns fit: as many as hold `minColumn` each plus the gaps (all in px), at least one. */
export function columnCount(width: number, minColumn: number, gap: number): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (minColumn + gap)));
}

/**
 * Deal panels into columns in reading order, each into the currently shortest column (the
 * leftmost one on a tie). Returns, per item, its column. Unknown heights count as equal, which
 * makes it plain round-robin.
 */
export function assignColumns(heights: readonly number[], count: number, gap = 0): number[] {
  const n = Math.max(1, count);
  const filled = new Array<number>(n).fill(0);
  return heights.map((h) => {
    let best = 0;
    for (let c = 1; c < n; c++) if (filled[c]! < filled[best]!) best = c;
    filled[best]! += (h > 0 ? h : 1) + gap;
    return best;
  });
}

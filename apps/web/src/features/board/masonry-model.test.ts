import { describe, expect, it } from 'vitest';
import { assignColumns, columnCount, rowSpan } from './masonry-model.ts';

describe('rowSpan', () => {
  it('covers the height and the gap below, rounding up, never less than one track', () => {
    expect(rowSpan(100, 20, 4)).toBe(30);
    expect(rowSpan(101, 20, 4)).toBe(31);
    expect(rowSpan(0, 0, 4)).toBe(1);
    expect(rowSpan(-5, 0, 4)).toBe(1);
  });
});

describe('columnCount', () => {
  it('fits columns plus gaps, never fewer than one', () => {
    expect(columnCount(0, 336, 20)).toBe(1);
    expect(columnCount(300, 336, 20)).toBe(1);
    expect(columnCount(692, 336, 20)).toBe(2);
    expect(columnCount(691, 336, 20)).toBe(1);
    expect(columnCount(1403, 336, 20)).toBe(3);
    expect(columnCount(1404, 336, 20)).toBe(4);
  });
});

describe('assignColumns', () => {
  it('is round-robin when heights are unknown', () => {
    expect(assignColumns([0, 0, 0, 0, 0], 3)).toEqual([0, 1, 2, 0, 1]);
  });
  it('puts the next panel under the shortest column', () => {
    expect(assignColumns([500, 100, 100, 100], 2)).toEqual([0, 1, 1, 1]);
  });
  it('breaks ties leftwards and uses one column when asked', () => {
    expect(assignColumns([100, 100], 2)).toEqual([0, 1]);
    expect(assignColumns([100, 200, 50], 1)).toEqual([0, 0, 0]);
  });
});

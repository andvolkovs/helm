import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { assignColumns, columnCount, rowSpan } from './masonry-model.ts';

// Same minimum width and gap as the grid this replaced (21rem, 1.25rem).
const MIN_COLUMN_REM = 21;
const GAP_REM = 1.25;
/** Height of one grid row track, px. Panels span as many as their height needs. */
const ROW_PX = 4;

interface MasonryProps {
  /** In reading order. Keys must stay stable: a changed key remounts the panel. */
  items: { key: string; node: ReactNode }[];
  /** Changes when panel heights change a lot on their own (e.g. a panel was folded). */
  layoutKey: string;
  /** While true (a drag), nothing moves between columns. */
  frozen: boolean;
}

/**
 * Panels flow into columns with no dead space under short ones. A plain grid gives every row the
 * height of its tallest panel, and CSS `columns` fills top to bottom, scrambling the order. So
 * each panel is dealt to the shortest column in JS, then placed in one shared CSS grid: an explicit
 * column, and a row span from its measured height over tiny row tracks (`dense` packs each one
 * right under the panel above it). Every panel stays a child of the same element, so moving it to
 * another column never remounts it: a half-typed task, focus and "Show more" survive. Spans follow
 * panel heights live; columns change only when the layout really does, and never during a drag.
 */
export function Masonry({ items, layoutKey, frozen }: MasonryProps) {
  const ref = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const [count, setCount] = useState(1);
  const [cols, setCols] = useState<Map<string, number>>(new Map());
  const [spans, setSpans] = useState<Map<string, number>>(new Map());
  const keys = items.map((i) => i.key).join('\n');
  const gapPx = () => GAP_REM * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

  // Column count follows the container width.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (frozen) return;
      const gap = gapPx();
      setCount(columnCount(el.clientWidth, (MIN_COLUMN_REM / GAP_REM) * gap, gap));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frozen]);

  // Row spans follow each panel's height as it grows and shrinks (tasks added, "Show more").
  useLayoutEffect(() => {
    const measureAll = () => {
      const gap = gapPx();
      setSpans((prev) => {
        let changed = false;
        const next = new Map<string, number>();
        for (const [key, el] of els.current) {
          const span = rowSpan(el.offsetHeight, gap, ROW_PX);
          next.set(key, span);
          if (prev.get(key) !== span) changed = true;
        }
        return changed || next.size !== prev.size ? next : prev;
      });
    };
    measureAll();
    const ro = new ResizeObserver(measureAll);
    for (const el of els.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [keys, count]);

  // Re-deal when the columns, the panels or the folding change, using the heights as they are now.
  useLayoutEffect(() => {
    if (frozen) return;
    const heights = items.map((i) => els.current.get(i.key)?.offsetHeight ?? 0);
    const next = assignColumns(heights, count);
    setCols(new Map(items.map((i, n) => [i.key, next[n]!])));
    // `items` is rebuilt every render; `keys` stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, keys, layoutKey, frozen]);

  return (
    <div className="bins" ref={ref} style={{ '--bins-cols': count, '--bins-row': `${ROW_PX}px` } as CSSProperties}>
      {items.map((item, n) => {
        const col = Math.min(cols.get(item.key) ?? n % count, count - 1);
        // Not measured yet: one track, corrected before the first paint.
        const span = spans.get(item.key) ?? 1;
        return (
          <div
            key={item.key}
            className="bins-item"
            style={{ gridColumn: col + 1, gridRow: `span ${span}` }}
            ref={(el) => {
              if (el) els.current.set(item.key, el);
              else els.current.delete(item.key);
            }}
          >
            {item.node}
          </div>
        );
      })}
    </div>
  );
}

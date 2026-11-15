import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface VMetrics { row: number; head: number; empty: number }
/**
 * A scroll list that renders only the items near the viewport (plus spacers for the rest) once it holds more than `virtualAfter`
 * items; below that it renders everything, exactly like a plain <ul>. Item heights are FIXED and come from CSS variables
 * (--rowh / --headh / --emptyh on the list), so the offsets are exact and scrolling never jumps.
 */
export function VList<T>({ items, sizeOf, renderItem, itemKey, focusKey, focusIndex, virtualAfter = 120, children }: {
  items: T[]; sizeOf: (item: T, m: VMetrics) => number; renderItem: (item: T) => React.ReactNode; itemKey: (item: T) => string;
  /** when this changes, the item at focusIndex is scrolled into view (if it is not visible already) */ focusKey?: unknown; focusIndex?: number;
  virtualAfter?: number; children?: React.ReactNode;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const virt = items.length > virtualAfter;
  const [vp, setVp] = useState({ top: 0, h: 900 });
  const [m, setM] = useState<VMetrics>({ row: 48, head: 32, empty: 28 });
  const offsets = useMemo(() => { if (!virt) return null; const o = new Float64Array(items.length + 1); for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + sizeOf(items[i], m); return o; }, [items, virt, m]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => {
      const cs = getComputedStyle(el), g = (n: string, d: number) => parseFloat(cs.getPropertyValue(n)) || d;
      const n = { row: g("--rowh", 48), head: g("--headh", 32), empty: g("--emptyh", 28) };
      setM((p) => (p.row === n.row && p.head === n.head && p.empty === n.empty ? p : n));
      setVp((v) => (v.h === el.clientHeight ? v : { top: Math.floor(el.scrollTop / 120) * 120, h: el.clientHeight }));
    };
    read(); const ro = new ResizeObserver(read); ro.observe(el); return () => ro.disconnect();
  }, []);
  const raf = useRef(0);
  const onScroll = () => {
    if (!virt || raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; const el = ref.current; if (!el) return; const top = Math.floor(el.scrollTop / 120) * 120; setVp((v) => (v.top === top ? v : { top, h: el.clientHeight })); });
  };
  useLayoutEffect(() => {
    const el = ref.current; if (!el || !offsets || focusIndex === undefined || focusIndex < 0) return;
    const y = offsets[focusIndex], h = offsets[focusIndex + 1] - y;
    if (y < el.scrollTop || y + h > el.scrollTop + el.clientHeight) { el.scrollTop = Math.max(0, y - el.clientHeight / 2); setVp({ top: Math.floor(el.scrollTop / 120) * 120, h: el.clientHeight }); }
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  let s = 0, e = items.length;
  if (offsets) {
    const over = 700, lo = vp.top - over, hi = vp.top + vp.h + 120 + over;
    let a = 0, b = items.length; while (a < b) { const mid = (a + b) >> 1; if (offsets[mid + 1] <= lo) a = mid + 1; else b = mid; } s = a;
    a = s; b = items.length; while (a < b) { const mid = (a + b) >> 1; if (offsets[mid] < hi) a = mid + 1; else b = mid; } e = a;
  }
  return (
    <ul ref={ref} className={virt ? "virt" : undefined} onScroll={onScroll}>
      {offsets && s > 0 && <li aria-hidden className="vspace" style={{ height: offsets[s] }} />}
      {items.slice(s, e).map((it) => <Fragment key={itemKey(it)}>{renderItem(it)}</Fragment>)}
      {offsets && e < items.length && <li aria-hidden className="vspace" style={{ height: offsets[items.length] - offsets[e] }} />}
      {children}
    </ul>
  );
}

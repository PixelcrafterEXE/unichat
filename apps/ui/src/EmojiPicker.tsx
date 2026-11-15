// One emoji picker for everything: composer, reactions (+ more), folder icons. All ~1.9k emojis from `gemoji` (loaded on first open), categories, search
// (names, aliases, tags, description), skin tones (kept in the UI settings), frequently used + recent (localStorage), keyboard navigation, windowed rendering,
// sticky category header. Emojis are drawn with the bundled 'UniChat Emoji' font (global). On phones the popover is a bottom sheet.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "./icons";
import { loadSettings } from "./util";

type G = { emoji: string; names: string[]; tags: string[]; description: string; category: string };
let cache: Promise<G[]> | undefined;
const load = () => (cache ??= import("gemoji").then((m) => m.gemoji as G[]));

export const EMOJI_CATEGORIES: { key: string; label: string; icon: string }[] = [
  { key: "Smileys & Emotion", label: "Smileys", icon: "😀" }, { key: "People & Body", label: "People", icon: "👋" }, { key: "Animals & Nature", label: "Nature", icon: "🐻" },
  { key: "Food & Drink", label: "Food", icon: "🍔" }, { key: "Activities", label: "Activities", icon: "⚽" }, { key: "Travel & Places", label: "Travel", icon: "✈️" },
  { key: "Objects", label: "Objects", icon: "💡" }, { key: "Symbols", label: "Symbols", icon: "❤️" }, { key: "Flags", label: "Flags", icon: "🏁" },
];

// ---- skin tone (a UI setting; App owns the settings object, so changes go through an event it merges and saves) ----
export const TONES = ["", "\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"];
const TONE_NAMES = ["Default", "Light", "Medium-light", "Medium", "Medium-dark", "Dark"];
const TONE_EVENT = "unichat-settings-patch";
let toneNow = -1;
const toneGet = () => { if (toneNow < 0) { const t = Number(loadSettings().skinTone); toneNow = t >= 0 && t <= 5 ? t : 0; } return toneNow; };
function setTone(n: number) { toneNow = n; dispatchEvent(new CustomEvent(TONE_EVENT, { detail: { skinTone: n } })); }
function useTone(): [number, (n: number) => void] {
  const [t, set] = useState(toneGet);
  useEffect(() => { const f = () => set(toneGet()); addEventListener(TONE_EVENT, f); return () => removeEventListener(TONE_EVENT, f); }, []);
  return [t, setTone];
}
const BASE = /(\p{Emoji_Modifier_Base})️?/gu, TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/gu;
const canTone = (e: string) => /\p{Emoji_Modifier_Base}/u.test(e);
/** The emoji in the chosen skin tone (every person in the sequence gets it). */
export function toned(e: string, tone: number): string { return tone > 0 && canTone(e) ? e.replace(BASE, "$1" + TONES[tone]) : e; }
const norm = (e: string) => e.replace(TONE_RE, "").replace(/️/g, "");

// ---- recents ----
const KEY = "unichat.emoji.recent";
interface Used { r: string[]; c: Record<string, number> }
function readUsed(): Used { try { const j = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return { r: Array.isArray(j.r) ? j.r.filter((x: unknown) => typeof x === "string").slice(0, 32) : [], c: j.c && typeof j.c === "object" ? j.c : {} }; } catch { return { r: [], c: {} }; } }
function remember(e: string) {
  try { const u = readUsed(), k = norm(e); u.r = [e, ...u.r.filter((x) => norm(x) !== k)].slice(0, 32); u.c[k] = (u.c[k] ?? 0) + 1;
    const keep = Object.entries(u.c).sort((a, b) => b[1] - a[1]).slice(0, 60); u.c = Object.fromEntries(keep); localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* storage unavailable: no recents */ }
}

// ---- layout ----
const HEAD = 30;
const useCell = () => {
  const q = typeof matchMedia === "function" ? matchMedia("(max-width: 720px), (pointer: coarse)") : undefined;
  const [coarse, set] = useState(!!q?.matches);
  useEffect(() => { if (!q) return; const f = () => set(q.matches); q.addEventListener("change", f); return () => q.removeEventListener("change", f); }, [q]);
  return coarse ? 44 : 38;
};

type Row = { k: "head"; id: string; label: string } | { k: "cells"; start: number; n: number };
interface Cell { e: string; label: string }

function score(g: G, q: string): number {
  let best = 9;
  for (const n of g.names) { const w = n.replace(/_/g, " "); if (w === q) return 0; if (w.startsWith(q)) best = Math.min(best, 1); else if (w.includes(q)) best = Math.min(best, 2); }
  for (const t of g.tags) { const w = t.replace(/_/g, " "); if (w === q) return 0; if (w.startsWith(q)) best = Math.min(best, 1); else if (w.includes(q)) best = Math.min(best, 2); }
  const d = g.description.toLowerCase(); if (d === q) return 0; if (d.startsWith(q)) best = Math.min(best, 1); else if (d.includes(q)) best = Math.min(best, 3);
  return best;
}

export function EmojiPicker({ onPick, onClose, autoFocus = true, id }: { onPick: (emoji: string) => void; onClose?: () => void; autoFocus?: boolean; id?: string }) {
  const [all, setAll] = useState<G[] | null>(null);
  useEffect(() => { let live = true; load().then((g) => live && setAll(g), () => live && setAll([])); return () => { live = false; }; }, []);
  const [q, setQ] = useState(""), [tone, setT] = useTone(), [toneOpen, setToneOpen] = useState(false), [active, setActive] = useState(-1), [used, setUsed] = useState<Used>(readUsed);
  const cell = useCell();
  const scroller = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 320, h: 300 }), [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const f = () => setBox({ w: el.clientWidth, h: el.clientHeight }); f();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(f) : undefined; ro?.observe(el); return () => ro?.disconnect();
  }, [all]);
  const byKey = useMemo(() => new Map((all ?? []).map((g) => [norm(g.emoji), g])), [all]);
  const cols = Math.max(1, Math.floor(box.w / cell)), cw = box.w / cols;

  // the content: [{head, cells}...] -> rows + flat list of cells for keyboard navigation
  const layout = useMemo(() => {
    if (!all) return { rows: [] as Row[], flat: [] as Cell[], offs: [] as number[], total: 0, sections: [] as { id: string; label: string; row: number }[] };
    const sections: { id: string; label: string; items: Cell[] }[] = [];
    const cellOf = (e: string): Cell => ({ e: toned(byKey.get(norm(e))?.emoji ?? e, tone), label: byKey.get(norm(e))?.description ?? "emoji" });
    const n = q.trim().toLowerCase().replace(/^:|:$/g, "");
    if (n) {
      const hits = all.map((g) => [score(g, n), g] as const).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0]);
      sections.push({ id: "results", label: `Results · ${hits.length}`, items: hits.map(([, g]) => ({ e: toned(g.emoji, tone), label: g.description })) });
    } else {
      const freq = Object.entries(used.c).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, cols * 1).map(([k]) => k);
      if (freq.length) sections.push({ id: "frequent", label: "Frequently used", items: freq.map(cellOf) });
      if (used.r.length) sections.push({ id: "recent", label: "Recent", items: used.r.slice(0, Math.max(cols, 16)).map(cellOf) });
      for (const c of EMOJI_CATEGORIES) { const items = all.filter((g) => g.category === c.key).map((g) => ({ e: toned(g.emoji, tone), label: g.description })); if (items.length) sections.push({ id: c.key, label: c.key, items }); }
    }
    const rows: Row[] = [], flat: Cell[] = [], secs: { id: string; label: string; row: number }[] = [];
    for (const s of sections) {
      secs.push({ id: s.id, label: s.label, row: rows.length }); rows.push({ k: "head", id: s.id, label: s.label });
      for (let i = 0; i < s.items.length; i += cols) { rows.push({ k: "cells", start: flat.length + i, n: Math.min(cols, s.items.length - i) }); }
      flat.push(...s.items);
    }
    const offs: number[] = []; let y = 0; for (const r of rows) { offs.push(y); y += r.k === "head" ? HEAD : cell; }
    return { rows, flat, offs, total: y, sections: secs };
  }, [all, q, tone, used, cols, cell, byKey]);
  const { rows, flat, offs, total, sections } = layout;

  const pick = useCallback((e: string) => { remember(e); setUsed(readUsed()); onPick(e); }, [onPick]);
  const jump = (row: number) => { const el = scroller.current; if (el) el.scrollTop = offs[row] ?? 0; };
  const reveal = (idx: number) => { // scroll so the cell of flat index idx is visible
    const el = scroller.current; if (!el) return;
    const ri = rows.findIndex((r) => r.k === "cells" && idx >= r.start && idx < r.start + r.n); if (ri < 0) return;
    const y = offs[ri]!; if (y - HEAD < el.scrollTop) el.scrollTop = Math.max(0, y - HEAD); else if (y + cell > el.scrollTop + el.clientHeight) el.scrollTop = y + cell - el.clientHeight;
  };
  const move = (to: number) => { const i = Math.max(0, Math.min(flat.length - 1, to)); setActive(i); reveal(i); };
  useEffect(() => { setActive(-1); if (scroller.current) scroller.current.scrollTop = 0; }, [q]);

  const onKey = (e: React.KeyboardEvent) => {
    const inInput = (e.target as HTMLElement).tagName === "INPUT", n = flat.length; if (!n) { if (e.key === "Escape") { e.stopPropagation(); onClose?.(); } return; }
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); move(active < 0 ? 0 : active + cols); break;
      case "ArrowUp": e.preventDefault(); move(active < 0 ? 0 : active - cols); break;
      case "ArrowRight": if (active >= 0 || !inInput || !q) { e.preventDefault(); move(active + 1); } break;
      case "ArrowLeft": if (active >= 0 || !inInput || !q) { e.preventDefault(); move(active < 0 ? 0 : active - 1); } break;
      case "PageDown": e.preventDefault(); move(active + cols * 5); break;
      case "PageUp": e.preventDefault(); move(active - cols * 5); break;
      case "Home": if (active >= 0) { e.preventDefault(); move(0); } break;
      case "End": if (active >= 0) { e.preventDefault(); move(n - 1); } break;
      case "Enter": if (inInput) e.preventDefault(); if (active >= 0 && flat[active]) { e.preventDefault(); pick(flat[active]!.e); } else if (q.trim() && flat[0]) { e.preventDefault(); pick(flat[0]!.e); } break;
      case "Escape": e.stopPropagation(); e.preventDefault(); if (q) setQ(""); else onClose?.(); break;
    }
  };

  // windowed rows
  const from = Math.max(0, offs.findIndex((o, i) => o + (rows[i]!.k === "head" ? HEAD : cell) > top) - 1);
  let to = from; while (to < rows.length && offs[to]! < top + box.h + cell) to++;
  const cur = (() => { let s = sections[0]; for (const x of sections) if ((offs[x.row] ?? 0) <= top + 1) s = x; return s; })();
  const curCat = q ? "" : cur?.id ?? "";

  return (
    <div className="epick" id={id} ref={root} onKeyDown={onKey} data-total={flat.length} data-tone={tone}>
      <div className="epsearch"><Search size={15} /><input type="search" role="combobox" aria-expanded="true" aria-controls="epgrid" aria-activedescendant={active >= 0 ? `ep-${active}` : undefined} placeholder="Search emojis (e.g. party, heart, flag)" aria-label="Search emojis" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={autoFocus} />
        {q && <button type="button" className="epclear" aria-label="Clear search" onClick={() => setQ("")}><X size={14} /></button>}</div>
      <div className="epcats" role="tablist" aria-label="Emoji categories">
        {(used.r.length > 0 ? [{ key: "recent", label: "Recent", icon: "🕘" }] : []).concat(EMOJI_CATEGORIES.map((c) => ({ key: c.key, label: c.label, icon: c.icon }))).map((c) => {
          const s = sections.find((x) => x.id === c.key || (c.key === "recent" && (x.id === "frequent" || x.id === "recent")));
          return <button key={c.key} type="button" role="tab" aria-selected={curCat === c.key || (c.key === "recent" && curCat === "frequent")} aria-label={c.label} title={c.label} data-cat={c.key} disabled={!!q || !s} className={curCat === c.key || (c.key === "recent" && curCat === "frequent") ? "on" : ""} onClick={() => s && jump(s.row)}>{c.icon}</button>;
        })}
      </div>
      {all === null ? <p className="hint eploading">Loading…</p> : (
        <div className="epbody">
          {cur && <div className="epsticky" aria-hidden>{cur.label}</div>}
          <div className="epscroll" id="epgrid" ref={scroller} role="group" aria-label="Emojis" onScroll={(e) => setTop((e.target as HTMLElement).scrollTop)}>
            {!flat.length && <p className="hint epnone">No emoji found.</p>}
            <div className="epspacer" style={{ height: total }}>
              {rows.slice(from, to).map((r, k) => { const i = from + k;
                if (r.k === "head") return <div key={r.id} className="ephead" style={{ top: offs[i], height: HEAD }}>{r.label}</div>;
                return <div key={i} className="eprow" style={{ top: offs[i], height: cell }}>{Array.from({ length: r.n }, (_, j) => { const idx = r.start + j, c = flat[idx]!;
                  return <button key={idx} id={`ep-${idx}`} type="button" tabIndex={-1} className={"epcell" + (idx === active ? " active" : "")} style={{ left: j * cw, width: cw, height: cell }} title={c.label} aria-label={c.label} data-emoji={c.e} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c.e)}>{c.e}</button>; })}</div>; })}
            </div>
          </div>
        </div>)}
      <div className="eptone">
        <button type="button" className="eptonebtn" aria-expanded={toneOpen} aria-label={`Skin tone: ${TONE_NAMES[tone]}`} title="Skin tone" onClick={() => setToneOpen((v) => !v)}><span>{toned("\u{1F44B}", tone)}</span></button>
        {toneOpen ? <div className="eptones" role="radiogroup" aria-label="Skin tone">{TONES.map((t, i) => <button key={i} type="button" role="radio" aria-checked={i === tone} aria-label={TONE_NAMES[i]} title={TONE_NAMES[i]} data-tone={i} className={i === tone ? "on" : ""} onClick={() => { setT(i); setToneOpen(false); }}>{toned("\u{1F44B}", i)}</button>)}</div>
          : <span className="eptip">{flat.length ? `${(all?.length ?? 0).toLocaleString()} emojis` : ""}</span>}
      </div>
    </div>);
}

// ---- where the click happened (a popover opens next to the button that opened it) ----
let lastClick: { r: DOMRect; t: number } | undefined;
if (typeof document !== "undefined") document.addEventListener("click", (e) => { const b = (e.target as Element | null)?.closest?.("button, [role=button], .chip"); if (b) lastClick = { r: b.getBoundingClientRect(), t: Date.now() }; }, true);

/** The picker as a popover next to the control that was just clicked (bottom sheet on phones). Closes on outside click / Escape. */
export function EmojiPopover({ onPick, onClose, onEscape, keepOpen }: { onPick: (emoji: string) => void; onClose: () => void; /** closed with the Escape key (e.g. to give the focus back to the composer) */ onEscape?: () => void; keepOpen?: boolean }) {
  const phone = typeof matchMedia === "function" && matchMedia("(max-width: 720px)").matches;
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => {
    const W = Math.min(352, innerWidth - 16), H = Math.min(420, innerHeight - 16), a = lastClick && Date.now() - lastClick.t < 3000 ? lastClick.r : undefined;
    if (!a) return { left: Math.max(8, (innerWidth - W) / 2), top: Math.max(8, (innerHeight - H) / 2), W, H };
    const left = Math.max(8, Math.min(innerWidth - W - 8, a.right - W)), above = a.top - H - 8 >= 8, top = above ? a.top - H - 8 : Math.max(8, Math.min(innerHeight - H - 8, a.bottom + 8));
    return { left, top, W, H };
  });
  useEffect(() => {
    const down = (e: Event) => { const t = e.target as Element; if (ref.current?.contains(t)) return; if (lastClick && t.closest?.("button") && (t.closest("button") as HTMLElement).getBoundingClientRect().left === lastClick.r.left && (t.closest("button") as HTMLElement).getBoundingClientRect().top === lastClick.r.top) return; onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { onEscape?.(); onClose(); } };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", esc); };
  }, [onClose, onEscape]);
  const style = phone ? undefined : { left: pos.left, top: pos.top, width: pos.W, height: pos.H };
  return createPortal(
    <>
      {phone && <div className="epbackdrop" onClick={onClose} />}
      <div ref={ref} className={"epop" + (phone ? " sheet" : "")} style={style} role="dialog" aria-label="Emoji picker" onContextMenu={(e) => e.preventDefault()}>
        {phone && <div className="epgrab"><button type="button" className="epdone" aria-label="Close emoji picker" onClick={onClose}><X size={18} /></button></div>}
        <EmojiPicker autoFocus={!phone} onClose={() => { onEscape?.(); onClose(); }} onPick={(e) => { onPick(e); if (!keepOpen) onClose(); }} />
      </div>
    </>, document.body);
}

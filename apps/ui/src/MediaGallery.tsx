// "Show all" of a chat's shared media: a gallery (modal on desktop, full screen on a phone) with Photos & videos / Files / Links / Voice,
// lazy thumbnails, infinite scroll against the backend's paged `chatMedia`, and a viewer with next / previous and "Show in chat".
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, Chat, Message } from "./types";
import { cardsOf } from "./types";
import { VoicePlayer } from "./Voice";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, ImageIcon, Link2, Mic, Play, X } from "./icons";
import { core, fmtDate, fmtBytes, fmtDuration, loadAttachment, useAttachment } from "./util";
const fmtTime = (t: string) => fmtDate(t);

export type MediaTab = "media" | "files" | "links" | "voice";
const TABS: { key: MediaTab; label: string }[] = [{ key: "media", label: "Photos & videos" }, { key: "files", label: "Files" }, { key: "links", label: "Links" }, { key: "voice", label: "Voice" }];
const TAB_ICON = { media: ImageIcon, files: FileText, links: Link2, voice: Mic } as const;
export interface MItem { key: string; m: Message; a?: Attachment; url?: string; title?: string; subtitle?: string }

const URL_RE = /https?:\/\/[^\s<>"]+/gi;
/** What a message contributes to a tab (one item per attachment / link). */
export function itemsOf(tab: MediaTab, m: Message): MItem[] {
  if (m.deleted) return [];
  const at = (f: (a: Attachment) => boolean) => (m.attachments ?? []).filter(f).map((a) => ({ key: `${m.chatId}|${m.id}|${a.id}`, m, a }));
  if (tab === "media") return at((a) => a.kind === "image" || a.kind === "video");
  if (tab === "files") return at((a) => a.kind === "file");
  if (tab === "voice") return at((a) => a.kind === "voice" || a.kind === "audio");
  const seen = new Set<string>(), out: MItem[] = [], cards = cardsOf(m);
  const add = (url: string) => { const u = url.replace(/[.,;:!?)\]]+$/, ""); if (!u || seen.has(u)) return; seen.add(u); const c = cards.find((x) => x.url === u); out.push({ key: `${m.chatId}|${m.id}|${u}`, m, url: u, title: c?.title, subtitle: c?.subtitle ?? c?.body }); };
  for (const x of m.text?.match(URL_RE) ?? []) add(x);
  for (const c of cards) if (c.url) add(c.url);
  return out;
}
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** A file name shortened in the middle: the start and the end (with the extension) stay visible. */
export function MidEllipsis({ text }: { text: string }) {
  const keep = Math.min(text.length, Math.max(8, (text.length - text.lastIndexOf(".") || 0) + 3)), cut = text.length > 18 ? text.length - keep : text.length;
  return <span className="mid" title={text}><span className="midh">{text.slice(0, cut)}</span><span className="midt">{text.slice(cut)}</span></span>;
}

type Page = { messages: Message[]; next?: string; count?: Partial<Record<MediaTab, number>> };
interface TabState { msgs: Message[]; next?: string; done: boolean; loading: boolean; error?: string; started: boolean }
const EMPTY: TabState = { msgs: [], done: false, loading: false, started: false };
const fits = (tab: MediaTab, m: Message) => itemsOf(tab, m).length > 0;

export function MediaGallery({ chat, initialTab = "media", counts, onClose, onJump }: { chat: Chat; initialTab?: MediaTab; counts?: Partial<Record<MediaTab, number>>; onClose: () => void; onJump?: (messageId: string, chatId?: string) => void }) {
  const [tab, setTab] = useState<MediaTab>(initialTab);
  const [st, setSt] = useState<Record<MediaTab, TabState>>({ media: EMPTY, files: EMPTY, links: EMPTY, voice: EMPTY });
  const [cnt, setCnt] = useState(counts ?? {});
  const legacy = useRef(false), busy = useRef(new Set<MediaTab>()), alive = useRef(true), scroller = useRef<HTMLDivElement>(null), sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => () => { alive.current = false; }, []);

  /** one page of a tab: the paged backend call, or (older backend) a walk back through the history */
  const fetchPage = useCallback(async (t: MediaTab, cursor?: string): Promise<Page> => {
    if (!legacy.current && !cursor?.startsWith("h:")) {
      try { const r = await core.call("chatMedia", { chatId: chat.id, kinds: [t], limit: 60, ...(cursor ? { before: cursor } : {}) }); if (r && Array.isArray(r.messages)) return { messages: r.messages, next: r.next ?? undefined, count: r.count }; } catch { /* an older backend: page the history instead */ }
      legacy.current = true;
    }
    const got: Message[] = []; let before = cursor?.startsWith("h:") ? cursor.slice(2) : undefined, beforeChat: string | undefined, more = true;
    for (let i = 0; i < 8 && more && got.length < 40; i++) {
      const page: Message[] = await core.call("history", { chatId: chat.id, limit: 200, ...(before ? { beforeMessageId: before, ...(beforeChat ? { beforeChatId: beforeChat } : {}) } : {}) });
      if (!page?.length) { more = false; break; }
      before = page[0]!.id; beforeChat = page[0]!.chatId !== chat.id ? page[0]!.chatId : undefined; more = page.length >= 200;
      got.push(...page.filter((m) => fits(t, m)));
    }
    return { messages: got.reverse(), next: more && before ? "h:" + before : undefined };
  }, [chat.id]);

  const more = useCallback(async (t: MediaTab) => {
    if (busy.current.has(t)) return; busy.current.add(t);
    const cur = stRef.current[t]; if (cur.done) { busy.current.delete(t); return; }
    setSt((s) => ({ ...s, [t]: { ...s[t], loading: true, started: true, error: undefined } }));
    try {
      const r = await fetchPage(t, cur.next); if (!alive.current) return;
      if (r.count) setCnt((c) => ({ ...c, ...r.count }));
      setSt((s) => { const seen = new Set(s[t].msgs.map((m) => m.chatId + "|" + m.id)); const add = r.messages.filter((m) => !seen.has(m.chatId + "|" + m.id));
        return { ...s, [t]: { ...s[t], msgs: [...s[t].msgs, ...add], next: r.next, done: !r.next, loading: false, started: true } }; });
    } catch (e: any) { if (alive.current) setSt((s) => ({ ...s, [t]: { ...s[t], loading: false, error: e?.message || "Could not load", started: true } })); }
    finally { busy.current.delete(t); }
  }, [fetchPage]);
  const stRef = useRef(st); stRef.current = st;
  useEffect(() => { if (!st[tab].started) void more(tab); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  // tab counts are known after the first page of any tab; fetch the others' first pages quietly when the numbers are missing
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 0; }, [tab]);

  const items = useMemo(() => { const seen = new Set<string>(), out: MItem[] = []; for (const m of st[tab].msgs) for (const it of itemsOf(tab, m)) if (!seen.has(it.key)) { seen.add(it.key); out.push(it); } return out.sort((a, b) => b.m.time.localeCompare(a.m.time)); }, [st, tab]);
  const cur = st[tab];

  // infinite scroll: the sentinel under the list asks for the next page when it comes near
  useEffect(() => {
    const el = sentinel.current, root = scroller.current; if (!el || !root || cur.done || !cur.started) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) void more(tab); }, { root, rootMargin: "400px" });
    io.observe(el); return () => io.disconnect();
  }, [tab, cur.done, cur.started, cur.loading, items.length, more]);

  const [view, setView] = useState<number>(-1);
  const jump = (m: Message) => { onJump?.(m.id, m.chatId); onClose(); };
  const total = (t: MediaTab) => cnt[t] ?? (st[t].done ? itemsOfAll(st[t].msgs, t) : undefined);

  return (
    <div className="modalbg mgback" onMouseDown={onClose}>
      <div className="mgal" role="dialog" aria-label="Shared media" data-tab={tab} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mghead"><h3>Shared media</h3><button className="icon" aria-label="Close" onClick={onClose}><X size={18} /></button></div>
        <div className="mgtabs" role="tablist">
          {TABS.map((t) => { const n = total(t.key), Ic = TAB_ICON[t.key]; return <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} data-tab={t.key} className={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)}><Ic size={16} className="mgti" />{t.label}{n !== undefined && <span className="mgn">{n}</span>}</button>; })}
        </div>
        <div className="mgscroll" ref={scroller}>
          {tab === "media" && <div className="mggrid" data-count={items.length}>{items.map((it, i) => <MediaCell key={it.key} chat={chat} it={it} root={scroller} onOpen={() => setView(i)} />)}{cur.loading && Array.from({ length: items.length ? 6 : 18 }, (_, i) => <span key={"sk" + i} className="mgcell mgskel" aria-hidden />)}</div>}
          {tab === "files" && <div className="mglist">{items.map((it) => <FileRow key={it.key} chat={chat} it={it} onJump={() => jump(it.m)} />)}</div>}
          {tab === "links" && <div className="mglist">{items.map((it) => <LinkRow key={it.key} it={it} onJump={() => jump(it.m)} />)}</div>}
          {tab === "voice" && <div className="mglist">{items.map((it) => <VoiceRow key={it.key} chat={chat} it={it} onJump={() => jump(it.m)} />)}</div>}
          {!items.length && cur.done && <p className="hint mgempty">{tab === "media" ? "No photos or videos yet" : tab === "files" ? "No files yet" : tab === "links" ? "No links yet" : "No voice messages yet"}</p>}
          {cur.error && <p className="hint err mgempty">{cur.error} <button className="secondary" onClick={() => void more(tab)}>Retry</button></p>}
          {cur.loading && tab !== "media" && !items.length && Array.from({ length: 5 }, (_, i) => <div key={"sr" + i} className="mgrow mgskelrow" aria-hidden><span className="mgfi mgskel" /><span className="mgtext"><i className="mgskel" style={{ width: 120 + i * 20 }} /><i className="mgskel" style={{ width: 80 }} /></span></div>)}
          {cur.loading && !!items.length && <div className="mgloading" role="status" aria-label="Loading more"><i className="spinner" /></div>}
          <div ref={sentinel} className="mgsentinel" aria-hidden />
        </div>
        {view >= 0 && items[view] && tab === "media" && <MediaViewer chat={chat} items={items} index={view} hasMore={!cur.done} onMore={() => void more("media")} onIndex={setView} onClose={() => setView(-1)} onJump={jump} />}
      </div>
    </div>);
}
const itemsOfAll = (ms: Message[], t: MediaTab) => ms.reduce((n, m) => n + itemsOf(t, m).length, 0);

function useVisible(root: React.RefObject<HTMLElement>) {
  const ref = useRef<HTMLElement>(null); const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el || vis) return;
    if (typeof IntersectionObserver !== "function") { setVis(true); return; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setVis(true); io.disconnect(); } }, { root: root.current, rootMargin: "300px" });
    io.observe(el); return () => io.disconnect();
  }, [vis, root]);
  return [ref, vis] as const;
}

/** The first frame of a video as its cover, when the messenger sent no preview picture: the file is loaded (only when asked to) and a muted, never-played <video> shows frame 0.1 s. */
export function VideoCover({ chat, m, a, on }: { chat: Chat; m: Message; a: Attachment; on: boolean }) {
  const { r } = useAttachment(m.chatId || chat.id, m.id, a, on && !a.thumbnailDataUrl);
  if (a.thumbnailDataUrl) return <img src={a.thumbnailDataUrl} alt="" loading="lazy" decoding="async" />;
  if (!r) return <ImageIcon size={22} />;
  return <video src={r.url + "#t=0.1"} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />;
}

function MediaCell({ chat, it, root, onOpen }: { chat: Chat; it: MItem; root: React.RefObject<HTMLElement>; onOpen: () => void }) {
  const [ref, vis] = useVisible(root), a = it.a!, video = a.kind === "video";
  // a small inline preview is used as is; without one an image's bytes are loaded (only when the cell is near the screen)
  const { r } = useAttachment(it.m.chatId || chat.id, it.m.id, a, vis && !video && !a.thumbnailDataUrl);
  const src = a.thumbnailDataUrl ?? r?.url;
  return (
    <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className={"mgcell" + (vis ? " vis" : "")} data-jump={it.m.id} data-kind={a.kind} aria-label={`${video ? "Video" : "Photo"}${a.name ? " " + a.name : ""}, ${fmtTime(it.m.time)}`} title={a.name} onClick={onOpen}>
      {vis && video ? <VideoCover chat={chat} m={it.m} a={a} on /> : vis && src ? <img src={src} alt="" loading="lazy" decoding="async" /> : vis ? <ImageIcon size={22} /> : null}
      {video && <span className="mgplay"><Play size={14} fill="currentColor" />{a.durationMs ? <small>{fmtDuration(a.durationMs)}</small> : null}</span>}
    </button>);
}

const EXT: Record<string, string> = { pdf: "#e5484d", doc: "#3b82f6", docx: "#3b82f6", xls: "#23a559", xlsx: "#23a559", csv: "#23a559", ppt: "#f0763a", pptx: "#f0763a", zip: "#a78bfa", rar: "#a78bfa", "7z": "#a78bfa", mp3: "#eb459e", wav: "#eb459e", png: "#14b8a6", jpg: "#14b8a6", txt: "#80848e", md: "#80848e" };
const extOf = (n?: string) => { const m = /\.([A-Za-z0-9]{1,5})$/.exec(n ?? ""); return m ? m[1]!.toLowerCase() : ""; };

function FileRow({ chat, it, onJump }: { chat: Chat; it: MItem; onJump: () => void }) {
  const a = it.a!, ext = extOf(a.name), name = a.name ?? "File";
  const open = async () => { const r = await loadAttachment(it.m.chatId || chat.id, it.m.id, a.id).catch(() => undefined); if (!r) return; const l = document.createElement("a"); l.href = r.url; l.download = a.name ?? r.name ?? "file"; l.click(); };
  return (
    <div className="mgrow filerow2" data-file={name}>
      <button type="button" className="mgrowmain" onClick={open} title={`Download ${name}`}>
        <span className="mgfi" style={{ ["--ext" as string]: EXT[ext] ?? "var(--accent)" }}><FileText size={20} />{ext && <b>{ext.slice(0, 4)}</b>}</span>
        <span className="mgtext"><MidEllipsis text={name} /><small>{[a.size ? fmtBytes(a.size) : "", fmtTime(it.m.time), it.m.fromMe ? "You" : it.m.sender].filter(Boolean).join(" · ")}</small></span>
      </button>
      <button type="button" className="icon mgshow" title="Show in chat" aria-label="Show in chat" onClick={onJump}><ExternalLink size={16} /></button>
    </div>);
}
function LinkRow({ it, onJump }: { it: MItem; onJump: () => void }) {
  return (
    <div className="mgrow linkrow" data-link={it.url}>
      <a className="mgrowmain" href={it.url} target="_blank" rel="noreferrer noopener" title={it.url}>
        <span className="mgfi link"><Link2 size={20} /></span>
        <span className="mgtext"><b className="mgt">{it.title ?? hostOf(it.url!)}</b>{it.subtitle && <small className="mgsub">{it.subtitle}</small>}<small className="mgurl">{it.url}</small><small>{fmtTime(it.m.time)}{it.m.fromMe ? " · You" : it.m.sender ? " · " + it.m.sender : ""}</small></span>
      </a>
      <button type="button" className="icon mgshow" title="Show in chat" aria-label="Show in chat" onClick={onJump}><ExternalLink size={16} /></button>
    </div>);
}
function VoiceRow({ chat, it, onJump }: { chat: Chat; it: MItem; onJump: () => void }) {
  const a = it.a!; const { r, err, load } = useAttachment(it.m.chatId || chat.id, it.m.id, a, false);
  return (
    <div className="mgrow voicerow">
      <span className="mgtext mgvoice"><small className="mgwho">{[it.m.fromMe ? "You" : it.m.sender || "Voice message", fmtTime(it.m.time)].join(" · ")}</small>
        <VoicePlayer a={a} url={r?.url} onLoad={load} failed={err} /></span>
      <button type="button" className="icon mgshow" title="Show in chat" aria-label="Show in chat" onClick={onJump}><ExternalLink size={16} /></button>
    </div>);
}

function MediaViewer({ chat, items, index, hasMore, onMore, onIndex, onClose, onJump }: { chat: Chat; items: MItem[]; index: number; hasMore: boolean; onMore: () => void; onIndex: (i: number) => void; onClose: () => void; onJump: (m: Message) => void }) {
  const it = items[index]!, a = it.a!, video = a.kind === "video";
  const [r, setR] = useState<{ url: string; name?: string }>(), [err, setErr] = useState(false);
  useEffect(() => { setR(undefined); setErr(false); let on = true; loadAttachment(it.m.chatId || chat.id, it.m.id, a.id).then((x) => on && setR(x), () => on && setErr(true)); return () => { on = false; }; }, [it.key, chat.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); };
  useEffect(() => { if (hasMore && index >= items.length - 3) onMore(); }, [index, items.length, hasMore]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); } else if (e.key === "ArrowRight") { e.preventDefault(); go(1); } };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const src = r?.url ?? (video ? undefined : a.thumbnailDataUrl);
  return (
    <div className="lightbox mgview" onClick={onClose} role="dialog" aria-label="Media viewer">
      <div className="mgvtop" onClick={(e) => e.stopPropagation()}><span className="mgcount">{index + 1} / {items.length}{hasMore ? "+" : ""}</span><span className="mgmeta">{it.m.fromMe ? "You" : it.m.sender} · {fmtTime(it.m.time)} {new Date(it.m.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></div>
      {video ? (r ? <video className="lbvideo" src={r.url} controls autoPlay playsInline aria-label={a.name ?? "video"} onClick={(e) => e.stopPropagation()} /> : <p className="hint">{err ? "Could not load this video" : "Loading…"}</p>)
        : src ? <img src={src} alt={a.name ?? ""} onClick={(e) => e.stopPropagation()} /> : <p className="hint">{err ? "Could not load this photo" : "Loading…"}</p>}
      <button type="button" className="mgnav prev" aria-label="Previous" disabled={index <= 0} onClick={(e) => { e.stopPropagation(); go(-1); }}><ChevronLeft size={26} /></button>
      <button type="button" className="mgnav next" aria-label="Next" disabled={index >= items.length - 1} onClick={(e) => { e.stopPropagation(); go(1); }}><ChevronRight size={26} /></button>
      <div className="mgvbar" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="secondary" data-act="show-in-chat" onClick={() => onJump(it.m)}><ExternalLink size={15} /> Show in chat</button>
        {r && <a className="primary dl" href={r.url} download={a.name ?? r.name ?? (video ? "video" : "image")}><Download size={15} /> Download</a>}
      </div>
    </div>);
}

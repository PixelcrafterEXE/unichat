// "Search all messages": left-column panel over the Hub's searchAll (local archive of every account, signed-out ones included).
// One query line with operators (from: in: has: before: after: "phrases" -exclude); the chips below insert / remove them.
import { useEffect, useRef, useState } from "react";
import type { Account, Chat, ProviderInfo } from "./types";
import { Search, X, LogOut } from "./icons";
import { Avatar, ProviderIcon, ProviderStack, core, fmtDate, fmtTime } from "./util";

export interface GHit { chatId: string; messageId: string; accountId: string; time: string; sender: string; fromMe: boolean; snippet: string; ranges: [number, number][]; offline?: string }
export interface GGroup { chatId: string; name: string; kind?: string; provider: string; providers: string[]; accountId: string; offline?: string; total: number; hits: GHit[] }
interface NameHit { chatId: string; name: string; kind?: string; provider: string; accountId: string; providers: string[] }
interface Res { groups: GGroup[]; total: number; next?: string; chats?: NameHit[]; parsed?: { filters: { op: string; value: string }[]; errors: string[] }; tookMs?: number; index: { ready: boolean; truncated: boolean; coveredFrom?: string; deep?: boolean; engine?: string } }
const HAS = ["image", "video", "file", "voice", "link", "poll"];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Remove one `op:value` token (value may be quoted) from the query text. */
export const dropToken = (q: string, op: string, value: string) => q.replace(new RegExp(`(^|\\s)${op}:(?:"${esc(value)}"|${esc(value)})(?=\\s|$)`, "i"), " ").replace(/\s+/g, " ").trimStart();
export const addToken = (q: string, op: string, value: string) => `${q.trimEnd()}${q.trim() ? " " : ""}${op}:${/\s/.test(value) ? `"${value}"` : value} `;

export function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const out: React.ReactNode[] = []; let at = 0;
  ranges.forEach(([a, b], i) => { out.push(text.slice(at, a), <mark key={i}>{text.slice(a, b)}</mark>); at = b; });
  out.push(text.slice(at)); return <>{out}</>;
}
const day = (iso: string) => fmtDate(iso);

export default function GlobalSearch({ initial, providers, accounts, chats, current, onOpen, onOpenChat, onClose }: { initial?: string; providers: ProviderInfo[]; accounts: Account[]; chats: Chat[]; current?: { id: string; name: string }; onOpen: (g: GGroup, h: GHit) => void; onOpenChat?: (chatId: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial ?? "");
  const [provs, setProvs] = useState<string[]>([]); const [acc, setAcc] = useState(""); const [kind, setKind] = useState(""); const [since, setSince] = useState(""); const [until, setUntil] = useState("");
  const [res, setRes] = useState<Res>(); const [loading, setLoading] = useState(false); const [more, setMore] = useState(false); const [err, setErr] = useState(""); const [deep, setDeep] = useState(false); const [here, setHere] = useState(false); const [active, setActive] = useState(-1); const [indexed, setIndexed] = useState<number>();
  const seq = useRef(0);
  const used = providers.filter((p) => accounts.some((a) => a.provider === p.name));
  const params = () => ({ query: q.trim(), limit: 30, ...(provs.length ? { providers: provs } : {}), ...(acc ? { accountIds: [acc] } : {}), ...(kind ? { kinds: [kind] } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}), ...(deep ? { deep: true } : {}), ...(here && current ? { chatIds: [current.id] } : {}) });
  const run = (cursor?: string) => {
    const my = ++seq.current; setErr(""); cursor ? setMore(true) : setLoading(true);
    return core.call("searchAll", { ...params(), ...(cursor ? { before: cursor } : {}) }).then((r: Res) => {
      if (my !== seq.current) return;
      setRes((old) => {
        if (!cursor || !old) return r;
        const groups = old.groups.map((g) => ({ ...g, hits: [...g.hits] }));
        for (const g of r.groups) { const x = groups.find((y) => y.chatId === g.chatId); if (x) x.hits.push(...g.hits); else groups.push(g); }
        return { ...r, groups };
      });
    }, (e) => { if (my === seq.current) setErr(e?.message ?? String(e)); }).finally(() => { if (my === seq.current) { setLoading(false); setMore(false); } });
  };
  useEffect(() => {
    if (!q.trim()) { seq.current++; setRes(undefined); setLoading(false); setErr(""); return; }
    const t = setTimeout(() => void run(), 250); return () => clearTimeout(t);
  }, [q, provs.join(), acc, kind, since, until, deep, here]);
  useEffect(() => core.on((ev, d) => { if (ev === "search-index") setIndexed(d.done ? undefined : d.indexed); }), []);
  useEffect(() => setActive(-1), [res?.groups]);
  const label = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const pname = (n: string) => providers.find((p) => p.name === n)?.displayName ?? n;
  const flat = res?.groups.flatMap((g) => g.hits.map((h) => [g, h] as const)) ?? [];
  const hasOn = (k: string) => new RegExp(`(^|\\s)has:${k}(\\s|$)`, "i").test(q);
  const toggleHas = (k: string) => setQ((v) => (hasOn(k) ? dropToken(v, "has", k) : addToken(v, "has", k)));
  const filters = (res?.parsed?.filters ?? []).filter((f) => f.op !== "has");
  useEffect(() => { if (active >= 0) document.querySelector(".gsearch .ghit.on")?.scrollIntoView({ block: "nearest" }); }, [active]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(-1, i - 1)); }
    else if (e.key === "Enter" && flat.length) { const [g, h] = flat[Math.max(0, active)]; onOpen(g, h); }
  };
  let n = -1;
  return (
    <div className="gsearch" role="search">
      <header className="gh"><Search size={16} /><span>Search all messages</span><button className="icon" onClick={onClose} aria-label="Close search"><X size={16} /></button></header>
      <div className="chatsearch"><Search size={14} /><input autoFocus placeholder='Words, "exact phrase", from:anna, has:image…' value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} aria-label="Search all messages" />
        {q && <button className="icon" onClick={() => setQ("")} aria-label="Clear"><X size={14} /></button>}</div>
      <div className="gfilters">
        <div className="chips" data-chips="has">{HAS.map((k) => <button key={k} className={"chip2" + (hasOn(k) ? " on" : "")} data-has={k} aria-pressed={hasOn(k)} onClick={() => toggleHas(k)}>has:{k}</button>)}
          {current && <button className={"chip2" + (here ? " on" : "")} data-scope="here" aria-pressed={here} onClick={() => setHere((v) => !v)}>In this chat: {current.name}</button>}</div>
        {filters.length > 0 && <div className="chips" data-chips="parsed">{filters.map((f) => <button key={f.op + f.value} className="chip2 on" data-filter={f.op} title="Remove this filter" onClick={() => setQ((v) => dropToken(v, f.op, f.value))}>{f.op}:{f.value} <X size={10} /></button>)}</div>}
        {used.length > 1 && <div className="chips">{used.map((p) => <button key={p.name} className={"chip2" + (provs.includes(p.name) ? " on" : "")} data-prov={p.name} onClick={() => setProvs((l) => (l.includes(p.name) ? l.filter((x) => x !== p.name) : [...l, p.name]))}><ProviderIcon provider={p.name} size={12} /> {p.displayName}</button>)}</div>}
        <div className="frow">
          {accounts.length > 1 && <select aria-label="Account" value={acc} onChange={(e) => setAcc(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>}
          <select aria-label="Chat type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All chats</option><option value="dm">Direct</option><option value="group">Groups</option><option value="channel">Channels</option></select>
        </div>
        <div className="frow"><input type="date" aria-label="From date" value={since} onChange={(e) => setSince(e.target.value)} /><input type="date" aria-label="To date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
      </div>
      <div className="gres">
        {!q.trim() && <div className="gstate" data-help><p>Search the messages, file names, polls and contacts of every chat on this device, including signed-out accounts.</p>
          <p className="ghelp"><code>pizza</code> words start-match, any case or accent · <code>"friday night"</code> exact phrase · <code>-vegan</code> exclude<br /><code>from:anna</code> <code>in:family</code> <code>has:image</code> <code>after:2026-01-01</code> <code>before:2026-02-01</code><br />Arrow keys move, Enter opens.</p></div>}
        {loading && <p className="gstate" role="status"><span className="spinner" aria-hidden /> Searching…</p>}
        {err && <p className="gstate hint err" role="alert">{err} <button className="secondary" onClick={() => run()}>Retry</button></p>}
        {res?.parsed?.errors.map((e) => <p key={e} className="gstate hint err" data-qerr>{e}</p>)}
        {q.trim() && res && !err && <div className="scount" data-total={res.total}>{res.total === 0 ? "No messages found" : `${res.total} message${res.total === 1 ? "" : "s"}`}{loading && " · updating…"}</div>}
        {res && !res.index.ready && <p className="gstate" data-indexing>Still indexing your archive{indexed ? ` (${indexed.toLocaleString()} messages so far)` : ""}, results may be incomplete.</p>}
        {res?.chats && res.chats.length > 0 && <section data-names>
          <div className="ghead"><span>Chats and contacts</span></div>
          {res.chats.map((c) => <button key={c.chatId} className="ghit gname" data-name-hit={c.chatId} onClick={() => onOpenChat?.(c.chatId)}><b><Avatar name={c.name} of={{ kind: "chat", id: c.chatId }} size={20} /> {c.name}<time>{pname(c.provider)} · {label(c.accountId)}</time></b></button>)}
        </section>}
        {res?.groups.map((g) => (
          <section key={g.chatId} data-gchat={g.chatId}>
            <div className="ghead">{g.kind === "channel" ? <span className="hash"># </span> : null}<Avatar name={g.name} of={{ kind: "chat", id: g.chatId }} size={24} />
              <span><span>{g.name}</span><span className="gsub">{g.providers.length > 1 ? <ProviderStack providers={g.providers} size={12} /> : <ProviderIcon provider={g.providers[0] ?? g.provider} size={12} />} {[...new Set(g.hits.map((h) => label(h.accountId)))].join(", ")}{g.providers.length === 1 ? ` · ${pname(g.providers[0])}` : ""}</span></span>
              {g.offline && <LogOut size={12} aria-label="Signed out: read-only" />}<small>{g.total}</small></div>
            {g.hits.map((h) => { const i = ++n; return (
              <button key={h.chatId + "|" + h.messageId} className={"ghit" + (i === active ? " on" : "")} data-hit={h.messageId} onClick={() => onOpen(g, h)} onMouseMove={() => active !== i && setActive(i)}>
                <b>{h.fromMe ? "You" : h.sender}<time>{day(h.time)} {fmtTime(h.time)}</time></b><span><Marked text={h.snippet} ranges={h.ranges} /></span></button>); })}
          </section>))}
        {res?.next && <button className="secondary wide" disabled={more} onClick={() => run(res.next)}>{more ? "Loading…" : "Show more results"}</button>}
        {res?.index.truncated && !res.index.deep && q.trim() && <p className="gstate">Only messages since {day(res.index.coveredFrom!)} are in the fast index. <button className="secondary" onClick={() => setDeep(true)}>Search older messages (slower)</button></p>}
        {res && !err && q.trim() && <p className="gstate gfoot" data-engine={res.index.engine}>{res.tookMs ?? 0} ms{res.index.engine === "fts5" ? " · full-text index" : ""}</p>}
      </div>
    </div>
  );
}

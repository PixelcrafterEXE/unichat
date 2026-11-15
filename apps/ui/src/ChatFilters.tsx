import { useEffect, useRef, useState } from "react";
import type { Account, Chat, ProviderInfo } from "./types";
import { capsOf } from "./types";
import { viaNote } from "./relay";
import { ProviderIcon } from "./util";
import { Check, ChevronDown, Hash, Layers, LayoutList, User, Users, X } from "./icons";

/** Chat list filters (local, remembered in the UI settings). All active filters combine with AND; the "Find a chat" search is independent and, while it has text, the filters are not applied. */
export type KindFilter = "all" | "dm" | "group" | "channel";
export interface ChatFilters {
  unread: boolean;          // only chats with unread messages (muted ones only when `unreadMuted`)
  unreadMuted: boolean;     // ...also count muted chats
  accounts: string[];       // only chats of these accounts (empty = every messenger)
  kind: KindFilter;
  online: boolean;          // only 1:1 chats whose contact is online (needs an account with Capabilities.presence)
}
export const NO_FILTERS: ChatFilters = { unread: false, unreadMuted: false, accounts: [], kind: "all", online: false };
export function normFilters(v: unknown): ChatFilters {
  const o = (v && typeof v === "object" ? v : {}) as Partial<ChatFilters>;
  return { unread: !!o.unread, unreadMuted: !!o.unreadMuted, accounts: Array.isArray(o.accounts) ? o.accounts.filter((x) => typeof x === "string") : [], kind: ["dm", "group", "channel"].includes(o.kind as string) ? (o.kind as KindFilter) : "all", online: !!o.online };
}
/** Number of active filters (the badge). */
export const activeCount = (f: ChatFilters) => Number(f.unread) + Number(f.accounts.length > 0) + Number(f.kind !== "all") + Number(f.online);

/**
 * Does a row pass the filters? A merged row (several 1:1 chats of one person) passes when ANY member does for messenger / online, and counts
 * its summed unread. Muted state of a row = the row's own flag or its community's (`isMuted`).
 */
export function matchesFilters(c: Chat, f: ChatFilters, ctx: { members?: Chat[]; isMuted: (c: Chat) => boolean }): boolean {
  const parts = c.mergeMembers ? ctx.members ?? [] : [c];
  if (f.unread && !((c.unread ?? 0) > 0 && (f.unreadMuted || !ctx.isMuted(c)))) return false;
  if (f.accounts.length && !(c.mergeMembers ? parts.some((p) => f.accounts.includes(p.accountId)) : f.accounts.includes(c.accountId))) return false;
  if (f.kind !== "all" && c.kind !== f.kind) return false;
  if (f.online && !(c.kind === "dm" && (c.mergeMembers ? parts.some((p) => p.online) : c.online))) return false;
  return true;
}
export const isOnline = (c: Chat, members?: Chat[]) => c.kind === "dm" && (c.mergeMembers ? !!members?.some((p) => p.online) : !!c.online);

const KINDS: { v: KindFilter; label: string; Icon: typeof User }[] = [
  { v: "all", label: "All chats", Icon: LayoutList }, { v: "dm", label: "Personal chats", Icon: User }, { v: "group", label: "Groups", Icon: Users }, { v: "channel", label: "Community channels", Icon: Hash },
];

/** One compact row of icon buttons above the chat list: Unread, Messenger, Type, Online (only when some account supports presence), and a badge that clears everything. */
export function ChatFilterBar({ value, onChange, accounts, providers }: { value: ChatFilters; onChange: (f: ChatFilters) => void; accounts: Account[]; providers: ProviderInfo[] }) {
  const [open, setOpen] = useState<"" | "messenger" | "kind">("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(""); };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(""); };
    document.addEventListener("mousedown", h); document.addEventListener("keydown", k); return () => { document.removeEventListener("mousedown", h); document.removeEventListener("keydown", k); };
  }, [open]);
  const hasPresence = accounts.some((a) => a.state === "connected" && capsOf(a, providers)?.presence);
  const n = activeCount(value), set = (p: Partial<ChatFilters>) => onChange({ ...value, ...p });
  const kind = KINDS.find((k) => k.v === value.kind)!;
  const toggleAcc = (id: string) => set({ accounts: value.accounts.includes(id) ? value.accounts.filter((x) => x !== id) : [...value.accounts, id] });
  return (
    <div className="cfilters" ref={ref} role="toolbar" aria-label="Chat filters" data-active={n}>
      <button className={"cf" + (value.unread ? " on" : "")} data-filter="unread" aria-pressed={value.unread} title="Only chats with unread messages" onClick={() => set({ unread: !value.unread })}><span className="cfdot" /><span className="cft">Unread</span></button>
      {value.unread && <button className={"cf sub" + (value.unreadMuted ? " on" : "")} data-filter="unread-muted" aria-pressed={value.unreadMuted} title="Also show muted chats with unread messages" onClick={() => set({ unreadMuted: !value.unreadMuted })}><span className="cft">+ muted</span></button>}
      <span className="cfwrap">
        <button className={"cf" + (value.accounts.length ? " on" : "")} data-filter="messenger" aria-expanded={open === "messenger"} title="Filter by messenger" onClick={() => setOpen(open === "messenger" ? "" : "messenger")}>
          {value.accounts.length === 1 ? <ProviderIcon provider={accounts.find((a) => a.id === value.accounts[0])?.provider ?? ""} size={14} /> : <Layers size={14} />}
          <span className="cft">{value.accounts.length > 1 ? `${value.accounts.length} messengers` : value.accounts.length === 1 ? "1 messenger" : "Messenger"}</span><ChevronDown size={12} /></button>
        {open === "messenger" && <div className="popmenu cfmenu" data-menu="messenger">
          {accounts.map((a) => <button key={a.id} data-account={a.id} aria-pressed={value.accounts.includes(a.id)} onClick={() => toggleAcc(a.id)}><ProviderIcon provider={a.provider} size={16} /><span className="cfl">{a.label}{a.via && <small className="vianote" data-via={a.via.kind}> · {viaNote(a.via)}</small>}</span>{value.accounts.includes(a.id) && <Check size={14} />}</button>)}
          {!accounts.length && <small className="hint">No accounts</small>}</div>}
      </span>
      <span className="cfwrap">
        <button className={"cf" + (value.kind !== "all" ? " on" : "")} data-filter="kind" aria-expanded={open === "kind"} title={"Type: " + kind.label} onClick={() => setOpen(open === "kind" ? "" : "kind")}>
          <kind.Icon size={14} /><span className="cft">{value.kind === "all" ? "Type" : kind.label}</span><ChevronDown size={12} /></button>
        {open === "kind" && <div className="popmenu cfmenu" data-menu="kind">
          {KINDS.map(({ v, label, Icon }) => <button key={v} data-kind={v} aria-pressed={value.kind === v} onClick={() => { set({ kind: v }); setOpen(""); }}><Icon size={16} /><span className="cfl">{label}</span>{value.kind === v && <Check size={14} />}</button>)}</div>}
      </span>
      {hasPresence && <button className={"cf" + (value.online ? " on" : "")} data-filter="online" aria-pressed={value.online} title="Only personal chats whose contact is online" onClick={() => set({ online: !value.online })}><span className="cfdot green" /><span className="cft">Online</span></button>}
      {n > 0 && <button className="cf clear" data-filter="clear" title="Clear all filters" aria-label={`Clear ${n} active filter${n === 1 ? "" : "s"}`} onClick={() => onChange(NO_FILTERS)}><b className="cfbadge">{n}</b><X size={13} /></button>}
    </div>
  );
}

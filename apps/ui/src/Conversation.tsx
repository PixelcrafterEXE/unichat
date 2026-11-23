import { createPortal } from "react-dom";
import { Suspense, lazy, forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { viaNote } from "./relay";
import { capsOf, cardsOf, type Account, type Attachment, type Capabilities, type Card, type Chat, type Contact, type Location, type Message, type ProviderInfo, type SharedContact } from "./types";
import { measureMedia, isGif } from "./measure";
import { placeholderOf } from "../../../packages/core/src/placeholder";
import { hasMarkup } from "./markup";
import { withThreadLinks } from "./threadlinks";
import { RichText } from "./RichText";
import { copyText, downloadText, icsOf, vcardOf, Avatar, CustomEmoji, Linkified, ProviderIcon, QUICK, isCoarse, sq, useLongPress, Ticks, color, core, dayLabel, fmtBytes, fmtDateTime, fmtTime, kindOf, loadAttachment, toBase64, useAttachment, useNearView, type Settings } from "./util";
import { MoreHorizontal, Camera, Check, ChevronDown, Calendar, Clock3, Phone, ShoppingBag, List as ListIcon, CreditCard, ExternalLink, Users as UsersIcon, MousePointerClick, FileQuestion, BarChart3, CheckCircle2, Circle, CheckSquare, Square, Info, LogOut, MessageSquareWarning, RotateCcw, ArrowDown, AlertCircle, Ban, Copy, Download, FileText, Forward, ImageIcon, MapPin, Mic, Paperclip, Pencil, Play, Plus, Reply, SendHorizontal, Smile, SmilePlus, Trash2, User, X } from "./icons";
import { ReactorsModal, loadMembers, useNames } from "./Reactors";
import type { VoiceClip } from "./Voice";
const MessageInfoModal = lazy(() => import("./MessageInfo").then((m) => ({ default: m.MessageInfoModal })));
const VideoPlayer = lazy(() => import("./Video").then((m) => ({ default: m.VideoPlayer })));
const VoicePlayer = lazy(() => import("./Voice").then((m) => ({ default: m.VoicePlayer })));
const VoiceRecorder = lazy(() => import("./Voice").then((m) => ({ default: m.VoiceRecorder })));
import { EmojiPopover } from "./EmojiPicker";
import { Pin as PinIcon, PinOff as PinOffIcon, Timer, MessagesSquare } from "./icons";
import { ExpiryMark } from "./Disappearing";
import { PinnedBar, pinDurationLabel, usePins } from "./Pins";
import { loadingLine, type LoadSource } from "./loadsource";
import { ContactModal, EventModal, ScheduleModal, ForwardModal, Lightbox, LocationModal, PollModal } from "./Modals";

interface Props {
  chat: Chat; messages: Message[]; typing: string[]; caps?: Capabilities; settings: Settings; chats: Chat[];
  /** Merged chat only: the member chats (each one a real chat of one account) and what is needed to describe/choose them. */
  members?: Chat[]; providers: ProviderInfo[]; accounts: Account[];
  onRemove: (id: string) => void; onRequest: (accept: boolean) => void;
  onSignIn: (accountId?: string) => void; onPerson: (senderId: string, name: string) => void;
  hasMore: boolean; onLoadOlder: (limit?: number) => Promise<number | undefined>;
  jumpRef: { current: ((messageId: string, chatId?: string) => void) | undefined };
  unreadAtOpen: number; loaded: boolean; loadState?: { status: "loading" | "error"; since: number; error?: string }; /** where the messages come from while loading */ loadSource?: LoadSource; /** the chat was read from this device only (source offline / not answering) */ loadNote?: string; onRetry: () => void; onSent: (m: Message, replaces?: string) => void; onOpenChat: (id: string) => void; onInfo: () => void;
}
const NET_GAP = 15 * 60_000; // merged chats: show the messenger indicator again after this long a pause
const WIN_MIN = 300; // below this the whole timeline is rendered (no windowing)
/** Messengers whose history comes from a phone: only there "waiting for your phone" makes sense. */
const PHONE_LINKED = new Set(["whatsapp", "signal", "threema-md"]);

export interface RowCb {
  jump: (messageId: string, chatId?: string) => void; person: (senderId: string, name: string) => void; getMessages: () => Message[];
  reply: (m: Message) => void; edit: (m: Message) => void; forward: (m: Message) => void; react: (m: Message, e: string) => void; pin: (m: Message, pinned: boolean, durationSec?: number) => void;
  /** open the thread a message started / announces (Message.thread) */
  thread: (m: Message) => void;
  retry: (m: Message) => void; discard: (m: Message) => void; image: (i: { url: string; name?: string; video?: boolean }) => void; handle: (h: string, own: Chat) => void;
  /** multi-select (see SelectionBar): toggles this message and, from the first one, puts the timeline into selection mode */
  select: (m: Message) => void;
}
const sameChatBits = (a: Chat, b: Chat) => a === b || (a.id === b.id && a.name === b.name && a.kind === b.kind && a.provider === b.provider && a.accountId === b.accountId && a.avatarUrl === b.avatarUrl);
/** One timeline row. Re-renders only when ITS message (or what it shows from the chat) changed: an incoming message re-renders one row, not thousands. */
const MessageRow = memo(function MessageRow(p: { cb: RowCb; m: Message; grouped: boolean; chat: Chat; own: Chat; net?: { provider: string; name: string; account: string; title: string }; showNet?: boolean; caps?: Capabilities; settings: Settings; selected?: boolean; selMode?: boolean }) {
  const { cb, m } = p;
  return <MessageView onJump={cb.jump} onPerson={cb.person} m={m} grouped={p.grouped} chat={p.chat} own={p.own} net={p.net} showNet={p.showNet} caps={p.caps} settings={p.settings} getMessages={cb.getMessages}
    onReply={() => cb.reply(m)} onEdit={() => cb.edit(m)} onForward={() => cb.forward(m)} onReact={(e) => cb.react(m, e)} onPin={(pinned, d) => cb.pin(m, pinned, d)} onRetry={() => cb.retry(m)} onDiscard={() => cb.discard(m)}
    onImage={cb.image} onMessageHandle={(h) => cb.handle(h, p.own)} onThread={() => cb.thread(m)} selected={p.selected} selMode={p.selMode} onSelect={() => cb.select(m)} />;
}, (a, b) => a.m === b.m && a.grouped === b.grouped && a.caps === b.caps && a.settings === b.settings && a.cb === b.cb && a.net === b.net && a.showNet === b.showNet && a.selected === b.selected && a.selMode === b.selMode && sameChatBits(a.chat, b.chat) && sameChatBits(a.own, b.own));
interface Pending { id: number; blob: Blob; name: string; mime: string; kind: Attachment["kind"]; preview?: string }
const err = (e: any) => alert(e?.message ?? String(e));
/** Payloads of sends that failed, keyed by the local placeholder message id, so they can be retried. */
const newClientId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
/** A message shown the instant it is sent: it carries a local id until the backend answers with the real message (App reconciles them). */
const isPending = (m: Message) => m.id.startsWith("pend-");
const failedSends = new Map<string, { payload: any; error: string }>();

export default function Conversation(p: Props) {
  const { chat, messages, settings } = p;
  const [reply, setReply] = useState<Message>();
  const [editing, setEditing] = useState<Message>();
  const [forwarding, setForwarding] = useState<Message>(); const [fwdMany, setFwdMany] = useState(false);
  // multi-select: the keys of the picked messages (chat id + message id, because a merged chat can repeat native ids).
  // An empty set means the timeline is in its normal mode; the first pick turns every row into a checkbox.
  const [sel, setSel] = useState<ReadonlySet<string>>(new Set());
  const [lightbox, setLightbox] = useState<{ url: string; name?: string; video?: boolean }>();
  const [drag, setDrag] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const composerRef = useRef<ComposerApi>(null);
  const olderBusy = useRef(false), captureRef = useRef<() => void>(() => {});
  /** Page in earlier history and keep what the user looks at where it is (new rows appear above the viewport). */
  const loadOlder = async () => {
    const el = list.current; if (!el || olderBusy.current) return; olderBusy.current = true;
    const prev = el.scrollHeight, top0 = el.scrollTop; setLoadingOlder(true); nearBottom.current = false; captureRef.current();
    try { await p.onLoadOlder(); await new Promise((r) => setTimeout(r, 60)); if (nearBottom.current) return; /* jumped to the latest meanwhile */ if (!anchor.current || !offRef.current) el.scrollTop = top0 + (el.scrollHeight - prev); } catch (e) { err(e); } finally { setLoadingOlder(false); olderBusy.current = false; }
  };
  const hasMoreRef = useRef(p.hasMore); hasMoreRef.current = p.hasMore;
  const [note, setNote] = useState<string>();
  // The messenger says N messages were unread when you opened the chat; show how many of them we actually hold.
  const [gapDismissed, setGapDismissed] = useState(false);
  // The unread counter says more than we hold, but the provider can still page back: load older messages instead of warning (a few pages at most).
  const autoGap = useRef(0);
  useEffect(() => { autoGap.current = 0; }, [p.chat.id]);
  const [refreshing, setRefreshing] = useState(false);
  // ---- merged chat: every message belongs to a real member chat (its own account/provider); the composer sends "via" one member.
  const members = p.members, merged = !!members?.length;
  const capsFor = (c?: Chat) => (!c || c.offline ? undefined : capsOf(p.accounts.find((a) => a.id === c.accountId), p.providers, c.provider)); // the ACCOUNT's capabilities (they can differ per instance)
  const memberOf = (cid: string): Chat => members?.find((c) => c.id === cid) ?? chat;
  // Answers go out on the network of the newest message automatically; a manual pick holds only until the next message arrives.
  const [manual, setManual] = useState<{ via: string; after?: string }>();
  useEffect(() => setManual(undefined), [chat.id]);
  const validVia = (id?: string) => (id && members?.some((c) => c.id === id) ? id : undefined);
  const lastMsg = merged ? [...messages].reverse().find((m) => !m.system) : undefined, lastLoaded = lastMsg?.chatId;
  const chosen = manual && manual.after === lastMsg?.id ? manual.via : undefined;
  const via: Chat = merged ? memberOf((reply && validVia(reply.chatId)) || validVia(chosen) || validVia(lastLoaded) || validVia(chat.mergeLastVia) || validVia(chat.mergeSendVia) || members![0].id) : chat;
  const caps = merged ? capsFor(via) : p.caps;
  const capsOfMsg = (m: Message) => (merged ? capsFor(memberOf(m.chatId)) : caps);
  const canPin = merged ? !!members!.some((c) => capsFor(c)?.pinMessages) : !!p.caps?.pinMessages;
  const pins = usePins(chat.id, messages, canPin);
  const pickVia = (cid: string) => { setManual({ via: cid, after: lastMsg?.id }); setReply(undefined); core.call("setMergeVia", { mergeId: chat.id, chatId: cid }).catch(err); };
  const viaSelect = merged ? <ViaSelect members={members!} value={via.id} accounts={p.accounts} providers={p.providers} onPick={pickVia} /> : undefined;
  const incomingTail = (() => { let n = 0; for (let i = messages.length - 1; i >= 0; i--) { const m = messages[i]; if (m.fromMe) break; if (!m.system) n++; } return n; })();
  const missingUnread = Math.max(0, p.unreadAtOpen - incomingTail);
  useEffect(() => { if (!p.loaded || missingUnread <= 0 || !p.hasMore || autoGap.current >= 6) return; autoGap.current++; void p.onLoadOlder(100).catch(() => {}); }, [p.loaded, missingUnread, p.hasMore, messages.length]);
  /** Scroll to a message and flash it. If it is older than what is loaded, keep loading earlier history until it turns up. */
  const jumpUntil = useRef(0), offRef = useRef<Float64Array | null>(null), messagesRef = useRef<Message[]>([]);
  const jumpTo = async (id: string, chatId?: string) => {
    const find = () => list.current?.querySelector<HTMLElement>(chatId ? `[data-mkey="${CSS.escape(chatId + "|" + id)}"]` : `[data-mid="${CSS.escape(id)}"]`);
    let el = find(), guard = 0;
    const seek = async () => { // windowed list: bring the message into the DOM by scrolling to its estimated position
      const box = list.current, o = offRef.current; if (el || !box || !o) return;
      const idx = messagesRef.current.findIndex((x) => (chatId ? x.chatId === chatId && x.id === id : x.id === id)); if (idx < 0) return;
      nearBottom.current = false; jumpUntil.current = 0; anchor.current = null; box.scrollTop = Math.max(0, o[idx] - box.clientHeight / 2);
      for (let k = 0; k < 12 && !(el = find()); k++) await new Promise((r) => setTimeout(r, 50));
    };
    await seek();
    while (!el && hasMoreRef.current && guard++ < 40) {
      const n = await p.onLoadOlder(200).catch(() => 0); // big pages: a hit may be far back
      await new Promise((r) => setTimeout(r, 90)); el = find();
      if (!n) break;
    }
    if (!el) { setNote("The original message isn't available (it may be deleted or older than your history)."); setTimeout(() => setNote(undefined), 4000); return; }
    nearBottom.current = false; anchor.current = null; jumpUntil.current = Date.now() + 1200; // the smooth scroll starts near the bottom: don't let that re-pin the list
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.remove("hl"); void el.offsetWidth; el.classList.add("hl");
    setTimeout(() => el!.classList.remove("hl"), 2200);
  };

  /** Jump to the newest message. The windowed list only has estimated heights far from the viewport, so a smooth scroll to the end gets cancelled by
   *  re-layout / history paging: pin to the bottom first (the window then renders the tail) and scroll there instantly, again after the re-render. */
  const toLatest = () => {
    const box = list.current; if (!box) return;
    nearBottom.current = true; anchor.current = null; jumpUntil.current = 0; setAtBottom(true);
    box.scrollTop = box.scrollHeight;
    requestAnimationFrame(() => { nearBottom.current = true; box.scrollTop = box.scrollHeight; end.current?.scrollIntoView({ block: "end" }); });
  };
  useEffect(() => { if (nearBottom.current) end.current?.scrollIntoView({ block: "end" }); }, [messages.length, p.typing.length]);
  const inner = useRef<HTMLDivElement>(null);
  useEffect(() => { nearBottom.current = true; end.current?.scrollIntoView({ block: "end" }); }, [chat.id]);
  // Media, link cards and avatars finish loading AFTER the first scroll and push the bottom away: while the user hasn't scrolled up,
  // follow every size change of the message list (this is what made chats open "a little above the bottom").
  useEffect(() => {
    const el = inner.current, box = list.current; if (!el || !box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (nearBottom.current) box.scrollTop = box.scrollHeight; });
    ro.observe(el); return () => ro.disconnect();
  }, [chat.id]);

  // read receipts: tell the provider once the newest incoming message is visible
  const lastRead = useRef(new Map<string, string>()), localRead = useRef(new Map<string, string>());
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => { const f = () => setFocused(true), b = () => setFocused(false); addEventListener("focus", f); addEventListener("blur", b); return () => { removeEventListener("focus", f); removeEventListener("blur", b); }; }, []);
  useEffect(() => {
    // a merged chat marks every member read, each through its own provider and only where that provider allows it
    for (const o of merged ? members! : [chat]) {
      const c = merged ? capsFor(o) : caps;
      const last = [...messages].reverse().find((m) => !m.fromMe && (!merged || (m.chatId === o.id && !m.system)));
      if (last && last.id !== lastRead.current.get(o.id) && focused && (c?.markRead || (c?.readReceipts && settings.sendReadReceipts))) {
        lastRead.current.set(o.id, last.id); core.call("markRead", { chatId: o.id, messageId: last.id }).catch(() => {});
      }
      else if (last && focused && last.id !== localRead.current.get(o.id)) { // this network cannot be told (or receipts are off): remember the read position locally so the unread mark stays gone across reloads and on other devices
        localRead.current.set(o.id, last.id); core.call("markChatRead", { chatId: o.id, sendReceipts: false }).catch(() => {});
      }
    }
  }, [messages, chat.id, focused, settings.sendReadReceipts, caps, members]);

  const shown = useMemo(() => withThreadLinks(messages, (cid) => (members?.find((c) => c.id === cid) ?? chat).provider), [messages, members, chat]);
  // ---- windowed message list: past WIN_MIN messages only the ones near the viewport are in the DOM (heights are measured, unmeasured ones estimated)
  const win = shown.length > WIN_MIN;
  const anchorTop = useRef(0), idxRef = useRef(new Map<string, number>()), anchor = useRef<{ k: string; o: number } | null>(null), selfScroll = useRef(0);
  const hs = useRef(new Map<string, number>()), est = useRef({ sum: 0, n: 0 });
  const [vp, setVp] = useState({ top: 0, h: 800 }), [hver, bumpH] = useState(0);
  const keyOf = (m: Message) => (merged ? m.chatId + "|" + m.id : m.id);
  const estH = est.current.n ? Math.min(400, Math.max(30, est.current.sum / est.current.n)) : 48;
  const off = useMemo(() => {
    if (!win) return null; const o = new Float64Array(shown.length + 1), ix = new Map<string, number>();
    for (let i = 0; i < shown.length; i++) { const k = keyOf(shown[i]); ix.set(k, i); o[i + 1] = o[i] + (hs.current.get(k) ?? estH); }
    idxRef.current = ix; return o; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, shown, vp.h, hver, merged]);
  offRef.current = off; messagesRef.current = shown;
  let s0 = 0, e0 = shown.length;
  if (win && off) {
    const total = off[shown.length], hh = list.current?.clientHeight || vp.h; let cur = list.current ? list.current.scrollTop : vp.top;
    const an = anchor.current; if (an && !nearBottom.current && Date.now() >= jumpUntil.current) { const j = idxRef.current.get(an.k); if (j !== undefined) cur += off[j] - an.o; } // where the layout effect will put the viewport
    anchorTop.current = cur;
    const top = nearBottom.current ? Math.max(0, total - hh) : Math.max(0, Math.min(cur, total - hh)), over = 600;
    const lo = top - over, hi = top + hh + over; let a = 0, b = shown.length;
    while (a < b) { const mid = (a + b) >> 1; if (off[mid + 1] <= lo) a = mid + 1; else b = mid; } s0 = a; a = s0; b = shown.length;
    while (a < b) { const mid = (a + b) >> 1; if (off[mid] < hi) a = mid + 1; else b = mid; } e0 = Math.min(shown.length, a + 1);
  }
  /** Remember which row sits at the top of the viewport and how far below the edge: after any re-layout (measured heights, prepended history) put it back. */
  const capture = () => {
    const el = list.current, o = offRef.current; if (!el || !o || !win) return;
    let a = 0, b = shown.length; while (a < b) { const mid = (a + b) >> 1; if (o[mid + 1] <= el.scrollTop) a = mid + 1; else b = mid; }
    if (a < shown.length) anchor.current = { k: keyOf(shown[a]), o: o[a] };
  };
  captureRef.current = capture;
  useLayoutEffect(() => {
    const el = list.current, a = anchor.current; if (!win || !off || !el || !a || nearBottom.current || Date.now() < jumpUntil.current) return;
    const j = idxRef.current.get(a.k); if (j === undefined) return;
    const delta = off[j] - a.o; if (Math.abs(delta) > 0.5) { selfScroll.current = Date.now(); el.scrollTop = Math.max(0, el.scrollTop + delta); a.o = off[j]; }
  });
  // measure rendered rows (one observer): their real heights replace the estimates
  const roRef = useRef<ResizeObserver>(), seenEls = useRef(new WeakSet<Element>()), raf = useRef(0);
  useEffect(() => {
    if (!win || typeof ResizeObserver === "undefined") return;
    roRef.current ??= new ResizeObserver((es) => {
      let changed = false;
      for (const en of es) { const k = (en.target as HTMLElement).dataset.k; if (!k) continue; const h = Math.round(en.borderBoxSize?.[0]?.blockSize ?? (en.target as HTMLElement).offsetHeight), old = hs.current.get(k);
        if (old === undefined) { est.current.sum += h; est.current.n++; } else est.current.sum += h - old; if (old !== h) { hs.current.set(k, h); changed = true; } }
      if (changed && !raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; bumpH((x) => x + 1); });
    });
    inner.current?.querySelectorAll(":scope > [data-k]").forEach((el) => { if (!seenEls.current.has(el)) { seenEls.current.add(el); roRef.current!.observe(el); } });
  });
  useEffect(() => () => { roRef.current?.disconnect(); cancelAnimationFrame(raf.current); }, []);
  p.jumpRef.current = jumpTo; // lets the sidebar search jump to a message

  const react = (m: Message, emoji: string) => {
    const mine = m.reactions?.find((r: { mine?: boolean; emoji: string }) => r.mine)?.emoji === emoji; // same emoji again removes it
    core.call("react", { chatId: m.chatId, messageId: m.id, emoji: mine ? null : emoji }).catch(err);
  };
  const forward = async (to: Chat) => { const m = forwarding!; setForwarding(undefined); try { await core.call("forward", { message: m, toChatId: to.id }); p.onOpenChat(to.id); } catch (e) { err(e); } };
  // ---- multi-select actions (issue #81). The picked messages are always handled oldest first, whatever order they were ticked in.
  const selKey = (m: Message) => m.chatId + "|" + m.id;
  const picked = () => messages.filter((m) => sel.has(selKey(m))).sort((a, b) => a.time.localeCompare(b.time));
  const toggleSel = (m: Message) => setSel((cur) => { const next = new Set(cur); const k = selKey(m); next.has(k) ? next.delete(k) : next.add(k); return next; });
  const clearSel = () => setSel(new Set());
  const forwardMany = async (to: Chat) => {
    const list = picked(); setFwdMany(false);
    let ok = 0, failed = "";
    for (const m of list) { try { await core.call("forward", { message: m, toChatId: to.id }); ok++; } catch (e: any) { failed ||= e?.message ?? String(e); } }
    clearSel();
    if (ok === list.length) p.onOpenChat(to.id);  // all of them went: follow them to the chat, like a single forward does
    else { setNote(`Forwarded ${ok} of ${list.length} messages to ${to.name}. ${failed}`); setTimeout(() => setNote(undefined), 8000); }
  };
  const copySel = async () => {
    const list = picked(), dm = chat.kind === "dm";
    const text = list.map((m) => { const body = m.text || placeholderOf(m.text) || (m.attachments?.length ? "[Attachment]" : ""); return body && !dm ? `${m.fromMe ? "You" : m.sender || m.senderId}: ${body}` : body; }).filter(Boolean).join("\n");
    if (!text) return;
    try { await copyText(text); clearSel(); } catch { setNote("This browser did not allow copying."); setTimeout(() => setNote(undefined), 5000); }
  };
  const deleteSel = async () => {
    const list = picked().filter((m) => m.fromMe && !m.deleted);
    if (!list.length || !confirm(`Delete ${list.length} message${list.length === 1 ? "" : "s"} for everyone?`)) return;
    for (const m of list) { try { await core.call("delete", { chatId: m.chatId, messageId: m.id }); } catch (e) { err(e); break; } }
    clearSel();
  };
  const known: Contact[] = p.chats.filter((c) => c.kind === "dm").map((c) => ({ id: c.id, name: c.name }));

  // ---- stable callbacks for the memoised rows (members are always the latest closures)
  const cb = useRef({} as RowCb).current;
  Object.assign(cb, {
    jump: jumpTo, person: p.onPerson, getMessages: () => messages,
    reply: (m: Message) => { setReply(m); setEditing(undefined); composerRef.current?.focus(); },
    edit: (m: Message) => { setEditing(m); setReply(undefined); composerRef.current?.setText(m.text); composerRef.current?.focus(); },
    forward: (m: Message) => setForwarding(m), react,
    pin: (m: Message, pinned: boolean, durationSec?: number) => { core.call("pin", { chatId: m.chatId, messageId: m.id, pinned, ...(durationSec !== undefined ? { durationSec } : {}) }).catch(err); },
    retry: async (m: Message) => { const f = failedSends.get(m.id); if (!f) return; failedSends.delete(m.id); p.onRemove(m.id); await composerRef.current?.resend(f.payload); },
    discard: (m: Message) => { failedSends.delete(m.id); p.onRemove(m.id); }, image: setLightbox, select: toggleSel,
    handle: async (h: string, own: Chat) => { try { const c = await core.call("startChat", { accountId: own.accountId, handle: h }); p.onOpenChat(c.id); } catch (e) { err(e); } },
    thread: async (m: Message) => {
      if (!m.thread) return;
      const id = `${m.accountId ?? m.chatId.slice(0, m.chatId.indexOf(":"))}:${m.thread.id}`; // the thread is a chat of the same account
      if (!p.chats.some((c) => c.id === id)) { try { await core.call("openThread", { chatId: id }); } catch (e) { err(e); return; } } // e.g. an archived thread: the network is asked once, then it is listed
      p.onOpenChat(id);
    },
  } satisfies RowCb);
  const nets = useMemo(() => new Map((members ?? []).map((c) => [c.id, netOf(c, p.providers, p.accounts)])), [members, p.providers, p.accounts]);
  const renderMsg = (m: Message, i: number) => {
          const mkey = merged ? m.chatId + "|" + m.id : m.id; // native ids can repeat across member chats
          if (m.system) return <div key={mkey} data-k={mkey}><SystemRow m={m} onThread={m.thread ? () => cb.thread(m) : undefined} /></div>;
          const prev = shown[i - 1];
          const newDay = !prev || new Date(prev.time).toDateString() !== new Date(m.time).toDateString();
          // in a merged chat the other person has a different sender id on every network: a DM has only "me" and "them", and a switch of network starts a new group
          const sameSender = merged ? prev?.fromMe === m.fromMe && prev?.chatId === m.chatId : prev?.senderId === m.senderId;
          const grouped = !newDay && !prev.system && sameSender && !m.replyTo && +new Date(m.time) - +new Date(prev.time) < 5 * 60_000;
          const own = merged ? memberOf(m.chatId) : chat;
          // the messenger indicator marks the START of a run: after a day divider, a sender or network change, or a pause of 15 minutes or more
          const showNet = !!(merged && (!prev || prev.system || newDay || prev.chatId !== m.chatId || prev.fromMe !== m.fromMe || +new Date(m.time) - +new Date(prev.time) >= NET_GAP));
          return (
            <div key={mkey} data-k={mkey}>
              {newDay && <div className="daysep"><span>{dayLabel(m.time)}</span></div>}
              <MessageRow cb={cb} m={m} grouped={grouped} chat={chat} own={own} net={merged ? nets.get(own.id) : undefined} showNet={showNet} caps={capsOfMsg(m)} settings={settings} selMode={sel.size > 0} selected={sel.has(m.chatId + "|" + m.id)} />
            </div>
          );
  };
  return (
    <div className={"conv" + (drag ? " dragging" : "")}
      onDragOver={(e) => { if (caps?.attachments && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); composerRef.current?.addFiles(Array.from(e.dataTransfer.files)); }}>
      <PinnedBar pins={pins} canUnpin={canPin} onJump={(id, cid) => void jumpTo(id, merged ? cid : undefined)} />
      <div className={"messages" + (win ? " win" : "")} ref={list} data-count={messages.length} onScroll={() => {
        const el = list.current!; if (Date.now() < jumpUntil.current) return; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; setAtBottom(nearBottom.current);
        if (win) { if (Date.now() - selfScroll.current > 80) capture(); const top = Math.floor(el.scrollTop / 200) * 200, h = el.clientHeight; setVp((v) => (v.top === top && v.h === h ? v : { top, h })); if (el.scrollTop < 250 && hasMoreRef.current) void loadOlder(); }
      }}>
        <div className={"minner" + (win ? " win" : "")} ref={inner}>
        {p.hasMore && (
          <button className="loadmore" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? "Loading…" : "Load earlier messages"}</button>)}
        {note && <div className="searchnote warn" role="status">{note}</div>}
        {!p.loaded && p.loadState?.status === "error" && (
          <div className="loaderr" role="alert"><AlertCircle size={22} /><b>Couldn't load this chat</b><span>{p.loadState.error}</span><button className="secondary" onClick={p.onRetry}><RotateCcw size={14} /> Try again</button></div>)}
        {p.loadNote && <div className="searchnote warn loadnote" role="status" data-load-note>{p.loadNote}{p.loadSource?.kind !== "offline" && <button className="linkbtn" onClick={p.onRetry}><RotateCcw size={12} /> Retry</button>}</div>}
        {!p.loaded && p.loadState?.status !== "error" && <LoadingMessages since={p.loadState?.since ?? Date.now()} source={p.loadSource} />}
        {p.loaded && !shown.length && <div className="placeholder small">No messages yet</div>}
        {win && s0 > 0 && <div aria-hidden className="vgap" style={{ height: off![s0] }} />}
        {(win ? shown.slice(s0, e0) : shown).map((m, k) => renderMsg(m, (win ? s0 : 0) + k))}
        {win && e0 < shown.length && <div aria-hidden className="vgap" style={{ height: off![shown.length] - off![e0] }} />}
        {p.loaded && p.loadState?.status === "loading" && shown.length > 0 && ( /* saved messages are on screen; the messenger's own answer is still coming */
          <div className="refreshing" role="status" aria-label="Checking for newer messages" data-refreshing title={loadingLine(p.loadSource, 0)}><span className="spinner" aria-hidden /></div>)}
        {p.typing.length > 0 && (() => {
          const nameOf = (id: string) => messages.find((m) => m.senderId === id && !m.fromMe)?.sender || (chat.kind === "dm" ? chat.name : "");
          const names = p.typing.map(nameOf).filter(Boolean);
          const who = chat.kind === "dm" ? chat.name : names.length ? (names.length > 2 ? `${names[0]}, ${names[1]} and others are` : names.length === 2 ? `${names[0]} and ${names[1]} are` : `${names[0]} is`) : "Someone is";
          return <div className="typing"><span className="dots"><i /><i /><i /></span> {chat.kind === "dm" ? `${who} is` : who} typing</div>;
        })()}
        {p.loaded && missingUnread > 0 && !gapDismissed && !p.hasMore && ( /* only once all earlier history is loaded: until then the app simply loads more (see the effect above) */
          <div className="gapnote" role="status"><Info size={15} /><span>{missingUnread} unread message{missingUnread === 1 ? "" : "s"} couldn't be loaded here. {chat.provider === "mesh" ? "" : PHONE_LINKED.has(chat.provider) ? "They may still be waiting for your phone to deliver them, or be older than the history this app received. Open the messenger on your phone to read them." : "The unread counter says more than this app has (older than the history it received, or already read elsewhere)."}</span>
            {caps?.refreshChat && <button className="secondary" disabled={refreshing} onClick={async () => { setRefreshing(true); try { const r = await core.call("refreshChat", { chatId: via.id }); setNote(r?.message ?? "Asked again."); setTimeout(() => setNote(undefined), 6000); } catch (e: any) { setNote(e.message); } finally { setRefreshing(false); } }}>{refreshing ? "Asking…" : "Ask the phone again"}</button>}
            <button className="icon" onClick={() => setGapDismissed(true)} aria-label="Dismiss"><X size={14} /></button></div>)}
        <div ref={end} />
        </div>
      </div>
      {!atBottom && <button className="tolatest" title="Jump to latest" onClick={toLatest}><ArrowDown size={18} /></button>}
      {drag && <div className="dropzone">Drop files to send</div>}

      {via.request && !via.offline && (
        <div className="reqbanner" role="region" aria-label="Message request"><MessageSquareWarning size={20} />
          <span><b>Message request</b><small>{chat.name} wrote to you first. Accept to keep the conversation, or decline to remove it. Replying also accepts.</small></span>
          {caps?.requests && <><button className="primary inline" onClick={() => p.onRequest(true)}>Accept</button><button className="secondary" onClick={() => p.onRequest(false)}>Decline</button></>}
        </div>)}
      {sel.size > 0 && (() => {
        const list = picked();
        const canCopy = list.some((m) => m.text || m.attachments?.length);
        const canDelete = !!caps?.deletes && list.length > 0 && list.every((m) => m.fromMe && !m.deleted);
        return (
          <div className="selbar msgselbar" role="toolbar" aria-label="Selected messages" data-sel={sel.size}>
            <b>{sel.size} message{sel.size === 1 ? "" : "s"} selected</b>
            <button data-act="msgsel-forward" onClick={() => setFwdMany(true)}><Forward size={14} /> Forward</button>
            {canCopy && <button data-act="msgsel-copy" onClick={() => void copySel()}><Copy size={14} /> Copy</button>}
            {canDelete && <button data-act="msgsel-delete" onClick={() => void deleteSel()}><Trash2 size={14} /> Delete</button>}
            <button className="icon" data-act="msgsel-clear" aria-label="Clear the selection" onClick={clearSel}><X size={16} /></button>
          </div>);
      })()}
      <ScheduledNote ids={[chat.id, ...(members?.map((c) => c.id) ?? [])]} />
      <Composer ref={composerRef} viaInfo={p.accounts.find((a) => a.id === via.accountId)?.via} onSignIn={() => p.onSignIn(via.accountId)} chat={chat} target={via} viaSelect={viaSelect} caps={caps} settings={settings} reply={reply} editing={editing} known={known}
        onCancel={() => { setReply(undefined); setEditing(undefined); }} onSent={(m, r) => { setReply(undefined); setEditing(undefined); p.onSent(m, r); }} />

      {forwarding && <ForwardModal chats={p.chats} onPick={forward} onClose={() => setForwarding(undefined)} />}
      {fwdMany && <ForwardModal chats={p.chats} onPick={forwardMany} onClose={() => setFwdMany(false)} />}
      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(undefined)} />}
    </div>
  );
}
const drafts = new Map<string, string>(); // unsent text survives switching chats
const draftMentions = new Map<string, Map<string, string>>(); // chat id -> (member id -> name) picked from the @ autocomplete in the unsent text
/** Structured mentions for `text`: every `@Name` of a picked member (word-bounded, longest name first, no overlaps) with its offsets. */
export function mentionsIn(text: string, picked: Map<string, string>): { id: string; name: string; start: number; length: number }[] {
  const out: { id: string; name: string; start: number; length: number }[] = [];
  for (const [id, name] of [...picked].sort((a, b) => b[1].length - a[1].length)) {
    const tok = "@" + name; let i = text.indexOf(tok);
    while (i >= 0) {
      const before = i === 0 || /[\s([{]/.test(text[i - 1]), after = i + tok.length >= text.length || !/[\p{L}\p{N}_]/u.test(text[i + tok.length]);
      if (before && after && !out.some((o) => i < o.start + o.length && o.start < i + tok.length)) out.push({ id, name, start: i, length: tok.length });
      i = text.indexOf(tok, i + tok.length);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
/** Scheduled messages of this chat that are waiting for another device, or were too late: said once, above the composer. */
function ScheduledNote({ ids }: { ids: string[] }) {
  const [jobs, setJobs] = useState<{ id: string; status: string; lastError?: string; payload: { chatId?: string; waiting?: boolean; late?: boolean; aborted?: boolean; queued?: boolean } }[]>([]);
  const key = ids.join("|");
  useEffect(() => {
    let dead = false; const load = () => core.call("jobs").then((j: any[]) => { if (!dead) setJobs((j ?? []).filter((x) => x.kind === "send" && ids.includes(x.payload?.chatId) && ((x.status === "pending" && x.payload.waiting) || (x.status === "failed" && (x.payload.late || x.payload.aborted))))); }, () => {});
    load(); const off = core.on((ev: string) => { if (ev === "job") load(); }); const t = setInterval(load, 10_000); return () => { dead = true; off(); clearInterval(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!jobs.length) return null;
  const w = jobs.filter((j) => j.status === "pending"), f = jobs.length - w.length;
  // a queued message (sent while the device that sends for this account was offline) is named as such, not as a scheduled one
  const what = (n: number, queued: boolean) => queued ? (n === 1 ? "Message waiting to send" : `${n} messages waiting to send`) : n === 1 ? "Scheduled message" : `${n} scheduled messages`;
  return <div className="schednote" data-sched-note role="status"><Clock3 size={14} /> {w.length > 0 && <span>{what(w.length, w.every((j) => j.payload.queued))}: {w[0].lastError ?? "it goes as soon as it can."}</span>}
    {f > 0 && <span> {f === 1 ? "1 message was" : `${f} messages were`} not sent. See Settings, Scheduled messages.</span>}</div>;
}
interface ComposerApi { focus(): void; setText(t: string): void; addFiles(f: File[]): void; resend(payload: object): Promise<void> }

const Composer = forwardRef<ComposerApi, { viaInfo?: Account["via"]; onSignIn: () => void; chat: Chat; /** the real chat a send goes to (= chat, or the selected "send via" member of a merged chat) */ target: Chat; viaSelect?: React.ReactNode; caps?: Capabilities; settings: Settings; reply?: Message; editing?: Message; known: Contact[]; onCancel: () => void; onSent: (m: Message, replaces?: string) => void }>(
function Composer({ chat, target, viaSelect, caps, settings, reply, editing, known, onCancel, onSent, onSignIn, viaInfo }, ref) {
  const [asked, setAsked] = useState("");
  const [text, setTextRaw] = useState(() => drafts.get(chat.id) ?? "");
  const setText = (v: string | ((t: string) => string)) => setTextRaw((t) => { const n = typeof v === "function" ? v(t) : v; n ? drafts.set(chat.id, n) : drafts.delete(chat.id); return n; });
  const [pending, setPending] = useState<Pending[]>([]);
  const [menu, setMenu] = useState(false);
  const [emoji, setEmoji] = useState(false);
  /** emoji from the picker go in at the caret; the focus stays in the picker (more emojis, keyboard), Escape returns it to the textarea */
  const insertEmoji = (e: string) => {
    const t = ta.current, s0 = t?.selectionStart ?? 0, e0 = t?.selectionEnd ?? s0;
    setText((v) => { const s = t ? Math.min(s0, v.length) : v.length, en = t ? Math.min(e0, v.length) : v.length; return v.slice(0, s) + e + v.slice(en); });
    requestAnimationFrame(() => { if (!t) return; const at = (t ? s0 : 0) + e.length; try { t.setSelectionRange(at, at); } catch { /* not focusable */ } });
  };
  const toolsRef = useDismiss(menu, () => { setMenu(false); setEmoji(false); });
  const [modal, setModal] = useState<"loc" | "contact" | "poll" | "event" | "schedule">();
  const [rec, setRec] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  /** Opens the file input in the given mode. `capture` hands it to the system camera (Android/iOS); it must be cleared again, or picking a file later would open the camera too. */
  const pickFiles = (accept: string, capture?: string) => { const f = fileIn.current!; f.accept = accept; capture ? f.setAttribute("capture", capture) : f.removeAttribute("capture"); f.click(); setMenu(false); };
  // "Take a photo" only where there is a camera to take it with: the Android app and phones/tablets in the browser.
  const hasCamera = typeof window !== "undefined" && (!!(window as any).UnimsgNative || isCoarse());
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const nextId = useRef(0);
  const disabled = target.readOnly;
  // @mention autocomplete: only in groups/channels of providers whose capabilities say they can take structured mentions
  const canMention = !!caps?.mentions && target.kind !== "dm" && target.provider !== "mesh";
  const [mq, setMq] = useState<{ at: number; query: string }>(); const [mIdx, setMIdx] = useState(0); const [mMembers, setMMembers] = useState<Contact[]>([]);
  const picked = () => { let m = draftMentions.get(chat.id); if (!m) { m = new Map(); draftMentions.set(chat.id, m); } return m; };
  useEffect(() => { setMq(undefined); }, [target.id]);
  useEffect(() => { if (canMention && mq) { let live = true; loadMembers(target.id).then((l) => live && setMMembers(l)); return () => { live = false; }; } }, [canMention, mq !== undefined, target.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const mItems = !mq ? [] : mMembers.filter((c) => { const q = mq.query.toLowerCase(); return !q || c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || c.name.toLowerCase().startsWith(q) || (c.handle ?? "").toLowerCase().replace(/^@/, "").startsWith(q); }).slice(0, 8);
  const trackMention = (v: string, caret: number) => {
    if (!canMention) return;
    const m = /(^|\s)@([^\s@]{0,32})$/.exec(v.slice(0, caret));
    if (m) { setMq({ at: caret - m[2].length - 1, query: m[2] }); setMIdx(0); } else setMq(undefined);
  };
  const insertMention = (c: Contact) => {
    if (!mq) return; const t = ta.current; const caret = t?.selectionStart ?? text.length;
    const ins = "@" + c.name + " "; picked().set(c.id, c.name);
    setText(text.slice(0, mq.at) + ins + text.slice(caret)); setMq(undefined);
    requestAnimationFrame(() => { if (t) { t.focus(); const p = mq.at + ins.length; t.setSelectionRange(p, p); } });
  };

  const addFiles = (files: File[]) => {
    if (!caps?.attachments) return;
    setPending((p) => [...p, ...files.map((f) => ({ id: nextId.current++, blob: f, name: f.name, mime: f.type || "application/octet-stream", kind: kindOf(f.type),
      preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined }))]);
  };
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), setText, addFiles, resend: (pl: object) => sendRaw(pl) }));

  useEffect(() => { const t = ta.current; if (t) { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; } }, [text]);

  const sendRaw = async (payload: object) => {
    // clientId: one id per message; a Retry sends the SAME payload, so a send through another device happens once even if the first answer was lost
    const full = { chatId: target.id, replyToMessageId: reply?.id, clientId: newClientId(), ...payload } as any;
    // show it right away (pending); the real message replaces it when the backend answers (App matches by chat + text, or by this id)
    const pid = "pend-" + full.clientId;
    onSent({ id: pid, chatId: target.id, sender: "You", senderId: "me", fromMe: true, status: "sending", time: new Date().toISOString(), text: full.text ?? "", location: full.location, contacts: full.contacts,
      replyTo: reply && reply.id === full.replyToMessageId ? { messageId: reply.id, sender: reply.sender, textPreview: reply.text.slice(0, 80) || "Attachment" } : undefined,
      attachments: full.attachments?.map((a: any, i: number) => ({ id: "l" + i, kind: a.kind, mime: a.mime, name: a.name, durationMs: a.durationMs, thumbnailDataUrl: a.kind === "image" && a.dataBase64 ? `data:${a.mime};base64,${a.dataBase64}` : undefined })) });
    try { onSent(await core.call("send", full), pid); }
    catch (e: any) { // keep a failed placeholder in the timeline with Retry / Discard
      const id = "local-" + Date.now() + Math.random().toString(36).slice(2, 6);
      failedSends.set(id, { payload: full, error: e?.message ?? String(e) });
      onSent({ id, chatId: target.id, sender: "You", senderId: "me", fromMe: true, status: "failed", time: new Date().toISOString(), text: full.text ?? "", location: full.location, contacts: full.contacts,
        attachments: full.attachments?.map((a: any, i: number) => ({ id: "l" + i, kind: a.kind, mime: a.mime, name: a.name })) }, pid);
    }
  };

  const submit = async () => {
    if (editing) {
      const t = text.trim(); if (!t) return;
      try { await core.call("edit", { chatId: editing.chatId, messageId: editing.id, text: t }); setText(""); onCancel(); } catch (e) { err(e); }
      return;
    }
    const t = text.trim(); if (!t && !pending.length) return;
    const mentions = canMention ? mentionsIn(t, picked()) : [];
    draftMentions.delete(chat.id); setMq(undefined);
    const atts = await Promise.all(pending.map(async (f) => ({ kind: f.kind, mime: f.mime, name: f.name, dataBase64: await toBase64(f.blob), ...(await measureMedia(f.blob, f.kind)), ...(isGif(f.mime, f.name) ? { gif: true } : {}) })));
    setText(""); setPending([]);
    if (typingTimer.current) { clearTimeout(typingTimer.current); typingTimer.current = undefined; core.call("setTyping", { chatId: target.id, typing: false }).catch(() => {}); }
    await sendRaw({ text: t, attachments: atts.length ? atts : undefined, ...(mentions.length ? { mentions } : {}) });
  };

  const onChange = (v: string, caret?: number) => {
    setText(v); trackMention(v, caret ?? v.length);
    if (caps?.typing && settings.sendTyping && chat.provider !== "mesh") {
      if (!typingTimer.current) core.call("setTyping", { chatId: target.id, typing: true }).catch(() => {});
      clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => { typingTimer.current = undefined; core.call("setTyping", { chatId: target.id, typing: false }).catch(() => {}); }, 4000);
    }
  };

  const sendVoice = async (c: VoiceClip) => {
    await sendRaw({ text: "", attachments: [{ kind: "voice", mime: c.mime, name: c.name, dataBase64: await toBase64(c.blob), durationMs: c.durationMs, waveform: c.waveform }] });
    setRec(false);
  };

  // an account whose login lives on another of the user's devices: say so, and only offer what can work
  if (viaInfo && viaInfo.kind !== "relay") return <>{viaSelect}<div className="composer ro offline" data-via-ro={viaInfo.kind}><LogOut size={16} /> {viaNote(viaInfo)}
    {viaInfo.kind === "ask" && <button className="primary inline" data-act="ask-allow" style={{ marginTop: 0 }} onClick={async () => { try { const r = await core.call("syncRelayAsk", { accountId: target.accountId }); setAsked(r.state === "pending" ? `Asked ${viaInfo.device}. It shows a question there.` : ""); } catch (e: any) { setAsked(e.message); } }}>Ask {viaInfo.device}</button>}
    {asked && <small data-asked>{asked}</small>}</div></>;
  if (target.offline) return <>{viaSelect}<div className="composer ro offline"><LogOut size={16} /> {target.offline === "signed-out" ? "You are signed out of this account. This chat is a read-only archive." : "This device was unlinked. This chat is a read-only archive."}<button className="primary inline" style={{ marginTop: 0 }} onClick={onSignIn}>Sign in again</button></div></>;
  if (target.blocked) return <>{viaSelect}<div className="composer ro">You blocked this contact. <button className="secondary" onClick={() => core.call("blockChat", { chatId: target.id, blocked: false }).catch(err)}>Unblock</button></div></>;
  if (disabled) return <>{viaSelect}<div className="composer ro">This channel is read-only</div></>;
  return (
    <>
      {viaSelect}
      {(reply || editing) && (
        <div className="replybar">{editing ? <><Pencil size={14} /> Editing message</> : <><Reply size={14} /> Replying to <b>{reply!.sender || "message"}</b>: {reply!.text.slice(0, 80) || "attachment"}</>}
          <button className="icon" onClick={() => { onCancel(); if (editing) setText(""); }}><X size={16} /></button></div>)}
      {!!pending.length && (
        <div className="pendingbar">{pending.map((f) => (
          <div key={f.id} className="pend">{f.preview ? <img src={f.preview} alt="" /> : <FileText size={22} />}<span className="pn">{f.name}</span>
            <button className="icon" onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}><X size={14} /></button></div>))}</div>)}
      {rec ? (
        <Suspense fallback={<div className="composer ro"><span className="spinner" /></div>}><VoiceRecorder onCancel={() => setRec(false)} onSend={sendVoice} /></Suspense>
      ) : (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {viaInfo?.kind === "relay" && <span className="viahint" data-via-hint title={`Sends through ${viaInfo.device}`}>via {viaInfo.device}</span>}
          <div className="tools" ref={toolsRef}>
            <button type="button" className="icon big" title="Attach" onClick={() => { setMenu(!menu); setEmoji(false); }}><Plus size={20} /></button>
            {menu && (
              <div className="popmenu">
                {caps?.attachments && hasCamera && <button type="button" id="att-camera" onClick={() => pickFiles("image/*", "environment")}><Camera size={16} /> Take a photo</button>}
                {caps?.attachments && <button type="button" id="att-media" onClick={() => pickFiles("image/*,video/*")}><ImageIcon size={16} /> Photo / video</button>}
                {caps?.attachments && <button type="button" id="att-file" onClick={() => pickFiles("")}><Paperclip size={16} /> File</button>}
                {caps?.location && <button type="button" onClick={() => { setModal("loc"); setMenu(false); }}><MapPin size={16} /> Location</button>}
                {caps?.contactCards && <button type="button" onClick={() => { setModal("contact"); setMenu(false); }}><User size={16} /> Contact</button>}
                {caps?.polls && <button type="button" onClick={() => { setModal("poll"); setMenu(false); }}><BarChart3 size={16} /> Poll</button>}
                {text.trim() && chat.provider !== "mesh" && !editing && <button type="button" onClick={() => { setModal("schedule"); setMenu(false); }}><Clock3 size={16} /> Schedule send…</button>}
                {caps?.events && <button type="button" onClick={() => { setModal("event"); setMenu(false); }}><Calendar size={16} /> Event</button>}
                {!caps?.attachments && !caps?.location && !caps?.contactCards && !caps?.polls && !caps?.events && <span className="hint pad">Nothing to attach for this chat</span>}
              </div>)}
            <input ref={fileIn} type="file" multiple hidden onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          </div>
          {mq && mItems.length > 0 && (
            <div className="mentionpop" role="listbox" aria-label="Mention someone">
              {mItems.map((c, i) => (
                <button type="button" key={c.id} role="option" aria-selected={i === mIdx} className={i === mIdx ? "on" : ""} data-mention={c.name}
                  onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setMIdx(i)} onClick={() => insertMention(c)}>
                  <Avatar name={c.name} size={24} of={{ kind: "contact", id: `${target.accountId}:${c.id}` }} /><b>{c.name}</b>{c.handle && <small>{c.handle}</small>}
                </button>))}
            </div>)}
          <textarea ref={ta} rows={1} value={text} placeholder={editing ? "Edit message" : `Message ${chat.kind === "channel" ? "#" : ""}${chat.name}`}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)} onBlur={() => setTimeout(() => setMq(undefined), 120)}
            onPaste={(e) => { const f = Array.from(e.clipboardData.files); if (f.length) { e.preventDefault(); addFiles(f); } }}
            onKeyDown={(e) => {
              if (mq && mItems.length) { // the autocomplete owns these keys while it is open
                if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMIdx((i) => (i + (e.key === "ArrowDown" ? 1 : mItems.length - 1)) % mItems.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertMention(mItems[Math.min(mIdx, mItems.length - 1)]); return; }
              }
              if (mq && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMq(undefined); return; }
              if (e.key === "Enter" && !e.shiftKey && settings.enterToSend) { e.preventDefault(); submit(); }
              if (e.key === "Escape") { onCancel(); if (editing) setText(""); }
            }} />
          <div className="tools">
            <button type="button" className="icon big" title="Emoji" onClick={() => { setEmoji(!emoji); setMenu(false); }}><Smile size={20} /></button>
            {emoji && <EmojiPopover keepOpen onClose={() => setEmoji(false)} onEscape={() => ta.current?.focus({ preventScroll: true })} onPick={insertEmoji} />}
          </div>
          {!text.trim() && !pending.length && !editing && caps?.voiceNotes && caps.attachments
            ? <button type="button" className="icon big" title="Record voice message" onClick={() => setRec(true)}><Mic size={20} /></button>
            : <button className="sendbtn" title="Send"><SendHorizontal size={18} /></button>}
        </form>)}
      {modal === "loc" && <LocationModal onClose={() => setModal(undefined)} onSend={(l: Location) => { setModal(undefined); sendRaw({ text: "", location: l }); }} />}
      {modal === "schedule" && <ScheduleModal preview={text.trim()} onClose={() => setModal(undefined)} onSchedule={async (at) => { await core.call("scheduleMessage", { chatId: target.id, text: text.trim(), at }); setText(""); }} />}
      {modal === "event" && <EventModal onClose={() => setModal(undefined)} onSave={async (event) => { await sendRaw({ text: "", event }); }} />}
      {modal === "poll" && <PollModal onClose={() => setModal(undefined)} onSend={(poll) => { setModal(undefined); sendRaw({ text: "", poll }); }} />}
      {modal === "contact" && <ContactModal known={known} onClose={() => setModal(undefined)} onSend={(c: SharedContact[]) => { setModal(undefined); sendRaw({ text: "", contacts: c }); }} />}
    </>
  );
});

const chat0Group = (c: Chat) => c.kind !== "dm";
/** Which network/account a member chat of a merged chat lives on: the provider, its display name and the account label. */
function netOf(c: Chat, providers: ProviderInfo[], accounts: Account[]) {
  const name = providers.find((x) => x.name === c.provider)?.displayName ?? c.provider, acc = accounts.find((a) => a.id === c.accountId)?.label ?? c.accountId;
  return { provider: c.provider, name, account: acc, title: `${name} · ${acc}` };
}

/** Close a popup on a click outside of `ref` or on Escape (never on mouse movement: that made popups vanish before they could be clicked). */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("mousedown", down); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

/** "Send via" selector of a merged chat: which member (network + account) the next message goes through. */
function ViaSelect({ members, value, accounts, providers, onPick }: { members: Chat[]; value: string; accounts: Account[]; providers: ProviderInfo[]; onPick: (chatId: string) => void }) {
  const [open, setOpen] = useState(false);
  const dismissRef = useDismiss(open, () => setOpen(false));
  const cur = members.find((c) => c.id === value) ?? members[0], n = netOf(cur, providers, accounts);
  return (
    <div className="viabar" ref={dismissRef}>
      <span className="vlabel">Send via</span>
      <button type="button" className={"viabtn" + (cur.offline ? " off" : "")} aria-haspopup="listbox" aria-expanded={open} title={`Messages you write go out through ${n.title}`} onClick={() => setOpen(!open)}>
        <ProviderIcon provider={cur.provider} size={16} /><b>{n.name}</b><span className="vacc">{n.account}</span>{cur.offline && <LogOut size={12} />}<ChevronDown size={14} />
      </button>
      {open && (
        <div className="popmenu viamenu" role="listbox">
          {members.map((c) => { const x = netOf(c, providers, accounts); return (
            <button key={c.id} type="button" role="option" aria-selected={c.id === cur.id} className={c.id === cur.id ? "on" : ""} onClick={() => { setOpen(false); onPick(c.id); }}>
              <ProviderIcon provider={c.provider} size={18} /><span className="vtxt"><b>{x.name}</b><small>{x.account}{c.offline ? " · signed out (read-only)" : ""}</small></span>{c.id === cur.id && <Check size={14} />}
            </button>); })}
        </div>)}
    </div>);
}

function MessageView(p: {
  onJump: (messageId: string, chatId?: string) => void;
  onPerson: (senderId: string, name: string) => void;
  /** the real chat this message belongs to (= chat, except in a merged chat) and, there only, its network */
  own: Chat; net?: { provider: string; name: string; account: string; title: string }; showNet?: boolean;
  m: Message; grouped: boolean; chat: Chat; caps?: Capabilities; settings: Settings; getMessages: () => Message[];
  onRetry: () => void; onDiscard: () => void;
  onReply: () => void; onEdit: () => void; onForward: () => void; onReact: (e: string) => void; onPin: (pinned: boolean, durationSec?: number) => void; onImage: (i: { url: string; name?: string; video?: boolean }) => void;
  selected?: boolean; selMode?: boolean; onSelect: () => void; onMessageHandle: (h: string) => void; onThread: () => void;
}) {
  const { m, chat, caps } = p;
  const [picker, setPicker] = useState(false);
  const [fullPicker, setFullPicker] = useState(false); // the complete emoji picker ("+ more" / the chip's add button)
  const pickTimer = useRef<ReturnType<typeof setTimeout>>();
  const [reactors, setReactors] = useState(false); const [hovered, setHovered] = useState(false); const [info, setInfo] = useState(false);
  const nameOf = useNames(p.chat, p.getMessages, hovered && chat0Group(p.chat));
  const reactorTitle = (r: { emoji: string; senderIds: string[]; mine?: boolean; count?: number }) =>
    (chat0Group(p.chat) && r.senderIds.length ? r.senderIds.map((id) => (r.mine && p.getMessages().some((x) => x.fromMe && x.senderId === id) ? "You" : nameOf(id))).join(", ") + (r.count && r.count > r.senderIds.length ? ` and ${r.count - r.senderIds.length} others` : "") + " · " : r.count && r.count > r.senderIds.length ? `${r.count} people · ` : "") + (r.mine ? "Click to remove your reaction · " : "") + "Right-click: who reacted";
  const pend = isPending(m); // sent a moment ago, the backend has not answered yet
  // not on the network (pending, queued or failed): it has no id there, so reply / react / edit / delete cannot refer to it (the menu offers Retry / Discard)
  const unsent = pend || m.id.startsWith("local-");
  const [menu, setMenu] = useState<{ x: number; y: number; sel: string }>();
  const lastLong = useRef(0); // touch: a long press opens the same menu as a right click (the browser's own contextmenu event that follows is ignored)
  const lp = useLongPress((x, y) => { lastLong.current = Date.now(); setMenu({ x, y, sel: "" }); });
  // Touch: drag a message to the right to reply to it. `swipe.on` is decided on the first moves -- false as soon as the
  // gesture is more vertical than horizontal, so the timeline keeps scrolling normally (CSS touch-action: pan-y does the rest).
  const canSwipeReply = !!caps?.replies && !m.deleted && !unsent && !p.selMode;
  const swipe = useRef({ x: 0, y: 0, on: undefined as boolean | undefined, armed: false });
  const [slide, setSlide] = useState(0);
  const SWIPE_FIRE = 56, SWIPE_MAX = 80;
  const swipeHandlers = {
    onTouchStart: (e: React.TouchEvent) => { const t = e.touches[0]!; swipe.current = { x: t.clientX, y: t.clientY, on: undefined, armed: false }; },
    onTouchMove: (e: React.TouchEvent) => {
      if (!canSwipeReply || e.touches.length > 1) { swipe.current.on = false; if (slide) setSlide(0); return; }
      const t = e.touches[0]!, dx = t.clientX - swipe.current.x, dy = t.clientY - swipe.current.y;
      if (swipe.current.on === undefined) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; swipe.current.on = dx > 0 && Math.abs(dx) > Math.abs(dy); }
      if (!swipe.current.on) return;
      const d = Math.max(0, Math.min(SWIPE_MAX, dx - 8));
      if (d >= SWIPE_FIRE && !swipe.current.armed) { swipe.current.armed = true; try { navigator.vibrate?.(12); } catch { /* not allowed */ } } // past the point: one tick, like the phone apps
      if (d < SWIPE_FIRE) swipe.current.armed = false;
      setSlide(d);
    },
    onTouchEnd: () => { const fire = swipe.current.on && swipe.current.armed; swipe.current.on = false; setSlide(0); if (fire) p.onReply(); },
    onTouchCancel: () => { swipe.current.on = false; setSlide(0); },
  };
  const del = () => { if (confirm("Delete this message for everyone?")) core.call("delete", { chatId: m.chatId, messageId: m.id }).catch(err); };
  // Android only: hand the message to the system share sheet. An attachment has to travel as bytes, because the archive is
  // encrypted and no other app can read it; the native side writes the copy and shares it as a content:// URI (issue #82).
  const canShare = !!(window as any).UnimsgNative && !m.deleted && (!!m.text || !!m.attachments?.length);
  const share = async () => {
    try {
      const a = m.attachments?.[0];
      const payload = a
        ? { text: m.text || "", file: { ...(await core.call("attachment", { chatId: m.chatId, messageId: m.id, attachmentId: a.id })), name: a.name || `attachment.${(a.mime.split("/")[1] ?? "bin").replace(/[^a-z0-9]/gi, "")}` } }
        : { text: m.text };
      const r = await core.call("$share", payload);
      if (r && r.started === false) err(new Error(r.error ?? "Sharing did not start."));
    } catch (e) { err(e); }
  };
  const badge = p.net && p.showNet && <span className="netbadge" title={p.net.title}><ProviderIcon provider={p.net.provider} size={14} title={p.net.title} /></span>;
  const name = m.fromMe ? "You" : chat.kind === "dm" ? chat.name : m.sender || m.senderId; // your alias wins in 1:1 chats
  // "[Photo]"-style stand-in text: hidden when the real media is there, a proper "not available" card when it is not
  const cards = cardsOf(m), atts = m.attachments ?? [];
  const hasRich = !!atts.length || !!cards.length || !!m.location || !!m.poll || !!m.contacts?.length;
  const ph = m.deleted ? undefined : placeholderOf(m.text), missing = ph && !hasRich ? ph : undefined, text = ph ? "" : m.text;
  const isPic = (a: Attachment) => a.kind === "image" || a.kind === "video" || !!a.gif || a.kind === "sticker";
  const mediaOnly = !!atts.length && atts.every(isPic) && !cards.length && !m.location && !m.poll && !m.contacts?.length;
  const mediaFirst = !!text && mediaOnly; // a caption sits under its picture
  const tail = !!atts.length && !mediaFirst || !!cards.length || !!m.location || !!m.poll || !!m.contacts?.length || !!missing; // something rendered after the text
  const metaPos: "inline" | "overlay" | "end" = !m.deleted && text && !tail ? "inline" : !text && mediaOnly && atts.every((a) => a.kind !== "sticker") ? "overlay" : "end";
  const reactions = useMemo(() => mergeReactions(m.reactions), [m.reactions]);
  const meta = (cls: string) => <span className={"mfoot " + cls}>{badge}<ExpiryMark seconds={m.deleted ? undefined : m.expiresIn} />{m.pinned && !m.deleted && <PinIcon size={11} className="pinmark" aria-label="Pinned" data-pinned />}<time>{fmtTime(m.time)}</time>{m.fromMe && <Ticks status={m.status} onInfo={m.status && m.status !== "sending" && (caps?.receiptDetails || p.own.kind === "dm") ? () => setInfo(true) : undefined} />}</span>;
  const attsEl = !!atts.length && <div className="atts">{atts.map((a) => <AttachmentView key={a.id} size={atts.filter((x) => x.kind === "image" || x.kind === "video" || x.gif).length > 1 ? 148 : 300} chat={p.own} m={m} a={a} auto={p.settings.autoDownloadMedia} onImage={p.onImage} />)}{metaPos === "overlay" && meta("ov")}</div>;
  const emojiScope = caps?.customEmoji ? p.own.accountId : undefined;
  const rich = !!text && p.own.provider === "discord" && hasMarkup(text); // Discord's markdown (#98); other networks' dialects are not parsed yet
  const textEl = !!text && (rich
    ? <div className="tx rich"><RichText text={text} dialect="discord" emojiScope={emojiScope} />{m.editedAt && <small className="edited"> (edited)</small>}{metaPos === "inline" && meta("inl")}</div>
    : <p className="tx"><Linkified text={text} emojiScope={emojiScope} />{m.editedAt && <small className="edited"> (edited)</small>}{metaPos === "inline" && meta("inl")}</p>);
  return (
    <div data-mid={m.id} data-mkey={m.chatId + "|" + m.id} className={"msg k-" + chat.kind + (p.grouped ? " grouped" : "") + (m.fromMe ? " mine" : "") + (pend ? " sending" : "") + (p.net ? " merged" : "") + (p.selMode ? " selmode" : "") + (p.selected ? " sel" : "") + (!m.deleted && reactions.length ? " hasreact" : "")}
      onClickCapture={(e) => { // while selecting, the whole row is one big checkbox: links, players and action buttons must not fire
        if (p.selMode) { e.stopPropagation(); e.preventDefault(); p.onSelect(); return; }
        if (lp.swallow()) { e.stopPropagation(); e.preventDefault(); } }}
      style={slide ? { transform: `translateX(${slide}px)`, transition: "none" } : undefined}
      data-swipe={slide >= SWIPE_FIRE ? "fire" : slide ? "on" : undefined}
      onTouchStart={(e) => { if (!(e.target as HTMLElement).closest("a, audio, video, input, textarea, .vidctrls")) { lp.onTouchStart(e); swipeHandlers.onTouchStart(e); } }}
      onTouchMove={(e) => { lp.onTouchMove(e); swipeHandlers.onTouchMove(e); }}
      onTouchEnd={(e) => { lp.onTouchEnd(e); swipeHandlers.onTouchEnd(); }}
      onTouchCancel={() => { lp.onTouchCancel(); swipeHandlers.onTouchCancel(); }}
      onContextMenu={(e) => { if ((e.target as HTMLElement).closest("a, audio, video, input, textarea")) return; e.preventDefault(); if (pend || Date.now() - lastLong.current < 1200) return; setMenu({ x: e.clientX, y: e.clientY, sel: window.getSelection()?.toString() ?? "" }); }}>
      {!!slide && <span className="swipereply" aria-hidden style={{ opacity: Math.min(1, slide / SWIPE_FIRE), transform: `translateX(${-Math.min(slide, SWIPE_MAX)}px) scale(${0.7 + 0.3 * Math.min(1, slide / SWIPE_FIRE)})` }}><Reply size={18} /></span>}
      {p.selMode && <span className="selmark" data-selected={p.selected ? "1" : "0"} aria-hidden>{p.selected ? <CheckSquare size={16} /> : <Square size={16} />}</span>}
      {p.grouped ? <time className="gtime">{fmtTime(m.time)}</time>
        : (() => { const av = <Avatar name={name} size={40} of={m.fromMe ? undefined : chat.kind === "dm" ? { kind: "chat", id: chat.id } : { kind: "contact", id: `${chat.accountId}:${m.senderId}` }} />;
            return chat.kind !== "dm" && !m.fromMe && chat.provider !== "mesh" ? <button className="avbtn" title={`Show ${name}`} onClick={() => p.onPerson(m.senderId, name)}>{av}</button> : av; })()}
      <div className={"body" + (mediaOnly && !text ? " pic" : "")}>
        {!p.grouped && <div className="meta"><b className={chat.kind !== "dm" && !m.fromMe && chat.provider !== "mesh" ? "linkname" : ""} onClick={chat.kind !== "dm" && !m.fromMe && chat.provider !== "mesh" ? () => p.onPerson(m.senderId, name) : undefined}>{name}</b><time>{fmtTime(m.time)}</time>{badge}</div>}
        {m.forwarded && <div className="fwd"><Forward size={12} /> Forwarded</div>}
        {m.replyTo && <button className="quote linkquote" title="Show the original message" onClick={() => p.onJump(m.replyTo!.messageId, m.chatId)}><Reply size={12} /> {m.replyTo.sender && <b>{m.replyTo.sender}: </b>}{m.replyTo.textPreview}</button>}
        {m.deleted ? <p className="deleted"><Ban size={14} /> This message was deleted</p> : <>
          {mediaFirst && attsEl}
          {textEl}
          {!mediaFirst && attsEl}
          {missing && <MissingMedia ph={missing} />}
          {m.location && <LocationCard l={m.location} preview={p.settings.mapPreviews} />}
          {m.poll && <PollCard m={m} canVote={!!(caps?.pollVote ?? caps?.polls)} />}
          {cards.map((c, i) => <CardView key={i} c={c} m={m} chat={p.own} auto={p.settings.autoDownloadMedia} onImage={p.onImage} canEdit={!!caps?.eventEdit} />)}
          {m.contacts?.map((c, i) => <ContactCard key={i} c={c} canChat={!!caps?.startChat} onChat={p.onMessageHandle} />)}
        </>}
        {!m.deleted && metaPos === "end" && meta("end")}
        {!m.deleted && !!reactions.length && (
          <div className="reactions">{reactions.map((r) => (
            <button key={r.emoji} className={"chip" + (r.mine ? " mine" : "")} title={reactorTitle(r)} onMouseEnter={() => setHovered(true)}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setReactors(true); }}
              onClick={() => caps?.reactions && p.onReact(r.emoji)}>{caps?.customEmoji && /^:[^:\s]+:$/.test(r.emoji) ? <CustomEmoji scope={p.own.accountId} name={r.emoji.slice(1, -1)} size={14} /> : r.emoji} <span>{r.count ?? r.senderIds.length}</span></button>))}
            {caps?.reactions && <button className="chip add" title="Add reaction" onClick={() => setFullPicker(!fullPicker)}><SmilePlus size={12} /></button>}</div>)}
        {m.thread && !m.deleted && <button className="linkbtn threadlink" data-open-thread onClick={p.onThread}><MessagesSquare size={13} /> {m.thread.count ? `${m.thread.count} ${m.thread.count === 1 ? "reply" : "replies"}` : "Thread"}{m.thread.name && m.thread.name !== m.text ? ` · ${m.thread.name}` : ""} · Open</button>}
        {m.status === "failed" && !m.deleted && <div className="foot"><span className="failrow">{failedSends.get(m.id)?.error ?? "Failed to send"} <button className="linkbtn" onClick={p.onRetry}><RotateCcw size={12} /> Retry</button> <button className="linkbtn" onClick={p.onDiscard}>Discard</button></span></div>}
      </div>
      {!m.deleted && !pend && !p.selMode && <button className="msgmore" aria-label="Message options" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom, sel: "" }); }}><MoreHorizontal size={16} /></button>}
      {!m.deleted && !unsent && !p.selMode && (
        <div className="actions">
          {caps?.reactions && <button title="React" onClick={() => setPicker(!picker)}><SmilePlus size={16} /></button>}
          {caps?.replies && <button title="Reply" onClick={p.onReply}><Reply size={16} /></button>}
          <button title="Forward" onClick={p.onForward}><Forward size={16} /></button>
          {m.text && <button title="Copy text" onClick={() => void copyText(m.text).catch(() => {})}><Copy size={16} /></button>}
          {m.fromMe && caps?.edits && m.text && <button title="Edit" onClick={p.onEdit}><Pencil size={16} /></button>}
          {m.fromMe && caps?.deletes && <button title="Delete" onClick={del}><Trash2 size={16} /></button>}
        </div>)}
      {reactors && createPortal(<ReactorsModal chat={p.own} m={m} messages={p.getMessages()} onClose={() => setReactors(false)} />, document.body)}
      {info && createPortal(<Suspense fallback={null}><MessageInfoModal chat={p.own} m={m} messages={p.getMessages()} details={!!caps?.receiptDetails} onClose={() => setInfo(false)} /></Suspense>, document.body)}
      {menu && <MessageMenu {...menu} onReactors={() => setReactors(true)} m={m} caps={caps} onClose={() => setMenu(undefined)} onSelect={p.onSelect} canShare={canShare} onShare={() => void share()} onMore={() => setFullPicker(true)} onReact={p.onReact} onPin={p.onPin} onReply={p.onReply} onForward={p.onForward} onEdit={p.onEdit} onDelete={del} onRetry={p.onRetry} onDiscard={p.onDiscard} />}
      {fullPicker && <EmojiPopover onClose={() => setFullPicker(false)} onPick={(e) => p.onReact(e)} />}
      {picker && (
        <div className="reactpick" onMouseLeave={() => { pickTimer.current = setTimeout(() => setPicker(false), 600); }} onMouseEnter={() => clearTimeout(pickTimer.current)}>
          {QUICK.map((e) => <button key={e} onClick={() => { p.onReact(e); setPicker(false); }}>{e}</button>)}
          <button className="more" title="More emojis" aria-label="More emojis" onClick={() => { setPicker(false); setFullPicker(true); }}>+</button>
        </div>)}
    </div>
  );
}

type Reaction = NonNullable<Message["reactions"]>[number];
/** One chip per emoji: a bridge (or an import merged into live data) can list the same emoji twice. */
function mergeReactions(rs: Message["reactions"]): Reaction[] {
  const by = new Map<string, Reaction>();
  for (const r of rs ?? []) {
    const e = by.get(r.emoji), n = r.count ?? r.senderIds.length;
    if (!e) { by.set(r.emoji, { ...r, senderIds: [...r.senderIds], count: n }); continue; }
    const have = new Set(e.senderIds), fresh = r.senderIds.filter((x) => !have.has(x));
    e.senderIds = [...e.senderIds, ...fresh]; e.count = Math.max(e.senderIds.length, (e.count ?? 0) + n - (r.senderIds.length - fresh.length)); e.mine = e.mine || r.mine;
  }
  return [...by.values()];
}
const MISSING = { image: ["Photo", ImageIcon], video: ["Video", Play], voice: ["Voice message", Mic], audio: ["Audio", Mic], sticker: ["Sticker", ImageIcon], gif: ["GIF", Play], file: ["File", FileText] } as const;
/** The text said "[Photo]" / "[File: x.csv]" but the media itself was never restored: a card instead of bracket text. */
function MissingMedia({ ph }: { ph: NonNullable<ReturnType<typeof placeholderOf>> }) {
  const [label, Icon] = MISSING[ph.kind];
  return <div className="filecard missing" data-missing={ph.kind} title={ph.name}><span className="fileic"><Icon size={20} /></span>
    <span className="fn">{ph.name ? <MidName name={ph.name} /> : <b>{label} not available</b>}<small>{ph.name ? "File not available" : "Not restored from the backup"}</small></span></div>;
}
/** A file name with a MIDDLE ellipsis: the end (and so the extension) always stays visible. Full name in the tooltip. */
function MidName({ name }: { name: string }) {
  const k = name.length > 28 ? 16 : 0;
  return <b className="mid" title={name}><span className="mh">{k ? name.slice(0, -k) : name}</span>{k > 0 && <span className="mt">{name.slice(-k)}</span>}</b>;
}

/** One card for every rich message type that has no dedicated view (events, invites, calls, products, lists, buttons...). */
function CardView({ c, m, chat, auto, onImage, canEdit }: { c: Card; m: Message; chat: Chat; auto: boolean; onImage: (i: { url: string; name?: string; video?: boolean }) => void; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const ics = () => { try { downloadText(`${c.title.replace(/[^\w\- ]+/g, "").trim() || "event"}.ics`, "text/calendar", icsOf(c, m.id)); } catch (e: any) { alert(e.message); } };
  const Icon = { event: Calendar, invite: UsersIcon, call: Phone, product: ShoppingBag, order: ShoppingBag, list: ListIcon, buttons: MousePointerClick, template: ListIcon, link: ExternalLink, payment: CreditCard, other: FileQuestion }[c.kind] ?? FileQuestion;
  const when = c.when ? fmtDateTime(c.when, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : undefined;
  const until = c.until ? new Date(c.until).toLocaleString([], { hour: "2-digit", minute: "2-digit" }) : undefined;
  return (
    <div className={"cardmsg k-" + c.kind + (c.image ? " withimg " + (c.image.layout === "thumb" ? "thumbimg" : "bannerimg") : "")}>
      {c.image && <CardPicture chat={chat} m={m} img={c.image} auto={auto} onImage={onImage} />}
      <div className="chead"><Icon size={18} /><span className="ckind">{c.kind === "event" ? "Event" : c.kind === "invite" ? "Invitation" : c.kind === "call" ? "Call" : c.kind === "payment" ? "Payment" : c.kind === "other" ? "Message" : c.kind[0].toUpperCase() + c.kind.slice(1)}</span></div>
      <div className="ctitle">{c.title}</div>
      {c.subtitle && <div className="csub">{c.subtitle}</div>}
      {when && <div className="crow"><Clock3 size={14} /> {when}{until ? ` – ${until}` : ""}</div>}
      {c.place && <div className="crow"><MapPin size={14} /> {c.place}</div>}
      {c.body && <div className="cbody"><Linkified text={c.body} /></div>}
      {!!c.rows?.length && <dl className="crows">{c.rows.map((r, i) => <div key={i}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>}
      {!!c.buttons?.length && <div className="cbtns" title="Buttons can't be used from UniChat">{c.buttons.map((b, i) => <span key={i} className="cbtn">{b}</span>)}</div>}
      {c.footer && <div className="cfoot">{c.footer}</div>}
      {c.kind === "event" && (
        <div className="cactions">
          {c.when && <button className="secondary" title="Download an .ics file: opens in your calendar app" onClick={ics}><Calendar size={14} /> Add to calendar</button>}
          {c.editable && canEdit && <button className="secondary" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>}
        </div>)}
      {editing && <EventModal initial={{ name: c.title, description: c.body, start: c.when, end: c.until, place: c.place }} onClose={() => setEditing(false)}
        onSave={async (v) => { await core.call("editEvent", { chatId: m.chatId, messageId: m.id, patch: v }); }} />}
      {c.url && /^https?:\/\//i.test(c.url) && <a className="secondary cbtn-link" href={c.url} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} /> {c.kind === "event" || c.kind === "call" ? "Join / open link" : c.kind === "invite" ? "Open invitation" : "Open link"}</a>}
    </div>
  );
}

/** Preview image of a card. It loads through the backend like any attachment (never hot-linked from the remote host). */
function CardPicture({ chat, m, img, auto, onImage }: { chat: Chat; m: Message; img: NonNullable<Card["image"]>; auto: boolean; onImage: (i: { url: string; name?: string; video?: boolean }) => void }) {
  const att: Attachment = { id: img.attachmentId, kind: "image", mime: "image/*" };
  const [nearRef, near] = useNearView<HTMLButtonElement>(auto);
  const { r, err: failed, loading, load } = useAttachment(chat.id, m.id, att, auto && near);
  const src = r?.url ?? img.thumbnailDataUrl;
  return (
    <button ref={nearRef} type="button" className="cardpic" style={img.width && img.height && img.layout !== "thumb" ? { aspectRatio: `${img.width} / ${img.height}` } : undefined} title={img.alt ?? "Open image"}
      onClick={async () => { const x = r ?? await load(); if (x) onImage({ url: x.url, name: img.alt }); }}>
      {src ? <img src={src} alt={img.alt ?? ""} loading="lazy" decoding="async" /> : <span className="imgph">{failed ? <><AlertCircle size={16} /> Failed to load</> : loading ? <><i className="spinner" /> Loading…</> : <><ImageIcon size={16} /> Tap to load</>}</span>}
    </button>);
}

/** Placeholder while a chat's messages are on their way, with honest wording if it takes long. */
function LoadingMessages({ since, source }: { since: number; source?: LoadSource }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => { const i = setInterval(() => setSecs(Math.floor((Date.now() - since) / 1000)), 500); return () => clearInterval(i); }, [since]);
  const off = source?.kind === "offline";
  return (
    <div className="loading" role="status" aria-live="polite" aria-label="Loading messages" data-source={source?.kind}>
      {[70, 45, 82, 38, 60].map((w, i) => (
        <div key={i} className={"skel " + (i % 2 ? "r" : "l")}><i className="sa" /><span className="sb"><i style={{ width: "30%" }} /><i style={{ width: w + "%" }} /></span></div>))}
      <div className="lmsg">{!off && <span className="spinner" aria-hidden />} <span data-load-line>{loadingLine(source, secs)}</span></div>
    </div>
  );
}

/** A poll: tap options to vote (single answer: pick one; several answers: toggle). */
function PollCard({ m, canVote }: { m: Message; canVote: boolean }) {
  const poll = m.poll!; const mine = new Set(poll.mine ?? []);
  const n = (o: { voters: string[]; count?: number }) => o.count ?? o.voters.length; // exact total when the network only reports counts
  const total = poll.options.reduce((s, o) => s + n(o), 0);
  const voters = poll.options.some((o) => o.count !== undefined) ? total : new Set(poll.options.flatMap((o) => o.voters)).size;
  const vote = (id: string) => {
    if (!canVote || poll.closed) return;
    const next = poll.multiple ? (mine.has(id) ? [...mine].filter((x) => x !== id) : [...mine, id]) : (mine.has(id) ? [] : [id]);
    core.call("vote", { chatId: m.chatId, messageId: m.id, optionIds: next }).catch(err);
  };
  return (
    <div className="pollcard">
      <div className="pq"><BarChart3 size={15} /> <b>{poll.question}</b></div>
      <div className="phint">{poll.closed ? "Poll closed" : poll.multiple ? "Select one or more" : "Select one"}</div>
      {poll.options.map((o) => {
        const pct = total ? Math.round((n(o) / total) * 100) : 0; const on = mine.has(o.id);
        const Icon = poll.multiple ? (on ? CheckSquare : Square) : (on ? CheckCircle2 : Circle);
        return (
          <button key={o.id} className={"popt" + (on ? " on" : "")} disabled={!canVote || poll.closed} onClick={() => vote(o.id)}>
            <span className="pbar" style={{ width: pct + "%" }} />
            <span className="pl"><Icon size={16} /> {o.text}</span><span className="pc">{n(o)}</span>
          </button>);
      })}
      <div className="phint">{voters} {voters === 1 ? "vote" : "votes"}</div>
    </div>
  );
}

/** Timeline marker: the account was linked / signed out / unlinked here (possible gap in history). */
function SystemRow({ m, onThread }: { m: Message; onThread?: () => void }) {
  return <div className={"sysmsg k-" + (m.system?.kind ?? "note")} role="note" data-kind={m.system?.kind}><span>{m.system?.kind === "info" && /disappearing messages/i.test(m.text) ? <Timer size={13} data-timer-note /> : m.system?.kind === "linked" || m.system?.kind === "info" ? <Info size={13} /> : <LogOut size={13} />} {m.text}{onThread && <button className="linkbtn threadlink" data-open-thread onClick={onThread}><MessagesSquare size={12} /> Open thread</button>}<time>{new Date(m.time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time></span></div>;
}

/** Right-click menu for a message (replaces the browser's own menu; selected text still gets "Copy selection"). */
function MessageMenu(p: { onMore: () => void; onReactors: () => void; onSelect: () => void; canShare?: boolean; onShare: () => void; x: number; y: number; sel: string; m: Message; caps?: Capabilities; onClose: () => void; onReact: (e: string) => void; onPin: (pinned: boolean, durationSec?: number) => void; onReply: () => void; onForward: () => void; onEdit: () => void; onDelete: () => void; onRetry: () => void; onDiscard: () => void }) {
  const { m, caps } = p;
  const [pinOpen, setPinOpen] = useState(false); // networks with expiring pins: the length is chosen right in the menu
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: p.x, top: p.y });
  useLayoutEffect(() => { const r = ref.current!.getBoundingClientRect(); setPos({ left: Math.max(8, Math.min(p.x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(p.y, innerHeight - r.height - 8)) }); }, [p.x, p.y]);
  useEffect(() => {
    // a scroll closes the menu, except in its first 300 ms: a chat that just opened is still settling at the bottom (images, the live answer), and that is not the user scrolling away
    const opened = performance.now();
    const close = () => p.onClose(); const key = (e: KeyboardEvent) => e.key === "Escape" && p.onClose(), sc = (e: Event) => { if (performance.now() - opened > 300 && !ref.current?.contains(e.target as Node)) close(); };
    addEventListener("mousedown", close); addEventListener("scroll", sc, true); addEventListener("resize", close); addEventListener("blur", close); addEventListener("keydown", key);
    return () => { removeEventListener("mousedown", close); removeEventListener("scroll", sc, true); removeEventListener("resize", close); removeEventListener("blur", close); removeEventListener("keydown", key); };
  }, []);
  const go = (f: () => void) => () => { p.onClose(); f(); };
  const Item = ({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) =>
    <button className={danger ? "dangeritem" : ""} onClick={go(onClick)}>{icon}{label}</button>;
  const failed = m.status === "failed";
  const copyImage = m.attachments?.find((a) => a.kind === "image");
  return (
    <div ref={ref} className="ctxmenu" style={{ left: pos.left, top: pos.top }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()} role="menu">
      {!m.deleted && !!m.reactions?.length && <Item icon={<SmilePlus size={15} />} label="Who reacted…" onClick={p.onReactors} />}
      {!m.deleted && !failed && caps?.reactions && <div className="ctxreacts">{QUICK.map((e) => <button key={e} onClick={go(() => p.onReact(e))}>{e}</button>)}<button className="more" title="More emojis" aria-label="More emojis" onClick={go(p.onMore)}>+</button></div>}
      {p.sel && <Item icon={<Copy size={15} />} label="Copy selection" onClick={() => void copyText(p.sel).catch(() => {})} />}
      {failed && <><Item icon={<RotateCcw size={15} />} label="Retry sending" onClick={p.onRetry} /><Item icon={<Trash2 size={15} />} label="Discard" onClick={p.onDiscard} danger /></>}
      {!m.deleted && !failed && <>
        {caps?.replies && <Item icon={<Reply size={15} />} label="Reply" onClick={p.onReply} />}
        <Item icon={<Forward size={15} />} label="Forward" onClick={p.onForward} />
        {p.canShare && <Item icon={<ExternalLink size={15} />} label="Share…" onClick={p.onShare} />}
        <Item icon={<CheckSquare size={15} />} label="Select" onClick={p.onSelect} />
        {caps?.pinMessages && (m.pinned ? <Item icon={<PinOffIcon size={15} />} label="Unpin" onClick={() => p.onPin(false)} />
          : caps.pinDurations?.length ? <>
            <button data-pin-menu aria-expanded={pinOpen} onClick={() => setPinOpen(!pinOpen)}><PinIcon size={15} />Pin…</button>
            {pinOpen && <div className="ctxsub" role="group" aria-label="Pin for">{caps.pinDurations.map((d) => <button key={d} data-default={d === 604800 ? "" : undefined} onClick={go(() => p.onPin(true, d))}>{pinDurationLabel(d)}</button>)}</div>}</>
          : <Item icon={<PinIcon size={15} />} label="Pin" onClick={() => p.onPin(true)} />)}
        {m.text && <Item icon={<Copy size={15} />} label="Copy text" onClick={() => void copyText(m.text).catch(() => {})} />}
        {copyImage && <Item icon={<Download size={15} />} label="Save image" onClick={async () => { const r = await loadAttachment(m.chatId, m.id, copyImage.id).catch(() => undefined); if (!r) return; const a = document.createElement("a"); a.href = r.url; a.download = copyImage.name ?? r.name ?? "image"; a.click(); }} />}
        {m.fromMe && caps?.edits && m.text && <Item icon={<Pencil size={15} />} label="Edit" onClick={p.onEdit} />}
        {m.fromMe && caps?.deletes && <Item icon={<Trash2 size={15} />} label="Delete for everyone" onClick={p.onDelete} danger />}
      </>}
      <div className="ctxinfo">{fmtDateTime(m.time, undefined, true)}{m.fromMe && m.status ? ` · ${m.status}` : ""}{m.editedAt ? " · edited" : ""}</div>
    </div>
  );
}

function AttachmentView({ chat, m, a, auto, onImage, size }: { size: number; chat: Chat; m: Message; a: Attachment; auto: boolean; onImage: (i: { url: string; name?: string; video?: boolean }) => void }) {
  const eager = auto && !isPending(m) && (a.kind === "image" || a.kind === "sticker" || a.kind === "voice" || a.kind === "audio" || a.kind === "video" || !!a.gif);
  const picture = a.kind === "image" || a.kind === "sticker";
  const [nearRef, near] = useNearView<HTMLButtonElement>(eager && picture);
  const { r, err: failed, loading, load } = useAttachment(chat.id, m.id, a, eager && (!picture || near));
  if (a.kind === "image" || a.kind === "sticker") {
    const src = r?.url ?? a.thumbnailDataUrl;
    const side = a.kind === "sticker" ? 150 : size; // pictures are always shown as squares (cropped to fill); the viewer shows the whole picture
    return (
      <button ref={nearRef} style={sq(side)} className={"imgwrap" + (a.kind === "sticker" ? " sticker" : "")} onClick={async () => { const x = r ?? await load(); if (x) onImage({ url: x.url, name: a.name ?? x.name }); }} title={a.name}>
        {src ? <img src={src} alt={a.name ?? "image"} loading="lazy" decoding="async" /> : <span className="imgph">{failed ? <><AlertCircle size={18} /> {a.kind === "sticker" ? "Sticker" : "Photo"} not available</> : loading ? <><i className="spinner" /> Loading…</> : <><ImageIcon size={18} /> Tap to load</>}</span>}
        {!r && src && !failed && <span className="imgdl"><Download size={12} /> {fmtBytes(a.size)}</span>}
      </button>);
  }
  if (a.kind === "voice" || a.kind === "audio")
    return <Suspense fallback={<span className="imgph"><i className="spinner" /></span>}><VoicePlayer a={a} url={r?.url} failed={failed} onLoad={load} /></Suspense>;
  if (a.gif) // GIFs arrive as tiny muted videos: play them inline like a picture, no player chrome
    return r ? <div className="imgwrap gifwrap" style={sq(size)}><video className="gif" src={r.url} autoPlay loop muted playsInline aria-label="GIF" /><span className="imgdl">GIF</span></div>
      : <button className="imgwrap" style={sq(size)} onClick={() => load()}>{a.thumbnailDataUrl ? <img src={a.thumbnailDataUrl} alt="GIF" /> : <span className="imgph"><Play size={18} /> GIF</span>}<span className="imgdl">GIF</span></button>;
  if (a.kind === "video")
    return <Suspense fallback={<span className="imgph"><i className="spinner" /></span>}><VideoPlayer a={a} size={size} url={r?.url} failed={failed} onLoad={load} onExpand={(url, at) => onImage({ url: url + (at > 1 ? "#t=" + at.toFixed(1) : ""), name: a.name ?? r?.name, video: true })} /></Suspense>;
  const download = async () => { const x = r ?? await load(); if (!x) return; const el = document.createElement("a"); el.href = x.url; el.download = a.name ?? x.name ?? "file"; el.click(); };
  return (
    <button className="filecard" onClick={download} title={a.name}><span className="fileic"><FileText size={20} /></span><span className="fn"><MidName name={a.name ?? "File"} /><small>{[fmtBytes(a.size), (a.name?.includes(".") ? a.name.split(".").pop()!.slice(0, 6).toUpperCase() : a.mime.split("/").pop())].filter(Boolean).join(" · ")}{failed ? " · not available" : ""}</small></span>{failed ? <AlertCircle size={18} /> : <Download size={18} />}</button>);
}

const TILE = 256, ZOOM = 15, MAP_W = 260, MAP_H = 130;
/** Real map preview: OpenStreetMap raster tiles stitched around the point (Web-Mercator maths), pin on top. */
function MapPreview({ lat, lng }: { lat: number; lng: number }) {
  const n = 2 ** ZOOM;
  const px = ((lng + 180) / 360) * n * TILE;
  const rad = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TILE;
  const left = px - MAP_W / 2, top = py - MAP_H / 2;
  const tiles: { x: number; y: number }[] = [];
  for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + MAP_H) / TILE); ty++)
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + MAP_W) / TILE); tx++)
      if (ty >= 0 && ty < n) tiles.push({ x: ((tx % n) + n) % n, y: ty, ...{ ox: tx } } as any);
  return (
    <span className="map" style={{ width: MAP_W, height: MAP_H }} aria-hidden>
      {tiles.map((t: any) => (
        <img key={`${t.ox}/${t.y}`} src={`https://tile.openstreetmap.org/${ZOOM}/${t.x}/${t.y}.png`} alt="" width={TILE} height={TILE} draggable={false}
          style={{ left: t.ox * TILE - left, top: t.y * TILE - top }} onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />))}
      <MapPin className="pin" size={30} fill="#da373c" color="#7a1014" strokeWidth={1.5} />
      <i className="osm">© OpenStreetMap contributors</i>
    </span>
  );
}

function LocationCard({ l, preview }: { l: Location; preview: boolean }) {
  const url = `https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=16/${l.lat}/${l.lng}`;
  const ended = !!l.live && !!l.liveUntil && new Date(l.liveUntil) < new Date();
  const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  return (
    <a className="loccard" href={url} target="_blank" rel="noreferrer noopener">
      {preview ? <MapPreview lat={l.lat} lng={l.lng} /> : <span className="map off"><MapPin size={28} /></span>}
      <span className="locinfo">
        {l.live && <span className={"livebadge" + (ended ? " ended" : "")}><i />{ended ? "Live location ended" : "Live location"}</span>}
        <b>{l.name ?? "Shared location"}</b>{l.address && <small>{l.address}</small>}
        <small>{l.lat.toFixed(5)}, {l.lng.toFixed(5)}{l.live && !ended && l.updatedAt ? ` · updated ${fmt(l.updatedAt)}` : ""}{l.live && !ended && l.liveUntil ? ` · until ${fmt(l.liveUntil)}` : ""}</small>
      </span>
    </a>);
}

function ContactCard({ c, canChat, onChat }: { c: SharedContact; canChat: boolean; onChat: (h: string) => void }) {
  const h = c.phones?.[0] ?? c.handle;
  return (
    <div className="contactcard"><Avatar name={c.name} size={40} /><span className="ci"><b>{c.name}</b>{c.phones?.map((x) => <small key={x}>{x}</small>)}{c.emails?.map((x) => <small key={x}>{x}</small>)}{!c.phones && c.handle && <small>{c.handle}</small>}</span>
      <span className="cabtns">{canChat && h && <button className="secondary" onClick={() => onChat(h)}>Message</button>}
        <button className="secondary" title="Download as a .vcf contact file (opens in your address book)" onClick={() => downloadText(`${c.name.replace(/[^\w\- ]+/g, "").trim() || "contact"}.vcf`, "text/vcard", vcardOf(c))}><Download size={14} /> .vcf</button></span></div>);
}

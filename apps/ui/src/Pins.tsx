// Pinned messages: the data hook, the bar at the top of a conversation and the list in the chat info panel.
import { useEffect, useMemo, useState } from "react";
import { Pin, PinOff, X } from "./icons";
import type { Message } from "./types";
import { core, fmtTime } from "./util";
import "./pins.css";

const key = (m: Message) => m.chatId + "|" + m.id;
const at = (m: Message) => m.pinnedAt ?? m.time;
/** Lengths offered for networks with expiring pins (Capabilities.pinDurations, seconds; 0 = until removed). */
export const pinDurationLabel = (s: number) => (s === 0 ? "Until removed" : s % 86400 === 0 ? (s / 86400 === 1 ? "24 hours" : `${s / 86400} days`) : s % 3600 === 0 ? `${s / 3600} hours` : `${Math.round(s / 60)} minutes`);
/** One line of a message for the bar and the list: its text, else what it carries. */
export function pinPreview(m: Message): string {
  const t = (m.text || "").replace(/\s+/g, " ").trim();
  if (t) return t;
  const a = m.attachments?.[0];
  if (a) return a.kind === "image" ? "Photo" : a.kind === "video" ? "Video" : a.kind === "voice" ? "Voice message" : a.kind === "sticker" ? "Sticker" : a.name ?? "File";
  if (m.location) return "Location";
  if (m.poll) return "Poll: " + m.poll.question;
  if (m.contacts?.length) return "Contact";
  return m.card?.title ?? m.cards?.[0]?.title ?? "Message";
}
export const unpin = (m: Message) => core.call("pin", { chatId: m.chatId, messageId: m.id, pinned: false }).catch((e: any) => alert(e?.message ?? String(e)));

/** The pinned messages of a chat (a merged chat: of all its members), newest pin first. Messages loaded in the timeline are authoritative; older pins come from the `pins` call. */
export function usePins(chatId: string, messages: Message[], enabled: boolean): Message[] {
  const [fetched, setFetched] = useState<Message[]>([]);
  const [tick, setTick] = useState(0);
  const sig = useMemo(() => messages.filter((m) => m.pinned).map(key).join(","), [messages]);
  useEffect(() => { setFetched([]); }, [chatId]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    core.call("pins", { chatId }).then((l: Message[]) => { if (live && Array.isArray(l)) setFetched((prev) => (prev.length === l.length && prev.every((m, i) => key(m) === key(l[i]) && m.pinnedAt === l[i]!.pinnedAt) ? prev : l)); }).catch(() => {});
    return () => { live = false; };
  }, [chatId, enabled, sig, tick]);
  useEffect(() => core.on((ev: string, d: any) => { if (ev === "message-update" && d?.patch && "pinned" in d.patch && (d.chatId === chatId || d.mergeId === chatId)) setTick((x) => x + 1); }), [chatId]);
  return useMemo(() => {
    const loaded = new Map(messages.map((m) => [key(m), m])), out = new Map<string, Message>(), now = Date.now();
    for (const m of fetched) { const l = loaded.get(key(m)); if (!l) out.set(key(m), m); else if (l.pinned) out.set(key(m), l); }
    for (const m of messages) if (m.pinned) out.set(key(m), m);
    return [...out.values()].filter((m) => !m.deleted && !(m.pinnedUntil && Date.parse(m.pinnedUntil) <= now)).sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
  }, [fetched, messages]);
}

/** The bar under the header: newest pin with sender and one line of text; "1 of 3" with several; a click jumps to the message and moves on to the next pin. */
export function PinnedBar({ pins, canUnpin, onJump }: { pins: Message[]; canUnpin: boolean; onJump: (messageId: string, chatId?: string) => void }) {
  const [i, setI] = useState(0);
  const n = pins.length, cur = pins[Math.min(i, n - 1)];
  useEffect(() => { if (i >= n) setI(0); }, [n, i]);
  if (!n || !cur) return null;
  const idx = Math.min(i, n - 1);
  return (
    <div className="pinbar" role="region" aria-label="Pinned messages" data-pinbar data-count={n}>
      <Pin size={16} className="pinic" aria-hidden />
      <button type="button" className="pinmain" data-pin-jump title="Show the pinned message" onClick={() => { onJump(cur.id, cur.chatId); if (n > 1) setI((idx + 1) % n); }}>
        <span className="pinhead">Pinned message{n > 1 ? <span className="pincount"> · {idx + 1} of {n}</span> : null}</span>
        <span className="pintext"><b>{cur.fromMe ? "You" : cur.sender || cur.senderId}</b> {pinPreview(cur)}</span>
      </button>
      {canUnpin && <button type="button" className="icon pinun" data-pin-unpin title="Unpin" aria-label="Unpin this message" onClick={() => void unpin(cur)}><PinOff size={16} /></button>}
    </div>
  );
}

/** "Pinned messages" in the chat info sidebar. */
export function PinnedList({ pins, canUnpin, onJump }: { pins: Message[]; canUnpin: boolean; onJump?: (messageId: string, chatId?: string) => void }) {
  if (!pins.length) return null;
  return (
    <section className="pinlist" data-pinlist><h4>Pinned messages · {pins.length}</h4>
      {pins.map((m) => (
        <div key={key(m)} className="pinrow">
          <button type="button" className="pinbody" title="Show in the conversation" onClick={() => onJump?.(m.id, m.chatId)}>
            <span className="pinwho"><b>{m.fromMe ? "You" : m.sender || m.senderId}</b><time>{fmtTime(m.time)}</time></span>
            <span className="pintext">{pinPreview(m)}</span>
            {m.pinnedUntil && <small className="pinuntil">until {new Date(m.pinnedUntil).toLocaleDateString()}</small>}
          </button>
          {canUnpin && <button type="button" className="icon" title="Unpin" aria-label={"Unpin: " + pinPreview(m).slice(0, 40)} onClick={() => void unpin(m)}><X size={14} /></button>}
        </div>))}
    </section>
  );
}

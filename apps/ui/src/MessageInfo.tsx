import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Chat, Contact, Message } from "./types";
import type { MessageReceipt } from "../../../packages/core/src/model";
import { Avatar, fmtDate } from "./util";
import { Modal } from "./Modals";
import { Check, CheckCheck } from "./icons";
import { loadMembers, useNames } from "./Reactors";
import "./messageinfo.css";

/** Exact time of a receipt: just the clock when it is today, with the date otherwise. */
export function fmtExact(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return t;
  return fmtDate(d, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }) + ", " + t;
}
const ts = (s?: string) => (s ? Date.parse(s) || 0 : 0);
const previewOf = (m: Message) => m.text || (m.attachments?.length ? ({ image: "Photo", video: "Video", audio: "Audio", voice: "Voice message", file: m.attachments[0].name ?? "File", sticker: "Sticker" }[m.attachments[0].kind]) : m.poll ? "Poll: " + m.poll.question : m.location ? "Location" : m.contacts?.length ? "Contact" : "Message");

/** Split receipts into who read it, who only got it (newest first), and the ids that have nothing yet. Exported for tests of the logic. */
export function splitReceipts(rs: MessageReceipt[], memberIds: string[], senderId: string) {
  const read = rs.filter((r) => r.read).sort((a, b) => ts(b.read) - ts(a.read));
  const delivered = rs.filter((r) => !r.read && r.delivered).sort((a, b) => ts(b.delivered) - ts(a.delivered));
  const known = new Set(rs.filter((r) => r.read || r.delivered).map((r) => r.id));
  const pending = memberIds.filter((id) => id !== senderId && id !== "me" && !known.has(id));
  return { read, delivered, pending };
}

const LIMIT = 10; // rows per section before "Show all"

/** WhatsApp-style "Message info" for one of MY messages: who received / read it and when. Live: `m` is the message as the app holds it. */
export function MessageInfoModal(p: Parameters<typeof InfoModal>[0]) { return createPortal(<InfoModal {...p} />, document.body); } // outside the message bubble: its CSS (hidden avatars, colours) must not apply
function InfoModal({ chat, m, messages, details, onClose }: { chat: Chat; m: Message; messages: Message[]; /** the account's connector reports per-recipient data */ details: boolean; onClose: () => void }) {
  const nameOf = useNames(chat, messages, true);
  const [members, setMembers] = useState<Contact[]>();
  useEffect(() => { let live = true; loadMembers(chat.id).then((x) => live && setMembers(x)); return () => { live = false; }; }, [chat.id]);
  const [all, setAll] = useState<Record<string, boolean>>({});
  const dm = chat.kind === "dm";
  const rs = m.receipts ?? [];
  const st = m.status;
  const ico = (read: boolean) => (read ? <CheckCheck size={14} color="#53bdeb" strokeWidth={2.2} /> : <CheckCheck size={14} color="#949ba4" strokeWidth={2.2} />);
  const who = nameOf;
  const person = (id: string) => dm ? <Avatar name={chat.name} size={32} of={{ kind: "chat", id: chat.id }} /> : <Avatar name={nameOf(id)} size={32} of={{ kind: "contact", id: `${chat.accountId}:${id}` }} />;

  const header = <>
    <div className="mi-preview" data-testid="mi-preview">{previewOf(m).slice(0, 300)}</div>
    <div className="mi-sent">Sent {fmtExact(m.time)}</div>
  </>;

  if (dm) { // one recipient: show what is known about them
    const r = rs.reduce<MessageReceipt | undefined>((a, x) => (a ? { id: a.id, delivered: ts(x.delivered) > ts(a.delivered) ? x.delivered : a.delivered, read: ts(x.read) > ts(a.read) ? x.read : a.read } : x), undefined); // the one recipient
    const gotIt = st === "delivered" || st === "read", readIt = st === "read";
    const line = (label: string, time: string | undefined, reached: boolean, readTick: boolean) => (
      <div className="mi-line" data-row={label}>{ico(readTick && reached)}<span className="mi-label">{label}</span>
        <span className="mi-time">{time ? fmtExact(time) : reached ? "Time not reported" : "Not yet"}</span></div>);
    const none = !rs.length && (gotIt || readIt);
    return (
      <Modal title="Message info" onClose={onClose}>
        <div className="minfo">{header}
          <div className="mi-list">
            {line("Read", r?.read, !!r?.read || readIt, true)}
            {line("Delivered", r?.delivered ?? undefined, !!r?.delivered || gotIt || !!r?.read, false)}
          </div>
          {st === "failed" ? <div className="mi-note">This message failed to send.</div>
            : (none || (!details && !rs.length)) && st !== "sending" && <div className="mi-note">Details are not available for this messenger.</div>}
        </div>
      </Modal>);
  }

  const { read, delivered, pending } = splitReceipts(rs, (members ?? []).map((c) => c.id), m.senderId);
  const section = (key: string, title: string, items: { id: string; time?: string }[], tick: React.ReactNode) => {
    if (!items.length) return null;
    const shown = all[key] ? items : items.slice(0, LIMIT);
    return (
      <section data-section={key}>
        <h4>{tick}{title} <span data-count>{items.length}</span></h4>
        <div className="mi-list">{shown.map((x) => <div className="mi-row" key={x.id} data-who={x.id}>{person(x.id)}<span className="mi-name">{who(x.id)}</span>{x.time && <span className="mi-time">{fmtExact(x.time)}</span>}</div>)}</div>
        {items.length > LIMIT && !all[key] && <button className="linkbtn mi-more" onClick={() => setAll((a) => ({ ...a, [key]: true }))}>Show all ({items.length})</button>}
      </section>);
  };
  return (
    <Modal title="Message info" onClose={onClose}>
      <div className="minfo">{header}
        {section("read", "Read by", read.map((r) => ({ id: r.id, time: r.read })), ico(true))}
        {section("delivered", "Delivered to", delivered.map((r) => ({ id: r.id, time: r.delivered })), <Check size={14} color="#949ba4" />)}
        {members === undefined ? <div className="mi-load">Loading members…</div> : section("pending", "Not yet", pending.map((id) => ({ id })), null)}
        {!rs.length && members !== undefined && !pending.length && <div className="mi-note">Nobody has received this message yet.</div>}
        {!details && <div className="mi-note">Details are not available for this messenger.</div>}
      </div>
    </Modal>);
}

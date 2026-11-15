import { useEffect, useState } from "react";
import type { Chat, Contact, Message } from "./types";
import { Avatar, core } from "./util";
import { Modal } from "./Modals";

// Member lists per chat, loaded once on demand (also feeds the hover tooltip).
const cache = new Map<string, Promise<Contact[]>>();
export function loadMembers(chatId: string): Promise<Contact[]> {
  let p = cache.get(chatId);
  if (!p) { p = core.call("members", { chatId }).then((m: Contact[]) => m ?? [], () => []); cache.set(chatId, p); p.then((m) => { if (!m.length) cache.delete(chatId); }); }
  return p;
}

/** Hook: display name for a sender id in this chat ("You" for me), best effort from the member list and the loaded messages. */
export function useNames(chat: Chat, messages: Message[] | (() => Message[]), enabled: boolean) {
  const [members, setMembers] = useState<Contact[]>([]);
  useEffect(() => { if (enabled) loadMembers(chat.id).then(setMembers); }, [chat.id, enabled]);
  return (id: string) => members.find((c) => c.id === id)?.name || (typeof messages === "function" ? messages() : messages).find((m) => m.senderId === id && !m.fromMe)?.sender || (chat.kind === "dm" ? chat.name : "") || "Someone";
}

/** Everyone who reacted to a message, grouped by emoji. */
export function ReactorsModal({ chat, m, messages, onClose }: { chat: Chat; m: Message; messages: Message[]; onClose: () => void }) {
  const nameOf = useNames(chat, messages, true);
  const [pick, setPick] = useState<string>();
  const rs = m.reactions ?? [];
  const shown = pick ? rs.filter((r) => r.emoji === pick) : rs;
  const cnt = (r: { senderIds: string[]; count?: number }) => r.count ?? r.senderIds.length; // exact total (the list may be incomplete)
  const total = rs.reduce((n, r) => n + cnt(r), 0);
  return (
    <Modal title="Reactions" onClose={onClose}>
      <div className="rtabs">
        <button className={!pick ? "on" : ""} onClick={() => setPick(undefined)}>All {total}</button>
        {rs.map((r) => <button key={r.emoji} className={pick === r.emoji ? "on" : ""} onClick={() => setPick(r.emoji)}>{r.emoji} {cnt(r)}</button>)}
      </div>
      <div className="rlist">
        {shown.flatMap((r) => r.senderIds.map((id) => {
          const mine = !!r.mine && (id === "me" || messages.some((x) => x.fromMe && x.senderId === id));
          const name = mine ? "You" : nameOf(id);
          return <div className="rrow" key={r.emoji + id}><Avatar name={name} size={32} provider={chat.provider} of={{ kind: "contact", id: `${chat.accountId}:${id}` }} /><span className="rname">{name}</span><span className="remoji">{r.emoji}</span></div>;
        }))}
        {shown.map((r) => { const rest = cnt(r) - r.senderIds.length; return rest > 0 && <div className="rmore" key={"more" + r.emoji}>{r.senderIds.length ? `and ${rest} ${rest === 1 ? "other" : "others"}` : `${rest} ${rest === 1 ? "person" : "people"}`} <span className="remoji">{r.emoji}</span></div>; })}
        {!shown.length && <div className="rempty">No reactions</div>}
      </div>
    </Modal>);
}

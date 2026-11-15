// Mark-as-read written back through the Hub: single chats and "mark all" batches with progress and partial-failure reporting.
import { useEffect, useRef, useState } from "react";
import type { Chat } from "./types";
import { core, type Settings } from "./util";

interface Prog { jobId: string; scope: string; label: string; total: number; done: number; ok: number; local: number; failed: number; finished: boolean; cancelled?: boolean; failures?: { chatId: string; error?: string }[]; cleared?: string[] }
const WHY: Record<string, string> = { "no-support": "this messenger can't be told", "receipts-off": "read receipts are off", "signed-out": "the account is signed out", "no-messages": "no message is stored yet" };

export function useMarkRead(o: { say: (t: string) => void; setChats: React.Dispatch<React.SetStateAction<Chat[]>>; settings: Settings; setError: (m: string) => void; getChats: () => Chat[] }) {
  /** chat id -> newest message time when the user cleared it: a refresh from a service that can't be told must not bring the counter back until something newer arrives */
  const localRead = useRef(new Map<string, string>());
  const [prog, setProg] = useState<Prog>();
  const labels = useRef(new Map<string, string>()); const ref = useRef(o); ref.current = o;
  const clear = (ids: string[]) => { const s = new Set(ids); for (const c of ref.current.getChats()) if (s.has(c.id) || (c.mergedInto && s.has(c.mergedInto))) localRead.current.set(c.id, c.lastMessageAt ?? ""); ref.current.setChats((cs) => cs.map((c) => (s.has(c.id) || (c.mergedInto && s.has(c.mergedInto)) ? { ...c, unread: 0 } : c))); };
  useEffect(() => core.on((ev, d) => {
    if (ev === "chat-read") clear([d.chatId]);
    if (ev === "mark-read-progress") {
      const p: Prog = { ...d, label: labels.current.get(d.jobId) ?? "chats" };
      if (!p.finished) { setProg(p); return; }
      if (p.cleared) clear(p.cleared);
      const bits = [`${p.ok} marked read on the service`, ...(p.local ? [`${p.local} cleared here only (no read-marking available, or receipts off)`] : []), ...(p.failed ? [`${p.failed} failed and stay unread`] : [])];
      ref.current.say(p.cancelled ? `Stopped: ${bits.join(", ")}` : bits.join(", "));
      if (p.failed) setProg(p); else setProg(undefined);
    }
  }), []);
  const markChat = async (c: Chat) => {
    try {
      const r = await core.call("markChatRead", { chatId: c.id, sendReceipts: o.settings.sendReadReceipts });
      if (r.status === "failed") ref.current.setError(`Couldn't mark “${c.name}” as read on the service (${r.error ?? "unknown error"}); it stays unread.`);
      else { clear([c.id]); if (r.status === "local") o.say(`Cleared here only: ${WHY[r.reason] ?? "nothing to send"}.`); }
    } catch (e: any) { ref.current.setError(e.message); }
  };
  const markAll = async (scope: string, label: string) => {
    try {
      const r = await core.call("markAllRead", { scope, sendReceipts: o.settings.sendReadReceipts });
      if (!r.total) { o.say("Nothing unread here."); return; }
      labels.current.set(r.jobId, label); setProg({ jobId: r.jobId, scope, label, total: r.total, done: 0, ok: 0, local: 0, failed: 0, finished: false });
    } catch (e: any) { ref.current.setError(e.message); }
  };
  return { localRead: localRead.current, prog, markChat, markAll, dismiss: () => setProg(undefined), cancel: () => prog && core.call("cancelMarkRead", { jobId: prog.jobId }).catch(() => {}) };
}

export function MarkReadToast({ prog, onCancel, onDismiss }: { prog?: Prog; onCancel: () => void; onDismiss: () => void }) {
  if (!prog) return null;
  return (
    <div className="toast" role="status" data-toast="markread">
      {prog.finished ? <><b>{prog.failed} chat{prog.failed === 1 ? "" : "s"} couldn't be marked read</b><small>{prog.failures?.slice(0, 3).map((f) => f.error).filter(Boolean).join(" · ")}</small><button className="secondary" onClick={onDismiss}>OK</button></>
        : <><span>Marking {prog.label} as read… {prog.done}/{prog.total}</span><div className="bar"><i style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></div><button className="secondary" onClick={onCancel}>Cancel</button></>}
    </div>);
}

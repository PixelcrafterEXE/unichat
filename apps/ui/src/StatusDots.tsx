// The account status row at the bottom of the chat list: one provider icon per account with a coloured ring (state), full wording in the tooltip / aria-label.
import { useEffect, useRef, useState } from "react";
import type { Account } from "./types";
import { acctStatus } from "./relay";
import { ProviderIcon } from "./util";

/** Set before opening Settings to make the Accounts section scroll to (and highlight) one account's card. */
export const focusAccount: { id?: string } = {};

export type Ring = "ok" | "wait" | "bad" | "off" | "relay";
/** green = connected, amber = connecting / reconnecting, red = signed out / needs login, grey = archive only / history copy, dashed blue = used through another device */
export function ringOf(a: Account): Ring {
  const v = a.via;
  if (v) return v.kind === "relay" ? (a.state === "connected" ? "relay" : a.state === "connecting" || a.state === "disconnected" ? "wait" : "bad") : "off";
  switch (a.state) { case "connected": return "ok"; case "connecting": case "disconnected": return "wait"; default: return "bad"; }
}
export function statusText(a: Account): string {
  const st = acctStatus(a);
  const state = a.state === "needs-login" && !a.via ? (a.everLinked ? "Unlinked, sign in again" : "Waiting to link") : st.label;
  if (!a.via) return `${a.label}: ${state}`;
  return a.via.kind === "relay" ? `${a.label}: ${state} · ${st.note}` : `${a.label}: ${st.note}`;
}

export function StatusDots({ accounts, onOpen, loading }: { accounts: Account[]; onOpen: (a: Account) => void; loading?: boolean }) {
  const [tip, setTip] = useState<string>(); // touch: hold an icon to read its status (a tooltip needs a mouse)
  const timer = useRef<ReturnType<typeof setTimeout>>(), held = useRef(false), hideT = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(hideT.current); }, []);
  if (loading && !accounts.length) return <div className="accts dots loadingdots" role="status" aria-label="Loading accounts">{[0, 1, 2, 3].map((i) => <span key={i} className="adot skeldot" aria-hidden />)}</div>;
  if (!accounts.length) return <div className="accts empty">No accounts</div>;
  const show = (id: string) => { held.current = true; setTip(id); clearTimeout(hideT.current); hideT.current = setTimeout(() => setTip(undefined), 3500); };
  return (
    <div className="accts dots" role="list" aria-label="Accounts">
      {accounts.map((a) => {
        const t = statusText(a), ring = ringOf(a);
        return (
          <div key={a.id} role="listitem" className="adot">
            <button type="button" className={"ring " + ring} data-acct={a.id} data-via={a.via?.kind} data-ring={ring} data-state={a.state} title={t} aria-label={t}
              onTouchStart={() => { held.current = false; clearTimeout(timer.current); timer.current = setTimeout(() => show(a.id), 420); }}
              onTouchEnd={() => clearTimeout(timer.current)} onTouchMove={() => clearTimeout(timer.current)} onTouchCancel={() => clearTimeout(timer.current)}
              onContextMenu={(e) => { e.preventDefault(); show(a.id); }}
              onClick={(e) => { e.stopPropagation(); if (held.current) { held.current = false; return; } onOpen(a); }}>
              <ProviderIcon provider={a.provider} size={22} title="" />
            </button>
            {tip === a.id && <div className="ringtip" role="status" data-ringtip={a.id}>{t}</div>}
          </div>);
      })}
    </div>);
}

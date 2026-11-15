// How an account that is used through another of the user's devices looks (see docs: "Sending through another device").
// Wording is fixed here so the footer, account cards, filter menu and composer say the same thing.
import type { Account } from "./types";
export interface AcctStatus { /** class for the dot / pill (connected, signed-out, ...) */ cls: string; /** pill text */ label: string; /** one short line; undefined for ordinary accounts */ note?: string; kind?: NonNullable<Account["via"]>["kind"]; device?: string }
export function viaNote(v: NonNullable<Account["via"]>): string {
  switch (v.kind) {
    case "relay": return `via ${v.device}`;
    case "offline": return `Archive only — ${v.device} is offline`;
    case "ask": return `History copy — ask ${v.device} to allow sending`;
    case "denied": return `History copy — ${v.device} doesn't allow sending`;
  }
}
const PLAIN: Record<string, string> = { "signed-out": "Signed out", connected: "Connected", connecting: "Connecting…", disconnected: "Disconnected", "needs-login": "Unlinked" };
/** `plain` = the text the caller would show for an ordinary account in this state */
export function acctStatus(a: Account, plain?: string): AcctStatus {
  const v = a.via;
  if (!v) return { cls: a.state, label: plain ?? PLAIN[a.state] ?? a.state };
  const base = { note: viaNote(v), kind: v.kind, device: v.device };
  if (v.kind === "relay") return { ...base, cls: a.state === "connected" ? "connected" : a.state, label: a.state === "connected" ? "Connected" : plain ?? PLAIN[a.state] ?? a.state };
  return { ...base, cls: "signed-out", label: v.kind === "offline" ? "Archive only" : "History copy" };
}

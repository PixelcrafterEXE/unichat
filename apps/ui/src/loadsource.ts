// Where a chat's messages come from while it loads (another device, the messenger's phone, a server) and the words for it.
import type { Account, Chat, ProviderInfo } from "./types";

export interface LoadSource { kind: "offline" | "relay" | "phone" | "server"; /** device name, or provider name */ name: string; device?: string }
const PHONE = new Set(["whatsapp", "signal", "threema-md"]);

/** The source of a (possibly merged) chat: an offline holder wins (nothing will answer), then a relayed device, then a phone-linked messenger. */
export function sourceOf(chat: Chat, chats: Chat[], accounts: Account[], providers: ProviderInfo[]): LoadSource {
  const real = chat.mergeMembers?.length ? chat.mergeMembers.map((id) => chats.find((c) => c.id === id)).filter((c): c is Chat => !!c) : [chat];
  const srcs: LoadSource[] = real.map((c) => {
    const a = accounts.find((x) => x.id === c.accountId), name = providers.find((p) => p.name === (a?.provider ?? c.provider))?.displayName ?? c.provider;
    if (a?.via?.kind === "offline") return { kind: "offline", name, device: a.via.device };
    if (a?.via?.kind === "relay") return { kind: "relay", name, device: a.via.device };
    return { kind: PHONE.has(a?.provider ?? c.provider) ? "phone" : "server", name };
  });
  return srcs.every((s) => s.kind === "offline") ? srcs[0]! : srcs.find((s) => s.kind === "relay") ?? srcs.find((s) => s.kind === "phone") ?? srcs.find((s) => s.kind !== "offline") ?? srcs[0]!;
}
export const offlineLine = (s: LoadSource) => `${s.device} is offline. Showing what is saved on this device.`;
export const timeoutNote = (s: LoadSource) => `${s.kind === "relay" ? s.device : s.kind === "phone" ? "Your phone" : s.name} didn't answer in time. Showing what is saved here.`;
export function loadingLine(s: LoadSource | undefined, secs: number): string {
  if (!s) return secs < 6 ? "Loading messages…" : secs < 25 ? "Still loading… this messenger is slow to answer (it may be asking your phone)." : "This is taking long. You can use other chats meanwhile; this one fills in when the messages arrive.";
  if (s.kind === "offline") return offlineLine(s);
  const who = s.kind === "relay" ? s.device! : s.kind === "phone" ? "your phone" : s.name;
  if (secs < 8) return s.kind === "relay" ? `Loading from ${s.device}…` : s.kind === "phone" ? `Asking your phone via ${s.name}…` : `Asking ${s.name}…`;
  if (secs < 20) return `Still waiting for ${who}. ${s.kind === "server" ? "The service may be slow." : "Is it on and online?"}`;
  return `${who === "your phone" ? "Your phone" : who} is slow to answer. You can use other chats meanwhile; this one fills in when it answers.`;
}

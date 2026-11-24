// Network notices recognised by their shape, for copies that lost their `system` mark (issue #102).
// Up to 0.1.16 device sync dropped the mark when two copies of a message were merged. Where one device still had it, the
// one-time re-read in sync brought it back (WhatsApp's notices did come back that way). Signal's "safety number changed"
// lines did not: the phone had merged the desktop's unmarked copy too, so neither device had the mark any more.
// Signal writes these lines itself (provider-signal inbound.ts, info()) in fixed words, so they can be recognised.
// Kept narrow on purpose: only exact sentences, and nothing a person would send along (attachment, quote, poll, location).
import type { Message } from "./model.js";

const SIGNAL: RegExp[] = [
  /^Your safety number with [^\n]{1,80} has changed\.$/,
  /^[^\n]{1,80} (?:pinned|unpinned) a message$/,
  /^Disappearing messages: [^\n]{1,40}$/,
];

// Discord (provider-discord map.ts, type 18): "<name> started a thread: <title>" -- lines fetched by older versions came without the mark
const DISCORD: RegExp[] = [/^[^\n]{1,80} started a thread(?:: [^\n]{0,200})?$/];

/** Would the connector of `provider` have written this as a network notice? */
export function looksLikeNotice(provider: string, m: Message): boolean {
  if (m.system || m.deleted || (provider !== "signal" && provider !== "discord")) return false;
  if (m.attachments?.length || m.replyTo || m.poll || m.location || m.contacts?.length || m.forwarded || m.card) return false;
  const t = (m.text ?? "").trim();
  if (provider === "discord") return DISCORD.some((r) => r.test(t));
  if (m.id.startsWith("safety.")) return /safety number/i.test(t); // the connector's own id for exactly this line
  return SIGNAL.some((r) => r.test(t));
}

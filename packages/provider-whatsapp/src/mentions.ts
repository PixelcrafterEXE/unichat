// @mentions: composer spans <-> WhatsApp wire form. Pure helpers (no Baileys runtime, no logging).
// Wire form: contextInfo.mentionedJid = [jid...] and the text holds "@<user part of that jid>" where the mention stands.
// WhatsApp clients render those tokens as names themselves; we show names too (renderMentions).
import type { OutgoingMention } from "@unimsg/core";

/** What a member is called on the wire: the jid to put in mentionedJid. */
export interface MentionTarget { jid: string }

/**
 * Rewrite "@Name" spans into "@<digits>" tokens. `target` maps a Contact.id to the jid the group addresses that member by
 * (undefined = unknown member: the span is left as typed and not mentioned). Invalid / overlapping spans are skipped.
 * Returns the new text and the distinct mentioned jids (in text order).
 */
export function rewriteMentions(text: string, mentions: OutgoingMention[] | undefined, target: (id: string) => MentionTarget | undefined): { text: string; jids: string[] } {
  if (!mentions?.length) return { text, jids: [] };
  const spans = mentions
    .filter((m) => Number.isInteger(m.start) && Number.isInteger(m.length) && m.start >= 0 && m.length > 1 && m.start + m.length <= text.length && text[m.start] === "@")
    .sort((a, b) => a.start - b.start);
  const used: { m: OutgoingMention; t: MentionTarget }[] = [];
  let end = 0;
  for (const m of spans) {
    if (m.start < end) continue; // overlap
    const t = target(m.id);
    if (!t) continue;
    used.push({ m, t });
    end = m.start + m.length;
  }
  let out = "", pos = 0;
  const jids: string[] = [];
  for (const { m, t } of used) {
    out += text.slice(pos, m.start) + "@" + t.jid.slice(0, t.jid.indexOf("@"));
    pos = m.start + m.length;
    if (!jids.includes(t.jid)) jids.push(t.jid);
  }
  return { text: out + text.slice(pos), jids };
}

/**
 * Show "@<digits>" tokens of a received (or own, as stored) text as "@Name". `names` maps the user part of each mentioned jid
 * (any of its known forms, phone number and LID) to a display name. Tokens without a known name stay as they are.
 */
export function renderMentions(text: string, mentionedJid: readonly string[] | null | undefined, names: (jid: string) => { forms: string[]; name: string | undefined }): string {
  if (!text || !mentionedJid?.length) return text;
  const byUser = new Map<string, string>();
  for (const j of mentionedJid) {
    const { forms, name } = names(j);
    if (!name) continue;
    for (const f of [j, ...forms]) { const u = f.slice(0, f.indexOf("@")); if (u && !byUser.has(u)) byUser.set(u, name); }
  }
  if (!byUser.size) return text;
  return text.replace(/@(\d{5,})(?!\d)/g, (m, u: string) => { const n = byUser.get(u); return n ? "@" + n : m; });
}

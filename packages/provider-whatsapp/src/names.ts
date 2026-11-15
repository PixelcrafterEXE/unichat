// Pure naming helpers (offline-testable). Never returns a raw jid.
import { isLidJid } from "./map.js";

const CC1 = new Set(["1", "7"]);
const CC2 = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"]);

/** "491701234567@s.whatsapp.net" -> "+49 170 1234567". Heuristic country-code split; falls back to "+<digits>". */
export function formatPhone(digits: string): string {
  const d = digits.replace(/\D/g, "");
  if (!d) return "";
  const cc = CC1.has(d[0]!) ? d[0]! : CC2.has(d.slice(0, 2)) ? d.slice(0, 2) : d.slice(0, 3);
  const rest = d.slice(cc.length);
  if (rest.length < 5) return "+" + d;
  return rest.length > 7 ? `+${cc} ${rest.slice(0, 3)} ${rest.slice(3)}` : `+${cc} ${rest}`;
}

export interface NameSources { contact?: string; push?: string; verified?: string }
/** WhatsApp shows people who hide their number as a masked number ("+49∙∙∙∙∙∙∙∙78"): that is a placeholder, never a name. */
export const isMaskedName = (s: string | undefined | null): boolean => !!s && /[∙•·●*]{2,}/.test(s);
const clean = (s: string | undefined) => (s && s.trim() && !isMaskedName(s) ? s.trim() : undefined);

/**
 * Display name for a person. Precedence: saved contact name > push name > verified (business) name >
 * formatted phone number > "WhatsApp user" (unmapped @lid). A push name is what the person calls THEMSELVES (not a name from
 * your address book): WhatsApp shows it with a leading "~", and so do we ("~Lorenz").
 */
export function pickName(jid: string, src: NameSources): string {
  const saved = clean(src.contact);
  if (saved) return saved;
  const push = clean(src.push);
  if (push) return `~${push.replace(/^~\s*/, "")}`;
  const verified = clean(src.verified);
  if (verified) return verified;
  if (isLidJid(jid)) return "WhatsApp user";
  const phone = formatPhone(jid.slice(0, Math.max(0, jid.indexOf("@"))));
  return phone || "WhatsApp user";
}

/** Name for a group whose subject is empty: its first known members, or "Group". */
export function groupFallbackName(memberNames: string[], total: number): string {
  if (memberNames.length === 0) return "Group";
  const shown = memberNames.slice(0, 3).join(", ");
  const more = total - Math.min(3, memberNames.length);
  return more > 0 ? `${shown} +${more}` : shown;
}

// ---------------------------------------------------------------------------------------------------------------------
// Name / id sources beyond what Baileys 6.7.24 surfaces. All pure and offline-testable; callers never log the values.

const isLid = (j: string | undefined | null): j is string => !!j && j.endsWith("@lid");
const isPn = (j: string | undefined | null): j is string => !!j && (j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us"));
const bare = (j: string) => { const at = j.indexOf("@"); const user = (at < 0 ? j : j.slice(0, at)).split(":")[0]!; return at < 0 ? user : `${user}@${j.slice(at + 1) === "c.us" ? "s.whatsapp.net" : j.slice(at + 1)}`; };

/** What a HistorySync blob carries for names/ids that Baileys drops for every sync type except PUSH_NAME. */
export interface HistoryHarvest { pushnames: [id: string, name: string][]; pairs: [lid: string, pn: string][] }
export function harvestHistorySync(h: {
  pushnames?: { id?: string | null; pushname?: string | null }[] | null;
  phoneNumberToLidMappings?: { pnJid?: string | null; lidJid?: string | null }[] | null;
}): HistoryHarvest {
  const out: HistoryHarvest = { pushnames: [], pairs: [] };
  for (const p of h.pushnames ?? []) if (p.id && p.pushname?.trim()) out.pushnames.push([bare(p.id), p.pushname.trim()]);
  for (const m of h.phoneNumberToLidMappings ?? []) if (isLid(m.lidJid) && isPn(m.pnJid)) out.pairs.push([bare(m.lidJid), bare(m.pnJid)]);
  return out;
}

/** protocolMessage.lidMigrationMappingSyncMessage payload (decoded by the caller) -> lid/pn pairs. Ids arrive as numbers (Long). */
export function lidMigrationPairs(p: { pnToLidMappings?: { pn?: unknown; assignedLid?: unknown; latestLid?: unknown }[] | null }): [lid: string, pn: string][] {
  const out: [string, string][] = [];
  const digits = (v: unknown) => (v == null ? "" : String(v).replace(/\D/g, ""));
  for (const m of p.pnToLidMappings ?? []) {
    const pn = digits(m.pn);
    if (!pn || /^0+$/.test(pn)) continue;
    for (const l of new Set([digits(m.assignedLid), digits(m.latestLid)])) if (l) out.push([`${l}@lid`, `${pn}@s.whatsapp.net`]);
  }
  return out;
}

export interface NodeLike { tag: string; attrs?: Record<string, string>; content?: unknown }
export interface ParticipantInfo { lid?: string; pn?: string; name?: string }
const NAME_ATTRS = ["display_name", "notify", "pushname", "push_name"];
const WALK_TAGS = new Set(["iq", "notification"]);
/**
 * Find <participant> children (group info, add/promote notifications...) in a received stanza and read every name/id attribute
 * we know of. `attrNames` receives the NAMES (never values) of all attributes seen on participant nodes so a live run can tell
 * which attributes WhatsApp really sends.
 */
export function scanParticipants(root: NodeLike, attrNames?: Map<string, number>): ParticipantInfo[] {
  if (!WALK_TAGS.has(root.tag)) return [];
  const out: ParticipantInfo[] = [];
  let budget = 3000;
  const walk = (n: NodeLike, depth: number) => {
    if (budget-- <= 0 || depth > 7) return;
    if (n.tag === "participant" && n.attrs) {
      const a = n.attrs;
      if (attrNames) for (const k of Object.keys(a)) if (/^[a-z_]{1,24}$/.test(k)) attrNames.set(k, (attrNames.get(k) ?? 0) + 1);
      const lid = isLid(a.jid) ? a.jid : isLid(a.lid) ? a.lid : undefined;
      const pn = isPn(a.jid) ? a.jid : isPn(a.phone_number) ? a.phone_number : isPn(a.pn) ? a.pn : undefined;
      const name = NAME_ATTRS.map((k) => a[k]?.trim()).find((x) => !!x && !isMaskedName(x));
      if (name || (lid && pn)) out.push({ ...(lid ? { lid: bare(lid) } : {}), ...(pn ? { pn: bare(pn) } : {}), ...(name ? { name } : {}) });
    }
    if (Array.isArray(n.content)) for (const c of n.content) if (c && typeof c === "object" && "tag" in c) walk(c as NodeLike, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Counts of how the distinct senders of group messages are named (for the `names:` debug line). */
export function senderNameStats(ids: Iterable<string>, name: (id: string) => NameSources & { known: boolean }): { total: number; named: number; phone: number; unknown: number } {
  const r = { total: 0, named: 0, phone: 0, unknown: 0 };
  for (const id of ids) {
    r.total++;
    const s = name(id);
    if (s.contact?.trim() || s.push?.trim() || s.verified?.trim()) r.named++;
    else if (s.known) r.phone++;
    else r.unknown++;
  }
  return r;
}

// Group / community / security notices (WhatsApp "stub" messages) -> short English info text. Pure.
import type { Card } from "@unimsg/core";

import { proto } from "@whiskeysockets/baileys";
/** Readable name of a stub type (for counts-only diagnostics). */
export const stubName = (t: number): string => proto.WebMessageInfo.StubType[t] ?? `#${t}`;

export interface StubText { text: string; card?: Card }

/** Participant params are either a bare jid or a JSON object like {"id":"..@lid","phone_number":"..@s.whatsapp.net"}. */
export function stubJids(params: (string | null | undefined)[] | null | undefined): string[] {
  const out: string[] = [];
  for (const p of params ?? []) {
    if (!p) continue;
    if (p.startsWith("{")) {
      try {
        const o = JSON.parse(p) as { id?: string; jid?: string; phone_number?: string; lid?: string };
        const j = o.phone_number ?? o.jid ?? o.id ?? o.lid;
        if (j) out.push(j);
        continue;
      } catch { /* fall through: treat as plain */ }
    }
    if (p.includes("@")) out.push(p);
  }
  return out;
}

const YOU = "You";
const list = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
/** "You" becomes "you" when it is the object of a sentence. */
const obj = (names: string[]) => list(names.map((n) => (n === YOU ? "you" : n)));
/** Participants (strings in the stub params) may each carry several ids (phone number + LID): all of them, per participant. */
export function stubParticipants(params: (string | null | undefined)[] | null | undefined): string[][] {
  const out: string[][] = [];
  for (const p of params ?? []) {
    if (!p) continue;
    if (p.startsWith("{")) {
      try {
        const o = JSON.parse(p) as { id?: string; jid?: string; phone_number?: string; lid?: string };
        const ids = [o.phone_number, o.jid, o.id, o.lid].filter((x): x is string => !!x && x.includes("@"));
        if (ids.length) { out.push([...new Set(ids)]); continue; }
      } catch { /* plain */ }
    }
    if (p.includes("@")) out.push([p]);
  }
  return out;
}
const isYou = (n: string) => n === YOU;
const be = (names: string[]) => (names.length > 1 || (names.length === 1 && isYou(names[0]!)) ? "were" : "was");

export function ephemeralText(seconds: number): string {
  if (!seconds) return "Disappearing messages turned off";
  const d = seconds / 86400;
  const label = seconds === 86400 ? "24 hours" : seconds === 604800 ? "7 days" : seconds === 7776000 ? "90 days" : d >= 1 && Number.isInteger(d) ? `${d} days` : `${seconds} seconds`;
  return `Disappearing messages: ${label}`;
}

/**
 * @param actor display name of whoever caused it ("" if unknown), @param targets display names of the people it happened to.
 * Returns undefined for stub types that are noise (encryption banners, business labels, payments plumbing...).
 */
export function describeStub(type: number, params: (string | null | undefined)[] | null | undefined, actor: string, targets: string[]): StubText | undefined {
  const p0 = params?.[0] ?? "";
  const who = targets.length ? list(targets) : actor;
  const by = actor ? actor : "";
  const passive = (active: string, passiveText: string) => (by ? `${by} ${active}` : passiveText);
  switch (type) {
    case 20: return { text: p0 ? passive(`created the group "${p0}"`, `Group "${p0}" was created`) : passive("created the group", "The group was created") };
    case 21: return { text: p0 ? passive(`changed the group name to "${p0}"`, `The group name was changed to "${p0}"`) : "The group name was changed" };
    case 22: return { text: passive("changed the group icon", "The group icon was changed") };
    case 23: return { text: passive("reset the group invite link", "The group invite link was reset") };
    case 24: case 173: return { text: passive("changed the description", "The description was changed") };
    case 25: return { text: p0 === "on" ? "Only admins can edit the group info" : "All members can edit the group info" };
    case 26: return { text: p0 === "on" ? "Only admins can send messages" : "All members can send messages" };
    case 27: case 166: case 168: {
      if (!targets.length) return { text: by ? `${by} added someone` : "Someone was added" };
      return { text: by ? `${by} added ${obj(targets)}` : `${list(targets)} ${be(targets)} added` };
    }
    case 28: {
      if (!targets.length) return { text: by ? `${by} removed someone` : "Someone was removed" };
      return { text: by ? `${by} removed ${obj(targets)}` : `${list(targets)} ${be(targets)} removed` };
    }
    case 29: case 147: { const t = targets.length ? targets : by ? [by] : []; return { text: `${t.length ? list(t) : "Someone"} ${t.length > 1 || (t.length === 1 && isYou(t[0]!)) ? "are" : "is"} now ${t.length > 1 ? "admins" : "an admin"}` }; }
    case 30: case 148: { const t = targets.length ? targets : by ? [by] : []; return { text: `${t.length ? list(t) : "Someone"} ${t.length > 1 || (t.length === 1 && isYou(t[0]!)) ? "are" : "is"} no longer ${t.length > 1 ? "admins" : "an admin"}` }; }
    case 31: { const t = targets.length ? targets : by ? [by] : []; return { text: `${t.length ? list(t) : "Someone"} joined using ${t.length === 1 && isYou(t[0]!) ? "an" : "the"} invite link` }; }
    case 141: case 151: case 140: { const t = targets.length ? targets : by ? [by] : []; return { text: `${t.length ? list(t) : "Someone"} joined` }; }
    case 32: { const t = targets.length ? targets : by ? [by] : []; return { text: `${t.length ? list(t) : "Someone"} left` }; }
    case 33: case 42: return { text: `${who || "Someone"} changed their phone number` };
    case 43: return { text: "This group was deleted" };
    case 38: case 73: return { text: `${who || "Someone"}'s security code changed` };
    case 71: case 144: case 172: return { text: `${who || "Someone"} requested to join` };
    case 72: case 130: return { text: ephemeralText(Number(p0) || 0) };
    case 134: return { text: "This group was added to a community" };
    case 135: case 136: return { text: "A group was added to the community" };
    case 137: case 146: return { text: "This group was removed from its community" };
    case 138: case 139: return { text: "A group was removed from the community" };
    case 142: return { text: passive("created the community", "The community was created") };
    case 149: return { text: "The community was deleted" };
    case 158: return { text: p0 ? `The community name was changed to "${p0}"` : "The community name was changed" };
    case 171: return { text: p0 === "all_member_add" ? "All members can add people" : "Only admins can add people" };
    case 145: return { text: p0 === "on" ? "Joining now needs admin approval" : "Joining no longer needs admin approval" };
    case 40: return { text: "Missed voice call", card: { kind: "call", title: "Missed voice call" } };
    case 41: return { text: "Missed video call", card: { kind: "call", title: "Missed video call" } };
    case 45: return { text: "Missed group voice call", card: { kind: "call", title: "Missed group voice call" } };
    case 46: return { text: "Missed group video call", card: { kind: "call", title: "Missed group video call" } };
    case 169: return { text: "Voice call silenced (unknown caller)", card: { kind: "call", title: "Silenced voice call" } };
    case 170: return { text: "Video call silenced (unknown caller)", card: { kind: "call", title: "Silenced video call" } };
    case 184: return { text: "Scheduled call canceled", card: { kind: "call", title: "Scheduled call canceled" } };
    case 205: return { text: "An event was updated" };
    case 206: return { text: "An event was canceled" };
    case 74: return { text: "View-once message (already opened)" };
    case 68: return { text: "Message too large to show" };
    case 177: return { text: passive("pinned a message", "A message was pinned") };
    case 162: return { text: "Scheduled call started", card: { kind: "call", title: "Scheduled call started" } };
    case 181: return { text: "Group call started", card: { kind: "call", title: "Group call started" } };
    case 203: return { text: "This group was deactivated" };
    case 193: return { text: `${who || "Someone"} changed their username` };
    default: return undefined;
  }
}

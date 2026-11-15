// End-to-end message bodies (csp.struct.yml e2e section, csp-e2e.proto): parsing of incoming/reflected bodies and builders for outgoing ones.
import { cat, } from "./keys.js";
import { u64le } from "./csp.js";
import { decode, encode } from "./proto.js";
import { DeleteMessage, EditMessage, Reaction } from "./schemas.js";

export const Ty = {
  TEXT: 0x01, IMAGE: 0x02, LOCATION: 0x10, VIDEO: 0x13, AUDIO: 0x14, POLL_SETUP: 0x15, POLL_VOTE: 0x16, FILE: 0x17, CONTACT_PIC_SET: 0x18, CONTACT_PIC_DEL: 0x19, CONTACT_PIC_REQ: 0x1a,
  GROUP_TEXT: 0x41, GROUP_LOCATION: 0x42, GROUP_IMAGE: 0x43, GROUP_VIDEO: 0x44, GROUP_AUDIO: 0x45, GROUP_FILE: 0x46, GROUP_SETUP: 0x4a, GROUP_NAME: 0x4b, GROUP_LEAVE: 0x4c, GROUP_CALL_START: 0x4f,
  GROUP_PIC_SET: 0x50, GROUP_SYNC_REQ: 0x51, GROUP_POLL_SETUP: 0x52, GROUP_POLL_VOTE: 0x53, GROUP_PIC_DEL: 0x54,
  DELIVERY: 0x80, GROUP_DELIVERY: 0x81, REACTION: 0x82, GROUP_REACTION: 0x83, TYPING: 0x90, EDIT: 0x91, DELETE: 0x92, GROUP_EDIT: 0x93, GROUP_DELETE: 0x94, FS: 0xa0,
} as const;
export const FEATURE = { EDIT: 0x100n, DELETE: 0x200n, REACTION: 0x400n, POLL: 0x04n, FILE: 0x08n, GROUP: 0x02n } as const;
const MEMBER_BASE: Record<number, number> = { 0x41: 0x01, 0x42: 0x10, 0x43: 0x02, 0x44: 0x13, 0x45: 0x14, 0x46: 0x17, 0x52: 0x15, 0x53: 0x16, 0x81: 0x80, 0x83: 0x82, 0x93: 0x91, 0x94: 0x92, 0x4c: 0x4c, 0x4f: 0x4f };
const CREATOR_BASE: Record<number, number> = { 0x4a: 0x4a, 0x4b: 0x4b, 0x50: 0x18, 0x54: 0x19, 0x51: 0x51 };
export const GROUP_OF: Record<number, number> = { 0x01: 0x41, 0x10: 0x42, 0x17: 0x46, 0x15: 0x52, 0x16: 0x53, 0x82: 0x83, 0x91: 0x93, 0x92: 0x94, 0x02: 0x43 };
const ascii = (b: Uint8Array) => new TextDecoder().decode(b), td = new TextEncoder();
const u64 = (b: Uint8Array, o = 0) => new DataView(b.buffer, b.byteOffset, b.length).getBigUint64(o, true);

export const hexId = (id: bigint) => Buffer.from(u64le(id)).toString("hex"); // wire (LE) order: also the quote format
export const idFromHex = (h: string) => { const b = Buffer.from(h, "hex"); return b.length === 8 ? b.readBigUInt64LE(0) : 0n; };
export const randomId = () => { const b = new Uint8Array(8); crypto.getRandomValues(b); return u64(b) || 1n; };

export interface GroupRef { creator: string; id: bigint }
export const groupChatId = (g: GroupRef) => `${g.creator}/${hexId(g.id)}`;
export const parseGroupChatId = (s: string): GroupRef | undefined => { const m = /^([0-9A-Z*]{8})\/([0-9a-f]{16})$/.exec(s); return m ? { creator: m[1], id: idFromHex(m[2]) } : undefined; };

export interface Split { type: number; /** base (non-group) type */ group?: GroupRef; inner: Uint8Array }
/** Unwrap group containers. `sender` = the CSP sender (the creator for creator-containers). */
export function split(type: number, body: Uint8Array, sender: string): Split | undefined {
  if (type in MEMBER_BASE) { if (body.length < 16) return undefined; return { type: MEMBER_BASE[type], group: { creator: ascii(body.subarray(0, 8)), id: u64(body, 8) }, inner: body.subarray(16) }; }
  if (type in CREATOR_BASE) { if (body.length < 8) return undefined; return { type: CREATOR_BASE[type], group: { creator: sender, id: u64(body, 0) }, inner: body.subarray(8) }; }
  return { type, inner: body };
}
export function wrapGroup(type: number, g: GroupRef, inner: Uint8Array, meIsCreatorContainer = false): { type: number; body: Uint8Array } {
  if (meIsCreatorContainer) return { type, body: cat(u64le(g.id), inner) };
  return { type: GROUP_OF[type] ?? type, body: cat(td.encode(g.creator), u64le(g.id), inner) };
}

export type FileInfo = { kind: number; mime: string; name?: string; size?: number; blobId: string; key: string; thumbBlobId?: string; thumbMime?: string; caption?: string; w?: number; h?: number; animated?: boolean; durationS?: number };
export type Parsed =
  | { k: "text"; text: string } | { k: "file"; f: FileInfo } | { k: "legacy-image"; blobId: string; size: number; nonce: Uint8Array }
  | { k: "location"; lat: number; lng: number; name?: string; address?: string }
  | { k: "poll-setup"; id: bigint; d: string; closed: boolean; multiple: boolean; choices: { id: number; name: string }[]; votes?: Record<string, number[]> }
  | { k: "poll-vote"; creator: string; id: bigint; choices: [number, number][] }
  | { k: "receipt"; status: number; ids: bigint[] } | { k: "typing"; on: boolean }
  | { k: "reaction"; id: bigint; emoji: string; withdraw: boolean } | { k: "edit"; id: bigint; text: string } | { k: "delete"; id: bigint }
  | { k: "group-setup"; members: string[] } | { k: "group-name"; name: string } | { k: "group-leave" } | { k: "group-sync-request" }
  | { k: "profile-picture"; blobId: string; key: string } | { k: "profile-picture-delete" } | { k: "profile-picture-request" }
  | { k: "other"; type: number };

export function parseInner(type: number, d: Uint8Array): Parsed {
  try {
    switch (type) {
      case Ty.TEXT: return { k: "text", text: ascii(d) };
      case Ty.FILE: {
        const j = JSON.parse(ascii(d)); const m = j.x ?? {};
        const kind = typeof j.j === "number" ? j.j : j.i === 1 ? 1 : 0;
        return { k: "file", f: { kind, mime: String(j.m ?? "application/octet-stream"), name: j.n, size: j.s, blobId: String(j.b), key: String(j.k), thumbBlobId: j.t, thumbMime: j.p, caption: j.d, w: m.w, h: m.h, animated: m.a === true, durationS: m.d } };
      }
      case Ty.IMAGE: return d.length >= 44 ? { k: "legacy-image", blobId: Buffer.from(d.subarray(0, 16)).toString("hex"), size: new DataView(d.buffer, d.byteOffset).getUint32(16, true), nonce: d.slice(20, 44) } : { k: "other", type };
      case Ty.LOCATION: {
        const lines = ascii(d).split("\n"); const [lat, lng] = lines[0].split(",").map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { k: "other", type };
        const rest = lines.slice(1);
        return rest.length >= 2 ? { k: "location", lat, lng, name: rest[0], address: rest[1].replace(/\\n/g, "\n") } : { k: "location", lat, lng, address: rest[0]?.replace(/\\n/g, "\n") };
      }
      case Ty.POLL_SETUP: {
        const j = JSON.parse(ascii(d.subarray(8))); const choices = (j.c ?? []).map((c: any) => ({ id: Number(c.i), name: String(c.n) }));
        let votes: Record<string, number[]> | undefined;
        if (j.s === 1 && Array.isArray(j.p)) { votes = {}; (j.p as string[]).forEach((p, idx) => { votes![p] = (j.c as any[]).filter((c) => c.r?.[idx]).map((c) => Number(c.i)); }); }
        return { k: "poll-setup", id: u64(d, 0), d: String(j.d ?? ""), closed: j.s === 1, multiple: j.a === 1, choices, votes };
      }
      case Ty.POLL_VOTE: return { k: "poll-vote", creator: ascii(d.subarray(0, 8)), id: u64(d, 8), choices: JSON.parse(ascii(d.subarray(16))) };
      case Ty.DELIVERY: { const ids: bigint[] = []; for (let o = 1; o + 8 <= d.length; o += 8) ids.push(u64(d, o)); return { k: "receipt", status: d[0], ids }; }
      case Ty.TYPING: return { k: "typing", on: d[0] === 1 };
      case Ty.REACTION: { const m = decode(Reaction, d); const e = m.apply ?? m.withdraw; return { k: "reaction", id: m.messageId, emoji: e ? ascii(e) : "", withdraw: !m.apply }; }
      case Ty.EDIT: { const m = decode(EditMessage, d); return { k: "edit", id: m.messageId, text: m.text ?? "" }; }
      case Ty.DELETE: return { k: "delete", id: decode(DeleteMessage, d).messageId };
      case Ty.GROUP_SETUP: { const members: string[] = []; for (let o = 0; o + 8 <= d.length; o += 8) members.push(ascii(d.subarray(o, o + 8))); return { k: "group-setup", members }; }
      case Ty.GROUP_NAME: return { k: "group-name", name: ascii(d) };
      case Ty.GROUP_LEAVE: return { k: "group-leave" };
      case Ty.GROUP_SYNC_REQ: return { k: "group-sync-request" };
      case Ty.CONTACT_PIC_SET: return d.length >= 52 ? { k: "profile-picture", blobId: Buffer.from(d.subarray(0, 16)).toString("hex"), key: Buffer.from(d.subarray(20, 52)).toString("hex") } : { k: "other", type };
      case Ty.CONTACT_PIC_DEL: return { k: "profile-picture-delete" };
      case Ty.CONTACT_PIC_REQ: return { k: "profile-picture-request" };
      default: return { k: "other", type };
    }
  } catch { return { k: "other", type }; }
}

// ---- builders ----
export const textBody = (t: string) => td.encode(t);
export const locationBody = (l: { lat: number; lng: number; name?: string; address?: string }) =>
  td.encode(`${l.lat},${l.lng}` + (l.name ? `\n${l.name}\n${(l.address ?? "").replace(/\n/g, "\\n")}` : l.address ? `\n${l.address.replace(/\n/g, "\\n")}` : ""));
export const quoteText = (quotedId: bigint, comment: string) => `> quote #${hexId(quotedId)}\n\n${comment}`;
export const QUOTE_RE = /^> quote #([0-9a-f]{16})(?:\r?\n){2}([\s\S]*)$/;
export const deliveryBody = (status: number, ids: bigint[]) => cat(Uint8Array.of(status), ...ids.map(u64le));
export const typingBody = (on: boolean) => Uint8Array.of(on ? 1 : 0);
export const reactionBody = (id: bigint, emoji: string, withdraw: boolean) => encode(Reaction, { messageId: id, [withdraw ? "withdraw" : "apply"]: td.encode(emoji) });
export const editBody = (id: bigint, text: string) => encode(EditMessage, { messageId: id, text });
export const deleteBody = (id: bigint) => encode(DeleteMessage, { messageId: id });
export function fileBody(f: { kind: number; mime: string; name?: string; size: number; blobId: string; key: string; caption?: string; w?: number; h?: number; animated?: boolean; durationS?: number }): Uint8Array {
  const x: Record<string, unknown> = {};
  if (f.w) x.w = f.w; if (f.h) x.h = f.h; if (f.animated) x.a = true; if (f.durationS) x.d = f.durationS;
  return td.encode(JSON.stringify({ j: f.kind, i: f.kind ? 1 : 0, k: f.key, b: f.blobId, m: f.mime, ...(f.name ? { n: f.name } : {}), s: f.size, ...(f.caption ? { d: f.caption } : {}), ...(Object.keys(x).length ? { x } : {}) }));
}
export const pollSetupBody = (id: bigint, q: string, options: string[], multiple: boolean) =>
  cat(u64le(id), td.encode(JSON.stringify({ d: q, s: 0, a: multiple ? 1 : 0, t: 1, u: 0, o: 0, c: options.map((n, i) => ({ i, n, o: i })) })));
export const pollVoteBody = (creator: string, id: bigint, choices: [number, number][]) => cat(td.encode(creator), u64le(id), td.encode(JSON.stringify(choices)));
export const groupSetupBody = (members: string[]) => cat(...members.map((m) => td.encode(m)));

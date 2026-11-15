// Contact sync: SyncMessage.Contacts points at a CDN blob (see attachments.ts) containing a stream of
// [varint length][ContactDetails][avatar bytes, `avatar.length` of them, if present].
import { Aci } from "@signalapp/libsignal-client";
import { toBytes } from "../protocol/bytes.js";
import { ContactDetailsCodec } from "../protocol/codec.js";
import { cleanName } from "./profileCrypto.js";
import type { ContactRecord } from "../store/types.js";

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0, shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("truncated contact stream");
    const b = buf[pos++]!;
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7;
    if (shift > 35) throw new Error("bad varint");
  }
}

export function parseContactStream(buf: Uint8Array): (ContactRecord & { expireTimer?: number })[] {
  const out: (ContactRecord & { expireTimer?: number })[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let len: number;
    [len, pos] = readVarint(buf, pos);
    if (pos + len > buf.length) throw new Error("truncated contact record");
    const d = ContactDetailsCodec.decode(buf.subarray(pos, pos + len));
    pos += len;
    pos += d.avatar?.length ?? 0; // avatars are skipped (TODO: load them as Chat.avatarUrl)
    const aci = d.aci || (d.aciBinary && d.aciBinary.length === 16 ? Aci.fromUuidBytes(toBytes(d.aciBinary)).getRawUuid() : undefined);
    if (!aci) continue; // number-only legacy entries cannot be addressed
    out.push({ aci: aci.toLowerCase(), number: d.number || undefined, name: d.name || undefined, ...(d.expireTimer !== undefined ? { expireTimer: d.expireTimer } : {}) });
  }
  return out;
}

/** Test helper / fixture builder: serialise contacts the way a primary device does. */
export function buildContactStream(contacts: { aci: string; number?: string; name?: string; expireTimer?: number }[]): Buffer {
  const parts: Buffer[] = [];
  for (const c of contacts) {
    const body = Buffer.from(ContactDetailsCodec.encode({ aci: c.aci, number: c.number, name: c.name, ...(c.expireTimer !== undefined ? { expireTimer: c.expireTimer } : {}) }));
    const len: number[] = []; let n = body.length;
    while (n > 0x7f) { len.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
    len.push(n);
    parts.push(Buffer.from(len), body);
  }
  return Buffer.concat(parts);
}

/**
 * The single resolved display name of a contact (`contact.name`), from the separately kept parts:
 * nickname (set in Signal) > address-book name (storage or contact-sync) > profile name (storage). A contact with none of the
 * parts keeps whatever `name` it already had (stores from before the parts existed).
 */
export function resolveContactName(c: ContactRecord): void {
  const ok = (v?: string) => cleanName(v);
  c.name = ok(c.nickName) || ok(c.systemName) || ok(c.syncName) || ok(c.profileName) || ok(c.name);
}

// Signal "Secure Backups" (the 2025 format used by Signal Android/iOS: one encrypted, gzip-compressed stream of BackupInfo + Frame
// protobufs). Parsing and validation are done by libsignal itself (its BackupJsonExporter turns Frames into JSON), so this file only
//   1. authenticates and decrypts the container:  IV(16) || AES-256-CBC(gzip(varint-delimited protos)) || HMAC-SHA256(32) over IV||ciphertext,
//      keys from MessageBackupKey({accountEntropy: the 64-character backup key / AEP, aci}) (libsignal derives them),
//   2. maps the JSON of recipients / chats / chat items to UniChat messages.
// Media of an ON-DEVICE (folder) backup lives beside `main`, not in it (Signal-Android LocalArchiver / lib/archive Backup.proto):
//   - every attachment's FilePointer.locatorInfo carries `plaintextHash`, `size` and `localKey` (64 bytes: AES-256 key || HMAC-SHA256 key),
//   - the file is  files/<xx>/<name>  with name = hex(sha256(plaintextHash || localKey)) and xx its first two hex chars; the shared `files/`
//     directory is next to the snapshot folder (or inside it); the snapshot's own `files` FILE is only an index of names (FilesFrame) and is not needed,
//   - file layout (AttachmentCipherOutputStream): IV(16) || AES-256-CBC/PKCS7(padded plaintext) || HMAC-SHA256(IV||ciphertext)(32); the plaintext is
//     zero-padded to a size bucket, so it is cut to `size` and checked against `plaintextHash`.
// mediaRootBackupKey / deriveMediaId / deriveMediaEncryptionKey belong to the REMOTE media tier (CDN), not to local backups: not used here.
// A single-file backup (or a folder without media) has no files: its messages carry "[Photo]"-style placeholders.
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { BackupError } from "../container.js";
import type { Message, Reaction } from "../model.js";
import { readVarint } from "./proto.js";
import type { HistorySource, RunOptions, RunStats } from "./legacysource.js";
import type { Attachment } from "../model.js";
import { attachmentKind, groupNativeId, iso, isUuid, normAci, ourMsgId, placeholder, timerText, VIEW_ONCE_TEXT, type BackupIdentity, type ImportChat, type ImportedAttachment, type ImportedMessage } from "./model.js";

type Lib = { MessageBackupKey: any; BackupJsonExporter: any; GroupSecretParams: any; GroupMasterKey: any; Aci: any; AccountEntropyPool: any };
async function lib(): Promise<Lib> {
  try {
    const base = "@signalapp/libsignal-client/dist/";
    // bundled hosts (Android) cannot resolve the computed specifiers below: they pre-register the four modules here (apps/android/src/libsignal-modules.ts)
    const pre = (globalThis as any).__unimsgLibsignalModules as Record<string, any> | undefined;
    const imp = (f: string) => pre?.[f] ?? import(base + f);
    const [mb, addr, zk, ak] = await Promise.all([imp("MessageBackup.js"), imp("Address.js"), imp("zkgroup/index.js"), imp("AccountKeys.js")]);
    return { MessageBackupKey: mb.MessageBackupKey, BackupJsonExporter: mb.BackupJsonExporter, GroupSecretParams: zk.GroupSecretParams, GroupMasterKey: zk.GroupMasterKey, Aci: addr.Aci, AccountEntropyPool: ak.AccountEntropyPool };
  } catch { throw new BackupError("unsupported-version", "Signal's backup library is not available in this build, so new-format (Secure Backup) files cannot be read here."); }
}
/** Signal shows the key in capitals with the letter O as "#" and the digit 0 as "=" (AccountEntropyPool.CHARACTER_DISPLAY_MAP): undo that. */
export const normalizeBackupKey = (s: string) => String(s ?? "").replace(/[\s\-]/g, "").replace(/#/g, "o").replace(/=/g, "0").toLowerCase();
export const looksLikeBackupKey = (s: string) => /^[a-z0-9]{64}$/.test(normalizeBackupKey(s));

const uuidFromB64 = (b: string | undefined): string | undefined => { if (!b) return undefined; const x = Buffer.from(b, "base64"); if (x.length !== 16) return undefined; const h = x.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };
const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const n = (v: unknown): number | undefined => { const x = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(x) ? x : undefined; };

/** Decrypts one media file of an on-device backup; undefined when it is damaged, tampered with or does not match its hash. */
export function decryptLocalMedia(file: Buffer, localKey: Buffer, size: number, plaintextHash?: Buffer): Buffer | undefined {
  if (localKey.length !== 64 || file.length < 16 + 16 + 32 || (file.length - 48) % 16) return undefined;
  const body = file.subarray(0, file.length - 32), mac = createHmac("sha256", localKey.subarray(32)).update(body).digest();
  if (!timingSafeEqual(mac, file.subarray(file.length - 32))) return undefined;
  try {
    const d = createDecipheriv("aes-256-cbc", localKey.subarray(0, 32), body.subarray(0, 16));
    const plain = Buffer.concat([d.update(body.subarray(16)), d.final()]);
    if (plain.length < size) return undefined;
    const out = plain.subarray(0, size);
    if (plaintextHash?.length && !createHash("sha256").update(out).digest().equals(plaintextHash)) return undefined;
    return out;
  } catch { return undefined; }
}
export const localMediaName = (plaintextHash: Buffer, localKey: Buffer) => createHash("sha256").update(plaintextHash).update(localKey).digest("hex");
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** The shared media directory of an on-device backup: `files/` inside the snapshot folder, else beside it. */
export function findMediaDir(mainFile: string): string | undefined {
  const here = dirname(mainFile);
  for (const c of [join(here, "files"), join(dirname(here), "files")]) if (isDir(c)) return c;
  return undefined;
}
interface MediaRef { name: string; key: Buffer; hash?: Buffer; size: number }

interface Rec { id: string; profileKey?: string; aci?: string; e164?: string; pni?: string; name?: string; self?: boolean; groupId?: string; title?: string }

export class SecureSource implements HistorySource {
  readonly format = "secure-backup" as const;
  identity: BackupIdentity = {};
  private constructor(private file: string, readonly size: number, private lib: Lib, private key: any, private aci: string) { this.identity = { aci }; }
  get dbVersion() { return undefined; }
  /** a media folder ("files/") was found beside this backup */
  get hasMedia() { return !!findMediaDir(this.file); }

  static async open(file: string, input: string, o: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void; aci?: string; /** the 36-byte `metadata` file of an on-device (folder) backup: carries the encrypted backup id, so no account id is needed */ metadata?: Buffer }): Promise<SecureSource> {
    const L = await lib();
    if (!looksLikeBackupKey(input)) throw new BackupError("bad-passphrase", "Enter the 64-character backup key (Signal > Settings > Backups > View backup key).");
    const aci = normAci(o.aci);
    let key: any;
    if (o.metadata) { // on-device backup folder: backup id = AES-CTR(metadata key from the backup key, nonce) of the id stored in `metadata`
      const m = o.metadata, iv = m.subarray(6, 18), encId = m.subarray(20, 36);
      if (m.length < 36 || m[2] !== 0x12 || iv.length !== 12 || encId.length !== 16) throw new BackupError("not-a-backup", "The metadata file is not from a Signal on-device backup.");
      try {
        const bk = L.AccountEntropyPool.deriveBackupKey(normalizeBackupKey(input));
        const d = createDecipheriv("aes-256-ctr", Buffer.from(bk.deriveLocalBackupMetadataKey()), Buffer.concat([iv, Buffer.alloc(4)]));
        key = new L.MessageBackupKey({ backupKey: bk, backupId: Buffer.concat([d.update(encId), d.final()]) });
      } catch { throw new BackupError("bad-passphrase", "That is not a valid Signal backup key."); }
    } else {
      if (!isUuid(aci)) throw new BackupError("invalid", "Choose the (signed-in) Signal account this backup belongs to: its account id is part of the decryption key.");
      try { key = new L.MessageBackupKey({ accountEntropy: normalizeBackupKey(input), aci: L.Aci.fromUuid(aci) }); } catch { throw new BackupError("bad-passphrase", "That is not a valid Signal backup key."); }
    }
    const fh = await open(file, "r"); let size: number;
    try { size = (await fh.stat()).size; } finally { await fh.close(); }
    if (size < 16 + 16 + 32) throw new BackupError("not-a-backup", "This file is too small to be a Signal backup.");
    // authenticate the whole file before anything is read from it
    const mac = createHmac("sha256", Buffer.from(key.hmacKey)); let seen = 0;
    const tail: Buffer[] = [];
    for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      if (o.signal?.aborted) throw new BackupError("cancelled", "Cancelled.");
      const end = seen + chunk.length, bodyEnd = size - 32;
      if (seen < bodyEnd) mac.update(chunk.subarray(0, Math.min(chunk.length, bodyEnd - seen)));
      if (end > bodyEnd) tail.push(chunk.subarray(Math.max(0, bodyEnd - seen)));
      seen = end; o.onProgress?.(seen, size);
    }
    const theirs = Buffer.concat(tail), ours = mac.digest();
    if (theirs.length !== 32 || !timingSafeEqual(ours, theirs)) throw new BackupError("bad-passphrase", "Wrong backup key or account, or the file is damaged or not a Signal Secure Backup. Nothing was imported.");
    return new SecureSource(file, size, L, key, aci ?? "");
  }

  private async *frames(signal?: AbortSignal): AsyncGenerator<{ info?: Buffer; frames?: Buffer }> {
    const rs = createReadStream(this.file, { start: 0, end: 15, highWaterMark: 16 }); const ivb: Buffer[] = []; for await (const c of rs as AsyncIterable<Buffer>) ivb.push(c);
    const iv = Buffer.concat(ivb), dec = createDecipheriv("aes-256-cbc", Buffer.from(this.key.aesKey), iv), gz = createGunzip({ finishFlush: 2 /* Z_SYNC_FLUSH: tolerate zero padding */ });
    const src = createReadStream(this.file, { start: 16, end: this.size - 33, highWaterMark: 1 << 20 });
    src.on("error", (e) => dec.destroy(e)); dec.on("error", (e) => gz.destroy(e));
    src.pipe(dec).pipe(gz);
    let buf: Buffer = Buffer.alloc(0), first = true, pending: Buffer[] = [], pendingBytes = 0;
    try {
      for await (const chunk of gz as AsyncIterable<Buffer>) {
        if (signal?.aborted) throw new BackupError("cancelled", "Cancelled.");
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          const l = readVarint(buf, 0); if (!l) break;
          if (l.v > 64 * 1024 * 1024) throw new BackupError("corrupt", "This backup contains an oversized record.");
          if (buf.length < l.next + l.v) break;
          const body = buf.subarray(l.next, l.next + l.v), whole = buf.subarray(0, l.next + l.v);
          if (first) { first = false; yield { info: Buffer.from(body) }; }
          else { pending.push(Buffer.from(whole)); pendingBytes += whole.length; if (pendingBytes > 256 * 1024) { yield { frames: Buffer.concat(pending) }; pending = []; pendingBytes = 0; } }
          buf = buf.subarray(l.next + l.v);
        }
        if (buf.length > 64 * 1024 * 1024) throw new BackupError("corrupt", "This backup contains an oversized record.");
      }
    } catch (e) { if (e instanceof BackupError) throw e; throw new BackupError("corrupt", "This backup could not be decrypted or decompressed (wrong key, wrong account, or damaged file)."); }
    if (pending.length) yield { frames: Buffer.concat(pending) };
  }

  async run(o: RunOptions): Promise<RunStats> {
    const L = this.lib, ownAci = normAci(o.ownAci) ?? this.aci;
    const stats: RunStats = { messages: 0, skipped: {}, chats: [], attachments: { listed: 0, bytes: 0, stored: 0, missing: 0 }, legacyGroupsSkipped: 0, unresolvedChats: 0, warnings: [] };
    const skip = (k: string) => { stats.skipped[k] = (stats.skipped[k] ?? 0) + 1; };
    const recipients = new Map<string, Rec>(), chatRec = new Map<string, string>(), chats = new Map<string, ImportChat>();
    const groupId = (mk: string): string | undefined => { try { const k = Buffer.from(mk, "base64"); return groupNativeId(L.GroupSecretParams.deriveFromMasterKey(new L.GroupMasterKey(k)).getPublicParams().getGroupIdentifier().serialize()); } catch { return undefined; } };
    const person = (rid: string | undefined): { id: string; name: string; self: boolean; unresolved?: boolean } | undefined => {
      const r = rid ? recipients.get(rid) : undefined; if (!r) return undefined;
      if (r.self) return { id: ownAci, name: "Me", self: true };
      const aci = r.aci ?? (r.e164 ? o.resolveE164?.(r.e164) : undefined);
      if (aci) return { id: aci, name: r.name ?? r.e164 ?? "Unknown", self: aci === ownAci };
      if (r.e164) return { id: `e164:${r.e164}`, name: r.name ?? r.e164, self: false, unresolved: true };
      return undefined;
    };
    const chatOf = (chatId: string | undefined): ImportChat | undefined => {
      if (!chatId) return undefined; const hit = chats.get(chatId); if (hit) return hit;
      const r = recipients.get(chatRec.get(chatId) ?? ""); if (!r) return undefined;
      let c: ImportChat;
      if (r.groupId) c = { id: r.groupId, kind: "group", name: r.title, count: 0 };
      else { const p = person(r.id); if (!p) return undefined; c = { id: p.id, kind: "dm", name: p.self ? "Note to Self" : p.name, count: 0, ...(p.unresolved ? { unresolved: true } : {}) }; }
      chats.set(chatId, c); return c;
    };
    let ex: any;
    let mapped = 0;
    const mediaDir = o.attachments ? findMediaDir(this.file) : undefined, refs = new Map<string, MediaRef>();
    const mediaPath = (name: string) => (mediaDir ? join(mediaDir, name.slice(0, 2), name) : undefined);
    for await (const part of this.frames(o.signal)) {
      if (part.info) { ex = L.BackupJsonExporter.start(part.info, { validate: false }).exporter; continue; }
      const lines = ex.exportFrames(part.frames!) as { line?: string }[];
      for (const { line } of lines) {
        if (!line) continue; let f: any; try { f = JSON.parse(line); } catch { continue; }
        if (f.recipient) {
          const r = f.recipient, id = s(r.id); if (!id) continue;
          const rec: Rec = { id };
          if (r.self) rec.self = true;
          if (r.contact) { const c = r.contact; rec.aci = uuidFromB64(c.aci); rec.pni = c.pni ? uuidFromB64(c.pni) : undefined; rec.e164 = c.e164 ? `+${c.e164}` : undefined; const nm = (a?: string, b?: string) => [a, b].filter(Boolean).join(" ") || undefined;
            const pk = typeof c.profileKey === "string" ? c.profileKey : undefined; if (pk && Buffer.from(pk, "base64").length === 32) rec.profileKey = pk;
            rec.name = nm(c.nickname?.given, c.nickname?.family) || nm(c.systemGivenName, c.systemFamilyName) || nm(c.profileGivenName, c.profileFamilyName) || c.username; }
          if (r.group) { rec.groupId = r.group.masterKey ? groupId(r.group.masterKey) : undefined; rec.title = r.group.snapshot?.title?.title; }
          recipients.set(id, rec);
        } else if (f.chat) { const id = s(f.chat.id), rid = s(f.chat.recipientId); if (id && rid) chatRec.set(id, rid); }
        else if (f.chatItem) {
          const m = this.mapItem(f.chatItem, { person, chatOf, ownAci, o, recipients, refs, have: (name) => { const p = mediaPath(name); return !!p && existsSync(p); } }); if ("skip" in m) { skip(m.skip); continue; }
          const im = m.ok; stats.attachments.listed += m.listed.n; stats.attachments.bytes += m.listed.bytes; const c = im.chat, t = Date.parse(im.message.time); c.count++; if (c.first === undefined || t < c.first) c.first = t; if (c.last === undefined || t > c.last) c.last = t;
          // decrypt first: an attachment that cannot be read (damaged, tampered, wrong hash) is dropped from the message again
          const blobs: { part: ImportedAttachment; data: Buffer }[] = [];
          for (const part of im.attachments) {
            const ref = refs.get(part.partKey), p = mediaPath(part.partKey); let data: Buffer | undefined;
            if (ref && p) { try { data = decryptLocalMedia(readFileSync(p), ref.key, ref.size, ref.hash); } catch { /* unreadable */ } }
            if (data) blobs.push({ part, data });
          }
          if (blobs.length < im.attachments.length) {
            const bad = im.attachments.filter((x) => !blobs.some((b) => b.part === x));
            im.attachments = blobs.map((b) => b.part); im.message.attachments = im.attachments.length ? im.attachments.map((x) => x.att) : undefined;
            if (!im.message.attachments) delete im.message.attachments;
            if (!im.attachments.length && !im.message.text) { const k = bad[0]!.att; im.message.text = placeholder(k.kind, k.name); }
          }
          stats.messages++; mapped++; await o.onMessage(im);
          for (const b of blobs) { await o.onBlob(b.part, im, b.data); stats.attachments.stored++; }
          refs.clear();
        }
      }
      o.onProgress?.(Math.min(this.size, mapped * 200), this.size);
    }
    stats.contacts = [...recipients.values()].flatMap((r) => (r.aci && !r.self && isUuid(normAci(r.aci)) ? [{ aci: normAci(r.aci)!, ...(r.profileKey ? { profileKey: r.profileKey } : {}), ...(r.name ? { name: r.name } : {}), ...(r.e164 ? { e164: r.e164 } : {}), ...(r.pni && isUuid(normAci(r.pni)) ? { pni: normAci(r.pni)! } : {}) }] : []));
    stats.chats = [...new Map([...chats.values()].filter((c) => c.count > 0).map((c) => [c.id, c])).values()];
    for (const c of stats.chats) { stats.first = Math.min(stats.first ?? Infinity, c.first ?? Infinity); stats.last = Math.max(stats.last ?? 0, c.last ?? 0); }
    if (stats.first === Infinity) stats.first = undefined;
    stats.unresolvedChats = stats.chats.filter((c) => c.unresolved).length;
    stats.attachments.missing = o.attachments ? Math.max(0, stats.attachments.listed - stats.attachments.stored) : stats.attachments.listed;
    if (o.attachments && !mediaDir && stats.attachments.listed) stats.warnings.push("No media folder (\"files\") was found next to this backup, so photos, videos and files appear as [Photo]/[Video]/[File] placeholders. Choose the main file inside the backup folder.");
    else if (!o.attachments && stats.attachments.listed) stats.warnings.push("Media was not requested: photos, videos and files appear as [Photo]/[Video]/[File] placeholders.");
    if (stats.unresolvedChats) stats.warnings.push(`${stats.unresolvedChats} conversations only know a phone number, not a Signal account id. They are imported as separate chats named by number.`);
    return stats;
  }

  private mapItem(it: any, c: { person(r?: string): { id: string; name: string; self: boolean } | undefined; chatOf(id?: string): ImportChat | undefined; ownAci: string; o: RunOptions; recipients: Map<string, Rec>; refs: Map<string, MediaRef>; have(name: string): boolean }): { ok: ImportedMessage; listed: { n: number; bytes: number } } | { skip: string } {
    const sent = n(it.dateSent); if (!sent) return { skip: "bad-time" };
    if ((c.o.since !== undefined && sent < c.o.since) || (c.o.until !== undefined && sent > c.o.until)) return { skip: "range" };
    const chat = c.chatOf(s(it.chatId)); if (!chat) return { skip: "no-chat" };
    const outgoing = !!it.outgoing, directionless = !!it.directionless;
    const who = outgoing ? { id: c.ownAci, name: "Me", self: true } : c.person(s(it.authorId)) ?? (chat.kind === "dm" ? { id: chat.id, name: chat.name ?? "Unknown", self: false } : undefined);
    if (!who) return { skip: "no-chat" };
    const mentionName = (aciB64: string | undefined) => { const a = uuidFromB64(aciB64); if (a === c.ownAci) return "me"; const r = [...c.recipients.values()].find((x) => x.aci === a); return r?.name ?? r?.e164 ?? "someone"; };
    const body = (t: any): string => { let text = String(t?.body ?? ""); if (text.includes("￼")) { const rs = ((t?.bodyRanges ?? []) as any[]).filter((r) => r.mentionAci).sort((a, b) => (n(a.start) ?? 0) - (n(b.start) ?? 0)); let i = 0; text = text.replace(/￼/g, () => "@" + (rs[i] ? mentionName(rs[i++]!.mentionAci) : "someone")); } return text; };
    let text = "", system = false, deleted = false, card: Message["card"], contacts: Message["contacts"]; let reactions: any[] | undefined, quote: any;
    type Raw = { ct: string; name?: string; voice: boolean; gif: boolean; w?: number; h?: number; size: number; ref?: MediaRef };
    const raw: Raw[] = [];
    const std = it.standardMessage, voice = it.voiceMessage, sticker = it.stickerMessage, cm = it.contactMessage, upd = it.updateMessage;
    if (std) {
      text = body(std.text); quote = std.quote; reactions = std.reactions;
      for (const a of (std.attachments ?? []) as any[]) {
        const p = a?.pointer ?? {}, li = p.locatorInfo ?? {}, size = n(li.size) ?? 0;
        const hash = li.plaintextHash ? Buffer.from(li.plaintextHash, "base64") : undefined, key = li.localKey ? Buffer.from(li.localKey, "base64") : undefined;
        const ref: MediaRef | undefined = c.o.attachments && hash?.length === 32 && key?.length === 64 ? { name: localMediaName(hash, key), key, hash, size } : undefined;
        raw.push({ ct: String(p.contentType ?? ""), name: p.fileName || undefined, voice: a.flag === "VOICE_MESSAGE", gif: a.flag === "GIF", w: n(p.width), h: n(p.height), size, ...(ref && c.have(ref.name) ? { ref } : {}) });
      }
      const shown = raw.some((r) => r.ref);
      if (raw.length && !shown) { const r = raw[0]!, ph = placeholder(attachmentKind(r.ct, { voice: r.voice }), r.name); text = text ? `${text}\n${ph}` : ph; }
      const lp = (std.linkPreview ?? [])[0]; if (lp?.url) card = { kind: "link", title: String(lp.title || lp.url), url: String(lp.url), ...(lp.description ? { body: String(lp.description) } : {}) };
      if (std.longText && !text) text = "[Long message]";
    } else if (voice) { text = "[Voice message]"; quote = voice.quote; reactions = voice.reactions; }
    else if (sticker) { reactions = sticker.reactions; const e = sticker.sticker?.emoji; text = e ? `Sticker ${e}` : "Sticker"; }
    else if (cm) { reactions = cm.reactions; const k = cm.contact; const nm = [k?.name?.givenName, k?.name?.familyName].filter(Boolean).join(" ") || k?.name?.nickname || k?.organization || "Contact";
      contacts = [{ name: nm, phones: (k?.number ?? []).map((x: any) => x.value).filter(Boolean), emails: (k?.email ?? []).map((x: any) => x.value).filter(Boolean) }]; text = `Contact: ${nm}`; }
    else if (it.remoteDeletedMessage) deleted = true;
    else if (it.viewOnceMessage) { text = VIEW_ONCE_TEXT; reactions = it.viewOnceMessage.reactions; }
    else if (upd) {
      system = true;
      if (upd.individualCall) { const k = upd.individualCall, vid = /VIDEO/.test(String(k.type)), missed = /MISSED|UNANSWERED|NOT_ACCEPTED/.test(JSON.stringify(k)), out = /OUTGOING/.test(String(k.direction)); text = `${missed ? "Missed " : out ? "Outgoing " : "Incoming "}${vid ? "video" : "voice"} call`; }
      else if (upd.groupCall) text = "Group call";
      else if (upd.expirationTimerChange) { const ms = n(upd.expirationTimerChange.expiresInMs) ?? 0; text = timerText(ms / 1000); }
      else return { skip: "noise" };
    } else return { skip: "noise" };
    if (!text && !contacts && !card && !deleted && !raw.some((r) => r.ref)) return { skip: "empty" };
    // edits keep the id of the first revision
    const revs = ((it.revisions ?? []) as any[]).map((r) => n(r.dateSent)).filter((x): x is number => !!x);
    const origTs = revs.length ? Math.min(sent, ...revs) : sent, id = ourMsgId(who.id, origTs);
    const m: Message = { id, chatId: chat.id, sender: outgoing ? "Me" : who.name, senderId: who.id, text: deleted ? "" : text, time: iso(origTs), fromMe: outgoing && !directionless,
      ...(contacts ? { contacts } : {}), ...(card ? { card } : {}), ...(system ? { system: { kind: "info" as const } } : {}), ...(deleted ? { deleted: true } : {}) };
    if (revs.length) m.editedAt = iso(sent);
    if (outgoing && !system) { const st = JSON.stringify(it.outgoing.sendStatus ?? []); m.status = /"failed"/i.test(st) ? "failed" : /"(read|viewed)"/i.test(st) ? "read" : /"delivered"/i.test(st) ? "delivered" : "sent"; }
    const qa = quote ? c.person(s(quote.authorId)) : undefined, qts = n(quote?.targetSentTimestamp);
    if (quote && qa && qts) m.replyTo = { messageId: ourMsgId(qa.id, qts), sender: qa.self ? "Me" : qa.name, ...(quote.text?.body ? { textPreview: String(quote.text.body) } : {}) };
    if (reactions?.length && !deleted) {
      const by = new Map<string, Reaction>();
      for (const r of reactions) { const p = c.person(s(r.authorId)); const e: Reaction = by.get(r.emoji) ?? { emoji: r.emoji, senderIds: [] }; const sid = p?.id ?? `r:${r.authorId}`; if (!e.senderIds.includes(sid)) e.senderIds.push(sid); if (p?.self) e.mine = true; by.set(r.emoji, e); }
      m.reactions = [...by.values()];
    }
    const parts: ImportedAttachment[] = [];
    raw.forEach((r, i) => {
      if (!r.ref) return;
      const att: Attachment = { id: `${id}#${i}`, kind: attachmentKind(r.ct, { voice: r.voice }), mime: r.ct || "application/octet-stream", ...(r.name ? { name: r.name } : {}), ...(r.size ? { size: r.size } : {}), ...(r.w ? { width: r.w } : {}), ...(r.h ? { height: r.h } : {}), ...(r.gif ? { gif: true } : {}) };
      c.refs.set(r.ref.name, r.ref); parts.push({ partKey: r.ref.name, att, size: r.size });
    });
    if (parts.length) m.attachments = parts.map((x) => x.att);
    return { ok: { chat, message: m, attachments: parts }, listed: { n: raw.length, bytes: raw.reduce((t, r) => t + r.size, 0) } };
  }
}

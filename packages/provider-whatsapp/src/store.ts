// Tiny JSON persistence for what Baileys does not keep: chat list, names, LID<->PN map, and a bounded
// per-chat message cache (needed for edits/reactions/replies/downloads and offline history()).
// The Hub's own store is the source of truth for history; this is a provider-local cache.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { ChatKind, Message } from "@unimsg/core";

export interface AttDesc {
  /** Baileys media type used for the HKDF key (see MEDIA_HKDF_KEY_MAPPING). */
  type: "image" | "video" | "audio" | "document" | "sticker";
  mediaKey: string; // base64
  directPath?: string;
  url?: string;
  mime: string;
  name?: string;
}
export interface StoredPoll {
  /** poll message secret (base64), needed to decrypt/encrypt votes. */
  secret: string;
  question: string;
  multiple: boolean;
  options: { id: string; text: string }[];
  /** voter id (same space as Message.senderId) -> selected option ids + vote time (ms). */
  votes: Record<string, { o: string[]; t: number }>;
}
export interface StoredEvent {
  secret: string; // base64 messageSecret of the event creation message
  name: string; description?: string; start: number; end?: number; place?: string; canceled?: boolean; extraGuests?: boolean; joinLink?: string;
}
export interface StoredMsg {
  /** a CIPHERTEXT placeholder that still waits for the real content */
  waiting?: boolean;
  /** live-location update counter */
  seq?: number;
  event?: StoredEvent;
  poll?: StoredPoll;
  m: Message;
  /** Raw participant jid as WhatsApp addressed it (needed for keys in groups). */
  pj?: string;
  /** Raw remoteJid as WhatsApp addressed it (may be @lid); used to build message keys. */
  rj?: string;
  /** Epoch ms, for ordering. */
  ts: number;
  att?: Record<string, AttDesc>;
}
export interface StoredChat {
  id: string; kind: ChatKind; name?: string;
  /** group/community we are currently a member of (from the live group fetch). */
  member?: boolean;
  /** created via startChat/createGroup: show even while empty. */
  started?: boolean;
  lastMessageAt?: string; unread?: number; muted?: boolean; readOnly?: boolean; spaceId?: string; archived?: boolean;
  /** disappearing-messages timer in seconds (absent = off) and when (ms) that setting was made */
  ephemeral?: number; ephemeralAt?: number;
  /** the group's description (about) as WhatsApp reports it */
  description?: string;
}
export interface StoreData {
  v: 1;
  chats: Record<string, StoredChat>;
  /** address-book / verified names by canonical jid. */
  contacts: Record<string, string>;
  /** push names (self-chosen) by canonical jid. */
  push: Record<string, string>;
  /** business verified names by canonical jid. */
  verified: Record<string, string>;
  /** newest-known message per chat from chat lists (anchor for on-demand history when nothing is stored). */
  anchors: Record<string, { id: string; fromMe: boolean; rj: string; pj?: string; ts: number }>;
  /** undecryptable messages waiting for the phone to resend them (message id -> request state). */
  pending: Record<string, import("./resend.js").Pending>;
  /** epoch ms of the last QR/new-login; initial history is only expected shortly after. */
  linkedAt?: number;
  lidToPn: Record<string, string>;
  spaces: Record<string, string>; // community jid -> name
  msgs: Record<string, StoredMsg[]>; // ascending by ts
}

export const MAX_MSGS_PER_CHAT = 2000;

export class Store {
  data: StoreData = { v: 1, chats: {}, contacts: {}, push: {}, verified: {}, anchors: {}, pending: {}, lidToPn: {}, spaces: {}, msgs: {} };
  private timer?: NodeJS.Timeout;
  private dirty = false;
  constructor(private file: string) {}

  load() {
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, "utf8")) as StoreData;
        if (d && d.v === 1) this.data = { ...this.data, ...d };
      }
    } catch { /* corrupt cache: start empty, history resync refills it */ }
  }

  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 1000);
    this.timer.unref?.();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      renameSync(tmp, this.file);
      try { chmodSync(this.file, 0o600); } catch { /* best effort */ }
    } catch { this.dirty = true; }
  }

  /** Stop all timers and forget pending writes (used by logout before wiping the dir). */
  discard() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.dirty = false; }

  find(chatId: string, messageId: string): StoredMsg | undefined {
    return this.data.msgs[chatId]?.find((s) => s.m.id === messageId);
  }

  /** Insert keeping ascending order; returns false when already present. */
  add(chatId: string, s: StoredMsg): boolean {
    const arr = (this.data.msgs[chatId] ??= []);
    if (arr.some((x) => x.m.id === s.m.id)) return false;
    let i = arr.length;
    while (i > 0 && arr[i - 1]!.ts > s.ts) i--;
    arr.splice(i, 0, s);
    if (arr.length > MAX_MSGS_PER_CHAT) arr.splice(0, arr.length - MAX_MSGS_PER_CHAT);
    this.touch();
    return true;
  }
}

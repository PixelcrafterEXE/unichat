import { SealedJsonFile, type KeyProvider } from "./secureFile.js";
import { Identities, KyberPreKeys, PreKeys, SenderKeys, Sessions, SignedPreKeys, type KindStores } from "./protocolStores.js";
import { freshStore, type AccountData, type AttachmentRef, type ChatRecord, type IdKind, type StoreShape } from "./types.js";

const SENT_INDEX_MAX = 3000;
const UNREAD_MAX = 500;

/** Facade over the sealed JSON file: typed data + factories for libsignal store objects. */
export class SignalStore {
  private file: SealedJsonFile<StoreShape>;
  data!: StoreShape;
  readonly senderKeys: SenderKeys;
  private kinds = new Map<IdKind, KindStores>();
  onIdentityChanged?: (address: string) => void;

  constructor(private readonly dir: string, keys?: KeyProvider) {
    this.file = new SealedJsonFile<StoreShape>(dir, freshStore, keys);
    this.senderKeys = new SenderKeys(this);
  }

  async load(): Promise<void> {
    this.data = await this.file.load();
    // stores written by earlier versions lack newer fields
    this.data.contacts ??= {}; this.data.attachments ??= {}; this.data.polls ??= {}; this.data.storage ??= {};
  }
  touch(): void { this.file.touch(); }
  flush(): Promise<void> { return this.file.flush(); }

  requireAccount(): AccountData {
    if (!this.data.account) throw new Error("not linked");
    return this.data.account;
  }
  get account(): AccountData | null { return this.data.account; }
  setAccount(a: AccountData): void { this.data.account = a; this.touch(); }

  stores(kind: IdKind): KindStores {
    let s = this.kinds.get(kind);
    if (!s) {
      s = {
        sessions: new Sessions(this, kind),
        identities: new Identities(this, kind, (a) => this.onIdentityChanged?.(a)),
        preKeys: new PreKeys(this, kind), signedPreKeys: new SignedPreKeys(this, kind), kyber: new KyberPreKeys(this, kind),
      };
      this.kinds.set(kind, s);
    }
    return s;
  }

  // ---- chat index ----
  upsertChat(c: ChatRecord): ChatRecord {
    const cur = this.data.chats[c.id];
    const next = { ...cur, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) } as ChatRecord;
    this.data.chats[c.id] = next; this.touch();
    return next;
  }
  indexSent(messageId: string, chatId: string): void {
    this.data.sentIndex[messageId] = chatId;
    const keys = Object.keys(this.data.sentIndex);
    if (keys.length > SENT_INDEX_MAX) for (const k of keys.slice(0, keys.length - SENT_INDEX_MAX)) delete this.data.sentIndex[k];
    this.touch();
  }

  /** Remember an incoming message as unread (so read receipts can cover EVERY unread message, and a read on another device can clear it). */
  noteUnread(chatId: string, messageId: string): void {
    const all = (this.data.unreadIds ??= {});
    const list = (all[chatId] ??= []);
    if (!list.includes(messageId)) list.push(messageId);
    if (list.length > UNREAD_MAX) list.splice(0, list.length - UNREAD_MAX);
    this.touch();
  }
  /** Remove and return the unread ids of a chat whose send timestamp is <= `upTo` (all of them when undefined). */
  takeUnread(chatId: string, upTo?: number): string[] {
    const list = this.data.unreadIds?.[chatId]; if (!list) return [];
    const ts = (id: string) => Number(id.slice(id.lastIndexOf(".") + 1));
    const taken = list.filter((id) => upTo === undefined || ts(id) <= upTo);
    if (taken.length) {
      const rest = list.filter((id) => !taken.includes(id));
      if (rest.length) this.data.unreadIds![chatId] = rest; else delete this.data.unreadIds![chatId];
      this.touch();
    }
    return taken;
  }
  /** Forget one unread id wherever it is; returns the chat it was in. */
  dropUnread(messageId: string): string | undefined {
    for (const [chatId, list] of Object.entries(this.data.unreadIds ?? {})) {
      const i = list.indexOf(messageId);
      if (i >= 0) { list.splice(i, 1); if (!list.length) delete this.data.unreadIds![chatId]; this.touch(); return chatId; }
    }
    return undefined;
  }

  rememberAttachment(id: string, ref: AttachmentRef): void {
    this.data.attachments[id] = ref;
    const keys = Object.keys(this.data.attachments);
    if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete this.data.attachments[k];
    this.touch();
  }

  /** Delete every secret and the data file (logout). */
  async wipe(): Promise<void> {
    await this.file.flush().catch(() => {});
    this.file.destroy();
    this.data = freshStore();
    this.kinds.clear();
  }
}

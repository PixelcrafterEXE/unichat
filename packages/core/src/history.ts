// One account's archive as a stream of pieces (messages, chat list, flags, names, link events, cached attachments), for the device-to-device move
// ("Also move the chat history") and "send this device's history of <account> to <device>". Merge semantics on the receiving side (nothing is overwritten
// that is newer there); nothing here touches the account's login. See docs/ARCHITECTURE.md "Move to another device".
import type { Chat, Message, Space } from "./model.js";
import type { MediaCache } from "./media.js";
import { attachmentIds } from "./backup.js";
import { mediaKey } from "./mediajob.js";
import type { AccountEventKind, Store } from "./store.js";

export interface HistoryEnv { store: Store; media: MediaCache }
export interface HistoryEstimate { messages: number; files: number; bytes: number }
export type HistoryRow =
  | { t: "message"; v: Message } | { t: "alias"; chatId: string; name: string } | { t: "flags"; chatId: string; v: any } | { t: "chatFolder"; chatId: string; folderId: string }
  | { t: "chatCache"; v: { chats: Chat[]; spaces: Space[] } } | { t: "event"; v: { kind: AccountEventKind; time: string } };
export type HistoryPiece = { kind: "rows"; rows: HistoryRow[]; messages: number } | { kind: "media"; chatId: string; messageId: string; attId: string; mime: string; name?: string; data: Buffer };
const inAcct = (chatId: string, acct: string) => chatId.startsWith(acct + ":");

function* messagesOf(h: HistoryEnv, acct: string): Generator<Message> {
  if (h.store.scanMessages) {
    let after: { chatId: string; id: string } | undefined;
    for (;;) { const page = h.store.scanMessages({ after, limit: 500, accountId: acct }); if (!page.length) return; for (const m of page) yield m; const l = page[page.length - 1]; after = { chatId: l.chatId, id: l.id }; }
  } else for (const r of h.store.exportRecords()) if (r.t === "message" && inAcct(r.v.chatId, acct)) yield r.v;
}

export function historyEstimate(h: HistoryEnv, acct: string, media: boolean): HistoryEstimate {
  let messages = 0, files = 0, bytes = 0;
  for (const m of messagesOf(h, acct)) {
    messages++; bytes += JSON.stringify(m).length;
    if (media) for (const id of attachmentIds(m)) { const k = mediaKey(m.chatId, m.id, id); if (h.media.has(acct, k)) { files++; bytes += h.media.size(acct, k); } }
  }
  return { messages, files, bytes };
}

const ROWS_BYTES = 180_000;
export async function* historyPieces(h: HistoryEnv, acct: string, media: boolean): AsyncGenerator<HistoryPiece> {
  let rows: HistoryRow[] = [], bytes = 0, msgs = 0;
  const flush = (): HistoryPiece => { const p: HistoryPiece = { kind: "rows", rows, messages: msgs }; rows = []; bytes = 0; msgs = 0; return p; };
  const add = (r: HistoryRow, isMsg = false) => { rows.push(r); bytes += JSON.stringify(r).length; if (isMsg) msgs++; };
  const cache = h.store.getChatCache(acct); if (cache) add({ t: "chatCache", v: cache });
  for (const e of h.store.listAccountEvents(acct)) add({ t: "event", v: { kind: e.kind, time: e.time } });
  for (const [chatId, name] of Object.entries(h.store.listAliases())) if (inAcct(chatId, acct)) add({ t: "alias", chatId, name });
  for (const [chatId, v] of Object.entries(h.store.listChatFlags())) if (inAcct(chatId, acct)) add({ t: "flags", chatId, v });
  for (const [chatId, folderId] of Object.entries(h.store.listChatFolders())) if (inAcct(chatId, acct)) add({ t: "chatFolder", chatId, folderId });
  const files: { m: Message; id: string }[] = [];
  let n = 0;
  for (const m of messagesOf(h, acct)) {
    add({ t: "message", v: m }, true);
    if (media) for (const id of attachmentIds(m)) if (h.media.has(acct, mediaKey(m.chatId, m.id, id))) files.push({ m, id });
    if (bytes >= ROWS_BYTES) yield flush();
    if (++n % 2000 === 0) await new Promise((ok) => setImmediate(ok));
  }
  if (rows.length) yield flush();
  for (const f of files) {
    const b = h.media.get(acct, mediaKey(f.m.chatId, f.m.id, f.id)); if (!b) continue;
    yield { kind: "media", chatId: f.m.chatId, messageId: f.m.id, attId: f.id, mime: b.mime, name: b.name, data: Buffer.from(b.data) };
  }
}

/** Apply rows of one account (merge: existing newer data wins; aliases / flags / folders only where nothing is set). Rows for other accounts are refused. */
export async function applyHistoryRows(h: HistoryEnv, acct: string, rows: HistoryRow[]): Promise<number> {
  let n = 0;
  await h.store.inTransaction(() => {
    const msgs: Message[] = [], al = h.store.listAliases(), fl = h.store.listChatFlags(), cf = h.store.listChatFolders();
    for (const r of rows) {
      switch (r?.t) {
        case "message": if (!inAcct(r.v.chatId, acct)) throw new Error("History for another account."); msgs.push({ ...r.v, accountId: acct } as Message); break;
        case "alias": if (inAcct(r.chatId, acct) && !(r.chatId in al)) h.store.setAlias(r.chatId, r.name); break;
        case "flags": if (inAcct(r.chatId, acct) && !(r.chatId in fl)) h.store.setChatFlags(r.chatId, r.v); break;
        case "chatFolder": if (inAcct(r.chatId, acct) && !(r.chatId in cf)) h.store.setChatFolder(r.chatId, r.folderId); break;
        case "chatCache": if (!h.store.getChatCache(acct)) h.store.putChatCache(acct, r.v); break;
        case "event": { const have = h.store.listAccountEvents(acct); if (!have.some((e) => e.time === r.v.time && e.kind === r.v.kind)) h.store.addAccountEvent(acct, r.v.kind, r.v.time); break; }
        default: throw new Error("Unknown history row.");
      }
    }
    if (msgs.length) h.store.putMessages(msgs); n = msgs.length;
  });
  return n;
}
export function applyHistoryMedia(h: HistoryEnv, acct: string, p: { chatId: string; messageId: string; attId: string; mime: string; name?: string; data: Buffer }) {
  if (!inAcct(p.chatId, acct)) throw new Error("History for another account.");
  h.media.put(acct, mediaKey(p.chatId, p.messageId, p.attId), { data: p.data, mime: p.mime, name: p.name });
}
/** "Remove the history from this device afterwards": messages, chat list, flags, names and cached files of the account, locally only. */
export function removeHistory(h: HistoryEnv, acct: string) { h.store.deleteAccountData(acct); h.media.removeAccount(acct); }

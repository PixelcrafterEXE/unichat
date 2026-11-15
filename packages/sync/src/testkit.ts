// Test kit: real Hub instances (MemoryStore / SqliteStore in temp dirs) paired over loopback only. Used by the integration tests here and in apps/server.
import { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Hub, MemoryStore, NO_CAPABILITIES, type Connector, type ProviderFactory, type Message, type Store } from "@unimsg/core";
import { SqliteStore } from "@unimsg/store-sqlite";
import { attachSync, SyncStore, type SyncService, type SyncOptions } from "./index.js";

export const signedIn: string[] = [];
export const fac = (name: string): ProviderFactory => ({ name, displayName: name, login: "qr", capabilities: NO_CAPABILITIES, create: ({ accountId }) => ({
  capabilities: NO_CAPABILITIES, async start() { signedIn.push(accountId); }, async stop() {}, async logout() {}, async submitLogin() {},
  async spaces() { return []; }, async chats() { return []; }, async history() { return []; }, async members() { return []; },
  async downloadAttachment() { return { data: new Uint8Array(), mime: "x" }; }, async send() { throw new Error("n/a"); } }) as unknown as Connector });

export interface Node { key: Uint8Array; name: string; hub: Hub; store: SyncStore; svc: SyncService; dir: string; call(m: string, p?: any): Promise<any>; stop(): Promise<void> }
const roots: string[] = [], all: Node[] = [];
after(async () => { for (const n of all) await n.stop().catch(() => {}); });
export async function node(name: string, kind: "memory" | "sqlite", dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), `sync-${name}-`)), seed?: (s: Store) => void, key: Uint8Array = new Uint8Array(randomBytes(32)), extra: { opts?: Partial<SyncOptions>; factories?: ProviderFactory[] } = {}): Promise<Node> {
  roots.push(dir);
  const inner: Store = kind === "sqlite" ? new SqliteStore(join(dir, "u.db"), key) : new MemoryStore();
  seed?.(inner);
  const store = new SyncStore(inner);
  const hub = new Hub(join(dir, "accounts"), [fac("fake"), fac("mattermost"), ...(extra.factories ?? [])], store, { dataKey: key });
  const svc = attachSync(hub, store, { dir, dataKey: key, deviceName: name, bindHost: "127.0.0.1", mdns: false, retryMs: 300, pairingTtlMs: 60_000, dht: { requireBootstrap: true, delayMs: 300, ...extra.opts?.dht }, ...extra.opts });
  await hub.init(); await svc.ready;
  const nd: Node = { key, name, hub, store, svc, dir, call: (m, p) => hub.call(m, p) as Promise<any>, stop: async () => { await hub.shutdown(); } };
  all.push(nd); return nd;
}
after_all();
function after_all() { process.on("exit", () => { for (const r of roots) try { rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ } }); }
export const msg = (chat: string, id: string, text: string, time: string, extra: Partial<Message> = {}): Message => ({ id, chatId: chat, sender: "Ann", senderId: "ann", text, time, fromMe: false, ...extra });
export async function until(f: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const t = Date.now(); for (;;) { if (await f()) return; if (Date.now() - t > ms) throw new Error("timeout waiting for " + what); await new Promise((r) => setTimeout(r, 40)); }
}
/** Join with the full ceremony: compare the 6 digits on both sides, approve on the inviting device, confirm on the joining one. */
export async function joinApproved(inviter: Node, joiner: Node, p: { port: number; code: string }) {
  const j = await joiner.call("syncJoin", { host: "127.0.0.1", port: p.port, code: p.code, deviceName: joiner.name });
  await until(async () => !!(await inviter.call("syncStatus")).approval, "approval request shown on the inviting device");
  const ap = (await inviter.call("syncStatus")).approval;
  assert.equal(ap.sas, j.sas, "both devices show the same digits"); assert.match(ap.sas, /^\d{3} \d{3}$/); assert.equal(ap.deviceName, joiner.name);
  await Promise.all([joiner.call("syncConfirmJoin", { keepListening: true }), inviter.call("syncApproveJoin", { accept: true })]);
}
export async function pairUp(inviter: Node, joiner: Node) {
  const p = await inviter.call("syncStartPairing", { deviceName: inviter.name, keepListening: true });
  await joinApproved(inviter, joiner, p);
  await until(async () => (await inviter.call("syncStatus")).devices.find((d: any) => d.id === joiner.svc.status().deviceId)?.online && (await joiner.call("syncStatus")).devices.find((d: any) => d.id === inviter.svc.status().deviceId)?.online, `${inviter.name}<->${joiner.name} online`);
}
/** Canonical dump of everything that must converge. */
export function dump(s: Store) {
  const rows: string[] = [];
  for (const r of s.exportRecords()) {
    if (r.t === "message") rows.push("m " + JSON.stringify([r.v.chatId, r.v.id, r.v.text, r.v.editedAt ?? null, !!r.v.deleted, r.v.status ?? null, (r.v.deleted ? [] : r.v.reactions ?? []).map((x) => x.emoji + x.senderIds.join())]));
    else if (r.t === "alias") rows.push("a " + r.chatId + "=" + r.name);
    else if (r.t === "flags") rows.push("f " + r.chatId + [!!r.v.pinned, !!r.v.muted, !!r.v.archived]);
    else if (r.t === "folder") rows.push("fo " + JSON.stringify(r.v));
    else if (r.t === "chatFolder") rows.push("cf " + r.chatId + r.folderId);
    else if (r.t === "setting" && ["retentionDays", "railOrder", "collapseSingleChatCommunities"].includes(r.key)) rows.push("s " + r.key + "=" + r.value);
    else if (r.t === "account") rows.push("ac " + r.v.id + r.v.label);
  }
  return rows.sort().join("\n");
}
export const converged = (...n: Node[]) => n.every((x) => dump(x.store) === dump(n[0].store));

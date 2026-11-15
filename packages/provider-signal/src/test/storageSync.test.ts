// Read-only Storage Service sync: fake storage server with real crypto (generated keys only), loopback http, no real network.
import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { test } from "node:test";
import { AccountEntropyPool } from "@signalapp/libsignal-client/dist/AccountKeys.js";
import {
  ManifestRecordCodec, ReadOperationCodec, StorageItemsCodec, StorageManifestCodec, StorageRecordCodec, StorageIdType,
  type AccountRecordPb, type ContactRecordPb, type GroupV2RecordPb,
} from "../protocol/codec.js";
import { Inbound } from "../service/inbound.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { deriveStorageKey, gcmEncrypt, itemKeys, manifestKey } from "../service/storageCrypto.js";
import { StorageSync, httpsStorageTransport, keysRequestDelayMs } from "../service/storageSync.js";
import { A, B, C, ME, b64, makeStore } from "./fixtures.js";

type Rec = { contact?: ContactRecordPb; groupV2?: GroupV2RecordPb; account?: AccountRecordPb };
interface Entry { raw: Buffer; type: number; rec: Rec; corrupt?: boolean }

class FakeStorage {
  version = 1; entries: Entry[] = []; log: string[] = []; reads: string[][] = []; authCalls = 0; failAuthOnce = false; rejectOnce = 0;
  server!: Server; port = 0; ikm = randomBytes(32);
  constructor(readonly storageKey: Buffer, readonly useIkm = true) {}
  add(type: number, rec: Rec, corrupt = false) { const e = { raw: randomBytes(16), type, rec, corrupt }; this.entries.push(e); return e; }
  bump() { this.version++; }
  private manifest() {
    const value = gcmEncrypt(manifestKey(this.storageKey, this.version), ManifestRecordCodec.encode({
      version: this.version, sourceDevice: 1, identifiers: this.entries.map((e) => ({ raw: e.raw, type: e.type })), ...(this.useIkm ? { recordIkm: this.ikm } : {}),
    }));
    return Buffer.from(StorageManifestCodec.encode({ version: this.version, value }));
  }
  private item(e: Entry) {
    const k = itemKeys(this.storageKey, e.raw, this.useIkm ? this.ikm : undefined)[0]!;
    const enc = gcmEncrypt(k, StorageRecordCodec.encode(e.rec));
    if (e.corrupt) enc[enc.length - 1]! ^= 1;
    return { key: e.raw, value: enc };
  }
  async start() {
    this.server = createServer(async (req: IncomingMessage, res) => {
      const parts: Buffer[] = []; for await (const c of req) parts.push(c as Buffer);
      const body = Buffer.concat(parts);
      this.log.push(`${req.method} ${req.url}`);
      if (this.rejectOnce > 0) { this.rejectOnce--; res.statusCode = 401; return res.end(); }
      const m = /^\/v1\/storage\/manifest\/version\/(\d+)$/.exec(req.url ?? "");
      if (req.method === "GET" && req.url === "/v1/storage/manifest") { res.end(this.manifest()); return; }
      if (req.method === "GET" && m) { if (Number(m[1]) === this.version) { res.statusCode = 204; return res.end(); } res.end(this.manifest()); return; }
      if (req.method === "PUT" && req.url === "/v1/storage/read") {
        const keys = (ReadOperationCodec.decode(body).readKey ?? []).map((k) => b64(k)); this.reads.push(keys);
        const items = this.entries.filter((e) => keys.includes(b64(e.raw))).map((e) => this.item(e));
        res.end(Buffer.from(StorageItemsCodec.encode({ items }))); return;
      }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
  }
  stop() { this.server.close(); }
  transport() {
    return httpsStorageTransport(async () => { this.authCalls++; return { username: "u", password: "p" }; }, { storageUrl: `http://127.0.0.1:${this.port}` });
  }
}

const hold = (store: Awaited<ReturnType<typeof makeStore>>, key: Buffer) => { store.data.storage.key = key.toString("base64"); };
async function setup(useIkm = true) {
  const store = await makeStore(ME, 2); const key = randomBytes(32);
  hold(store, key);
  const fake = new FakeStorage(key, useIkm); await fake.start();
  let changed = 0; const newGroups: string[] = []; const keysSeen: string[] = [];
  const sync = new StorageSync(store, () => fake.transport(), { onChanged: () => { changed++; }, onNewGroups: (g) => newGroups.push(...g), onProfileKey: (a) => keysSeen.push(a) });
  return { store, fake, sync, newGroups, keysSeen, changed: () => changed };
}

test("manifest decrypt, batched read, contact / group / account records applied, name precedence", async () => {
  const { store, fake, sync, newGroups, keysSeen, changed } = await setup();
  const pk = randomBytes(32), gmk = randomBytes(32), gmk2 = randomBytes(32);
  fake.add(StorageIdType.CONTACT, { contact: { aci: A, e164: "+491700000001", profileKey: pk, givenName: "Prof", familyName: "File", blocked: true, archived: true, mutedUntilTimestamp: Date.now() + 1e7 } });
  fake.add(StorageIdType.CONTACT, { contact: { aci: B, givenName: "Prof", systemGivenName: "Sys", systemFamilyName: "Tem", nickname: { given: "Nick" } } });
  fake.add(StorageIdType.CONTACT, { contact: { aci: C, givenName: "Prof", systemGivenName: "Sys", systemFamilyName: "Tem" } });
  fake.add(StorageIdType.CONTACT, { contact: { aci: randomUuid(), systemNickname: "Nn" } });
  for (let i = 0; i < 230; i++) fake.add(StorageIdType.CONTACT, { contact: { aci: randomUuid(), givenName: `P${i}` } });
  fake.add(StorageIdType.GROUPV2, { groupV2: { masterKey: gmk, archived: true, blocked: true } });
  fake.add(StorageIdType.GROUPV2, { groupV2: { masterKey: gmk2 } });
  fake.add(6, { });
  fake.add(StorageIdType.ACCOUNT, { account: { readReceipts: false, typingIndicators: false, linkPreviews: false, profileKey: randomBytes(32), pinnedConversations: [{ contact: { serviceId: B } }, { groupMasterKey: gmk2 }] } });
  const stats = await sync.sync();
  assert.ok(stats && stats.skipped === 0);
  assert.equal(stats.records, 234 + 2 + 1 + 1);
  assert.deepEqual(fake.reads.map((r) => r.length), [100, 100, 37]);
  assert.ok(fake.reads.every((r) => r.length <= 100));
  const c = store.data.contacts;
  assert.equal(c[A]!.name, "Prof File"); assert.equal(c[A]!.profileKey, b64(pk)); assert.equal(c[A]!.number, "+491700000001");
  assert.equal(c[A]!.blocked, true); assert.equal(c[A]!.archived, true); assert.ok(c[A]!.mutedUntil! > Date.now());
  assert.equal(c[B]!.name, "Nick", "nickname beats address book beats profile"); assert.equal(c[B]!.profileName, "Prof"); assert.equal(c[B]!.systemName, "Sys Tem");
  assert.equal(c[C]!.name, "Sys Tem");
  assert.equal(c[B]!.pinned, true);
  assert.equal(store.data.account!.readReceipts, false); assert.equal(store.data.account!.typingIndicators, false); assert.equal(store.data.account!.linkPreviews, false);
  const g1 = groupChatId(groupIdFromMasterKey(gmk)), g2 = groupChatId(groupIdFromMasterKey(gmk2));
  assert.deepEqual(newGroups.sort(), [g1, g2].sort());
  assert.equal(store.data.chats[g1]!.groupMasterKey, b64(gmk)); assert.equal(store.data.chats[g2]!.pinned, true);
  assert.deepEqual(keysSeen.includes(A), true);
  assert.ok(changed() >= 1);
  const inb = new Inbound("acc", store, () => {});
  store.data.chats[A] = { id: A, kind: "dm" }; store.data.chats[B] = { id: B, kind: "dm" };
  assert.equal(inb.chatRecordToChat(A).name, "Prof File"); assert.equal(inb.chatRecordToChat(A).archived, true); assert.equal(inb.chatRecordToChat(A).muted, true); assert.equal(inb.chatRecordToChat(A).blocked, true);
  assert.equal(inb.chatRecordToChat(B).name, "Nick"); assert.equal(inb.chatRecordToChat(B).pinned, true);
  assert.equal(inb.chatRecordToChat(g1).archived, true);
  assert.ok(fake.log.every((l) => l.startsWith("GET ") || l === "PUT /v1/storage/read"), "read-only: no write request was ever sent");
  fake.stop();
});

test("incremental: unchanged records are not read again; a changed one is; legacy (no recordIkm) keys work", async () => {
  const { store, fake, sync } = await setup(false);
  const e1 = fake.add(StorageIdType.CONTACT, { contact: { aci: A, givenName: "Old" } });
  fake.add(StorageIdType.CONTACT, { contact: { aci: B, givenName: "Bee" } });
  await sync.sync(); assert.equal(store.data.contacts[A]!.name, "Old");
  const r = await sync.sync();
  assert.equal(r?.unchanged, true); assert.equal(fake.reads.length, 1, "same version: only the version probe");
  fake.entries = fake.entries.filter((e) => e !== e1); fake.add(StorageIdType.CONTACT, { contact: { aci: A, givenName: "New" } }); fake.bump();
  await sync.sync();
  assert.equal(fake.reads.length, 2); assert.equal(fake.reads[1]!.length, 1, "only the new id is read");
  assert.equal(store.data.contacts[A]!.name, "New");
  fake.stop();
});

test("wrong key drops the key; corrupted record is skipped and counted; 401 re-authenticates", async () => {
  const { store, fake, sync } = await setup();
  fake.add(StorageIdType.CONTACT, { contact: { aci: A, givenName: "Fine" } });
  fake.add(StorageIdType.CONTACT, { contact: { aci: B, givenName: "Broken" } }, true);
  fake.rejectOnce = 1;
  const r = await sync.sync();
  assert.equal(fake.authCalls, 2, "401 caused one re-auth"); assert.equal(r?.applied, 1); assert.equal(r?.skipped, 1);
  assert.equal(store.data.contacts[B], undefined);
  const s2 = await makeStore(ME, 2); hold(s2, randomBytes(32));
  const wrong = new StorageSync(s2, () => fake.transport(), { onChanged() {} });
  assert.equal(await wrong.sync(), undefined); assert.equal(s2.data.storage.key, undefined, "a key that cannot open the manifest is dropped");
  fake.stop();
});

test("log lines carry counts only", async () => {
  const { fake, sync } = await setup();
  fake.add(StorageIdType.CONTACT, { contact: { aci: A, e164: "+491700000009", givenName: "Secretname" } });
  const lines: string[] = []; const orig = process.stderr.write.bind(process.stderr); process.env.UNIMSG_DEBUG = "1";
  (process.stderr as { write: unknown }).write = (s: string) => { lines.push(String(s)); return true; };
  try { await sync.sync(); } finally { (process.stderr as { write: unknown }).write = orig; delete process.env.UNIMSG_DEBUG; }
  const all = lines.join("");
  assert.match(all, /\[signal\] storage: manifest v=1 records=1 contacts=1 groups=0 applied=1 skipped=0/);
  assert.ok(!all.includes("Secretname") && !all.includes(A) && !all.includes("+4917"));
  fake.stop();
});

test("KEYS answer: aep and master derive the same storage key as the documented HMAC; inbound stores only the derived key", async () => {
  const master = randomBytes(32);
  const hm = createHmac("sha256", master).update("Storage Service Encryption").digest();
  assert.deepEqual(deriveStorageKey({ master }), hm, "legacy master -> storage key equals HMAC(master, 'Storage Service Encryption')");
  const aep = AccountEntropyPool.generate();
  assert.equal(deriveStorageKey({ accountEntropyPool: aep })!.length, 32);
  assert.equal(deriveStorageKey({ accountEntropyPool: "nope" }), undefined);
  const store = await makeStore(ME, 2); let got = 0;
  const inb = new Inbound("acc", store, () => {}); inb.hooks.onStorageKey = () => { got++; };
  await inb.handle({ senderAci: ME, content: { syncMessage: { keys: { accountEntropyPool: aep } } } } as never, 1);
  assert.equal(got, 1); assert.deepEqual(Buffer.from(store.data.storage.key!, "base64"), deriveStorageKey({ accountEntropyPool: aep }));
  assert.ok(!JSON.stringify(store.data).includes(aep));
  let fetched = 0; inb.hooks.onStorageManifestChanged = () => { fetched++; };
  await inb.handle({ senderAci: ME, content: { syncMessage: { fetchLatest: { type: 2 } } } } as never, 2);
  assert.equal(fetched, 1);
  await inb.handle({ senderAci: A, content: { syncMessage: { keys: { master } } } } as never, 3);
  assert.equal(got, 1, "keys from anybody but our own account are ignored");
  assert.ok(keysRequestDelayMs(0) === 0 && keysRequestDelayMs(3) > keysRequestDelayMs(1) && keysRequestDelayMs(9) >= 7 * 86400_000);
  void createHash;
});

function randomUuid(): string { const b = randomBytes(16); b[6] = (b[6]! & 0x0f) | 0x40; b[8] = (b[8]! & 0x3f) | 0x80; const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }

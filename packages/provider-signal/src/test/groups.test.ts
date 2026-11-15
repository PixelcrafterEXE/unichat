// Groups v2 state: fake groups server + real zkgroup crypto, generated keys only, throwaway temp-dir stores. No network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Aci, IdentityKeyPair, Pni } from "@signalapp/libsignal-client";
import {
  AuthCredentialPresentation, ClientZkGroupCipher, GroupMasterKey, GroupPublicParams, GroupSecretParams, ServerSecretParams,
  ServerZkAuthOperations,
} from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import type { CoreEvent } from "@unimsg/core";
import { GroupAttributeBlobCodec, GroupResponseCodec, GroupCodec } from "../protocol/codec.js";
import { GroupResolver, GroupsHttpError, type GroupsTransport } from "../service/groupState.js";
import { groupChatId, groupIdFromMasterKey } from "../service/groups.js";
import { Inbound } from "../service/inbound.js";
import { SignalStore } from "../store/signalStore.js";

const ME = "22222222-2222-4222-8222-222222222222";
const MY_PNI = "33333333-3333-4333-8333-333333333333";
const ALICE = "11111111-1111-4111-8111-111111111111";
const TITLE = "Secret Book Club 7731";
const DESC = "Tuesdays, bring snacks 4417";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(40)]);
const NOW = Date.UTC(2026, 5, 1, 12) ;

const bytes = (u: Uint8Array) => new Uint8Array(u);

async function makeStore(): Promise<SignalStore> {
  const s = new SignalStore(mkdtempSync(join(tmpdir(), "unimsg-signal-groups-")));
  await s.load();
  s.setAccount({
    aci: ME, pni: MY_PNI, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"),
    readReceipts: true, linkedAt: 0,
  });
  return s;
}

interface FakeState { title: string; description?: string; revision: number; avatar?: Buffer; avatarPath?: string; members: string[]; admin?: string }

function fakeServer(masterKey: Uint8Array, st: FakeState) {
  const server = ServerSecretParams.generate();
  const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(bytes(masterKey)));
  const cipher = new ClientZkGroupCipher(secret);
  const zk = new ServerZkAuthOperations(server);
  const calls = { credentials: 0, group: 0, avatar: 0 };
  const failures = { group: 0, avatar: false, bare: false };
  const unsupported = async (): Promise<never> => { throw new Error("write side not used in this test"); };
  const transport: GroupsTransport = {
    createGroup: unsupported, modifyGroup: unsupported, avatarForm: unsupported, uploadAvatar: unsupported,
    async authCredentials(start) {
      calls.credentials++;
      const credentials = [0, 1, 2].map((d) => ({
        redemptionTime: start + d * 86400,
        credential: Buffer.from(zk.issueAuthCredentialWithPniZkc(Aci.fromUuid(ME), Pni.fromUuid(MY_PNI), start + d * 86400).serialize()).toString("base64"),
      }));
      return { credentials, pni: `PNI:${MY_PNI}` };
    },
    async fetchGroup(basicAuth) {
      calls.group++;
      if (failures.group > 0) { failures.group--; throw new GroupsHttpError(403); }
      const [user, pass] = Buffer.from(basicAuth, "base64").toString().split(":");
      const pub = new GroupPublicParams(bytes(Buffer.from(user!, "hex")));
      assert.deepEqual(pub.serialize(), secret.getPublicParams().serialize());
      zk.verifyAuthCredentialPresentation(pub, new AuthCredentialPresentation(bytes(Buffer.from(pass!, "hex"))), new Date(NOW)); // throws if forged
      const blob = (o: object) => cipher.encryptBlob(bytes(GroupAttributeBlobCodec.encode(o)));
      const group = {
        publicKey: pub.serialize(), version: st.revision, title: blob({ title: st.title }),
        ...(st.description ? { descriptionBytes: blob({ descriptionText: st.description }) } : {}),
        ...(st.avatarPath ? { avatar: st.avatarPath } : {}),
        members: st.members.map((m) => ({ userId: cipher.encryptServiceId(Aci.fromUuid(m)).serialize(), role: m === st.admin ? 2 : 1 })),
      };
      return failures.bare ? GroupCodec.encode(group) : GroupResponseCodec.encode({ group });
    },
    async fetchAvatar(path) {
      calls.avatar++;
      assert.equal(path, st.avatarPath);
      if (failures.avatar) throw new Error("cdn down");
      return cipher.encryptBlob(bytes(GroupAttributeBlobCodec.encode({ avatar: st.avatar })));
    },
  };
  return { transport, calls, failures, publicParams: server.getPublicParams().serialize() };
}

async function setup(st: FakeState, opts: { bare?: boolean } = {}) {
  const store = await makeStore();
  const masterKey = randomBytes(32);
  const chatId = groupChatId(groupIdFromMasterKey(masterKey));
  const events: CoreEvent[] = [];
  const emit = (e: CoreEvent) => events.push(e);
  const fake = fakeServer(masterKey, st);
  fake.failures.bare = !!opts.bare;
  let now = NOW;
  const resolver = new GroupResolver(store, () => fake.transport, emit, {
    serverPublicParams: fake.publicParams, now: () => now,
  });
  return { store, masterKey, chatId, events, fake, resolver, advance: (ms: number) => { now += ms; } };
}

const base = (): FakeState => ({ title: TITLE, description: DESC, revision: 3, avatarPath: "groups/abc", avatar: PNG, members: [ME, ALICE], admin: ALICE });
const lastPatch = (events: CoreEvent[]) => events.filter((e) => e.type === "chats-changed");

async function register(h: Awaited<ReturnType<typeof setup>>) {
  h.store.upsertChat({ id: h.chatId, kind: "group", groupMasterKey: Buffer.from(h.masterKey).toString("base64") });
}

test("groups v2: title, description, avatar and members resolve and persist", async () => {
  for (const bare of [false, true]) {
    const h = await setup(base(), { bare });
    await register(h);
    const inb = new Inbound("acc", h.store, (e) => h.events.push(e));
    assert.equal(inb.chatRecordToChat(h.chatId).name, "Signal group");
    await h.resolver.request(h.chatId);
    const chat = inb.chatRecordToChat(h.chatId);
    assert.equal(chat.name, TITLE); assert.equal(chat.description, DESC);
    const rec = h.store.data.chats[h.chatId]!;
    assert.equal(rec.groupRevision, 3); assert.deepEqual(rec.groupMembers!.sort(), [ALICE, ME]); assert.deepEqual(rec.groupAdmins, [ALICE]);
    assert.deepEqual(Buffer.from(rec.avatarB64!, "base64"), PNG); assert.equal(rec.avatarMime, "image/png");
    assert.equal(lastPatch(h.events).length, 1);
    // names come from contact data where known
    h.store.data.contacts[ALICE] = { aci: ALICE, name: "Alice A" };
    assert.deepEqual(inb.groupMembers(h.chatId).map((m) => m.name).sort(), ["Alice A", "You"]);
    // persisted sealed: survives a reload of the store
    await h.store.flush();
  }
});

test("groups v2: refresh only on a newer revision; avatar refetched only when its path changes", async () => {
  const st = base();
  const h = await setup(st);
  await register(h);
  await h.resolver.request(h.chatId, 3);
  assert.equal(h.fake.calls.group, 1);
  await h.resolver.request(h.chatId, 3); await h.resolver.request(h.chatId, 2); await h.resolver.request(h.chatId);
  assert.equal(h.fake.calls.group, 1);
  st.revision = 4; st.title = "Renamed"; st.members = [ME];
  await h.resolver.request(h.chatId, 4);
  assert.equal(h.fake.calls.group, 2);
  assert.equal(h.fake.calls.avatar, 1); assert.equal(h.fake.calls.credentials, 1); // credential cached for the day
  const rec = h.store.data.chats[h.chatId]!;
  assert.deepEqual([rec.name, rec.groupRevision, rec.groupMembers], ["Renamed", 4, [ME]]);
  st.revision = 5; st.avatarPath = "groups/def"; st.avatar = Buffer.from([0xff, 0xd8, 1, 2, 3]);
  await h.resolver.request(h.chatId, 5);
  assert.equal(h.fake.calls.avatar, 2); assert.equal(h.store.data.chats[h.chatId]!.avatarMime, "image/jpeg");
  // an inbound message announcing a newer revision triggers the hook path
  const seen: [string, number | undefined][] = [];
  const inb = new Inbound("acc", h.store, (e) => h.events.push(e));
  inb.hooks.onGroupSeen = (id, rev) => seen.push([id, rev]);
  await inb.handle({ senderAci: ALICE, senderDevice: 1, sealed: false, content: { dataMessage: { body: "hi", timestamp: 9, groupV2: { masterKey: new Uint8Array(h.masterKey), revision: 6 } } } }, 9);
  assert.deepEqual(seen, [[h.chatId, 6]]);
});

test("groups v2: failures are soft, keep the old label, and back off", async () => {
  const h = await setup(base());
  await register(h);
  const inb = new Inbound("acc", h.store, (e) => h.events.push(e));
  h.fake.failures.group = 1;
  await h.resolver.request(h.chatId);
  assert.equal(inb.chatRecordToChat(h.chatId).name, "Signal group");
  assert.equal(lastPatch(h.events).length, 0); assert.equal(h.store.data.chats[h.chatId]!.groupRevision, undefined);
  await h.resolver.request(h.chatId); // inside the cooldown: no new request
  assert.equal(h.fake.calls.group, 1);
  h.advance(61_000);
  await h.resolver.request(h.chatId);
  assert.equal(inb.chatRecordToChat(h.chatId).name, TITLE);
  // avatar failure keeps title + members, retried at the next refresh
  const h2 = await setup(base());
  await register(h2); h2.fake.failures.avatar = true;
  await h2.resolver.request(h2.chatId);
  assert.equal(h2.store.data.chats[h2.chatId]!.name, TITLE); assert.equal(h2.store.data.chats[h2.chatId]!.avatarB64, undefined);
  // a group state for a different group (wrong key) is rejected
  const h3 = await setup(base());
  h3.store.upsertChat({ id: h3.chatId, kind: "group", groupMasterKey: Buffer.from(randomBytes(32)).toString("base64") });
  await h3.resolver.request(h3.chatId);
  assert.equal(h3.store.data.chats[h3.chatId]!.groupRevision, undefined);
});

test("groups v2: debug lines carry counts only, and nothing is logged without UNIMSG_DEBUG", async () => {
  const lines: string[] = [];
  const orig = { d: console.debug, l: console.log, e: console.error, w: console.warn, i: console.info };
  const cap = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  const prevEnv = process.env.UNIMSG_DEBUG;
  const run = async (fail: boolean) => {
    const h = await setup(base());
    await register(h); h.fake.failures.group = fail ? 1 : 0;
    console.debug = console.log = console.error = console.warn = console.info = cap;
    try { await h.resolver.request(h.chatId); } finally { Object.assign(console, { debug: orig.d, log: orig.l, error: orig.e, warn: orig.w, info: orig.i }); }
    return h;
  };
  try {
    delete process.env.UNIMSG_DEBUG;
    await run(false);
    assert.equal(lines.length as number, 0);
    process.env.UNIMSG_DEBUG = "1";
    const h = await run(false); await run(true);
    assert.ok(lines.length >= 5);
    for (const l of lines) assert.match(l, /^\[signal\] groups v2: [a-z ]+( [a-z]+=[a-z0-9 ]+)*$/i, l);
    const secrets = [TITLE, DESC, ME, MY_PNI, ALICE, Buffer.from(h.masterKey).toString("base64"), Buffer.from(h.masterKey).toString("hex"),
      Buffer.from(h.masterKey).toString("base64url"), h.chatId, "groups/abc", "pw"];
    for (const l of lines) for (const sec of secrets) assert.ok(!l.includes(sec), "secret leaked in a log line");
    assert.ok(lines.some((l) => /resolved ok=1 failed=0/.test(l)));
    assert.ok(lines.some((l) => /resolved ok=0 failed=1 step=fetch reason=http 403/.test(l)));
  } finally {
    if (prevEnv === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prevEnv;
  }
});

test("groups v2: avatar-changed is emitted when the avatar path changes; a big avatar is served from memory", async () => {
  const st = base();
  const h = await setup(st); await register(h);
  await h.resolver.request(h.chatId);
  const changed = () => h.events.filter((e) => e.type === "avatar-changed").length;
  assert.equal(changed(), 1, "first picture");
  st.revision = 4; st.avatarPath = "groups/big"; st.avatar = Buffer.concat([Buffer.from([0x89, 0x50]), Buffer.alloc(1024 * 1024 + 10, 7)]);
  await h.resolver.request(h.chatId, 4);
  assert.equal(changed(), 2, "path changed");
  const rec = h.store.data.chats[h.chatId]!;
  assert.equal(rec.avatarB64, undefined, "too big to persist");
  assert.equal(rec.avatarPath, "groups/big");
  const m = h.resolver.memoryAvatar(h.chatId)!;
  assert.equal(m.data.length, st.avatar.length); assert.equal(m.mime, "image/png");
  st.revision = 5; // same avatar path: not fetched again, no event
  const before = h.fake.calls.avatar;
  await h.resolver.request(h.chatId, 5);
  assert.equal(h.fake.calls.avatar, before); assert.equal(changed(), 2);
});

// Groups v2 MODIFY + sealed multi-recipient group sends against a fake groups server using real zkgroup crypto
// (auth credential + profile key credential presentations are VERIFIED by the fake server). No network.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import { Aci, Pni, ProtocolAddress, groupDecrypt, processSenderKeyDistributionMessage, SenderKeyDistributionMessage, sealedSenderDecryptToUsmc, sealedSenderMultiRecipientMessageForSingleRecipient } from "@signalapp/libsignal-client";
import {
  AuthCredentialPresentation, ClientZkGroupCipher, ClientZkProfileOperations, GroupMasterKey, GroupPublicParams, GroupSecretParams, GroupSendDerivedKeyPair,
  GroupSendEndorsementsResponse, GroupSendFullToken, ProfileKey, ProfileKeyCredentialPresentation, ServerSecretParams, ServerZkAuthOperations, ServerZkProfileOperations, UuidCiphertext,
} from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import type { CoreEvent } from "@unimsg/core";
import {
  AvatarUploadAttributesCodec, GroupActionsCodec, GroupAttributeBlobCodec, GroupChangeCodec, GroupChangeResponseCodec, GroupCodec, GroupResponseCodec, type AvatarUploadAttributesPb,
} from "../protocol/codec.js";
import { ContentCodec } from "../protocol/codec.js";
import { unpadContent } from "../protocol/padding.js";
import { groupIdFromMasterKey } from "../service/groups.js";
import { SignalClient } from "../service/client.js";
import { GroupResolver, GroupsHttpError, type GroupsTransport } from "../service/groupState.js";
import { SealedAccess } from "../service/sealed.js";
import { Sender } from "../service/sender.js";
import { A, B, C, ME, json, makePeer, makePki, makeStore, peerDecrypt, type Peer } from "./fixtures.js";

const MY_PNI = "33333333-3333-4333-8333-333333333333";
const bytes = (u: Uint8Array) => new Uint8Array(u);
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");

interface G { rev: number; title?: Uint8Array; desc?: Uint8Array; avatar?: string; members: Map<string, number>; pending: Set<string>; cts: Map<string, Uint8Array>; pub: GroupPublicParams }

class FakeGroups {
  server = ServerSecretParams.generate();
  zk = new ServerZkAuthOperations(this.server);
  profile = new ServerZkProfileOperations(this.server);
  groups = new Map<string, G>();
  blobs = new Map<string, Uint8Array>();
  commitments = new Map<string, { aci: string; key: ProfileKey }>();
  forbid = false; conflictOnce = false;
  log: string[] = [];
  actions: ReturnType<typeof GroupActionsCodec.decode>[] = [];
  addUser(aci: string, key: Uint8Array) { this.commitments.set(aci, { aci, key: new ProfileKey(bytes(key)) }); }

  private auth(basic: string): { g?: G; pub: GroupPublicParams; caller: string } {
    const [u, p] = Buffer.from(basic, "base64").toString().split(":");
    const pub = new GroupPublicParams(bytes(Buffer.from(u!, "hex")));
    const pres = new AuthCredentialPresentation(bytes(Buffer.from(p!, "hex")));
    this.zk.verifyAuthCredentialPresentation(pub, pres); // throws if forged
    return { g: this.groups.get(hex(pub.serialize())), pub, caller: hex(pres.getUuidCiphertext().serialize()) };
  }
  transport(): GroupsTransport {
    const self = this;
    return {
      async authCredentials(start) {
        const day = Math.floor(Date.now() / 1000 / 86400) * 86400;
        void start;
        return { credentials: [0, 1, 2].map((d) => ({ redemptionTime: day + d * 86400,
          credential: Buffer.from(self.zk.issueAuthCredentialWithPniZkc(Aci.fromUuid(ME), Pni.fromUuid(MY_PNI), day + d * 86400).serialize()).toString("base64") })), pni: `PNI:${MY_PNI}` };
      },
      async fetchGroup(basic) {
        const { g, caller } = self.auth(basic);
        if (!g || !g.members.has(caller)) throw new GroupsHttpError(g ? 403 : 404);
        const cts = [...g.members.keys()].map((k) => new UuidCiphertext(bytes(g.cts.get(k)!)));
        const exp = new Date(Math.floor(Date.now() / 86400_000) * 86400_000 + 3 * 86400_000);
        const endorsements = GroupSendEndorsementsResponse.issue(cts, GroupSendDerivedKeyPair.forExpiration(exp, self.server)).serialize();
        return GroupResponseCodec.encode({ group: {
          publicKey: g.pub.serialize(), version: g.rev, title: g.title, descriptionBytes: g.desc, avatar: g.avatar,
          members: [...g.members].map(([k, role]) => ({ userId: g.cts.get(k), role })),
          membersPendingProfileKey: [...g.pending].map((k) => ({ member: { userId: g.cts.get(k), role: 1 } })),
        }, groupSendEndorsementsResponse: endorsements });
      },
      async fetchAvatar(path) { return self.blobs.get(path)!; },
      async createGroup(basic, body) {
        const { pub, caller } = self.auth(basic);
        const grp = GroupCodec.decode(body);
        const g: G = { rev: 0, title: grp.title, avatar: grp.avatar, members: new Map(), pending: new Set(), cts: new Map(), pub };
        for (const m of grp.members ?? []) {
          const pres = new ProfileKeyCredentialPresentation(bytes(m.presentation!));
          self.profile.verifyProfileKeyCredentialPresentation(pub, pres);
          const ct = pres.getUuidCiphertext().serialize(); g.cts.set(hex(ct), ct); g.members.set(hex(ct), m.role!);
        }
        for (const p of grp.membersPendingProfileKey ?? []) { const ct = p.member!.userId!; g.cts.set(hex(ct), ct); g.pending.add(hex(ct)); }
        if (g.members.get(caller) !== 2) throw new GroupsHttpError(403);
        self.groups.set(hex(pub.serialize()), g); self.log.push("create");
        return new Uint8Array();
      },
      async modifyGroup(basic, body) {
        const { g, caller } = self.auth(basic);
        if (!g || !g.members.has(caller) || self.forbid) throw new GroupsHttpError(403);
        const a = GroupActionsCodec.decode(body); self.actions.push(a);
        if (self.conflictOnce) { self.conflictOnce = false; g.rev++; throw new GroupsHttpError(409); }
        if (a.version !== g.rev + 1) throw new GroupsHttpError(409);
        for (const m of a.addMembers ?? []) {
          const pres = new ProfileKeyCredentialPresentation(bytes(m.added!.presentation!));
          self.profile.verifyProfileKeyCredentialPresentation(g.pub, pres);
          const ct = pres.getUuidCiphertext().serialize(); g.cts.set(hex(ct), ct); g.members.set(hex(ct), 1);
        }
        for (const p of a.addPendingMembers ?? []) { const ct = p.added!.member!.userId!; g.cts.set(hex(ct), ct); g.pending.add(hex(ct)); }
        for (const d of a.deleteMembers ?? []) g.members.delete(hex(d.deletedUserId!));
        for (const d of a.deletePendingMembers ?? []) g.pending.delete(hex(d.deletedUserId!));
        if (a.modifyTitle) g.title = a.modifyTitle.title;
        if (a.modifyDescription) g.desc = a.modifyDescription.descriptionBytes;
        if (a.modifyAvatar) g.avatar = a.modifyAvatar.avatar || undefined;
        g.rev = a.version!; self.log.push("modify");
        return GroupChangeResponseCodec.encode({ groupChange: { actions: GroupActionsCodec.encode({ ...a, sourceUserId: g.cts.get(caller) }), serverSignature: randomBytes(64) } });
      },
      async avatarForm(basic) { self.auth(basic); return AvatarUploadAttributesCodec.encode({ key: `groups/av${self.blobs.size}`, credential: "c", acl: "private", algorithm: "a", date: "d", policy: "p", signature: "s" }); },
      async uploadAvatar(form: AvatarUploadAttributesPb, enc) { self.blobs.set(form.key!, enc); },
    };
  }
  unauthCredentials(): { getProfileKeyCredential: (r: { requestContext: never; serverParams: never }) => Promise<unknown> } {
    const self = this;
    return {
      async getProfileKeyCredential({ requestContext, serverParams }) {
        const ops = new ClientZkProfileOperations(serverParams);
        const expiry = Math.floor(Date.now() / 86400_000) * 86400 + 5 * 86400;
        for (const c of self.commitments.values()) {
          try {
            const resp = self.profile.issueExpiringProfileKeyCredential((requestContext as { getRequest(): never }).getRequest(), Aci.fromUuid(c.aci), c.key.getCommitment(Aci.fromUuid(c.aci)), expiry);
            return ops.receiveExpiringProfileKeyCredential(requestContext, resp);
          } catch { /* not this user's profile key */ }
        }
        throw new Error("profile not found");
      },
    };
  }
}

async function setup(o: { knowKeys?: string[] } = {}) {
  const myKey = randomBytes(32);
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-gm-")) });
  await client.store.load();
  const me = client.store;
  const fake = new FakeGroups();
  const keys: Record<string, Uint8Array> = { [ME]: myKey, [A]: randomBytes(32), [B]: randomBytes(32), [C]: randomBytes(32) };
  me.setAccount({ aci: ME, pni: MY_PNI, deviceId: 2, password: "pw", registrationId: 7, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0, profileKey: Buffer.from(myKey).toString("base64") });
  for (const [aci, k] of Object.entries(keys)) fake.addUser(aci, k);
  for (const aci of o.knowKeys ?? [A, B]) me.data.contacts[aci] = { aci, profileKey: Buffer.from(keys[aci]!).toString("base64") };
  const peers: Record<string, Peer> = { [A]: await makePeer(A, keys[A]!), [B]: await makePeer(B, keys[B]!), [C]: await makePeer(C, keys[C]!) };
  const pki = makePki(me);
  const sealedSent: { destination: string; contents: { contents: Uint8Array }[] }[] = [];
  const authSent: { destination: string }[] = [];
  const multi: { payload: Uint8Array; auth: GroupSendFullToken }[] = [];
  const auth = {
    fetch: async (r: { path: string }) => {
      if (r.path.startsWith("/v1/certificate/delivery")) return json({ certificate: pki.certB64 });
      const m = /^\/v2\/keys\/([^/]+)/.exec(r.path);
      if (m && peers[m[1]!]) return json(peers[m[1]!]!.bundle);
      return { status: 404, body: undefined };
    },
    sendMessage: async (r: { destination: Aci }) => { authSent.push({ destination: r.destination.getRawUuid() }); },
    sendSyncMessage: async () => {},
  };
  let multiFail: Error | undefined;
  const unauth = {
    ...fake.unauthCredentials(),
    sendMessage: async (r: { destination: Aci; contents: { contents: Uint8Array }[] }) => { sealedSent.push({ destination: r.destination.getRawUuid(), contents: r.contents }); },
    sendMultiRecipientMessage: async (r: { payload: Uint8Array; auth: GroupSendFullToken }) => { if (multiFail) throw multiFail; multi.push(r); return { unregisteredIds: [] }; },
  };
  const events: CoreEvent[] = [];
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void };
  priv.emit = (e) => events.push(e);
  priv.chatConn = auth; priv.unauthConn = unauth;
  priv.transportOverride = fake.transport();
  priv.stopped = false;
  priv.groupResolver = new GroupResolver(me, () => fake.transport(), (e) => events.push(e), { serverPublicParams: fake.server.getPublicParams().serialize() });
  priv.sender = new Sender(me, () => auth as never, { unauth: async () => unauth as never, sealed: new SealedAccess(me, () => auth as never, { trustRoots: () => [pki.rootPublic] }) });
  priv.makeInbound();
  return { client, me, fake, peers, keys, events, sealedSent, authSent, multi, pki, failMulti: (e: Error) => { multiFail = e; } };
}

const serverGroup = (h: Awaited<ReturnType<typeof setup>>, chatId: string) => {
  const rec = h.me.data.chats[chatId]!;
  const secret = GroupSecretParams.deriveFromMasterKey(new GroupMasterKey(bytes(Buffer.from(rec.groupMasterKey!, "base64"))));
  const g = h.fake.groups.get(hex(secret.getPublicParams().serialize()))!;
  const cipher = new ClientZkGroupCipher(secret);
  const blob = (b?: Uint8Array) => (b ? GroupAttributeBlobCodec.decode(cipher.decryptBlob(bytes(b))) : undefined);
  const memberAcis = (set: Iterable<string>) => [...set].map((k) => cipher.decryptServiceId(new UuidCiphertext(bytes(g.cts.get(k)!))).getRawUuid());
  return { g, cipher, secret, title: blob(g.title)?.title, desc: blob(g.desc)?.descriptionText, members: memberAcis(g.members.keys()), pending: memberAcis(g.pending), rec };
};

test("createGroup: encrypted title, ProfileKeyCredential members, invitees as pending, members are told", async () => {
  const h = await setup({ knowKeys: [A] }); // B's profile key is unknown -> invited
  const chat = await h.client.createGroup("Book Club 7731", [A, B]);
  const s = serverGroup(h, chat.id);
  assert.equal(s.title, "Book Club 7731");
  assert.deepEqual(s.members.sort(), [A, ME].sort()); assert.deepEqual(s.pending, [B]);
  assert.equal(chat.name, "Book Club 7731"); assert.equal(chat.kind, "group");
  assert.equal(h.me.data.chats[chat.id]!.groupRevision, 0);
  // the announcement reached both A and B with the group master key (sealed: A has a profile key known; B has none -> authenticated)
  assert.deepEqual(h.sealedSent.map((x) => x.destination), [A]);
  assert.deepEqual(h.authSent.map((x) => x.destination).filter((d) => d === B), [B]);
  const got = await peerDecrypt(h.peers[A]!, h.sealedSent[0]!.contents[0]!.contents, h.pki.rootPublic);
  assert.deepEqual(got.content.dataMessage!.groupV2!.masterKey, new Uint8Array(Buffer.from(s.rec.groupMasterKey!, "base64")));
  assert.ok(h.events.some((e) => e.type === "error" && e.data.code === "group-invited"));
  await assert.rejects(h.client.createGroup("  ", [A]), /needs a name/);
  await assert.rejects(h.client.createGroup("Solo", []), /at least one other person/);
});

test("rename, description, add/remove members: each is a signed-by-credential action, state is refreshed, groupChange is sent", async () => {
  const h = await setup({ knowKeys: [A, B] });
  const chat = await h.client.createGroup("Old", [A]);
  h.sealedSent.length = 0;
  await h.client.renameChat(chat.id, "New name");
  let s = serverGroup(h, chat.id);
  assert.equal(s.title, "New name"); assert.equal(h.me.data.chats[chat.id]!.name, "New name"); assert.equal(h.me.data.chats[chat.id]!.groupRevision, 1);
  const got = await peerDecrypt(h.peers[A]!, h.sealedSent[0]!.contents[0]!.contents, h.pki.rootPublic);
  const gv2 = got.content.dataMessage!.groupV2!;
  assert.equal(gv2.revision, 1);
  const change = GroupChangeCodec.decode(gv2.groupChange!);
  const actions = GroupActionsCodec.decode(change.actions!);
  assert.equal(actions.version, 1); assert.ok(actions.modifyTitle?.title?.length);

  await h.client.setChatDescription(chat.id, "Tuesdays 4417");
  s = serverGroup(h, chat.id); assert.equal(s.desc, "Tuesdays 4417");
  assert.equal(h.client.groupAvatar(chat.id), undefined);

  await h.client.addMembers(chat.id, [B]);
  s = serverGroup(h, chat.id); assert.deepEqual(s.members.sort(), [A, B, ME].sort());
  h.sealedSent.length = 0; h.authSent.length = 0;
  await h.client.removeMember(chat.id, A);
  s = serverGroup(h, chat.id); assert.deepEqual(s.members.sort(), [B, ME].sort());
  // the removed person AND the remaining one are notified
  assert.deepEqual([...h.sealedSent.map((x) => x.destination)].sort(), [A, B].sort());
  await assert.rejects(h.client.removeMember(chat.id, ME), /leave the group/);
  await assert.rejects(h.client.renameChat(chat.id, " "), /can't be empty/);
  await assert.rejects(h.client.renameChat(A, "x"), /not implemented/);
});

test("setChatPicture: encrypted avatar upload form + modifyAvatar, round trips through the resolver; null removes it", async () => {
  const h = await setup();
  const chat = await h.client.createGroup("Pics", [A]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(50)]);
  await h.client.setChatPicture(chat.id, { data: png, mime: "image/png" });
  const s = serverGroup(h, chat.id);
  assert.ok(s.g.avatar);
  assert.deepEqual(Buffer.from(GroupAttributeBlobCodec.decode(s.cipher.decryptBlob(bytes(h.fake.blobs.get(s.g.avatar!)!))).avatar!), png);
  assert.deepEqual(Buffer.from(h.client.groupAvatar(chat.id)!.data), png);
  await h.client.setChatPicture(chat.id, null);
  assert.equal(serverGroup(h, chat.id).g.avatar, undefined); assert.equal(h.client.groupAvatar(chat.id), undefined);
  await assert.rejects(h.client.setChatPicture(chat.id, { data: new Uint8Array(1024 * 1024 + 1), mime: "image/png" }), /smaller than 1 MB/);
});

test("revision conflict (409) refetches and retries; 403 becomes a plain 'only admins' message", async () => {
  const h = await setup();
  const chat = await h.client.createGroup("Race", [A]);
  h.fake.conflictOnce = true; h.fake.actions.length = 0;
  await h.client.renameChat(chat.id, "After conflict");
  assert.equal(h.fake.actions.length, 2);
  assert.equal(h.fake.actions[1]!.version, h.fake.actions[0]!.version! + 1); // rebuilt on the newer revision
  assert.equal(serverGroup(h, chat.id).title, "After conflict");
  h.fake.forbid = true;
  await assert.rejects(h.client.renameChat(chat.id, "nope"), (e: Error) => /Only group admins can rename the group/.test(e.message) && !/403|HTTP/.test(e.message));
});

test("leaveChat: deletes me from the group and the local chat; the only admin must hand over first", async () => {
  const h = await setup();
  const chat = await h.client.createGroup("Leave me", [A]);
  await assert.rejects(h.client.leaveChat(chat.id), /only admin/);
  h.me.data.chats[chat.id]!.groupAdmins = [ME, A]; // as if someone else is an admin too
  await h.client.leaveChat(chat.id);
  assert.equal(h.me.data.chats[chat.id], undefined);
  assert.ok([...h.fake.groups.values()].every((g) => g.members.size === 1)); // only A remains
});

test("group send: ONE sealed multi-recipient request with a verified send token; sender key shared once via sealed 1:1", async () => {
  const h = await setup({ knowKeys: [A, B] });
  const chat = await h.client.createGroup("Fan out", [A, B]);
  h.sealedSent.length = 0; h.authSent.length = 0;
  const lines: string[] = [];
  const orig = console.debug; const prev = process.env.UNIMSG_DEBUG;
  process.env.UNIMSG_DEBUG = "1"; console.debug = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await h.client.send(chat.id, { text: "hello group 1" }); await h.client.send(chat.id, { text: "hello group 2" }); }
  finally { console.debug = orig; if (prev === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prev; }
  assert.equal(h.multi.length, 2);
  // first send distributed the sender key to both members (sealed 1:1), the second did not
  assert.equal(h.sealedSent.length, 2);
  // the server verifies the token for exactly {A,B} with the key for its expiration
  const token = h.multi[0]!.auth;
  token.verify([Aci.fromUuid(A), Aci.fromUuid(B)], GroupSendDerivedKeyPair.forExpiration(token.getExpiration(), h.fake.server));
  assert.throws(() => token.verify([Aci.fromUuid(A)], GroupSendDerivedKeyPair.forExpiration(token.getExpiration(), h.fake.server)));
  assert.ok(lines.some((l) => /^\[signal\] send: mode=sealed recipients=2 delivered=2 failed=0 fallback=0$/.test(l)), lines.join("|"));
  assert.ok(lines.every((l) => !l.includes(A) && !l.includes("hello")));
});

test("group send: recipient decrypts the multi-recipient message with the distributed sender key", async () => {
  const h = await setup({ knowKeys: [A] });
  (h.client as unknown as { multiRecipientMin: number }).multiRecipientMin = 1;
  const chat = await h.client.createGroup("Pair", [A]);
  h.sealedSent.length = 0;
  await h.client.send(chat.id, { text: "only for members" });
  const sender = ProtocolAddress.new(Aci.fromUuid(ME), 2);
  // 1) the sender key distribution message arrives as a sealed 1:1 message at each member
  for (const aci of [A]) {
    const sent = h.sealedSent.find((x) => x.destination === aci)!;
    const skdm = await peerDecrypt(h.peers[aci]!, sent.contents[0]!.contents, h.pki.rootPublic);
    await processSenderKeyDistributionMessage(sender, SenderKeyDistributionMessage.deserialize(bytes(skdm.content.senderKeyDistributionMessage!)), h.peers[aci]!.store.senderKeys);
  }
  // 2) the multi-recipient payload, extracted for one recipient, decrypts via group decrypt (extraction needs exactly one recipient)
  const single = sealedSenderMultiRecipientMessageForSingleRecipient(bytes(h.multi[0]!.payload));
  let body: string | undefined;
  for (const aci of [A]) {
    try {
      const usmc = await sealedSenderDecryptToUsmc(single, h.peers[aci]!.store.stores("aci").identities);
      const plain = await groupDecrypt(sender, h.peers[aci]!.store.senderKeys, usmc.contents());
      body = ContentCodec.decode(unpadContent(plain)).dataMessage!.body;
      assert.deepEqual(usmc.groupId(), groupIdFromMasterKey(new Uint8Array(Buffer.from(h.me.data.chats[chat.id]!.groupMasterKey!, "base64"))));
      break;
    } catch (e) { if (e instanceof assert.AssertionError) throw e; }
  }
  assert.equal(body, "only for members");
});

test("group send: refused token falls back to per-member sends; no endorsements means no multi-recipient attempt", async () => {
  const h = await setup({ knowKeys: [A, B] });
  const chat = await h.client.createGroup("Fallback", [A, B]);
  const { LibSignalErrorBase } = await import("@signalapp/libsignal-client");
  h.failMulti(new LibSignalErrorBase("x", "RequestUnauthorized" as never, "test"));
  h.sealedSent.length = 0;
  await h.client.send(chat.id, { text: "fallback" });
  assert.equal(h.multi.length, 0);
  assert.ok(h.sealedSent.length >= 2, "per-member sealed sends");
  assert.equal(h.me.data.chats[chat.id]!.endorsements, undefined); // refused endorsements are dropped and refetched with the state
});

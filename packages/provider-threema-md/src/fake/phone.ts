// FAKE "phone": the existing device (ED) of the join protocol (RRD role) and, once connected, another member of the device group that reflects
// messages like the real leader would. Offline tests only.
import { randomBytes } from "node:crypto";
import { Mediator, type Reflected } from "../mediator.js";
import { RendezvousChannel, wsTransport } from "../rendezvous.js";
import { deriveDeviceGroupKeys, type DeviceGroupKeys } from "../keys.js";
import { rphEmoji } from "../emoji.js";
import { generateKeyPair, secretbox } from "../nacl.js";
import { decode, encode, type Msg } from "../proto.js";
import { DeviceGroupJoinRequestOrOffer, EdToNd, NdToEd } from "../schemas.js";
import { FakeBackend, newPeer, type Peer } from "./servers.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export interface PhoneContact { peer: Peer; first?: string; last?: string; nick?: string; acq?: number; feature?: bigint; avatar?: Uint8Array; lastAt?: number }
export interface PhoneGroup { creator: string; id: bigint; name: string; members: string[]; lastAt?: number }

export class FakePhone {
  identity: string; me: Peer; dgk = new Uint8Array(randomBytes(32)); keys: DeviceGroupKeys; serverGroup = "ab"; deviceId = 0x1111222233334444n;
  contacts: PhoneContact[] = []; groups: PhoneGroup[] = []; blocked: string[] = []; nickname = "Phone Owner"; nonceHashes: Uint8Array[] = [];
  med?: Mediator; got: Reflected[] = []; emoji: string[] = []; registeredSeen = false; confirm = true;
  be: FakeBackend;
  constructor(be: FakeBackend, identity = "PHONE001") { this.be = be; this.identity = identity; this.me = newPeer(identity); this.keys = deriveDeviceGroupKeys(this.dgk); be.registerIdentity(identity, this.me.pk); be.registerGroup(identity, this.dgk, this.serverGroup); }
  addContact(id: string, o: Partial<PhoneContact> = {}) { const c: PhoneContact = { peer: newPeer(id), acq: 0, feature: 0x7ffn, ...o }; this.contacts.push(c); this.be.registerIdentity(id, c.peer.pk); return c; }

  /** Existing device side of "request to join": scan the QR payload. Resolves when ND sent `Registered`. */
  async scan(url: string): Promise<void> {
    const m = /^threema:\/\/device-group\/join#([A-Za-z0-9_-]+)$/.exec(url); if (!m) throw new Error("not a join URL");
    const req = decode(DeviceGroupJoinRequestOrOffer, new Uint8Array(Buffer.from(m[1], "base64url")));
    if (!req.variant?.requestToJoin) throw new Error("not a request to join");
    const init = req.rendezvousInit, rw = init.relayedWebSocket;
    const t = await wsTransport(rw.url); const ch = new RendezvousChannel("rrd", init.ak, rw.pathId, t);
    const { rph } = await ch.handshake(10_000); this.emoji = rphEmoji(rph); await ch.nominate();
    if (!this.confirm) { ch.close(4100); throw new Error("user did not confirm"); }
    ch.send(encode(EdToNd, { begin: {} }));
    const blobs: Msg[] = []; const pic = (data?: Uint8Array) => { if (!data) return undefined; const key = new Uint8Array(randomBytes(32)), id = new Uint8Array(randomBytes(16)); const n = new Uint8Array(24); n[23] = 1; blobs.push({ id, data: secretbox(data, n, key) }); return { updated: { type: 0, blob: { id, key } } }; };
    const contacts = this.contacts.map((c) => ({ contact: { identity: c.peer.id, publicKey: c.peer.pk, createdAt: 1n, firstName: c.first, lastName: c.last, nickname: c.nick, acquaintanceLevel: c.acq ?? 0, featureMask: c.feature, contactDefinedProfilePicture: pic(c.avatar) }, lastUpdateAt: c.lastAt ? BigInt(c.lastAt) : undefined }));
    const groups = this.groups.map((g) => ({ group: { groupIdentity: { groupId: g.id, creatorIdentity: g.creator }, name: g.name, userState: 0, memberIdentities: { identities: g.members } }, lastUpdateAt: BigInt(g.lastAt ?? 1) }));
    for (const b of blobs) ch.send(encode(EdToNd, { blobData: b }));
    ch.send(encode(EdToNd, { essentialData: {
      identityData: { identity: this.identity, ck: this.me.sk, cspDeviceCookie: new Uint8Array(randomBytes(16)), cspServerGroup: this.serverGroup },
      deviceGroupData: { dgk: this.dgk }, userProfile: { nickname: this.nickname }, settings: { readReceiptPolicy: 0, typingIndicatorPolicy: 0, blockedIdentities: { identities: this.blocked } },
      contacts, groups, cspHashedNonces: this.nonceHashes, d2dHashedNonces: [] } }));
    for (;;) { const f = decode(NdToEd, await ch.recv(15_000)); if (f.registered) { this.registeredSeen = true; break; } }
    ch.close(1000);
  }

  /** Connect the phone to the (fake) mediator as an existing device; it becomes the leader when it connects first. */
  async connect(mediatorBase: string): Promise<void> {
    const m = this.med = new Mediator({ url: mediatorBase + hex(new Uint8Array(0)), serverGroup: this.serverGroup, keys: this.keys, deviceId: this.deviceId, label: "Phone", platformDetails: "FakePhone", appVersion: "1", expectedSlot: this.phoneKnown ? 1 : 0 });
    (m as any).o.url = mediatorBase; // the client class appends the url info itself
    m.on("reflected", (r: Reflected) => { this.got.push(r); if (!(r.flags & 1)) m.ackReflected(r.id); });
    await m.connect(); m.flow(); this.phoneKnown = true;
  }
  phoneKnown = false;
  /** The phone (leader) received a message from the chat server and reflects it. */
  incoming(from: string, id: bigint, type: number, body: Uint8Array, at = Date.now()) { return this.med!.reflect({ incomingMessage: { senderIdentity: from, messageId: id, createdAt: BigInt(at), type, body, nonce: new Uint8Array(randomBytes(24)) } }); }
  outgoing(conv: Msg, id: bigint, type: number, body: Uint8Array, at = Date.now()) { return this.med!.reflect({ outgoingMessage: { conversation: conv, messageId: id, createdAt: BigInt(at), type, body, nonces: [new Uint8Array(randomBytes(24))] } }); }
  reflect(body: Msg, ephemeral = false) { return this.med!.reflect(body, ephemeral); }
  close() { this.med?.close(); }
}
void generateKeyPair;

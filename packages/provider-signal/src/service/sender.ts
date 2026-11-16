// Outbound 1:1 delivery over the authenticated chat connection (unsealed sender):
//   per device: signalEncrypt -> AuthMessagesService.sendMessage / sendSyncMessage.
// Missing sessions are bootstrapped from GET /v2/keys/<aci>/<device|*> prekey bundles.
// Mismatched-device errors are handled the standard way (drop extra, refresh stale/missing, retry).
// SEALED SENDER (see ./sealed.ts): for 1:1 sends to non-self recipients we first try unidentified delivery
//   signalEncrypt -> UnidentifiedSenderMessageContent(sender certificate) -> sealedSenderEncrypt -> UnauthMessagesService.sendMessage
// authorised with the recipient's access key (derived from their profile key) or "unrestricted". Without a certificate / key /
// unauth connection, or when the server answers 401, we fall back to the authenticated (unsealed) path. Group sends use ONE
// sealed multi-recipient request over sender keys when group send endorsements are available (deliverGroup), else per-member
// deliver(). Sync transcripts to our own devices always stay authenticated.
import { randomUUID } from "node:crypto";
import {
  Aci, ContentHint, ErrorCode, KEMPublicKey, LibSignalErrorBase, PreKeyBundle, ProtocolAddress, PublicKey, SenderKeyDistributionMessage,
  UnidentifiedSenderMessageContent, groupEncrypt, processPreKeyBundle, sealedSenderEncrypt, sealedSenderMultiRecipientEncrypt, signalEncrypt,
} from "@signalapp/libsignal-client";
import { GroupSendEndorsement, type GroupSecretParams } from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import { fromB64, toBytes } from "../protocol/bytes.js";
import { ContentCodec, type Content } from "../protocol/codec.js";
import { padContent } from "../protocol/padding.js";
import type { SignalStore } from "../store/signalStore.js";
import type { AuthChat, UnauthChat } from "./chatTypes.js";
import type { Access, SealedAccess } from "./sealed.js";

interface KeysResponse {
  identityKey: string;
  devices: {
    deviceId: number; registrationId: number;
    signedPreKey?: { keyId: number; publicKey: string; signature: string };
    preKey?: { keyId: number; publicKey: string };
    pqPreKey?: { keyId: number; publicKey: string; signature: string };
  }[];
}

export class SendError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

export interface DeliverOptions {
  urgent?: boolean; onlineOnly?: boolean;
  /** Group id (zkgroup identifier) put into the sealed-sender content for group messages. */
  groupId?: Uint8Array;
  /** Never seal this send. */
  unsealed?: boolean;
}
/** What `deliver` actually did (for the `[signal] send:` debug line). */
export interface DeliverResult { mode: "sealed" | "authenticated"; fallback: boolean }

export interface SenderDeps {
  /** The unauthenticated chat connection used for sealed sends (undefined = unavailable right now). */
  unauth?: () => Promise<UnauthChat | undefined>;
  /** Called when a sealed send failed because the unauthenticated connection itself is broken. */
  unauthBroken?: () => void;
  sealed?: SealedAccess;
}

export interface GroupSendRequest {
  chatId: string; members: string[]; content: Content; timestamp: number; groupId: Uint8Array; secret: GroupSecretParams;
}
export interface GroupSendResult { mode: "sealed"; delivered: number; failed: number; fallback: number; /** Members that could not be prepared/sent in the multi-recipient request and are worth an individual retry (not: unregistered accounts). */ retry?: string[] }

const contentHint = (c: Content) => (c.dataMessage || c.editMessage ? ContentHint.Resendable : ContentHint.Implicit);

export class Sender {
  constructor(private readonly store: SignalStore, private readonly chat: () => AuthChat, readonly deps: SenderDeps = {}) {}

  private get account() { return this.store.requireAccount(); }
  private get local() { return ProtocolAddress.new(Aci.fromUuid(this.account.aci), this.account.deviceId); }

  private knownDevices(aci: string): number[] {
    const prefix = `aci:${aci.toLowerCase()}.`;
    return Object.keys(this.store.data.sessions).filter((k) => k.startsWith(prefix)).map((k) => Number(k.slice(prefix.length)))
      .filter((n) => Number.isInteger(n));
  }
  private dropSession(aci: string, device: number) { delete this.store.data.sessions[`aci:${aci.toLowerCase()}.${device}`]; this.store.touch(); }

  /**
   * Fetch prekey bundles and establish sessions. `device` undefined = all devices. Returns false only when ONE specific device
   * no longer exists (404): the caller then simply leaves it out instead of failing the whole send to the person.
   */
  private async fetchBundles(aci: string, device?: number): Promise<boolean> {
    const res = await this.chat().fetch({ verb: "GET", path: `/v2/keys/${aci}/${device ?? "*"}`, headers: [] });
    if (res.status === 404) { if (device !== undefined) return false; throw new SendError("recipient not found or has no prekeys"); }
    if (res.status < 200 || res.status >= 300) throw new SendError(`prekey fetch failed (HTTP ${res.status})`, res.status >= 500 || res.status === 429);
    const json = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")) as KeysResponse;
    const identity = PublicKey.deserialize(fromB64(json.identityKey));
    const st = this.store.stores("aci");
    for (const d of json.devices) {
      if (!d.signedPreKey || !d.pqPreKey) throw new SendError("recipient device has no signed/PQ prekey");
      const bundle = PreKeyBundle.new(
        d.registrationId, d.deviceId, d.preKey?.keyId ?? null, d.preKey ? PublicKey.deserialize(fromB64(d.preKey.publicKey)) : null,
        d.signedPreKey.keyId, PublicKey.deserialize(fromB64(d.signedPreKey.publicKey)), fromB64(d.signedPreKey.signature), identity,
        d.pqPreKey.keyId, KEMPublicKey.deserialize(fromB64(d.pqPreKey.publicKey)), fromB64(d.pqPreKey.signature));
      await processPreKeyBundle(bundle, ProtocolAddress.new(Aci.fromUuid(aci), d.deviceId), this.local, st.sessions, st.identities);
    }
    return true;
  }

  /** Encrypt for one device; a session that cannot encrypt (corrupt/invalid) is reset from a fresh bundle ONCE. undefined = the device is gone. */
  private async encryptFor(aci: string, deviceId: number, plain: Uint8Array<ArrayBuffer>): Promise<{ ct: Awaited<ReturnType<typeof signalEncrypt>>; registrationId: number } | undefined> {
    const st = this.store.stores("aci");
    const addr = ProtocolAddress.new(Aci.fromUuid(aci), deviceId);
    const attempt = async () => {
      const ct = await signalEncrypt(plain, addr, this.local, st.sessions, st.identities);
      const rec = await st.sessions.getSession(addr);
      if (!rec) throw new SendError("session missing after encrypt");
      return { ct, registrationId: rec.remoteRegistrationId() };
    };
    try { return await attempt(); }
    catch (e) {
      if (e instanceof SendError) throw e;
      this.dropSession(aci, deviceId);
      if (!(await this.fetchBundles(aci, deviceId))) return undefined;
      return await attempt();
    }
  }

  /**
   * Encrypt `content` for every device of `aci` and send it.
   * mode "message": normal 1:1 send. mode "sync": aci must be our own account (sync to linked devices).
   */
  async deliver(aci: string, content: Content, timestamp: number, mode: "message" | "sync", opts: DeliverOptions = {}): Promise<DeliverResult> {
    const plain = padContent(ContentCodec.encode(content));
    const self = aci.toLowerCase() === this.account.aci.toLowerCase();
    const st = this.store.stores("aci");
    let devices = this.knownDevices(aci).filter((d) => !(self && d === this.account.deviceId));
    if (devices.length === 0) {
      await this.fetchBundles(aci);
      devices = this.knownDevices(aci).filter((d) => !(self && d === this.account.deviceId));
    }
    if (devices.length === 0) {
      if (mode === "sync") return { mode: "authenticated", fallback: false }; // no other linked devices
      throw new SendError("no devices to send to");
    }
    // ---- sealed sender preconditions (message mode, not to ourselves) ----
    const wantSealed = mode === "message" && !self && !!this.deps.sealed && !!this.deps.unauth && !opts.unsealed;
    let sealedNow = false;
    let cert: Awaited<ReturnType<SealedAccess["cert"]>>;
    let access: Access | undefined;
    let unauth: UnauthChat | undefined;
    if (wantSealed) {
      cert = await this.deps.sealed!.cert();
      access = cert ? await this.deps.sealed!.access(aci) : undefined;
      unauth = access ? await this.deps.unauth!() : undefined;
      sealedNow = !!(cert && access && unauth);
    }
    let fellBack = wantSealed && !sealedNow;
    for (let attempt = 0; attempt < 5; attempt++) {
      const contents = [];
      const sealedContents = [];
      for (const deviceId of devices) {
        const addr = ProtocolAddress.new(Aci.fromUuid(aci), deviceId);
        const enc = await this.encryptFor(aci, deviceId, plain);
        if (!enc) continue; // device vanished while we were resetting its session
        if (sealedNow) {
          const usmc = UnidentifiedSenderMessageContent.new(enc.ct, cert!, contentHint(content), opts.groupId ? toBytes(opts.groupId) : null);
          sealedContents.push({ deviceId, registrationId: enc.registrationId, contents: await sealedSenderEncrypt(usmc, addr, st.identities) });
        } else contents.push({ deviceId, registrationId: enc.registrationId, contents: enc.ct });
      }
      if (contents.length + sealedContents.length === 0) {
        if (mode === "sync") return { mode: "authenticated", fallback: false };
        throw new SendError("no devices to send to");
      }
      await this.store.flush();
      try {
        if (sealedNow) {
          await unauth!.sendMessage({
            destination: Aci.fromUuid(aci), timestamp, contents: sealedContents, onlineOnly: opts.onlineOnly ?? false, urgent: opts.urgent ?? true,
            auth: access!.kind === "unrestricted" ? "unrestricted" : { accessKey: toBytes(access!.key) },
          });
          return { mode: "sealed", fallback: false };
        }
        const chat = this.chat();
        if (mode === "sync") await chat.sendSyncMessage({ timestamp, contents, urgent: opts.urgent ?? false });
        else await chat.sendMessage({ destination: Aci.fromUuid(aci), timestamp, contents, onlineOnly: opts.onlineOnly ?? false, urgent: opts.urgent ?? true });
        return { mode: "authenticated", fallback: fellBack };
      } catch (e) {
        if (LibSignalErrorBase.is(e, ErrorCode.MismatchedDevices)) {
          const entry = e.entries.find((x) => x.account.getRawUuid().toLowerCase() === aci.toLowerCase());
          if (!entry) throw e;
          for (const d of [...entry.extraDevices, ...entry.staleDevices]) this.dropSession(aci, d);
          for (const d of [...entry.missingDevices, ...entry.staleDevices]) await this.fetchBundles(aci, d);
          devices = this.knownDevices(aci).filter((d) => !(self && d === this.account.deviceId));
          if (devices.length === 0) {
            if (mode === "sync") return { mode: "authenticated", fallback: false };
            throw new SendError("no devices to send to");
          }
          continue;
        }
        if (LibSignalErrorBase.is(e, ErrorCode.ServiceIdNotFound)) throw new SendError("recipient is no longer registered with Signal");
        if (LibSignalErrorBase.is(e, ErrorCode.RateLimitedError)) throw new SendError(`rate limited, retry in ${e.retryAfterSecs}s`, true);
        if (LibSignalErrorBase.is(e, ErrorCode.RateLimitChallengeError)) throw new SendError("Signal requires a rate-limit challenge (captcha); not supported");
        if (sealedNow) {
          // 401: our access key is wrong/stale -> maybe the account is "unrestricted", else authenticated fallback.
          if (LibSignalErrorBase.is(e, ErrorCode.RequestUnauthorized)) {
            const next = await this.deps.sealed!.rejected(aci);
            if (next && access!.kind !== "unrestricted") { access = next; continue; }
          } else this.deps.unauthBroken?.(); // connection-level failure: don't trust the unauth socket
          sealedNow = false; fellBack = true; continue;
        }
        throw e;
      }
    }
    throw new SendError("device list kept changing; giving up", true);
  }

  /**
   * ONE sealed multi-recipient request (Sealed Sender v2 over sender keys) authorised by a group send token built from the
   * group's endorsements. Returns undefined when this path is not usable right now (no certificate/unauth connection/endorsements,
   * server rejected the token): the caller then fans out per member with deliver().
   */
  async deliverGroup(req: GroupSendRequest): Promise<GroupSendResult | undefined> {
    const { sealed } = this.deps;
    const rec = this.store.data.chats[req.chatId];
    const end = rec?.endorsements;
    if (!sealed || !this.deps.unauth || !rec || !end || end.expiresAt - Date.now() < 60 * 60_000) return undefined;
    if (req.members.some((m) => !end.members[m.toLowerCase()])) return undefined; // endorsements older than the member list
    const cert = await sealed.cert();
    const unauth = cert ? await this.deps.unauth() : undefined;
    if (!cert || !unauth) return undefined;

    const st = this.store.stores("aci");
    rec.skDistributionId ??= randomUUID();
    rec.skSharedWith ??= {};
    const dist = rec.skDistributionId;
    const hint = contentHint(req.content);
    const excluded = new Set<string>();
    let fallback = 0;
    const prepare = async (member: string): Promise<void> => {
      let devs = this.knownDevices(member);
      if (devs.length === 0) { await this.fetchBundles(member); devs = this.knownDevices(member); }
      if (devs.length === 0) throw new SendError("no devices to send to");
      const shared = rec.skSharedWith![member] ?? [];
      if (devs.some((d) => !shared.includes(d))) {
        const skdm = await SenderKeyDistributionMessage.create(this.local, dist, this.store.senderKeys);
        const r = await this.deliver(member, { senderKeyDistributionMessage: skdm.serialize() }, req.timestamp, "message", { urgent: false, groupId: req.groupId });
        if (r.fallback) fallback++;
        rec.skSharedWith![member] = this.knownDevices(member);
        this.store.touch();
      }
    };
    for (const m of req.members) { try { await prepare(m); } catch { excluded.add(m); } }
    const included = () => req.members.filter((m) => !excluded.has(m));
    if (included().length === 0) return { mode: "sealed", delivered: 0, failed: excluded.size, fallback, retry: [...excluded] };

    const plain = padContent(ContentCodec.encode(req.content));
    const ct = await groupEncrypt(this.local, dist, this.store.senderKeys, plain);
    const usmc = UnidentifiedSenderMessageContent.new(ct, cert, hint, toBytes(req.groupId));
    await this.store.flush();
    for (let attempt = 0; attempt < 4; attempt++) {
      const members = included();
      if (members.length === 0) return { mode: "sealed", delivered: 0, failed: excluded.size, fallback, retry: [...excluded] };
      const recipients = members.flatMap((m) => this.knownDevices(m).map((d) => ProtocolAddress.new(Aci.fromUuid(m), d)));
      const payload = await sealedSenderMultiRecipientEncrypt({ content: usmc, recipients, identityStore: st.identities, sessionStore: st.sessions });
      const token = GroupSendEndorsement.combine(members.map((m) => new GroupSendEndorsement(Buffer.from(end.members[m.toLowerCase()]!, "base64"))))
        .toFullToken(req.secret, new Date(end.expiresAt));
      try {
        const res = await unauth.sendMultiRecipientMessage({ payload, timestamp: req.timestamp, auth: token, onlineOnly: false, urgent: true });
        const unregistered = res.unregisteredIds.length;
        return { mode: "sealed", delivered: Math.max(0, members.length - unregistered), failed: excluded.size + Math.min(unregistered, members.length), fallback, retry: [...excluded] };
      } catch (e) {
        if (LibSignalErrorBase.is(e, ErrorCode.MismatchedDevices)) {
          for (const entry of e.entries) {
            const aci = entry.account.getRawUuid().toLowerCase();
            const m = members.find((x) => x.toLowerCase() === aci);
            if (!m) continue;
            for (const d of [...entry.extraDevices, ...entry.staleDevices]) this.dropSession(m, d);
            for (const d of [...entry.missingDevices, ...entry.staleDevices]) { try { await this.fetchBundles(m, d); } catch { excluded.add(m); } }
            rec.skSharedWith![m] = (rec.skSharedWith![m] ?? []).filter((d) => !entry.extraDevices.includes(d) && !entry.staleDevices.includes(d));
            if (!excluded.has(m)) { try { await prepare(m); } catch { excluded.add(m); } }
          }
          await this.store.flush();
          continue;
        }
        if (LibSignalErrorBase.is(e, ErrorCode.RateLimitedError)) throw new SendError(`rate limited, retry in ${e.retryAfterSecs}s`, true);
        if (LibSignalErrorBase.is(e, ErrorCode.RequestUnauthorized)) delete rec.endorsements; // token refused: refetch group state next time
        else this.deps.unauthBroken?.();
        return undefined;
      }
    }
    return undefined;
  }
}

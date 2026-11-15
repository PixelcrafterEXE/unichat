// Interactive verification for Matrix (emoji / SAS) on top of the SDK's rust crypto, speaking the generic `verification` contract of
// @unimsg/core (VerificationState events + verificationStart / Action / Status / Setup / Recover). The connector (index.ts) only wires it.
//
//   request (mine or theirs) -> Requested -> accept -> Ready -> we start m.sas.v1 -> Started -> ShowSas (7 emojis) -> confirm / mismatch -> Done
//
// Secrets: the account password (cross-signing setup) and the recovery key are used once, kept in memory only while the call runs, never logged.
import { MatrixError, type MatrixClient } from "matrix-js-sdk";
import { VerificationPhase, VerificationRequestEvent, VerifierEvent, type VerificationRequest, type Verifier, type ShowSasCallbacks } from "matrix-js-sdk/lib/crypto-api/verification.js";
import type { CoreEvent, VerificationAction, VerificationState, VerificationStatus } from "@unimsg/core";
import { randomBytes } from "node:crypto";

export interface VerifHost {
  accountId: string;
  client(): MatrixClient | undefined;
  me(): string;
  emit(e: CoreEvent): void;
  err(code: string, e: unknown): void;
  /** Make `key` the secret-storage key the SDK gets asked for while `fn` runs. */
  withSecretKey<T>(key: Uint8Array, fn: () => Promise<T>): Promise<T>;
  /** Recovery key (or passphrase) typed by the user -> the secret storage key. Throws when it is neither. */
  keyFromInput(input: string): Promise<Uint8Array>;
  /** A request nobody answers is cancelled after this long (default 10 minutes). */
  timeoutMs?: number;
}

interface Entry {
  id: string; req: VerificationRequest; incoming: boolean; other: VerificationState["other"];
  sas?: ShowSasCallbacks; confirmed: boolean; hooked: boolean; starting: boolean; ended: boolean; reason?: string;
  last?: string; timer?: ReturnType<typeof setTimeout>;
}

const REASONS: Record<string, string> = {
  "m.timeout": "The request timed out: nobody answered in time.",
  "m.mismatched_sas": "The emojis did not match, so the verification was stopped. If you compared them carefully, someone may be interfering: do not trust that device.",
  "m.key_mismatch": "The security check failed, so the verification was stopped.",
  "m.mismatched_commitment": "The security check failed, so the verification was stopped.",
  "m.user_mismatch": "The security check failed, so the verification was stopped.",
  "m.unexpected_message": "The other side sent something unexpected. Please try again.",
  "m.invalid_message": "The other side sent something unexpected. Please try again.",
  "m.unknown_transaction": "The other side lost track of this request. Please try again.",
  "m.unknown_method": "The other side cannot compare emojis, so this verification is not possible.",
  "m.accepted": "Another of your devices already answered this request.",
};

export class Verifications {
  private entries = new Map<string, Entry>();
  private h: VerifHost;
  constructor(h: VerifHost) { this.h = h; }

  // ------------------------------------------------------------------ requests
  /** A request arrived (from the SDK event) or was created by us. */
  track(req: VerificationRequest, incoming: boolean): string {
    for (const e of this.entries.values()) if (e.req === req) return e.id;
    const me = this.h.me();
    const self = req.isSelfVerification ?? req.otherUserId === me;
    const other: Entry["other"] = self
      ? { kind: "device", name: req.otherDeviceId ? `device ${req.otherDeviceId}` : "your other device", userId: req.otherUserId, deviceId: req.otherDeviceId }
      : { kind: "user", name: this.h.client()?.getUser(req.otherUserId)?.displayName || req.otherUserId, userId: req.otherUserId };
    const e: Entry = { id: randomBytes(6).toString("hex"), req, incoming, other, confirmed: false, hooked: false, starting: false, ended: false };
    this.entries.set(e.id, e);
    e.timer = setTimeout(() => this.timeout(e), this.h.timeoutMs ?? 600_000); e.timer.unref?.();
    req.on(VerificationRequestEvent.Change, () => this.step(e));
    void this.lookupName(e);
    this.step(e);
    return e.id;
  }

  changed() { this.h.emit({ type: "verification-changed", data: {} }); }

  /** `crypto.verificationRequestReceived`: ignore what is not waiting for an answer or came from ourselves. */
  received(req: VerificationRequest) {
    if (req.initiatedByMe || req.phase !== VerificationPhase.Requested) return;
    this.track(req, true);
  }

  private async lookupName(e: Entry) {
    try {
      if (e.other.kind === "device") {
        const crypto = this.h.client()?.getCrypto(); const dev = e.req.otherDeviceId ?? e.other.deviceId;
        const d = dev ? (await crypto?.getUserDeviceInfo([this.h.me()]))?.get(this.h.me())?.get(dev) : undefined;
        const name = d?.displayName || (dev ? `device ${dev}` : undefined);
        if (name && name !== e.other.name) { e.other = { ...e.other, name, deviceId: dev }; this.emitState(e, true); }
      } else {
        const name = this.h.client()?.getUser(e.other.userId ?? "")?.displayName;
        if (name && name !== e.other.name) { e.other = { ...e.other, name }; this.emitState(e, true); }
      }
    } catch { /* the id stays as the name */ }
  }

  private phaseOf(e: Entry): VerificationState["phase"] {
    if (e.ended) return e.reason === undefined ? "done" : "cancelled";
    const p = e.req.phase;
    if (p === VerificationPhase.Done) return "done";
    if (p === VerificationPhase.Cancelled) return "cancelled";
    if (e.sas) return e.confirmed ? "confirming" : "sas";
    if (p === VerificationPhase.Requested || p === VerificationPhase.Unsent) return e.incoming ? "incoming" : "waiting";
    return "waiting";
  }
  private emitState(e: Entry, force = false) {
    const phase = this.phaseOf(e);
    const emoji = e.sas?.sas.emoji;
    const state: VerificationState = { accountId: this.h.accountId, id: e.id, phase, incoming: e.incoming, other: e.other, ...(emoji && (phase === "sas" || phase === "confirming") ? { emoji: emoji.map(([a, b]) => [a, b] as [string, string]) } : {}), ...(phase === "cancelled" ? { reason: e.reason ?? this.reasonOf(e) } : {}) };
    const key = JSON.stringify([phase, e.other.name, state.emoji, state.reason]);
    if (!force && key === e.last) return;
    e.last = key;
    this.h.emit({ type: "verification", data: state });
  }
  private reasonOf(e: Entry): string {
    const code = e.req.cancellationCode ?? "";
    if (code === "m.user" || code === "m.user_cancelled" || !code) {
      const by = e.req.cancellingUserId;
      return by && by !== this.h.me() ? `${e.other.name} cancelled the verification.` : "The verification was cancelled.";
    }
    return REASONS[code] ?? "The verification was cancelled.";
  }

  /** Finish an entry exactly once. `reason` undefined = success. */
  private end(e: Entry, reason?: string) {
    if (e.ended) return;
    e.ended = true; e.reason = reason; clearTimeout(e.timer);
    this.emitState(e, true);
    if (reason === undefined) this.changed();
    setTimeout(() => this.entries.delete(e.id), 30_000).unref?.();
  }
  private timeout(e: Entry) {
    if (e.ended) return;
    try { void Promise.resolve(e.req.cancel({ reason: "Timed out", code: "m.timeout" } as never)).catch(() => {}); } catch { /* already over */ }
    this.end(e, REASONS["m.timeout"]);
  }

  private step(e: Entry) {
    if (e.ended) return;
    const req = e.req;
    if (req.phase === VerificationPhase.Ready && !e.hooked && !e.starting) {
      e.starting = true;
      void req.startVerification("m.sas.v1").then((v) => this.hook(e, v), (err) => { this.h.err("verify", err); this.end(e, "Could not start the emoji comparison. Please try again."); });
    } else if (req.phase === VerificationPhase.Started && req.verifier) this.hook(e, req.verifier);
    else if (req.phase === VerificationPhase.Cancelled) return this.end(e, this.reasonOf(e));
    else if (req.phase === VerificationPhase.Done) return this.end(e);
    this.emitState(e);
  }

  private hook(e: Entry, v: Verifier) {
    if (e.hooked) return; e.hooked = true;
    const show = (cb: ShowSasCallbacks) => { e.sas = cb; this.emitState(e); };
    v.on(VerifierEvent.ShowSas, show as never);
    const now = v.getShowSasCallbacks(); if (now) show(now);
    v.verify().then(() => this.end(e), (err) => {
      if (e.ended) return;
      this.h.err("verify", err);
      this.end(e, this.reasonOf(e));
    });
  }

  // ------------------------------------------------------------------ calls from the UI
  async start(target?: { userId?: string; chatId?: string }): Promise<{ id: string }> {
    const client = this.h.client(); const crypto = client?.getCrypto(); if (!client || !crypto) throw new Error("Not connected yet - try again in a moment.");
    if (!(await crypto.isCrossSigningReady().catch(() => false))) throw new Error("This account has no cross-signing set up yet. Use \"Set up verification\" first.");
    const userId = target?.userId ?? (target?.chatId ? this.peerOf(client, target.chatId) : undefined);
    if (target?.chatId && !userId) throw new Error("Verification works with one person at a time: open a direct chat with them first.");
    if (!userId || userId === this.h.me()) return { id: this.track(await crypto.requestOwnUserVerification(), false) };
    const roomId = target?.chatId ?? this.dmWith(client, userId);
    if (!roomId) throw new Error("Open a direct chat with this person first: verification requests are sent there.");
    return { id: this.track(await crypto.requestVerificationDM(userId, roomId), false) };
  }
  /** The other person of a 1:1 room. */
  private peerOf(client: MatrixClient, chatId: string): string | undefined {
    const others = (client.getRoom(chatId)?.getJoinedMembers() ?? []).map((m) => m.userId).filter((u) => u !== this.h.me());
    return others.length === 1 ? others[0] : undefined;
  }
  private dmWith(client: MatrixClient, userId: string): string | undefined {
    const direct = client.getAccountData("m.direct" as never)?.getContent() as Record<string, string[]> | undefined;
    return direct?.[userId]?.find((r) => !!client.getRoom(r));
  }

  async action(id: string, action: VerificationAction): Promise<void> {
    const e = this.entries.get(id);
    if (!e) { if (action === "cancel" || action === "decline") return; throw new Error("This verification is no longer active."); }
    if (e.ended) return;
    switch (action) {
      case "accept":
        if (!e.incoming || e.req.phase !== VerificationPhase.Requested) throw new Error("There is nothing to accept.");
        await e.req.accept(); this.step(e); return;
      case "decline": case "cancel":
        try { await e.req.cancel(); } catch (err) { this.h.err("verify", err); }
        this.end(e, action === "decline" ? "You declined the request." : "You cancelled the verification."); return;
      case "confirm":
        if (!e.sas) throw new Error("The emojis are not ready yet.");
        e.confirmed = true; this.emitState(e);
        try { await e.sas.confirm(); } catch (err) { e.confirmed = false; this.h.err("verify", err); this.emitState(e); throw new Error("Could not confirm. Please try again or cancel."); }
        return;
      case "mismatch":
        if (!e.sas) throw new Error("The emojis are not ready yet.");
        e.sas.mismatch(); this.end(e, REASONS["m.mismatched_sas"]); return;
      default: throw new Error("unknown verification action");
    }
  }

  dispose() { for (const e of this.entries.values()) { clearTimeout(e.timer); } this.entries.clear(); }

  // ------------------------------------------------------------------ status, setup, recovery
  async status(target?: { userId?: string; chatId?: string }): Promise<VerificationStatus> {
    const client = this.h.client(); const crypto = client?.getCrypto();
    if (!client || !crypto) return { state: "unknown", crossSigning: "unknown", backup: "unknown" };
    const ready = await crypto.isCrossSigningReady().then((b): "ready" | "missing" | "unknown" => (b ? "ready" : "missing"), (): "ready" | "missing" | "unknown" => "unknown");
    const info = await crypto.getKeyBackupInfo().then((i): "enabled" | "none" | "unknown" => (i?.version ? "enabled" : "none"), (): "enabled" | "none" | "unknown" => "unknown");
    let state: VerificationStatus["state"] = "unknown";
    const userId = target?.userId ?? (target?.chatId ? this.peerOf(client, target.chatId) : undefined);
    try {
      if (target?.chatId && !userId) { /* a group: nobody to ask about */ } else if (!userId || userId === this.h.me()) {
        const dev = client.getDeviceId();
        const st = dev ? await crypto.getDeviceVerificationStatus(this.h.me(), dev) : null;
        state = st ? (st.crossSigningVerified ? "verified" : "unverified") : "unknown";
      } else {
        const st = await crypto.getUserVerificationStatus(userId);
        state = st.isVerified() ? "verified" : st.known ? "unverified" : "unknown";
      }
    } catch { /* unknown */ }
    return { state, crossSigning: ready, backup: info, ...(userId ? { userId } : {}) };
  }

  async setup(opts: { password?: string }): Promise<{ recoveryKey?: string }> {
    const client = this.h.client(); const crypto = client?.getCrypto(); if (!client || !crypto) throw new Error("Not connected yet - try again in a moment.");
    const me = this.h.me(); const password = opts.password;
    const crossReady = await crypto.isCrossSigningReady().catch(() => false);
    const st = await crypto.getSecretStorageStatus().catch(() => undefined);
    if (st?.defaultKeyId) {
      if (crossReady && st.ready) throw new Error("Verification is already set up for this account.");
      throw new Error("This account already has a recovery key. Verify with that key or with another device instead.");
    }
    const hasBackup = !!(await crypto.getKeyBackupInfo().catch(() => null))?.version;
    // Cross-signing keys are uploaded with user-interactive auth: the server wants the account password (or another step we cannot do here).
    const upload = async (makeRequest: (auth: never) => Promise<void>) => {
      try { await makeRequest(null as never); return; } catch (e) {
        if (!(e instanceof MatrixError) || e.httpStatus !== 401) throw e;
        const data = e.data as { flows?: { stages: string[] }[]; session?: string } | undefined; const flows = data?.flows ?? [];
        if (flows.some((f) => f.stages.length === 1 && f.stages[0] === "m.login.password")) {
          if (!password) throw new Error("Enter your account password to continue.");
          try { await makeRequest({ type: "m.login.password", identifier: { type: "m.id.user", user: me }, password, session: data?.session } as never); return; }
          catch (e2) { if (e2 instanceof MatrixError && (e2.httpStatus === 401 || e2.httpStatus === 403)) throw new Error("That password was not accepted."); throw e2; }
        }
        const kinds = [...new Set(flows.flatMap((f) => f.stages))].join(", ") || "unknown";
        throw new Error(`This server asks for a sign-in step UniChat cannot do here (${kinds}). Set up verification in Element or another Matrix app instead, then come back and verify this device.`);
      }
    };
    const key = await crypto.createRecoveryKeyFromPassphrase();
    try {
      // the new secret-storage key must be available while the cross-signing secrets are stored in it
      await this.h.withSecretKey(key.privateKey, async () => {
        if (!crossReady) await crypto.bootstrapCrossSigning({ setupNewCrossSigning: true, authUploadDeviceSigningKeys: upload as never });
        await crypto.bootstrapSecretStorage({ createSecretStorageKey: async () => key, setupNewSecretStorage: true, setupNewKeyBackup: !hasBackup });
      });
    } catch (e) {
      if (e instanceof Error && /password|sign-in step|already/.test(e.message)) throw e;
      this.h.err("verify-setup", e);
      throw new Error("Setting up verification failed. Nothing was changed that you need to undo; please try again.");
    }
    this.changed();
    return key.encodedPrivateKey ? { recoveryKey: key.encodedPrivateKey } : {};
  }

  /** "Verify with recovery key": unlock secret storage, import the cross-signing keys (this device becomes verified) and load the message key backup. */
  async recover(input: string): Promise<void> {
    const client = this.h.client(); const crypto = client?.getCrypto(); if (!client || !crypto) throw new Error("Not connected yet - try again in a moment.");
    if (!input.trim()) throw new Error("Enter your recovery key or passphrase.");
    const status = await crypto.getSecretStorageStatus().catch(() => undefined);
    if (!status?.defaultKeyId || status.secretStorageKeyValidityMap["m.cross_signing.master"] === false) throw new Error("This account has no recovery key set up yet. Use \"Set up verification\" instead.");
    let key: Uint8Array;
    try { key = await this.h.keyFromInput(input); } catch { throw new Error("That is not a valid recovery key or passphrase."); }
    try {
      await this.h.withSecretKey(key, async () => {
        await crypto.bootstrapCrossSigning({}); // imports the cross-signing keys from secret storage and signs this device; never creates new ones (they exist)
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage().then(() => crypto.restoreKeyBackup()).catch(() => {}); // backup is a bonus
      });
    } catch (e) {
      this.h.err("verify-recover", e);
      throw new Error("That recovery key or passphrase does not match this account.");
    }
    this.changed();
  }
}

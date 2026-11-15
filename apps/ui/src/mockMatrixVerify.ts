// Mock backend for Matrix verification (emoji comparison, set-up, recovery key): the same RPC surface and `verification` events as the Hub.
// Test hooks (all on window):
//   __mockMatrixVerify({ phase, incoming?, other?, emoji?, reason?, accountId?, id? })  emit a verification state (drives the dialog)
//   __mockMatrixAuto = true      a started request advances by itself: accepted -> emojis -> (after "They match") done
//   __mockVerifyLog              every call [{ method, params }] (passwords and keys are replaced by "<secret>")
//   __mockVerifyStatus           { device, crossSigning, backup } of the account;  __mockVerifyPeople  { "@anna:matrix.org": "verified" | "unverified" | "unknown" }
type Emit = (ev: string, d: unknown) => void;
const g = globalThis as any;
const EMOJI: [string, string][] = [["🐶", "Dog"], ["🔑", "Key"], ["🚀", "Rocket"], ["🍄", "Mushroom"], ["🎸", "Guitar"], ["📌", "Pin"], ["🔒", "Lock"]];
const METHODS = new Set(["pendingVerifications", "verificationStart", "verificationAction", "verificationStatus", "verificationSetup", "verificationRecover"]);
export const mockMatrixVerifyHandles = (m: string) => METHODS.has(m);

const log: { method: string; params: any }[] = []; g.__mockVerifyLog = log;
g.__mockMatrixAuto = false;
g.__mockVerifyStatus = { device: "unverified", crossSigning: "ready", backup: "enabled" };
g.__mockVerifyPeople = { "@anna:matrix.org": "unverified", "@bea:matrix.org": "verified" } as Record<string, string>;
const active = new Map<string, any>();
let seq = 0, emitFn: Emit = () => {};
const send = (s: any) => { if (s.phase === "done" || s.phase === "cancelled") active.delete(s.id); else active.set(s.id, s); emitFn("verification", s); return s; };
const later = (f: () => void, ms: number) => void setTimeout(f, ms);

/** called once by the mock transport */
export function installMatrixVerifyHooks(emit: Emit) {
  emitFn = emit;
  g.__mockMatrixVerify = (o: any) => send({ accountId: "mx-1", id: "mv1", phase: "sas", incoming: false, other: { kind: "device", name: "Element on Pixel 8" },
    ...(o.phase === "sas" || o.phase === "confirming" ? { emoji: EMOJI } : {}), ...o });
}
const secret = (p: any) => ({ ...p, ...(p?.password !== undefined ? { password: "<secret>" } : {}), ...(p?.recoveryKey !== undefined ? { recoveryKey: "<secret>" } : {}) });
const needMatrix = (accounts: { id: string; provider: string }[], id: string) => { if (accounts.find((a) => a.id === id)?.provider !== "matrix") throw new Error("This messenger has no verification in UniChat"); };

export async function mockMatrixVerifyCall(method: string, p: any, accounts: { id: string; provider: string }[]): Promise<any> {
  log.push({ method, params: secret(p) });
  if (method === "pendingVerifications") return [...active.values()];
  needMatrix(accounts, p.accountId);
  const st = g.__mockVerifyStatus;
  switch (method) {
    case "verificationStart": {
      if (st.crossSigning !== "ready") throw new Error("This account has no cross-signing set up yet. Use \"Set up verification\" first.");
      const user = p.userId ?? (p.chatId ? String(p.chatId).split(":").slice(1).join(":") : undefined);
      const id = "mv" + ++seq;
      const other = user ? { kind: "user", name: user.replace(/^@|:.*$/g, "").replace(/^./, (c: string) => c.toUpperCase()), userId: user } : { kind: "device", name: "your other device" };
      send({ accountId: p.accountId, id, phase: "waiting", incoming: false, other });
      if (g.__mockMatrixAuto) later(() => active.has(id) && send({ accountId: p.accountId, id, phase: "sas", incoming: false, other, emoji: EMOJI }), 500);
      return { id };
    }
    case "verificationAction": {
      const s = active.get(p.id); const a = p.action;
      if (!s) { if (a === "cancel" || a === "decline") return; throw new Error("This verification is no longer active."); }
      const done = () => { if (s.other.kind === "device") g.__mockVerifyStatus = { ...g.__mockVerifyStatus, device: "verified" }; else g.__mockVerifyPeople[s.other.userId ?? ""] = "verified"; send({ ...s, phase: "done", emoji: undefined }); emitFn("verification-changed", { accountId: p.accountId }); };
      if (a === "accept") { send({ ...s, phase: "waiting" }); if (g.__mockMatrixAuto) later(() => active.has(s.id) && send({ ...s, phase: "sas", emoji: EMOJI }), 400); }
      else if (a === "confirm") { send({ ...s, phase: "confirming" }); if (g.__mockMatrixAuto) later(() => active.has(s.id) && done(), 400); }
      else if (a === "mismatch") send({ ...s, phase: "cancelled", emoji: undefined, reason: "The emojis did not match, so the verification was stopped. If you compared them carefully, someone may be interfering: do not trust that device." });
      else if (a === "decline") send({ ...s, phase: "cancelled", reason: "You declined the request." });
      else if (a === "cancel") send({ ...s, phase: "cancelled", emoji: undefined, reason: "You cancelled the verification." });
      return;
    }
    case "verificationStatus": {
      const user = p.userId ?? (p.chatId ? String(p.chatId).split(":").slice(1).join(":") : undefined);
      const base = { crossSigning: st.crossSigning, backup: st.backup };
      return user ? { ...base, state: g.__mockVerifyPeople[user] ?? "unknown", userId: user } : { ...base, state: st.device };
    }
    case "verificationSetup": {
      await new Promise((r) => setTimeout(r, 250));
      if (st.crossSigning === "ready") throw new Error("Verification is already set up for this account.");
      if (p.password === "sso") throw new Error("This server asks for a sign-in step UniChat cannot do here (m.login.sso). Set up verification in Element or another Matrix app instead, then come back and verify this device.");
      if (!p.password) throw new Error("Enter your account password to continue.");
      if (p.password === "wrong") throw new Error("That password was not accepted.");
      g.__mockVerifyStatus = { device: "verified", crossSigning: "ready", backup: "enabled" };
      emitFn("verification-changed", { accountId: p.accountId });
      return { recoveryKey: "EsTc 4mXk 9QpL 7uVd 2sYh 8nRa 5bWc 3eZf 6gJt 1hKm" };
    }
    case "verificationRecover": {
      await new Promise((r) => setTimeout(r, 250));
      if (!String(p.recoveryKey).trim()) throw new Error("Enter your recovery key or passphrase.");
      if (p.recoveryKey === "wrong") throw new Error("That recovery key or passphrase does not match this account.");
      g.__mockVerifyStatus = { ...st, device: "verified" }; emitFn("verification-changed", { accountId: p.accountId });
      return;
    }
  }
}

// "Nearby" pairing: connect to a device that shows "Add a device" WITHOUT typing or scanning its code.
//
// The Noise handshake of mode "nearby" uses a PUBLIC psk (every UniChat knows it), so it only gives an encrypted but UNAUTHENTICATED channel: whoever answers on the
// network can complete it, including a man in the middle. The only thing that authenticates the two devices is the 6-digit number BOTH people compare and confirm
// (Bluetooth "numeric comparison"). For that to be worth anything the number must not be something an attacker can grind for:
//
//   1. Noise finishes; both sides now hold the transcript T (it binds both static keys and all ephemeral keys; the two legs of a man in the middle differ).
//   2. host   -> joiner : commit = SHA-256("unichat-nearby-commit-v1" | T | Nh)     (Nh: 16 fresh random bytes, committed BEFORE the joiner shows anything)
//      joiner -> host   : Nj (16 fresh random bytes)                                (sent after the commitment, so the host cannot pick Nh to suit Nj)
//      host   -> joiner : Nh                                                         (the joiner checks it against the commitment, aborts otherwise)
//   3. T' = HMAC(T, "unichat-nearby-sas-v1" | Nh | Nj); the digits are sasOf(T') like in the code-based path.
//
// A man in the middle has two legs. On the host leg it must send its joiner nonce before it learns Nh; on the joiner leg it must commit to its own host nonce before
// it learns Nj. Both digit strings are therefore uniform random from its point of view when it has to decide, and they agree with probability 10^-6 per attempt
// (20 bits), which is exactly the strength of numeric comparison. Without the commitment the attacker could grind its own static key AFTER seeing the other leg's
// transcript until the two numbers collide (about a million cheap X25519 keys): that is why the commit/reveal exists. Every failed or abandoned attempt is rate limited
// by the service (per source address, per pairing session). The code-based paths are unchanged and stay stronger (the code adds ~50 bits before anyone is asked).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ChannelError, type Secure } from "./channel.js";

/** The psk of mode "nearby". It is public on purpose: see above. */
export const NEARBY_PSK: Buffer = createHash("sha256").update("unichat-nearby-pairing-v1 (public, not a secret)").digest();
const commitOf = (t: Buffer, n: Buffer) => createHash("sha256").update("unichat-nearby-commit-v1").update(t).update(n).digest();
const NONCE = 16;
const nonceOf = (m: any, type: string): Buffer => {
  const b = m?.t === type && typeof m?.n === "string" ? Buffer.from(m.n, "base64") : Buffer.alloc(0);
  if (b.length !== NONCE) throw new ChannelError("protocol", "bad nearby message");
  return b;
};
const sasTranscript = (t: Buffer, nh: Buffer, nj: Buffer) => createHmac("sha256", t).update("unichat-nearby-sas-v1").update(nh).update(nj).digest();

/** Host (the device that showed "Add a device" and accepted the connection). On success `ch.transcript` is the value to derive the digits from. */
export async function nearbyHost(ch: Secure, timeoutMs = 8000): Promise<void> {
  const t = ch.transcript, nh = randomBytes(NONCE);
  await ch.send({ t: "nb-commit", c: commitOf(t, nh).toString("base64") });
  const nj = nonceOf(await ch.recv(timeoutMs), "nb-nonce");
  await ch.send({ t: "nb-reveal", n: nh.toString("base64") });
  ch.transcript = sasTranscript(t, nh, nj);
}
/** Joiner (the device that dialed). */
export async function nearbyJoin(ch: Secure, timeoutMs = 8000): Promise<void> {
  const t = ch.transcript, nj = randomBytes(NONCE);
  const m = await ch.recv(timeoutMs);
  if (m?.t !== "nb-commit" || typeof m.c !== "string") throw new ChannelError("protocol", "bad nearby message");
  const commit = Buffer.from(m.c, "base64");
  await ch.send({ t: "nb-nonce", n: nj.toString("base64") });
  const nh = nonceOf(await ch.recv(timeoutMs), "nb-reveal");
  const want = commitOf(t, nh);
  if (commit.length !== want.length || !timingSafeEqual(commit, want)) { ch.close(); throw new ChannelError("protocol", "The other device did not follow the nearby protocol."); }
  ch.transcript = sasTranscript(t, nh, nj);
}

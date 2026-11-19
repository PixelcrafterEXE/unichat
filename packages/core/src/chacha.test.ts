// ChaCha20-Poly1305 has two implementations (node:crypto, and libsodium where node:crypto has none -- Electron). They
// must produce the same bytes, or a desktop and a phone could not talk. Both are held to RFC 8439's own test vector.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCiphers, randomBytes } from "node:crypto";
import { AeadAuthError, chachaImpl, chachaOpen, chachaSeal } from "./chacha.js";

const hex = (s: string) => Buffer.from(s.replace(/\s+/g, ""), "hex");
// RFC 8439 section 2.8.2
const KEY = hex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
const NONCE = hex("070000004041424344454647");
const AAD = hex("50515253c0c1c2c3c4c5c6c7");
const PT = Buffer.from("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
const CT = hex(`d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116`);
const TAG = hex("1ae10b594f09e26a7e902ecbd0600691");

// Inside Electron node:crypto has no such cipher (that is the point of chacha.ts): there only libsodium is held to the RFC.
const nodeHasIt = getCiphers().includes("chacha20-poly1305");
const both = (f: (impl: string) => void) => { const was = chachaImpl.useSodium; try { for (const s of nodeHasIt ? [false, true] : [true]) { chachaImpl.useSodium = s; f(s ? "libsodium" : "node:crypto"); } } finally { chachaImpl.useSodium = was; } };

test("both implementations reproduce RFC 8439's test vector, and open it again", () => both((impl) => {
  assert.deepEqual(chachaSeal(KEY, NONCE, PT, AAD), Buffer.concat([CT, TAG]), impl + " seals to the RFC's bytes");
  assert.deepEqual(chachaOpen(KEY, NONCE, Buffer.concat([CT, TAG]), AAD), PT, impl + " opens the RFC's bytes");
}));

test("what one implementation seals, the other opens (a desktop and a phone talking)", { skip: nodeHasIt ? false : "this runtime has only one of the two (Electron): the RFC vector above holds it to the same bytes" }, () => {
  const was = chachaImpl.useSodium;
  try {
    for (let i = 0; i < 50; i++) {
      const k = randomBytes(32), n = randomBytes(12), pt = randomBytes(i * 37), ad = i % 3 ? randomBytes(i) : undefined;
      chachaImpl.useSodium = false; const a = chachaSeal(k, n, pt, ad);
      chachaImpl.useSodium = true; const b = chachaSeal(k, n, pt, ad);
      assert.deepEqual(a, b, "identical ciphertext and tag");
      assert.deepEqual(chachaOpen(k, n, a, ad), pt);
      chachaImpl.useSodium = false; assert.deepEqual(chachaOpen(k, n, b, ad), pt);
    }
  } finally { chachaImpl.useSodium = was; }
});

test("a wrong key, flipped bit, wrong AAD or short box is an authentication failure on both, never a crash", () => both((impl) => {
  const box = chachaSeal(KEY, NONCE, PT, AAD);
  const flipped = Buffer.from(box); flipped[5] ^= 1;
  for (const [what, f] of [
    ["wrong key", () => chachaOpen(randomBytes(32), NONCE, box, AAD)],
    ["flipped bit", () => chachaOpen(KEY, NONCE, flipped, AAD)],
    ["wrong AAD", () => chachaOpen(KEY, NONCE, box, Buffer.from("x"))],
    ["short box", () => chachaOpen(KEY, NONCE, box.subarray(0, 10), AAD)],
  ] as const) assert.throws(f, AeadAuthError, `${impl}: ${what}`);
}));

// Vectors generated once with libsodium (crypto_box_easy / crypto_secretbox_easy / crypto_scalarmult_base). Pure offline.
import test from "node:test";
import assert from "node:assert/strict";
import { box, boxOpen, generateKeyPair, publicKeyOf, secretbox, secretboxOpen } from "./nacl.js";

const V = {"skA": "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "pkA": "07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c", "skB": "65666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f8081828384", "pkB": "5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36", "nonce": "c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf", "msg": "48656c6c6f2054687265656d6120c3a4f09f918d20706164646564206d736748656c6c6f2054687265656d6120c3a4f09f918d20706164646564206d736748656c6c6f2054687265656d6120c3a4f09f918d20706164646564206d7367", "box": "f4ff43e25e073a08e60ea8c3aa1c908f8edf5e3981994fba41dc474e822ebeb7826336278742b7990ac0dfeda012d4784daea393c4639ca3fbd5fd52b9bab8a5d864804421b0c173dcf0156bc226ad5ed5776aed0c1800466f8551e9711be9ac69a49428235b3882f2f0f56737", "key": "32333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f5051", "sbox": "12ebabe945ee240e0649ba399207c47af57f48aa71124e13e6a5f610e624c22c997517512594da7215b56760cf4b60fefdd2aa7e5c7703d82cdb3071aa688e4ec6c3240a2558c725e086cecd0bed027b66fd310fd29d6b035e619a7836cbcdb33b44d35a9f3f9e423b82eae512", "sboxEmpty": "709e0bb8485aba0525b977bc27c8e928"};
const H = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("X25519 public key derivation matches libsodium", () => {
  assert.equal(hex(publicKeyOf(H(V.skA))), V.pkA);
  assert.equal(hex(publicKeyOf(H(V.skB))), V.pkB);
});
test("crypto_box matches libsodium both ways and rejects tampering", () => {
  const c = box(H(V.msg), H(V.nonce), H(V.pkB), H(V.skA));
  assert.equal(hex(c), V.box);
  assert.equal(hex(boxOpen(c, H(V.nonce), H(V.pkA), H(V.skB))!), V.msg);
  const bad = Uint8Array.from(c); bad[20] ^= 1;
  assert.equal(boxOpen(bad, H(V.nonce), H(V.pkA), H(V.skB)), undefined);
  assert.equal(boxOpen(c, H(V.nonce), H(V.pkA), H(V.skA)), undefined);
});
test("crypto_secretbox matches libsodium (incl. empty message and multi-block)", () => {
  assert.equal(hex(secretbox(H(V.msg), H(V.nonce), H(V.key))), V.sbox);
  assert.equal(hex(secretbox(new Uint8Array(0), H(V.nonce), H(V.key))), V.sboxEmpty);
  assert.equal(hex(secretboxOpen(H(V.sbox), H(V.nonce), H(V.key))!), V.msg);
});
test("random key pairs round-trip", () => {
  const a = generateKeyPair(), b = generateKeyPair(), n = new Uint8Array(24).fill(7);
  const m = new Uint8Array(1000).map((_, i) => i * 7);
  assert.deepEqual(boxOpen(box(m, n, b.publicKey, a.secretKey), n, a.publicKey, b.secretKey), m);
});

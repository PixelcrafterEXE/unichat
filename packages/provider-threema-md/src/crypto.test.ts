// Vectors for every KDF step. The BLAKE2b ones come from Python hashlib (an independent implementation; "abc"/512 is also RFC 7693 Appendix A).
// The composed Threema KDF vectors (DGK tree, rendezvous STK/RPH/transport keys, CSP vouch, MMK, directory response) are SELF-DERIVED: there are no
// official test vectors for them in the public docs. They were computed once with an independent Python script (hashlib blake2b + cryptography X25519 + a
// 20-line HSalsa20), following the formulas of PROTOCOL-NOTES.md, so they pin the implementation but cannot prove interoperability with Threema.
import test from "node:test";
import assert from "node:assert/strict";
import { chachaOpen, chachaSeal } from "./aead.js";
import { blake2b } from "./blake2b.js";
import { cspVouch, deriveAuthKeys, deriveDeviceGroupKeys, deriveTransportKeys, directoryResponse, metadataKey } from "./keys.js";
import { publicKeyOf } from "./nacl.js";

const V = {
 "dgk": "01080f161d242b323940474e555c636a71787f868d949ba2a9b0b7bec5ccd3da",
 "dgrk": "6e562c583cd903dd5b49d785dc7ce37875ec4064049fb4b27e17ef35bcce0863",
 "dgdik": "8ee1880b4fa90095723b3be9cfcb8a859a29520d15b6078ba3d64c0cdb89fdff",
 "dgsddk": "b7110c924de480f1ffaa84c0819dde98ef515f929734c634cca13f9a49e06b00",
 "dgtsk": "cf82f496edc32d51708c884af421bc8203861bc1faed97988c338fb3904d9ecc",
 "dgpkSecret": "5d6985e096588c52cd05e376e5a07c979822d2ea4d7d6b935a6ea8581942395f",
 "dgpkPublic": "9d2438ebe911848645c67c9a5edc13d062c04b3601891bfc4e163854e16d3e25",
 "ak": "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc",
 "etkLocalSecret": "050c131a21282f363d444b525960676e757c838a91989fa6adb4bbc2c9d0d7de",
 "etkRemoteSecret": "0910171e252c333a41484f565d646b727980878e959ca3aab1b8bfc6cdd4dbe2",
 "etkRemotePublic": "732edfab923aea4d28f187a1120d6b1cd0b2acb33763e450d7dd7913e122604d",
 "ridak": "897f6b15e64c6c89f187d383b3f4002c7e183db1f8c288ac63e30dcb18f61720",
 "rrdak": "4e5f5a42ba31fbd9e8c1ebdda01ba7fdd0bced7ea4e91324504af1ef3f2069a5",
 "stk": "4b9184497db424291e9efa32a8753c8500d96fd36e2c4276a2418495dd0b85f3",
 "rph": "d37f481dc23a375fad9ecb3ac148f036060194cc865e64c91e23f2d60f3b6446",
 "ridtk": "009c9fee0b695fb6b35f58236df5eaad0b0b93ab5e1e7bba006487aa5cfb34bc",
 "rrdtk": "8281a17ebd343415d2c69d63e0fd02944667e558ee8849ee6e77951f0b1eaee6",
 "ck": "0b121920272e353c434a51585f666d747b828990979ea5acb3bac1c8cfd6dde4",
 "skSecret": "0d141b222930373e454c535a61686f767d848b9299a0a7aeb5bcc3cad1d8dfe6",
 "skPublic": "9f55403a4e8a3fea6bad890add88d6a222e9fcc8009c638091bd81ab20704263",
 "tskSecret": "11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3ea",
 "tskPublic": "e52b940ad182cfed595624daaaa892f68f14d52c49ae9016b6ab870e080e8300",
 "sck": "131a21282f363d444b525960676e757c",
 "tckPublic": "f0c598791fadf1337568bd13316c2391a020a555688c34ba091dd9f2d0bacc23",
 "vouch": "5f53410eb2fd649eb61abc628accc5eddb2ecd58024bcbbeb7819af02c2243ad",
 "peerPublic": "dacd3ef42235ccb603e11ec9fbcfdbd5dbf534741049e58b812c023f5260530a",
 "mmk": "309512b4bcd0db3251c62a28f2ad738004bc7395e18c6d2bd0e1b095bc68248d",
 "token": "1f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dce3eaf1f8ff060d141b222930",
 "dirResp": "5c043561c5a1b7c94afac662e58643a1395a922e5843e529e08d280e70f4171b",
 "b2": {
  "abc512": "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
  "empty256": "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  "keyed": "71aa692528042f4a726359b0d470b74d50012f98a7dacd4e4b03de632cdfcb3c",
  "keyed64": "de0fc47c3e0719d10b5d6f10a59c5b55d3b07f3918333f6e27de7eb0bdbfa169",
  "exact128": "6327926e83d958c9e94f48cc62193827a436af35aa21b16a13a7585422802a8e",
  "long": "a04b545bbe75ea87c1170efe43ec45dadc7f0db124f0d8751134a7cc48ea2c4b"
 }
} as any;
const H = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seq = (a: number, n = 32) => Uint8Array.from({ length: n }, (_, i) => (a + i * 7) & 255);

test("BLAKE2b: RFC 7693 and keyed/salted/personalised vectors", () => {
  assert.equal(hex(blake2b(new TextEncoder().encode("abc"), { outLen: 64 })), V.b2.abc512);
  assert.equal(hex(blake2b(new Uint8Array(0))), V.b2.empty256);
  assert.equal(hex(blake2b(new TextEncoder().encode("hello threema"), { key: Uint8Array.from({ length: 32 }, (_, i) => i) })), V.b2.keyed);
  assert.equal(hex(blake2b(new Uint8Array(300).fill(120), { key: Uint8Array.from({ length: 64 }, (_, i) => i), salt: "st", personal: "3ma-rendezvous" })), V.b2.keyed64);
  assert.equal(hex(blake2b(Uint8Array.from({ length: 128 }, (_, i) => i), { key: "k" })), V.b2.exact128);
  assert.equal(hex(blake2b(Uint8Array.from({ length: 1000 }, (_, i) => i % 251), { key: "secret", salt: "di", personal: "3ma-mdev" })), V.b2.long);
});

test("device group key tree (DGK -> DGPK/DGRK/DGDIK/DGSDDK/DGTSK)", () => {
  const k = deriveDeviceGroupKeys(H(V.dgk));
  assert.equal(hex(k.dgpkSecret), V.dgpkSecret); assert.equal(hex(k.dgpkPublic), V.dgpkPublic);
  for (const n of ["dgrk", "dgdik", "dgsddk", "dgtsk"] as const) assert.equal(hex(k[n]), V[n], n);
});

test("rendezvous key schedule (AK, STK, RPH, RIDTK, RRDTK) is symmetric", () => {
  const a = deriveAuthKeys(H(V.ak)); assert.equal(hex(a.ridak), V.ridak); assert.equal(hex(a.rrdak), V.rrdak);
  const t = deriveTransportKeys(H(V.ak), H(V.etkLocalSecret), H(V.etkRemotePublic));
  assert.equal(hex(t.stk), V.stk); assert.equal(hex(t.rph), V.rph); assert.equal(hex(t.ridtk), V.ridtk); assert.equal(hex(t.rrdtk), V.rrdtk);
  const other = deriveTransportKeys(H(V.ak), H(V.etkRemoteSecret), publicKeyOf(H(V.etkLocalSecret)));
  assert.equal(hex(other.stk), V.stk);
});

test("CSP vouch, message metadata key, directory challenge response", () => {
  assert.equal(hex(cspVouch(H(V.ck), H(V.skPublic), H(V.tskPublic), H(V.sck), H(V.tckPublic))), V.vouch);
  assert.equal(hex(metadataKey(H(V.ck), H(V.peerPublic))), V.mmk);
  assert.equal(hex(directoryResponse(H(V.ck), H(V.tskPublic), H(V.token))), V.dirResp);
  void seq;
});

test("ChaCha20-Poly1305 (RFC 8439 2.8.2 vector) as used by the rendezvous layer", () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i), nonce = H("070000004041424344454647"), aad = H("50515253c0c1c2c3c4c5c6c7");
  const pt = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
  const box = chachaSeal(key, nonce, pt, aad);
  assert.equal(hex(box.subarray(box.length - 16)), "1ae10b594f09e26a7e902ecbd0600691");
  assert.equal(new TextDecoder().decode(chachaOpen(key, nonce, box, aad)!), new TextDecoder().decode(pt));
  const bad = Uint8Array.from(box); bad[3] ^= 1; assert.equal(chachaOpen(key, nonce, bad, aad), undefined);
});

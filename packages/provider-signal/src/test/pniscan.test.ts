import test from "node:test";
import assert from "node:assert/strict";
import { scanContactPni } from "../service/storageSync.js";

// minimal protobuf writer: field n, wire type 2 (bytes) / 0 (varint)
const varint = (x: number) => { const o: number[] = []; while (x > 127) { o.push((x & 127) | 128); x = Math.floor(x / 128); } o.push(x); return Buffer.from(o); };
const ld = (n: number, v: Uint8Array) => Buffer.concat([varint((n << 3) | 2), varint(v.length), v]);
const vi = (n: number, v: number) => Buffer.concat([varint((n << 3) | 0), varint(v)]);
const ACI = "11111111-2222-3333-4444-555555555555", PNI = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const hex = (u: string) => Buffer.from(u.replace(/-/g, ""), "hex");
const record = (...fields: Buffer[]) => ld(1, Buffer.concat(fields)); // StorageRecord.contact

test("the PNI of a contact record is found whatever field it is in (text, PNI: prefix, raw bytes, 0x01-prefixed service id)", () => {
  const base = [ld(1, Buffer.from(ACI)), ld(2, Buffer.from("+4915112345")), ld(3, Buffer.alloc(32, 7)), vi(9, 0)];
  for (const [name, f] of [["text", ld(24, Buffer.from(PNI))], ["prefixed", ld(15, Buffer.from("PNI:" + PNI))], ["binary", ld(27, hex(PNI))], ["service id", ld(30, Buffer.concat([Buffer.from([1]), hex(PNI)]))]] as const)
    assert.equal(scanContactPni(record(...base, f), ACI), PNI, name);
});
test("no PNI when the record only holds the ACI; the ACI itself is never returned; garbage is not a crash", () => {
  assert.equal(scanContactPni(record(ld(1, Buffer.from(ACI)), ld(2, Buffer.from("+49"))), ACI), undefined);
  assert.equal(scanContactPni(record(ld(1, Buffer.from(ACI)), ld(24, hex(ACI))), ACI), undefined);
  assert.equal(scanContactPni(Buffer.from([0xff, 0xff, 0xff]), ACI), undefined);
  assert.equal(scanContactPni(new Uint8Array(0), ACI), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { MediaDownloader, failReason } from "./mediajob.js";

test("failReason: provider reason, timeout, generic", () => {
  assert.equal(failReason(Object.assign(new Error("x"), { reason: "expired" })), "expired");
  assert.equal(failReason(new Error("timed out")), "timeout");
  assert.equal(failReason(new Error("boom")), "error");
});

test("media job result counts failures per reason", async () => {
  const msgs = ["a", "b", "c", "d"].map((id) => ({ id, chatId: "w:chat", attachments: [{ id: "a0", kind: "image", mime: "image/png" }] }));
  const store: any = { scanMessages: ({ after }: any) => (after ? [] : msgs) };
  const cache: any = { has: () => false, put: () => {} };
  const errs: Record<string, Error> = { a: Object.assign(new Error("gone"), { reason: "expired" }), b: Object.assign(new Error("gone"), { reason: "expired" }), c: Object.assign(new Error("full"), { reason: "disk-full" }) };
  const conn: any = { downloadAttachment: async (_c: string, id: string) => { if (errs[id]) throw errs[id]; return { data: new Uint8Array(3), mime: "image/png" }; } };
  const events: any[] = [];
  const d = new MediaDownloader(store, cache, () => conn, (e, x) => events.push([e, x]), { gapMs: 0 });
  const { finished } = await d.start("w");
  const fin = await finished;
  assert.equal(fin.failed, 3);
  assert.deepEqual(fin.reasons, { expired: 2, "disk-full": 1 });
});

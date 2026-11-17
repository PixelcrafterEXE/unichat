// GIF sending: which Baileys content an outgoing image/video attachment becomes, and that the echoed Attachment.gif
// matches what WhatsApp will really show (only an mp4 with gifPlayback animates). Offline: fake socket.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent, OutgoingAttachment } from "@unimsg/core";
import factory, { visualContent } from "./index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-gif-"));
  const c = factory.create({ accountId: "t", dataDir: dir }) as any;
  const sent: any[] = [];
  c.emit = (_e: CoreEvent) => {};
  c.opened = true;
  c.sock = { sendMessage: async (jid: string, content: any) => {
    sent.push(content);
    // echo what Baileys would relay back, so the stored/returned Message goes through the normal receive mapping
    const message = content.video
      ? { videoMessage: { mimetype: content.mimetype, caption: content.caption, ...(content.gifPlayback ? { gifPlayback: true } : {}) } }
      : { imageMessage: { mimetype: content.mimetype, caption: content.caption } };
    return { key: { remoteJid: jid, id: "S" + sent.length, fromMe: true }, messageTimestamp: 9, message, status: 1 };
  } };
  return { c, sent, done: () => { c.store.discard(); rmSync(dir, { recursive: true, force: true }); } };
}
const ANN = "4915111@s.whatsapp.net";
const MP4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom", "latin1"), Buffer.alloc(8)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(10)]);
const att = (a: Partial<OutgoingAttachment> & Pick<OutgoingAttachment, "kind" | "mime" | "data">) => a as OutgoingAttachment;

test("an mp4 marked as a GIF is sent as a video with gifPlayback and is echoed as a GIF", async () => {
  const t = setup();
  try {
    const m = await t.c.send(ANN, { text: "look", attachments: [att({ kind: "video", mime: "video/mp4", data: MP4, gif: true })] });
    assert.deepEqual(t.sent[0], { video: MP4, mimetype: "video/mp4", gifPlayback: true, caption: "look" });
    assert.equal(m.attachments[0].gif, true);
    // the mime may be missing on the way in (UI picked an .mp4 it did not sniff): the ftyp box decides
    await t.c.send(ANN, { text: "x", attachments: [att({ kind: "image", mime: "application/octet-stream", data: MP4, gif: true })] });
    assert.equal(t.sent[1].gifPlayback, true);
  } finally { t.done(); }
});

test("a real image/gif cannot animate: it is sent as a still image and never echoed as a GIF", async () => {
  const t = setup();
  try {
    const m = await t.c.send(ANN, { text: "", attachments: [att({ kind: "image", mime: "image/gif", data: GIF, gif: true })] });
    assert.deepEqual(t.sent[0], { image: GIF, mimetype: "image/gif" });
    assert.equal(m.attachments[0].mime, "image/gif");
    assert.equal(m.attachments[0].gif, undefined); // honest: WhatsApp shows the first frame, so the message must not claim an animation
    // GIF bytes stay an image even when the hint says video: a videoMessage of them would be unplayable
    await t.c.send(ANN, { text: "", attachments: [att({ kind: "video", mime: "image/gif", data: GIF, gif: true })] });
    assert.equal(t.sent[1].video, undefined);
    assert.equal(t.sent[1].gifPlayback, undefined);
    assert.ok(t.sent[1].image);
  } finally { t.done(); }
});

test("ordinary images and videos are unchanged", async () => {
  const t = setup();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const m = await t.c.send(ANN, { text: "hi", attachments: [att({ kind: "image", mime: "image/png", data: png })] });
    assert.deepEqual(t.sent[0], { image: png, mimetype: "image/png", caption: "hi" });
    assert.equal(m.attachments[0].gif, undefined);
    await t.c.send(ANN, { text: "", attachments: [att({ kind: "video", mime: "video/mp4", data: MP4 })] });
    assert.deepEqual(t.sent[1], { video: MP4, mimetype: "video/mp4" }); // no gif hint: a plain video, no gifPlayback
  } finally { t.done(); }
});

test("visualContent is pure: the caption rides along and the gif hint alone does not make a video", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(visualContent(att({ kind: "image", mime: "image/png", data: png, gif: true }), png, { caption: "c" }), { image: png, mimetype: "image/png", caption: "c" });
  assert.deepEqual(visualContent(att({ kind: "video", mime: "video/mp4", data: MP4, gif: true }), MP4, {}), { video: MP4, mimetype: "video/mp4", gifPlayback: true });
});

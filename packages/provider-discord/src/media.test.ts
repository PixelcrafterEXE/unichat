// Pictures do not wait in the API's paced queue: a chat with thirty of them took most of a minute, top to bottom, so the
// newest (at the bottom, where a chat opens) came last and a tap on one just waited its turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Api } from "./api.js";

/** A stand-in CDN: answers each picture after `ms`, and records the order and how many were in flight at once. */
async function cdn(ms: number) {
  const started: string[] = []; let inflight = 0, peak = 0;
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    started.push(req.url!); inflight++; peak = Math.max(peak, inflight);
    setTimeout(() => { inflight--; res.writeHead(200, { "content-type": "image/png" }); res.end(Buffer.from(req.url!)); }, ms);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { url: (n: number) => `${base}/p${n}.png`, started, peak: () => peak, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const userApi = () => new Api({ base: "http://127.0.0.1:1", token: "t", mode: "user", paceMs: 1000 }); // a user account: API calls 1-2 s apart

test("a chat's pictures download in parallel, not paced like API calls", async () => {
  const c = await cdn(100), api = userApi();
  try {
    const t0 = Date.now();
    const got = await Promise.all(Array.from({ length: 12 }, (_, i) => api.fetchMedia(c.url(i), 1)));
    assert.equal(got.length, 12);
    assert.ok(Date.now() - t0 < 2500, `12 pictures in ${Date.now() - t0} ms (paced one by one this was 12-24 s)`);
    assert.ok(c.peak() <= 4, `at most 4 at once (saw ${c.peak()})`); assert.ok(c.peak() >= 2, "but more than one");
  } finally { api.close(); await c.close(); }
});

test("the most recently requested picture goes first: a chat opens at the bottom, and those are asked for last", async () => {
  const c = await cdn(80), api = userApi();
  try {
    await Promise.all(Array.from({ length: 10 }, (_, i) => api.fetchMedia(c.url(i), 1)));
    // The first four start as they are asked for. Of the six that waited, the newest go first: when the first four finish
    // together, four slots open in the same instant, so within that batch the arrival order is the network's.
    assert.deepEqual(new Set(c.started.slice(4, 8)), new Set(["/p9.png", "/p8.png", "/p7.png", "/p6.png"]), "the newest four of the waiting six");
    assert.deepEqual(new Set(c.started.slice(8)), new Set(["/p5.png", "/p4.png"]), "the oldest waited longest");
  } finally { api.close(); await c.close(); }
});

test("a tap on a picture still waiting moves it to the front, and it is downloaded once", async () => {
  const c = await cdn(80), api = userApi();
  try {
    const all = Array.from({ length: 10 }, (_, i) => api.fetchMedia(c.url(i), 1));
    // p4 is the oldest of the six that wait: left alone it would start last of all. Four slots open in the same instant,
    // so "next" means "in the next batch" -- which p4 can only be in if the tap moved it.
    const tapped = api.fetchMedia(c.url(4), 0);
    await Promise.all([...all, tapped]);
    assert.ok(c.started.slice(4, 8).includes("/p4.png"), `the tapped one starts with the next batch (${c.started.slice(4).join(" ")})`);
    assert.equal(c.started.filter((u) => u === "/p4.png").length, 1, "one download for both requests");
    assert.equal(Buffer.from((await tapped).data).toString(), "/p4.png");
  } finally { api.close(); await c.close(); }
});

test("closing the account fails the pictures still waiting instead of leaving them hanging", async () => {
  const c = await cdn(200), api = userApi();
  try {
    const ps = Array.from({ length: 8 }, (_, i) => api.fetchMedia(c.url(i), 1).then(() => "ok", (e) => e.message));
    api.close();
    const r = await Promise.all(ps);
    assert.equal(r.filter((x) => x === "Stopped.").length, 4, "the four that had not started yet");
  } finally { await c.close(); }
});

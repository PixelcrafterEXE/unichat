// Link previews: SSRF policy + metadata parsing against a fake web server on loopback (loopback is allowed ONLY through the injected
// `allowPrivate` + `get` overrides, never by default), and the send() integration. No real network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { request as httpRequest, createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IdentityKeyPair } from "@signalapp/libsignal-client";
import type { CoreEvent } from "@unimsg/core";
import type { Content } from "../protocol/codec.js";
import { SignalClient } from "../service/client.js";
import type { CdnHttp } from "../service/attachmentUpload.js";
import { PreviewError, fetchPreview, firstUrl, isPublicAddress, parseMeta, type PreviewDeps, type RawGetArgs, type RawResponse } from "../service/linkPreview.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 7)]);
const ME = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
async function webServer(handler: Handler): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(`${req.headers.host}${req.url}`); handler(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as { port: number }).port, hits };
}
/** Everything resolves to loopback; the "https" request is made as plain http to the fake server. */
const loopbackDeps = (port: number, extra: Partial<PreviewDeps> = {}): PreviewDeps => ({
  resolve: async () => [{ address: "127.0.0.1", family: 4 }], allowPrivate: true,
  get: (a: RawGetArgs) => new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: `${a.url.pathname}${a.url.search}`, headers: { host: a.url.host }, signal: a.signal }, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }));
    req.on("error", reject); req.end();
  }),
  ...extra,
});
const html = (res: ServerResponse, body: string, type = "text/html; charset=utf-8") => { res.writeHead(200, { "content-type": type }); res.end(body); };

test("firstUrl: first link, trailing punctuation stripped, balanced parens kept", () => {
  assert.equal(firstUrl("see https://example.com/a, ok")?.url, "https://example.com/a");
  assert.equal(firstUrl("(https://example.com/a_(b))")?.url, "https://example.com/a_(b)");
  assert.equal(firstUrl("(https://example.com/x)")?.url, "https://example.com/x");
  assert.equal(firstUrl("no link here"), undefined);
  assert.equal(firstUrl("a http://one.test b https://two.test")?.url, "http://one.test");
});

test("address policy: private, loopback, link-local, CGNAT, metadata, mapped and unique-local addresses are rejected", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "ff02::1", "64:ff9b::7f00:1", "not-an-ip"]) assert.equal(isPublicAddress(a), false, a);
  for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(a), true, a);
});

test("SSRF: by default loopback targets are refused (no request made); all DNS answers must be public; http and credentials refused", async () => {
  const w = await webServer((_q, res) => html(res, "<title>x</title>"));
  try {
    const noAllow: PreviewDeps = { ...loopbackDeps(w.port), allowPrivate: false };
    await assert.rejects(fetchPreview("https://evil.test/", noAllow), (e: PreviewError) => e.reason === "private-address");
    assert.equal(w.hits.length, 0);
    const mixed: PreviewDeps = { ...noAllow, resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] };
    await assert.rejects(fetchPreview("https://rebind.test/", mixed), (e: PreviewError) => e.reason === "private-address");
    await assert.rejects(fetchPreview("https://127.0.0.1/", { ...noAllow }), (e: PreviewError) => e.reason === "private-address");
    await assert.rejects(fetchPreview("https://[::1]/", { ...noAllow }), (e: PreviewError) => e.reason === "private-address");
    await assert.rejects(fetchPreview("http://example.com/", loopbackDeps(w.port)), (e: PreviewError) => e.reason === "not-https");
    await assert.rejects(fetchPreview("https://user:pw@example.com/", loopbackDeps(w.port)), (e: PreviewError) => e.reason === "credentials-in-url");
    assert.equal(w.hits.length, 0);
  } finally { w.server.close(); }
});

test("redirects: followed (max 3), each hop is re-validated, redirect to a private address is refused", async () => {
  const w = await webServer((req, res) => {
    const n = Number(/hop(\d+)/.exec(req.url ?? "")?.[1] ?? "-1");
    if (req.url === "/ok") return html(res, '<meta property="og:title" content="Landed"><title>t</title>');
    if (req.url === "/to-private") { res.writeHead(302, { location: "https://internal.test/secret" }); return void res.end(); }
    if (req.url === "/to-http") { res.writeHead(302, { location: "http://example.com/x" }); return void res.end(); }
    if (n >= 0) { res.writeHead(302, { location: n >= 9 ? "/ok" : `/hop${n + 1}` }); return void res.end(); }
    html(res, "<title>top</title>");
  });
  try {
    const resolve = async (host: string) => [{ address: host === "internal.test" ? "10.0.0.9" : "127.0.0.1", family: 4 }];
    const deps = loopbackDeps(w.port, { resolve });
    // 3 redirects are fine: /hop6 -> hop7 -> hop8 -> hop9 -> /ok is 4 hops; start at hop8 -> hop9 -> /ok = 2
    assert.equal((await fetchPreview("https://a.test/hop8", deps)).title, "Landed");
    await assert.rejects(fetchPreview("https://a.test/hop0", deps), (e: PreviewError) => e.reason === "too-many-redirects");
    // internal.test resolves to a private address: that hop must be refused even though the first host was fine
    const strict = { ...deps, allowPrivate: false, resolve: async (h: string) => [{ address: h === "internal.test" ? "10.0.0.9" : "93.184.216.34", family: 4 }] };
    const hitsBefore = w.hits.length;
    await assert.rejects(fetchPreview("https://a.test/to-private", { ...strict, get: deps.get }), (e: PreviewError) => e.reason === "private-address");
    assert.equal(w.hits.length, hitsBefore + 1); // only the first (public) hop was requested
    await assert.rejects(fetchPreview("https://a.test/to-http", deps), (e: PreviewError) => e.reason === "not-https");
  } finally { w.server.close(); }
});

test("caps: only text/html, 1 MB body cap (header and streamed), 5 s timeout, non-200 refused", async () => {
  const w = await webServer((req, res) => {
    if (req.url === "/json") return html(res, "{}", "application/json");
    if (req.url === "/big-header") { res.writeHead(200, { "content-type": "text/html", "content-length": String(2 * 1024 * 1024) }); return void res.end(Buffer.alloc(2 * 1024 * 1024, 97)); }
    if (req.url === "/big-stream") { res.writeHead(200, { "content-type": "text/html" }); res.write(Buffer.alloc(900 * 1024, 97)); res.write(Buffer.alloc(300 * 1024, 97)); return void res.end(); }
    if (req.url === "/slow") { res.writeHead(200, { "content-type": "text/html" }); res.write("<title>x"); return; }
    if (req.url === "/404") { res.writeHead(404); return void res.end(); }
    html(res, "<title>fine</title>");
  });
  try {
    const d = loopbackDeps(w.port, { timeoutMs: 300 });
    for (const [path, reason] of [["/json", "content-type"], ["/big-header", "too-large"], ["/big-stream", "too-large"], ["/slow", "timeout"], ["/404", "http-404"]] as const) {
      await assert.rejects(fetchPreview(`https://a.test${path}`, d), (e: PreviewError) => e.reason === reason, path);
    }
    assert.equal((await fetchPreview("https://a.test/ok", d)).title, "fine");
  } finally { w.server.close(); w.server.closeAllConnections(); }
});

test("metadata: og:* beats twitter:* beats <title>; entities decoded; relative image resolved; image fetched with caps", async () => {
  const page = `<!doctype html><html><head><title>Plain &amp; title</title>
    <meta name="twitter:title" content="Twitter title"><meta property="og:title" content='OG &quot;Title&quot; &#233;'>
    <meta name="description" content="meta desc"><meta property="og:description" content="OG  desc
      with   spaces">
    <meta property="og:image" content="/img/p.png"></head><body>ignored</body></html>`;
  const w = await webServer((req, res) => {
    if (req.url === "/img/p.png") { res.writeHead(200, { "content-type": "image/png" }); return void res.end(PNG); }
    if (req.url === "/bad-img") return html(res, '<title>T</title><meta property="og:image" content="/notimg">');
    if (req.url === "/notimg") return html(res, "<html>", "text/html");
    if (req.url === "/empty") return html(res, "<html><body>nothing</body></html>");
    if (req.url === "/tw") return html(res, '<meta name="twitter:title" content="TW"><meta name="twitter:description" content="twd"><meta name="twitter:image" content="http://insecure.test/a.png">');
    html(res, page);
  });
  try {
    const d = loopbackDeps(w.port);
    const p = await fetchPreview("https://site.test/a/b?x=1", d);
    assert.equal(p.title, 'OG "Title" é'); assert.equal(p.description, "OG desc with spaces");
    assert.deepEqual([p.image?.mime, Buffer.from(p.image!.data).equals(PNG)], ["image/png", true]);
    assert.ok(w.hits.includes("site.test/img/p.png"), "relative image resolved against the page URL");
    const bad = await fetchPreview("https://site.test/bad-img", d);
    assert.equal(bad.title, "T"); assert.equal(bad.image, undefined); // image failure keeps the preview
    await assert.rejects(fetchPreview("https://site.test/empty", d), (e: PreviewError) => e.reason === "no-metadata");
    const tw = await fetchPreview("https://site.test/tw", d);
    assert.deepEqual([tw.title, tw.description, tw.image], ["TW", "twd", undefined]); // http image dropped
  } finally { w.server.close(); }
  assert.deepEqual(parseMeta("<title>x</title>", new URL("https://a.test")), { title: "x", description: undefined, image: undefined });
});

// ---------- send() integration ----------
async function sendSetup(o: { web?: Server; port?: number; linkPreviews?: boolean; group?: boolean } = {}) {
  const client = new SignalClient({ accountId: "acc", dataDir: mkdtempSync(join(tmpdir(), "unimsg-signal-lp-")) });
  await client.store.load();
  client.store.setAccount({ aci: ME, deviceId: 2, password: "pw", registrationId: 5, aciIdentity: Buffer.from(IdentityKeyPair.generate().serialize()).toString("base64"), readReceipts: true, linkedAt: 0,
    ...(o.linkPreviews === undefined ? {} : { linkPreviews: o.linkPreviews }) });
  const priv = client as unknown as Record<string, unknown> & { makeInbound(): void; emit: (e: CoreEvent) => void; previewDeps: PreviewDeps };
  priv.emit = () => {};
  const forms: string[] = [];
  priv.chatConn = { fetch: async (r: { path: string }) => { forms.push(r.path); return { status: 200, body: Buffer.from(JSON.stringify({ cdn: 3, key: "PV-KEY", headers: {}, signedUploadLocation: "https://cdn3.signal.org/up/1" })) }; } };
  const uploads: Buffer[] = [];
  priv.cdnHttp = (async (r) => { if (r.method === "POST") return { status: 201, headers: { location: "/r" } }; uploads.push(r.body!); return { status: 204, headers: {} }; }) as CdnHttp;
  priv.makeInbound();
  const calls: { aci: string; content: Content; mode: string }[] = [];
  priv.sender = { deliver: async (aci: string, content: Content, _ts: number, mode: string) => { calls.push({ aci, content, mode }); } };
  if (o.port) priv.previewDeps = loopbackDeps(o.port);
  return { client, calls, forms, uploads };
}

test("send: first https link gets a preview (title, description, uploaded image, date) in the message and the transcript", async () => {
  const w = await webServer((req, res) => {
    if (req.url === "/i.png") { res.writeHead(200, { "content-type": "image/png" }); return void res.end(PNG); }
    html(res, '<meta property="og:title" content="Cool page"><meta property="og:description" content="About it"><meta property="og:image" content="/i.png">');
  });
  try {
    const h = await sendSetup({ port: w.port });
    const m = await h.client.send(A, { text: "look https://cool.test/page and https://other.test" });
    const dm = h.calls.find((c) => c.mode === "message")!.content.dataMessage!;
    assert.equal(dm.preview!.length, 1);
    const p = dm.preview![0]!;
    assert.deepEqual([p.url, p.title, p.description, p.date], ["https://cool.test/page", "Cool page", "About it", Date.parse(m.time)]);
    assert.equal(p.image!.cdnKey, "PV-KEY"); assert.equal(p.image!.contentType, "image/png"); assert.equal(p.image!.key!.length, 64);
    assert.equal(h.uploads.length, 1);
    assert.deepEqual(h.calls.find((c) => c.mode === "sync")!.content.syncMessage!.sent!.message!.preview![0]!.url, "https://cool.test/page");
    assert.equal(m.text, "look https://cool.test/page and https://other.test");
    assert.deepEqual([m.card?.kind, m.card?.title, m.card?.image?.attachmentId], ["link", "Cool page", `${m.id}#preview`]);
    assert.ok(h.client.store.data.attachments[m.card!.image!.attachmentId], "preview image is downloadable through the attachment path");
  } finally { w.server.close(); }
});

test("send: opt-out (message field or account setting), http links, attachments and failures send plain text", async () => {
  const w = await webServer((_q, res) => html(res, "<title>T</title>"));
  try {
    const off = await sendSetup({ port: w.port });
    await off.client.send(A, { text: "https://x.test", linkPreview: false } as never);
    const off2 = await sendSetup({ port: w.port, linkPreviews: false });
    await off2.client.send(A, { text: "https://x.test" });
    const http = await sendSetup({ port: w.port });
    await http.client.send(A, { text: "http://x.test" });
    const att = await sendSetup({ port: w.port });
    await att.client.send(A, { text: "https://x.test", attachments: [{ kind: "file", mime: "text/plain", data: new Uint8Array([1, 2, 3]) }] });
    const ssrf = await sendSetup({}); // default deps: a loopback literal is refused, the message still goes out
    const m = await ssrf.client.send(A, { text: "http://127.0.0.1/ and https://127.0.0.1:1/" });
    assert.equal(m.text.length > 0, true);
    for (const h of [off, off2, http, att, ssrf]) assert.equal(h.calls.find((c) => c.mode === "message")!.content.dataMessage!.preview, undefined);
    assert.equal(w.hits.length, 0);
  } finally { w.server.close(); }
});

test("privacy setting 'linkPreviews' toggles the account flag; debug line has no URL", async () => {
  const h = await sendSetup({});
  assert.equal(h.client.getPrivacy().find((p) => p.id === "linkPreviews")!.value, "on");
  await h.client.setPrivacy("linkPreviews", "off");
  assert.equal(h.client.store.account!.linkPreviews, false);
  assert.equal(h.client.getPrivacy().find((p) => p.id === "linkPreviews")!.value, "off");
  const lines: string[] = []; const orig = console.debug; const prev = process.env.UNIMSG_DEBUG;
  process.env.UNIMSG_DEBUG = "1"; console.debug = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { const h2 = await sendSetup({}); await h2.client.send(A, { text: "https://secret-host.test/path" }); }
  finally { console.debug = orig; if (prev === undefined) delete process.env.UNIMSG_DEBUG; else process.env.UNIMSG_DEBUG = prev; }
  assert.ok(lines.some((l) => /^\[signal\] link preview: result=[a-z0-9-]+ image=0$/.test(l)), lines.join("|"));
  assert.ok(lines.every((l) => !l.includes("secret-host")));
});

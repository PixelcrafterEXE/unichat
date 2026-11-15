// Offline integration: connector against an in-process fake homeserver on 127.0.0.1 (no real homeserver contacted).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "./index.js";
import type { CoreEvent } from "@unimsg/core";

const ME = "@me:hs";
// Events that must count as "live" need a server time after the connector started (it drops older ones as backlog): use a future base.
const waitFor0 = async (f: () => boolean) => { const t = Date.now(); while (Date.now() - t < 8000 && !f()) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), "timeout"); };
const NOW = Date.now() + 3_600_000;
const st = (type: string, state_key: string, content: object, id: string) => ({ type, state_key, content, sender: ME, event_id: id, origin_server_ts: 1000 });
const msg = (id: string, body: string, sender = "@bob:hs", ts = NOW + 2000) => ({ type: "m.room.message", sender, event_id: id, origin_server_ts: ts, content: { msgtype: "m.text", body } });

const reqs: string[] = [];
let echoRooms: Record<string, any> = {};
const spaceRoom = (id: string, name: string, isSpace = true) => ({ state: { events: [st("m.room.create", "", isSpace ? { creator: ME, type: "m.space" } : { creator: ME }, "$c" + id),
  st("m.room.member", ME, { membership: "join" }, "$m" + id), st("m.room.name", "", { name }, "$n" + id)] }, timeline: { events: [] } });
let liveEvents: object[] = []; // timeline events for !dm:hs delivered by the next long-poll
let echo: object[] = []; // account data the fake server echoes back over /sync, like a real homeserver
test("connector: sync -> chats/spaces/messages, no login prompt with stored session", async () => {
  let batch = 0;
  const srv = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname.includes("/profile/")) return void res.end(JSON.stringify({ displayname: "Me Old", avatar_url: "mxc://hs/av" }));
    if (url.pathname.includes("/media/") && req.method === "GET") { res.setHeader("content-type", "image/png"); return void res.end(Buffer.from([137, 80, 78, 71])); }
    if (url.pathname.includes("/media/") && url.pathname.endsWith("/upload")) { req.resume(); return void req.on("end", () => { reqs.push(`${req.method} ${url.pathname}${url.search} ct=${req.headers["content-type"]}`); res.end(JSON.stringify({ content_uri: "mxc://hs/up" })); }); }
    if (url.pathname.endsWith("/versions")) return void res.end(JSON.stringify({ versions: ["v1.11"], unstable_features: {} }));
    if (url.pathname.endsWith("/sync")) {
      const first = !url.searchParams.get("since");
      const join: Record<string, any> = {};
      if (first) {
        join["!dm:hs"] = { state: { events: [st("m.room.create", "", { creator: ME }, "$c1"), st("m.room.member", ME, { membership: "join" }, "$m1"),
          st("m.room.member", "@bob:hs", { membership: "join", displayname: "Bob" }, "$m2")] }, timeline: { events: [msg("$a", "old"), { ...msg("$th", "threaded"), content: { msgtype: "m.text", body: "threaded", "m.relates_to": { rel_type: "m.thread", event_id: "$a", "m.in_reply_to": { event_id: "$a" }, is_falling_back: true } } }], limit: 20, prev_batch: "p" }, unread_notifications: { notification_count: 3 } };
        join["!sp:hs"] = { state: { events: [st("m.room.create", "", { creator: ME, type: "m.space" }, "$c2"), st("m.room.member", ME, { membership: "join" }, "$m3"),
          st("m.room.name", "", { name: "My Space" }, "$n"), st("m.space.child", "!ch:hs", { via: ["hs"] }, "$sc")] }, timeline: { events: [] } };
        join["!ch:hs"] = { state: { events: [st("m.room.create", "", { creator: ME }, "$c3"), st("m.room.member", ME, { membership: "join" }, "$m4"), st("m.room.name", "", { name: "general" }, "$n2")] }, timeline: { events: [] } };
        const inv = (id: string, name: string, direct: boolean) => ({ invite_state: { events: [
          { type: "m.room.create", state_key: "", sender: "@bob:hs", content: { creator: "@bob:hs" } },
          { type: "m.room.name", state_key: "", sender: "@bob:hs", content: { name } },
          { type: "m.room.member", state_key: ME, sender: "@bob:hs", content: { membership: "invite", ...(direct ? { is_direct: true } : {}) } }] } });
        batch = 1;
        return void res.end(JSON.stringify({ next_batch: "s1", rooms: { invite: { "!inv:hs": inv("!inv:hs", "", true), "!inv2:hs": inv("!inv2:hs", "Bob's Room", false) }, join }, account_data: { events: [{ type: "m.direct", content: { "@bob:hs": ["!dm:hs"] } }] } }));
      }
      if (batch === 1) { batch = 2; return void res.end(JSON.stringify({ next_batch: "s2", rooms: { join: { "!dm:hs": { timeline: { events: [msg("$stale", "stale", "@bob:hs", 1000), msg("$b", "live"), msg("$b", "live")] } } } } })); }
      setTimeout(() => { const ad = echo; echo = []; const j = echoRooms; echoRooms = {}; if (liveEvents.length) { j["!dm:hs"] = { timeline: { events: liveEvents } }; liveEvents = []; } res.end(JSON.stringify({ next_batch: "s" + ++batch, rooms: { join: j }, account_data: { events: ad } })); }, 300);
      return;
    }
    if (url.pathname.includes("/room_keys/")) { res.statusCode = 404; return void res.end(JSON.stringify({ errcode: "M_NOT_FOUND", error: "none" })); }
    if (req.method !== "GET" && /\/(createRoom|join\/.*)$/.test(url.pathname)) {
      let body = ""; req.on("data", (d) => (body += d));
      return void req.on("end", () => {
        reqs.push(`${req.method} ${decodeURIComponent(url.pathname)}${url.search} ${body}`);
        const t = decodeURIComponent(url.pathname.split("/join/")[1] ?? "");
        const json = (code: number, o: object) => { res.statusCode = code; res.end(JSON.stringify(o)); };
        if (url.pathname.endsWith("/createRoom")) { echoRooms["!new:hs"] = spaceRoom("!new:hs", JSON.parse(body).name); return json(200, { room_id: "!new:hs" }); }
        if (t === "#sp:hs") { echoRooms["!sp2:hs"] = spaceRoom("!sp2:hs", "Joined Space"); return json(200, { room_id: "!sp2:hs" }); }
        if (t === "#room:hs") { echoRooms["!plain:hs"] = spaceRoom("!plain:hs", "Plain", false); return json(200, { room_id: "!plain:hs" }); }
        if (t === "!inv:hs") { echoRooms["!inv:hs"] = spaceRoom("!inv:hs", "", false); return json(200, { room_id: "!inv:hs" }); }
        if (t === "!dm:hs") return json(200, { room_id: "!dm:hs" }); // a room we are already in
        if (t === "#gone:hs") return json(404, { errcode: "M_NOT_FOUND", error: "x" });
        return json(403, { errcode: "M_FORBIDDEN", error: "x" });
      });
    }
    if (req.method !== "GET" && !/keys\//.test(url.pathname)) {
      let body = ""; req.on("data", (d) => (body += d));
      return void req.on("end", () => { reqs.push(`${req.method} ${decodeURIComponent(url.pathname)} ${body}`);
        if (req.method === "PUT" && url.pathname.includes("/account_data/")) echo.push({ type: url.pathname.split("/").pop(), content: JSON.parse(body) }); res.end(JSON.stringify({ event_id: "$srv" + reqs.length })); });
    }
    res.end(JSON.stringify({ one_time_key_counts: { signed_curve25519: 50 }, device_keys: {}, failures: {} }));
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const dir = mkdtempSync(join(tmpdir(), "mx-"));
  const port = (srv.address() as { port: number }).port;
  writeFileSync(join(dir, "matrix-session.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, userId: ME, deviceId: "D", accessToken: "tok", cryptoKey: Buffer.alloc(32, 1).toString("base64") }));
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  try {
    await conn.start((e) => ev.push(e));
    const t0 = Date.now();
    while (Date.now() - t0 < 15000 && !ev.some((e) => e.type === "message")) await new Promise((r) => setTimeout(r, 100));
    assert.ok(!ev.some((e) => e.type === "login"), "no login prompt");
    assert.ok(ev.some((e) => e.type === "account" && e.data.state === "connected"));
    const msgs = ev.filter((e) => e.type === "message");
    assert.equal(msgs.length, 1); // regression (real Synapse): initial-sync backlog re-delivered after PREPARED (old server time) and duplicates are not emitted, only the live one
    assert.equal((msgs[0] as any).data.text, "live");
    const chats = await conn.chats();
    const dm = chats.find((c) => c.id === "!dm:hs")!; const ch = chats.find((c) => c.id === "!ch:hs")!;
    assert.equal(dm.kind, "dm"); assert.equal(dm.unread, 3); assert.equal(ch.kind, "channel"); assert.equal(ch.spaceId, "!sp:hs");
    assert.equal(chats.length, 4);
    const inv = chats.find((c) => c.id === "!inv:hs")!, inv2 = chats.find((c) => c.id === "!inv2:hs")!;
    assert.deepEqual([inv.request, inv.kind, inv.name], [true, "dm", "Bob"]);  // pending DM invite: a request, named after the inviter
    assert.deepEqual([inv2.request, inv2.kind, inv2.name], [true, "group", "Bob's Room"]);
    assert.equal(dm.request, undefined);
    assert.deepEqual(await conn.history("!inv2:hs", { limit: 10 }), []);
    assert.ok(conn.capabilities.requests && conn.capabilities.mentions);
    const sp = await conn.spaces();
    assert.deepEqual(sp.map((s) => [s.id, s.name]), [["!sp:hs", "My Space"]]);
    assert.ok(!chats.some((c) => c.blocked));
    await conn.declineRequest!("!inv2:hs");
    await conn.acceptRequest!("!inv:hs");
    await assert.rejects(conn.acceptRequest!("!inv2:hs"), /no longer pending/);
    const mm = await conn.send("!dm:hs", { text: "hi @Bob & co", mentions: [{ id: "@bob:hs", name: "Bob", start: 3, length: 4 }] });
    assert.equal(mm.text, "hi @Bob & co");
    await conn.send("!dm:hs", { text: "plain stays plain" });
    await conn.send("!dm:hs", { text: "thread answer", replyToMessageId: "$th" });
    await conn.send("!dm:hs", { text: "normal reply", replyToMessageId: "$a" });
    await conn.renameChat!("!ch:hs", " Lobby ");
    await conn.setChatDescription!("!ch:hs", " New topic ");
    echoRooms["!ch:hs"] = { state: { events: [st("m.room.topic", "", { topic: "New topic" }, "$tp")] }, timeline: { events: [] } };
    const t1 = ev.length;
    await waitFor0(() => ev.slice(t1).some((e) => e.type === "chats-changed" && (e.data as any).chatId === "!ch:hs"));
    assert.equal((await conn.chats()).find((c) => c.id === "!ch:hs")!.description, "New topic"); // description follows topic changes
    // pins: m.room.pinned_events read-modify-write, incoming state changes mark / unmark messages, pins() lists them
    assert.equal(conn.capabilities.pinMessages, true);
    await conn.pin!("!ch:hs", "$p1", true);
    const t2 = ev.length;
    echoRooms["!dm:hs"] = { state: { events: [st("m.room.pinned_events", "", { pinned: ["$a"] }, "$pe1")] }, timeline: { events: [] } };
    await waitFor0(() => ev.slice(t2).some((e) => e.type === "message-update" && e.data.messageId === "$a" && e.data.patch.pinned === true));
    const pu = ev.slice(t2).find((e) => e.type === "message-update" && e.data.messageId === "$a") as any;
    assert.equal(pu.data.patch.pinnedBy, ME);
    assert.deepEqual((await conn.pins!("!dm:hs")).map((m) => [m.id, m.pinned]), [["$a", true]]);
    await conn.pin!("!dm:hs", "$b", true);
    await conn.pin!("!dm:hs", "$a", false);
    await conn.addMembers!("!ch:hs", ["alice", "@carol:other.org"]);
    await conn.removeMember!("!ch:hs", "@bob:hs");
    await conn.blockChat!("!dm:hs", true);
    assert.equal((await conn.chats()).find((c) => c.id === "!dm:hs")!.blocked, true);
    await conn.leaveChat!("!ch:hs");
    await assert.rejects(conn.addMembers!("!ch:hs", ["@bad id:x"]));
    await assert.rejects(conn.blockChat!("!ch:hs", true));
    const log = reqs.join("\n");
    assert.match(log, /PUT .*\/rooms\/!ch:hs\/state\/m\.room\.topic\/? \{[^\n]*"topic":"New topic"/);
    assert.match(log, /POST .*\/join\/!inv:hs/); assert.match(log, /POST .*\/rooms\/!inv2:hs\/leave/); assert.match(log, /POST .*\/rooms\/!inv2:hs\/forget/);
    assert.ok(!/join\/!inv2:hs/.test(log), "declining never joins");
    assert.match(log, /account_data\/m\.direct \{[^\n]*"@bob:hs":\[[^\n]*"!inv:hs"/);        // accepted DM invite is remembered as a direct chat
    const mline = log.split("\n").find((l) => l.includes('"body":"hi @Bob & co"'))!;
    assert.ok(mline.includes('"m.mentions":{"user_ids":["@bob:hs"]}') && mline.includes('"formatted_body":"hi <a href=\\"https://matrix.to/#/%40bob%3Ahs\\">@Bob</a> &amp; co"') && mline.includes('"format":"org.matrix.custom.html"'));
    assert.match(log, /\{"msgtype":"m\.text","body":"plain stays plain"\}/);
    assert.match(log, /"body":"thread answer"[^\n]*"m\.relates_to":\{"rel_type":"m\.thread","event_id":"\$a","is_falling_back":false,"m\.in_reply_to":\{"event_id":"\$th"\}\}/);
    assert.match(log, /"body":"normal reply"[^\n]*"m\.relates_to":\{"m\.in_reply_to":\{"event_id":"\$a"\}\}/);
    assert.match(log, /PUT \/.*\/rooms\/!ch:hs\/state\/m.room.name\/? \{"name":"Lobby"\}/);
    assert.match(log, /PUT .*\/rooms\/!ch:hs\/state\/m\.room\.pinned_events\/? \{"pinned":\["\$p1"\]\}/);
    assert.match(log, /PUT .*\/rooms\/!dm:hs\/state\/m\.room\.pinned_events\/? \{"pinned":\["\$a","\$b"\]\}/); // appended to the room's current list
    assert.match(log, /PUT .*\/rooms\/!dm:hs\/state\/m\.room\.pinned_events\/? \{"pinned":\[\]\}/);   // unpin removes that id (the fake server does not echo state, so $b is not yet in the room's list)
    assert.match(log, /POST .*\/rooms\/!ch:hs\/invite \{"user_id":"@alice:hs"\}/);
    assert.match(log, /invite \{"user_id":"@carol:other.org"\}/);
    assert.match(log, /rooms\/!ch:hs\/kick \{"user_id":"@bob:hs"\}/);
    assert.match(log, /user\/@me:hs\/account_data\/m.ignored_user_list .*@bob:hs/);
    assert.match(log, /rooms\/!ch:hs\/leave/);
    assert.match(log, /rooms\/!ch:hs\/forget/);
    // communities
    const created = await conn.createSpace!("Team", "About us");
    assert.deepEqual([created.id, created.name], ["!new:hs", "Team"]);
    const j1 = await conn.joinSpace!("https://matrix.to/#/%23sp%3Ahs?via=a.org&via=b.org");
    assert.deepEqual([j1.id, j1.name], ["!sp2:hs", "Joined Space"]);
    await assert.rejects(conn.joinSpace!("#room:hs"), /not a space/);
    await assert.rejects(conn.joinSpace!("!dm:hs"), /not a space/); // regression (real Synapse run): must not leave a room we were already in
    await assert.rejects(conn.joinSpace!("#gone:hs"), /not found/);
    await assert.rejects(conn.joinSpace!("#priv:hs"), /Not allowed/);
    await assert.rejects(conn.joinSpace!("hello"), /Not a Matrix space link/);
    assert.deepEqual((await conn.spaces()).map((x) => x.id).sort(), ["!new:hs", "!sp2:hs", "!sp:hs"]);
    assert.ok(ev.some((e) => e.type === "spaces-changed"));
    const log2 = reqs.join("\n");
    const cr = JSON.parse(/createRoom (\{.*\})/.exec(log2)![1]);
    assert.equal(cr.name, "Team"); assert.equal(cr.topic, "About us"); assert.equal(cr.creation_content.type, "m.space");
    assert.equal(cr.visibility, "private"); assert.equal(cr.preset, "private_chat"); assert.equal(cr.power_level_content_override.events["m.space.child"], 100);
    assert.match(log2, /POST .*\/join\/#sp:hs\?server_name=a\.org&server_name=b\.org/);
    // polls
    const pe = (id: string, type: string, sender: string, ts: number, content: object) => ({ type, sender, event_id: id, origin_server_ts: NOW + ts, content });
    const pollContent = { "m.text": "Lunch?\n1. Pizza\n2. Sushi", "m.poll": { question: { "m.text": "Lunch?" }, kind: "m.disclosed", max_selections: 1, answers: [{ id: "a", "m.text": "Pizza" }, { "m.id": "b", "m.text": "Sushi" }] } };
    const ref = { "m.relates_to": { rel_type: "m.reference", event_id: "$poll" } };
    const waitFor = async (f: () => boolean) => { const t = Date.now(); while (Date.now() - t < 8000 && !f()) await new Promise((r) => setTimeout(r, 50)); assert.ok(f(), "timeout"); };
    liveEvents.push(pe("$poll", "m.poll.start", "@bob:hs", 5000, pollContent));
    await waitFor(() => ev.some((e) => e.type === "message" && (e.data as any).id === "$poll"));
    const pm = (ev.find((e) => e.type === "message" && (e.data as any).id === "$poll") as any).data;
    assert.equal(pm.poll.question, "Lunch?"); assert.deepEqual(pm.poll.options.map((o: any) => o.id), ["a", "b"]); assert.equal(pm.text, "");
    liveEvents.push(pe("$r1", "m.poll.response", "@bob:hs", 5100, { "m.selections": ["a"], ...ref }));
    liveEvents.push(pe("$r2", "m.poll.response", "@bob:hs", 5200, { "m.selections": ["b"], ...ref }));
    await waitFor(() => ev.some((e) => e.type === "message-update" && (e.data as any).patch.poll));
    await new Promise((r) => setTimeout(r, 400));
    const upd = ev.filter((e) => e.type === "message-update" && (e.data as any).patch.poll).map((e: any) => e.data.patch.poll);
    const lastPoll = upd[upd.length - 1];
    assert.deepEqual(lastPoll.options.map((o: any) => o.voters), [[], ["@bob:hs"]]); // latest response wins
    await conn.vote!("!dm:hs", "$poll", ["a"]);
    await assert.rejects(conn.vote!("!dm:hs", "$poll", ["a", "b"]), /at most 1/);
    await assert.rejects(conn.vote!("!dm:hs", "$poll", ["zzz"]), /unknown/);
    const mine = (ev.filter((e) => e.type === "message-update" && (e.data as any).patch.poll).pop() as any).data.patch.poll;
    assert.deepEqual(mine.mine, ["a"]);
    await conn.vote!("!dm:hs", "$poll", []);
    const sent = await conn.send("!dm:hs", { text: "", poll: { question: "Q?", options: ["x", "y"], multiple: true } });
    assert.equal(sent.poll!.options.length, 2); assert.equal(sent.poll!.multiple, true);
    await conn.leaveSpace!("!new:hs");
    const log3 = reqs.join("\n");
    assert.match(log3, /PUT .*\/rooms\/!dm:hs\/send\/m\.poll\.response\/[^ ]* \{[^\n]*"m\.selections":\["a"\][^\n]*"m\.relates_to":\{"rel_type":"m\.reference","event_id":"\$poll"\}/);
    assert.match(log3, /m\.poll\.response\/[^ ]* \{[^\n]*"m\.selections":\[\]/);
    assert.match(log3, /m\.poll\.start\/[^ ]* \{[^\n]*"m\.poll":\{"question":\{"m\.text":"Q\?"\},"kind":"m\.disclosed","max_selections":2/);
    assert.match(log3, /POST .*\/rooms\/!new:hs\/leave/); assert.match(log3, /POST .*\/rooms\/!new:hs\/forget/);
    assert.ok(!/rooms\/!ch:hs\/leave[\s\S]*rooms\/!ch:hs\/leave/.test(log3));
    assert.ok(!/rooms\/!dm:hs\/(leave|forget)/.test(log3), "refused joinSpace of an already-joined room must not leave it");
    // avatars: contact (profile lookup fallback), none for room without avatar
    const av = await conn.avatar!({ kind: "contact", id: "@zed:hs" });
    assert.deepEqual([...av!.data], [137, 80, 78, 71]);
    assert.equal(await conn.avatar!({ kind: "chat", id: "!ch:hs" }), undefined);
    assert.equal(await conn.avatar!({ kind: "contact", id: "garbage" }), undefined);
    // profile + privacy
    const prof = await conn.getProfile!();
    assert.deepEqual([prof.displayName, prof.handle, [...prof.avatar!.data], prof.avatar!.mime], ["Me Old", ME, [137, 80, 78, 71], "image/png"]);
    await conn.updateProfile!({ displayName: " New Name ", avatar: { data: new Uint8Array([1, 2]), mime: "image/png" } });
    await conn.updateProfile!({ avatar: null });
    await assert.rejects(conn.updateProfile!({ about: "x" }), /about/);
    await assert.rejects(conn.updateProfile!({ displayName: "  " }));
    const pv = await conn.getPrivacy!();
    assert.deepEqual(pv.map((x) => [x.id, x.value]), [["readReceipts", "public"], ["typing", "on"], ["keyBackup", "none"], ["deviceVerification", "unverified"]]);
    await conn.markRead!("!dm:hs", "$b");
    const pv2 = await conn.setPrivacy!("readReceipts", "private");
    assert.equal(pv2[0].value, "private");
    await conn.markRead!("!dm:hs", "$b");
    await conn.setPrivacy!("typing", "off");
    await conn.setTyping!("!dm:hs", true);          // suppressed
    await conn.setPrivacy!("typing", "on");
    await conn.setTyping!("!dm:hs", true);
    await assert.rejects(conn.setPrivacy!("readReceipts", "nobody"));
    await assert.rejects(conn.setPrivacy!("keyBackup", "restore"), /no message key backup/);   // nothing to restore: no prompt opened
    await assert.rejects(conn.setPrivacy!("deviceVerification", "verified"), /cannot be changed/);
    assert.ok(!ev.some((e) => e.type === "login"));
    const log4 = reqs.join("\n");
    assert.match(log4, /PUT .*\/profile\/@me:hs\/displayname \{"displayname":"New Name"\}/);
    assert.match(log4, /POST \/_matrix\/media\/v3\/upload\?filename=avatar ct=image\/png/);
    assert.match(log4, /PUT .*\/profile\/@me:hs\/avatar_url \{"avatar_url":"mxc:\/\/hs\/up"\}/);
    assert.match(log4, /avatar_url \{"avatar_url":""\}/);
    assert.match(log4, /POST .*\/rooms\/!dm:hs\/receipt\/m\.read\/\$b /);
    assert.match(log4, /receipt\/m\.read\.private\/\$b /);
    assert.match(log4, /account_data\/org\.unimsg\.privacy \{"read_receipts":"private","typing":true\}/);
    assert.equal((log4.match(/\/typing\//g) ?? []).length, 1);
    assert.ok(!JSON.stringify(ev).includes("tok"));
  } finally { await conn.stop(); srv.close(); srv.closeAllConnections(); rmSync(dir, { recursive: true, force: true });  }
});

test("m.read receipts cover all of MY events since the member's previous receipt (read only, no delivery), private ones stay invisible", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-rc-"));
  try {
    const c = factory.create({ accountId: "t", dataDir: dir });
    const p = c as unknown as { me: string; emit: (e: CoreEvent) => void; onReceipt(ev: unknown, room: unknown): void };
    const events: CoreEvent[] = []; p.emit = (e) => events.push(e); (p as any).session = { userId: ME };
    const e = (id: string, sender: string, ts: number, extra: Record<string, unknown> = {}) => ({ getId: () => id, getSender: () => sender, getTs: () => ts, getType: () => "m.room.message", getRelation: () => (extra.rel ? { rel_type: extra.rel } : null) });
    const evs = [e("$1", ME, 1000), e("$2", "@bob:hs", 1500), e("$3", ME, 2000), e("$edit", ME, 2100, { rel: "m.replace" }), e("$4", ME, 3000)];
    const room = { roomId: "!r:hs", findEventById: (id: string) => evs.find((x) => x.getId() === id), getLiveTimeline: () => ({ getEvents: () => evs }) };
    const rc = (content: object) => ({ getContent: () => content });
    const got = () => events.filter((x) => x.type === "receipt").map((x) => (x as any).data);
    p.onReceipt(rc({ "$3": { "m.read": { "@bob:hs": { ts: 5000 } }, "m.read.private": { "@eve:hs": { ts: 5000 } } } }), room);
    assert.deepEqual(got().map((d) => [d.messageId, d.by, d.status, d.at]), [["$1", "@bob:hs", "read", new Date(5000).toISOString()], ["$3", "@bob:hs", "read", new Date(5000).toISOString()]]);
    events.length = 0;
    p.onReceipt(rc({ "$4": { "m.read": { "@bob:hs": { ts: 9000 }, [ME]: { ts: 9000 } } } }), room); // Bob moves on: only the new range; my own receipt is not reported
    assert.deepEqual(got().map((d) => [d.messageId, d.by]), [["$4", "@bob:hs"]]);
    assert.equal(c.capabilities.receiptDetails, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("presence: only 1:1 peers are reported, idle counts as online, offline carries lastSeen, duplicates are dropped, privacy switch silences it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mx-p-"));
  try {
    const conn: any = factory.create({ accountId: "acc", dataDir: dir });
    const ev: CoreEvent[] = []; conn.emitFn = (e: CoreEvent) => ev.push(e);
    conn.directMap = () => new Map([["!dm:hs", "@bob:hs"]]);
    assert.equal(conn.capabilities.presence, true);
    conn.emitPresence("@stranger:hs", "online");
    assert.equal(ev.length, 0, "not a DM peer: nothing");
    conn.emitPresence("@bob:hs", "unavailable");
    assert.deepEqual(ev.map((e) => e.data), [{ accountId: "acc", chatId: "!dm:hs", contactId: "@bob:hs", online: true }]);
    conn.emitPresence("@bob:hs", "unavailable"); assert.equal(ev.length, 1, "unchanged: not repeated");
    conn.emitPresence("@bob:hs", "offline", 120_000);
    const last: any = ev[1].data; assert.equal(last.online, false); assert.ok(Math.abs(Date.now() - Date.parse(last.lastSeen) - 120_000) < 2000);
    conn.setPresenceEnabled(false); conn.emitPresence("@bob:hs", "online"); assert.equal(ev.length, 2, "switch off: silent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

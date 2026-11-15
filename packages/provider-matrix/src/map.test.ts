import test from "node:test";
import assert from "node:assert/strict";
import { emoticons, firstHttpUrl, linkPreviewContent, htmlToText, mentionContent, threadOf, callCard, tallyPoll, parsePollStart, pollStartContent, pollResponseContent, parseSpaceInvite, normalizeUserId, mapMessage, pickEdit, groupReactions, stripReplyFallback, type RawEvent, type MapCtx } from "./map.js";
import { decryptAttachment, encryptAttachment } from "./attach-crypto.js";

const ctx: MapCtx = { chatId: "!r:x", selfId: "@me:x", nameOf: (u) => u.slice(1, u.indexOf(":")) };
const ev = (o: Partial<RawEvent> & { content: any }): RawEvent => ({ event_id: "$1", sender: "@bob:x", type: "m.room.message", origin_server_ts: 1_700_000_000_000, ...o });

test("text message", () => {
  const m = mapMessage(ev({ content: { msgtype: "m.text", body: "hi" } }), ctx)!;
  assert.equal(m.text, "hi"); assert.equal(m.sender, "bob"); assert.equal(m.fromMe, false); assert.equal(m.time, "2023-11-14T22:13:20.000Z");
});
test("own message gets status", () => {
  const m = mapMessage(ev({ sender: "@me:x", content: { msgtype: "m.text", body: "x" } }), ctx)!;
  assert.equal(m.fromMe, true); assert.equal(m.status, "sent");
});
test("reply strips legacy fallback and carries preview", () => {
  const e = ev({ content: { msgtype: "m.text", body: "> <@a:x> old\n\nanswer", "m.relates_to": { "m.in_reply_to": { event_id: "$0" } } } });
  const m = mapMessage(e, { ...ctx, replyPreview: () => ({ sender: "a", textPreview: "old" }) })!;
  assert.equal(m.text, "answer"); assert.deepEqual(m.replyTo, { messageId: "$0", sender: "a", textPreview: "old" });
  assert.equal(stripReplyFallback("> q\n\nr", false), "> q\n\nr");
});
test("edit applied, foreign edit ignored", () => {
  const orig = ev({ content: { msgtype: "m.text", body: "a" } });
  const edit = ev({ event_id: "$2", origin_server_ts: 1_700_000_001_000, content: { msgtype: "m.text", body: "* b", "m.new_content": { msgtype: "m.text", body: "b" }, "m.relates_to": { rel_type: "m.replace", event_id: "$1" } } });
  const evil = { ...edit, event_id: "$3", sender: "@eve:x" };
  assert.equal(pickEdit(orig, [evil]), undefined);
  const m = mapMessage(orig, { ...ctx, edit: pickEdit(orig, [evil, edit]) })!;
  assert.equal(m.text, "b"); assert.ok(m.editedAt);
  assert.equal(mapMessage(edit, ctx), null);
});
test("redacted", () => {
  assert.equal(mapMessage(ev({ content: {}, unsigned: { redacted_because: {} } }), ctx)!.deleted, true);
});
test("image with caption and encrypted file", () => {
  const m = mapMessage(ev({ content: { msgtype: "m.image", body: "look", filename: "a.png", info: { mimetype: "image/png", size: 5, w: 10, h: 20 }, file: { url: "mxc://x/y" } } }), ctx)!;
  assert.equal(m.text, "look"); assert.deepEqual(m.attachments, [{ id: "0", kind: "image", mime: "image/png", name: "a.png", size: 5, width: 10, height: 20 }]);
});
test("file without caption, voice, sticker", () => {
  assert.equal(mapMessage(ev({ content: { msgtype: "m.file", body: "d.pdf", url: "mxc://x/y" } }), ctx)!.text, "");
  assert.equal(mapMessage(ev({ content: { msgtype: "m.audio", body: "v.ogg", url: "mxc://x/y", "org.matrix.msc3245.voice": {} } }), ctx)!.attachments![0].kind, "voice");
  assert.equal(mapMessage(ev({ type: "m.sticker", content: { body: "smile", url: "mxc://x/y", info: {} } }), ctx)!.attachments![0].kind, "sticker");
});
test("undecryptable placeholder", () => {
  assert.match(mapMessage(ev({ type: "m.room.encrypted", content: {} }), ctx)!.text, /Encrypted/);
});
test("reactions grouping", () => {
  assert.deepEqual(groupReactions([{ key: "👍", sender: "@a:x" }, { key: "👍", sender: "@b:x" }, { key: "❤", sender: "@a:x" }]),
    [{ emoji: "👍", senderIds: ["@a:x", "@b:x"] }, { emoji: "❤", senderIds: ["@a:x"] }]);
});
test("attachment encryption roundtrip + tamper detection", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);
  const { ciphertext, info } = encryptAttachment(data);
  assert.deepEqual([...decryptAttachment(ciphertext, info)], [...data]);
  const bad = Uint8Array.from(ciphertext); bad[0] ^= 1;
  assert.throws(() => decryptAttachment(bad, info));
});
test("location and mine reactions", () => {
  const m = mapMessage(ev({ content: { msgtype: "m.location", body: "Cafe", geo_uri: "geo:52.5,13.4;u=10" } }), ctx)!;
  assert.deepEqual(m.location, { lat: 52.5, lng: 13.4, name: "Cafe" });
  assert.deepEqual(groupReactions([{ key: "👍", sender: "@me:x" }], "@me:x"), [{ emoji: "👍", senderIds: ["@me:x"], mine: true }]);
});
test("normalizeUserId", () => {
  assert.equal(normalizeUserId("@a:x.org", "@me:hs"), "@a:x.org");
  assert.equal(normalizeUserId("a:x.org", "@me:hs"), "@a:x.org");
  assert.equal(normalizeUserId("alice", "@me:hs"), "@alice:hs");
  assert.equal(normalizeUserId(" ", "@me:hs"), undefined);
  assert.equal(normalizeUserId("@a b:x", "@me:hs"), undefined);
});
test("parseSpaceInvite", () => {
  assert.deepEqual(parseSpaceInvite("#x:srv.org"), { target: "#x:srv.org", via: [] });
  assert.deepEqual(parseSpaceInvite("!id:srv?via=a.org&via=b.org"), { target: "!id:srv", via: ["a.org", "b.org"] });
  assert.deepEqual(parseSpaceInvite("https://matrix.to/#/%23x%3Asrv?via=a.org"), { target: "#x:srv", via: ["a.org"] });
  assert.deepEqual(parseSpaceInvite("https://matrix.to/#/!id:srv/$ev?via=a"), { target: "!id:srv", via: ["a"] });
  assert.deepEqual(parseSpaceInvite("matrix:r/x:srv?via=a"), { target: "#x:srv", via: ["a"] });
  // room v12 ids carry no server part (regression: found against Synapse 1.165)
  assert.deepEqual(parseSpaceInvite("!ab-C_d9"), { target: "!ab-C_d9", via: [] });
  assert.deepEqual(parseSpaceInvite("https://matrix.to/#/!ab-C_d9?via=srv"), { target: "!ab-C_d9", via: ["srv"] });
  assert.equal(parseSpaceInvite("#nodomain"), undefined);
  assert.equal(parseSpaceInvite("@user:srv"), undefined);
  assert.equal(parseSpaceInvite("junk"), undefined);
});

const pollEv = ev({ event_id: "$p", type: "m.poll.start", sender: "@bob:x", content: { "m.poll": { question: { "m.text": "Q" }, kind: "m.disclosed", max_selections: 2,
  answers: [{ id: "a", "m.text": "A" }, { id: "b", "m.text": "B" }, { id: "c", "m.text": "C" }] } } });
const resp = (id: string, sender: string, ts: number, sel: string[], type = "m.poll.response") =>
  ev({ event_id: id, type, sender, origin_server_ts: ts, content: { "m.selections": sel, "m.relates_to": { rel_type: "m.reference", event_id: "$p" } } });
const end = (id: string, sender: string, ts: number) => ev({ event_id: id, type: "m.poll.end", sender, origin_server_ts: ts, content: { "m.poll.end": {}, "m.relates_to": { rel_type: "m.reference", event_id: "$p" } } });

test("poll: ending by a user with redact power (MSC3381), regression from Synapse run", () => {
  const ps = parsePollStart(pollEv)!;
  const rel = [resp("1", "@a:x", 10, ["a"]), end("e", "@admin:x", 20), resp("2", "@a:x", 30, ["b"])];
  assert.equal(tallyPoll(pollEv, ps, rel, "@me:x").closed, undefined);
  const p = tallyPoll(pollEv, ps, rel, "@me:x", undefined, (u) => u === "@admin:x");
  assert.equal(p.closed, true); assert.deepEqual(p.options.map((o) => o.voters), [["@a:x"], [], []]);
});
test("poll: latest wins, max_selections, non-members, retract, spoiled", () => {
  const ps = parsePollStart(pollEv)!;
  const votes = (rel: RawEvent[], isMember?: (u: string) => boolean) => tallyPoll(pollEv, ps, rel, "@me:x", isMember).options.map((o) => o.voters);
  assert.deepEqual(votes([resp("1", "@a:x", 10, ["a"]), resp("2", "@a:x", 20, ["b", "c"])]), [[], ["@a:x"], ["@a:x"]]);
  assert.deepEqual(votes([resp("1", "@a:x", 10, ["a"]), resp("2", "@a:x", 20, [])]), [[], [], []]);
  assert.deepEqual(votes([resp("1", "@a:x", 10, ["a", "b", "c"])]), [["@a:x"], ["@a:x"], []]);          // truncated to max
  assert.deepEqual(votes([resp("1", "@a:x", 10, ["zzz"])]), [[], [], []]);                                // spoiled
  assert.deepEqual(votes([resp("1", "@gone:x", 10, ["a"])], (u) => u !== "@gone:x"), [[], [], []]);        // not a member
  assert.deepEqual(votes([resp("1", "@a:x", 10, ["a"], "org.matrix.msc3381.poll.response")]), [["@a:x"], [], []]);
});
test("poll: end closes, late votes ignored, only creator can end, mine", () => {
  const ps = parsePollStart(pollEv)!;
  const p = tallyPoll(pollEv, ps, [resp("1", "@me:x", 10, ["c"]), end("e", "@bob:x", 20), resp("2", "@a:x", 30, ["a"]), end("e2", "@eve:x", 5)], "@me:x");
  assert.equal(p.closed, true); assert.deepEqual(p.mine, ["c"]); assert.deepEqual(p.options.map((o) => o.voters), [[], [], ["@me:x"]]);
  assert.equal(tallyPoll(pollEv, ps, [end("e2", "@eve:x", 5)], "@me:x").closed, undefined);
});
test("poll: message mapping, sdk-era shape, malformed, outgoing content", () => {
  const m = mapMessage(pollEv, { ...ctx, pollRelated: [resp("1", "@me:x", 10, ["a"])] })!;
  assert.equal(m.poll!.multiple, true); assert.deepEqual(m.poll!.mine, ["a"]); assert.equal(m.text, "");
  const old = ev({ type: "org.matrix.msc3381.poll.start", content: { "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "Q" }, kind: "org.matrix.msc3381.poll.disclosed", answers: [{ id: "x", "org.matrix.msc1767.text": "X" }] } } });
  assert.equal(mapMessage(old, ctx)!.poll!.options[0].text, "X");
  assert.equal(mapMessage(ev({ type: "m.poll.start", content: { "m.text": "fallback" } }), ctx)!.text, "fallback");
  let n = 0; const c = pollStartContent("Q?", ["x", "y"], false, () => "id" + n++);
  assert.equal(parsePollStart(ev({ type: "m.poll.start", content: c }))!.options.length, 2);
  assert.equal(c.body, "Q?\n1. x\n2. y");
  assert.deepEqual(pollResponseContent("$p", ["a"])["m.relates_to"], { rel_type: "m.reference", event_id: "$p" });
});

const st = (type: string, state_key: string, content: object, extra: Partial<RawEvent> = {}) => ev({ event_id: "$s" + type + state_key, type, state_key, content, sender: "@bob:x", ...extra });

test("emote, notice, unknown msgtype, verification request", () => {
  assert.equal(mapMessage(ev({ content: { msgtype: "m.emote", body: "waves" } }), ctx)!.text, "* bob waves");
  assert.equal(mapMessage(ev({ content: { msgtype: "m.notice", body: "bot says" } }), ctx)!.text, "bot says");
  const u = mapMessage(ev({ content: { msgtype: "com.example.thing", body: "hello" } }), ctx)!;
  assert.equal(u.text, "hello"); assert.equal(u.card!.kind, "other"); assert.equal(u.card!.title, "com.example.thing");
  const v = mapMessage(ev({ content: { msgtype: "m.key.verification.request", body: "verify me", to: "@me:x" } }), ctx)!;
  assert.deepEqual([v.system, v.text, v.card], [{ kind: "info" }, "Key verification requested", undefined]);
  assert.equal(mapMessage(ev({ type: "m.key.verification.start", content: {} }), ctx), null);
  assert.equal(mapMessage(ev({ type: "m.key.verification.done", content: {} }), ctx)!.system!.kind, "info");
});
test("sticker keeps image info", () => {
  const m = mapMessage(ev({ type: "m.sticker", content: { body: "wave", url: "mxc://x/s", info: { mimetype: "image/webp", w: 100, h: 90 } } }), ctx)!;
  assert.deepEqual(m.attachments, [{ id: "0", kind: "sticker", mime: "image/webp", name: undefined, width: 100, height: 90 }]);
});
const inv = ev({ event_id: "$i", type: "m.call.invite", sender: "@bob:x", origin_server_ts: 1000, content: { call_id: "c1", lifetime: 60000, offer: { type: "offer", sdp: "v=0 m=audio m=video" } } });
const callEv = (type: string, ts: number, sender = "@me:x") => ev({ event_id: "$" + type + ts, type, sender, origin_server_ts: ts, content: { call_id: "c1" } });
test("call card: one card per call, status from answer/hangup", () => {
  const now = 10_000_000;
  assert.equal(callCard(inv, [], "@me:x", 1500).title, "Video call – ringing");
  assert.equal(callCard(inv, [], "@me:x", now).title, "Video call – missed");
  assert.equal(callCard(inv, [callEv("m.call.hangup", 5000, "@bob:x")], "@me:x", now).title, "Video call – missed");
  assert.equal(callCard(inv, [callEv("m.call.reject", 2000)], "@me:x", now).title, "Video call – declined");
  const done = callCard(inv, [callEv("m.call.answer", 2000), callEv("m.call.hangup", 67000)], "@me:x", now);
  assert.deepEqual([done.title, done.rows], ["Video call – ended", [{ label: "Duration", value: "1 min 5 s" }]]);
  const m = mapMessage(inv, { ...ctx, callRelated: [callEv("m.call.hangup", 5000, "@bob:x")], now })!;
  assert.deepEqual([m.card!.kind, m.text], ["call", "Video call – missed"]);
  assert.equal(mapMessage(callEv("m.call.hangup", 5), ctx), null);
  assert.equal(mapMessage(callEv("m.call.candidates", 5), ctx), null);
  const g = mapMessage(st("org.matrix.msc3401.call", "g1", { "m.type": "m.video", "m.intent": "m.room" }), ctx)!;
  assert.deepEqual([g.card!.kind, g.card!.title], ["call", "Group video call – started"]);
  assert.equal(mapMessage(st("org.matrix.msc3401.call.member", "@a:x", {}), ctx), null);
});
test("widgets", () => {
  const j = mapMessage(st("im.vector.modular.widgets", "w1", { type: "jitsi", name: "Jitsi", url: "https://x/y?conf=$matrix_room_id", data: { domain: "meet.example", conferenceId: "abc" } }), ctx)!;
  assert.deepEqual([j.card!.kind, j.card!.url, j.system!.kind], ["link", "https://meet.example/abc", "info"]);
  assert.equal(mapMessage(st("im.vector.modular.widgets", "w1", {}), ctx), null);
});
test("room state rows", () => {
  const t = (e: RawEvent, c: Partial<MapCtx> = {}) => mapMessage(e, { ...ctx, ...c })!;
  assert.equal(t(st("m.room.name", "", { name: "Lobby" })).text, 'bob changed the room name to "Lobby"');
  assert.equal(t(st("m.room.topic", "", { topic: "t" })).system!.kind, "info");
  assert.match(t(st("m.room.avatar", "", { url: "mxc://x/a" })).text, /changed the room picture/);
  assert.match(t(st("m.room.create", "", { creator: "@bob:x" })).text, /created the room/);
  assert.match(t(st("m.room.encryption", "", { algorithm: "m.megolm.v1.aes-sha2" })).text, /encryption/);
  assert.match(t(st("m.room.tombstone", "", { replacement_room: "!n:x" })).text, /upgraded/);
  assert.equal(t(st("m.room.name", "", { name: "Lobby" })).id, "$sm.room.name");
});
test("membership rows: kinds and member-count gate", () => {
  const mem = (target: string, c: object, prev: object | undefined, sender = target) => st("m.room.member", target, c, { sender, unsigned: prev ? { prev_content: prev } : undefined });
  const t = (e: RawEvent, n = 10) => mapMessage(e, { ...ctx, memberCount: n });
  assert.equal(t(mem("@al:x", { membership: "join", displayname: "Al" }, undefined))!.text, "Al joined");
  assert.equal(t(mem("@al:x", { membership: "leave" }, { membership: "join" }))!.text, "al left");
  assert.equal(t(mem("@al:x", { membership: "invite" }, undefined, "@bob:x"))!.text, "bob invited al");
  assert.equal(t(mem("@al:x", { membership: "leave" }, { membership: "join" }, "@bob:x"))!.text, "bob removed al");
  assert.equal(t(mem("@al:x", { membership: "ban" }, { membership: "join" }, "@bob:x"))!.text, "bob banned al");
  assert.equal(t(mem("@al:x", { membership: "join", displayname: "New" }, { membership: "join" })), null); // profile change
  assert.equal(t(mem("@al:x", { membership: "join" }, undefined), 51), null);                              // big room
  assert.equal(t(st("m.room.name", "", { name: "x" }), 500)!.system!.kind, "info");                         // non-membership rows unaffected
});
test("power level rows", () => {
  const pl = (users: object, prev: object) => mapMessage(st("m.room.power_levels", "", { users }, { unsigned: { prev_content: { users: prev } } }), ctx);
  assert.equal(pl({ "@al:x": 100 }, {})!.text, "al was made admin");
  assert.equal(pl({ "@al:x": 50 }, { "@al:x": 100 })!.text, "al is now moderator");
  assert.equal(pl({}, { "@al:x": 50 })!.text, "al is no longer moderator");
  assert.equal(pl({ "@al:x": 10 }, {}), null);
});
test("special events: redacted row becomes deleted, state redaction skipped", () => {
  assert.equal(mapMessage(ev({ type: "m.call.invite", content: {}, unsigned: { redacted_because: {} } }), ctx)!.deleted, true);
  assert.equal(mapMessage(st("m.room.topic", "", {}, { unsigned: { redacted_because: {} } }), ctx), null);
});

test("htmlToText: bold/italic/code/lists/quotes/links/spoilers, reply fallback and pills", () => {
  assert.equal(htmlToText("<mx-reply><blockquote>old</blockquote></mx-reply>Hello <strong>bold</strong> <em>it</em> <del>x</del> <code>a&lt;b</code>"), "Hello **bold** *it* ~~x~~ `a<b`");
  assert.equal(htmlToText("<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><ol start=\"3\"><li>c</li><li>d</li></ol>"), "- one\n- two\n  - nested\n3. c\n4. d");
  assert.equal(htmlToText("<blockquote>quoted<br>line2</blockquote>after"), "> quoted\n> line2\n\nafter".replace("\n\nafter", "\nafter"));
  assert.equal(htmlToText("<pre><code class=\"language-js\">let a = 1;\nb();</code></pre>"), "```\nlet a = 1;\nb();\n```");
  assert.equal(htmlToText('see <a href="https://example.org/x">the site</a> and <a href="https://example.org">https://example.org</a>'), "see the site (https://example.org/x) and https://example.org");
  assert.equal(htmlToText('hi <a href="https://matrix.to/#/@bob:srv">Bob</a>, <a href="https://matrix.to/#/@al:srv">@Al</a>'), "hi @Bob, @Al");
  assert.equal(htmlToText('secret: <span data-mx-spoiler>the end</span> &amp; &#x1F600; &quot;q&quot;'), 'secret: ||the end|| & 😀 "q"');
  assert.equal(htmlToText("<p>para one</p><p>para two</p><h2>Head</h2>text<br/>next<hr>"), "para one\n\npara two\n\n**Head**\n\ntext\nnext\n---");
  assert.equal(htmlToText('<img alt=":smile:" src="mxc://x/y"> <script>x</script>'), ":smile: x");
});
test("formatted bodies win over body, reply fallback stripped, edits use m.new_content html", () => {
  const m = mapMessage(ev({ content: { msgtype: "m.text", body: "> <@a:x> old\n\nplain", format: "org.matrix.custom.html", formatted_body: "<mx-reply><blockquote>old</blockquote></mx-reply><b>fmt</b>", "m.relates_to": { "m.in_reply_to": { event_id: "$o" } } } }), ctx)!;
  assert.equal(m.text, "**fmt**"); assert.equal(m.replyTo?.messageId, "$o");
  const e = mapMessage(ev({ content: { msgtype: "m.text", body: "a" } }), { ...ctx, edit: ev({ event_id: "$e", content: { body: "* x", "m.new_content": { msgtype: "m.text", body: "x", format: "org.matrix.custom.html", formatted_body: "<i>x</i>" } , "m.relates_to": { rel_type: "m.replace", event_id: "$1" } } }) })!;
  assert.equal(e.text, "*x*");
  assert.equal(mapMessage(ev({ content: { msgtype: "m.text", body: "plain <b>", format: "org.matrix.custom.html", formatted_body: "" } }), ctx)!.text, "plain <b>");
});
test("mentionContent: pill link + m.mentions, plain text stays plain, bad spans ignored", () => {
  assert.deepEqual(mentionContent("hello", undefined), {});
  assert.deepEqual(mentionContent("hello", [{ id: "bad", name: "x", start: 0, length: 2 }, { id: "@a:x", name: "a", start: 3, length: 9 }]), {});
  const c = mentionContent("hi @Bob & <co>\nbye @Bob", [{ id: "@bob:srv", name: "Bob", start: 3, length: 4 }, { id: "@bob:srv", name: "Bob", start: 19, length: 4 }, { id: "@x:srv", name: "o", start: 4, length: 2 }]) as any;
  assert.equal(c.formatted_body, 'hi <a href="https://matrix.to/#/%40bob%3Asrv">@Bob</a> &amp; &lt;co&gt;<br>bye <a href="https://matrix.to/#/%40bob%3Asrv">@Bob</a>');
  assert.deepEqual(c["m.mentions"], { user_ids: ["@bob:srv"] });
  // round trip: what we send is rendered as @Bob by the receive side
  assert.equal(htmlToText(c.formatted_body), "hi @Bob & <co>\nbye @Bob");
});
test("m.thread relation -> replyTo with thread hint (flat view)", () => {
  const root = { "m.relates_to": { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$root" }, is_falling_back: true } };
  const m1 = mapMessage(ev({ content: { msgtype: "m.text", body: "in thread", ...root } }), { ...ctx, replyPreview: (id) => ({ sender: "bob", textPreview: id }) })!;
  assert.deepEqual(m1.replyTo, { messageId: "$root", sender: "bob", textPreview: "$root", thread: true });
  const real = { "m.relates_to": { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$prev" }, is_falling_back: false } };
  assert.equal(mapMessage(ev({ content: { msgtype: "m.text", body: "> <@a:x> q\n\nanswer", ...real } }), ctx)!.text, "answer");
  assert.equal(mapMessage(ev({ content: { msgtype: "m.text", body: "x", ...real } }), ctx)!.replyTo?.messageId, "$prev");
  assert.deepEqual(threadOf(ev({ content: real })), { root: "$root", replyTo: "$prev" });
  assert.equal(threadOf(ev({ content: { "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } } })), undefined);
  const plain = mapMessage(ev({ content: { msgtype: "m.text", body: "r", "m.relates_to": { "m.in_reply_to": { event_id: "$a" } } } }), ctx)!;
  assert.equal((plain.replyTo as any).thread, undefined);
});
test("MSC4095 link previews become a link card; nothing is fetched", () => {
  const m = mapMessage(ev({ content: { msgtype: "m.text", body: "look https://example.org/a", "com.beeper.linkpreviews": [{ matched_url: "https://example.org/a", "og:title": "Example", "og:description": "Desc" }] } }), ctx)!;
  assert.deepEqual(m.card, { kind: "link", title: "Example", body: "Desc", url: "https://example.org/a" });
  assert.equal(m.text, "look https://example.org/a");
  assert.equal(mapMessage(ev({ content: { msgtype: "m.text", body: "x", "com.beeper.linkpreviews": [{ matched_url: "javascript:x", "og:title": "T" }] } }), ctx)!.card?.url, undefined);
});

test("sending link previews: first URL, homeserver og answer -> com.beeper.linkpreviews, nothing for empty/odd answers", () => {
  assert.equal(firstHttpUrl("see https://example.org/a?b=1, ok"), "https://example.org/a?b=1");
  assert.equal(firstHttpUrl("(http://x.test/p)"), "http://x.test/p");
  assert.equal(firstHttpUrl("no link, ftp://x.test and javascript:alert(1)"), undefined);
  const c = linkPreviewContent("https://example.org/a", { "og:title": "T", "og:description": "D", "og:image": "mxc://hs/img", "og:image:width": 40, "og:image:height": 30, "og:image:type": "image/png", "matrix:image:size": 99 })!;
  assert.deepEqual(c, { "com.beeper.linkpreviews": [{ matched_url: "https://example.org/a", "og:url": "https://example.org/a", "og:title": "T", "og:description": "D", "og:image": "mxc://hs/img", "og:image:width": 40, "og:image:height": 30, "matrix:image:size": 99, "og:image:type": "image/png" }] });
  assert.equal(linkPreviewContent("https://x", { "og:image": "mxc://hs/i" }), undefined);                       // no text at all: no preview
  assert.equal((linkPreviewContent("https://x", { "og:title": "T", "og:image": "https://evil/i.png" })!["com.beeper.linkpreviews"] as any)[0]["og:image"], undefined); // only mxc images
  // what we send is what we show: round trip through the receive mapper
  const m = mapMessage(ev({ content: { msgtype: "m.text", body: "look https://example.org/a", ...c } }), ctx)!;
  assert.deepEqual(m.card, { kind: "link", title: "T", body: "D", url: "https://example.org/a" });
});

test("custom emoji: <img data-mx-emoticon> becomes :shortcode: and its mxc is remembered; plain images and non-mxc sources are not", () => {
  assert.equal(htmlToText('hi <img data-mx-emoticon height="32" src="mxc://hs/abc" alt=":party_parrot:" title=":party_parrot:"> there'), "hi :party_parrot: there");
  assert.equal(emoticons.get("party_parrot"), "mxc://hs/abc");
  assert.equal(htmlToText('<img data-mx-emoticon src="https://evil/x.png" alt=":bad:">'), ":bad:");   // alt text only (as before), nothing registered
  assert.equal(emoticons.has("bad"), false);
  assert.equal(htmlToText('<img src="mxc://hs/p" alt="a photo">'), "a photo");
  assert.equal(emoticons.has("a photo"), false);
});

test("gifs: muted looping videos flagged by Element-style info keys; plain videos are not", () => {
  const vid = (info: object) => mapMessage(ev({ content: { msgtype: "m.video", body: "x.mp4", url: "mxc://x/v", info: { mimetype: "video/mp4", ...info } } }), ctx)!.attachments![0]!;
  assert.equal(vid({ "fi.mau.gif": true }).gif, true);
  assert.equal(vid({ "fi.mau.loop": true, "fi.mau.autoplay": true }).gif, true);
  assert.equal(vid({}).gif, undefined);
});

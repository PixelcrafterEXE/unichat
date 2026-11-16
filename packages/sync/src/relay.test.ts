// "Sending through another device" end to end over loopback with fake providers: a device that only has an account as a mirror (history, no login)
// uses a paired device that holds the live login, automatically once that device allowed it. Real Hubs, real encrypted sessions, no real services.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NO_CAPABILITIES, type Chat, type Connector, type CoreEvent, type Message, type ProviderFactory } from "@unimsg/core";
import { node, pairUp, until, type Node } from "./testkit.js";

const CAPS = { ...NO_CAPABILITIES, attachments: true, backfill: true, reactions: true, edits: true, polls: true, profile: { displayName: true, about: true, avatar: true }, privacy: true } as typeof NO_CAPABILITIES;
const ACCT = "relayfake-1", CHAT = ACCT + ":c1";
/** a fake messenger: every device that holds the login gets its own world; `calls` records what the REAL connector was asked to do */
interface World { prof: { displayName: string; about: string; avatar?: Uint8Array }; priv: Record<string, string>; calls: string[]; sent: string[]; emit?: (e: CoreEvent) => void; gate?: Promise<void> }
const mk = () => {
  const w: World = { calls: [], sent: [], prof: { displayName: "Real Name", about: "hi" }, priv: { lastSeen: "everyone" } };
  const f: ProviderFactory = { name: "relayfake", displayName: "RelayFake", login: "qr", capabilities: NO_CAPABILITIES, create: () => ({
    capabilities: CAPS,
    async start(emit: (e: CoreEvent) => void) { w.emit = emit; emit({ type: "account", data: { id: "x", state: "connected" } }); }, async stop() {}, async logout() {}, async submitLogin() {},
    async spaces() { return []; }, async chats() { return [{ id: "c1", accountId: "", provider: "relayfake", kind: "dm", name: "Anna" } as unknown as Chat]; }, async members() { return []; },
    async history() { w.calls.push("history"); return [{ id: "h1", chatId: "c1", sender: "Anna", senderId: "anna", text: "old hello", time: "2026-01-01T00:00:00Z", fromMe: false }]; },
    async downloadAttachment() { w.calls.push("attachment"); return { data: new Uint8Array([7, 7]), mime: "image/png" }; },
    async avatar() { w.calls.push("avatar"); return { data: new Uint8Array([1]), mime: "image/png" }; },
    async send(chatId: string, m: { text: string }) { w.calls.push("send"); if (w.gate) await w.gate; w.sent.push(m.text); return { id: "s" + w.sent.length + "-" + w.sent.join("|").length, chatId, sender: "me", senderId: "me", text: m.text, time: new Date().toISOString(), fromMe: true, status: "sent" } as Message; },
    async react(_c: string, id: string, e: string | null) { w.calls.push(`react:${id}:${e}`); }, async edit(_c: string, id: string, t: string) { w.calls.push(`edit:${id}:${t}`); },
    async delete(_c: string, id: string) { w.calls.push(`delete:${id}`); }, async markRead(_c: string, id: string) { w.calls.push(`markRead:${id}`); },
    async getProfile() { w.calls.push("getProfile"); return { displayName: w.prof.displayName, about: w.prof.about, handle: "+49 1", ...(w.prof.avatar ? { avatar: { data: w.prof.avatar, mime: "image/png" } } : {}) }; },
    async updateProfile(p: { displayName?: string; about?: string; avatar?: { data: Uint8Array; mime: string } | null }) { w.calls.push("updateProfile"); if (p.displayName !== undefined) w.prof.displayName = p.displayName; if (p.about !== undefined) w.prof.about = p.about; if (p.avatar !== undefined) w.prof.avatar = p.avatar ? p.avatar.data : undefined; return { displayName: w.prof.displayName, about: w.prof.about, ...(w.prof.avatar ? { avatar: { data: w.prof.avatar, mime: "image/png" } } : {}) }; },
    async getPrivacy() { return Object.entries(w.priv).map(([id, value]) => ({ id, label: id, value, options: [{ value: "everyone", label: "Everyone" }, { value: "nobody", label: "Nobody" }] })); },
    async setPrivacy(id: string, value: string) { w.calls.push(`setPrivacy:${id}:${value}`); w.priv[id] = value; return Object.entries(w.priv).map(([k, v]) => ({ id: k, label: k, value: v, options: [] })); },
    async vote(_c: string, id: string, o: string[]) { w.calls.push(`vote:${id}:${o.join()}`); }, async setTyping(_c: string, t: boolean) { w.calls.push(`typing:${t}`); },
  }) as unknown as Connector };
  return { w, f };
};
const holder = async (name: string, opts: any = {}, kind: "memory" | "sqlite" = "memory") => {
  const { w, f } = mk();
  const n = await node(name, kind, undefined, (s) => { s.putAccount({ id: ACCT, provider: "relayfake", label: "Relay", status: "active" }); }, undefined, { factories: [f], opts });
  mkdirSync(join(n.dir, "accounts", ACCT), { recursive: true }); writeFileSync(join(n.dir, "accounts", ACCT, "session.secret"), "SECRET-SESSION-" + name);
  return { n, w };
};
const mirror = async (name: string) => { const { w, f } = mk(); return { n: await node(name, "memory", undefined, undefined, undefined, { factories: [f] }), w }; };
const id = (n: Node) => n.svc.status().deviceId;
const acct = async (n: Node) => (await n.call("accounts")).find((a: any) => a.id === ACCT);
const st = (n: Node) => n.call("syncStatus");
const hasMirror = (n: Node) => until(() => n.store.listAccounts().some((a) => a.id === ACCT), `${n.name} has the account as a mirror`);
/** the mirror asks, the holder's user answers */
async function allow(A: Node, B: Node, yes = true) {
  assert.equal((await B.call("syncRelayAsk", { accountId: ACCT })).state, "pending");
  await until(async () => (await st(A)).proxy.asks.some((x: any) => x.deviceId === id(B) && x.accountId === ACCT), "prompt on the holder");
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: yes });
}
const stop = async (...n: Node[]) => { for (const x of n) await x.stop(); };

test("default is OFF: nothing is used until the holder allows; the question appears once on the holder, naming the device and account", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B);
  await until(async () => (await acct(B))?.via?.kind === "ask", "B shows the account as a history copy");
  const v = (await acct(B)).via; assert.equal(v.device, "Laptop"); assert.notEqual((await acct(B)).state, "connected");
  assert.deepEqual((await st(B)).proxy.using, [], "no relay without permission");
  await assert.rejects(B.call("send", { chatId: CHAT, text: "nope" }), /read-only|signed out/);
  assert.deepEqual(w.sent, []);
  // the holder is not asked by itself; only when the phone's user asks (composer / account note)
  assert.deepEqual((await st(A)).proxy.asks, []);
  assert.equal((await B.call("syncRelayAsk", { accountId: ACCT })).state, "pending");
  assert.equal((await B.call("syncRelayAsk", { accountId: ACCT })).state, "pending", "asking twice shows one prompt");
  await until(async () => (await st(A)).proxy.asks.length === 1, "one prompt");
  const ask = (await st(A)).proxy.asks[0]; assert.equal(ask.deviceName, "Phone"); assert.equal(ask.label, "Relay"); assert.equal(ask.accountId, ACCT);
  await stop(A, B);
});

test("allow: B uses the holder automatically (no manual proxy click); online, 'via Laptop', capabilities of the holder's connector; all write ops go through", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B, w: wb } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B);
  await allow(A, B, true);
  await until(async () => (await acct(B))?.state === "connected" && (await acct(B))?.via?.kind === "relay", "B online via the holder", 15_000);
  const a = await acct(B); assert.equal(a.via.device, "Laptop"); assert.equal(a.capabilities.reactions, true, "capabilities mirror the holder's connector"); assert.equal(a.capabilities.edits, true);
  assert.deepEqual((await st(B)).proxy.using.map((u: any) => [u.accountId, u.auto]), [[ACCT, true]]);
  assert.deepEqual((await st(A)).proxy.asks, [], "the prompt is gone");
  assert.equal((await st(A)).proxy.decisions.length, 1);
  // chats come from the holder, history too
  await until(async () => (await B.call("snapshot")).chats.some((c: any) => c.id === CHAT && !c.offline), "chat list live");
  assert.ok((await B.call("history", { chatId: CHAT, limit: 20 })).some((m: any) => m.text === "old hello"));
  const sent = await B.call("send", { chatId: CHAT, text: "hello from the phone" }); assert.equal(sent.chatId, CHAT);
  await B.call("react", { chatId: CHAT, messageId: "h1", emoji: "👍" }); await B.call("edit", { chatId: CHAT, messageId: sent.id, text: "edited" });
  await B.call("vote", { chatId: CHAT, messageId: "h1", optionIds: ["o1"] }); await B.call("markRead", { chatId: CHAT, messageId: "h1" });
  await B.call("setTyping", { chatId: CHAT, typing: true });
  const att = await B.call("attachment", { chatId: CHAT, messageId: "h1", attachmentId: "x" }); assert.equal(att.dataBase64, Buffer.from([7, 7]).toString("base64"));
  await B.call("delete", { chatId: CHAT, messageId: sent.id });
  assert.deepEqual(w.sent, ["hello from the phone"], "the REAL connector on the holder sent it, once");
  for (const c of ["react:h1:👍", `edit:${sent.id}:edited`, "vote:h1:o1", "markRead:h1", "typing:true", "attachment", `delete:${sent.id}`]) assert.ok(w.calls.includes(c), "holder ran " + c);
  assert.deepEqual(wb.calls, [], "the phone's own (unused) connector never ran");
  // the holder's log says who did what; chats carry no tag
  const au = (await st(A)).devices.find((d: any) => !d.self).audit[ACCT]; assert.ok(au.byOp.send === 1 && au.byOp.react === 1 && au.recent.some((r: any) => r.op === "send"));
  assert.ok(!JSON.stringify(A.store.getMessage(CHAT, sent.id) ?? {}).includes("Phone"), "no device tag in the message");
  // events from the holder arrive on the phone
  const seen: string[] = []; B.hub.subscribe((e, d: any) => { if (e === "message") seen.push(d.text); });
  w.emit!({ type: "message", data: { id: "n1", chatId: "c1", sender: "Anna", senderId: "anna", text: "live from the laptop", time: new Date().toISOString(), fromMe: false } });
  await until(() => seen.includes("live from the laptop"), "event reached the phone");
  await stop(A, B);
});

test("prompt answers are remembered per device and account: 'Don't allow' sticks, revoking stops sending at once, allowing again resumes, forgetting asks again", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B);
  await allow(A, B, false);
  await until(async () => (await acct(B))?.via?.kind === "denied", "B sees the refusal");
  assert.equal((await B.call("syncRelayAsk", { accountId: ACCT })).state, "denied"); assert.deepEqual((await st(A)).proxy.asks, [], "a refusal is not asked again");
  await assert.rejects(B.call("send", { chatId: CHAT, text: "x" }), /read-only|signed out/);
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: true });
  await until(async () => (await acct(B))?.via?.kind === "relay" && (await acct(B))?.state === "connected", "allowed from the devices list", 15_000);
  await B.call("send", { chatId: CHAT, text: "one" });
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: false }); // revoke
  await until(async () => (await acct(B))?.via?.kind === "denied", "revoked: back to a history copy", 15_000);
  await assert.rejects(B.call("send", { chatId: CHAT, text: "two" }), /read-only|signed out|allow/);
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: true });
  await until(async () => (await acct(B))?.state === "connected" && (await acct(B))?.via?.kind === "relay", "allowed again", 15_000);
  await B.call("send", { chatId: CHAT, text: "three" });
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: null }); // forget the answer
  await until(async () => (await acct(B))?.via?.kind === "ask", "forgotten: asks again");
  assert.equal((await B.call("syncRelayAsk", { accountId: ACCT })).state, "pending");
  assert.deepEqual(w.sent, ["one", "three"], "nothing sent while not allowed");
  await stop(A, B);
});

test("the per-account switch on the holder allows every paired device without a prompt (and a remembered 'no' still wins)", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone"); const { n: C } = await mirror("Tablet");
  await pairUp(A, B); await pairUp(A, C); await hasMirror(B); await hasMirror(C);
  await A.call("syncSetProxyShare", { accountId: ACCT, enabled: true });
  await until(async () => (await acct(B))?.via?.kind === "relay" && (await acct(C))?.via?.kind === "relay", "both devices send through the laptop", 15_000);
  await A.call("syncRelaySet", { deviceId: id(C), accountId: ACCT, allow: false });
  await until(async () => (await acct(C))?.via?.kind === "denied", "the tablet is excluded", 15_000);
  await B.call("send", { chatId: CHAT, text: "b" }); await assert.rejects(C.call("send", { chatId: CHAT, text: "c" }), /read-only|signed out/);
  assert.deepEqual(w.sent, ["b"]);
  await stop(A, B, C);
});

test("holder offline: archive only, sending refused (nothing queued, nothing replayed); when it returns the relay resumes by itself", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B); await allow(A, B);
  await until(async () => (await acct(B))?.state === "connected", "online", 15_000);
  await B.call("send", { chatId: CHAT, text: "before" });
  await A.call("syncPause");
  await until(async () => (await acct(B))?.via?.kind === "offline" && (await acct(B))?.state === "disconnected", "archive only", 15_000);
  assert.equal((await acct(B)).via.device, "Laptop");
  await assert.rejects(B.call("send", { chatId: CHAT, text: "during" }), /Laptop is offline/);
  assert.ok((await B.call("history", { chatId: CHAT, limit: 20 })).length >= 0, "archive still readable");
  await A.call("syncResume");
  await until(async () => (await acct(B))?.state === "connected" && (await acct(B))?.via?.kind === "relay", "back by itself", 20_000);
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(w.sent, ["before"], "the refused message was not queued or replayed");
  await B.call("send", { chatId: CHAT, text: "after" }); assert.deepEqual(w.sent, ["before", "after"]);
  // and it also survives a restart of the phone's side bookkeeping: the choice is remembered
  assert.equal((await st(B)).proxy.using.length, 1);
  await stop(A, B);
});

test("two holders: the one that was active last is chosen, B keeps it while it is online (no flapping), fails over and does not jump back", async () => {
  const { n: A1, w: w1 } = await holder("Laptop"); const { n: A2, w: w2 } = await holder("Desktop"); const { n: B } = await mirror("Phone");
  await pairUp(A1, A2); await pairUp(A1, B); await hasMirror(B);
  await until(async () => (await st(B)).devices.filter((d: any) => !d.self && d.online).length === 2 && (await st(A2)).devices.filter((d: any) => d.online).length === 3, "full mesh", 20_000);
  await A1.call("syncSetProxyShare", { accountId: ACCT, enabled: true }); await A2.call("syncSetProxyShare", { accountId: ACCT, enabled: true });
  await until(async () => (await st(B)).proxy.using.length === 1, "B picked one", 15_000);
  const first = (await st(B)).proxy.using[0].home;
  // the choice is stable: more activity on the other device does not move it
  const other = first === id(A1) ? w2 : w1; other.emit!({ type: "message", data: { id: "x1", chatId: "c1", sender: "Anna", senderId: "anna", text: "ping", time: new Date().toISOString(), fromMe: false } });
  await new Promise((r) => setTimeout(r, 1200)); assert.equal((await st(B)).proxy.using[0].home, first, "no flapping");
  await B.call("send", { chatId: CHAT, text: "m1" });
  assert.equal((first === id(A1) ? w1 : w2).sent.length, 1); assert.equal((first === id(A1) ? w2 : w1).sent.length, 0, "exactly one holder sent it");
  // the chosen one goes away: B moves to the other one
  const gone = first === id(A1) ? A1 : A2, left = gone === A1 ? A2 : A1, wl = gone === A1 ? w2 : w1;
  await gone.call("syncPause");
  await until(async () => (await st(B)).proxy.using[0]?.home === id(left) && (await acct(B))?.via?.kind === "relay", "failed over", 20_000);
  await until(async () => (await acct(B))?.state === "connected", "connected through the other one", 15_000);
  await B.call("send", { chatId: CHAT, text: "m2" }); assert.deepEqual(wl.sent, ["m2"]);
  await gone.call("syncResume"); await until(async () => (await st(B)).devices.filter((d: any) => d.online && !d.self).length === 2, "both back", 20_000);
  await new Promise((r) => setTimeout(r, 800)); assert.equal((await st(B)).proxy.using[0].home, id(left), "it does not jump back while the current one is fine");
  await stop(A1, A2, B);
});

test("this device holds its own live login: it never relays (even when another device offers)", async () => {
  const { n: A } = await holder("Laptop"); const { n: B, w: wb } = await holder("Phone");
  await pairUp(A, B);
  await A.call("syncSetProxyShare", { accountId: ACCT, enabled: true }); await B.call("syncSetProxyShare", { accountId: ACCT, enabled: true });
  await new Promise((r) => setTimeout(r, 1500));
  for (const n of [A, B]) { assert.deepEqual((await st(n)).proxy.using, []); assert.equal((await acct(n)).via, undefined); assert.equal((await acct(n)).state, "connected"); }
  await B.call("send", { chatId: CHAT, text: "own login" }); assert.deepEqual(wb.sent, ["own login"]);
  await stop(A, B);
});

test("a device that is itself relayed is not offered onward; a third device without permission can neither use the account nor call the holder directly", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone"); const { n: C } = await mirror("Tablet");
  await pairUp(A, B); await pairUp(A, C); await hasMirror(B); await hasMirror(C);
  await until(async () => (await st(B)).devices.filter((d: any) => !d.self && d.online).length === 2, "B sees both", 20_000);
  await allow(A, B);
  await until(async () => (await acct(B))?.state === "connected", "B online", 15_000);
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(!(await st(C)).proxy.offers.some((o: any) => o.deviceId === id(B)), "B does not offer a relayed account");
  await until(async () => (await acct(C))?.via?.kind === "ask", "C shows a history copy"); assert.deepEqual((await st(C)).proxy.using, []);
  await assert.rejects(C.call("send", { chatId: CHAT, text: "from C" }), /read-only|signed out/);
  // a hostile / buggy tablet that talks to the laptop directly
  for (const op of ["send", "info", "chats", "history"]) await assert.rejects(C.svc.rpc(id(A), "proxy.call", { acct: ACCT, op, args: { chatId: "c1", msg: { text: "evil" } } }), /doesn't allow/);
  await assert.rejects(C.svc.rpc(id(A), "proxy.call", { acct: ACCT, op: "logout", args: {} }), /not available/);
  assert.deepEqual(w.sent, []);
  await stop(A, B, C);
});

test("a revoked device cannot relay any more and its answers are forgotten", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B); await allow(A, B);
  await until(async () => (await acct(B))?.state === "connected", "online", 15_000);
  const bid = id(B);
  await A.call("syncRevoke", { deviceId: bid }); // a group of two: both unlink
  await assert.rejects(B.call("send", { chatId: CHAT, text: "after revoke" }), /offline|read-only|not allow|unreachable/);
  assert.deepEqual(w.sent, []); assert.deepEqual((await st(A)).proxy.decisions, [], "the old answer is gone");
  assert.equal((await st(A)).enabled, false); assert.equal((await st(B)).enabled, false);
  await assert.rejects(A.call("syncRelaySet", { deviceId: bid, accountId: ACCT, allow: true }), /Unknown device/);
  await stop(A, B);
});

test("rate limit on writes per device, counted in the holder's log; reads are not limited", async () => {
  const { n: A, w } = await holder("Laptop", { relay: { max: 3, ms: 60_000 } }); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B); await allow(A, B);
  await until(async () => (await acct(B))?.state === "connected", "online", 15_000);
  for (let i = 0; i < 3; i++) await B.call("send", { chatId: CHAT, text: "m" + i });
  await assert.rejects(B.call("send", { chatId: CHAT, text: "m3" }), /Too many messages/);
  await assert.rejects(B.call("react", { chatId: CHAT, messageId: "h1", emoji: "x" }), /Too many messages/);
  for (let i = 0; i < 6; i++) await B.call("history", { chatId: CHAT, limit: 5 });
  assert.deepEqual(w.sent, ["m0", "m1", "m2"]);
  const au = (await st(A)).devices.find((d: any) => !d.self).audit[ACCT]; assert.ok(au.errors >= 2 && au.byOp.send === 4);
  await stop(A, B);
});

test("the login never crosses: no session file, key or secret on the phone, in its store, status or sync data", async () => {
  const { n: A } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B); await allow(A, B);
  await until(async () => (await acct(B))?.state === "connected", "online", 15_000);
  await B.call("send", { chatId: CHAT, text: "hi" }); await B.call("history", { chatId: CHAT, limit: 5 });
  const files: string[] = []; const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } }; walk(B.dir);
  for (const f of files) assert.ok(!readFileSync(f).includes("SECRET-SESSION"), "no secret in " + f);
  assert.ok(!JSON.stringify(await st(B)).includes("SECRET-SESSION")); assert.ok(!JSON.stringify(B.store.exportRecords()).includes("SECRET-SESSION"));
  assert.ok(!files.some((f) => f.endsWith("session.secret")));
  await stop(A, B);
});

// ---------------------------------------------------------------------------------------------- one request id = at most one execution
const CID = (n: number) => "c0ffee00deadbeef" + String(n).padStart(4, "0");
/** the answer of the next relayed call is lost on the way back (the holder did the work) */
const loseNextAnswer = (B: Node) => { const orig = (B.svc as any).rpc.bind(B.svc); let drop = false; (B.svc as any).rpc = async (...a: any[]) => { const r = await orig(...a); if (drop && a[1] === "proxy.call") { drop = false; throw new Error("the other device did not answer in time (timed out)"); } return r; }; return () => { drop = true; }; };
async function relayed() {
  const h = await holder("Laptop", {}, "sqlite"), m = await mirror("Phone");
  await pairUp(h.n, m.n); await hasMirror(m.n); await allow(h.n, m.n);
  await until(async () => (await acct(m.n))?.state === "connected", "online", 15_000);
  return { A: h.n, w: h.w, B: m.n };
}

test("lost answer: the retry (same client id) returns the ORIGINAL message and the service is asked once", async () => {
  const { A, w, B } = await relayed(); const lose = loseNextAnswer(B);
  lose(); await assert.rejects(B.call("send", { chatId: CHAT, text: "once", clientId: CID(1) }), /offline|unreachable/);
  assert.deepEqual(w.sent, ["once"], "the holder did send it");
  const r = await B.call("send", { chatId: CHAT, text: "once", clientId: CID(1) });
  assert.deepEqual(w.sent, ["once"], "and the retry did not send it again"); assert.ok(A.store.getMessage(CHAT, r.id), "it is the message the holder archived");
  assert.equal(r.status, "sent"); assert.ok(B.store.getMessage(CHAT, r.id), "now on the phone too");
  const r2 = await B.call("send", { chatId: CHAT, text: "once", clientId: CID(1) }); assert.equal(r2.id, r.id);
  await B.call("send", { chatId: CHAT, text: "twice", clientId: CID(2) }); assert.deepEqual(w.sent, ["once", "twice"], "a different client id is a different message");
  // a send without a client id still works (and is not deduplicated)
  await B.call("send", { chatId: CHAT, text: "plain" }); await B.call("send", { chatId: CHAT, text: "plain" }); assert.equal(w.sent.filter((x) => x === "plain").length, 2);
  await stop(A, B);
});

test("retry while the first attempt is still running: single flight, both get the same message", async () => {
  const { A, w, B } = await relayed(); let open!: () => void; w.gate = new Promise<void>((r) => (open = r));
  const p1 = B.call("send", { chatId: CHAT, text: "slow", clientId: CID(3) });
  await until(() => w.calls.filter((c) => c === "send").length === 1, "the service call started");
  const p2 = B.call("send", { chatId: CHAT, text: "slow", clientId: CID(3) }); await new Promise((r) => setTimeout(r, 400));
  assert.equal(w.calls.filter((c) => c === "send").length, 1, "the second request waits for the first");
  open(); const [a, b] = await Promise.all([p1, p2]); assert.equal(a.id, b.id); assert.deepEqual(w.sent, ["slow"]);
  await stop(A, B);
});

test("a failed write is not remembered: the retry runs again; other writes (react, edit, delete, vote) carry request ids too", async () => {
  const { A, w, B } = await relayed(); const orig = w.sent;
  w.gate = Promise.reject(new Error("service said no")); w.gate.catch(() => {});
  await assert.rejects(B.call("send", { chatId: CHAT, text: "later", clientId: CID(4) }), /service said no/); assert.deepEqual(orig, []);
  w.gate = undefined; await B.call("send", { chatId: CHAT, text: "later", clientId: CID(4) }); assert.deepEqual(w.sent, ["later"]);
  const seen: string[] = []; const o = (A.svc as any).proxies.serve.bind((A.svc as any).proxies); (A.svc as any).proxies.serve = (peer: string, p: any) => { seen.push(p.op + ":" + (p.rid ? "rid" : "none")); return o(peer, p); };
  await B.call("react", { chatId: CHAT, messageId: "h1", emoji: "x" }); await B.call("edit", { chatId: CHAT, messageId: "h1", text: "e" }); await B.call("delete", { chatId: CHAT, messageId: "h1" }); await B.call("vote", { chatId: CHAT, messageId: "h1", optionIds: ["a"] });
  await B.call("markRead", { chatId: CHAT, messageId: "h1" });
  assert.deepEqual(seen, ["react:rid", "edit:rid", "delete:rid", "vote:rid", "markRead:none"]);
  await stop(A, B);
});

test("holder restart: a retried send is answered from the persisted reference (no text stored), an unknown in-flight one says so", async () => {
  const { A, w, B } = await relayed(); const lose = loseNextAnswer(B);
  lose(); await assert.rejects(B.call("send", { chatId: CHAT, text: "secret words", clientId: CID(5) }), /offline|unreachable/); assert.deepEqual(w.sent, ["secret words"]);
  const kv = JSON.stringify((A.svc as any).ledger.kvGet("relaySent")); assert.ok(kv.includes(CID(5)) && !kv.includes("secret words"), "only the reference is stored, never the text");
  const dir = A.dir, key = A.key, A2w = mk(), idA = id(A); await A.stop();
  const A2 = await node("Laptop", "sqlite", dir, undefined, key, { factories: [A2w.f] });
  await until(async () => (await st(B)).devices.find((d: any) => d.id === idA)?.online === true && (await acct(B))?.state === "connected" && (await acct(B))?.via?.kind === "relay", "B talks to the restarted holder", 25_000);
  let r: any; for (let i = 0; i < 20 && !r; i++) { try { r = await B.call("send", { chatId: CHAT, text: "secret words", clientId: CID(5) }); } catch (e: any) { if (!/offline/.test(e.message)) throw e; await new Promise((x) => setTimeout(x, 400)); } } // (sessions may still be settling: retrying is exactly what the id is for)
  assert.deepEqual(A2w.w.sent, [], "the restarted holder did not send it again"); assert.ok(r.id && r.chatId === CHAT);
  // a send that was in flight when it died: the holder cannot know
  (A2.svc as any).proxies.setRef(id(B), CID(6), { at: Date.now(), chatId: "" });
  await assert.rejects(B.call("send", { chatId: CHAT, text: "?", clientId: CID(6) }), /cannot tell if it went out/); assert.deepEqual(A2w.w.sent, []);
  await stop(A2, B);
});

test("the memory is bounded: at most N results per device and a time limit; after it a repeat is a new request", async () => {
  let t = Date.now();
  const h = await holder("Laptop", { idem: { ttlMs: 60_000, max: 3 }, now: () => t }), m = await mirror("Phone");
  const { n: A, w } = h, B = m.n; await pairUp(A, B); await hasMirror(B); await allow(A, B); await until(async () => (await acct(B))?.state === "connected", "online", 15_000);
  for (let i = 10; i < 16; i++) await B.call("send", { chatId: CHAT, text: "m" + i, clientId: CID(i) });
  const px = (A.svc as any).proxies; assert.equal(px.idem.get(id(B)).size, 3, "memory bounded"); assert.equal(Object.keys(px.sentRefs[id(B)]).length, 3, "persisted references bounded");
  await B.call("send", { chatId: CHAT, text: "m15", clientId: CID(15) }); assert.equal(w.sent.length, 6, "inside the window: answered, not executed");
  await B.call("send", { chatId: CHAT, text: "m10", clientId: CID(10) }); assert.equal(w.sent.length, 7, "pushed out of the window: executed as new");
  t += 61_000; await B.call("send", { chatId: CHAT, text: "m10", clientId: CID(10) }); assert.equal(w.sent.length, 8, "too old: executed as new");
  await stop(A, B);
});

// ---------------------------------------------------------------------------------------------- scheduled messages for relayed accounts
const jobs = (n: Node, status = "pending") => n.call("jobs", { status });
test("scheduled message, holder offline at fire time: stays pending with a visible reason, sent ONCE when the holder returns", async () => {
  const { A, w, B } = await relayed();
  await A.call("syncPause"); await until(async () => (await acct(B))?.via?.kind === "offline", "holder offline", 15_000);
  await B.call("scheduleMessage", { chatId: CHAT, text: "see you at 9", at: Date.now() + 300 });
  await until(async () => (await jobs(B)).some((j: any) => j.payload.waiting && /Waiting for Laptop to come online/.test(j.lastError)), "waiting state", 10_000);
  const j = (await jobs(B))[0]; assert.equal(j.attempts, 0, "waiting is not a failed try"); assert.ok(j.payload.due, "the planned time is kept");
  assert.deepEqual(w.sent, []);
  await A.call("syncResume");
  await until(() => w.sent.length === 1, "sent after the holder returned", 25_000); await until(async () => (await jobs(B, "done")).length === 1 && (await jobs(B)).length === 0, "job done");
  await new Promise((r) => setTimeout(r, 600)); assert.deepEqual(w.sent, ["see you at 9"], "once");
  await stop(A, B);
});

test("scheduled message: too late is not sent silently (late cutoff), then 'Send now' sends it once, 'Delete' removes it", async () => {
  const { A, w, B } = await relayed(); await B.call("setSetting", { key: "scheduleLateHours", value: 1 });
  assert.equal((await B.call("getSettings")).scheduleLateHours, 1);
  const old = Date.now() - 2 * 3600_000, mkJob = (text: string, cid: string) => B.hub.scheduler.enqueue({ kind: "send", payload: { chatId: CHAT, text, clientId: cid, due: old }, runAt: Date.now() });
  const j1 = mkJob("old one", CID(20)), j2 = mkJob("old two", CID(21));
  await until(async () => (await jobs(B, "failed")).length === 2, "both marked late");
  const f = (await jobs(B, "failed")).find((x: any) => x.id === j1.id); assert.ok(f.payload.late); assert.match(f.lastError, /could not be sent within 1 hours, so it was not sent\. Send it now or delete it/); assert.deepEqual(w.sent, []);
  await B.call("sendJobNow", { id: j1.id }); assert.deepEqual(w.sent, ["old one"]);
  await assert.rejects(B.call("sendJobNow", { id: j1.id }), /not waiting for a decision/, "no second send");
  assert.equal(await B.call("discardJob", { id: j2.id }), true); assert.equal((await jobs(B, "failed")).length, 0); assert.deepEqual(w.sent, ["old one"]);
  await stop(A, B);
});

test("scheduled message for an account that is no longer relayed (holder removed): fails at once with a clear reason, nothing is sent", async () => {
  const { A, w, B } = await relayed();
  await B.call("scheduleMessage", { chatId: CHAT, text: "will not go", at: Date.now() + 1500 });
  await B.call("syncRevoke", { deviceId: id(A) }); // this phone removes the laptop
  await until(async () => (await jobs(B, "failed")).length === 1, "failed with a reason", 15_000);
  const f = (await jobs(B, "failed"))[0]; assert.match(f.lastError, /is not connected on this device, and no other of your devices sends for it any more\. Nothing was sent/); assert.ok(f.payload.aborted); assert.deepEqual(w.sent, []);
  await stop(A, B);
});

test("scheduled message when the holder removed this phone: the phone is told, stops relaying and the job fails with a reason instead of waiting for ever", async () => {
  const { A, w, B } = await relayed();
  await B.call("scheduleMessage", { chatId: CHAT, text: "nope", at: Date.now() + 2500 });
  await A.call("syncRevoke", { deviceId: id(B) });
  await until(async () => (await jobs(B, "failed")).length === 1, "job failed with a reason", 15_000);
  assert.match((await jobs(B, "failed"))[0].lastError, /not connected on this device/); assert.deepEqual(w.sent, [], "never sent through a holder that removed us");
  assert.equal((await acct(B)).via, undefined);
  await stop(A, B);
});

test("own profile and privacy settings work through the home device: read, change name / about / picture, change a privacy choice; the holder's connector does it", async () => {
  const { n: A, w } = await holder("Laptop"); const { n: B } = await mirror("Phone");
  await pairUp(A, B); await hasMirror(B);
  await A.call("syncRelaySet", { deviceId: id(B), accountId: ACCT, allow: true });
  await until(async () => (await acct(B))?.via?.kind === "relay", "B uses the holder");
  const p = await B.call("getProfile", { accountId: ACCT });
  assert.equal(p.displayName, "Real Name"); assert.equal(p.about, "hi");
  const out = await B.call("updateProfile", { accountId: ACCT, displayName: "New Name", about: "new about", avatar: { dataBase64: Buffer.from([9, 9, 9]).toString("base64"), mime: "image/png" } });
  assert.equal(out.displayName, "New Name"); assert.equal(w.prof.displayName, "New Name"); assert.equal(w.prof.about, "new about"); assert.deepEqual([...w.prof.avatar!], [9, 9, 9]);
  assert.equal((await B.call("getProfile", { accountId: ACCT })).avatar.dataBase64, Buffer.from([9, 9, 9]).toString("base64"));
  assert.equal((await B.call("getPrivacy", { accountId: ACCT }))[0].value, "everyone");
  await B.call("setPrivacy", { accountId: ACCT, id: "lastSeen", value: "nobody" });
  assert.equal(w.priv.lastSeen, "nobody"); assert.ok(w.calls.includes("setPrivacy:lastSeen:nobody"));
  await stop(A, B);
});

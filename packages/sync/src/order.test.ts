// Priority order of the device sync: the small global state (accounts, settings, folders) arrives BEFORE the message backlog, however late it was written.
import test from "node:test";
import assert from "node:assert/strict";
import { converged, msg, node, pairUp, until } from "./testkit.js";

const NO_SNAP = { snapshot: { minEntities: 1e9, minEntitiesEmpty: 1e9 } };

test("an account written after 2500 messages still arrives first; pause/resume mid-backlog is idempotent", async () => {
  const chat = "fake-aaaa:c1", N = 2500;
  const A = await node("A", "memory", undefined, (s) => {
    s.putAccount({ id: "fake-aaaa", provider: "fake", label: "Work", status: "active" });
    const ms = []; for (let i = 0; i < N; i++) ms.push(msg(chat, "m" + i, "text " + i, new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString()));
    s.putMessages(ms);
  }, undefined, { opts: NO_SNAP });
  A.store.putAccount({ id: "fake-late", provider: "fake", label: "Added last", status: "active" }); // highest sequence number of the whole ledger
  A.store.setSetting("railOrder", '["x"]'); A.store.putFolder({ id: "folder:1", name: "Fam" });
  const B = await node("B", "sqlite");
  const order: string[] = []; let msgApplied = 0;
  const orig = B.store.applyRemote.bind(B.store);
  B.store.applyRemote = async (entries, src) => {
    const kinds = new Set(entries.map((e) => e.k.split("\u0001")[0])); order.push([...kinds].sort().join("+"));
    const r = await orig(entries, src); msgApplied += entries.filter((e) => e.k.startsWith("msg\u0001")).length; return r;
  };
  const prog: any[] = []; B.hub.subscribe(((e: string, d: any) => { if (e === "sync-progress" && d?.accts) prog.push(d); }) as any);
  await pairUp(A, B);
  await until(() => B.store.listAccounts().some((a) => a.id === "fake-late"), "late account");
  const iAcc = order.findIndex((k) => k.includes("ac")), iMsg = order.findIndex((k) => k.includes("msg"));
  assert.ok(iAcc >= 0 && (iMsg < 0 || iAcc < iMsg), "accounts applied before the first message batch: " + order.slice(0, 5).join(" | "));
  assert.equal(B.store.getSetting("railOrder"), '["x"]');
  assert.ok(B.store.listFolders().some((f) => f.id === "folder:1"));
  await until(() => !!B.store.getMessage(chat, "m" + (N - 1)), "newest message arrives early (head batch)", 20000);
  await B.call("syncPause"); const mid = msgApplied; await new Promise((r) => setTimeout(r, 200));
  A.store.putAccount({ id: "fake-two", provider: "fake", label: "Two", status: "active" });
  await B.call("syncResume");
  await until(() => converged(A, B) && B.store.listAccounts().some((a) => a.id === "fake-two"), "full convergence after resume", 60000);
  assert.ok(mid <= N + 700, "no duplicate storm"); void mid;
  assert.equal(Number((B.svc as any).ledger.countClass(0, true)), N, "exactly N message rows");
  const cur: any = Object.values((B.svc as any).ledger.kvGet("cursors"))[0]; assert.ok(cur.g > 0 && cur.applied > 0, "both class cursors are persisted");
  assert.ok(prog.some((p) => p.accts.total > 0 && p.chats.total >= N - 1), "phase counters are reported");
  await A.stop(); await B.stop();
});

// Names of merged chats (alias on a merge id, with emoji) must reach the other device exactly.
import test from "node:test";
import assert from "node:assert/strict";
import { node, pairUp, until } from "./testkit.js";

test("alias of a merged chat (emoji + variation selector) replicates exactly, and survives a later rename", async () => {
  const A = await node("A", "memory", undefined, (s) => {
    s.putAccount({ id: "fake-aaaa", provider: "fake", label: "Work", status: "active" });
    s.putAccount({ id: "fake-bbbb", provider: "fake", label: "Home", status: "active" });
  });
  const B = await node("B", "memory");
  await pairUp(A, B);
  const M = "merge:11111111-2222-3333-4444-555555555555";
  A.store.putMerge({ id: M, members: ["fake-aaaa:lena", "fake-bbbb:lena"], primary: "fake-aaaa:lena", createdAt: "2026-01-01T00:00:00Z" });
  A.store.setAlias(M, "Lena ♥️");
  await until(() => B.store.listMerges().some((m) => m.id === M), "merge arrives");
  await until(() => B.store.listAliases()[M] !== undefined, "alias arrives");
  assert.equal(B.store.listAliases()[M], "Lena ♥️");
  A.store.setAlias(M, "Lena 💜");
  await until(() => B.store.listAliases()[M] === "Lena 💜", "renamed alias arrives");
  for (const n of [A, B]) await n.stop();
});

test("the list of chats created by a history import replicates (so a paired device has the chat rows, not only the messages)", async () => {
  const A = await node("A", "memory", undefined, (s) => { s.putAccount({ id: "signal-aaaa", provider: "signal", label: "Signal", status: "active" }); });
  const B = await node("B", "memory");
  await pairUp(A, B);
  const key = "signalImport.chats.signal-aaaa", val = JSON.stringify({ "signal-aaaa:u1": { id: "u1", name: "Julian" } });
  A.store.setSetting(key, val);
  await until(() => B.store.getSetting(key) === val, "imported chat list arrives");
  A.store.setSetting("some.local.only", "x");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(B.store.getSetting("some.local.only"), undefined, "other settings stay local");
  for (const n of [A, B]) await n.stop();
});

test("groups of communities in the rail and the user's chat categories replicate", async () => {
  const A = await node("A", "memory"), B = await node("B", "memory");
  await pairUp(A, B);
  const groups = JSON.stringify([{ id: "grp1", name: "Work", color: "#3b82f6", members: ["discord-x:g1", "mattermost-y:t1"] }]);
  A.store.setSetting("railGroups", groups);
  A.store.setSetting("userCategories", JSON.stringify([{ id: "cat1", name: "Hiking" }]));
  A.store.setSetting("chatCategories", JSON.stringify({ "wa-1:anna": "cat1" }));
  await until(() => B.store.getSetting("railGroups") === groups, "rail groups arrive");
  await until(() => !!B.store.getSetting("userCategories") && !!B.store.getSetting("chatCategories"), "categories arrive");
  for (const n of [A, B]) await n.stop();
});

test("a synced setting that already had a value before it became syncable is registered once, so an already-paired device receives it", async () => {
  const A = await node("A", "memory"), B = await node("B", "memory");
  await pairUp(A, B);
  const v = JSON.stringify([{ id: "grp9", name: "Old group", members: ["discord-x:g9"] }]);
  (A.store as any).inner.setSetting("railGroups", v); // written without touching the ledger, like a value from before the key was syncable
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(B.store.getSetting("railGroups"), undefined, "not synced yet");
  A.store.adoptSettings();
  await until(() => B.store.getSetting("railGroups") === v, "adopted setting arrives");
  A.store.adoptSettings(); // idempotent
  for (const n of [A, B]) await n.stop();
});

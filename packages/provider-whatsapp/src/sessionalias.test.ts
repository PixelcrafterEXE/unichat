import test from "node:test";
import assert from "node:assert/strict";
import { aliasSessions, canonicalSessionId, userMap } from "./sessionalias.js";

const mem = (init: Record<string, unknown> = {}) => {
  const d: Record<string, unknown> = { ...init };
  return { d, store: { get: async (_t: string, ids: string[]) => Object.fromEntries(ids.filter((i) => d[i]).map((i) => [i, d[i]])), set: async (x: any) => { for (const grp of [x.session ?? {}, x["sender-key"] ?? {}]) for (const [k, v] of Object.entries(grp)) { if (v === null) delete d[k]; else d[k] = v; } } } as any };
};
const map = userMap({ lidToPn: { "111@lid": "491@s.whatsapp.net" }, own: { pn: "4917@s.whatsapp.net", lid: "222@lid" } });

test("canonical form", () => {
    assert.equal(canonicalSessionId("111.0", map), "491.0");
    assert.equal(canonicalSessionId("222.3", map), "4917.3");
    assert.equal(canonicalSessionId("999.0", map), "999.0");
});
test("a session written under the PN address is found under the LID address", async () => {
    const m = mem(), s = aliasSessions(m.store, () => map);
    await s.set({ session: { "491.0": Buffer.from("x") } } as any);
    assert.deepEqual(Object.keys(await s.get("session", ["111.0"])), ["111.0"]);
});
test("a legacy record under the LID form is still read, and moves on write", async () => {
    const m = mem({ "111.0": Buffer.from("old") }), s = aliasSessions(m.store, () => map);
    assert.equal(((await s.get("session", ["111.0"])) as any)["111.0"].toString(), "old");
    await s.set({ session: { "111.0": Buffer.from("new") } } as any);
    assert.equal((m.d["491.0"] as Buffer).toString(), "new"); assert.equal(m.d["111.0"], undefined);
});
test("other key types and unknown ids pass through", async () => {
    const m = mem({ "999.0": 1 }), s = aliasSessions(m.store, () => map);
    assert.deepEqual(Object.keys(await s.get("session", ["999.0"])), ["999.0"]);
});

test("group sender keys: a key stored under the PN form is found under the LID form, and a legacy LID-form key still reads", async () => {
  const m = mem(), s = aliasSessions(m.store, () => map);
  await (s.set as any)({ "sender-key": { "123@g.us::491::0": Buffer.from("k") } });
  assert.deepEqual(Object.keys(await s.get("sender-key" as any, ["123@g.us::111::0"])), ["123@g.us::111::0"]);
  const m2 = mem({ "123@g.us::111::0": Buffer.from("old") }), s2 = aliasSessions(m2.store, () => map);
  assert.equal(((await s2.get("sender-key" as any, ["123@g.us::111::0"])) as any)["123@g.us::111::0"].toString(), "old");
  await (s2.set as any)({ "sender-key": { "123@g.us::111::0": Buffer.from("new") } });
  assert.equal((m2.d["123@g.us::491::0"] as Buffer).toString(), "new"); assert.equal(m2.d["123@g.us::111::0"], undefined);
});

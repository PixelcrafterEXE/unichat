// Offline tests for the optional-permission features of the Teams provider: own profile, creating a team. Fake Entra + Graph only.
import test from "node:test";
import assert from "node:assert/strict";
import factory from "./index.js";
import { loadSession } from "./secret.js";
import { CLIENT_ID } from "./fake-server.js";
import { waitFor, setup } from "./helpers.js";

const png = { data: new Uint8Array([137, 80, 78, 71, 1]), mime: "image/png" };
const withWrite = (f: any) => { f.scope += " User.ReadWrite Team.Create"; };

test("login: the profile and create-teams boxes add their scopes; both are optional and off by default", async () => {
  const s = await setup(factory, { noSession: true, fake: { pendingPolls: 0 } });
  try {
    await waitFor(() => s.of("login").length > 0);
    const form = s.of("login")[0];
    const names = form.fields.map((f: any) => f.name); assert.ok(names.includes("profile") && names.includes("create"));
    for (const n of ["profile", "create"]) assert.ok(!form.fields.find((f: any) => f.name === n).required);
    await s.conn.submitLogin(form.promptId, { client_id: CLIENT_ID, tenant: "", profile: "true", create: "true" });
    await waitFor(s.connected);
    assert.match(loadSession(s.dir)!.scope, /User\.ReadWrite/); assert.match(loadSession(s.dir)!.scope, /Team\.Create/);
  } finally { await s.close(); }
  const t = await setup(factory, { noSession: true, fake: { pendingPolls: 0 } });
  try {
    await waitFor(() => t.of("login").length > 0);
    await t.conn.submitLogin(t.of("login")[0].promptId, { client_id: CLIENT_ID });
    await waitFor(t.connected);
    assert.doesNotMatch(loadSession(t.dir)!.scope, /ReadWrite\b.*User|User\.ReadWrite|Team\.Create/);
  } finally { await t.close(); }
});

test("capabilities follow the granted permissions: without them no profile editing and no team creation", async () => {
  const s = await setup(factory);
  try {
    await waitFor(s.connected);
    assert.equal(s.conn.capabilities.createSpace, false); assert.deepEqual(s.conn.capabilities.profile, { displayName: false, about: false, avatar: false });
    await assert.rejects(s.conn.updateProfile({ about: "x" }), /User\.ReadWrite/); await assert.rejects(s.conn.createSpace("Team"), /Team\.Create/);
    assert.equal(s.fake.hits.filter((h) => /^(PATCH|PUT) \/me|POST \/teams$/.test(h)).length, 0, "nothing is sent without the permission");
  } finally { await s.close(); }
  const w = await setup(factory, { prep: withWrite });
  try {
    await waitFor(w.connected);
    assert.equal(w.conn.capabilities.createSpace, true); assert.deepEqual(w.conn.capabilities.profile, { about: true, avatar: true });
  } finally { await w.close(); }
});

test("profile: picture and about text are written, name and removal are refused, bad pictures too", async () => {
  const s = await setup(factory, { prep: withWrite });
  try {
    await waitFor(s.connected); const F = s.fake;
    const out = await s.conn.updateProfile({ about: "  Climber  ", avatar: png });
    assert.equal(F.about, "Climber"); assert.deepEqual(F.photoPuts, ["image/png"]);
    assert.equal(out.about, "Climber"); assert.equal(out.avatar.mime, "image/png");
    await assert.rejects(s.conn.updateProfile({ displayName: "New" }), /managed by your organisation/);
    await assert.rejects(s.conn.updateProfile({ avatar: null }), /cannot remove/);
    await assert.rejects(s.conn.updateProfile({ avatar: { data: png.data, mime: "image/gif" } }), /JPEG or PNG/);
    await assert.rejects(s.conn.updateProfile({ avatar: { data: new Uint8Array(4_300_000), mime: "image/png" } }), /too large/);
    assert.equal(F.photoPuts.length, 1);
  } finally { await s.close(); }
});

test("create a team: 202, follows the async operation, the team appears as a space with its channels", async () => {
  const s = await setup(factory, { prep: withWrite, env: { UNIMSG_TEAMS_OP_MS: "10" } });
  try {
    await waitFor(s.connected); const F = s.fake; F.opsPending = 2;
    const sp = await s.conn.createSpace("  Climbing  ", "weekend plans");
    assert.equal(sp.name, "Climbing");
    const b = F.bodies.find((x: any) => x.path === "POST /teams")!.body;
    assert.deepEqual([b.displayName, b.description, b["template@odata.bind"]], ["Climbing", "weekend plans", "https://graph.microsoft.com/v1.0/teamsTemplates('standard')"]);
    assert.ok(F.hits.filter((h) => /\/operations\//.test(h)).length >= 3, "polled the operation until it succeeded");
    assert.ok((await s.conn.spaces()).some((x: any) => x.id === sp.id));
    assert.ok((await s.conn.chats()).some((c: any) => c.spaceId === sp.id), "its General channel is listed");
    assert.ok(s.of("spaces-changed").length >= 1);
    await assert.rejects(s.conn.createSpace("   "), /1 to 256/);
  } finally { await s.close(); }
});

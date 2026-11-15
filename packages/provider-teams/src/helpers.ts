import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { CLIENT_ID, FakeTeams, TENANT_ID, type FakeOpts } from "./fake-server.js";
import { saveSession } from "./secret.js";

export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 15));
  if (!f()) throw new Error("timeout waiting for " + what);
}

export const ME = "aaaaaaaa-0000-4000-8000-000000000001", ALICE = "aaaaaaaa-0000-4000-8000-000000000002", BOB = "aaaaaaaa-0000-4000-8000-000000000003";
export const C = { dm: "19:dm-alice@unq.gbl.spaces", group: "19:grp-1@thread.v2", meeting: "19:meeting_1@thread.v2" };
export const T1 = "bbbbbbbb-0000-4000-8000-000000000001";
export const CH = { general: "19:general@thread.tacv2", secret: "19:secret@thread.tacv2", shared: "19:shared@thread.tacv2" };
export const CHAN = { general: `${T1}/${CH.general}`, secret: `${T1}/${CH.secret}`, shared: `${T1}/${CH.shared}` };

/** A small world: 3 people, a 1:1 chat, a group chat, a meeting chat, one team with three channels. Seed messages are 1 h in the past. */
export function world(f: FakeTeams) {
  f.me = ME;
  f.user(ME, "Me Myself", "me@example.test"); f.user(ALICE, "Alice Wonder", "alice@example.test"); f.user(BOB, "Bob Builder", "bob@example.test");
  f.chat(C.dm, "oneOnOne", [ME, ALICE]);
  f.chat(C.group, "group", [ME, ALICE, BOB]);
  f.chat(C.meeting, "meeting", [ME, ALICE, BOB], "Weekly Standup");
  f.team(T1, "Engineering", [
    { id: CH.general, displayName: "General", membershipType: "standard", description: "Everything" },
    { id: CH.secret, displayName: "Leads", membershipType: "private" },
    { id: CH.shared, displayName: "Partner", membershipType: "shared" },
  ]);
  f.say(C.dm, ALICE, "<p>Hello <b>Me</b></p>");
  return f;
}

export const env = (f: FakeTeams) => ({
  UNIMSG_TEAMS_GRAPH: f.graph, UNIMSG_TEAMS_AUTH: f.auth, UNIMSG_TEAMS_PACE_MS: "0", UNIMSG_TEAMS_POLL_MS: "40", UNIMSG_TEAMS_DEVICE_POLL_MS: "20",
});

export async function setup(factory: { create(o: { accountId: string; dataDir: string }): any }, o: { fake?: FakeOpts; noSession?: boolean; prep?: (f: FakeTeams) => void; env?: Record<string, string>; dir?: string } = {}) {
  const fake = new FakeTeams(o.fake); await fake.start(); world(fake); o.prep?.(fake);
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "teams-"));
  Object.assign(process.env, env(fake), o.env);
  if (!o.noSession) {
    const t = fake.issue(ME);
    saveSession(dir, { clientId: CLIENT_ID, tenant: "organizations", scope: "openid", refreshToken: t.refresh_token, accessToken: t.access_token, expiresAt: Date.now() + 3600_000, granted: t.scope, userId: ME, tenantId: TENANT_ID });
  }
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: CoreEvent) => ev.push(e));
  const of = <T extends CoreEvent["type"]>(t: T) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => ev.some((e) => e.type === "account" && e.data.state === "connected");
  const close = async () => { await conn.stop(); await fake.close(); };
  return { fake, dir, ev, conn, of, connected, close };
}

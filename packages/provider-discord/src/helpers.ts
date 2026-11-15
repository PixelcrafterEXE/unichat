import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { FakeDiscord, PERM, bits, type FakeOpts } from "./fake-server.js";
import { saveSession } from "./secret.js";

export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error("timeout waiting for " + what);
}

export const ME = "8000000000000001", ALICE = "1000000000000001", BOB = "1000000000000002", G1 = "100000000000001";
export const C = { cat: "200000000000001", general: "200000000000002", announce: "200000000000003", secret: "200000000000004", voice: "200000000000005", forum: "200000000000006", thread: "200000000000007", post: "200000000000008", dm: "200000000000009", gdm: "200000000000010" };

/** A small world: one guild (category, text, announcement, hidden channel, voice, forum + post, thread), a DM and a group DM. */
export function world(f: FakeDiscord) {
  f.user(ME, "meuser", "Me Myself"); f.user(ALICE, "alice", "Alice Wonder"); f.user(BOB, "bob");
  f.token("bot-good", "bot", ME); f.token("user-good", "user", ME);
  const g = f.guild(G1, "Test Guild", ALICE, [{ id: "300000000000001", name: "Moderators", permissions: "0" }]);
  g.emojis = [{ id: "555000000000001", name: "party", animated: false }, { id: "555000000000002", name: "dance", animated: true }] as any;
  f.member(G1, ME, []); f.member(G1, ALICE, ["300000000000001"], "Ally"); f.member(G1, BOB, []);
  const ev = G1; // @everyone overwrite id == guild id
  f.channel({ id: C.cat, type: 4, guild_id: G1, name: "Text Channels", position: 0 });
  f.channel({ id: C.general, type: 0, guild_id: G1, name: "general", topic: "Talk here", parent_id: C.cat });
  f.channel({ id: C.announce, type: 5, guild_id: G1, name: "announcements", parent_id: C.cat, permission_overwrites: [{ id: ev, type: 0, allow: "0", deny: bits(PERM.SEND) }] });
  f.channel({ id: C.secret, type: 0, guild_id: G1, name: "staff-only", permission_overwrites: [{ id: ev, type: 0, allow: "0", deny: bits(PERM.VIEW) }] });
  f.channel({ id: C.voice, type: 2, guild_id: G1, name: "Voice" });
  f.channel({ id: C.forum, type: 15, guild_id: G1, name: "ideas" });
  f.channel({ id: C.thread, type: 11, guild_id: G1, name: "side-talk", parent_id: C.general, thread_metadata: { archived: false } });
  f.channel({ id: C.post, type: 11, guild_id: G1, name: "Dark mode?", parent_id: C.forum, thread_metadata: { archived: false } });
  f.channel({ id: C.dm, type: 1, recipients: [f.users.get(ALICE)!] });
  f.channel({ id: C.gdm, type: 3, name: undefined, recipients: [f.users.get(ALICE)!, f.users.get(BOB)!] });
  return f;
}

export async function setup(factory: { create(o: { accountId: string; dataDir: string }): any }, o: { mode?: "bot" | "user"; fake?: FakeOpts; noSession?: boolean; prep?: (f: FakeDiscord) => void; env?: Record<string, string>; token?: string } = {}) {
  const fake = new FakeDiscord(o.fake); await fake.start(); world(fake); o.prep?.(fake);
  const dir = mkdtempSync(join(tmpdir(), "dc-"));
  Object.assign(process.env, { UNIMSG_DISCORD_BASE: fake.url, UNIMSG_DISCORD_GATEWAY: fake.wsUrl, UNIMSG_DISCORD_CDN: fake.url + "/cdn", UNIMSG_DISCORD_PACE_MS: "0", UNIMSG_DISCORD_GW_FAST: "1" }, o.env);
  const mode = o.mode ?? "bot";
  if (!o.noSession) saveSession(dir, { mode, token: o.token ?? (mode === "bot" ? "bot-good" : "user-good"), userId: ME });
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: CoreEvent) => ev.push(e));
  const of = <T extends CoreEvent["type"]>(t: T) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => ev.some((e) => e.type === "account" && e.data.state === "connected");
  /** connected and the guild (bot: GUILD_CREATE after READY) has arrived */
  const loaded = async () => {
    await waitFor(connected, 8000, "connected");
    const t = Date.now();
    for (;;) {
      try { const ids = (await conn.chats()).map((c: any) => c.id); if (ids.includes(C.general) && !ids.includes(C.secret)) break; } catch { /* not ready */ }
      if (Date.now() - t > 6000) throw new Error("timeout waiting for the world to load");
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150));
  };
  return { fake, dir, ev, conn, of, connected, loaded, close: async () => { await conn.stop(); await fake.close(); } };
}

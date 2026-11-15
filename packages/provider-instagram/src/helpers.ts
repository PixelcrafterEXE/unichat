import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { FakeIG, type FakeOpts } from "./fake-server.js";

export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error("timeout waiting for " + what);
}
/** Log in against the fake with the real flow unless `noSession`; `presession` writes a session as an earlier run would have. */
export async function setup(factory: { create(o: { accountId: string; dataDir: string }): any }, o: { fake?: FakeOpts; noSession?: boolean; dir?: string; prep?: (f: FakeIG) => void; env?: Record<string, string> } = {}) {
  const fake = new FakeIG(o.fake); await fake.start(); o.prep?.(fake);
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "ig-"));
  Object.assign(process.env, { UNIMSG_IG_BASE: fake.url, UNIMSG_IG_MQTT: fake.wsUrl, UNIMSG_IG_PACE_MS: "0", UNIMSG_IG_POLL_MS: "60000", UNIMSG_IG_RT_RETRY_MS: "150", UNIMSG_IG_NO_REALTIME: "0" }, o.env);
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  if (!o.noSession) { // pretend an earlier run logged in: reuse the fake's token
    fake.tokens.add((fake as any).authToken);
    writeFileSync(join(dir, "instagram-session.json"), JSON.stringify({ authorization: (fake as any).authToken, userId: "1000", username: "fakeme", mid: "MID-SECRET" }), { mode: 0o600 });
  }
  await conn.start((e: CoreEvent) => ev.push(e));
  const of = <T extends CoreEvent["type"]>(t: T) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => ev.some((e) => e.type === "account" && e.data.state === "connected");
  return { fake, dir, ev, conn, of, connected, close: async () => { await conn.stop(); await fake.close(); } };
}
export const LOGIN = { username: "fakeme", password: "fakepw", confirm: "YES" };

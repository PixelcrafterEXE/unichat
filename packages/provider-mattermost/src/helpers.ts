import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { FakeMM, type FakeOpts } from "./fake-server.js";

export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error("timeout waiting for " + what);
}
export async function setup(factory: { create(o: { accountId: string; dataDir: string }): any }, o: { fake?: FakeOpts; token?: string; noSession?: boolean; prep?: (f: FakeMM) => void } = {}) {
  const fake = new FakeMM(o.fake); await fake.start(); o.prep?.(fake);
  const dir = mkdtempSync(join(tmpdir(), "mm-"));
  if (!o.noSession) writeFileSync(join(dir, "mattermost-session.json"), JSON.stringify({ server: fake.url, token: o.token ?? "pat-good" }));
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: CoreEvent) => ev.push(e));
  const of = <T extends CoreEvent["type"]>(t: T) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => ev.some((e) => e.type === "account" && e.data.state === "connected");
  return { fake, dir, ev, conn, of, connected, close: async () => { await conn.stop(); await fake.close(); } };
}

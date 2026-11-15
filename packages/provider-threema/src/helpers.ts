import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { FakeGateway, GW, SECRET } from "./fake-server.js";
import { saveSession } from "./secret.js";
import { hex } from "./proto.js";

export const ALICE = "ALICE123", BOB = "BOBBOB99";
export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error("timeout waiting for " + what);
}
export const freePort = () => new Promise<number>((ok) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => ok(p)); }); });

export async function setup(factory: { create(o: { accountId: string; dataDir: string }): any }, o: { noSession?: boolean; port?: number | "none"; env?: Record<string, string> } = {}) {
  const fake = new FakeGateway(); await fake.start();
  fake.peer(ALICE, "Alice W"); fake.peer(BOB);
  const dir = mkdtempSync(join(tmpdir(), "tm-"));
  Object.assign(process.env, { UNIMSG_THREEMA_BASE: fake.url, UNIMSG_THREEMA_RETRY_MS: "50" }, o.env);
  const port = o.port === "none" ? 0 : o.port ?? await freePort();
  fake.callbackUrl = `http://127.0.0.1:${port}/threema/callback`;
  if (!o.noSession) saveSession(dir, { gatewayId: GW, secret: SECRET, privateKey: hex(fake.gw.secretKey), callbackPort: port });
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  await conn.start((e: CoreEvent) => ev.push(e));
  const of = <T extends CoreEvent["type"]>(t: T) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => ev.some((e) => e.type === "account" && e.data.state === "connected");
  return { fake, dir, ev, conn, of, port, connected, close: async () => { await conn.stop(); await fake.close(); } };
}

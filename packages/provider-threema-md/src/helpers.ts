import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreEvent } from "@unimsg/core";
import { FakePhone } from "./fake/phone.js";
import { FakeBackend, FakeHttp, FakeRendezvous } from "./fake/servers.js";

export async function waitFor(f: () => boolean, ms = 8000, what = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms && !f()) await new Promise((r) => setTimeout(r, 20));
  if (!f()) throw new Error("timeout waiting for " + what);
}
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const tmp = () => mkdtempSync(join(tmpdir(), "tmd-"));

export async function world(o: { slots?: number; env?: Record<string, string> } = {}) {
  const rz = new FakeRendezvous(), be = new FakeBackend(o.slots ?? 3), http = new FakeHttp();
  const [rzUrl, medUrl, httpUrl] = [await rz.start(), await be.start(), await http.start()];
  Object.assign(process.env, {
    UNIMSG_THREEMA_MD_RENDEZVOUS: rzUrl, UNIMSG_THREEMA_MD_MEDIATOR: medUrl, UNIMSG_THREEMA_MD_BLOB: httpUrl, UNIMSG_THREEMA_MD_DIRECTORY: httpUrl,
    UNIMSG_THREEMA_MD_CSP_KEY: be.cspKeyHex, UNIMSG_THREEMA_MD_RETRY_MS: "40", UNIMSG_THREEMA_MD_PACE_MS: "0", UNIMSG_THREEMA_MD_MAX_RETRIES: "6", UNIMSG_THREEMA_MD_BLOCK_MS: "150",
  }, o.env);
  const phone = new FakePhone(be);
  return { rz, be, http, phone, medUrl, close: async () => { phone.close(); await rz.close(); await be.close(); await http.close(); } };
}
export type World = Awaited<ReturnType<typeof world>>;

export interface Linked { conn: any; dir: string; ev: CoreEvent[]; of: (t: CoreEvent["type"]) => any[]; connected: () => boolean; stateOf: () => string; w: World; stop: () => Promise<void> }
/** Run the complete linking flow against the fakes and return a connected connector. */
export async function linked(factory: { create(o: { accountId: string; dataDir: string }): any }, w: World, o: { dir?: string; phoneOnline?: boolean } = {}): Promise<Linked> {
  const dir = o.dir ?? tmp();
  const ev: CoreEvent[] = [];
  const conn = factory.create({ accountId: "acc", dataDir: dir });
  const of = (t: CoreEvent["type"]) => ev.filter((e) => e.type === t).map((e) => e.data as any);
  const connected = () => { const a = of("account"); return a.length > 0 && a[a.length - 1].state === "connected"; };
  const stateOf = () => { const a = of("account"); return a.length ? a[a.length - 1].state : ""; };
  await conn.start((e: CoreEvent) => ev.push(e));
  await waitFor(() => of("login").length > 0, 3000, "consent prompt");
  await conn.submitLogin(of("login")[0].promptId, { confirm: "true" });
  await waitFor(() => of("login").some((l: any) => l.kind === "qr"), 5000, "qr");
  const qr = of("login").find((l: any) => l.kind === "qr").payload as string;
  await w.phone.scan(qr);
  if (o.phoneOnline) await w.phone.connect(w.medUrl);
  await waitFor(connected, 8000, "connected");
  return { conn, dir, ev, of, connected, stateOf, w, stop: () => conn.stop() };
}
export const filesIn = (dir: string) => readdirSync(dir);
export const readAll = (dir: string) => readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");

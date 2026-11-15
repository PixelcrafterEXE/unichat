// Bundled by `node scripts/build-backend-bundle.mjs --dht-smoke` and run under a plain Node (ideally 18.x, like nodejs-mobile): proves that the HyperDHT transport
// (packages/sync/src/dht.ts) survives the esbuild bundle + the native-add-on loader, over an in-process LOCAL testnet only (never the public DHT).
// @ts-ignore hyperdht has no types and is not a dependency of this package (the bundler resolves it from packages/sync)
import createTestnet from "hyperdht/testnet";
import { randomBytes } from "node:crypto";
import { dhtSeed, DhtTransport } from "../../../packages/sync/src/dht.js";

const t = await createTestnet(3, { host: "127.0.0.1" });
const bootstrap = t.bootstrap.map((b: any) => `${b.host}:${b.port}`);
let a: DhtTransport | undefined, b: DhtTransport | undefined;
try {
  const got: Buffer[] = []; let bKey = "", aKey = "";
  a = new DhtTransport({ seed: dhtSeed(randomBytes(32), "g"), bootstrap, requireBootstrap: true, allow: () => [bKey], onInbound: (s: any) => { s.on("data", (d: Buffer) => { got.push(d); s.write(Buffer.from("pong:" + d)); }); } });
  b = new DhtTransport({ seed: dhtSeed(randomBytes(32), "g"), bootstrap, requireBootstrap: true, allow: () => [aKey], onInbound: () => {} });
  await a.start(); await b.start(); aKey = a.publicKey!; bKey = b.publicKey!;
  const s: any = await b.connect(aKey, new AbortController().signal, 15_000);
  const reply = await new Promise<string>((ok, fail) => { s.once("data", (d: Buffer) => ok(String(d))); s.once("error", fail); s.write(Buffer.from("ping")); setTimeout(() => fail(new Error("no reply")), 10_000); });
  if (reply !== "pong:ping" || String(got[0]) !== "ping") throw new Error("unexpected data: " + reply);
  console.log(`DHT-SMOKE OK node=${process.version} platform=${process.platform}-${process.arch} bytes=${reply}`);
  s.destroy();
} finally { await a?.stop(); await b?.stop(); await t.destroy(); }
process.exit(0);

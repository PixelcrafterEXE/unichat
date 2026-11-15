// Stand-alone relay process: no Hub, no data directory, no keys. See relay.ts.
import { startRelayServer } from "./relay.js";
const host = process.env.HOST ?? "127.0.0.1", port = Number(process.env.PORT ?? 8780);
const r = await startRelayServer(port, host, { trustProxy: process.env.UNIMSG_RELAY_TRUST_PROXY === "1" });
console.log(`unimsg relay on ${host}:${r.port}/relay/<id>  (forwards opaque encrypted frames between two paired devices; stores nothing)`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { r.close(); process.exit(0); });

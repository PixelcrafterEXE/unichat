import { join } from "node:path";
import type { Hub } from "@unimsg/core";
import { Ledger } from "./ledger.js";
import { SyncService, type SyncOptions } from "./service.js";
import type { SyncStore } from "./syncstore.js";

/**
 * Hook the sync service into a Hub. `store` must be the SyncStore that the Hub was constructed with.
 * `dir` holds sync.db (sealed with `dataKey`, the same key as the message archive); omit it for an in-memory ledger (tests).
 */
export function attachSync(hub: Hub, store: SyncStore, o: SyncOptions & { dir?: string; dataKey?: Uint8Array } = {}): SyncService {
  const ledger = new Ledger(o.dir ? join(o.dir, "sync.db") : ":memory:", o.dataKey);
  let svc!: SyncService;
  hub.attachSync((host) => (svc = new SyncService(host, store, ledger, o)));
  return svc;
}

// HTTPS side channels: identity directory (public key lookup) and the multi-device blob mirror. Requests are serialised and paced; HTTP 429 blocks
// further requests for >= 10 s (csp.struct.yml "Valid Contacts Lookup Steps"). Errors never contain ids, urls or payloads.
import { blobMirrorBase, directoryBase, HTTP_PACE_MS, RATE_BLOCK_MS } from "./config.js";
import { u64le } from "./csp.js";

export class HttpError extends Error { status: number; constructor(status: number, what: string) { super(`${what} failed (HTTP ${status})`); this.status = status; } }
export interface DirEntry { identity: string; publicKey: Uint8Array; type: number; state: number; featureMask: bigint }

export class Net {
  private chain: Promise<unknown> = Promise.resolve();
  private blockedUntil = 0; private last = 0;
  private dgpkPublic: Uint8Array; private deviceId: bigint;
  constructor(dgpkPublic: Uint8Array, deviceId: bigint) { this.dgpkPublic = dgpkPublic; this.deviceId = deviceId; }
  private run<T>(f: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = Math.max(this.blockedUntil - Date.now(), this.last + HTTP_PACE_MS() - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await f(); } finally { this.last = Date.now(); }
    });
    this.chain = p.catch(() => undefined);
    return p;
  }
  private async http(what: string, url: string, init: RequestInit & { expect?: number[] }): Promise<Response> {
    let r: Response;
    try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), headers: { "user-agent": "UniChat", ...(init.headers as object) } }); }
    catch { throw new HttpError(0, what); }
    if (r.status === 429) { this.blockedUntil = Date.now() + Math.max(RATE_BLOCK_MS(), Number(r.headers.get("retry-after") ?? 0) * 1000); throw new HttpError(429, what); }
    if (!(init.expect ?? [200]).includes(r.status)) throw new HttpError(r.status, what);
    return r;
  }

  fetchIdentities(ids: string[]): Promise<Map<string, DirEntry>> {
    return this.run(async () => {
      const r = await this.http("directory lookup", directoryBase() + "identity/fetch_bulk", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ identities: ids }) });
      const j = (await r.json()) as { identities?: { identity: string; type?: number; publicKey: string; state?: number; featureMask?: number | string }[] };
      const out = new Map<string, DirEntry>();
      for (const e of j.identities ?? []) {
        const pk = new Uint8Array(Buffer.from(e.publicKey, "base64"));
        if (pk.length === 32 && ids.includes(e.identity)) out.set(e.identity, { identity: e.identity, publicKey: pk, type: e.type ?? 0, state: e.state ?? 0, featureMask: BigInt(e.featureMask ?? 0) });
      }
      return out;
    });
  }

  private q(scope: "local" | "public", extra = "") { return `?deviceId=${Buffer.from(u64le(this.deviceId)).toString("hex")}&deviceGroupId=${Buffer.from(this.dgpkPublic).toString("hex")}&scope=${scope}${extra}`; }
  download(blobIdHex: string, scope: "local" | "public" = "public"): Promise<Uint8Array> {
    if (!/^[0-9a-f]{32}$/.test(blobIdHex)) return Promise.reject(new Error("invalid blob reference"));
    return this.run(async () => {
      const r = await this.http("blob download", blobMirrorBase(this.dgpkPublic) + blobIdHex + this.q(scope), { method: "GET", headers: { accept: "application/octet-stream" } });
      return new Uint8Array(await r.arrayBuffer());
    });
  }
  /** Tell the mirror this device has the blob (it may delete it once every device did). Best effort. */
  done(blobIdHex: string, scope: "local" | "public" = "public"): Promise<void> {
    return this.run(async () => { await this.http("blob done", blobMirrorBase(this.dgpkPublic) + blobIdHex + "/done" + this.q(scope), { method: "POST", expect: [204, 200] }); }).catch(() => undefined);
  }
  upload(data: Uint8Array, persist: boolean, scope: "local" | "public" = "public"): Promise<string> {
    return this.run(async () => {
      const fd = new FormData(); fd.append("blob", new Blob([data as BlobPart]));
      const r = await this.http("blob upload", blobMirrorBase(this.dgpkPublic) + "upload" + this.q(scope, `&persist=${persist ? 1 : 0}`), { method: "POST", headers: { accept: "text/plain" }, body: fd });
      const id = (await r.text()).trim();
      if (!/^[0-9a-f]{32}$/.test(id)) throw new Error("blob upload returned an invalid id");
      return id;
    });
  }
}

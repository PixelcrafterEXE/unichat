// Endpoints (production defaults are public client constants, see Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes) section 8) and loopback-only overrides for the offline tests.
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
/** An endpoint override is honoured ONLY for loopback hosts (tests); anything else silently falls back to the default. */
export function endpoint(envName: string, def: string): string {
  const v = process.env[envName]; if (!v) return def;
  try { const u = new URL(v); if (LOOPBACK.test(u.hostname)) return v.endsWith("/") ? v : v + "/"; } catch { /* ignore */ }
  return def;
}
export const isOverridden = (envName: string, def: string) => endpoint(envName, def) !== def;

const hex2 = (b: number) => b.toString(16).padStart(2, "0");
const tpl = (t: string, first: number) => t.replace("{p4}", (first >> 4).toString(16)).replace("{p8}", hex2(first));

export const DEFAULTS = {
  rendezvous: "wss://rendezvous-{p4}.threema.ch/{p8}/",
  mediator: "wss://mediator-{p4}.threema.ch/{p8}/",
  blobMirror: "https://blob-mirror-{p4}.threema.ch/{p8}/",
  directory: "https://ds-apip.threema.ch/",
} as const;
/** Permanent chat server public keys (client constants of the public Threema Desktop config; unverifiable offline, see README gaps). */
export const CSP_SERVER_KEYS_HEX = [
  "450b975735279fdecb3313648f5fc6ee9ff4360ea92a8c1751c661e4c0d8c909",
  "da7c73798f97d587c3a25ebe0a91417f76dbcccdda2930e6a9090af62eba6f15",
];
export const cspServerKeys = (): Uint8Array[] => {
  const o = process.env.UNIMSG_THREEMA_MD_CSP_KEY;
  if (o && isOverridden("UNIMSG_THREEMA_MD_MEDIATOR", DEFAULTS.mediator)) return [new Uint8Array(Buffer.from(o, "hex"))];
  return CSP_SERVER_KEYS_HEX.map((h) => new Uint8Array(Buffer.from(h, "hex")));
};

export const rendezvousBase = (pathFirstByte: number) => tpl(endpoint("UNIMSG_THREEMA_MD_RENDEZVOUS", DEFAULTS.rendezvous), pathFirstByte);
export const mediatorBase = (dgpkPublic: Uint8Array) => tpl(endpoint("UNIMSG_THREEMA_MD_MEDIATOR", DEFAULTS.mediator), dgpkPublic[0]);
export const blobMirrorBase = (dgpkPublic: Uint8Array) => tpl(endpoint("UNIMSG_THREEMA_MD_BLOB", DEFAULTS.blobMirror), dgpkPublic[0]);
export const directoryBase = () => endpoint("UNIMSG_THREEMA_MD_DIRECTORY", DEFAULTS.directory);

const num = (n: string, d: number) => (process.env[n] !== undefined ? Number(process.env[n]) : d);
export const RETRY_BASE_MS = () => num("UNIMSG_THREEMA_MD_RETRY_MS", 5000);
export const MAX_RETRIES = () => num("UNIMSG_THREEMA_MD_MAX_RETRIES", 8);
/** After HTTP 429 no further request is made for at least this long (spec: >= 10 s). */
export const RATE_BLOCK_MS = () => num("UNIMSG_THREEMA_MD_BLOCK_MS", 10_000);
export const HTTP_PACE_MS = () => num("UNIMSG_THREEMA_MD_PACE_MS", 400);
export const JOIN_TTL_MS = () => num("UNIMSG_THREEMA_MD_JOIN_TTL_MS", 4 * 60_000);
export const DEVICE_LABEL = "UniChat";
export const APP_VERSION = "0.1";

const DEBUG = () => !!process.env.UNIMSG_DEBUG;
/** Debug lines carry counts/states only, never ids, names, keys or text. */
export const dbg = (line: string) => { if (DEBUG()) process.stderr.write(`[threema-md] ${line}\n`); };

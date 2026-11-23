// Self-update service: looks for a newer release in the GitHub Releases of the project, downloads the asset for THIS platform,
// verifies its SHA-256 against the release manifest (`latest.json`) and hands it to the platform installer.
//   - Private repos: an optional read-only token (sealed on disk, never logged, never returned, never synced). The token is only sent to the API host:
//     asset downloads redirect to a CDN host, and the redirect is followed WITHOUT the Authorization header.
//   - One download at a time; a failed / cancelled / mismatching download leaves no partial file behind.
//   - Never throws on its own from the background: failures end up in the status (`error`, `errorKind`).
// Transport-agnostic like the Hub: the RPCs are updateCheck / updateStatus / updateDownload / updateCancel / updateInstall / updateSettings.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_UPDATE_REPO = "PixelcrafterEXE/unichat";
export type UpdateChannel = "stable" | "prerelease";
export type UpdateErrorKind = "offline" | "rate-limit" | "auth" | "not-found" | "mismatch" | "manifest" | "no-asset" | "metered" | "other";
export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";
/** How this platform installs: "self" = the app replaces itself / hands the file to the OS installer; "manual" = the user is pointed to the file (.deb); "none" = only tell (web, server, dev). */
export type InstallMode = "self" | "manual" | "none";

export interface ManifestAsset { name: string; size: number; sha256: string }
export interface Manifest { version: string; publishedAt: string; notes: string; assets: Record<string, ManifestAsset> }
export interface UpdateInfo { version: string; publishedAt: string; notes: string; asset?: { name: string; size: number } }
export interface UpdateSettingsView { repo: string; hasToken: boolean; channel: UpdateChannel; auto: boolean }
export interface UpdateStatus {
  state: UpdateState; current: string; platform?: string; installMode: InstallMode; dev: boolean;
  available: boolean; latest?: UpdateInfo; lastChecked?: number; error?: string; errorKind?: UpdateErrorKind;
  progress?: { done: number; total: number }; /** the verified file, once state is "ready" */ file?: string; settings: UpdateSettingsView;
}
export interface InstallContext { file: string; asset: { name: string; size: number; sha256: string }; version: string; platform: string }
export interface InstallResult { /** "restart": the installer replaced the app and a restart follows; "handoff": the UI must call the native installer with `file`; "manual": nothing was installed, tell the user (`message`) */ action: "restart" | "handoff" | "manual"; file?: string; message?: string }

export interface UpdaterOptions {
  dataDir: string;
  /** "0.1.N" or "dev" */
  version: string;
  /** manifest asset key of this platform (android, desktop-linux-appimage, desktop-linux-deb); undefined = web / server: only tell that a new version exists */
  platform?: string;
  /** "manual" for .deb (no self-install), default "self" when a platform and an installer / handoff exist */
  installMode?: InstallMode;
  /** the platform installer. Without it the verified file is only handed back (Android: the UI starts the system installer) */
  install?: (c: InstallContext) => Promise<InstallResult> | InstallResult;
  emit?: (event: string, data: unknown) => void;
  /** 32-byte key used to seal the token on disk */
  dataKey?: Uint8Array;
  /** tests point this at a loopback server; default https://api.github.com */
  apiBase?: string;
  fetch?: typeof fetch;
  isMetered?: () => boolean | Promise<boolean>;
  /** background checks: first one after startDelayMs, then every intervalMs (default 15 s / 6 h); 0 disables the timer */
  startDelayMs?: number; intervalMs?: number;
  /** network stall limit for API calls and between two download chunks */
  timeoutMs?: number;
  /** how often one download is retried (resuming) after a dropped connection */
  retries?: number;
}

const METHODS = new Set(["updateCheck", "updateStatus", "updateDownload", "updateCancel", "updateInstall", "updateSettings"]);
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const MAX_NOTES = 1200;

/** "0.1.37" / "v0.1.37" (+ optional "-pre" / "+build") -> [0,1,37]; anything else (e.g. "dev") -> undefined */
export function parseVersion(v: unknown): number[] | undefined {
  const m = typeof v === "string" ? /^v?(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?:[-+][0-9A-Za-z.+-]*)?$/.exec(v.trim()) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : undefined;
}
/** <0 when a is older than b. Unparseable versions count as older than everything (a bare "dev" build is older than any release).
 *  A pre-release is older than its release (semver): a local build "0.1.17-dev.202611231530" previews 0.1.17, so the release 0.1.17
 *  (and anything higher) is an update for it, while 0.1.16 is not. Build metadata ("+...") does not count. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x && !y) return 0; if (!x) return -1; if (!y) return 1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  const pre = (v: string) => /^v?\d+\.\d+(?:\.\d+)?-/.test(v.trim());
  const pa = pre(a), pb = pre(b);
  return pa === pb ? 0 : pa ? -1 : 1;
}

/** Validate a parsed `latest.json`. Throws a user-readable Error. */
export function parseManifest(raw: unknown): Manifest {
  const o = raw as any;
  if (!o || typeof o !== "object") throw new Error("The release manifest is not an object");
  if (!parseVersion(o.version)) throw new Error("The release manifest has no valid version");
  if (!o.assets || typeof o.assets !== "object" || Array.isArray(o.assets)) throw new Error("The release manifest has no assets");
  const assets: Record<string, ManifestAsset> = {};
  for (const [k, a] of Object.entries<any>(o.assets)) {
    if (!a || typeof a.name !== "string" || !/^[\w][\w.+-]{0,200}$/.test(a.name)) continue; // a name is a plain file name, never a path
    if (!Number.isFinite(a.size) || a.size <= 0 || a.size > 2 ** 33) continue;
    if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(a.sha256)) continue;
    assets[k] = { name: a.name, size: Math.floor(a.size), sha256: a.sha256.toLowerCase() };
  }
  return { version: String(o.version).replace(/^v/, ""), publishedAt: typeof o.publishedAt === "string" ? o.publishedAt : "", notes: typeof o.notes === "string" ? o.notes.slice(0, MAX_NOTES) : "", assets };
}

class UpdateError extends Error { constructor(msg: string, readonly kind: UpdateErrorKind, readonly retryAfterMs?: number) { super(msg); } }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface ReleaseAsset { name: string; url: string; size: number }
interface Release { tag: string; prerelease: boolean; notes: string; publishedAt: string; assets: ReleaseAsset[] }

export class Updater {
  static readonly methods = METHODS;
  static handles(m: string) { return METHODS.has(m); }
  private cfg: { repo: string; channel: UpdateChannel; auto: boolean; lastChecked?: number; token?: string };
  private st: { state: UpdateState; latest?: UpdateInfo; error?: string; errorKind?: UpdateErrorKind; progress?: { done: number; total: number }; file?: string } = { state: "idle" };
  private manifestAsset?: ManifestAsset; private releaseAsset?: ReleaseAsset;
  private checking?: Promise<UpdateStatus>; private downloading?: Promise<UpdateStatus>; private abort?: AbortController;
  private backoffUntil = 0; private metered = false; private timer?: ReturnType<typeof setInterval>; private first?: ReturnType<typeof setTimeout>;
  private announced = ""; private disposed = false;
  private readonly dir: string; private readonly cfgFile: string; private readonly apiBase: string; private readonly fetchImpl: typeof fetch;

  constructor(private o: UpdaterOptions) {
    this.dir = join(o.dataDir, "updates"); this.cfgFile = join(o.dataDir, "updater.json");
    this.apiBase = (o.apiBase ?? "https://api.github.com").replace(/\/+$/, ""); this.fetchImpl = o.fetch ?? fetch;
    this.cfg = { repo: DEFAULT_UPDATE_REPO, channel: "prerelease", auto: true };
    this.loadConfig();
    this.cleanDir();
  }

  get dev() { return !parseVersion(this.o.version); }
  private get installMode(): InstallMode { if (!this.o.platform) return "none"; return this.o.installMode ?? "self"; }
  setMetered(m: boolean) { this.metered = m; }

  // ---- RPC ---------------------------------------------------------------------------------------------------------------
  async call(method: string, p: any = {}): Promise<unknown> {
    switch (method) {
      case "updateStatus": return this.status();
      case "updateCheck": return this.check({ manual: true });
      case "updateDownload": return this.download();
      case "updateCancel": this.abort?.abort(); return this.status();
      case "updateInstall": return this.install();
      case "updateSettings": return this.settings(p);
    }
    throw new Error("unknown update method " + method);
  }

  status(): UpdateStatus {
    const s = this.st;
    return { state: s.state, current: this.o.version, platform: this.o.platform, installMode: this.installMode, dev: this.dev,
      available: !this.dev && !!s.latest && compareVersions(s.latest.version, this.o.version) > 0, latest: s.latest, lastChecked: this.cfg.lastChecked, error: s.error, errorKind: s.errorKind,
      progress: s.progress, file: s.file, settings: this.view() };
  }
  private view(): UpdateSettingsView { return { repo: this.cfg.repo, hasToken: !!this.cfg.token, channel: this.cfg.channel, auto: this.cfg.auto }; }

  /** `token`: undefined = keep, "" = remove, otherwise replace. The token is never returned. */
  settings(p: { repo?: unknown; token?: unknown; channel?: unknown; auto?: unknown } = {}): UpdateStatus {
    if (p.repo !== undefined) {
      const r = String(p.repo).trim() || DEFAULT_UPDATE_REPO;
      if (!REPO_RE.test(r) || r.split("/").some((x) => /^\.+$/.test(x))) throw new Error("The repository must look like owner/name.");
      if (r !== this.cfg.repo) { this.cfg.repo = r; this.reset(); }
    }
    if (p.channel !== undefined) {
      if (p.channel !== "stable" && p.channel !== "prerelease") throw new Error("The channel must be stable or prerelease.");
      if (p.channel !== this.cfg.channel) { this.cfg.channel = p.channel; this.reset(); }
    }
    if (p.auto !== undefined) { this.cfg.auto = !!p.auto; this.schedule(); }
    if (p.token !== undefined) {
      if (typeof p.token !== "string") throw new Error("Invalid token.");
      const t = p.token.trim();
      if (/[\r\n]/.test(t) || t.length > 500) throw new Error("This does not look like a token.");
      this.cfg.token = t || undefined; this.backoffUntil = 0;
    }
    this.saveConfig();
    return this.status();
  }
  /** A different repo / channel invalidates what was found (and a downloaded file of the old answer). */
  private reset() { if (this.st.state === "downloading") this.abort?.abort(); this.st = { state: "idle" }; this.manifestAsset = undefined; this.releaseAsset = undefined; this.announced = ""; this.backoffUntil = 0; this.cleanDir(); }

  // ---- check -------------------------------------------------------------------------------------------------------------
  /** `manual`: the user asked (metered connections and rate-limit backoff do not stop it). Resolves with the status; failures are in it. */
  check(o: { manual?: boolean } = {}): Promise<UpdateStatus> {
    if (this.checking) return this.checking;
    if (this.st.state === "downloading" || this.st.state === "installing") return Promise.resolve(this.status());
    return (this.checking = this.doCheck(!!o.manual).finally(() => { this.checking = undefined; }));
  }
  private async doCheck(manual: boolean): Promise<UpdateStatus> {
    if (!manual) {
      if (Date.now() < this.backoffUntil) return this.status();
      if (await this.isMetered()) { this.setError(new UpdateError("Skipped: this connection is metered.", "metered"), true); return this.status(); }
    }
    const before = this.st; this.st = { ...before, state: "checking", error: undefined, errorKind: undefined };
    try {
      const rel = await this.pickRelease();
      const mf = await this.fetchManifest(rel);
      this.cfg.lastChecked = Date.now(); this.saveConfig();
      const ma = this.o.platform ? mf.assets[this.o.platform] : undefined;
      const ra = ma ? rel.assets.find((a) => a.name === ma.name) : undefined;
      const info: UpdateInfo = { version: mf.version, publishedAt: mf.publishedAt || rel.publishedAt, notes: mf.notes || rel.notes, asset: ma && { name: ma.name, size: ma.size } };
      const newer = compareVersions(mf.version, this.o.version) > 0 && !this.dev;
      if (this.dev) { this.st = { state: "idle", latest: info }; return this.status(); } // a dev build never offers installing a release over itself
      if (!newer) { this.st = { state: "idle", latest: info }; this.manifestAsset = undefined; return this.status(); }
      this.manifestAsset = ma; this.releaseAsset = ra;
      const keepFile = this.st.file && this.st.latest?.version === info.version ? this.st.file : undefined;
      this.st = { state: keepFile ? "ready" : "available", latest: info, file: keepFile };
      if (this.o.platform && !ma) this.st.error = `This release has no file for ${this.o.platform}.`, this.st.errorKind = "no-asset";
      if (this.announced !== info.version) { this.announced = info.version; this.emit("update-available", { version: info.version, notes: info.notes, publishedAt: info.publishedAt, installMode: this.installMode }); }
    } catch (e) { this.setError(e, false); }
    return this.status();
  }
  private setError(e: unknown, _keepLatest: boolean) {
    const ue = e instanceof UpdateError ? e : new UpdateError(e instanceof Error ? e.message : String(e), "other");
    if (ue.retryAfterMs) this.backoffUntil = Date.now() + ue.retryAfterMs;
    this.st = { state: "error", error: ue.message, errorKind: ue.kind, latest: this.st.latest }; // an earlier answer stays visible next to the error
  }
  private async isMetered() { try { return this.metered || !!(await this.o.isMetered?.()); } catch { return false; } }

  private headers(accept: string): Record<string, string> {
    const h: Record<string, string> = { Accept: accept, "User-Agent": "UniChat-updater", "X-GitHub-Api-Version": "2022-11-28" };
    if (this.cfg.token) h.Authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  /** GET with manual redirects: the Authorization header goes only to the origin we started with (never to the CDN a download redirects to), https is never downgraded. */
  private async get(url: string, accept: string, o: { range?: number; signal?: AbortSignal } = {}): Promise<Response> {
    const first = new URL(url); let cur = first;
    for (let hop = 0; hop < 6; hop++) {
      const h = this.headers(accept);
      if (cur.origin !== first.origin) delete h.Authorization;
      if (o.range) h.Range = `bytes=${o.range}-`;
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 30_000);
      const onAbort = () => ctl.abort(); o.signal?.addEventListener("abort", onAbort);
      let res: Response;
      try { res = await this.fetchImpl(cur, { headers: h, redirect: "manual", signal: ctl.signal }); }
      catch (e) { if (o.signal?.aborted) throw new UpdateError("Cancelled.", "other"); throw new UpdateError("Cannot reach the update server. Check your internet connection.", "offline"); }
      finally { clearTimeout(t); o.signal?.removeEventListener("abort", onAbort); }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location")!, cur); void res.body?.cancel().catch(() => {});
        if (cur.protocol === "https:" && next.protocol !== "https:") throw new UpdateError("The update server redirected to an insecure address. Refused.", "other");
        cur = next; continue;
      }
      return res;
    }
    throw new UpdateError("The update server redirected too often.", "other");
  }
  private failFor(res: Response): UpdateError {
    const left = res.headers.get("x-ratelimit-remaining"), reset = Number(res.headers.get("x-ratelimit-reset")), ra = Number(res.headers.get("retry-after"));
    if (res.status === 429 || (res.status === 403 && (left === "0" || Number.isFinite(ra) && ra > 0))) {
      const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Number.isFinite(reset) && reset > 0 ? Math.max(60_000, reset * 1000 - Date.now()) : 3600_000;
      return new UpdateError("GitHub is limiting requests right now. Try again later" + (this.cfg.token ? "." : " (a token raises the limit)."), "rate-limit", Math.min(ms, 24 * 3600_000));
    }
    if (res.status === 401 || res.status === 403) return new UpdateError("GitHub refused the access token. Check that it can read this repository.", "auth");
    if (res.status === 404) return new UpdateError(this.cfg.token ? "Repository or release not found. Check the name and that the token can read it." : "Repository not found. If it is private, add a read-only token in the update settings.", "not-found");
    return new UpdateError(`The update server answered ${res.status}.`, "other");
  }
  private async json(url: string): Promise<any> {
    const res = await this.get(url, "application/vnd.github+json");
    if (!res.ok) throw this.failFor(res);
    try { return await res.json(); } catch { throw new UpdateError("The update server sent something unreadable.", "other"); }
  }

  private async pickRelease(): Promise<Release> {
    const list = await this.json(`${this.apiBase}/repos/${this.cfg.repo}/releases?per_page=30`);
    if (!Array.isArray(list)) throw new UpdateError("The update server sent something unexpected.", "other");
    let best: Release | undefined;
    for (const r of list) {
      if (!r || r.draft || (r.prerelease && this.cfg.channel === "stable") || !parseVersion(r.tag_name)) continue;
      const assets: ReleaseAsset[] = Array.isArray(r.assets) ? r.assets.filter((a: any) => a && typeof a.name === "string" && typeof a.url === "string").map((a: any) => ({ name: a.name, url: a.url, size: Number(a.size) || 0 })) : [];
      if (!assets.some((a) => a.name === "latest.json")) continue; // not one of ours / still being published
      if (!best || compareVersions(r.tag_name, best.tag) > 0) best = { tag: r.tag_name, prerelease: !!r.prerelease, notes: String(r.body ?? "").slice(0, MAX_NOTES), publishedAt: String(r.published_at ?? ""), assets };
    }
    if (!best) throw new UpdateError("No release found yet.", "not-found");
    return best;
  }
  private async fetchManifest(rel: Release): Promise<Manifest> {
    const a = rel.assets.find((x) => x.name === "latest.json")!;
    const res = await this.get(a.url, "application/octet-stream");
    if (!res.ok) throw this.failFor(res);
    try { return parseManifest(JSON.parse(await res.text())); } catch (e) { throw new UpdateError(`The release manifest is invalid: ${(e as Error).message}`, "manifest"); }
  }

  // ---- download ----------------------------------------------------------------------------------------------------------
  download(): Promise<UpdateStatus> {
    if (this.downloading) return this.downloading; // never two at once
    if (this.st.state === "ready") return Promise.resolve(this.status());
    if (this.installMode === "none") return Promise.reject(new Error("This app cannot install updates itself."));
    if (!this.manifestAsset || !this.releaseAsset || this.st.state === "idle") return Promise.reject(new Error("No update to download. Check for updates first."));
    return (this.downloading = this.doDownload(this.manifestAsset, this.releaseAsset).finally(() => { this.downloading = undefined; this.abort = undefined; }));
  }
  private async doDownload(ma: ManifestAsset, ra: ReleaseAsset): Promise<UpdateStatus> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const final = join(this.dir, ma.name), part = final + ".part";
    this.cleanDir(ma.name);
    this.abort = new AbortController();
    const latest = this.st.latest; this.st = { state: "downloading", latest, progress: { done: 0, total: ma.size } };
    this.emit("update-progress", { done: 0, total: ma.size });
    try {
      if (!existsSync(final) || (await sha256File(final)) !== ma.sha256) {
        rmSync(final, { force: true });
        await this.fetchTo(ra.url, part, ma);
        const got = await sha256File(part);
        if (statSync(part).size !== ma.size || got !== ma.sha256) throw new UpdateError("The downloaded file does not match the published checksum, so it was discarded.", "mismatch");
        renameSync(part, final);
      }
      this.st = { state: "ready", latest, file: final, progress: { done: ma.size, total: ma.size } };
      this.emit("update-progress", { done: ma.size, total: ma.size, ready: true });
    } catch (e) {
      rmSync(part, { force: true }); rmSync(final, { force: true });
      this.setError(e, true);
    }
    return this.status();
  }
  /** Stream to `part`, resuming with a Range request when the connection drops (a few times), progress events at most every 200 ms. */
  private async fetchTo(url: string, part: string, ma: ManifestAsset) {
    const signal = this.abort!.signal; let last = 0, lastErr: unknown;
    for (let attempt = 0; attempt <= (this.o.retries ?? 3); attempt++) {
      if (signal.aborted) throw new UpdateError("Cancelled.", "other");
      let have = existsSync(part) ? statSync(part).size : 0;
      if (have > ma.size) { rmSync(part, { force: true }); have = 0; }
      if (have === ma.size) return;
      try {
        const res = await this.get(url, "application/octet-stream", { range: have || undefined, signal });
        if (!res.ok) throw this.failFor(res);
        if (have && res.status !== 206) { rmSync(part, { force: true }); have = 0; } // the server ignored Range: start over with what it sends
        const fh = await open(part, have ? "a" : "w", 0o600);
        try {
          const reader = res.body!.getReader(); let done = have;
          try { for (;;) {
            const chunk = await readTimed(reader, this.o.timeoutMs ?? 30_000, signal);
            if (chunk.done) break;
            if (done + chunk.value.length > ma.size) throw new UpdateError("The downloaded file is larger than announced and was discarded.", "mismatch");
            await fh.write(chunk.value); done += chunk.value.length;
            this.st.progress = { done, total: ma.size };
            const now = Date.now(); if (now - last > 200) { last = now; this.emit("update-progress", { done, total: ma.size }); }
          } if (done < ma.size) throw new UpdateError("The connection was lost during the download.", "offline"); } finally { void reader.cancel().catch(() => {}); await fh.close(); }
        } catch (e) { throw e; }
        return;
      } catch (e) {
        lastErr = e;
        if (!(e instanceof UpdateError) || e.kind !== "offline" || signal.aborted) throw e; // only dropped connections are retried
        await sleep(Math.min(200 * 2 ** attempt, 2000));
      }
    }
    throw lastErr;
  }

  // ---- install -----------------------------------------------------------------------------------------------------------
  async install(): Promise<InstallResult & { status: UpdateStatus }> {
    const f = this.st.file, ma = this.manifestAsset, v = this.st.latest?.version;
    if (this.st.state !== "ready" || !f || !ma || !v || !this.o.platform) throw new Error("There is no verified update to install. Download it first.");
    if (await sha256File(f) !== ma.sha256) { rmSync(f, { force: true }); this.st = { state: "error", latest: this.st.latest, error: "The downloaded file changed on disk and was discarded.", errorKind: "mismatch" }; throw new Error(this.st.error); }
    if (!this.o.install) return { action: "handoff", file: f, status: this.status() }; // Android: the UI passes the file to the native installer
    const before = this.st; this.st = { ...before, state: "installing" };
    try {
      const r = await this.o.install({ file: f, asset: ma, version: v, platform: this.o.platform });
      this.st = { ...before, state: "ready" };
      return { ...r, status: this.status() };
    } catch (e) { this.st = { ...before, state: "ready" }; throw e; }
  }

  // ---- background ---------------------------------------------------------------------------------------------------------
  /** Start the background check (first one shortly after start, then every 6 h) while "auto" is on. */
  start() { this.schedule(); }
  private schedule() {
    clearTimeout(this.first); clearInterval(this.timer); this.first = this.timer = undefined;
    const every = this.o.intervalMs ?? 6 * 3600_000;
    if (this.disposed || !this.cfg.auto || this.dev || every <= 0) return;
    const run = () => { void this.check().catch(() => {}); };
    this.first = setTimeout(run, this.o.startDelayMs ?? 15_000); this.first.unref?.();
    this.timer = setInterval(run, every); this.timer.unref?.();
  }
  dispose() { this.disposed = true; clearTimeout(this.first); clearInterval(this.timer); this.abort?.abort(); }

  // ---- files ---------------------------------------------------------------------------------------------------------------
  /** Remove partial files and downloads of other versions (keeps `keep`). */
  private cleanDir(keep?: string) {
    try { for (const n of readdirSync(this.dir)) if (n.endsWith(".part") || (n !== keep && n !== (this.manifestAsset?.name))) rmSync(join(this.dir, n), { recursive: true, force: true }); } catch { /* no dir yet */ }
  }
  private emit(e: string, d: unknown) { try { this.o.emit?.(e, d); } catch { /* listener bugs must not break the updater */ } }

  // ---- settings file (device-local: never part of the synced archive). The token is sealed with the data key (AES-256-GCM). --------------------
  private tokenKey() { return this.o.dataKey ? createHmac("sha256", Buffer.from(this.o.dataKey)).update("unichat-update-token").digest() : undefined; }
  private loadConfig() {
    try {
      const j = JSON.parse(readFileSync(this.cfgFile, "utf8"));
      if (typeof j.repo === "string" && REPO_RE.test(j.repo)) this.cfg.repo = j.repo;
      if (j.channel === "stable" || j.channel === "prerelease") this.cfg.channel = j.channel;
      if (typeof j.auto === "boolean") this.cfg.auto = j.auto;
      if (Number.isFinite(j.lastChecked)) this.cfg.lastChecked = j.lastChecked;
      if (typeof j.token === "string") this.cfg.token = this.unseal(j.token);
    } catch { /* first start or unreadable: defaults */ }
  }
  private saveConfig() {
    try {
      mkdirSync(this.o.dataDir, { recursive: true, mode: 0o700 });
      const tmp = this.cfgFile + ".tmp";
      writeFileSync(tmp, JSON.stringify({ repo: this.cfg.repo, channel: this.cfg.channel, auto: this.cfg.auto, lastChecked: this.cfg.lastChecked, token: this.cfg.token ? this.seal(this.cfg.token) : undefined }), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
      renameSync(tmp, this.cfgFile);
    } catch { /* read-only data dir: settings last for this run */ }
  }
  private seal(t: string): string {
    const k = this.tokenKey(); if (!k) return "p:" + Buffer.from(t).toString("base64");
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", k, iv), enc = Buffer.concat([c.update(t, "utf8"), c.final()]);
    return "g:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
  }
  private unseal(s: string): string | undefined {
    try {
      if (s.startsWith("p:")) return Buffer.from(s.slice(2), "base64").toString();
      const k = this.tokenKey(); if (!k || !s.startsWith("g:")) return undefined;
      const b = Buffer.from(s.slice(2), "base64"), d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    } catch { return undefined; }
  }
}
function readTimed(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => { cleanup(); fail(new UpdateError("The download stalled.", "offline")); }, ms);
    const ab = () => { cleanup(); fail(new UpdateError("Cancelled.", "other")); };
    const cleanup = () => { clearTimeout(t); signal.removeEventListener("abort", ab); };
    signal.addEventListener("abort", ab, { once: true });
    reader.read().then((v) => { cleanup(); ok(v); }, (e) => { cleanup(); fail(new UpdateError("The connection was lost during the download.", "offline")); void e; });
  });
}

export function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => { const h = createHash("sha256"); createReadStream(path).on("data", (d) => h.update(d)).on("end", () => ok(h.digest("hex"))).on("error", fail); });
}

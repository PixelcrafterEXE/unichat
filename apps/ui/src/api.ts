// Transport-agnostic client. Same UI, three hosts:
//  - Desktop (Electron): in-process Hub in the main process, via IPC, no network
//  - Android:          Node (nodejs-mobile) in-process, via window.UnimsgNative bridge
//  - Web:              WebSocket to a hosted @unimsg/server (only case needing a server)
import { Heartbeat } from "./heartbeat";
type Listener = (ev: string, data: any) => void;

interface Transport {
  call(method: string, params: object): Promise<any>;
  onEvent(l: Listener): () => void;
}

const w = window as any;

function electronTransport(): Transport {
  return { call: (m, p) => w.unimsg.call(m, p), onEvent: (l) => w.unimsg.onEvent((e: any) => l(e.event, e.data)) };
}

/** Adds the heartbeat (heartbeat.ts) to a transport whose backend can freeze or restart without the page noticing: synthetic "core-connection" events, fail-fast calls while down. */
function withHeartbeat(t: Transport, ls: Set<Listener>, o: { ping: () => Promise<unknown>; restart?: () => Promise<unknown>; intervalMs?: number; retryMs?: number; timeoutMs?: number; restartAfter?: number }): Transport & { hb: Heartbeat } {
  const hb = new Heartbeat({ ...o, emit: (state) => ls.forEach((l) => l("core-connection", { state })), visible: () => typeof document === "undefined" || document.visibilityState !== "hidden" });
  hb.start();
  try {
    const kick = () => hb.kick();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") kick(); });
    document.addEventListener("resume", kick); // Capacitor App plugin / cordova style resume
    window.addEventListener("focus", kick); window.addEventListener("online", kick); window.addEventListener("pageshow", kick);
  } catch { /* no DOM (unit tests of api.ts under plain Node) */ }
  return { hb, call: (m, p) => hb.guard(() => t.call(m, p)), onEvent: t.onEvent };
}

function androidTransport(): Transport {
  const ls = new Set<Listener>();
  w.__unimsgEvent = (json: string) => { const e = JSON.parse(json); ls.forEach((l) => l(e.event, e.data)); };
  const raw: Transport = {
    call: async (m, p) => JSON.parse(await w.UnimsgNative.call(m, JSON.stringify(p))),
    onEvent: (l) => { ls.add(l); return () => ls.delete(l); },
  };
  // $ping goes to Node (through the Java bridge), so a frozen Node, a dead socket and a stale WebView proxy all look the same: no answer.
  // $restartBackend is answered by Java, which pings the backend itself before it restarts the app process.
  return withHeartbeat(raw, ls, { ping: () => raw.call("$ping", {}), restart: () => raw.call("$restartBackend", {}) });
}

const TOKEN_KEY = "unimsg.token";
/** Access token for a hosted backend: from ?token=… (stored, then removed from the address bar) or from this browser's storage. */
export function getToken(): string {
  try {
    const u = new URL(location.href), t = u.searchParams.get("token");
    if (t) { localStorage.setItem(TOKEN_KEY, t); u.searchParams.delete("token"); history.replaceState(null, "", u); return t; }
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch { return ""; }
}
export function setToken(t: string) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } }

/** WebSocket transport with automatic reconnect. Emits the synthetic event "core-connection" {state: "up" | "down"}. */
function wsTransport(baseUrl: string): Transport & { ready: Promise<void> } {
  let n = 0, tries = 0, up = false;
  const pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  const ls = new Set<Listener>();
  let ws!: WebSocket;
  const withToken = () => { const t = getToken(); return t ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : baseUrl; };
  const connect = (first: boolean) => new Promise<void>((ok, fail) => {
    let opened = false;
    ws = new WebSocket(withToken());
    ws.onopen = () => { opened = true; up = true; tries = 0; if (!first) ls.forEach((l) => l("core-connection", { state: "up" })); ok(); };
    ws.onerror = () => { if (!opened && first) fail(new Error("cannot reach the backend at " + baseUrl)); };
    ws.onclose = () => {
      const was = up; up = false;
      pending.forEach((p) => p.err(new Error("Connection to the backend was lost"))); pending.clear();
      if (was) ls.forEach((l) => l("core-connection", { state: "down" }));
      if (opened) setTimeout(() => connect(false).catch(() => {}), Math.min(500 * 2 ** tries++, 8000)); // backend restarted / network blip
      else if (!first) setTimeout(() => connect(false).catch(() => {}), Math.min(500 * 2 ** tries++, 8000));
    };
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.event) return ls.forEach((l) => l(msg.event, msg.data));
      const p = pending.get(msg.id); if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.err(new Error(msg.error)) : p.ok(msg.result);
    };
  });
  return {
    ready: connect(true),
    call: (method, params) => new Promise((ok, err) => {
      if (ws.readyState !== WebSocket.OPEN) return err(new Error("Not connected to the backend. Reconnecting…"));
      const id = ++n; pending.set(id, { ok, err });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    onEvent: (l) => { ls.add(l); return () => ls.delete(l); },
  };
}

export class Core {
  private t: Transport;
  ready: Promise<void> = Promise.resolve();
  constructor() {
    if (new URLSearchParams(location.search).has("mock")) { // the fake backend is its own chunk: it is never downloaded by a real build's users
      const mock = import("./mock").then((m) => m.mockTransport());
      this.ready = mock.then(() => {});
      this.t = { call: (m, p) => mock.then((t) => t.call(m, p)), onEvent: (l) => { let off = () => {}, dead = false; mock.then((t) => { if (!dead) off = t.onEvent(l); }); return () => { dead = true; off(); }; } };
      const hbMs = Number(new URLSearchParams(location.search).get("hb")); // ?mock&hb=200: e2e tests of the heartbeat (window.__mockSilent = true makes the fake backend stop answering)
      if (hbMs > 0) {
        const ls = new Set<Listener>(), inner = this.t; inner.onEvent((e, d) => ls.forEach((l) => l(e, d)));
        const ping = () => ((w.__mockSilent ? new Promise(() => {}) : Promise.resolve({ pong: true })) as Promise<unknown>);
        w.__mockRestarts = 0;
        this.t = withHeartbeat({ call: (m, p) => (m === "$ping" ? ping() : inner.call(m, p)), onEvent: (l) => { ls.add(l); return () => ls.delete(l); } }, ls,
          { ping, restart: async () => { w.__mockRestarts++; setTimeout(() => { w.__mockSilent = false; }, hbMs * 2); }, intervalMs: hbMs, retryMs: hbMs, timeoutMs: hbMs, restartAfter: 6 });
      }
    }
    else if (w.unimsg) this.t = electronTransport();
    else if (w.UnimsgNative) this.t = androidTransport();
    else {
      const t = wsTransport(import.meta.env.VITE_CORE_URL ?? `ws://${location.hostname}:8765/ws`);
      this.ready = t.ready; this.t = t;
    }
  }
  call<T = any>(method: string, params: object = {}): Promise<T> { return this.t.call(method, params); }
  on(l: Listener) { return this.t.onEvent(l); }
}

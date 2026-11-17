// The backend as the live tests see it: `call(method, params)` = one Hub RPC, `events()` = what the backend pushed since the last look.
// Both go through the UI page's own transport (Android: window.UnimsgNative + window.__unimsgEvent; desktop: window.unimsg), reached
// over the Chrome DevTools Protocol, so nothing is mocked and no second backend (which would steal the messenger sessions) is started.
import { Cdp } from "./cdp.mjs";

const HOOK = `(() => {
  if (window.__liveEvents) return "hooked";
  window.__liveEvents = [];
  const push = (event, data) => { window.__liveEvents.push({ t: Date.now(), event, data }); if (window.__liveEvents.length > 5000) window.__liveEvents.splice(0, 1000); };
  if (typeof window.__unimsgEvent === "function") { const prev = window.__unimsgEvent; window.__unimsgEvent = (j) => { try { const e = JSON.parse(j); push(e.event, e.data); } catch {} return prev(j); }; return "android"; }
  if (window.unimsg?.onEvent) { window.unimsg.onEvent((e) => push(e.event, e.data)); return "desktop"; }
  return "none";
})()`;

export class Backend {
  constructor(cdp, kind) { this.cdp = cdp; this.kind = kind; this.cursor = 0; }
  static async connect(devtools = "http://127.0.0.1:9333") {
    const cdp = await Cdp.connect(devtools);
    const kind = await cdp.eval(HOOK);
    if (kind === "none") throw new Error("the page has neither window.UnimsgNative (Android) nor window.unimsg (desktop)");
    const b = new Backend(cdp, kind);
    b.cursor = await cdp.eval("window.__liveEvents.length");
    return b;
  }
  /** One Hub RPC. Errors thrown by the backend arrive as Error with the backend's message. */
  async call(method, params = {}, timeoutMs = 90_000) {
    const p = JSON.stringify(JSON.stringify(params)), m = JSON.stringify(method);
    const expr = this.kind === "android" || this.kind === "hooked"
      ? `UnimsgNative.call(${m}, ${p}).then((r) => JSON.stringify(JSON.parse(r) ?? null))`
      : `window.unimsg.call(${m}, JSON.parse(${p})).then((r) => JSON.stringify(r ?? null))`;
    const r = await this.cdp.eval(expr, timeoutMs);
    return r === undefined ? undefined : JSON.parse(r);
  }
  /** Events pushed since the previous call of events() (oldest first). */
  async events() {
    const list = await this.cdp.eval(`JSON.stringify(window.__liveEvents.slice(${this.cursor}))`);
    const arr = JSON.parse(list); this.cursor += arr.length; return arr;
  }
  close() { this.cdp.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Poll `fn` until it returns a truthy value (returned) or `ms` passed (throws with `what`). */
export async function until(fn, what, ms = 20_000, every = 700) {
  const t0 = Date.now(); let last;
  for (;;) { last = await fn(); if (last) return last; if (Date.now() - t0 > ms) throw new Error(`timeout (${Math.round(ms / 1000)} s) waiting for ${what}`); await sleep(every); }
}

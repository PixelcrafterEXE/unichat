// Minimal Chrome DevTools Protocol client for the live tests (Node 22+: global WebSocket, no dependencies).
// Connects to a page (the UniChat UI running in the Android WebView forwarded with `adb forward`, or an Electron/Chromium page
// started with --remote-debugging-port) and evaluates JavaScript in it. The page's own transport (window.unimsg on the desktop,
// window.UnimsgNative on Android) is used to call the backend, so the tests exercise exactly what the UI exercises.
export class Cdp {
  constructor(ws) { this.ws = ws; this.n = 0; this.pending = new Map(); this.listeners = new Set();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const { ok, fail } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? fail(new Error(m.error.message)) : ok(m.result); } else if (m.method) for (const l of this.listeners) l(m); };
    ws.onclose = () => { for (const { fail } of this.pending.values()) fail(new Error("devtools connection closed")); this.pending.clear(); };
  }
  static async connect(base = "http://127.0.0.1:9333") {
    const pages = await (await fetch(base + "/json")).json();
    const page = pages.find((p) => p.type === "page" && p.webSocketDebuggerUrl);
    if (!page) throw new Error("no debuggable page at " + base);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("cannot open " + page.webSocketDebuggerUrl)); });
    const c = new Cdp(ws); await c.send("Runtime.enable"); return c;
  }
  send(method, params = {}) { const id = ++this.n; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((ok, fail) => this.pending.set(id, { ok, fail })); }
  /** Evaluate an expression (awaited if it is a promise) and return its JSON value; a thrown error is re-thrown here with its message. */
  async eval(expression, timeoutMs = 60_000) {
    const r = await Promise.race([this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }), new Promise((_, f) => setTimeout(() => f(new Error("evaluate timed out: " + expression.slice(0, 80))), timeoutMs))]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "evaluation failed");
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

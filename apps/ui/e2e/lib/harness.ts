// E2E harness: static server for apps/ui/dist, headless Chromium (own profile + debugging port),
// and a small CDP client. Everything is cleaned up even when a test throws.

export type Json = unknown;

/** Serve a directory (SPA fallback to index.html) on a free port. */
export function startStaticServer(dir: string): { url: string; close: () => Promise<void> } {
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png",
    json: "application/json", ico: "image/x-icon", woff2: "font/woff2", webmanifest: "application/manifest+json",
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    if (rel.includes("..")) return new Response("bad path", { status: 400 });
    if (rel.endsWith("/")) rel += "index.html";
    let file = dir + rel;
    try { if (!(await Deno.stat(file)).isFile) throw 0; } catch { file = dir + "/index.html"; }
    const ext = file.split(".").pop() ?? "";
    return new Response(await Deno.readFile(file), { headers: { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
  });
  return { url: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Browser-level CDP connection; pages are sessions attached with flatten:true. */
class Cdp {
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private listeners: ((m: any) => void)[] = [];
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (p) m.error ? p.err(new Error(`${m.error.message}`)) : p.ok(m.result); }
      else for (const l of this.listeners) l(m);
    };
    ws.onclose = () => { for (const p of this.pending.values()) p.err(new Error("CDP connection closed")); this.pending.clear(); };
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((ok, err) => { ws.onopen = () => ok(); ws.onerror = () => err(new Error("CDP websocket failed")); });
    return new Cdp(ws);
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((ok, err) => { const id = ++this.id; this.pending.set(id, { ok, err }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(l: (m: any) => void) { this.listeners.push(l); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/** One headless Chromium with a throwaway profile. */
export class Browser {
  private constructor(private proc: Deno.ChildProcess, private cdp: Cdp, readonly profile: string) {}

  static async launch(): Promise<Browser> {
    const profile = await Deno.makeTempDir({ prefix: "unimsg-e2e-" });
    const proc = new Deno.Command("chromium", {
      args: ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
        "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,900", "about:blank"],
      stdout: "null", stderr: "null",
    }).spawn();
    try {
      let port = 0;
      for (let i = 0; i < 100 && !port; i++) {
        try { port = Number((await Deno.readTextFile(profile + "/DevToolsActivePort")).split("\n")[0]); } catch { await sleep(100); }
      }
      if (!port) throw new Error("Chromium did not report a debugging port");
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      return new Browser(proc, await Cdp.connect(v.webSocketDebuggerUrl), profile);
    } catch (e) {
      try { proc.kill(); } catch { /* ignore */ }
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      throw e;
    }
  }

  /** A fresh, isolated browser context (own localStorage etc.) with one tab. */
  async newPage(): Promise<Page> {
    const { browserContextId } = await this.cdp.send("Target.createBrowserContext", { disposeOnDetach: false });
    const { targetId } = await this.cdp.send("Target.createTarget", { url: "about:blank", browserContextId, width: 1400, height: 900 });
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(this.cdp, sessionId, async () => {
      await this.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
      await this.cdp.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    });
    await page.init();
    return page;
  }

  async close() {
    try { await this.cdp.send("Browser.close"); } catch { /* already gone */ }
    this.cdp.close();
    const t = setTimeout(() => { try { this.proc.kill("SIGKILL"); } catch { /* ignore */ } }, 3000);
    try { await this.proc.status; } catch { /* ignore */ }
    clearTimeout(t);
    await Deno.remove(this.profile, { recursive: true }).catch(() => {});
  }
}

export class TimeoutError extends Error {}

export type WaitOpts = { timeout?: number; interval?: number };

/** Page helpers injected into every document (window.__e2e), so tests can stay short. */
const PAGE_HELPERS = `(()=>{
  const m = (e, t) => t == null || (t && t.re !== undefined ? new RegExp(t.re, t.fl).test(e.textContent) : e.textContent.includes(t));
  const all = (sel, t, root) => [...(root || document).querySelectorAll(sel)].filter((e) => m(e, t));
  const setv = (el, v) => { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); };
  const ctx = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x ?? 200, clientY: y ?? 200 }));
  const row = (name, nth) => all('.chats li', null).filter((l) => l.querySelector('.name')?.textContent.trim() === name)[nth || 0];
  const rows = () => [...document.querySelectorAll('.chats li')].filter((l) => l.querySelector('.name')).map((l) => l.querySelector('.name').textContent.trim());
  const msg = (txt) => [...document.querySelectorAll('.messages .msg')].find((e) => e.innerText.includes(txt));
  const msgs = () => [...document.querySelectorAll('.messages .msg')].map((e) => e.innerText.replace(/\\n/g, ' ').trim());
  const rail = () => [...document.querySelectorAll('.rail .pill')].map((b) => b.getAttribute('title')).filter((t) => !/^(Settings|Add a|New folder|Archived)/.test(t || ''));
  window.__e2e = { all, setv, ctx, row, rows, msg, msgs, rail };
})()`;

export class Page {
  /** assertions recorded by the running test */
  checks: { name: string; ok: boolean; detail: string }[] = [];
  private consoleErrors: string[] = [];
  /** messages of native dialogs (confirm/alert) that were auto-accepted */
  dialogs: string[] = [];
  /** default timeout of wait helpers */
  timeout = 5000;
  constructor(private cdp: Cdp, readonly sessionId: string, private dispose: () => Promise<void>) {}

  async init() {
    await this.send("Page.enable"); await this.send("Runtime.enable");
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await this.initScript(PAGE_HELPERS);
    this.cdp.on((m) => {
      if (m.sessionId !== this.sessionId) return;
      if (m.method === "Page.javascriptDialogOpening") { // a native confirm/alert would freeze every CDP call: accept it
        this.dialogs.push(m.params.message); void this.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
      }
      if (m.method === "Runtime.exceptionThrown") this.consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? "exception");
    });
  }

  send(method: string, params: object = {}) { return this.cdp.send(method, params, this.sessionId); }
  async close() { await this.dispose(); }
  /** uncaught page exceptions seen so far (mock mode should have none) */
  get pageErrors() { return this.consoleErrors; }

  /** Run a script in every document before the page's own scripts (call before open()). */
  initScript(source: string) { return this.send("Page.addScriptToEvaluateOnNewDocument", { source }); }

  /** Evaluate a JS expression in the page (awaits promises) and return its value. */
  async ev<T = any>(expr: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split("\n")[0].slice(0, 300) + "  in: " + expr.slice(0, 160));
    return r.result.value;
  }

  /** Poll an expression until truthy; returns its value. Throws TimeoutError. */
  async waitFor<T = any>(expr: string, o: WaitOpts & { desc?: string } = {}): Promise<T> {
    const end = Date.now() + (o.timeout ?? this.timeout); let last: any, lastErr: any;
    for (;;) {
      try { last = await this.ev(`(()=>{const __v=(${expr}); return (typeof __v==='object'&&__v!==null&&__v instanceof Node)?true:__v})()`); if (last) return last; } catch (e) { lastErr = e; }
      if (Date.now() > end) throw new TimeoutError(`timed out waiting for ${o.desc ?? expr.slice(0, 140)}` + (lastErr ? ` (${lastErr.message.slice(0, 120)})` : ` (last: ${JSON.stringify(last)})`));
      await sleep(o.interval ?? 40);
    }
  }
  /** Wait until the expression is falsy. */
  async waitGone(expr: string, o: WaitOpts = {}): Promise<void> { await this.waitFor(`!(${expr})`, { ...o, desc: "gone: " + expr.slice(0, 120) }); }
  /** Wait for a selector (optionally with text) and return how many matched. */
  waitSel(sel: string, text?: Text, o: WaitOpts = {}) { return this.waitFor(`__e2e.all(${JSON.stringify(sel)},${txt(text)}).length`, { ...o, desc: `selector ${sel} ${text ?? ""}` }); }
  sleep = sleep;

  // ---- assertions (soft: recorded, the test keeps going) ----
  check(name: string, ok: boolean, detail = "") { this.checks.push({ name, ok: !!ok, detail }); return !!ok; }
  /** Wait until expr is truthy (up to timeout), then record a check. */
  async ok(name: string, expr: string, o: WaitOpts = {}) {
    let v: any; try { v = await this.waitFor(expr, o); } catch (e) { return this.check(name, false, (e as Error).message); }
    return this.check(name, !!v, typeof v === "string" ? v.slice(0, 100) : "");
  }
  /** Wait until expr is falsy, then record a check. */
  async not(name: string, expr: string, o: WaitOpts = {}) {
    try { await this.waitGone(expr, o); return this.check(name, true); } catch (e) { return this.check(name, false, (e as Error).message); }
  }
  /** Wait until expr deep-equals `expected` (JSON compare), then record a check with the actual value on failure. */
  async eq(name: string, expr: string, expected: Json, o: WaitOpts = {}) {
    const want = JSON.stringify(expected); let got: any; const end = Date.now() + (o.timeout ?? this.timeout);
    for (;;) {
      try { got = await this.ev(expr); } catch (e) { got = "ERR " + (e as Error).message.slice(0, 100); }
      if (JSON.stringify(got) === want) return this.check(name, true);
      if (Date.now() > end) return this.check(name, false, `expected ${want.slice(0, 120)}, got ${JSON.stringify(got)?.slice(0, 200)}`);
      await sleep(40);
    }
  }
  /** The condition must stay false for `ms` (for "does not appear" checks). */
  async stays(name: string, expr: string, ms = 400) {
    const end = Date.now() + ms;
    do { let v: any; try { v = await this.ev(expr); } catch { v = false; } if (v) return this.check(name, false, "became true: " + expr.slice(0, 100)); await sleep(50); } while (Date.now() < end);
    return this.check(name, true);
  }
  /** Compare a value (already fetched) */
  expectEq(name: string, got: Json, want: Json) { return this.check(name, JSON.stringify(got) === JSON.stringify(want), `expected ${JSON.stringify(want)?.slice(0, 120)}, got ${JSON.stringify(got)?.slice(0, 200)}`); }

  // ---- navigation ----
  base = "";
  /**
   * Load `?mock<extra>` fresh and wait until the app shows its chat list.
   * `settle` additionally waits until the mock's own timed events (typing at 2.5s, a live message at 5s) have happened.
   */
  async open(extra = "", o: { settle?: boolean } = {}) {
    const url = this.base + "/?mock" + extra;
    await this.send("Page.navigate", { url });
    await this.waitFor(`document.readyState==='complete' && !!document.querySelector('.chats li') && document.querySelectorAll('.rail .pillwrap[data-space]').length>=3`, { timeout: 15000, desc: "app to render " + url });
    if (o.settle) await this.waitFor(`performance.now() > 5400`, { timeout: 8000 });
  }
  /** Reload the current URL (new app state, same browser storage). */
  async reload() { await this.send("Page.reload"); await this.waitFor(`document.readyState==='complete' && !!document.querySelector('.chats li') && document.querySelectorAll('.rail .pillwrap[data-space]').length>=3`, { timeout: 15000 }); }
  /** Navigate (storage kept) to a path+query of the app */
  async goto(query: string) { await this.open(query); }

  // ---- interaction ----
  /** Wait for an element (optionally by text) and click it. `nth` picks among several. */
  async click(sel: string, text?: Text, nth = 0) {
    await this.waitFor(`(()=>{const e=__e2e.all(${JSON.stringify(sel)},${txt(text)})[${nth}]; if(!e) return false; e.click(); return true})()`, { desc: `click target ${sel} ${text ?? ""}` });
  }
  /** click the LAST match (e.g. modal primary buttons) */
  async clickLast(sel: string, text?: Text) {
    await this.waitFor(`(()=>{const e=__e2e.all(${JSON.stringify(sel)},${txt(text)}).at(-1); if(!e) return false; e.click(); return true})()`, { desc: `click target ${sel} ${text ?? ""}` });
  }
  /** Dispatch a contextmenu event on a (selector,text) match, or an expression returning an element. */
  async contextMenu(target: string | { sel: string; text?: Text; nth?: number } | { expr: string }, x = 200, y = 200) {
    const get = typeof target === "string" ? `document.querySelector(${JSON.stringify(target)})`
      : "expr" in target ? target.expr : `__e2e.all(${JSON.stringify(target.sel)},${txt(target.text)})[${target.nth ?? 0}]`;
    await this.waitFor(`(${get})`, { desc: "context menu target " + get.slice(0, 100) });
    await this.ev(`__e2e.ctx(${get},${x},${y})`);
  }
  /** Right-click a chat row by its name (nth if names repeat) */
  async rowMenu(name: string, nth = 0) {
    await this.waitFor(`__e2e.row(${JSON.stringify(name)},${nth})`, { desc: `chat row ${name}` });
    await this.ev(`__e2e.ctx(__e2e.row(${JSON.stringify(name)},${nth}))`);
    await this.waitFor(`document.querySelector('.chatmenu')`, { desc: "chat context menu" });
  }
  /** Click an item (by text) in the open chat context menu */
  menuItem(text: Text) { return this.click(".chatmenu button", text); }
  async openRow(name: string, nth = 0) {
    await this.waitFor(`__e2e.row(${JSON.stringify(name)},${nth})`, { desc: `chat row ${name}` });
    await this.ev(`__e2e.row(${JSON.stringify(name)},${nth}).click()`);
  }
  async openChat(id: string) { await this.waitFor(`document.querySelector('[data-chat=${JSON.stringify(id)}]')`, { desc: "chat " + id }); await this.ev(`document.querySelector('[data-chat=${JSON.stringify(id)}]').click()`); await this.waitFor(`document.querySelector('.composer, .composer.ro, main header .titlebtn')`); }
  /** Switch rail space by data-space id */
  async space(id: string) { await this.waitFor(`document.querySelector('[data-space=${JSON.stringify(id)}] button, [data-space=${JSON.stringify(id)}]')`, { desc: "space " + id }); await this.ev(`(document.querySelector('[data-space=${JSON.stringify(id)}] button')||document.querySelector('[data-space=${JSON.stringify(id)}]')).click()`); }
  /** Switch rail space by (title prefix) */
  async pill(titlePrefix: string) { await this.waitFor(`document.querySelector('.rail .pill[title^=${JSON.stringify(titlePrefix)}]')`, { desc: "rail pill " + titlePrefix }); await this.ev(`document.querySelector('.rail .pill[title^=${JSON.stringify(titlePrefix)}]').click()`); }
  /** Set the composer text (React-controlled textarea) without keystrokes. */
  typeIn(text: string) { return this.setInput(".composer textarea", text); }
  /** Set a React-controlled input/textarea/select value. */
  async setInput(sel: string, value: string) {
    await this.waitFor(`document.querySelector(${JSON.stringify(sel)})`, { desc: "input " + sel });
    await this.ev(`__e2e.setv(document.querySelector(${JSON.stringify(sel)}),${JSON.stringify(value)})`);
  }
  /** Press Enter in the composer (sends). */
  enter() { return this.ev(`document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`); }
  /** Type at the real caret using CDP text insertion (fires beforeinput/input like a keyboard). */
  async insertText(text: string) { await this.send("Input.insertText", { text }); }
  /** Real key press. */
  async key(k: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Escape") {
    const codes = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Tab: 9, Escape: 27 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: codes[k] });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: codes[k] });
  }
  async mouseMove(x: number, y: number) { await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); }
  async mouseClick(x: number, y: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }
  /** Put files into an <input type=file> through DOM.setFileInputFiles (real upload path). */
  async upload(selector: string, files: string[]) {
    await this.waitFor(`document.querySelector(${JSON.stringify(selector)})`, { desc: "file input " + selector });
    const doc = await this.send("DOM.getDocument", { depth: 0 });
    const q = await this.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    await this.send("DOM.setFileInputFiles", { nodeId: q.nodeId, files });
  }
  /** Synthetic drag and drop between two elements (expressions returning elements). */
  async drag(fromExpr: string, toExpr: string) {
    await this.ev(`(()=>{const from=${fromExpr}, to=${toExpr}; const dt=new DataTransfer(); from.dispatchEvent(new DragEvent('dragstart',{dataTransfer:dt,bubbles:true})); to.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true})); to.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));})()`);
  }
  /** Send a text through the composer and wait for it to appear in the timeline. */
  async send_(text: string) { await this.typeIn(text); await this.enter(); await this.waitFor(`__e2e.msg(${JSON.stringify(text)})`, { desc: "sent message " + text }); }

  /**
   * Emulate a device: `phone` = Galaxy A33 (412x915), `small` = 360x800, `tablet` = 768x1024; touch events, mobile UA, (pointer: coarse).
   * Call before open().
   */
  async device(name: "phone" | "small" | "tablet", landscape = false) {
    const d = { phone: [412, 915], small: [360, 800], tablet: [768, 1024] }[name];
    const [w, h] = landscape ? [d[1], d[0]] : d;
    await this.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: landscape ? "landscapePrimary" : "portraitPrimary", angle: landscape ? 90 : 0 } });
    await this.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await this.send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 15; SM-A336B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" });
  }
  /** One finger: touch down at (x,y), hold `holdMs`, lift. */
  async touch(x: number, y: number, holdMs = 40) {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(holdMs);
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  /** Centre of an element (expression) in CSS px, scrolled into view first. */
  async centre(expr: string): Promise<{ x: number; y: number }> {
    return await this.waitFor(`(()=>{const e=${expr}; if(!e) return false; e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`, { desc: "touch target " + expr.slice(0, 100) });
  }
  async tap(expr: string) { const c = await this.centre(expr); await this.touch(c.x, c.y); }
  /** One finger: down at (x,y), dragged by (dx,dy) in `steps` moves, then lifted. */
  async swipe(x: number, y: number, dx: number, dy = 0, steps = 8) {
    await this.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i++) {
      await this.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: Math.round(x + (dx * i) / steps), y: Math.round(y + (dy * i) / steps) }] });
      await sleep(16);
    }
    await this.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  /** Swipe starting at the centre of an element (expression). */
  async swipeOn(expr: string, dx: number, dy = 0) { const c = await this.centre(expr); await this.swipe(c.x, c.y, dx, dy); }
  async longPress(expr: string, ms = 650) { const c = await this.centre(expr); await this.touch(c.x, c.y, ms); }
  /** set by the runner: where named screenshots go (undefined = do not take them) */
  shotDir?: string;
  fixturesDir = "";
  fixture(name: string) { return this.fixturesDir + "/" + name; }
  /** Named reference screenshot (only taken with --update-shots; for humans, never diffed). */
  async shot(name: string) { if (this.shotDir) await this.screenshot(`${this.shotDir}/${name}.png`); }

  async screenshot(path: string) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
  }
}

export type Text = string | RegExp;
/** serialise a text filter for __e2e.all (string => includes, RegExp => test) */
export function txt(t?: Text): string {
  if (t === undefined) return "null";
  return t instanceof RegExp ? `{re:${JSON.stringify(t.source)},fl:${JSON.stringify(t.flags)}}` : JSON.stringify(t);
}

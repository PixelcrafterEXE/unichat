// Performance budgets on the big mock dataset (?mock&big=1: ~600 chats, 100k messages, one chat with 10k, 20 merged chats).
// The thresholds are deliberately generous (3-6x what a laptop measures) so they only trip on real regressions, not on a busy CI box.
// Every test also writes its numbers to e2e/out/perf-<name>.json; `deno run -A e2e/run.ts -f perf -j 1` gives clean numbers for PERF.md.
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";

/** Records first-row time and long tasks (>50 ms) from the very start of the document. */
const OBSERVE = `window.__lt=[];window.__first=0;window.__t0=performance.now();
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__lt.push([Math.round(e.startTime),Math.round(e.duration)])}).observe({type:'longtask',buffered:true})}catch(e){}
new MutationObserver(()=>{if(!window.__first&&document.querySelector('.chats li[data-chat]'))window.__first=performance.now()}).observe(document,{childList:true,subtree:true});`;

const num = (n: number) => Math.round(n * 10) / 10;
async function record(t: Page, name: string, data: Record<string, number | string>) {
  console.log(`PERF ${name} ${JSON.stringify(data)}`);
  const dir = t.fixturesDir.replace(/fixtures$/, "out");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/perf-${name}.json`, JSON.stringify(data, null, 1));
}
async function heap(t: Page) {
  const m: Record<string, number> = {}; for (const x of (await t.send("Performance.getMetrics")).metrics) m[x.name] = x.value;
  return { heapMB: num(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, listeners: m.JSEventListeners };
}
const longest = (t: Page, from = 0) => t.ev<number>(`Math.max(0,...window.__lt.filter(x=>x[0]>=${from}).map(x=>x[1]))`);

export default [
  test("big mock: first render and time to interactive", async (t) => {
    await t.send("Performance.enable");
    await t.open("&big=1");
    await t.waitFor(`window.__first>0`);
    const first = await t.ev<number>(`window.__first`);
    await t.sleep(700);
    const lastEnd = await t.ev<number>(`Math.max(0,...window.__lt.map(x=>x[0]+x[1]))`);
    const rows = await t.ev<number>(`document.querySelectorAll('.chats li[data-chat]').length`);
    const total = await t.ev<number>(`window.__bigMessages`);
    const mem = await heap(t);
    await record(t, "first-render", { firstRowMs: num(first), ttiMs: num(Math.max(first, lastEnd)), longestTaskMs: await longest(t), domRows: rows, messagesInDataset: total, ...mem });
    t.check("dataset has 600+ chats and 100k messages", (await t.ev<number>(`window.__bigMessages`)) >= 100000);
    t.check("first row rendered within 4 s", first < 4000, `${first} ms`);
    t.check("time to interactive within 6 s", Math.max(first, lastEnd) < 6000, `${lastEnd} ms`);
    t.check("no single task blocks the page for more than 1.2 s on start", (await longest(t)) < 1200);
    t.check("DOM stays small (chat list is windowed)", rows < 250, `${rows} rows in the DOM`);
  }, { init: OBSERVE, timeout: 90000 }),

  test("big mock: switching chats is fast", async (t) => {
    await t.open("&big=1");
    await t.waitFor(`document.querySelectorAll('.chats li[data-chat]').length>10`);
    const times = await t.ev<number[]>(`(async()=>{
      const out=[]; const ids=[...document.querySelectorAll('.chats li[data-chat]')].slice(0,14).map(e=>e.dataset.chat);
      for(const id of ids){ const row=document.querySelector('[data-chat="'+id+'"]'); if(!row) continue; const name=row.querySelector('.name')?.textContent.trim();
        const t0=performance.now(); row.click();
        await new Promise(res=>{const f=()=>{ if(document.querySelector('.composer textarea, .composer.ro')&&!document.querySelector('.messages .loading')&&document.querySelector('.titlebtn')?.textContent.includes(name)&&document.querySelector('.messages .msg')) res(); else requestAnimationFrame(f)}; f()});
        await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); out.push(Math.round(performance.now()-t0)); }
      return out})()`);
    const sorted = [...times].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)], max = sorted.at(-1)!;
    await record(t, "chat-switch", { medianMs: med, maxMs: max, samples: times.join(",") });
    t.check("switched at least 8 chats", times.length >= 8, String(times.length));
    t.check("median chat switch < 400 ms", med < 400, `${med} ms`);
    t.check("slowest chat switch < 1200 ms", max < 1200, `${max} ms`);
  }, { timeout: 90000 }),

  test("big mock: scrolling 5000 loaded messages has no long task over 200 ms", async (t) => {
    await t.send("Performance.enable");
    await t.open("&big=1&chat=mx-1:big-grp0");
    await t.waitSel(".messages .msg");
    // page back through the 10k history until 5000 messages are loaded (the button pages 50 at a time)
    const loadStart = Date.now();
    const TARGET = Number(Deno.env.get("PERF_TARGET") ?? 5000);
    const loaded = await t.ev<number>(`(async()=>{ let n=0; for(let i=0;i<120;i++){ const b=document.querySelector('.loadmore'); if(!b) break; b.click(); await new Promise(r=>setTimeout(r,70)); while(document.querySelector('.loadmore')?.disabled) await new Promise(r=>setTimeout(r,30)); n=window.__loaded?.() ?? 0; if(+(document.querySelector(".messages")?.dataset.count||0)>=${TARGET}) break; } return +(document.querySelector('.messages')?.dataset.count||0)})()`, ).catch(() => 0);
    const loadMs = Date.now() - loadStart;
    const mem = await heap(t);
    const start = await t.ev<number>(`performance.now()`);
    const res = await t.ev<{ frames: number; worst: number; over100: number }>(`(async()=>{
      const box=document.querySelector('.messages'); box.scrollTop=box.scrollHeight; await new Promise(r=>setTimeout(r,200));
      let last=performance.now(), worst=0, over100=0, frames=0;
      await new Promise(done=>{const step=()=>{ const now=performance.now(); const d=now-last; last=now; frames++; if(frames>1){worst=Math.max(worst,d); if(d>100)over100++}
        if(box.scrollTop<=400) return done(); box.scrollTop=Math.max(0,box.scrollTop-900); requestAnimationFrame(step)}; requestAnimationFrame(step)});
      return {frames,worst:Math.round(worst),over100}})()`);
    const lt = await longest(t, start);
    await record(t, "scroll", { loadedMessages: loaded, loadMs, scrollFrames: res.frames, worstFrameMs: res.worst, framesOver100ms: res.over100, longestTaskMs: lt, domMsgs: await t.ev<number>(`document.querySelectorAll('.messages .msg').length`), ...mem });
    t.check("5000 messages were loaded", loaded >= TARGET, `${loaded}`);
    t.check("no long task over 200 ms while scrolling", lt < 200, `${lt} ms`);
    t.check("DOM is capped while scrolling (windowed message list)", (await t.ev<number>(`document.querySelectorAll('.messages .msg').length`)) < 700);
  }, { init: OBSERVE, timeout: 180000 }),

  test("big mock: 200 incoming messages per second are absorbed", async (t) => {
    await t.send("Performance.enable");
    await t.open("&big=1&chat=wa-1:big-dm1");
    await t.waitSel(".messages .msg");
    const start = await t.ev<number>(`performance.now()`);
    const r = await t.ev<{ sent: number; ms: number; worstGap: number }>(`(async()=>{
      const ids=[...document.querySelectorAll('.chats li[data-chat]')].map(e=>e.dataset.chat).filter(Boolean); const open='wa-1:big-dm1'; let sent=0, last=performance.now(), worstGap=0; const t0=performance.now();
      let raf=true; (function loop(){ const n=performance.now(); worstGap=Math.max(worstGap,n-last); last=n; if(raf) requestAnimationFrame(loop)})();
      for(let sec=0; sec<3; sec++){ const s=performance.now(); for(let i=0;i<200;i++){ __mockInject(i%4===0?open:ids[(sec*200+i)%ids.length],'Ana','storm '+sec+'-'+i); sent++; if(i%20===19) await new Promise(r=>setTimeout(r,100)); } const left=1000-(performance.now()-s); if(left>0) await new Promise(r=>setTimeout(r,left)); }
      await new Promise(r=>setTimeout(r,500)); raf=false; return {sent,ms:Math.round(performance.now()-t0),worstGap:Math.round(worstGap)}})()`);
    const lt = await longest(t, start);
    await t.waitFor(`__e2e.msg('storm 2-196')`, { timeout: 8000, desc: "last message of the open chat shown" }).catch(() => {});
    await record(t, "event-storm", { sent: r.sent, ms: r.ms, worstFrameGapMs: r.worstGap, longestTaskMs: lt, ...(await heap(t)) });
    t.check("600 events delivered", r.sent === 600);
    t.check("open chat shows the latest message", await t.ev<boolean>(`!!__e2e.msg('storm 2-196')`));
    t.check("no task over 300 ms during the storm", lt < 300, `${lt} ms`);
    t.check("frames never stall for 1 s", r.worstGap < 1000, `${r.worstGap} ms`);
  }, { init: OBSERVE, timeout: 90000 }),

  test("big mock: opening the 10k chat renders one page and stays small", async (t) => {
    await t.send("Performance.enable");
    await t.open("&big=1&chat=mx-1:big-grp0");
    await t.waitSel(".messages .msg");
    t.check("only the newest page is rendered at first", (await t.ev<number>(`document.querySelectorAll('.messages .msg').length`)) <= 120);
    t.check("memory stays reasonable (< 400 MB heap)", (await heap(t)).heapMB < 400);
  }, { timeout: 60000 }),
];

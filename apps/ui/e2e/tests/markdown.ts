// Discord markdown in message bubbles (#98): headings, emphasis, code, quotes, lists, spoilers, masked links; plain elsewhere.
import { test } from "../lib/test.ts";

const MSG = `[...document.querySelectorAll('.messages .msg')].find(m=>/Trip plan/.test(m.textContent))`;

export default [
  test("Discord markdown renders as formatting, never as raw markers or HTML", async (t) => {
    await t.open("&chat=dc-2:dana");
    await t.waitFor(MSG);
    const q = (sel: string) => `(${MSG}).querySelector(${JSON.stringify(sel)})`;
    await t.ok("heading, bold inside", `(()=>{const h=${q(".mdh.h1")}; return !!h && h.textContent==="Trip plan" && !!h.querySelector('strong')})()`);
    await t.ok("subtext", `${q(".mdsub")}?.textContent==="draft, ask before sharing"`);
    await t.ok("italic, strike, underline", `!!${q("em")} && ${q("s")}?.textContent==="8:00" && ${q("u")}?.textContent==="sharp"`);
    await t.eq("list items with nesting", `[...(${MSG}).querySelectorAll('.mdli')].map(l=>l.textContent).join('|')`, "•rope|•harness|•spare carabiner|1.drive|2.climb");
    await t.ok("quote", `${q(".mdquote")}?.textContent==="the forecast says sun"`);
    await t.ok("inline code keeps its stars", `${q(".icode")}?.textContent==="npm i **not bold**"`);
    await t.ok("code block keeps its text and language", `(()=>{const p=${q("pre.codeblock")}; return !!p && p.dataset.lang==="js" && /\\*\\*no markup here\\*\\*/.test(p.textContent)})()`);
    await t.ok("snake_case is not italic", `/snake_case_stays/.test((${MSG}).textContent)`);
    await t.ok("no raw markers left outside code", `(()=>{const c=(${MSG}).cloneNode(true); c.querySelectorAll('.icode,pre,.mfoot').forEach(e=>e.remove()); return !/\\*\\*|~~|__|\\|\\||^#/m.test(c.textContent)})()`);
    // spoiler: hidden until tapped
    await t.ok("spoiler hidden", `(()=>{const s=${q("[data-spoiler]")}; return !!s && !s.classList.contains('open') && getComputedStyle(s.firstElementChild).visibility==='hidden'})()`);
    await t.click(".msg [data-spoiler]");
    await t.ok("spoiler revealed", `${q("[data-spoiler]")}.classList.contains('open')`);
    // masked links name where they go
    await t.ok("masked link shows its host", `(()=>{const a=[...(${MSG}).querySelectorAll('a[data-masked]')].find(a=>a.textContent==='the topo'); return !!a && a.getAttribute('href')==='https://example.org/topo_v2' && /example\\.org/.test(a.nextElementSibling?.textContent||'')})()`);
    await t.ok("the deceptive link shows its real host too", `[...(${MSG}).querySelectorAll('.linkdest')].some(e=>/evil\\.example/.test(e.textContent))`);
    await t.ok("no HTML injected", `!(${MSG}).querySelector('script,iframe,img[onerror]')`);
    await t.shot("discord-markdown");
  }),
  test("the chat list preview and other networks stay plain", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    await t.ok("no markdown elements outside Discord", `!document.querySelector('.messages .tx.rich')`);
  }),
];

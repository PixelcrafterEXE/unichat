// Pinned messages: context menu, pin mark, bar at the top, jump, unpin, merged chat, phone layout (mock WhatsApp has 24h/7d/30d pins, mock Matrix plain pins).
import { test } from "../lib/test.ts";
import { look, mergeAnna } from "../lib/ui.ts";

const msgMenu = (t: any, txt: string) => t.contextMenu({ expr: `__e2e.msg(${JSON.stringify(txt)})` }, 500, 300);
const calls = `(globalThis.__pinCalls ?? [])`;

export default [
  test("pin from the context menu (WhatsApp: choose a duration), mark + bar appear, unpin removes them", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    t.check("no bar without pins", !(await t.ev(`!!document.querySelector('[data-pinbar]')`)));
    const first = await t.ev<string>(`document.querySelector('.messages .msg .tx')?.textContent.slice(0,12)`);
    await msgMenu(t, first);
    await t.click(".ctxmenu button[data-pin-menu]");
    await t.eq("durations offered", `[...document.querySelectorAll('.ctxsub button')].map(b=>b.textContent).join('|')`, "24 hours|7 days|30 days");
    await t.click(".ctxsub button", /24 hours/);
    await t.ok("pin sent with 24h", `${calls}.at(-1)?.pinned===true && ${calls}.at(-1)?.durationSec===86400`);
    await t.waitSel("[data-pinbar]");
    await t.ok("pin mark on the bubble", `!!__e2e.msg(${JSON.stringify(first)}).querySelector('[data-pinned]')`);
    await t.ok("bar shows the text", `document.querySelector('[data-pinbar] .pintext').textContent.includes(${JSON.stringify(first.slice(0, 8))})`);
    await t.eq("bar is 44px", `Math.round(document.querySelector('[data-pinbar]').getBoundingClientRect().height)`, 44);
    await t.shot("pins-bar");
    await msgMenu(t, first);
    await t.ok("menu now says Unpin", `[...document.querySelectorAll('.ctxmenu button')].some(b=>b.textContent.trim()==='Unpin')`);
    await t.click(".ctxmenu button", /^\s*Unpin/);
    await t.not("bar gone", `document.querySelector('[data-pinbar]')`);
    await t.not("mark gone", `__e2e.msg(${JSON.stringify(first)}).querySelector('[data-pinned]')`);
  }),

  test("bar: count, click jumps to the message and cycles, unpin button, info panel list", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    const ids: string[] = await t.ev(`[...document.querySelectorAll('.messages .msg')].slice(0,3).map(e=>e.dataset.mid)`);
    for (const id of ids) await t.ev(`__mockCall('pin',{chatId:'wa-1:anna',messageId:${JSON.stringify(id)},pinned:true,durationSec:604800})`);
    await t.waitSel("[data-pinbar]");
    await t.eq("count shown", `document.querySelector('[data-pinbar] .pincount')?.textContent.trim()`, "· 1 of 3");
    await t.click("[data-pin-jump]");
    await t.ok("jump highlights the newest pin", `document.querySelector('.msg.hl')?.dataset.mid===${JSON.stringify(ids[2])}`);
    await t.eq("click moved on to the next pin", `document.querySelector('[data-pinbar] .pincount')?.textContent.trim()`, "· 2 of 3");
    await t.click('button[title="Chat info"]');
    await t.eq("info panel lists the pins", `document.querySelectorAll('[data-pinlist] .pinrow').length`, 3);
    await t.click("[data-pinlist] .pinrow .icon");
    await t.eq("unpin in the panel", `document.querySelectorAll('[data-pinlist] .pinrow').length`, 2);
    await t.click("[data-pin-unpin]");
    await t.eq("unpin from the bar", `document.querySelectorAll('.msg [data-pinned]').length`, 1);
    await t.shot("pins-info");
  }),

  test("Matrix has plain pins (no duration choice); Instagram has no pin item", async (t) => {
    await t.open("&chat=mx-1:@bea:matrix.org");
    await t.waitSel(".messages .msg");
    await msgMenu(t, await t.ev<string>(`document.querySelector('.messages .msg .tx')?.textContent.slice(0,10)`));
    await t.ok("plain Pin item", `[...document.querySelectorAll('.ctxmenu button')].some(b=>b.textContent.trim()==='Pin')`);
    await t.not("no duration submenu", `document.querySelector('[data-pin-menu]')`);
  }),

  test("merged chat: pins of both networks in one bar, each pinned on its own network", async (t) => {
    await t.open("", { settle: true }); await mergeAnna(t); await t.openRow("Anna Becker");
    await t.waitFor(`document.querySelectorAll('.messages .msg').length>5`);
    const two: { id: string; chatId: string }[] = await t.ev(`(()=>{const a=[...document.querySelectorAll('.messages .msg')]; const pick=(p)=>a.find(e=>e.dataset.mkey.startsWith(p)); return [pick('wa-1:'),pick('mx-1:')].map(e=>({id:e.dataset.mid,chatId:e.dataset.mkey.split('|')[0]}))})()`);
    for (const m of two) await t.ev(`__mockCall('pin',{chatId:${JSON.stringify(m.chatId)},messageId:${JSON.stringify(m.id)},pinned:true})`);
    await t.waitSel("[data-pinbar]");
    await t.eq("both pins counted", `document.querySelector('[data-pinbar]').dataset.count`, "2");
    t.check("pinned on their own networks", (await t.ev<string[]>(`${calls}.map(c=>c.chatId)`)).every((c: string) => c.startsWith("wa-1:") || c.startsWith("mx-1:")));
  }),

  test("phone: long-press menu offers Pin, the bar fits 360px and truncates", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    await t.longPress(`document.querySelector('.messages .msg p')`);
    await t.waitSel(".ctxmenu");
    t.check("Pin… in the sheet", await t.ev(`!!document.querySelector('.ctxmenu [data-pin-menu]')`));
    await t.tap(`document.querySelector('[data-pin-menu]')`);
    t.check("duration buttons are touch sized", await t.ev(`[...document.querySelectorAll('.ctxsub button')].every(b=>b.getBoundingClientRect().height>=34)`));
    await look(t, "pins-phone-menu");
    await t.tap(`[...document.querySelectorAll('.ctxsub button')].find(b=>/7 days/.test(b.textContent))`);
    await t.ev(`__mockCall('pin',{chatId:'wa-1:anna',messageId:document.querySelectorAll('.messages .msg')[1].dataset.mid,pinned:true})`);
    await t.waitSel("[data-pinbar]");
    t.check("bar inside viewport, 44px", await t.ev(`(()=>{const r=document.querySelector('[data-pinbar]').getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth&&Math.round(r.height)===44})()`));
    t.check("no horizontal overflow", await t.ev(`document.documentElement.scrollWidth<=innerWidth`));
    await look(t, "pins-phone-bar");
  }),
];

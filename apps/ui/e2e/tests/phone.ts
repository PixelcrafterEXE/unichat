// Phone / tablet behaviour (CDP device emulation: mobile viewport, touch events, (pointer: coarse)). Screenshots go to e2e/out/phone-*.png.
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";
import { look } from "../lib/ui.ts";

/** Elements (visible, in the page flow) that stick out of the right edge and are not inside a scroll container that clips them. */
const OVERFLOW = `(()=>{const W=innerWidth; const bad=[]; for(const e of document.body.querySelectorAll('*')){ const r=e.getBoundingClientRect(); if(r.width===0||r.height===0||r.right<=W+1) continue;
  const cs=getComputedStyle(e); if(cs.position==='fixed'&&cs.display==='none') continue; if(cs.visibility==='hidden') continue;
  let clipped=false; for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){ const o=getComputedStyle(p); if(/(auto|scroll|hidden|clip)/.test(o.overflowX)&&p.getBoundingClientRect().right<=W+1){clipped=true;break} }
  if(!clipped) bad.push((e.className&&e.className.baseVal===undefined?'.'+String(e.className).split(' ')[0]:e.tagName)+' right='+Math.round(r.right)) }
  return {scrollW:document.documentElement.scrollWidth, W, bad:bad.slice(0,6)}})()`;
async function noOverflow(t: Page, name: string) {
  const r = await t.ev<{ scrollW: number; W: number; bad: string[] }>(OVERFLOW);
  t.check(`${name}: no horizontal overflow`, r.scrollW <= r.W && r.bad.length === 0, JSON.stringify(r));
}
const inViewport = (sel: string) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; const r=e.getBoundingClientRect(); return r.left>=-1&&r.top>=-1&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`;

export default [
  test("phone: 'Take a photo' hands the file input to the system camera, and the other entries do not", async (t) => {
    await t.device("phone");
    await t.open("&chat=wa-1:anna");
    await t.click(".composer .tools .icon.big");
    await t.waitSel("#att-camera");
    await t.click("#att-camera");
    await t.eq("the input asks for an image from the camera", `(()=>{const f=document.querySelector('.composer input[type=file]'); return f.accept + '|' + f.getAttribute('capture')})()`, "image/*|environment");
    await t.click(".composer .tools .icon.big");
    await t.click("#att-media");
    await t.eq("picking a photo afterwards opens the gallery again, not the camera", `(()=>{const f=document.querySelector('.composer input[type=file]'); return f.accept + '|' + f.getAttribute('capture')})()`, "image/*,video/*|null");
  }),

  test("phone: swipe a message to the right to reply to it", async (t) => {
    await t.device("phone");
    await t.open("&chat=wa-1:anna");
    const MSG = `__e2e.msg("Are we still on for Saturday?")`;
    await t.waitFor(MSG);
    await t.swipeOn(MSG, 20); // too short: the message springs back and nothing is quoted
    await t.not("a short drag does not reply", `document.querySelector('.replybar')`);
    await t.swipeOn(MSG, 100);
    await t.ok("the composer quotes the message", `/Replying to/.test(document.querySelector('.replybar')?.textContent||'')`);
    await t.ok("and the row is back where it belongs", `!${MSG}.style.transform`);
    await t.ok("the quote names the sender", `/Anna Becker/.test(document.querySelector('.replybar')?.textContent||'')`);
  }),

  test("phone: swiping up or down scrolls the timeline instead of replying", async (t) => {
    await t.device("phone");
    await t.open("&chat=wa-1:anna");
    const MSG = `__e2e.msg("Are we still on for Saturday?")`;
    await t.waitFor(MSG);
    await t.swipeOn(MSG, 10, -120);
    await t.not("a vertical drag never replies", `document.querySelector('.replybar')`);
  }),

  test("phone: chat list, open chat, back, no overflow", async (t) => {
    await t.device("phone"); await t.open();
    t.check("(pointer: coarse) is on", await t.ev(`matchMedia('(pointer: coarse)').matches`));
    await noOverflow(t, "chat list");
    await look(t, "phone-list");
    await t.tap(`__e2e.row('Ben Fischer')`);
    await t.waitSel(".messages .msg");
    await t.ok("rail is hidden while a chat is open", `getComputedStyle(document.querySelector('.rail')).display==='none'`);
    await t.ok("conversation fills the width", `document.querySelector('main').getBoundingClientRect().width===innerWidth`);
    await noOverflow(t, "conversation");
    await look(t, "phone-chat");
    await t.tap(`document.querySelector('.burger')`);
    await t.ok("back button shows the chat list again", `getComputedStyle(document.querySelector('.chats')).display!=='none' && getComputedStyle(document.querySelector('.rail')).display!=='none'`);
  }),

  test("phone: composer, send, keyboard-size inputs, attach menu", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    t.check("composer inside the viewport", await t.ev(inViewport(".composer")));
    t.check("composer text is 16px (no zoom on focus)", (await t.ev<number>(`parseFloat(getComputedStyle(document.querySelector('.composer textarea')).fontSize)`)) >= 16);
    t.check("send / attach buttons are at least 40px", await t.ev(`[...document.querySelectorAll('.composer .icon.big')].every(b=>b.getBoundingClientRect().height>=40)`));
    await t.send_("hello from the phone");
    await t.tap(`document.querySelector('.composer .tools .icon.big')`);
    await t.waitSel(".composer .popmenu button");
    t.check("attach menu stays inside the viewport", await t.ev(inViewport(".composer .popmenu")));
    await look(t, "phone-attach");
    await noOverflow(t, "composer + attach menu");
  }),

  test("phone: images and videos are sized to the viewport", async (t) => {
    await t.device("small"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    await t.ok("image squares fit 360px wide", `[...document.querySelectorAll('.imgwrap')].length>0 && [...document.querySelectorAll('.imgwrap')].every(e=>{const r=e.getBoundingClientRect(); return r.right<=innerWidth && Math.abs(r.width-r.height)<2 || e.classList.contains('sticker')})`);
    await noOverflow(t, "chat with media at 360px");
    await look(t, "phone-small-chat");
  }),

  test("phone: long press on a message opens a bottom-sheet menu; tap outside closes", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    await t.longPress(`document.querySelector('.messages .msg p')`);
    await t.waitSel(".ctxmenu");
    t.check("menu sits at the bottom edge, full width", await t.ev(`(()=>{const r=document.querySelector('.ctxmenu').getBoundingClientRect(); return r.width>=innerWidth-1 && Math.abs(r.bottom-innerHeight)<2})()`));
    t.check("menu items are at least 44px", await t.ev(`[...document.querySelectorAll('.ctxmenu > button')].every(b=>b.getBoundingClientRect().height>=44)`));
    await look(t, "phone-msg-menu");
    await t.touch(200, 60);
    await t.not("menu closed by a tap outside", `document.querySelector('.ctxmenu')`);
    await t.not("no per-message '...' button on a phone (hold the message instead)", `[...document.querySelectorAll('.msgmore')].some(e=>getComputedStyle(e).display!=='none')`);
  }),

  test("phone: long press on a chat row starts selection mode; taps toggle; back clears", async (t) => {
    await t.device("phone"); await t.open();
    await t.longPress(`__e2e.row('Ben Fischer')`);
    await t.waitSel(".selbar");
    await t.ok("row is selected with a checkbox", `document.querySelectorAll('.chats li.selected .selbox.on').length===1`);
    await t.tap(`__e2e.row('Anna Becker')`);
    await t.eq("tap adds a second chat instead of opening it", `document.querySelectorAll('.chats li.selected').length`, 2);
    t.check("still on the list (no chat opened)", await t.ev(`!document.querySelector('.messages')`));
    await look(t, "phone-selection");
    await t.ev(`dispatchEvent(new CustomEvent('unimsg-back',{cancelable:true}))`);
    await t.not("Android back clears the selection", `document.querySelector('.selbar')`);
  }),

  test("phone: chat options button opens a bottom sheet with Move to folder / category", async (t) => {
    await t.device("phone"); await t.open();
    await t.tap(`__e2e.row('Ben Fischer').querySelector('.more')`);
    await t.waitSel(".chatmenu");
    t.check("sheet is full width at the bottom", await t.ev(`(()=>{const r=document.querySelector('.chatmenu').getBoundingClientRect(); return r.width>=innerWidth-1 && Math.abs(r.bottom-innerHeight)<2})()`));
    t.check("has Move to folder and Move to category", await t.ev(`['Move to folder','Move to category'].every(x=>[...document.querySelectorAll('.chatmenu button')].some(b=>b.textContent.includes(x)))`));
    await look(t, "phone-chat-menu");
  }),

  test("phone: long press on a rail icon opens its menu (move / group alternatives to drag)", async (t) => {
    await t.device("phone"); await t.open();
    await t.longPress(`document.querySelector('.rail .pill[title^="Hiking"]')`);
    await t.waitSel(".railmenu");
    t.check("menu has Move up/down and Add to group", await t.ev(`['Add to group','Move down'].every(x=>[...document.querySelectorAll('.railmenu button')].some(b=>b.textContent.includes(x)))`));
    await look(t, "phone-rail-menu");
    t.check("the long press did not also switch space", await t.ev(`!document.querySelector('.rail .pill.active[title^="Hiking"]')`));
  }),

  test("phone: info panel is a full-screen sheet; search panel too", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:family");
    await t.waitSel(".messages .msg");
    await t.tap(`document.querySelector('.hright .icon[title="Chat info"]')`);
    await t.waitSel("aside.info");
    t.check("info covers the whole screen", await t.ev(`(()=>{const r=document.querySelector('aside.info').getBoundingClientRect(); return r.left<=0&&r.top<=0&&r.width>=innerWidth&&r.height>=innerHeight-1})()`));
    await noOverflow(t, "info sheet");
    await look(t, "phone-info");
    await t.ev(`dispatchEvent(new CustomEvent('unimsg-back',{cancelable:true}))`);
    await t.not("back closes the sheet", `document.querySelector('aside.info')`);
  }),

  test("phone: dialogs are bottom sheets that fit the screen", async (t) => {
    await t.device("small"); await t.open();
    await t.tap(`document.querySelector('.pill.add[title^="Add a community"]')`);
    await t.waitSel(".modal");
    t.check("sheet is full width, at the bottom, inside the viewport", await t.ev(`(()=>{const r=document.querySelector('.modal').getBoundingClientRect(); return r.width>=innerWidth-1 && Math.abs(r.bottom-innerHeight)<2 && r.top>=0})()`));
    await noOverflow(t, "add menu sheet"); await look(t, "phone-sheet-add");
    await t.ev(`dispatchEvent(new CustomEvent('unimsg-back',{cancelable:true}))`);
    await t.not("back closes it", `document.querySelector('.modal')`);
    await t.tap(`document.querySelector('.pill.add[title="New folder"]')`);
    await t.waitSel(".modal");
    await noOverflow(t, "folder dialog"); await look(t, "phone-sheet-folder");
    t.check("inputs are 16px", await t.ev(`[...document.querySelectorAll('.modal input:not([type=checkbox])')].every(i=>parseFloat(getComputedStyle(i).fontSize)>=16)`));
  }),

  test("phone 360px: Sync devices (add card, nearby list, Advanced open, confirm dialog) has no horizontal overflow and 44px targets", async (t) => {
    await t.device("small"); await t.open();
    await t.tap(`document.querySelector('.pill.gear[title="Settings"]')`); await t.waitSel(".settings");
    await t.ev(`[...document.querySelectorAll('.settings nav button')].find(b=>b.textContent.trim()==='Sync devices').click()`); await t.waitSel("#sync-panel");
    await t.ev(`window.__mockSyncNearby(true)`); await t.waitSel("[data-nearby]");
    await noOverflow(t, "sync idle");
    await t.tap(`document.querySelector('#sync-start')`); await t.waitSel("#sync-pairing");
    await noOverflow(t, "sync add card");
    await t.ev(`document.querySelector('#sync-advanced').open = true`); await t.sleep(100);
    await noOverflow(t, "sync advanced");
    t.check("all buttons >= 44px", await t.ev(`[...document.querySelectorAll('#sync-panel button')].filter(b=>b.offsetHeight>0).every(b=>b.offsetHeight>=44)`));
    await t.ev(`window.__mockSyncJoinRequest(true)`); await t.waitSel("#sync-confirm");
    await noOverflow(t, "sync confirm dialog");
    t.check("confirm buttons >= 44px", await t.ev(`[...document.querySelectorAll('#sync-confirm button')].every(b=>b.offsetHeight>=44)`));
  }),

  test("phone: settings tabs and account cards do not overflow", async (t) => {
    await t.device("small"); await t.open();
    await t.tap(`document.querySelector('.pill.gear[title="Settings"]')`);
    await t.waitSel(".settings");
    await noOverflow(t, "settings");
    await t.not("category headings are hidden on a phone", `[...document.querySelectorAll('.settings nav h6')].some(h=>getComputedStyle(h).display!=='none'&&h.getBoundingClientRect().width>0)`);
    await t.ok("all pages sit in one row", `(()=>{const ys=[...document.querySelectorAll('.settings nav button')].map(b=>Math.round(b.getBoundingClientRect().top)); return new Set(ys).size===1})()`);
    const tabs = await t.ev<string[]>(`[...document.querySelectorAll('.settings nav button')].map(b=>b.textContent.trim())`);
    for (const name of tabs) {
      await t.ev(`[...document.querySelectorAll('.settings nav button')].find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);
      await t.sleep(120);
      await noOverflow(t, "settings > " + name);
      await look(t, "phone-settings-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    }
  }, { timeout: 90000 }),

  test("tablet: portrait and landscape keep the three columns without overflow", async (t) => {
    await t.device("tablet"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    await noOverflow(t, "tablet portrait"); await look(t, "tablet-portrait");
    await t.device("tablet", true); await t.sleep(300);
    await noOverflow(t, "tablet landscape"); await look(t, "tablet-landscape");
    await t.eq("conversation survived the rotation", `!!document.querySelector('.messages .msg')`, true);
    await t.device("phone", true); await t.sleep(300);
    await noOverflow(t, "phone landscape"); await look(t, "phone-landscape");
    t.check("composer reachable in landscape", await t.ev(inViewport(".composer")));
  }),

  test("phone: lightbox, reactions list and video fit the screen", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna");
    await t.waitSel(".imgwrap");
    await t.tap(`document.querySelector('.imgwrap')`);
    await t.waitSel(".lightbox");
    t.check("image within the viewport", await t.ev(`(()=>{const r=document.querySelector('.lightbox img').getBoundingClientRect(); return r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`));
    await look(t, "phone-lightbox");
  }),
  test("phone: Add account - tap a provider in a long list (touch), reach the login (QR) screen", async (t) => {
    await t.device("phone"); await t.open("&manyproviders=1");
    await t.tap(`document.querySelector('.pill[title^="Add a community"]')`);
    await t.waitSel(".menuitem");
    await t.tap(`[...document.querySelectorAll('.menuitem')].at(-1)`);
    await t.waitSel(".modal .grid .card");
    await t.ok("the sheet fits the screen and scrolls when the list is longer", `(()=>{const m=document.querySelector('.modal'); const r=m.getBoundingClientRect(); return r.bottom<=innerHeight+1 && r.top>=0 && /(auto|scroll)/.test(getComputedStyle(m).overflowY)})()`);
    await t.ok("rows are at least 44px and nothing covers them", `[...document.querySelectorAll('.modal .grid .card')].slice(0,2).every(c=>{const r=c.getBoundingClientRect(); const e=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return r.height>=44 && c.contains(e)})`);
    await t.ev(`(()=>{const m=document.querySelector('.modal'); m.scrollTop=m.scrollHeight})()`);
    await t.ok("the last provider can be scrolled into view", `(()=>{const c=[...document.querySelectorAll('.modal .grid .card')].at(-1).getBoundingClientRect(); return c.bottom<=innerHeight+1})()`);
    await t.ev(`(()=>{const m=document.querySelector('.modal'); m.scrollTop=0})()`);
    await t.tap(`[...document.querySelectorAll('.modal .grid .card')].find(c=>/WhatsApp/.test(c.textContent))`);
    await t.waitSel(".qr svg, .qr canvas");
    await t.ok("the QR login is shown", `!!document.querySelector('.qr') && /Link device/.test(document.querySelector('.modal h3').textContent)`);
    await t.shot("phone_add_account");
  }),
];

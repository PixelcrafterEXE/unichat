// UI round 2026-11-13: settings structure, archive switch, compact layout retired, picture zoom, colour picker, nested dialogs.
import { test } from "../lib/test.ts";

export default [
  test("settings: grouped navigation with plain names (no 'Data'/'Devices')", async (t) => {
    await t.open("&settings");
    await t.waitSel(".settings nav");
    const names = await t.ev(`[...document.querySelectorAll('.settings nav button')].map(b=>b.textContent.trim())`);
    t.expectEq("section names", names, ["Accounts", "Privacy & chats", "Appearance", "Notifications", "Scheduled messages", "Storage & downloads", "Backup & restore", "Sync devices", "Move to another device", "Updates"]);
    await t.ok("group headings explain the structure", `[...document.querySelectorAll('.settings nav h6')].map(h=>h.textContent).join('|') === 'Messengers|App|Your data|Other devices'`);
    await t.click(".settings nav button", "Move to another device");
    await t.waitSel("#bk-move");
    await t.ok("the page explains how it differs from backup and sync", `/Backup & restore/.test(document.querySelector('.bk').innerText) && /Sync devices/.test(document.querySelector('.bk').innerText)`);
    await t.click(".settings nav button", "Sync devices");
    await t.waitSel("#sync-panel");
  }),

  test("compact layout is retired: no toggle, and a stored value is ignored", async (t) => {
    await t.open("&settings", { init: `localStorage.setItem('unimsg.settings', JSON.stringify({compact: true}))` } as any);
    await t.click(".settings nav button", "Appearance");
    await t.not("no compact toggle in Appearance", `/Compact message layout/.test(document.querySelector('.settings section').innerText)`);
    await t.not("the compact class is never set", `document.documentElement.classList.contains('compact')`);
  }),

  test("archive switch: one button shows archived chats and communities everywhere, dimmed", async (t) => {
    await t.open();
    await t.waitSel(".chats li");
    await t.ev(`[...document.querySelectorAll('.chats li')].find(e=>e.textContent.includes('Ben Fischer')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
    await t.click(".chatmenu button", /^\s*Archive\s*$/);
    await t.not("the archived chat is hidden from the list", `[...document.querySelectorAll('.chats li')].some(e=>e.textContent.includes('Ben Fischer'))`);
    await t.ok("the archive button offers to show archived items", `[...document.querySelectorAll('.pill')].some(p=>/^Show archived/.test(p.title))`);
    await t.click('.pill[title^="Show archived"]');
    await t.ok("the archived chat is back in the list, dimmed", `[...document.querySelectorAll('.chats li.archivedrow')].some(e=>e.textContent.includes('Ben Fischer'))`);
    await t.ok("the button now offers to hide them", `[...document.querySelectorAll('.pill')].some(p=>/^Hide archived/.test(p.title))`);
    await t.click('.pill[title^="Hide archived"]');
    await t.not("and hides them again", `[...document.querySelectorAll('.chats li')].some(e=>e.textContent.includes('Ben Fischer'))`);
  }),

  test("archive button: an unread message in an archived chat shows a bubble; one switch only", async (t) => {
    await t.open();
    await t.waitSel(".chats li");
    await t.not("no second archive bar under the chat list", `document.querySelector('.archivedbar')`);
    await t.ev(`[...document.querySelectorAll('.chats li')].find(e=>e.textContent.includes('A24')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
    await t.click(".chatmenu button", /^\s*Archive\s*$/);
    await t.ok("A24 (2 unread) is archived: the archive button carries a bubble with 2", `(()=>{const p=[...document.querySelectorAll('.pillwrap')].find(w=>/archived/i.test(w.querySelector('.pill')?.title||'')); return p?.querySelector('.pbadge')?.textContent==='2'})()`);
    await t.ev(`document.querySelector('.pill[title^="Show archived"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:40,clientY:300}))`);
    await t.click('[data-act="archive-mark-read"]');
    await t.ok("mark all archived as read clears the bubble", `(()=>{const p=[...document.querySelectorAll('.pillwrap')].find(w=>/archived/i.test(w.querySelector('.pill')?.title||'')); return !p?.querySelector('.pbadge')})()`, { timeout: 8000 });
    await t.eq("exactly one archive switch in the whole UI", `[...document.querySelectorAll('.pill')].filter(p=>/archived/i.test(p.title)).length + document.querySelectorAll('.archivedbar').length`, 1);
  }),

  test("archive button: muted chats (themselves or via their community) never count", async (t) => {
    await t.open();
    await t.waitSel(".chats li");
    const arch = async (name: string) => { await t.ev(`[...document.querySelectorAll('.chats li')].find(e=>e.textContent.includes(${JSON.stringify(name)})).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`); await t.click(".chatmenu button", /^\s*Archive\s*$/); };
    await t.ev(`[...document.querySelectorAll('.chats li')].find(e=>e.textContent.includes('A24')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
    await t.click(".chatmenu button", /Mute/);
    await arch("A24");
    await t.ok("a muted archived chat with 2 unread does not make the bubble", `(()=>{const w=[...document.querySelectorAll('.pillwrap')].find(w=>/archived/i.test(w.querySelector('.pill')?.title||'')); return !!w && !w.querySelector('.pbadge')})()`);
  }),

  test("pictures: a profile/group picture opens in the big viewer", async (t) => {
    await t.open("&chat=wa-1:family&info=1");
    await t.waitSel(".hero .avatar.zoomable");
    await t.click(".hero .avatar.zoomable");
    await t.waitSel(".lightbox img");
    await t.ok("the viewer shows the picture", `!!document.querySelector('.lightbox img').src`);
    await t.click(".lightbox");
    await t.not("clicking closes it", `document.querySelector('.lightbox')`);
  }),

  test("folder cover: any emoji from the full list, with a drop shadow", async (t) => {
    await t.open();
    await t.click('.pill[title="New folder"]');
    await t.waitSel("#allemoji");
    await t.click("#allemoji");
    await t.waitSel("#fullemoji .epcell");
    await t.ok("the full list has far more than the 12 presets", `+document.querySelector('#fullemoji .epick').dataset.total > 1000`);
    await t.ev(`(()=>{const i=document.querySelector('#fullemoji input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'rocket'); i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await t.ok("search finds it", `[...document.querySelectorAll('#fullemoji .epcell')].some(b=>b.textContent==='🚀')`);
    await t.click("#fullemoji .epcell", "🚀");
    await t.ok("the preview shows the chosen emoji with the shadow", `getComputedStyle(document.querySelector('.folderprev .fe')).filter.includes('drop-shadow') && document.querySelector('.folderprev .fe').textContent==='🚀'`);
  }),

  test("colour picker: many presets plus a custom colour", async (t) => {
    await t.open();
    await t.click('.pill[title="New folder"]');
    await t.waitSel(".swatches");
    await t.ok("at least 20 preset colours", `document.querySelectorAll('.modal .swatches .swatch:not(.custom):not(.ico)').length >= 20`);
    await t.ok("and a custom colour input", `!!document.querySelector('.modal .swatch.custom input[type=color]')`);
  }),
];

// Merged chats (one person on several networks): merging, unified timeline, Send via, per-message actions,
// search, live events, unread/notifications, flags, contact panel, offline members, unmerge.
import { NOTIFY_INIT, test } from "../lib/test.ts";
import { mergeAnna, pickMergeRow, pickVia, plusItems, settings, viaName } from "../lib/ui.ts";

const MSG = (s: string) => `__e2e.msg(${JSON.stringify(s)})`;
const ANNA_ROWS = `__e2e.rows().filter(n=>n==='Anna Becker').length`;
const msgMenu = (t: any, s: string) => t.contextMenu({ expr: MSG(s) }, 600, 300);
const merged = async (t: any, init = "") => { await t.open(init, { settle: true }); await mergeAnna(t); await t.openRow("Anna Becker"); await t.waitFor(`document.querySelector('main header .titlebtn')?.textContent==='Anna Becker' && document.querySelectorAll('.messages .msg').length>5`); };

export default [
  test("merge two DMs from the chat menu (one row, both networks)", async (t) => {
    await t.open();
    await t.eq("before: two separate 'Anna Becker' rows", ANNA_ROWS, 2);
    await t.rowMenu("Anna Becker", 0);
    await t.ok("menu offers 'Merge with…' on a DM", `[...document.querySelectorAll('.chatmenu button')].some(b=>/Merge with/.test(b.textContent))`);
    await t.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`); await t.ev(`document.body.click()`);
    await t.rowMenu("Family");
    await t.not("no 'Merge with…' on a group", `[...document.querySelectorAll('.chatmenu button')].some(b=>/Merge with/.test(b.textContent))`);
    await t.ev(`document.body.click()`);
    await t.rowMenu("Anna Becker", 0); await t.menuItem("Merge with");
    await t.waitFor(`/LIKELY THE SAME PERSON/i.test(document.querySelector('.modal')?.innerText ?? '')`);
    const modal = await t.ev(`document.querySelector('.modal').innerText`);
    t.check("modal suggests the Matrix Anna (same name) first", /LIKELY THE SAME PERSON\s+AB\s+Anna Becker\s+Matrix/i.test(modal), modal.slice(0, 200));
    t.check("modal lists only DMs (no groups/channels)", !/Family|A24|Weekend crew|general/.test(modal));
    t.check("modal says nothing is sent", /nothing is sent/.test(modal));
    await t.shot("modal");
    await pickMergeRow(t, "Anna Becker");
    await t.ok("merge button counts chats", `/Merge 2 chats/.test(document.querySelector('.modal button.primary').textContent)`);
    await t.clickLast(".modal button.primary");
    await t.eq("after: ONE 'Anna Becker' row", ANNA_ROWS, 1);
    await t.openRow("Anna Becker");
    await t.ok("merged chat opens", `document.querySelector('main header .titlebtn')?.textContent==='Anna Becker'`);
    await t.eq("row has 2 provider badges", `document.querySelectorAll('.chats li.active .avbadge .pstackitem').length`, 2);
    await t.ok("header names both networks", `/WhatsApp \\+ Matrix/.test(document.querySelector('main header .prov').textContent)`);
  }),

  test("merged row: messenger dots show the primary first, then the others by last use", async (t) => {
    await merged(t);
    const dots = `[...document.querySelectorAll('.chats li[data-chat^="merge:"] .avbadge .pstackitem .pi')].map(e=>e.title)`;
    const first = await t.ev<string[]>(dots);
    const primary = first[0];
    await t.ev(`window.__mockInject('mx-1:@anna:matrix.org','Anna Becker','newest on matrix')`);
    await t.ev(`window.__mockInject('wa-1:anna','Anna Becker','newest on whatsapp')`);
    await t.sleep(400);
    const after = await t.ev<string[]>(dots);
    t.expectEq("the primary messenger stays first however recent the others are", after[0], primary);
    t.expectEq("both dots are still there", after.length, 2);
    await t.ok("the first dot is drawn in front of the later ones", `(()=>{const l=[...document.querySelectorAll('.chats li[data-chat^="merge:"] .avbadge .pstackitem')]; return l.length>1 && Number(getComputedStyle(l[0]).zIndex) > Number(getComputedStyle(l[1]).zIndex)})()`);
  }),

  test("unified timeline: sorted across networks, badge at the start of each run", async (t) => {
    await merged(t);
    const m: string[] = await t.ev(`__e2e.msgs()`);
    const iM = m.findIndex((x) => x.includes("new Matrix account")), iW = m.findIndex((x) => x.includes("Are we still on")), iT = m.findIndex((x) => x.includes("train leaves")), iY = m.findIndex((x) => x.includes("Yes! 10am"));
    t.check("timeline contains Matrix and WhatsApp messages", iM >= 0 && iW >= 0);
    t.check("sorted by time across networks (Matrix 35h < WA 25h; train message between WA messages)", iM < iW && iW < iT && iT < iY, `${iM} ${iW} ${iT} ${iY}`);
    await t.ev(`document.querySelector('.messages').scrollTop=0`);
    const badges = await t.ev(`(()=>{const ms=[...document.querySelectorAll('.messages .msg')]; return {n:ms.length, withBadge: ms.filter(e=>e.querySelector('.netbadge')).length, titles:[...new Set([...document.querySelectorAll('.messages .netbadge')].map(b=>b.title))]}})()`);
    t.check("the indicator marks run starts only: some messages carry it, followers of the same network and sender do not", badges.withBadge >= 2 && badges.withBadge < badges.n, JSON.stringify(badges));
    t.check("badge tooltip names network + account", badges.titles.includes("WhatsApp · WhatsApp · +49 151 2345") && badges.titles.includes("Matrix · @michi:matrix.org"), JSON.stringify(badges.titles));
    await t.ok("day separators still shown", `document.querySelectorAll('.messages .daysep').length >= 2`);
    t.check("a network switch starts a new group (not grouped under the WA message)", (await t.ev(`${MSG("Sent you the route")}.classList.contains('grouped')`)) === false);
    await t.ok("attachments of WhatsApp messages load through their own chat id", `[...document.querySelectorAll('.messages .imgwrap img')].some(i=>i.src.startsWith('blob:'))`, { timeout: 8000 });
    await t.shot("timeline");
  }),

  test("Send via: default = network of the newest message; composer adapts; sent messages carry the badge", async (t) => {
    await merged(t);
    await t.ev(`document.querySelector('.messages').scrollTop=1e9`);
    await t.ok("composer has the Send via selector", `document.querySelector('.viabtn')`);
    await t.eq("default via = network of the newest message (WhatsApp)", `document.querySelector('.viabtn b')?.textContent`, "WhatsApp");
    const wa = await plusItems(t);
    t.check("WhatsApp composer offers Contact + Event", wa.some((x) => /Contact/.test(x)) && wa.some((x) => /Event/.test(x)), JSON.stringify(wa));
    await pickVia(t, "Matrix");
    const mx = await plusItems(t);
    t.check("composer adapts to Matrix capabilities (no Contact/Event, but Poll)", !mx.some((x) => /Contact|Event/.test(x)) && mx.some((x) => /Poll/.test(x)), JSON.stringify(mx));
    await t.send_("via matrix please");
    await t.ok("message sent via Matrix carries the Matrix badge", `/Matrix/.test(${MSG("via matrix please")}.querySelector('.netbadge')?.title)`);
    await pickVia(t, "WhatsApp");
    await t.send_("and one via whatsapp");
    await t.ok("message sent via WhatsApp carries the WhatsApp badge", `/WhatsApp/.test(${MSG("and one via whatsapp")}.querySelector('.netbadge')?.title)`);
    await t.shot("via");
  }),

  test("Send via: non-merged chats have none; the selection after a round trip follows the newest message", async (t) => {
    await merged(t);
    await pickVia(t, "Matrix");
    await t.send_("sent through matrix");
    await t.openRow("Ben Fischer");
    await t.not("non-merged chat has no Send via selector", `document.querySelector('.viabtn')`);
    await t.openRow("Anna Becker");
    await t.eq("coming back: via = network of the newest message (Matrix, I just wrote there)", `document.querySelector('.viabtn b')?.textContent`, "Matrix");
    await pickVia(t, "WhatsApp");
    await t.openRow("Ben Fischer"); await t.openRow("Anna Becker");
    await t.eq("an unused manual choice is NOT remembered (falls back to the newest message's network)", `document.querySelector('.viabtn b')?.textContent`, "Matrix");
  }),

  test("scheduled message goes out via the selected member", async (t) => {
    await merged(t);
    await pickVia(t, "Matrix");
    await t.typeIn("later via matrix");
    await t.click(".composer .tools .icon.big");
    await t.click(".composer .popmenu button", /Schedule/);
    await t.click(".modal button", /^\s*Schedule\s*$/);
    await t.ok("the scheduled job targets the Matrix member chat", `(globalThis.__jobs||[]).some(j=>j.payload.chatId==='mx-1:@anna:matrix.org')`);
  }),

  test("switching Send via keeps the message list mounted (no reload)", async (t) => {
    await merged(t);
    await t.ev(`window.__marker = document.querySelector(".messages"); 0`);
    await t.click(".viabtn");
    await t.ev(`[...document.querySelectorAll('.viamenu button')].find(b=>b.getAttribute('aria-selected')!=='true').click()`);
    await t.sleep(600);
    await t.ok("same message list element", `window.__marker === document.querySelector('.messages')`);
    await t.ok("and the messages are still there", `document.querySelectorAll('.msg').length > 3`);
  }),

  test("per-message actions use the message's own chat (react, reply, edit, delete, forward)", async (t) => {
    await merged(t);
    await t.ev(`document.querySelector('.messages').scrollTop=0`);
    await msgMenu(t, "btw the train leaves"); await t.click(".ctxreacts button");
    await t.ok("react on a Matrix message in the merged view", `${MSG("btw the train leaves")}.querySelector('.reactions .chip')`);
    await pickVia(t, "WhatsApp");
    await msgMenu(t, "btw the train leaves"); await t.click(".ctxmenu button", /Reply/);
    await t.eq("replying to a Matrix message switches Send via to Matrix", `document.querySelector('.viabtn b')?.textContent`, "Matrix");
    await t.typeIn("noted, 9:40"); await t.enter();
    await t.ok("the reply carries a quote and goes out via Matrix", `(()=>{const el=${MSG("noted, 9:40")}; return !!el && !!el.querySelector('.quote') && /Matrix/.test(el.querySelector('.netbadge').title)})()`);
    await t.ev(`${MSG("noted, 9:40")}.querySelector('.quote').click()`);
    await t.ok("clicking the quote jumps to and highlights the original", `${MSG("btw the train leaves")}.classList.contains('hl')`);
    await msgMenu(t, "Thanks, see you there"); await t.click(".ctxmenu button", /^\s*Edit/);
    await t.ok("edit loads the message into the composer", `document.querySelector('.composer textarea').value==='Thanks, see you there'`);
    await t.typeIn("Thanks, see you there!"); await t.enter();
    await t.ok("edited message shows (edited)", `${MSG("Thanks, see you there!")}?.innerText.includes('(edited)')`);
    await msgMenu(t, "Yes! 10am at the station"); await t.click(".ctxmenu button", /Delete/);
    await t.ok("delete on a WhatsApp message works from the merged view", `/This message was deleted/.test(document.querySelector('.messages').innerText)`);
    await msgMenu(t, "Packing list"); await t.click(".ctxmenu button", /Forward/);
    await t.waitSel(".modal .rowbtn");
    const fwd = await t.ev(`[...document.querySelectorAll('.modal .rowbtn')].map(b=>b.textContent.trim())`);
    t.check("forward list shows the merged chat once (no hidden member rows)", fwd.filter((n: string) => /Anna Becker$/.test(n)).length === 1, JSON.stringify(fwd));
    await t.click(".modal .rowbtn", "Ben Fischer");
    await t.ok("forwarded message lands in the target chat", `${MSG("Packing list")} && document.querySelector('main header .titlebtn').textContent.includes('Ben Fischer')`);
  }),

  test("search covers all members of a merged chat and jumps to hits", async (t) => {
    await merged(t);
    await t.click('main header .hright button[title^="Search"]');
    await t.setInput(".sidesearch input", "route");
    await t.eq("finds a Matrix message", `document.querySelectorAll('.sres').length`, 1);
    await t.setInput(".sidesearch input", "snacks");
    await t.ok("finds a WhatsApp message in the same panel", `document.querySelectorAll('.sres').length===1 && /WhatsApp/.test(document.querySelector('.sres .pi')?.title ?? '')`);
    await t.setInput(".sidesearch input", "s"); // prefix search: words starting with s
    await t.ok("a broad search returns hits from both networks", `(()=>{const h=[...document.querySelectorAll('.sres .pi')].map(p=>p.title.split(' · ')[0]); return h.includes('WhatsApp')&&h.includes('Matrix')})()`);
    await t.setInput(".sidesearch input", "btw the train");
    await t.waitFor(`document.querySelectorAll('.sres').length===1 && /train/.test(document.querySelector('.sres').textContent)`);
    await t.click(".sres");
    await t.ok("clicking a hit jumps to it in the unified timeline", `${MSG("btw the train leaves")}?.classList.contains('hl')`);
    await t.shot("search");
  }),

  test("live events reach the open merged chat (message, typing, update)", async (t) => {
    await merged(t);
    await t.ev(`globalThis.__mockInject('mx-1:@anna:matrix.org','Anna Becker','live from matrix')`);
    await t.ok("live Matrix message appears with a Matrix badge", `/Matrix/.test(${MSG("live from matrix")}?.querySelector('.netbadge')?.title)`);
    await t.ev(`globalThis.__mockEmit('typing',{chatId:'wa-1:anna',senderId:'Anna',typing:true})`);
    await t.ok("typing of a member shows in the merged chat", `document.querySelector('.typing')`);
    const id = await t.ev(`globalThis.__mockInject('mx-1:@anna:matrix.org','Anna Becker','to be edited').id`);
    await t.ev(`globalThis.__mockEmit('message-update',{chatId:'mx-1:@anna:matrix.org',messageId:${JSON.stringify(id)},patch:{text:'was edited live',editedAt:new Date().toISOString()}})`);
    await t.ok("live message-update of a member updates the merged timeline", `${MSG("was edited live")}`);
  }),

  test("unread = sum of members, preview = newest, notifications and rename use the merged name", async (t) => {
    await t.open("", { settle: true });
    await mergeAnna(t); await t.openRow("Ben Fischer");
    await t.waitFor(`!document.querySelector('.chats li.active .unread')`).catch(() => {});
    const row = `__e2e.row('Anna Becker')`;
    // unread before the injections (the 5s mock message may have added one; read state is whatever the mock has)
    const base = Number(await t.ev(`${row}.querySelector('.unread')?.textContent ?? 0`));
    await t.ev(`window.__notes.length=0; globalThis.__mockInject('mx-1:@anna:matrix.org','Anna Becker','ping 1'); globalThis.__mockInject('wa-1:anna','Anna Becker','ping 2')`);
    await t.eq("unread of the merged row grows by the injected messages", `Number(${row}.querySelector('.unread')?.textContent)`, base + 2);
    await t.eq("preview = newest across members", `${row}.querySelector('small').textContent`, "ping 2");
    const notes = await t.ev(`window.__notes`);
    t.check("notifications use the merged name", notes.length === 2 && notes.every((n: any[]) => n[0] === "Anna Becker"), JSON.stringify(notes));
    await t.openRow("Anna Becker");
    await t.not("opening the merged chat clears unread", `document.querySelector('.chats li.active .unread')`);
    await t.rowMenu("Anna Becker"); await t.menuItem("Rename");
    await t.setInput(".modal input", "Annchen");
    await t.ev(`document.querySelector('.modal form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    await t.ok("renaming changes the shown name", `__e2e.rows().includes('Annchen') && document.querySelector('main header .titlebtn').textContent==='Annchen'`);
    await t.openRow("Ben Fischer");
    await t.ev(`window.__notes.length=0; globalThis.__mockInject('mx-1:@anna:matrix.org','Anna Becker','ping 3')`);
    await t.eq("notification uses the user-chosen merged name", `window.__notes[0]?.[0]`, "Annchen");
  }, { init: NOTIFY_INIT }),

  test("pin, mute and archive apply to the merged chat", async (t) => {
    await t.open("", { settle: true }); await mergeAnna(t);
    await t.rowMenu("Anna Becker"); await t.menuItem("Pin");
    await t.eq("pinned merged chat is first", `__e2e.rows()[0]`, "Anna Becker");
    await t.rowMenu("Anna Becker"); await t.menuItem("Mute");
    await t.ok("muted flag shows on the merged row", `__e2e.row('Anna Becker').querySelector('.name svg')`);
    await t.rowMenu("Anna Becker"); await t.menuItem("Archive");
    await t.eq("archiving hides it (and its members do not pop back)", ANNA_ROWS, 0);
    await t.click('.pill[title^="Show archived"]');
    await t.ok("it is listed under Archived", `__e2e.rows().includes('Anna Becker')`);
    await t.rowMenu("Anna Becker"); await t.menuItem("Unarchive");
    await t.ok("unarchived: it is in the normal list and the archive switch is gone (nothing is archived any more)", `__e2e.rows().includes('Anna Becker')`);
  }),

  test("contact panel of a merged chat: networks, make primary, merge more", async (t) => {
    await merged(t);
    await t.click('main header .hright button[title="Chat info"]');
    await t.waitSel("aside.info .netrow");
    const info = await t.ev(`document.querySelector('aside.info').innerText`);
    t.check("shows both networks once each with their account", /networks\s*·\s*2/i.test(info) && /@michi:matrix.org/.test(info) && /\+49 151/.test(info) && (info.match(/\bMatrix\b/g) ?? []).length >= 1, info.replace(/\n/g, " | ").slice(0, 300));
    await t.shot("info");
    await t.click('.netrow button[aria-label^="Make"]');
    await t.ok("make primary reorders members", `/Matrix/.test(document.querySelector('.netrow b').textContent)`);
    await t.click("aside.info button", /Merge with more/);
    await t.ok("'Merge with more…' opens the picker", `/Merge more into/.test(document.querySelector('.modal h3')?.textContent)`);
  }),

  test("a signed-out member makes the merged chat partly read-only; removing the account keeps the history", async (t) => {
    await merged(t);
    await settings(t);
    await t.ev(`[...document.querySelectorAll('.acard')].find(c=>c.innerText.includes('@michi:matrix.org')).querySelector('button.secondary[title^="Log out"]').click()`);
    await t.clickLast(".modal button.primary, .modal button.danger");
    await t.click(".settings .closex");
    await t.ok("the merged chat is still writable via the other member", `document.querySelector('.composer textarea')`);
    await pickVia(t, "Matrix");
    await t.ok("selecting the signed-out member shows the read-only note", `/read-only archive/.test(document.querySelector('.composer.ro')?.innerText ?? '')`);
    await t.ok("...and the selector stays so the user can switch", `document.querySelector('.viabtn')`);
    await t.shot("offline");
    await pickVia(t, "WhatsApp");
    await t.ok("switching back restores the composer", `document.querySelector('.composer textarea')`);
    await t.ok("timeline got a signed-out marker for Matrix", `/signed out/i.test([...document.querySelectorAll('.sysmsg')].map(e=>e.innerText).join(' '))`);
    await settings(t);
    await t.ev(`[...document.querySelectorAll('.acard')].find(c=>c.innerText.includes('@michi:matrix.org')).querySelector('button.danger').click()`);
    await t.clickLast(".modal button.danger");
    await t.click(".settings .closex");
    await t.ok("removing the Matrix account: the merge survives (WhatsApp history)", `__e2e.rows().includes('Anna Becker')`);
    await t.openRow("Anna Becker");
    await t.ok("remaining archive shown, Matrix messages gone", `(()=>{const m=__e2e.msgs(); return m.some(x=>x.includes('Are we still on')) && !m.some(x=>x.includes('new Matrix account'))})()`);
    await t.eq("single network badge now", `document.querySelectorAll('.chats li.active .avbadge .pi').length`, 1);
  }),

  test("unmerge restores two chats with their own untouched history", async (t) => {
    await t.open("", { settle: true }); await mergeAnna(t);
    await t.rowMenu("Anna Becker");
    await t.ok("merged chat's menu has Unmerge", `[...document.querySelectorAll('.chatmenu button')].some(b=>/Unmerge/.test(b.textContent))`);
    await t.menuItem("Unmerge");
    await t.ok("unmerge promises that nothing is deleted", `/No messages are deleted/.test(document.querySelector('.modal').innerText)`);
    await t.click(".modal button.primary");
    await t.eq("two separate rows again", ANNA_ROWS, 2);
    await t.openRow("Anna Becker", 0); await t.waitFor(`document.querySelectorAll('.messages .msg').length>3`);
    const m1: string[] = await t.ev(`__e2e.msgs()`);
    await t.openRow("Anna Becker", 1); await t.sleep(300); await t.waitFor(`document.querySelectorAll('.messages .msg').length>=3`);
    const m2: string[] = await t.ev(`__e2e.msgs()`);
    const wa = m1.some((x) => x.includes("Are we still on")) ? m1 : m2, mx = wa === m1 ? m2 : m1;
    t.check("each chat keeps only its own history", !wa.some((x) => x.includes("Matrix account")) && mx.some((x) => x.includes("Matrix account")) && !mx.some((x) => x.includes("Are we still on")));
    await t.not("no per-message provider badges / Send via outside a merge", `document.querySelector('.messages .netbadge') || document.querySelector('.viabtn')`);
  }),

  test("merge picker is reachable from the info panel of a plain DM", async (t) => {
    await t.open("&chat=wa-1:anna&info=1");
    await t.ok("info panel has 'Merge with other chats'", `[...document.querySelectorAll('aside.info button')].some(b=>/Merge with other chats/.test(b.textContent))`);
    await t.click("aside.info button", /Merge with other chats/);
    await t.ok("which opens the merge picker", `/Merge “Anna Becker” with/.test(document.querySelector('.modal h3')?.textContent)`);
  }),

  test("visual: merged chat in the flat/light theme and on a phone-width viewport", async (t) => {
    await t.open("", {});
    await mergeAnna(t); await t.openRow("Anna Becker");
    await t.waitFor(`document.querySelectorAll('.messages .msg').length>5`);
    await t.shot("flat_light");
    await t.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 800, deviceScaleFactor: 1, mobile: true });
    await t.ok("merged chat still renders its timeline on a narrow screen", `document.querySelectorAll('.messages .msg').length>5 && document.documentElement.scrollWidth <= 430`);
    await t.shot("mobile");
  }, { init: `try{localStorage.setItem('unimsg.settings',JSON.stringify({messageStyle:'flat',theme:'light'}))}catch(e){}` }),
];

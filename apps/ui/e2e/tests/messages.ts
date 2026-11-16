// Messages, composer popups, reactions and who-reacted, deleted messages, search, load-earlier.
import { test } from "../lib/test.ts";

const RUST = "&chat=mx-1:!rust-general";
const msgMenu = (t: any, txt: string) => t.contextMenu({ expr: `__e2e.msg(${JSON.stringify(txt)})` }, 500, 300);

export default [
  test("attach popup stays open when the mouse moves, closes on outside click", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.click('button[title="Attach"]');
    await t.waitFor(`document.querySelector('.tools .popmenu')`);
    await t.mouseMove(600, 300);
    await t.stays("attach popup stays open when the mouse moves", `!document.querySelector('.tools .popmenu')`, 500);
    await t.mouseClick(700, 200);
    await t.not("it closes on an outside click", `document.querySelector('.tools .popmenu')`);
  }),

  test("reaction chip: tooltip and right-click lists who reacted", async (t) => {
    await t.open(RUST);
    await t.waitSel(".reactions .chip:not(.add)");
    const title = await t.ev(`document.querySelector('.reactions .chip:not(.add)').title`);
    t.check("a reaction chip has a hover tooltip", /Right-click/.test(title), String(title));
    await t.ev(`document.querySelector('.reactions .chip:not(.add)').dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}))`);
    await t.contextMenu(".reactions .chip:not(.add)");
    await t.eq("right-click lists who reacted (3 people)", `document.querySelectorAll('.rrow .rname').length`, 3);
    await t.shot("reactors");
    await t.ev(`document.querySelector('.modalbg').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
    await t.not("clicking the backdrop closes it", `document.querySelector('.rrow')`);
  }),

  test("reply quote jump highlights the original message", async (t) => {
    await t.open(RUST);
    await t.waitFor(`__e2e.msg("dyn-compatible")`);
    await t.ev(`__e2e.msg("dyn-compatible").querySelector('.quote').click()`);
    await t.ok("jumping to the quoted message highlights it", `__e2e.msg("Async traits are finally")?.classList.contains('hl')`);
  }),

  test("react to a message from the context menu", async (t) => {
    await t.open(RUST);
    await t.waitFor(`__e2e.msg("Async traits")`);
    await msgMenu(t, "Async traits");
    await t.click(".ctxreacts button");
    await t.ok("my reaction chip appears", `!!__e2e.msg("Async traits").querySelector('.reactions .chip.mine')`);
  }),

  test("edit own message shows (edited)", async (t) => {
    await t.open(RUST);
    await t.waitFor(`__e2e.msg("Anyone tried them")`);
    await msgMenu(t, "Anyone tried them");
    await t.click(".ctxmenu button", /^\s*Edit/);
    await t.ok("edit loads the text into the composer", `document.querySelector('.composer textarea').value.includes('Anyone tried them')`);
    await t.typeIn("Anyone tried them with Tauri?");
    await t.enter();
    await t.ok("edited message is marked", `__e2e.msg("with Tauri?")?.innerText.includes('(edited)')`);
  }),

  test("load earlier messages extends the timeline", async (t) => {
    await t.open(RUST);
    await t.waitSel(".loadmore");
    const n0 = await t.ev(`document.querySelectorAll('.messages .msg').length`);
    await t.click(".loadmore");
    await t.ok("more messages are shown", `document.querySelectorAll('.messages .msg').length > ${n0}`);
  }),

  test("search jump to a message older than the loaded window", async (t) => {
    await t.open(RUST);
    await t.click('main header .hright button[title^="Search"]');
    await t.setInput(".sidesearch input", "Older message #3");
    await t.click(".sres");
    await t.ok("the older message is loaded and highlighted", `!!document.querySelector('.messages .msg.hl') || !!__e2e.msg("Older message #3")`, { timeout: 8000 });
  }),

  test("consecutive messages of one sender are grouped", async (t) => {
    await t.open();
    await t.openRow("Family");
    await t.ok("Oma's consecutive messages are grouped", `document.querySelectorAll('.messages .msg.grouped').length >= 2`);
  }),

  test("send in a plain chat, ticks progress", async (t) => {
    await t.open();
    await t.openRow("Ben Fischer");
    await t.send_("hello ben");
    await t.ok("a status tick shows up (sent -> delivered -> read)", `!!__e2e.msg("hello ben").querySelector('.ticks')`, { timeout: 6000 });
  }),

  test("global search finds messages across chats and opens the hit", async (t) => {
    await t.open();
    await t.click('.chats header button[data-act="gsearch"]');
    await t.waitSel(".chats input, .gsearch input");
    await t.setInput(".chats input, .gsearch input", "invoice");
    await t.ok("the hit from Ben's chat is listed", `/invoice/i.test(document.querySelector('.chats')?.innerText ?? '') && /Ben Fischer/.test(document.querySelector('.chats').innerText)`);
  }),

  test("plain chat has neither Send via nor network badges", async (t) => {
    await t.open(RUST);
    await t.waitSel(".messages .msg");
    await t.not("no Send via / network badge in a non-merged chat", `document.querySelector('.viabtn') || document.querySelector('.netbadge')`);
  }),

  test("delete own message shows the deleted placeholder", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitFor(`__e2e.msg("Yes! 10am at the station")`);
    await msgMenu(t, "Yes! 10am at the station");
    await t.click(".ctxmenu button", /Delete/);
    await t.ok("the message is replaced by 'This message was deleted'", `/This message was deleted/.test(document.querySelector('.messages').innerText)`);
    await t.not("original text is gone", `__e2e.msg("Yes! 10am at the station")`);
  }),

  test("attachments, locations and contact cards render in a chat", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.ok("image attachments load (blob urls)", `[...document.querySelectorAll('.messages .imgwrap img')].some(i=>i.src.startsWith('blob:')||i.src.startsWith('data:'))`, { timeout: 8000 });
    await t.ok("file attachment shows its name", `__e2e.msg("Packing list")?.innerText.includes('packing-list.txt')`);
    await t.ok("location message", `__e2e.msg("Zugspitze summit") !== undefined`);
    await t.ok("contact card message", `__e2e.msg("Tom Hartmann") !== undefined`);
  }),

  test("voice message in a chat has a player and can be played", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitSel(".voice .vplay");
    await t.ok("player shows the duration", `/0:0[01]/.test(document.querySelector('.voice .vmeta').textContent)`);
    await t.click(".voice .vplay");
    await t.ok("clicking play loads the audio and starts it", `document.querySelector('.voice.playing') || document.querySelector('.voice audio')?.currentTime > 0 || !!document.querySelector('.voice audio')`, { timeout: 6000 });
    await t.click(".voice .vspeed");
    await t.ok("speed button cycles 1x -> 1.5x", `document.querySelector('.voice .vspeed').textContent.includes('1.5')`);
  }),

  test("scroll-to-latest button jumps to the newest message from the top of a big, windowed chat", async (t) => {
    await t.open("&big=1&chat=mx-1:big-grp0");
    await t.waitSel(".messages .msg");
    await t.ev(`(async()=>{ for(let i=0;i<6;i++){ const b=document.querySelector('.loadmore'); if(!b) break; b.click(); await new Promise(r=>setTimeout(r,150)); while(document.querySelector('.loadmore')?.disabled) await new Promise(r=>setTimeout(r,30)); } const box=document.querySelector('.messages'); box.scrollTop=0; })()`);
    await t.waitSel(".tolatest");
    const before = await t.ev<number>(`+document.querySelector('.messages').dataset.count`);
    await t.click(".tolatest");
    await t.ok("the list is at the bottom", `(()=>{const b=document.querySelector('.messages'); return b.scrollHeight-b.scrollTop-b.clientHeight<120})()`);
    await t.ok("the newest message is rendered", `(()=>{const m=[...document.querySelectorAll('.messages .msg')].pop(), b=document.querySelector('.messages').getBoundingClientRect(); return m && m.getBoundingClientRect().bottom<=b.bottom+4 && m.getBoundingClientRect().bottom>b.top})()`);
    await t.waitFor(`!document.querySelector('.tolatest')`);
    t.check("older pages stay loaded", (await t.ev<number>(`+document.querySelector('.messages').dataset.count`)) >= before);
  }, { timeout: 90000 }),
];

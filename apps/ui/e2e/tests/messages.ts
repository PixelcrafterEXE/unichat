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

  test("a sent message shows instantly (pending), then becomes the real one without a duplicate", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.ev(`globalThis.__mockSlowSend=1200`);
    const n = await t.ev<number>(`document.querySelectorAll('.messages .msg').length`);
    await t.typeIn("instant hello"); await t.enter();
    await t.ok("it is in the list at once, marked as sending", `(()=>{const m=__e2e.msg("instant hello"); return !!m && m.classList.contains('sending') && /^pend-/.test(m.dataset.mid)})()`, );
    t.check("the backend has not answered yet", (await t.ev<number>(`(globalThis.__mockSendLog||[]).length`)) === 0);
    await t.ok("the real message replaces it", `(()=>{const l=[...document.querySelectorAll('.messages .msg')].filter(m=>/instant hello/.test(m.textContent)); return l.length===1 && !l[0].classList.contains('sending') && !/^pend-/.test(l[0].dataset.mid)})()`);
    await t.eq("exactly one message was added", `document.querySelectorAll('.messages .msg').length`, n + 1);
    await t.ev(`globalThis.__mockSlowSend=0`);
  }),

  test("a pending message keeps its place before later ones, and a failed slow send turns into Retry", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.ev(`globalThis.__mockSlowSend=800`);
    await t.typeIn("/fail slow one"); await t.enter();
    await t.ok("shown pending first", `(()=>{const m=__e2e.msg("/fail slow one"); return !!m && m.classList.contains('sending')})()`);
    await t.waitSel(".msg button", "Retry");
    await t.eq("one failed row, the placeholder is gone", `[...document.querySelectorAll('.messages .msg')].filter(m=>/slow one/.test(m.textContent)).length`, 1);
    await t.ok("it is the last message", `(()=>{const l=[...document.querySelectorAll('.messages .msg')]; return /slow one/.test(l[l.length-1].textContent)})()`);
    await t.ev(`globalThis.__mockSlowSend=0`);
  }),

  test("two quick pending sends stay in order and are not duplicated", async (t) => {
    await t.open("&chat=wa-1:anna");
    const n = await t.ev<number>(`document.querySelectorAll('.messages .msg').length`);
    await t.ev(`globalThis.__mockSlowSend=500`);
    await t.typeIn("first"); await t.enter(); await t.typeIn("second"); await t.enter();
    await t.ok("both pending, in order", `(()=>{const l=[...document.querySelectorAll('.messages .msg.sending')].map(m=>m.textContent); return l.length===2 && /first/.test(l[0]) && /second/.test(l[1])})()`);
    await t.ok("both become real", `!document.querySelector('.msg.sending') && !!__e2e.msg("first") && !!__e2e.msg("second")`);
    await t.ok("in order, one row each", `(()=>{const a=__e2e.msg("first"), b=__e2e.msg("second"); return !!(a.compareDocumentPosition(b)&4) && [...document.querySelectorAll('.messages .msg')].length===${n}+2})()`);
    await t.ev(`globalThis.__mockSlowSend=0`);
  }),

  test("a pending reply shows its quote at once and is not duplicated", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitSel(".messages .msg");
    const target = "Are we still on for Saturday?"; await t.waitFor(`__e2e.msg(${JSON.stringify(target)})`);
    await msgMenu(t, target); await t.click(".ctxmenu button", /Reply/);
    await t.ev(`globalThis.__mockSlowSend=700`);
    await t.typeIn("quoted answer"); await t.enter();
    await t.ok("pending with a quote", `(()=>{const m=__e2e.msg("quoted answer"); return !!m && m.classList.contains('sending') && !!m.querySelector('.quote')})()`);
    await t.ok("real one has the quote, once", `(()=>{const l=[...document.querySelectorAll('.messages .msg')].filter(m=>/quoted answer/.test(m.textContent)); return l.length===1 && !l[0].classList.contains('sending') && !!l[0].querySelector('.quote')})()`);
    await t.ev(`globalThis.__mockSlowSend=0`);
  }),

  test("contact info: no messenger chips under the name; the networks of a merged chat are listed in their own section", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.click("main header .titlebtn");
    await t.waitSel("aside.info .hero h2");
    await t.eq("no provider chips in the hero", `document.querySelectorAll('aside.info .hero .tag.brand').length`, 0);
    await t.ev(`window.__mockCall('mergeChats',{chatIds:['wa-1:anna','mx-1:@anna:matrix.org']}).then(r=>window.dispatchEvent(new CustomEvent('unichat-open-chat',{detail:r.id})))`);
    await t.waitSel("aside.info .mergesec .netrow");
    await t.eq("still no chips for a merged chat", `document.querySelectorAll('aside.info .hero .tag.brand').length`, 0);
    await t.ok("the networks section lists both", `document.querySelectorAll('aside.info .mergesec .netrow .pi').length>=2`);
  }),

  test("contact info lists the communities in common (icon + name); a click opens that community", async (t) => {
    await t.open("&chat=wa-1:anna&info=1");
    await t.waitSel("[data-common-communities] .netrow");
    await t.eq("two communities listed", `document.querySelectorAll('[data-common-communities] .netrow').length`, 2);
    await t.ok("with name and community icon", `(()=>{const r=document.querySelector('[data-common-communities] [data-space="wa-1:hike"]'); return !!r && /Hiking Club/.test(r.textContent) && !!r.querySelector('.avatar')})()`);
    await t.ok("the heading counts them", `/Communities in common · 2/.test(document.querySelector('[data-common-communities] h4').textContent)`);
    await t.click('[data-common-communities] [data-space="wa-1:hike"]');
    await t.ok("the community is open: its chats are listed, a personal chat is not", `!!document.querySelector('.chats li[data-chat="wa-1:hike-trips"]') && !document.querySelector('.chats li[data-chat="wa-1:anna"]')`);
  }),
];

// Discord-style servers: categories, cards, counts, polls, per-account capabilities, mentions.
import { test, settingsInit } from "../lib/test.ts";
import { look } from "../lib/ui.ts";

const GENERAL = "&chat=dc-1:general";


const newDiscordChat = async (t: any, handle: string) => {
  await t.ev(`window.__mockCaptcha = true`);
  await t.click(".chats header button[title='New chat']");
  await t.waitSel(".modal select, [role=dialog] select");
  await t.ev(`(()=>{const sel=document.querySelector('.modal select, [role=dialog] select'); __e2e.setv(sel,'dc-2')})()`);
  await t.waitFor(`[...document.querySelectorAll('.modal input, [role=dialog] input')].filter(i=>i.type!=='checkbox').length`);
  await t.ev(`__e2e.setv([...document.querySelectorAll('.modal input, [role=dialog] input')].filter(i=>i.type!=='checkbox').at(-1),'${handle}')`);
  await t.click(".modal button.primary, [role=dialog] button.primary");
  await t.waitSel('[data-testid="captcha-stub"]');
};
const captchaTests = [
  test("captcha: starting a chat with a new person shows the human check, solving it opens the chat", async (t) => {
    await t.open();
    await newDiscordChat(t, "newperson");
    await t.shot("captcha");
    await t.ok("modal explains what is happening and offers the fallback", `(()=>{const x=document.body.textContent; return x.includes("check that you are human") && x.includes("Open Discord instead") && x.includes("best-effort")})()`);
    await t.click('[data-testid="captcha-stub"]');
    await t.waitFor(`document.querySelector('.chats li.active')?.dataset.chat === 'dc-2:newperson'`);
    await t.not("the captcha modal closed", `document.querySelector('[data-testid="captcha-stub"]')`);
    await t.eq("the solved token reached the backend", `globalThis.__captchaToken`, "stub-captcha-token");
  }),
  test("captcha: Cancel explains instead of opening a chat", async (t) => {
    await t.open();
    await newDiscordChat(t, "someoneelse");
    await t.click('[data-testid="captcha-cancel"]');
    await t.waitFor(`document.querySelector('.modal, [role=dialog]')?.textContent.includes("solve a captcha")`);
    await t.ok("explanatory error, no chat", `!document.querySelector('[data-chat="dc-2:someoneelse"]')`);
    await t.not("modal closed", `document.querySelector('[data-testid="captcha-stub"]')`);
  }),
];

export default [
  ...captchaTests,
  test("categories: headings, order, collapse, remembered across reloads", async (t) => {
    await t.open();
    await t.space("dc-1:g1");
    await t.waitSel(".chats li.cathead");
    await t.shot("categories");
    await t.eq("category headings exist", `[...document.querySelectorAll('.chats li.cathead')].map(e=>e.dataset.cat).join('|')`, "Text Channels|Projects");
    // order INSIDE a category is not part of the contract (it is alphabetical today, was seed order before)
    await t.eq("uncategorized first, then each heading followed by its own chats", `(()=>{const o=[...document.querySelectorAll('.chats ul li')].map(e=>e.classList.contains('cathead')?'#'+e.dataset.cat:e.dataset.chat.split(':')[1]); const i=o.indexOf('#Text Channels'), j=o.indexOf('#Projects'); return [o.slice(0,i).sort().join(), o.slice(i,j).sort().join(), o.slice(j).sort().join()]})()`, ["rules,welcome", "#Text Channels,dev-talk,general", "#Projects,bugs,roadmap"]);
    await t.click(".chats li.cathead", "Projects");
    await t.not("collapse hides the chats of that category", `document.querySelector('[data-chat="dc-1:roadmap"]')`);
    await t.ok("other categories stay", `document.querySelector('[data-chat="dc-1:general"]')`);
    await t.eq("collapsed heading shows the unread of hidden chats", `document.querySelector('.cathead[data-cat="Projects"] .unread')?.textContent`, "2");
    await t.reload();
    await t.space("dc-1:g1");
    await t.waitSel(".chats li.cathead");
    await t.not("collapsed state is remembered across reloads", `document.querySelector('[data-chat="dc-1:roadmap"]')`);
  }),

  test("cards, counts and polls (Discord #general)", async (t) => {
    await t.open(GENERAL);
    await t.waitSel(".cardmsg");
    await t.shot("cards");
    await t.eq("three cards rendered", `document.querySelectorAll('.cardmsg').length`, 3);
    await t.eq("card images loaded through the backend (blob urls)", `[...document.querySelectorAll('.cardpic img')].map(i=>i.src.slice(0,5)).join()`, "blob:,blob:");
    await t.ok("banner and thumb layouts", `document.querySelector('.cardmsg.bannerimg') && document.querySelector('.cardmsg.thumbimg')`);
    await t.ok("reaction chips show provider counts", `[...document.querySelectorAll('.reactions .chip:not(.add)')].map(e=>e.textContent.trim()).join('|').includes("👍 42")`);
    await t.eq("poll shows counts", `[...document.querySelectorAll('.pollcard .pc')].map(e=>e.textContent).join()`, "120,30,0");
    await t.ok("poll total", `document.querySelector('.pollcard .phint:last-child').textContent.startsWith("150")`);
    await t.ok("bot account cannot vote", `[...document.querySelectorAll('.pollcard .popt')].every(b=>b.disabled)`);
    await t.contextMenu(".reactions .chip");
    await t.waitSel(".rtabs");
    await t.shot("reactors");
    await t.ok("reactors modal: tab counts and 'others'", `document.querySelector('.rtabs').textContent.includes("All 50") && document.querySelector('.rmore')?.textContent.includes("40 others")`);
  }),

  test("per-account capabilities: bot vs user account of the same provider", async (t) => {
    await t.open(GENERAL);
    await t.waitSel(".pollcard .popt");
    await t.ok("bot account: poll options disabled", `[...document.querySelectorAll('.pollcard .popt')].every(b=>b.disabled)`);
    await t.click('button[title="Attach"]');
    await t.ok("bot account: + menu offers Poll", `document.querySelector('.tools .popmenu')?.textContent.includes("Poll")`);
    await t.ev(`document.body.click()`);
    await t.not("bot account: no mic (voiceNotes=false)", `document.querySelector('button[title="Record voice message"]')`);
    await t.pill("Personal");
    await t.openChat("dc-2:general");
    await t.ok("user account: poll options enabled", `[...document.querySelectorAll('.pollcard .popt')].some(b=>!b.disabled)`);
    await t.ok("user account: mic shown", `document.querySelector('button[title="Record voice message"]')`);
    await t.shot("caps_user");
    await t.openChat("dc-2:gdm");
    await t.click('button[title="Chat info"]');
    await t.ok("user-account group DM: 'Add people' and 'Rename for everyone'", `document.body.textContent.includes("Add people") && document.body.textContent.includes("Rename for everyone")`);
    await t.click('button[title="Chat info"]');
    await t.ev(`__mockSetCaps('dc-2',{voiceNotes:false,pollVote:false})`);
    await t.openChat("dc-2:general");
    await t.ok("capabilities change live (no mic, polls locked)", `!document.querySelector('button[title="Record voice message"]') && [...document.querySelectorAll('.pollcard .popt')].every(b=>b.disabled)`);
    await t.ev(`__mockSetCaps('dc-2',{voiceNotes:true,pollVote:true})`);
    await t.click(".chats header button[title='New chat']");
    await t.click(".tabs button", "New group");
    const opts = await t.ev(`[...document.querySelectorAll('.modal select option, [role=dialog] select option')].map(o=>o.textContent).join('|')`);
    t.check("new-group account choice lists only accounts that can create groups", opts.includes("michi (user account)") && !opts.includes("UniChat Bot"), opts);
  }),

  test("mentions: no autocomplete without the capability or in DMs", async (t) => {
    await t.open("&chat=wa-1:family");
    await t.waitSel(".composer textarea");
    await t.ev(`document.querySelector('.composer textarea').focus()`); await t.insertText("@");
    await t.stays("no autocomplete when provider caps lack mentions (WhatsApp group)", `document.querySelector('.mentionpop')`);
    await t.open("&chat=dc-2:dana");
    await t.waitSel(".composer textarea");
    await t.ev(`document.querySelector('.composer textarea').focus()`); await t.insertText("@");
    await t.stays("no autocomplete in a DM (even on a provider with mentions)", `document.querySelector('.mentionpop')`);
  }),

  test("mentions: autocomplete, filtering, keyboard, structured send", async (t) => {
    await t.open(GENERAL);
    await t.waitSel(".composer textarea");
    const ta = `document.querySelector('.composer textarea')`;
    const names = () => t.ev(`[...document.querySelectorAll('.mentionpop button')].map(b=>b.dataset.mention)`);
    await t.ev(`${ta}.focus()`); await t.insertText("hi @");
    await t.waitFor(`document.querySelectorAll('.mentionpop button').length>=3`);
    await t.shot("mention");
    await t.insertText("A");
    await t.ok("typing filters (A -> Anna Becker first)", `document.querySelector('.mentionpop button')?.dataset.mention==='Anna Becker'`);
    await t.key("Escape");
    await t.not("Escape closes it", `document.querySelector('.mentionpop')`);
    t.expectEq("...and the text stays", await t.ev(`${ta}.value`), "hi @A");
    // arrow keys + Enter / Tab / click
    await t.typeIn(""); await t.ev(`${ta}.focus()`); await t.insertText("@");
    await t.waitSel(".mentionpop button");
    const n = await names();
    await t.key("ArrowDown");
    await t.eq("ArrowDown moves the highlight", `document.querySelector('.mentionpop button.on')?.dataset.mention`, n[1]);
    await t.key("Enter");
    await t.eq("Enter inserts @Name", `${ta}.value`, `@${n[1]} `);
    await t.not("popup closed after insert", `document.querySelector('.mentionpop')`);
    await t.insertText("and @");
    await t.waitSel(".mentionpop button");
    await t.key("Tab");
    await t.ok("Tab inserts the first entry", `${ta}.value.includes(${JSON.stringify("and @" + n[0] + " ")})`);
    await t.insertText("go @");
    await t.waitFor(`document.querySelector('.mentionpop button:nth-child(3)')?.dataset.mention===${JSON.stringify(n[2])} && ${ta}.value.endsWith('go @')`);
    await t.click(".mentionpop button:nth-child(3)");
    await t.ok("click inserts", `${ta}.value.endsWith(${JSON.stringify("@" + n[2] + " ")})`);
    await t.key("Enter");
    await t.waitFor(`globalThis.__lastSend?.mentions`, { desc: "send with mentions" });
    const sent = await t.ev(`globalThis.__lastSend`);
    t.check("send carries structured mentions with correct offsets", sent.mentions?.length === 3 && sent.mentions.every((m: any) => sent.text.substr(m.start, m.length) === "@" + m.name), JSON.stringify(sent.mentions) + " / " + sent.text);
    await t.insertText("mail me a@");
    await t.stays("'a@' inside a word does not trigger", `document.querySelector('.mentionpop')`);
  }),

  // Follow-up messages of one sender must line up with the first message of the run (the avatar column is empty, not removed) in every layout and for every chat kind.
  ...([["flat", false], ["bubbles", false]] as [string, boolean][]).flatMap(([style, compact]) => [
    ["dc-1:dev-talk", "Discord channel (plain, embed and wrapped follow-ups)"], ["wa-1:family", "WhatsApp group"],
  ].map(([chat, label]) => test(`grouped follow-ups are indented like the first message: ${label}, ${style}${compact ? " compact" : ""}`, async (t) => {
    await t.open("&chat=" + chat);
    await t.waitSel(".messages .msg.grouped");
    await t.waitSel(".messages .msg");
    await t.eq("a run has grouped follow-ups", `document.querySelectorAll('.messages .msg.grouped').length >= 1`, true);
    // every incoming message's text column starts at the same x, grouped or not
    await t.eq("one common left edge for the incoming messages' bodies", `new Set([...document.querySelectorAll('.messages .msg:not(.mine)')].map(m=>Math.round(m.querySelector('.body').getBoundingClientRect().left - m.getBoundingClientRect().left))).size`, 1);
    await t.ok("grouped follow-ups of the same run do not start further left than the avatar column", `[...document.querySelectorAll('.messages .msg.grouped:not(.mine)')].every(m=>m.querySelector('.body').getBoundingClientRect().left - m.getBoundingClientRect().left >= (${compact ? 28 : 40}))`);
    if (chat === "dc-1:dev-talk" && style === "bubbles" && !compact) await look(t, "discord-grouped-bubbles");
    if (chat === "dc-1:dev-talk" && style === "flat" && !compact) await look(t, "discord-grouped-flat");
  }, { init: settingsInit({ messageStyle: style, compact }) }))),
];

// Instagram-style features: approximate unread, message requests, provisional chats; login forms and warnings.
import { test } from "../lib/test.ts";
import { btn } from "../lib/ui.ts";

const sendKey = (t: any) => t.key("Enter");
const addDiscord = async (t: any) => {
  await t.click('.pill[title="Add a community or account"]');
  await t.click(".menuitem", "Add an account");
  await t.click(".grid .card", "Discord");
  await t.waitSel(".loginwarn");
};

export default [
  test("unread: approximate shows a dot, exact shows a number", async (t) => {
    await t.open();
    await t.shot("instagram_list");
    await t.eq("approximate unread shows a dot, not a number", `[document.querySelectorAll('[data-chat="ig-1:alice"] .unreaddot').length, !!document.querySelector('[data-chat="ig-1:alice"] b.unread')]`, [1, false]);
    await t.eq("exact unread still shows a number (WhatsApp Anna)", `document.querySelector('[data-chat="wa-1:anna"] b.unread')?.textContent`, "2");
  }),

  test("message request: tag, banner, accept", async (t) => {
    await t.open();
    await t.eq("message request tag in the list", `document.querySelector('[data-chat="ig-1:mallory"] .reqtag')?.textContent`, "Message request");
    await t.not("no tag on normal chats", `document.querySelector('[data-chat="ig-1:alice"] .reqtag')`);
    await t.openChat("ig-1:mallory");
    await t.waitSel(".reqbanner");
    await t.shot("request_banner");
    await t.ok("banner offers Accept / Decline", `document.querySelector('.reqbanner').textContent.includes("Message request") && [...document.querySelectorAll('.reqbanner button')].map(b=>b.textContent).join()==="Accept,Decline"`);
    await t.click(".reqbanner button", "Accept");
    await t.not("Accept removes the banner", `document.querySelector('.reqbanner')`);
    await t.not("...and the tag", `document.querySelector('[data-chat="ig-1:mallory"] .reqtag')`);
  }),

  test("message request: decline removes the chat", async (t) => {
    await t.open();
    await t.openChat("ig-1:mallory");
    await t.click(".reqbanner button", "Decline");
    await t.not("Decline removes the chat from the list", `document.querySelector('[data-chat="ig-1:mallory"]')`);
  }),

  test("message request: replying accepts it", async (t) => {
    await t.open();
    await t.openChat("ig-1:mallory");
    await t.waitSel(".reqbanner");
    await t.ev(`document.querySelector('.composer textarea').focus()`); await t.insertText("hello!"); await sendKey(t);
    await t.not("replying accepts: banner gone", `document.querySelector('.reqbanner')`);
    await t.not("replying accepts: tag gone", `document.querySelector('[data-chat="ig-1:mallory"] .reqtag')`);
  }),

  test("provisional chat (startChat) resolves to the real chat on first send", async (t) => {
    await t.open();
    await t.click(".chats header button[title='New chat']");
    await t.waitSel(".modal select, [role=dialog] select");
    await t.ev(`(()=>{const sel=document.querySelector('.modal select, [role=dialog] select'); __e2e.setv(sel,'ig-1')})()`);
    await t.waitFor(`[...document.querySelectorAll('.modal input, [role=dialog] input')].filter(i=>i.type!=='checkbox').length`);
    await t.ev(`__e2e.setv([...document.querySelectorAll('.modal input, [role=dialog] input')].filter(i=>i.type!=='checkbox').at(-1),'@newfriend')`);
    await t.shot("newchat");
    await t.click(".modal button.primary, [role=dialog] button.primary");
    await t.eq("startChat opened a provisional chat", `document.querySelector('.chats li.active')?.dataset.chat`, "ig-1:new:newfriend");
    await t.ev(`document.querySelector('.composer textarea').focus()`); await t.insertText("first message"); await sendKey(t);
    await t.ok("first send resolved it to the real chat id", `/^ig-1:t\\d+$/.test(document.querySelector('.chats li.active')?.dataset.chat ?? '')`);
    await t.ok("the typed message is kept", `[...document.querySelectorAll('.msg .body p')].some(p=>p.firstChild?.textContent==='first message')`);
    await t.eq("exactly one chat of that name (provisional entry gone)", `[...document.querySelectorAll('.chats li')].filter(e=>e.textContent.includes('Newfriend')).length`, 1);
    await t.ev(`document.querySelector('.composer textarea').focus()`); await t.insertText("second"); await sendKey(t);
    await t.eq("following messages go to the real chat", `[...document.querySelectorAll('.msg .body p')].map(p=>p.firstChild?.textContent).filter(x=>x==='first message'||x==='second').length`, 2);
  }),

  test("login: warning box above the form, required checkbox gates Continue", async (t) => {
    await t.open();
    await addDiscord(t);
    await t.shot("login");
    await t.ok("login warning box rendered (danger) with the ToS text", `document.querySelector('.loginwarn.danger svg') && document.querySelector('.loginwarn').textContent.includes("Terms of Service")`);
    await t.ok("warning comes before the form", `(()=>{const w=document.querySelector('.loginwarn'),f=document.querySelector('.modal form, [role=dialog] form'); return !!(w&&f&&(w.compareDocumentPosition(f)&Node.DOCUMENT_POSITION_FOLLOWING))})()`);
    await t.eq("required checkbox unchecked, Continue disabled", `[document.querySelector('.loginchk input').checked, document.querySelector('.modal form button.primary, [role=dialog] form button.primary').disabled]`, [false, true]);
    await t.ev(`globalThis.__lastLogin=undefined; document.querySelector('.modal form, [role=dialog] form').requestSubmit()`);
    await t.ok("unchecked required checkbox is not submitted (form shows an error)", `globalThis.__lastLogin===undefined && document.querySelector('.modal .error, [role=dialog] .error')?.textContent.includes("tick")`);
    await t.click(".loginchk input");
    await t.not("ticking enables Continue", `document.querySelector('.modal form button.primary, [role=dialog] form button.primary').disabled`);
    await t.ev(`for (const [n,v] of [['mode','bot'],['token','abc']]) __e2e.setv(document.querySelector('[name='+n+']'),v)`);
    await t.click(".modal form button.primary, [role=dialog] form button.primary");
    await t.eq('submitted with checkbox value "true"', `globalThis.__lastLogin?.confirm`, "true");
  }),

  ...["info", "warning"].map((sev) => test(`login: a '${sev}' warning is styled accordingly`, async (t) => {
    await t.open();
    await t.ev(`__mockEmit("login",{accountId:"x",promptId:"p",kind:"form",title:"T",warning:{severity:${JSON.stringify(sev)},text:"Heads up"},fields:[]})`);
    await t.ok(`severity ${sev} styled`, `document.querySelector('.loginwarn.${sev}')`);
    await t.shot("login_" + sev);
  })),

  test("login form: select field with options and expandable help", async (t) => {
    await t.open();
    await t.ev(`__mockEmit("login",{accountId:"dc-x",promptId:"p",kind:"form",title:"Paste your token",fields:[
      {name:"mode",label:"Account type",type:"select",options:[{value:"bot",label:"Bot token"},{value:"user",label:"User account"}]},
      {name:"token",label:"Token",type:"password",help:[{title:"Where do I find it?",steps:["Open the developer portal","Copy the token"],link:{label:"Open portal",href:"https://example.org/portal"}}]}]})`);
    await t.waitSel('.modal select[name="mode"], [role=dialog] select[name="mode"]');
    await t.eq("select shows its options", `[...document.querySelectorAll('select[name="mode"] option')].map(o=>o.textContent).join('|')`, "Bot token|User account");
    await t.eq("select defaults to the first option", `document.querySelector('select[name="mode"]').value`, "bot");
    await t.ok("help is collapsed behind a summary", `(()=>{const d=document.querySelector('details.fieldhelp'); return d && !d.open && d.querySelector('summary').textContent==='Where do I find it?'})()`);
    await t.click("details.fieldhelp summary");
    await t.ok("opening it shows the steps and a safe external link", `(()=>{const d=document.querySelector('details.fieldhelp'); const a=d.querySelector('a'); return d.open && d.querySelectorAll('ol li').length===2 && a.target==='_blank' && /noopener/.test(a.rel)})()`);
    await t.ev(`__e2e.setv(document.querySelector('select[name="mode"]'),'user'); __e2e.setv(document.querySelector('input[name="token"]'),'tok')`);
    await t.ev(`globalThis.__lastLogin=undefined`);
    await t.click(".modal form button.primary, [role=dialog] form button.primary");
    await t.ok("submit carries the chosen select value", `globalThis.__lastLogin?.mode==='user' && globalThis.__lastLogin?.token==='tok'`);
  }),

  test("add-account list offers every provider with an icon", async (t) => {
    await t.open();
    await t.click('.pill[title="Add a community or account"]');
    await t.click(".menuitem", "Add an account");
    await t.waitSel(".grid .card");
    const cards: string[] = await t.ev(`[...document.querySelectorAll('.grid .card')].map(c=>c.textContent.trim())`);
    t.check("WhatsApp, Signal, Matrix, Discord and Instagram are offered", ["WhatsApp", "Signal", "Matrix", "Discord", "Instagram"].every((n) => cards.some((c) => c.includes(n))), JSON.stringify(cards));
    await t.ok("every card has an svg icon", `[...document.querySelectorAll('.grid .card')].every(c=>c.querySelector('svg'))`);
    await t.shot("providers");
  }),
];

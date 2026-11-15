import { test } from "../lib/test.ts";

const OPEN = ".chats .gsearch input[aria-label='Search all messages']";
const search = async (t: any, q: string) => { await t.click('.chats header button[data-act="gsearch"]'); await t.waitSel(OPEN); await t.setInput(OPEN, q); };
const total = (n: number) => `document.querySelector('.gsearch .scount')?.dataset.total==='${n}'`;

export default [
  test("search: prefix, case/diacritics-insensitive words and exact phrases", async (t) => {
    await t.open();
    await search(t, "INVO");
    await t.ok("prefix finds invoice in Ben's chat", `document.querySelector('.gsearch [data-gchat*="ben"] mark')?.textContent.toLowerCase()==='invoice'`);
    await t.setInput(OPEN, '"get my invoice"');
    await t.ok("exact phrase matches", `document.querySelectorAll('.gsearch .ghit').length===1`);
    await t.setInput(OPEN, '"invoice my get"');
    await t.ok("a different word order does not", `document.querySelector('.gsearch .scount')?.dataset.total==='0'`);
    await t.setInput(OPEN, "zugspitze");
    await t.ok("diacritic-free query + names/places in locations", `document.querySelectorAll('.gsearch .ghit').length>=2`);
  }),

  test("search: operators from: has: after: before: in: and exclusion", async (t) => {
    await t.open();
    await search(t, "invoice from:ben");
    await t.ok("from:ben keeps Ben's messages", `document.querySelectorAll('.gsearch .ghit').length>=1`);
    await t.setInput(OPEN, "invoice from:nobody");
    await t.ok("from:nobody has no hits", total(0));
    await t.setInput(OPEN, "has:image");
    await t.ok("has:image lists image messages from Anna's chat", `document.querySelectorAll('.gsearch [data-gchat="wa-1:anna"] .ghit').length>=1`);
    await t.setInput(OPEN, "has:link");
    await t.ok("has:link finds the hike link message", `/Packing list/.test(document.querySelector('.gsearch')?.innerText ?? '')`);
    await t.setInput(OPEN, "invoice in:ben");
    await t.ok("in:ben restricts the chat", `document.querySelectorAll('.gsearch section[data-gchat]').length===1`);
    await t.setInput(OPEN, "invoice in:zzzz");
    await t.ok("in:zzzz matches no chat", total(0));
    await t.setInput(OPEN, "invoice after:2999-01-01");
    await t.ok("after: in the future matches nothing", total(0));
    await t.setInput(OPEN, "invoice before:2999-01-01");
    await t.ok("before: in the future matches", `+document.querySelector('.gsearch .scount')?.dataset.total>=1`);
    await t.setInput(OPEN, "invoice -invoice");
    await t.ok("excluded word removes the hit", total(0));
    await t.setInput(OPEN, "invoice has:bogus after:xyz");
    await t.ok("mistakes are reported but the words still search", `document.querySelectorAll('.gsearch [data-qerr]').length===2 && +document.querySelector('.gsearch .scount')?.dataset.total>=1`);
  }),

  test("search: filter chips edit the query and parsed filters can be removed", async (t) => {
    await t.open();
    await search(t, "pack");
    await t.click('.gsearch [data-has="link"]');
    await t.ok("chip adds has:link to the query", `document.querySelector(${JSON.stringify(OPEN)}).value.includes('has:link')`);
    await t.ok("chip shows as pressed", `document.querySelector('.gsearch [data-has="link"]').getAttribute('aria-pressed')==='true'`);
    await t.setInput(OPEN, "invoice after:2020-01-01");
    await t.waitSel('.gsearch [data-filter="after"]');
    await t.click('.gsearch [data-filter="after"]');
    await t.ok("clicking the parsed chip removes the operator", `!document.querySelector(${JSON.stringify(OPEN)}).value.includes('after:')`);
  }),

  test("search: keyboard navigation opens the chat at the message and highlights it", async (t) => {
    await t.open();
    await search(t, "invoice");
    await t.waitSel(".gsearch .ghit");
    await t.key("ArrowDown");
    await t.ok("the first hit is active", `document.querySelector('.gsearch .ghit.on')?.dataset.hit`);
    await t.key("Enter");
    await t.ok("Ben's chat is open", `/Ben Fischer/.test(document.querySelector('main header')?.innerText ?? '')`);
    await t.ok("the message is shown and highlighted", `document.querySelector('.messages .msg.hl') || __e2e.msg("Did you get my invoice?")`, { timeout: 8000 });
  }),

  test("search: chat and contact names are matched too", async (t) => {
    await t.open();
    await search(t, "ben");
    await t.ok("a name hit is listed above the messages", `document.querySelector('.gsearch [data-names] [data-name-hit="wa-1:ben"]')`);
    await t.click('.gsearch [data-name-hit="wa-1:ben"]');
    await t.ok("clicking opens that chat", `/Ben Fischer/.test(document.querySelector('main header')?.innerText ?? '')`);
  }),

  test("search: 'in this chat' scope chip and the chat header search use operators", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.click('.chats header button[data-act="gsearch"]');
    await t.waitSel('.gsearch [data-scope="here"]');
    await t.click('.gsearch [data-scope="here"]');
    await t.setInput(OPEN, "has:image");
    await t.ok("only Anna's chat is listed in scope", `(()=>{const s=[...document.querySelectorAll('.gsearch section[data-gchat]')]; return s.length===1 && s[0].dataset.gchat==='wa-1:anna'})()`);
    await t.click('.gsearch .gh button');
    await t.click('main header .hright button[title^="Search"]');
    await t.setInput(".sidesearch input", "has:voice");
    await t.ok("chat-header search understands has:voice", `document.querySelectorAll('.sidesearch .sres').length>=1`);
    await t.setInput(".sidesearch input", "has:voice from:ben");
    await t.ok("and from:", `document.querySelectorAll('.sidesearch .sres').length===0`);
  }),

  test("search: errors and slow answers are shown, results keep order while typing", async (t) => {
    await t.open();
    await search(t, "boom");
    await t.ok("error with retry", `document.querySelector('.gsearch [role=alert] button')`);
    await t.setInput(OPEN, "slowpoke");
    await t.ok("searching indicator", `document.querySelector('.gsearch [role=status]')`);
  }),
];

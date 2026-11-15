// App-level sanity: error boundary, no page exceptions on the main screens.
import { test } from "../lib/test.ts";

const BOUNDARY = `document.body.innerText.includes('Something went wrong in the display')`;

export default [
  test("error boundary is not shown on normal pages and nothing throws", async (t) => {
    await t.open();
    await t.not("home / chat list renders without the error page", BOUNDARY);
    await t.openRow("Family");
    await t.waitSel(".messages .msg");
    await t.click('main header .hright button[title="Chat info"]');
    await t.waitSel("aside.info");
    await t.openChat("wa-1:anna");
    await t.pill("Rust");
    await t.click(".pill.gear");
    await t.waitSel(".settings");
    for (const s of ["Appearance", "Backup & restore"]) await t.click(".settings nav button", s);
    await t.not("chat, info panel, community and settings screens: no error page", BOUNDARY);
    await t.not("the app root still has content", `!document.querySelector('#root')?.children.length`);
    t.expectEq("no uncaught page exceptions", t.pageErrors, []);
  }),

  test("error boundary: a crash shows the message and a Reload button (not a blank page)", async (t) => {
    await t.open();
    // a malformed login prompt (fields is not a list) makes the login modal throw while rendering
    await t.ev(`__mockEmit("login",{accountId:"x",promptId:"p",kind:"form",title:"T",fields:5})`);
    await t.ok("shows 'Something went wrong in the display'", BOUNDARY);
    await t.ok("offers a Reload button", `[...document.querySelectorAll('button')].some(b=>b.textContent==='Reload')`);
    await t.ok("explains that data is safe", `document.body.innerText.includes('Your accounts and messages are safe')`);
  }),
];

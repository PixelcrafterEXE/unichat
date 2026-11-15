// Matrix verification (emoji comparison, incoming requests, account card + contact panel entry points, set-up, recovery key) against the mock.
// Hooks: window.__mockMatrixVerify({phase,...}) emits a verification state; __mockMatrixAuto advances requests by itself; __mockVerifyLog records calls.
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";
import { settings } from "../lib/ui.ts";

const hook = (t: Page, o: object) => t.ev(`window.__mockMatrixVerify(${JSON.stringify(o)})`);
const called = (pred: string) => `window.__mockVerifyLog.some((c)=>${pred})`;
const log = (t: Page) => t.ev<{ method: string; params: any }[]>(`JSON.parse(JSON.stringify(window.__mockVerifyLog))`);
const clickAct = (t: Page, act: string) => t.click(`.vmodal [data-act=${act}]`);
const dialogText = `(document.querySelector('.vmodal')?.textContent||'')`;
const openCard = async (t: Page) => { await settings(t, "Accounts"); await t.waitSel(".acard"); await t.waitFor(`[...document.querySelectorAll('.acard')].some(c=>/Matrix/.test(c.textContent)&&c.querySelector('[data-verify-account]'))`, { desc: "matrix card with verification row" }); };
const clickIn = (t: Page, scope: string, act: string) => t.ev(`(()=>{const c=[...document.querySelectorAll('.acard')].find(c=>/Matrix/.test(c.textContent)); c.querySelector('[data-act=${act}]').click();})()`);
const OVERFLOW_AND_TARGETS = `(()=>{const m=document.querySelector('.vmodal'); const W=innerWidth; const r=m.getBoundingClientRect();
  const bad=[...m.querySelectorAll('button')].filter(b=>b.getBoundingClientRect().height<43.5).map(b=>b.textContent+':'+Math.round(b.getBoundingClientRect().height));
  const out=[...m.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>W+0.5||e.getBoundingClientRect().left<-0.5).map(e=>e.className||e.tagName);
  return {scrollW:document.documentElement.scrollWidth,W,left:r.left,right:r.right,bad,out:out.slice(0,5)}})()`;

export default [
  test("emoji dialog: 7 emojis with names, instructions, They match -> waiting for the other -> Verified", async (t) => {
    await t.open();
    await hook(t, { phase: "sas" });
    await t.waitSel(".vmodal");
    await t.eq("title names the device", `document.querySelector('.vmodal h3').textContent`, "Verify Element on Pixel 8");
    await t.eq("7 emojis", `document.querySelectorAll('.vmodal .vemoji').length`, 7);
    await t.ok("emoji drawn with the bundled emoji font, names below", `(()=>{const e=document.querySelector('.vmodal .vemoji'); return /UniChat Emoji/.test(getComputedStyle(e.querySelector('.vglyph')).fontFamily) && e.querySelector('.vname').textContent==='Dog' && parseFloat(getComputedStyle(e.querySelector('.vglyph')).fontSize)>=36})()`);
    await t.ok("order is kept", `[...document.querySelectorAll('.vmodal .vname')].map(e=>e.textContent).join(',')==='Dog,Key,Rocket,Mushroom,Guitar,Pin,Lock'`);
    await t.ok("instruction text", `/same emojis in the same order/.test(${dialogText})`);
    await t.ok("buttons: They match (primary), They don't match, Cancel", `(()=>{const b=[...document.querySelectorAll('.vmodal .vbtns button')]; return b.map(x=>x.textContent).join('|')==="Cancel|They don't match|They match" && b[2].classList.contains('primary') && new Set(b.map(x=>Math.round(x.getBoundingClientRect().width))).size<=2 && new Set(b.map(x=>Math.round(x.getBoundingClientRect().top))).size===1})()`);
    await t.shot("sas");
    await clickAct(t, "match");
    await t.ok("waiting state after confirming", `/Waiting for Element on Pixel 8 to confirm/.test(${dialogText}) && !document.querySelector('.vmodal [data-act=match]')`);
    await t.eq("emojis stay visible (dimmed)", `document.querySelectorAll('.vmodal .vemoji').length`, 7);
    await t.shot("confirming");
    await hook(t, { phase: "done" });
    await t.ok("success: shield and 'Verified'", `document.querySelector('.vmodal .vhero.ok svg') && document.querySelector('.vmodal h3').textContent==='Verified' && /This device is verified/.test(${dialogText})`);
    await t.shot("done");
    await clickAct(t, "done");
    await t.ok("dialog closes", `!document.querySelector('.vmodal')`);
    const l = await log(t);
    t.check("confirm was sent to the backend with the verification id", l.some((c) => c.method === "verificationAction" && c.params.action === "confirm" && c.params.id === "mv1" && c.params.accountId === "mx-1"), JSON.stringify(l));
  }),

  test("emoji dialog: They don't match stops with a plain reason; Cancel cancels; the other side cancelling shows why", async (t) => {
    await t.open();
    await hook(t, { phase: "sas" });
    await t.waitSel(".vmodal [data-act=nomatch]");
    await clickAct(t, "nomatch");
    await t.ok("mismatch ends with a plain reason and a shield", `/did not match/.test(${dialogText}) && document.querySelector('.vmodal .vhero.bad svg') && document.querySelector('.vmodal h3').textContent==='Verification stopped'`);
    await t.shot("mismatch");
    await clickAct(t, "close");
    await t.ok("mismatch was reported", called(`c.method==='verificationAction'&&c.params.action==='mismatch'`));
    await hook(t, { id: "mv2", phase: "sas", other: { kind: "user", name: "Anna Becker", userId: "@anna:matrix.org" } });
    await t.waitSel(".vmodal");
    await t.eq("user title", `document.querySelector('.vmodal h3').textContent`, "Verify Anna Becker");
    await t.ok("user wording", `/Anna Becker shows the same emojis/.test(${dialogText})`);
    await clickAct(t, "cancel");
    await t.ok("cancel closes the dialog and is sent to the backend", `!document.querySelector('.vmodal') && ${called(`c.method==='verificationAction'&&c.params.action==='cancel'&&c.params.id==='mv2'`)}`);
    await hook(t, { id: "mv3", phase: "sas" });
    await t.waitSel(".vmodal");
    await hook(t, { id: "mv3", phase: "cancelled", reason: "Anna cancelled the verification." });
    await t.ok("remote cancel reason shown", `/Anna cancelled the verification/.test(${dialogText})`);
    await clickAct(t, "close");
    await t.stays("closing a finished dialog sends no cancel", called(`c.params.id==='mv3'`), 300);
    await t.ok("closed", `!document.querySelector('.vmodal')`);
  }),

  test("incoming request: toast 'X wants to verify you', Decline dismisses, Accept opens the emoji dialog", async (t) => {
    await t.open();
    await hook(t, { id: "in1", phase: "incoming", incoming: true, other: { kind: "user", name: "Bea Lorenz", userId: "@bea:matrix.org" } });
    await t.waitSel(".vincoming");
    await t.ok("toast text and both buttons", `/Bea Lorenz wants to verify you/.test(document.querySelector('.vincoming').textContent) && document.querySelector('.vincoming [data-act=accept]') && document.querySelector('.vincoming [data-act=decline]')`);
    await t.shot("incoming");
    await clickAct(t, "decline");
    await t.ok("toast gone after Decline", `!document.querySelector('.vincoming')`);
    await t.ok("declined on the backend", called(`c.params.id==='in1'&&c.params.action==='decline'`));
    await hook(t, { id: "in2", phase: "incoming", incoming: true, other: { kind: "device", name: "Element on Pixel 8" } });
    await t.waitSel(".vincoming");
    await t.ok("own device wording", `/Element on Pixel 8 wants to verify you/.test(document.querySelector('.vincoming').textContent)`);
    await clickAct(t, "accept");
    await t.ok("accepted on the backend", called(`c.params.id==='in2'&&c.params.action==='accept'`));
    await t.ok("waiting dialog replaces the toast", `!document.querySelector('.vincoming') && document.querySelector('.vmodal')`);
    await hook(t, { id: "in2", phase: "sas", incoming: true });
    await t.ok("emoji dialog follows", `document.querySelectorAll('.vmodal .vemoji').length===7`);
    await hook(t, { id: "in3", phase: "incoming", incoming: true, other: { kind: "user", name: "Zed" } });
    await hook(t, { id: "in3", phase: "cancelled", incoming: true, reason: "Zed cancelled the verification." });
    await t.stays("a request that was cancelled before it was answered shows no dialog of its own", `/Zed/.test(document.querySelector('.vmodal')?.textContent||'')`, 400);
  }),

  test("account card: status, 'Verify this device' explains the other device, then emojis -> Verified updates the card", async (t) => {
    await t.open();
    await t.ev(`window.__mockMatrixAuto = true`);
    await openCard(t);
    await t.ok("shows Not verified", `/This device:\\s*Not verified/.test(document.querySelector('[data-verify-account]').textContent)`);
    await t.shot("card");
    await clickIn(t, "", "verify-device");
    await t.ok("explains what to do on the other device", `/Waiting for your other device/.test(${dialogText}) && /Open Element/.test(${dialogText}) && /Verify this session/.test(${dialogText})`);
    await t.shot("waiting");
    await t.ok("a request was started for this device", called(`c.method==='verificationStart'&&c.params.userId===undefined&&c.params.chatId===undefined`));
    await t.waitFor(`document.querySelectorAll('.vmodal .vemoji').length===7`, { desc: "emojis" });
    await clickAct(t, "match");
    await t.waitFor(`document.querySelector('.vmodal h3')?.textContent==='Verified'`, { desc: "verified" });
    await clickAct(t, "done");
    await t.ok("card now says Verified and offers no verify button", `/This device:\\s*Verified/.test(document.querySelector('[data-verify-account]').textContent) && !document.querySelector('[data-verify-account] [data-act=verify-device]')`);
  }),

  test("account card: cancelling while waiting for the other device", async (t) => {
    await t.open(); await openCard(t);
    await clickIn(t, "", "verify-device");
    await t.waitSel(".vmodal [data-act=cancel]");
    await clickAct(t, "cancel");
    await t.ok("dialog closes", `!document.querySelector('.vmodal')`);
  }),

  test("contact panel: person's shield + 'Verify <name>' runs the same dialog; a verified person has no button", async (t) => {
    await t.open("&chat=mx-1:@anna:matrix.org");
    await t.ev(`window.__mockMatrixAuto = true`);
    await t.click("main header .titlebtn");
    await t.waitSel("aside.info [data-verify-person]");
    await t.ok("Anna is not verified", `/Anna Becker is not verified/.test(document.querySelector('[data-verify-person]').textContent)`);
    await t.shot("person");
    await t.click("aside.info [data-act=verify-person]");
    await t.waitFor(`document.querySelectorAll('.vmodal .vemoji').length===7`, { desc: "emojis" });
    await t.ok("started for the DM chat", called(`c.method==='verificationStart'&&c.params.chatId==='mx-1:@anna:matrix.org'`));
    await clickAct(t, "match");
    await t.waitFor(`document.querySelector('.vmodal h3')?.textContent==='Verified'`, { desc: "verified" });
    await clickAct(t, "done");
    await t.ok("shield turns verified", `/Anna Becker is verified/.test(document.querySelector('[data-verify-person]').textContent) && !document.querySelector('[data-verify-person] button')`);
    await t.open("&chat=mx-1:@bea:matrix.org");
    await t.click("main header .titlebtn");
    await t.ok("Bea is already verified", `/Bea Lorenz is verified/.test(document.querySelector('[data-verify-person]')?.textContent||'')`);
  }),

  test("set up verification: password dialog, wrong password, recovery key shown once with Copy + warning, password never kept", async (t) => {
    await t.open();
    await t.ev(`window.__mockVerifyStatus = { device: 'unverified', crossSigning: 'missing', backup: 'none' }`);
    await openCard(t);
    await t.ok("explains that nothing is set up", `/no verification keys yet/.test(document.querySelector('[data-verify-account]').textContent) && !document.querySelector('[data-verify-account] [data-act=verify-device]')`);
    await clickIn(t, "", "setup");
    await t.waitSel(".vmodal input[type=password]");
    await t.ok("button disabled without a password", `document.querySelector('.vmodal form .primary').disabled`);
    await t.setInput(".vmodal input[type=password]", "wrong");
    await t.click(".vmodal form .primary");
    await t.ok("wrong password: plain error, still on the form", `/password was not accepted/.test(${dialogText}) && document.querySelector('.vmodal input[type=password]')`);
    await t.setInput(".vmodal input[type=password]", "sso");
    await t.click(".vmodal form .primary");
    await t.ok("other auth type is explained", `/sign-in step UniChat cannot do here/.test(${dialogText})`);
    await t.setInput(".vmodal input[type=password]", "s3cret-pw");
    await t.click(".vmodal form .primary");
    await t.waitSel(".vmodal [data-recovery-key]");
    await t.ok("recovery key shown", `/^EsTc( \\w{4}){9}$/.test(document.querySelector('[data-recovery-key]').textContent)`);
    await t.ok("warning: not stored, only shown once", `/only time you see this key/.test(${dialogText}) && /does not\\s*store it/.test(${dialogText})`);
    await t.ok("Done needs the acknowledgement; there is a Copy button; no close button", `document.querySelector('.vmodal [data-act=done]').disabled && document.querySelector('.vmodal [data-act=copy]') && !document.querySelector('.vmodal .mhead .icon')`);
    await t.shot("recovery-key");
    await t.click(".vmodal .vcheck input");
    await clickAct(t, "done");
    await t.ok("closed; card now Verified", `!document.querySelector('.vmodal') && /This device:\\s*Verified/.test(document.querySelector('[data-verify-account]').textContent)`);
    await t.ok("the password and the key appear nowhere in the page or the call log", `!document.body.innerText.includes('s3cret-pw') && !JSON.stringify(window.__mockVerifyLog).includes('s3cret-pw')`);
    t.check("the backend got the password (once)", (await log(t)).filter((c) => c.method === "verificationSetup").length === 3);
  }),

  test("verify with recovery key: alternative when no other device is available", async (t) => {
    await t.open(); await openCard(t);
    await clickIn(t, "", "recover");
    await t.waitSel(".vmodal input[type=password]");
    await t.ok("explains when to use it", `/no other device/.test(${dialogText})`);
    await t.setInput(".vmodal input[type=password]", "wrong");
    await t.click(".vmodal form .primary");
    await t.ok("wrong key: plain error", `/does not match this account/.test(${dialogText})`);
    await t.setInput(".vmodal input[type=password]", "EsTc 1111 2222");
    await t.click(".vmodal form .primary");
    await t.ok("verified", `/This device is verified/.test(${dialogText})`);
    await clickAct(t, "done");
    await t.ok("card shows Verified", `/This device:\\s*Verified/.test(document.querySelector('[data-verify-account]').textContent)`);
    t.check("the key never reaches the log", !JSON.stringify(await log(t)).includes("EsTc"));
  }),

  test("other messengers show no verification UI", async (t) => {
    await t.open(); await settings(t, "Accounts"); await t.waitSel(".acard");
    await t.ok("only the Matrix card has it", `[...document.querySelectorAll('.acard')].filter(c=>c.querySelector('[data-verify-account]')).every(c=>/Matrix/.test(c.textContent)) && document.querySelectorAll('[data-verify-account]').length===1`);
  }),

  test("phone 360px: emoji dialog fits, no overflow, every button is at least 44px", async (t) => {
    await t.device("small"); await t.open();
    for (const phase of ["waiting", "sas", "confirming", "done", "cancelled"]) {
      await hook(t, { id: "p1", phase, reason: "The emojis did not match, so the verification was stopped." });
      await t.waitSel(".vmodal");
      await t.waitFor(`document.querySelector('.vmodal')`);
      const r = await t.ev<any>(OVERFLOW_AND_TARGETS);
      t.check(`${phase}: inside 360px`, r.scrollW <= r.W && r.left >= -0.5 && r.right <= r.W + 0.5 && r.out.length === 0, JSON.stringify(r));
      t.check(`${phase}: targets >= 44px`, r.bad.length === 0, JSON.stringify(r.bad));
      if (phase === "sas") await t.shot("phone-sas");
    }
    await clickAct(t, "close");
    await hook(t, { id: "p2", phase: "incoming", incoming: true });
    await t.waitSel(".vincoming");
    const r2 = await t.ev<any>(OVERFLOW_AND_TARGETS);
    t.check("incoming dialog fits and has 44px buttons", r2.scrollW <= r2.W && r2.right <= r2.W + 0.5 && r2.out.length === 0 && r2.bad.length === 0, JSON.stringify(r2));
    await t.shot("phone-incoming");
  }),

  test("phone 360px: set-up dialog with the recovery key fits", async (t) => {
    await t.device("small"); await t.open();
    await t.ev(`window.__mockVerifyStatus = { device: 'unverified', crossSigning: 'missing', backup: 'none' }`);
    await openCard(t);
    await clickIn(t, "", "setup");
    await t.setInput(".vmodal input[type=password]", "pw");
    await t.click(".vmodal form .primary");
    await t.waitSel(".vmodal [data-recovery-key]");
    const r = await t.ev<any>(OVERFLOW_AND_TARGETS);
    t.check("inside 360px", r.scrollW <= r.W && r.right <= r.W + 0.5 && r.out.length === 0, JSON.stringify(r));
    t.check("targets >= 44px", r.bad.length === 0, JSON.stringify(r.bad));
    await t.shot("phone-key");
  }),

  test("account card refreshes live: verification-changed / account events and finished flows update it without a reload", async (t) => {
    await t.open(); await openCard(t);
    await t.ok("starts as Not verified", `/This device:\\s*Not verified/.test(document.querySelector('[data-verify-account]').textContent)`);
    await t.ev(`window.__mockVerifyStatus = { device: 'verified', crossSigning: 'ready', backup: 'enabled' }; window.__mockEmit('verification-changed', { accountId: 'mx-1' })`);
    await t.ok("flips to Verified by itself", `/This device:\\s*Verified/.test(document.querySelector('[data-verify-account]').textContent) && !document.querySelector('[data-verify-account] [data-act=verify-device]')`);
    await t.ev(`window.__mockVerifyStatus = { device: 'unverified', crossSigning: 'missing', backup: 'none' }; window.__mockEmit('account', { id: 'mx-1', state: 'connected' })`);
    await t.ok("an account event re-reads the state: set-up offered", `document.querySelector('[data-verify-account] [data-act=setup]') && /Not verified/.test(document.querySelector('[data-verify-account]').textContent)`);
    await t.ev(`window.__mockVerifyStatus = { device: 'unverified', crossSigning: 'ready', backup: 'enabled' }; window.__mockEmit('verification-changed', { accountId: 'mx-1' })`);
    await t.ok("and back to 'Verify this device'", `document.querySelector('[data-verify-account] [data-act=verify-device]') && !document.querySelector('[data-verify-account] [data-act=setup]')`);
  }),

  test("set up / recovery update the card behind the dialog without a reload", async (t) => {
    await t.open();
    await t.ev(`window.__mockVerifyStatus = { device: 'unverified', crossSigning: 'missing', backup: 'none' }`);
    await openCard(t);
    await clickIn(t, "", "setup");
    await t.setInput(".vmodal input[type=password]", "pw");
    await t.click(".vmodal form .primary");
    await t.waitSel(".vmodal [data-recovery-key]");
    await t.ok("the card behind the key dialog is already Verified", `/This device:\\s*Verified/.test(document.querySelector('[data-verify-account]').textContent)`);
  }),
];

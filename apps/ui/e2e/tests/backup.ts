// Settings > Data on the mock UI: native file dialogs (desktop shell, faked as window.unimsg) and the "Move a login to another device" wizard.
import { test } from "../lib/test.ts";

// A fake desktop shell: dialogs answer with canned paths and record what they were asked; the backup RPCs are recorded by mockBackup.ts.
const SHELL = (save: string | null, open: string | null, file = "MOCKBK:secretpass1") => `
window.__native={save:0,open:0,reveal:[],names:[]};window.__mockFiles={${JSON.stringify(open ?? "/none")}:${JSON.stringify(file)}};
window.unimsg={showSaveDialog:async(r)=>{__native.save++;__native.names.push(r&&r.suggestedName);return ${save ? `{canceled:false,path:${JSON.stringify(save)}}` : `{canceled:true}`}},
 showOpenDialog:async()=>{__native.open++;return ${open ? `{canceled:false,path:${JSON.stringify(open)}}` : `{canceled:true}`}},
 revealInFolder:async(p)=>{__native.reveal.push(p);return{ok:true}},call:async()=>{throw new Error('mock UI uses the mock transport')},onEvent:()=>()=>{}};`;
const calls = (m: string) => `(__mockBackupLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
const openData = async (t: any) => { await t.open("&settings"); await t.click(".settings nav button", "Backup & restore"); await t.waitSel("#bk-export"); };
const openMove = async (t: any) => { await t.open("&settings"); await t.click(".settings nav button", "Move to another device"); await t.waitSel("#bk-move"); await t.ev(`document.getElementById('mvp-file').open = true`); };
const fill = (t: any, pairs: [string, string][]) => Promise.all(pairs.map(([s, v]) => t.setInput(s, v)));

export default [
  test("desktop: export asks the native save dialog first, writes to that path, reveals it", async (t) => {
    await openData(t);
    await fill(t, [["#bk-pw", "a long passphrase"], ["#bk-pw2", "a long passphrase"]]);
    await t.click("#bk-go");
    await t.waitSel("#bk-done");
    const p = await t.ev(`${calls("exportData")}[0].params`);
    t.expectEq("exportData got the chosen targetPath and no download ticket", [p.targetPath, p.deliver], ["/home/u/out.unimsg-backup", undefined]);
    t.expectEq("save dialog asked once with a .unimsg-backup name", await t.ev(`[__native.save, /\\.unimsg-backup$/.test(__native.names[0])]`), [1, true]);
    t.expectEq("the saved file is revealed in the file manager", await t.ev(`__native.reveal`), ["/home/u/out.unimsg-backup"]);
    await t.ok("result shows the path", `document.querySelector('#bk-done').innerText.includes('/home/u/out.unimsg-backup')`);
  }, { init: SHELL("/home/u/out.unimsg-backup", null) }),

  test("desktop: cancelling the save dialog exports nothing", async (t) => {
    await openData(t);
    await fill(t, [["#bk-pw", "a long passphrase"], ["#bk-pw2", "a long passphrase"]]);
    await t.click("#bk-go");
    await t.waitFor(`__native.save===1`);
    await t.stays("no export call after cancel", `${calls("exportData")}.length>0 || !!document.querySelector('#bk-done')`, 500);
  }, { init: SHELL(null, null) }),

  test("desktop: import uses the native open dialog and passes a path, not an upload", async (t) => {
    await openData(t);
    await t.click("#bk-drop");
    await t.waitSel("#bk-ipw");
    await t.setInput("#bk-ipw", "secretpass1");
    await t.click("#bk-check");
    await t.waitSel("#bk-info");
    await t.click("#bk-import-go");
    await t.waitSel("#bk-result");
    const i = await t.ev(`${calls("importInspect")}[0].params`), d = await t.ev(`${calls("importData")}[0].params`);
    t.expectEq("importInspect names the chosen path", [i.path, i.uploadId], ["/home/u/in.unimsg-backup", undefined]);
    t.expectEq("importData names the chosen path", [d.path, d.uploadId], ["/home/u/in.unimsg-backup", undefined]);
    await t.eq("no chunked upload was used", `${calls("backupUploadStart")}.length`, 0);
  }, { init: SHELL(null, "/home/u/in.unimsg-backup") }),

  test("move login (source): several accounts in one file, wiped one by one after the final confirm", async (t) => {
    await openMove(t);
    await t.click("#mv-away");
    await t.waitSel("#mv-acct-wa-1");
    await t.click("#mv-acct-wa-1"); await t.click("#mv-acct-dc-1");
    await t.ok("next shows how many accounts", `/2 accounts/.test(document.querySelector('#mv-next').innerText)`);
    await t.click("#mv-next");
    await t.waitSel("#mv-warn-bound");
    await t.ok("both providers get their own warning", `!!document.querySelector('#mv-warn-bound') && !!document.querySelector('#mv-warn-token')`);
    await t.click("#mv-ready"); await t.click("#mv-next");
    await t.waitSel("#mv-export");
    await fill(t, [["#mv-pw", "move us please"], ["#mv-pw2", "move us please"]]);
    await t.click("#mv-export");
    await t.waitSel("#mv-wipe");
    const e = await t.ev(`${calls("exportData")}[0].params`);
    t.expectEq("one session-only archive with both accounts", [e.accountIds, e.parts], [["wa-1", "dc-1"], { data: false, sessions: true }]);
    await t.eq("nothing wiped yet", `${calls("moveAwayAccount")}.length`, 0);
    await t.click("#mv-saved"); await t.click("#mv-wipe");
    await t.waitSel("#mv-done");
    t.expectEq("each account is wiped, with the confirmation flag", await t.ev(`${calls("moveAwayAccount")}.map(c=>c.params)`), [{ accountId: "wa-1", confirmedSaved: true }, { accountId: "dc-1", confirmedSaved: true }]);
  }, { init: SHELL("/home/u/login2.unimsg-backup", null) }),

  test("move login (source): wizard order, per-provider warning, export is session-only, wipe only after the final confirm", async (t) => {
    await openMove(t);
    await t.click("#mv-away");
    await t.waitSel("#mv-acct-wa-1");
    await t.ok("next is disabled until an account is picked", `document.querySelector('#mv-next').disabled`);
    await t.click("#mv-acct-wa-1"); await t.click("#mv-next");
    await t.waitSel("#mv-warn-bound");
    await t.ok("WhatsApp gets the 'only one device' warning", `/ONE device/.test(document.querySelector('#mv-warn-bound').innerText)`);
    await t.ok("it says the account is NOT signed out remotely", `/not signed out on the network/i.test(document.querySelector('#mv-source').innerText)`);
    await t.ok("next needs the ready checkbox", `document.querySelector('#mv-next').disabled`);
    await t.click("#mv-ready"); await t.click("#mv-next");
    await t.waitSel("#mv-export");
    await t.ok("export needs matching passphrases", `document.querySelector('#mv-export').disabled`);
    await fill(t, [["#mv-pw", "move me please"], ["#mv-pw2", "move me please"]]);
    await t.click("#mv-export");
    await t.waitSel("#mv-wipe");
    const e = await t.ev(`${calls("exportData")}[0].params`);
    t.expectEq("session-only archive of exactly that account", [e.accountIds, e.parts, e.targetPath], [["wa-1"], { data: false, sessions: true }, "/home/u/login.unimsg-backup"]);
    t.expectEq("the file is revealed", await t.ev(`__native.reveal`), ["/home/u/login.unimsg-backup"]);
    await t.ok("wipe button is disabled until 'I have the file'", `document.querySelector('#mv-wipe').disabled`);
    await t.eq("nothing was wiped yet", `${calls("moveAwayAccount")}.length`, 0);
    await t.click("#mv-saved");
    await t.not("wipe is enabled after the checkbox", `document.querySelector('#mv-wipe').disabled`);
    await t.click("#mv-wipe");
    await t.waitSel("#mv-done");
    t.expectEq("moveAwayAccount with confirmedSaved", await t.ev(`${calls("moveAwayAccount")}.map(c=>c.params)`), [{ accountId: "wa-1", confirmedSaved: true }]);
    await t.shot("move-login-done");
  }, { init: SHELL("/home/u/login.unimsg-backup", null) }),

  test("move login (source): token providers get the softer warning; 'not now' leaves the session alone", async (t) => {
    await openMove(t);
    await t.click("#mv-away"); await t.click("#mv-acct-dc-1"); await t.click("#mv-next");
    await t.waitSel("#mv-warn-token");
    await t.not("no 'only one device' warning for a token provider", `document.querySelector('#mv-warn-bound')`);
    await t.click("#mv-ready"); await t.click("#mv-next");
    await fill(t, [["#mv-pw", "move me please"], ["#mv-pw2", "move me please"]]);
    await t.click("#mv-export"); await t.waitSel("#mv-later");
    await t.click("#mv-later");
    await t.eq("moveAwayAccount never called", `${calls("moveAwayAccount")}.length`, 0);
  }, { init: SHELL("/home/u/dc.unimsg-backup", null) }),

  test("move login (source) in the browser: archive is delivered as a download", async (t) => {
    await openMove(t);
    await t.click("#mv-away"); await t.click("#mv-acct-wa-1"); await t.click("#mv-next"); await t.click("#mv-ready"); await t.click("#mv-next");
    await fill(t, [["#mv-pw", "move me please"], ["#mv-pw2", "move me please"]]);
    await t.click("#mv-export"); await t.waitSel("#mv-wipe");
    const e = await t.ev(`${calls("exportData")}[0].params`);
    t.expectEq("download ticket, no path", [e.deliver, e.targetPath], ["download", undefined]);
  }),

  test("move login (target): import in merge mode, confirm only after the old device is wiped", async (t) => {
    await openMove(t);
    await t.click("#mv-here");
    await t.upload("#mv-fileinput", [t.fixture("login.unimsg-backup")]);
    await t.setInput("#mv-ipw", "correct horse battery");
    await t.click("#mv-check");
    await t.waitSel("#mv-info");
    await t.ok("shows the single account and the WhatsApp warning", `document.querySelector('#mv-info').innerText.includes('Old phone') && !!document.querySelector('#mv-warn-bound')`);
    await t.click("#mv-import");
    await t.waitSel("#mv-confirm");
    const d = await t.ev(`${calls("importData")}[0].params`);
    t.expectEq("merge mode, sessions only", [d.mode, d.parts], ["merge", { media: false, sessions: true }]);
    await t.ok("start is disabled until the old device is confirmed wiped", `document.querySelector('#mv-start').disabled`);
    await t.eq("not started yet", `${calls("confirmMovedAccount")}.length`, 0);
    await t.click("#mv-old-stopped"); await t.click("#mv-start");
    await t.waitSel("#mv-started");
    t.expectEq("confirmMovedAccount for the imported account", await t.ev(`${calls("confirmMovedAccount")}.map(c=>c.params)`), [{ accountId: "wa-9" }]);
  }),

  test("move login (target): a normal backup without session is refused", async (t) => {
    await openMove(t);
    await t.click("#mv-here");
    await t.upload("#mv-fileinput", [t.fixture("plain.unimsg-backup")]);
    await t.setInput("#mv-ipw", "plainpass1"); await t.click("#mv-check");
    await t.waitSel("#mv-ierr");
    await t.ok("explains that the file has no session", `/no sign-in session/.test(document.querySelector('#mv-ierr').innerText)`);
  }),
];

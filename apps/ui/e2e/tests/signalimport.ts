// Import Signal history (SignalBackupImport.tsx on the mock backend). The page is mounted standalone with `&signalimport` (see mockSignalImport.ts),
// so these tests do not depend on where Settings places the component. A mock backup file is `MOCKSIG:<legacy|secure>:<secret>[:flag]`.
import { test } from "../lib/test.ts";

const PASS = "123456789012345678901234567890", KEY = "a".repeat(64);
const SHELL = (file: string, path = "/home/u/signal-2026-11-01-10-00-00.backup") => `
window.__native={open:0};window.__mockFiles={${JSON.stringify(path)}:${JSON.stringify(file)}};
window.unimsg={showSaveDialog:async()=>({canceled:true}),showOpenDialog:async()=>{__native.open++;return {canceled:false,path:${JSON.stringify(path)}}},revealInFolder:async()=>({ok:true}),call:async()=>{throw new Error('mock')},onEvent:()=>()=>{}};`;
const calls = (m: string) => `(__mockSignalImportLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
const open = async (t: any) => { await t.open("&signalimport"); await t.waitSel("#sbi-explain"); };
const toForm = async (t: any) => { await t.click("#sbi-start"); await t.waitSel("#sbi-drop"); };
const chooseFile = async (t: any, secret: string) => { await t.click("#sbi-drop"); await t.waitFor(`/signal-2026/.test(document.querySelector('#sbi-drop').textContent)`); await t.setInput("#sbi-pw", secret); };

export default [
  test("the import lives on the Signal account card (Settings > Accounts), not under Backup", async (t) => {
    await t.open("&settings&signalimport");
    await t.waitSel("#signal-history");
    await t.click("#signal-history");
    await t.waitSel(".acard #sbi-explain");
    t.expectEq("no account picker needed", await t.ev(`!document.querySelector('#sbi-account')`), true);
    await t.click(".settings nav button", "Backup & restore"); await t.waitSel("#bk-export");
    t.expectEq("not in Backup & restore any more", await t.ev(`!document.querySelector('#sbi-explain')`), true);
  }),
  test("explains how to make the backup, the passphrase field groups digits and validates length", async (t) => {
    await open(t);
    await t.ok("explains where to find the backup", `/Settings > Chats > Chat backups > Create backup/.test(document.querySelector('#sbi-explain').innerText.replace(/&gt;/g,'>')) && /30 digits/.test(document.querySelector('#sbi-explain').innerText)`);
    await t.ok("secure-backup option is described (64 characters, text only)", `/64-character/.test(document.querySelector('#sbi-explain').innerText)`);
    await toForm(t);
    await t.ok("check is disabled without file and key", `document.querySelector('#sbi-check').disabled`);
    await t.setInput("#sbi-pw", "1234567890123456789012345-6789x");
    await t.eq("digits are grouped in fives, other characters dropped", `document.querySelector('#sbi-pw').value`, "12345 67890 12345 67890 12345 6789");
    await t.ok("counter shows progress", `/29 of 30 digits/.test(document.querySelector('#sbi-pwhint').textContent)`);
    await t.setInput("#sbi-pw", PASS.replace(/(.{5})/g, "$1 "));
    await t.eq("30 digits with spaces are accepted (still no file)", `document.querySelector('#sbi-check').disabled`, true);
  }),

  test("desktop dialog: choose file, wrong passphrase error, inspect, options, import with progress, result and Open chats", async (t) => {
    await open(t); await toForm(t);
    await chooseFile(t, "00000 00000 00000 00000 00000 00000");
    await t.click("#sbi-check");
    await t.ok("wrong passphrase gives a clear error", `/Wrong passphrase/.test(document.querySelector('#sbi-err')?.textContent||'')`);
    await t.setInput("#sbi-pw", PASS.replace(/(.{5})/g, "$1 ")); await t.click("#sbi-check");
    await t.waitSel("#sbi-info");
    const i = await t.ev(`${calls("signalBackupInspect")}.at(-1).params`);
    t.expectEq("inspect names the chosen path (no upload) and sends digits only", [i.path, i.uploadId, i.format, i.accountId, i._len], ["/home/u/signal-2026-11-01-10-00-00.backup", undefined, "android-legacy", "sg-1", 30]);
    await t.ok("counts, chats and attachment size are shown", `(x=>/1,?234/.test(x.querySelector('#sbi-n-msgs').textContent)&&/4 one-to-one, 2 groups/.test(x.querySelector('#sbi-n-chats').textContent)&&/40/.test(x.querySelector('#sbi-n-att').textContent)&&/MB/.test(x.querySelector('#sbi-n-att').textContent))(document.querySelector('#sbi-info'))`);
    await t.ok("account matches", `!!document.querySelector('#sbi-match')`);
    await t.ok("attachments are on by default, with a storage estimate", `document.querySelector('#sbi-att').checked && /MB/.test(document.querySelector('#sbi-info').textContent)`);
    await t.shot("inspect");
    await t.setInput("#sbi-from", "2020-01-01");
    await t.click("#sbi-go");
    await t.ok("progress bar and cancel while importing", `document.querySelector('#sbi-bar .bar') && document.querySelector('#sbi-cancel')`);
    await t.waitSel("#sbi-result", undefined, { timeout: 15000 });
    const d = await t.ev(`${calls("signalBackupImport")}.at(-1).params`);
    t.expectEq("import params: account, attachments, since, confirmations", [d.accountId, d.options.attachments, /^2020-01-01T/.test(d.options.since) || /^2019-12-31T/.test(d.options.since), d.options.until, d.confirmMismatch, d.confirmUnverified], ["sg-1", true, true, undefined, false, false]);
    await t.ok("summary lists what was added", `(x=>/1,?200/.test(x)&&/31 were already here/.test(x)&&/6 conversations/.test(x)&&/38 files stored/.test(x))(document.querySelector('#sbi-result').textContent)`);
    await t.click("#sbi-open");
    await t.eq("Open chats hands the account to the host", `globalThis.__sbiOpened`, "sg-1");
    await t.shot("result");
  }, { init: SHELL(`MOCKSIG:legacy:${PASS}`) }),

  test("cancel while importing: error shown, nothing reported as imported, can retry", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-info");
    await t.click("#sbi-go"); await t.waitSel("#sbi-cancel"); await t.click("#sbi-cancel");
    await t.ok("cancelled message", `/Cancelled/.test(document.querySelector('#sbi-err')?.textContent||'')`);
    await t.stays("no result box", `!!document.querySelector('#sbi-result')`, 400);
    await t.ok("import button is available again", `!document.querySelector('#sbi-go').disabled`);
  }, { init: SHELL(`MOCKSIG:legacy:${PASS}:slow`) }),

  test("another account's backup needs an explicit confirmation", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-mismatch");
    await t.ok("import disabled until confirmed", `document.querySelector('#sbi-go').disabled`);
    await t.click("#sbi-confirm"); await t.ok("now enabled", `!document.querySelector('#sbi-go').disabled`);
    await t.click("#sbi-go"); await t.waitSel("#sbi-result", undefined, { timeout: 15000 });
    t.expectEq("confirmMismatch is sent", await t.ev(`${calls("signalBackupImport")}.at(-1).params.confirmMismatch`), true);
  }, { init: SHELL(`MOCKSIG:legacy:${PASS}:mismatch`) }),

  test("signed-out account: unverified backup needs a confirmation too", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-unverified");
    await t.ok("import disabled", `document.querySelector('#sbi-go').disabled`);
    await t.click("#sbi-confirm"); await t.click("#sbi-go"); await t.waitSel("#sbi-result", undefined, { timeout: 15000 });
    t.expectEq("confirmUnverified is sent", await t.ev(`${calls("signalBackupImport")}.at(-1).params.confirmUnverified`), true);
  }, { init: SHELL(`MOCKSIG:legacy:${PASS}:unknown`) }),

  test("secure backup (single file, no media folder): 64-character key, no attachment option, text-only warning", async (t) => {
    await open(t); await t.click("#sbi-k-secure"); await toForm(t);
    await chooseFile(t, KEY.toUpperCase().replace(/(.{4})/g, "$1-"));
    await t.ok("key counter", `/64 of 64/.test(document.querySelector('#sbi-pwhint').textContent)`);
    await t.click("#sbi-check"); await t.waitSel("#sbi-info");
    const i = await t.ev(`${calls("signalBackupInspect")}.at(-1).params`);
    t.expectEq("format and normalised key", [i.format, i._len], ["secure-backup", 64]);
    await t.ok("attachments cannot be selected and the page says why", `document.querySelector('#sbi-att').disabled && /no media folder found/.test(document.querySelector('#sbi-n-att').textContent) && /no media/i.test(document.querySelector('#sbi-info').textContent)`);
    await t.click("#sbi-go"); await t.waitSel("#sbi-result", undefined, { timeout: 15000 });
    t.expectEq("attachments option off", await t.ev(`${calls("signalBackupImport")}.at(-1).params.options.attachments`), false);
  }, { init: SHELL(`MOCKSIG:secure:${KEY}`, "/home/u/signal-2026-11-01.binary") }),

  test("browser: a chosen file is uploaded in chunks and passed by uploadId", async (t) => {
    await open(t); await toForm(t);
    await t.ev(`(()=>{const f=new File(['x'],'signal-2026-11-01-10-00-00.backup');const dt=new DataTransfer();dt.items.add(f);const i=document.querySelector('#sbi-file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await t.waitFor(`/signal-2026/.test(document.querySelector('#sbi-drop').textContent)`);
    await t.setInput("#sbi-pw", PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-info");
    const i = await t.ev(`${calls("signalBackupInspect")}.at(-1).params`);
    t.expectEq("uploadId, not path", [!!i.uploadId, i.path], [true, undefined]);
  }),

  test("the passphrase is not kept in the page after a successful import", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-info");
    await t.click("#sbi-go"); await t.waitSel("#sbi-result", undefined, { timeout: 15000 });
    await t.ok("no input holds the secret and the text is not in the DOM", `![...document.querySelectorAll('input')].some(i=>i.value.includes('12345'))&&!document.body.innerText.includes('${PASS}')`);
  }, { init: SHELL(`MOCKSIG:legacy:${PASS}`) }),
  test("Android: 'Find the backup on this phone' copies the chosen Signal backup, then the passphrase step works", async (t) => {
    const safCalls = (m: string) => `(__mockSafLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
    await open(t); await toForm(t);
    await t.click("#saf-find"); await t.waitSel("#saf-files");
    await t.ok("two backups listed, no media section", `document.querySelectorAll('#saf-files input').length===2&&!document.querySelector('#saf-media')`);
    await t.click("#saf-copy"); await t.waitSel("#saf-done");
    t.expectEq("copy names the file", await t.ev(`${safCalls("$backupCopy")}.at(-1).params`), { kind: "signal", name: "signal-2026-11-10-04-00-00.backup", media: [] });
    await t.ok("the file is chosen", `/signal-2026-11-10/.test(document.querySelector('#sbi-drop').textContent)`);
    await t.setInput("#sbi-pw", PASS); await t.click("#sbi-check"); await t.waitSel("#sbi-info");
    t.expectEq("inspect reads the copied path", (await t.ev(`__mockSignalImportLog.filter(c=>c.method==='signalBackupInspect').at(-1).params.path`)), "/data/.backup/saf/signal/signal-2026-11-10-04-00-00.backup");
  }, { init: `window.__mockSaf=1;window.__mockSafContent=${JSON.stringify(`MOCKSIG:legacy:${PASS}`)};` }),
];

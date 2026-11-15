// Import WhatsApp history (WhatsAppBackupImport.tsx on the mock backend). The page is mounted standalone with `&whatsappimport` (see mockWhatsAppImport.ts).
// A mock backup file is `MOCKWA:<crypt15|crypt14>:<secret>[:flag]`.
import { test } from "../lib/test.ts";

const KEY = "0123456789abcdef".repeat(4);
const SHELL = (file: string, path = "/home/u/WhatsApp/Databases/msgstore.db.crypt15") => `
window.__native={open:0};window.__mockFiles={${JSON.stringify(path)}:${JSON.stringify(file)}};
window.unimsg={showSaveDialog:async()=>({canceled:true}),showOpenDialog:async()=>{__native.open++;return {canceled:false,path:${JSON.stringify(path)}}},revealInFolder:async()=>({ok:true}),call:async()=>{throw new Error('mock')},onEvent:()=>()=>{}};`;
const calls = (m: string) => `(__mockWhatsAppImportLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
const open = async (t: any) => { await t.open("&whatsappimport"); await t.waitSel("#wbi-explain"); };
const toForm = async (t: any) => { await t.click("#wbi-start"); await t.waitSel("#wbi-drop"); };
const chooseFile = async (t: any, secret?: string) => { await t.click("#wbi-drop"); await t.waitFor(`/msgstore/.test(document.querySelector('#wbi-drop').textContent)`); if (secret !== undefined) await t.setInput("#wbi-pw", secret); };

export default [
  test("the import lives on the WhatsApp account card (Settings > Accounts)", async (t) => {
    await t.open("&settings&whatsappimport");
    await t.waitSel("#whatsapp-history");
    await t.click("#whatsapp-history");
    await t.waitSel(".acard #wbi-explain");
    t.expectEq("no account picker needed", await t.ev(`!document.querySelector('#wbi-account')`), true);
    t.expectEq("no Signal import opened", await t.ev(`!document.querySelector('#sbi-explain')`), true);
  }),
  test("explains the encrypted-backup steps and validates the key field (password type, 64 hex digits)", async (t) => {
    await open(t);
    await t.ok("explains where the key and the file come from", `(x=>/End-to-end encrypted backup/.test(x)&&/64 digits/.test(x)&&/msgstore\\.db\\.crypt15/.test(x)&&/WhatsApp folder/.test(x)&&/rooted/.test(x))(document.querySelector('#wbi-explain').innerText.replace(/&gt;/g,'>'))`);
    await toForm(t);
    await t.eq("the key field is a password field", `document.querySelector('#wbi-pw').type`, "password");
    await t.ok("check is disabled without file and key", `document.querySelector('#wbi-check').disabled`);
    await t.setInput("#wbi-pw", "XYZ" + KEY.slice(0, 40));
    await t.ok("counter counts hex characters only", `/40 of 64/.test(document.querySelector('#wbi-pwhint').textContent)`);
    await t.setInput("#wbi-pw", KEY.replace(/(.{4})/g, "$1 "));
    await t.ok("64 digits with spaces count as complete", `/64 of 64/.test(document.querySelector('#wbi-pwhint').textContent)`);
    await t.eq("still no file chosen", `document.querySelector('#wbi-check').disabled`, true);
  }),
  test("desktop dialog: choose file, wrong key error, inspect, options, import with progress, result and Open chats", async (t) => {
    await open(t); await toForm(t);
    await chooseFile(t, "f".repeat(64));
    await t.click("#wbi-check");
    await t.ok("wrong key gives a clear error", `/Wrong key/.test(document.querySelector('#wbi-err')?.textContent||'')`);
    await t.setInput("#wbi-pw", KEY.toUpperCase().replace(/(.{4})/g, "$1-")); await t.click("#wbi-check");
    await t.waitSel("#wbi-info");
    const i = await t.ev(`${calls("whatsappBackupInspect")}.at(-1).params`);
    t.expectEq("inspect names the chosen path (no upload) and sends the normalised 64-digit key", [i.path, i.uploadId, i.accountId, i._len, i.key], ["/home/u/WhatsApp/Databases/msgstore.db.crypt15", undefined, "wa-1", 64, "<redacted>"]);
    await t.ok("counts, chats and media found are shown", `(x=>/1,?234/.test(x.querySelector('#wbi-n-msgs').textContent)&&/4 one-to-one, 2 groups/.test(x.querySelector('#wbi-n-chats').textContent)&&/38 of 40 found/.test(x.querySelector('#wbi-n-att').textContent))(document.querySelector('#wbi-info'))`);
    await t.ok("account matches", `!!document.querySelector('#wbi-match')`);
    await t.ok("attachments are on by default", `document.querySelector('#wbi-att').checked`);
    await t.shot("inspect");
    await t.setInput("#wbi-from", "2020-01-01");
    await t.click("#wbi-go");
    await t.ok("progress bar and cancel while importing", `document.querySelector('#wbi-bar .bar') && document.querySelector('#wbi-cancel')`);
    await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    const d = await t.ev(`${calls("whatsappBackupImport")}.at(-1).params`);
    t.expectEq("import params: account, attachments, since, confirmations", [d.accountId, d.options.attachments, /^2020-01-01T/.test(d.options.since) || /^2019-12-31T/.test(d.options.since), d.options.until, d.confirmMismatch, d.confirmUnverified], ["wa-1", true, true, undefined, false, false]);
    await t.ok("summary lists what was added", `(x=>/1,?200/.test(x)&&/31 were already here/.test(x)&&/6 conversations/.test(x)&&/36 files stored/.test(x)&&/2 files were not in the Media folder/.test(x))(document.querySelector('#wbi-result').textContent)`);
    await t.click("#wbi-open");
    await t.eq("Open chats hands the account to the host", `globalThis.__wbiOpened`, "wa-1");
    await t.shot("result");
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}`) }),
  test("cancel while importing: error shown, nothing reported as imported, can retry", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    await t.click("#wbi-go"); await t.waitSel("#wbi-cancel"); await t.click("#wbi-cancel");
    await t.ok("cancelled message", `/Cancelled/.test(document.querySelector('#wbi-err')?.textContent||'')`);
    await t.stays("no result box", `!!document.querySelector('#wbi-result')`, 400);
    await t.ok("import button is available again", `!document.querySelector('#wbi-go').disabled`);
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}:slow`) }),
  test("another number's backup needs an explicit confirmation", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-mismatch");
    await t.ok("import disabled until confirmed", `document.querySelector('#wbi-go').disabled`);
    await t.click("#wbi-confirm"); await t.ok("now enabled", `!document.querySelector('#wbi-go').disabled`);
    await t.click("#wbi-go"); await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    t.expectEq("confirmMismatch is sent", await t.ev(`${calls("whatsappBackupImport")}.at(-1).params.confirmMismatch`), true);
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}:mismatch`) }),
  test("signed-out account: unverified backup needs a confirmation too", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-unverified");
    await t.ok("import disabled", `document.querySelector('#wbi-go').disabled`);
    await t.click("#wbi-confirm"); await t.click("#wbi-go"); await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    t.expectEq("confirmUnverified is sent", await t.ev(`${calls("whatsappBackupImport")}.at(-1).params.confirmUnverified`), true);
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}:unknown`) }),
  test("no Media folder found: attachments cannot be selected and the page says why; a typed folder fixes it", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    await t.ok("attachment option disabled with an explanation", `document.querySelector('#wbi-att').disabled && /no Media folder/i.test(document.querySelector('#wbi-n-att').textContent)`);
    await t.click("#wbi-go"); await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    t.expectEq("attachments option off", await t.ev(`${calls("whatsappBackupImport")}.at(-1).params.options.attachments`), false);
    await t.click("#wbi-again"); await t.waitSel("#wbi-explain"); await toForm(t); await chooseFile(t, KEY);
    await t.setInput("#wbi-media", "/home/u/WhatsApp"); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    t.expectEq("the folder is passed to the backend", await t.ev(`${calls("whatsappBackupInspect")}.at(-1).params.mediaPath`), "/home/u/WhatsApp");
    await t.ok("attachments now selectable", `!document.querySelector('#wbi-att').disabled && document.querySelector('#wbi-att').checked`);
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}:nomedia`) }),
  test("crypt14: asks for the key file instead of the 64 digits and sends it", async (t) => {
    await open(t); await toForm(t); await t.click("#wbi-drop"); await t.waitFor(`/crypt14/.test(document.querySelector('#wbi-drop').textContent)`);
    await t.ok("key-file picker replaces the password field and mentions root", `!document.querySelector('#wbi-pw') && !!document.querySelector('#wbi-keyfile') && /rooted|root/.test(document.querySelector('#wbi-keyfile-l').textContent)`);
    await t.ok("check disabled without the key file", `document.querySelector('#wbi-check').disabled`);
    await t.ev(`(()=>{const f=new File([new Uint8Array(158)],'key');const dt=new DataTransfer();dt.items.add(f);const i=document.querySelector('#wbi-keyfile');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await t.waitFor(`!document.querySelector('#wbi-check').disabled`);
    await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    const i = await t.ev(`${calls("whatsappBackupInspect")}.at(-1).params`);
    t.expectEq("key file sent, no key", [i.keyFileBase64, i.key], ["<redacted>", undefined]);
  }, { init: SHELL(`MOCKWA:crypt14:keyfile`, "/home/u/WhatsApp/Databases/msgstore.db.crypt14") }),
  test("browser: a chosen file is uploaded in chunks and passed by uploadId", async (t) => {
    await open(t); await toForm(t);
    await t.ev(`(()=>{const f=new File(['x'],'msgstore.db.crypt15');const dt=new DataTransfer();dt.items.add(f);const i=document.querySelector('#wbi-file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await t.waitFor(`/msgstore/.test(document.querySelector('#wbi-drop').textContent)`);
    await t.setInput("#wbi-pw", KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    const i = await t.ev(`${calls("whatsappBackupInspect")}.at(-1).params`);
    t.expectEq("uploadId, not path", [!!i.uploadId, i.path], [true, undefined]);
  }),
  test("the key is not kept in the page after a successful import", async (t) => {
    await open(t); await toForm(t); await chooseFile(t, KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    await t.click("#wbi-go"); await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    await t.ok("no input holds the key and the text is not in the DOM", `![...document.querySelectorAll('input')].some(i=>i.value.includes('0123456789'))&&!document.body.innerText.includes('${KEY}')`);
  }, { init: SHELL(`MOCKWA:crypt15:${KEY}`) }),
  test("Android: 'Find the backup on this phone' lists backups, copies the chosen one with media folders, then the usual key step works", async (t) => {
    const safCalls = (m: string) => `(__mockSafLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
    await open(t); await toForm(t);
    await t.ok("permission wording explains the single folder and 'Use this folder'", `(x=>/Use this folder/.test(x)&&/one folder/.test(x)&&/Android > media > com\\.whatsapp/.test(x))(document.querySelector('#saf-explain').textContent)`);
    await t.click("#saf-find"); await t.waitSel("#saf-files");
    t.expectEq("locate asks for WhatsApp", await t.ev(`${safCalls("$backupLocate")}.at(-1).params`), { kind: "whatsapp", pick: false });
    await t.ok("newest backup is selected; big media folders are off by default, the small one is on", `document.querySelector('#saf-files input').checked&&(i=>!i[0].checked&&!i[1].checked&&i[2].checked)([...document.querySelectorAll('#saf-media input')])`);
    await t.click("#saf-copy"); await t.waitSel("#saf-bar .bar"); await t.waitSel("#saf-done");
    t.expectEq("copy names the file and the ticked media folders only", await t.ev(`${safCalls("$backupCopy")}.at(-1).params`), { kind: "whatsapp", name: "msgstore.db.crypt15", media: ["WhatsApp Documents"] });
    await t.ok("the drop zone now shows the copied file and the media path is filled in", `/msgstore\\.db\\.crypt15/.test(document.querySelector('#wbi-drop').textContent)&&document.querySelector('#wbi-media').value==='/data/.backup/saf/whatsapp/WhatsApp'`);
    await t.setInput("#wbi-pw", KEY); await t.click("#wbi-check"); await t.waitSel("#wbi-info");
    const i = await t.ev(`${calls("whatsappBackupInspect")}.at(-1).params`);
    t.expectEq("inspect reads the copied path", [i.path, i.mediaPath], ["/data/.backup/saf/whatsapp/WhatsApp/Databases/msgstore.db.crypt15", "/data/.backup/saf/whatsapp/WhatsApp"]);
    await t.click("#wbi-go"); await t.waitSel("#wbi-result", undefined, { timeout: 15000 });
    await t.waitFor(`${safCalls("$backupDiscard")}.length>0`);
    t.expectEq("copies are discarded after the import", (await t.ev(`${safCalls("$backupDiscard")}.at(-1).params`)), { kind: "whatsapp" });
    await t.shot("saf");
  }, { init: `window.__mockSaf=1;window.__mockSafContent=${JSON.stringify(`MOCKWA:crypt15:${KEY}`)};` }),
  test("Android: folder without a Media folder, empty folder and cancelled picker are explained", async (t) => {
    await open(t); await toForm(t);
    await t.click("#saf-find"); await t.waitSel("#saf-nomedia");
    await t.ok("says only messages can be imported", `/only the messages/.test(document.querySelector('#saf-nomedia').textContent)`);
  }, { init: `window.__mockSaf="nomedia";` }),
  test("Android: no backup file in the chosen folder shows a clear message and no copy button", async (t) => {
    await open(t); await toForm(t);
    await t.click("#saf-find"); await t.waitSel("#saf-err");
    await t.ok("message and no copy button", `/No WhatsApp backup file/.test(document.querySelector('#saf-err').textContent)&&!document.querySelector('#saf-copy')`);
  }, { init: `window.__mockSaf="empty";` }),
  test("Android: cancelling the folder chooser leaves the page as it was", async (t) => {
    await open(t); await toForm(t);
    await t.click("#saf-find"); await t.stays("no list appears", `!!document.querySelector('#saf-files')||!!document.querySelector('#saf-err')`, 400);
    await t.ok("find button is usable again", `!document.querySelector('#saf-find').disabled`);
  }, { init: `window.__mockSaf="cancel";` }),
];

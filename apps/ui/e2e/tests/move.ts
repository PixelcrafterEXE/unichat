// Settings > Move to another device (device to device, over the encrypted sync channel; mock backend = apps/ui/src/mockSync.ts).
// choose account -> choose device (or add one on the spot) -> ONE confirm on both devices -> progress -> done; cancel on either side; target offline.
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const open = async (t: any, devices = true) => { await t.open(); await settings(t, "Move to another device"); await t.waitSel("#mvp"); if (devices) { await t.ev(`window.__mockSyncAddDevice('Pixel phone', true)`); await t.waitSel("[data-dev='Pixel phone']"); } };
const calls = (m: string) => `(__mockSyncLog||[]).filter(c=>c.method===${JSON.stringify(m)})`;
const MAIN = `(()=>{const p=document.querySelector('#mvp').cloneNode(true); return p.textContent})()`;
const pick = async (t: any, acct: string | string[] = "wa-1", dev = "Pixel-phone") => { for (const a of [].concat(acct)) await t.click(`#mvp-acct-${a}`); await t.click(`#mvp-dev-${dev}`); await t.click("#mvp-next"); await t.waitSel("#mvp-confirm"); };

export default [
  test("move (p2p): the page leads with accounts and devices; the file way is a closed, secondary fold; no jargon", async (t) => {
    await open(t);
    await t.ok("lists the movable accounts; one that can't move says why", `!!document.querySelector('#mvp-acct-wa-1') && !!document.querySelector('#mvp-acct-mm-1') && !document.querySelector('#mvp-acct-ig-1') && /history only/.test(document.querySelector("[data-stuck='ig-1']").textContent)`);
    await t.ok("lists the paired device as online", `/Online/.test(document.querySelector("[data-dev='Pixel phone']").textContent)`);
    await t.not("Next waits for a choice", `!document.querySelector('#mvp-next').disabled`);
    await t.not("the file fold is closed", `document.getElementById('mvp-file').open`);
    await t.ok("the file fold says it is secondary", `/Use a file instead/.test(document.querySelector('#mvp-file summary').textContent) && /better way/.test(document.querySelector('#mvp-file p').textContent)`);
    await t.ok("no file, passphrase or jargon in the main view", `(()=>{const c=document.querySelector('#mvp').textContent; return !/passphrase|\\.unimsg|ledger|HLC|proxy|relay/i.test(c)})()`);
    await t.ok("the old file wizard sits only inside the fold", `document.getElementById('bk-move').closest('#mvp-file')!==null`);
  }),

  test("move (p2p), source: choose account, choose device, ONE confirm naming account and direction, progress, success toast; the account leaves the list", async (t) => {
    await open(t);
    await pick(t);
    await t.ok("one confirm: account and direction", `document.querySelector('#mvp-confirm-title').textContent==='Move WhatsApp from My laptop to Pixel phone?'`);
    await t.ok("it says what happens to the source, plain words", `/My laptop will be signed out locally without logging out of the service/.test(document.querySelector('#mvp-confirm-text').textContent)`);
    await t.eq("nothing was started before the confirm", `${calls("syncMoveStart")}.length`, 0);
    await t.shot("move_confirm");
    await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-progress");
    await t.waitSel("#mvp-progress[data-phase='sending']"); await t.ok("shows the account and the amount sent", `/WhatsApp/.test(document.querySelector('#mvp-progress').textContent) && /MB/.test(document.querySelector('#mvp-progress').textContent)`);
    await t.waitSel("#mvp-done", "WhatsApp now runs on Pixel phone");
    await t.waitSel("#mvp-toast", "WhatsApp moved to Pixel phone");
    await t.ok("per-account row says it is kept as an archive", `/read-only archive/.test(document.querySelector('#mvp-progress [data-acct="wa-1"]').textContent)`);
    t.expectEq("syncMoveStart carries the explicit confirm", await t.ev(`${calls("syncMoveStart")}.map(c=>[c.params.accountIds[0],c.params.deviceId,c.params.confirmed])`), [["wa-1", "dev-pixel-phone", true]]);
    await t.click("#mvp-close");
    await t.not("the moved account can't be moved again", `!!document.querySelector('#mvp-acct-wa-1')`);
    await t.ok("others are still there", `!!document.querySelector('#mvp-acct-mm-1')`);
    await t.shot("move_done");
  }),

  test("move (p2p), source: cancelling the dialog starts nothing; cancelling during the transfer keeps the account here", async (t) => {
    await open(t);
    await pick(t); await t.click("#mvp-confirm-no"); await t.waitGone(`document.querySelector('#mvp-confirm')`);
    await t.stays("no move started", `${calls("syncMoveStart")}.length>0`, 400);
    await t.ev(`window.__mockMoveHold(true)`);
    await t.click("#mvp-next"); await t.waitSel("#mvp-confirm"); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-progress[data-phase='sending']"); await t.click("#mvp-cancel");
    await t.waitSel("#mvp-failed", "did not happen"); await t.ok("says it is still here", `/Cancelled/.test(document.querySelector('#mvp-progress').textContent) && /Still on this device/.test(document.querySelector('#mvp-progress').textContent)`);
    await t.ev(`window.__mockMoveHold(false)`); await t.click("#mvp-close");
    await t.ok("the account can be moved later", `!!document.querySelector('#mvp-acct-mm-1')`);
  }),

  test("move (p2p), source: the other device says no, or cancels, or the connection drops: plain words, account stays", async (t) => {
    await open(t);
    await t.ev(`window.__mockMoveMode('deny')`); await pick(t); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-failed", "did not happen"); await t.ok("said no, account stays", `/said no/.test(document.querySelector('#mvp-progress').textContent) && /Still on this device/.test(document.querySelector('#mvp-progress').textContent)`); await t.click("#mvp-close");
    await t.ev(`window.__mockMoveMode('drop')`); await pick(t); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-failed", "did not happen"); await t.ok("connection lost, plain words", `/connection to the other device was lost/.test(document.querySelector('#mvp-progress').textContent)`); await t.click("#mvp-close");
    await t.ev(`window.__mockMoveMode('ok'); window.__mockMoveHold(true)`); await pick(t); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-progress[data-phase='sending']"); await t.ev(`window.__mockMoveRemoteCancel()`);
    await t.waitSel("#mvp-failed", "did not happen"); await t.ok("the other device cancelled", `/The other device cancelled/.test(document.querySelector('#mvp-progress').textContent)`); await t.ev(`window.__mockMoveHold(false)`);
    await t.ok("nothing was reported as moved", `!document.querySelector('#mvp-done') && !!document.querySelector('#mvp-failed')`);
  }),

  test("move (p2p), target: the confirm appears on any page, names account and direction; accepting shows progress and a toast; declining installs nothing", async (t) => {
    await t.open(); // the chat list, NOT the settings
    await t.ev(`window.__mockSyncAddDevice('Pixel phone', true); window.__mockMoveIncoming('Signal (+49…)')`);
    await t.waitSel("#mvp-confirm");
    await t.ok("names account and direction", `document.querySelector('#mvp-confirm-title').textContent==='Move Signal (+49…) from Pixel phone to My laptop?'`);
    await t.ok("same plain sentence", `/Pixel phone will be signed out locally without logging out of the service/.test(document.querySelector('#mvp-confirm-text').textContent)`);
    await t.ok("buttons", `[...document.querySelectorAll('#mvp-confirm button')].map(b=>b.textContent).join('|')==="Move here|Don't allow"`);
    await t.click("#mvp-confirm-no"); await t.waitGone(`document.querySelector('#mvp-confirm')`);
    await t.waitSel("#mvp-toast", "was not moved"); t.expectEq("declined with the answer recorded", await t.ev(`${calls("syncMoveRespond")}.map(c=>c.params.accept)`), [false]);
    await t.ev(`window.__mockMoveIncoming('Signal (+49…)')`); await t.waitSel("#mvp-confirm"); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-receiving", "Receiving Signal"); await t.waitSel("#mvp-toast", "Signal (+49…) is now connected here");
    await t.waitGone(`document.querySelector('#mvp-receiving')`);
  }),

  test("move (p2p), target: the sender cancels while the confirm is open -> it disappears with a plain notice", async (t) => {
    await t.open(); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true); window.__mockMoveIncoming()`); await t.waitSel("#mvp-confirm");
    await t.ev(`window.__mockMoveRemoteCancel()`); await t.waitGone(`document.querySelector('#mvp-confirm')`);
    await t.waitSel("#mvp-toast", "was not moved"); await t.ok("no dialog is left", `!document.querySelector('#mvp-confirm') && !document.querySelector('#mvp-receiving')`);
  }),

  test("move (p2p): an offline device cannot be chosen; nothing is sent", async (t) => {
    await open(t); await t.ev(`window.__mockMoveOffline(true)`);
    await t.ok("shown as offline with a hint, not selectable", `/Offline/.test(document.querySelector("[data-dev='Pixel phone']").textContent) && document.querySelector('#mvp-dev-Pixel-phone').disabled`);
    await t.click("#mvp-acct-wa-1"); await t.not("Next stays disabled", `!document.querySelector('#mvp-next').disabled`);
    await t.eq("no call", `${calls("syncMoveStart")}.length`, 0);
  }),

  test("move (p2p): no paired device -> 'Add a device' inline with the normal pairing, then the move goes on", async (t) => {
    await open(t, false);
    await t.waitSel("#mvp-nopair", "no other device yet");
    await t.click("#mvp-acct-wa-1"); await t.not("can't continue without a device", `!document.querySelector('#mvp-next').disabled`);
    await t.click("#mvp-add"); await t.waitSel("#mvp-adding");
    await t.ok("the usual code card is shown right here", `/bako-lemi-zuta-nosu/.test(document.querySelector('#sync-code-shown').textContent) && !!document.querySelector('#mvp-adding svg')`);
    await t.ev(`window.__mockSyncJoinRequest()`); await t.waitSel("#sync-confirm");
    await t.ok("the one pairing confirm (digits) is the existing one", `/Add Pixel phone\\?/.test(document.querySelector('#sync-confirm-title').textContent) && /^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent)`);
    await t.click("#sync-match");
    await t.waitSel("[data-dev='Pixel phone']"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.ok("the new device is already chosen, the account choice is kept", `document.querySelector('#mvp-dev-Pixel-phone').checked && document.querySelector('#mvp-acct-wa-1').checked`);
    await t.click("#mvp-next"); await t.waitSel("#mvp-confirm"); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-done", "WhatsApp now runs on Pixel phone");
  }),

  test("move (p2p), file fallback: still there under 'Use a file instead', marked as secondary", async (t) => {
    await open(t); await t.ev(`document.getElementById('mvp-file').open = true`);
    await t.waitSel("#mv-away"); await t.ok("both file entry points exist", `!!document.querySelector('#mv-here')`);
  }),

  test("move (p2p), phone width: no overflow, 44px targets, dialogs inside the screen", async (t) => {
    await t.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
    await open(t, false);
    await t.ok("page does not scroll sideways (no device)", `document.documentElement.scrollWidth<=innerWidth+1`);
    await t.ev(`window.__mockSyncAddDevice('Pixel phone with a really long name that must wrap', true)`); await t.waitSel("[data-dev^='Pixel phone']");
    await t.ok("page does not scroll sideways (with a long device name)", `document.documentElement.scrollWidth<=innerWidth+1`);
    await t.ok("account and device rows are 44px high", `[...document.querySelectorAll('#mvp .mvrow.pick')].filter(b=>b.offsetHeight>0).every(b=>b.offsetHeight>=44)`);
    await t.ok("buttons are 44px high", `[...document.querySelectorAll('#mvp button')].filter(b=>b.offsetHeight>0).every(b=>b.offsetHeight>=44)`);
    await t.click("#mvp-acct-wa-1"); await t.click("[data-dev^='Pixel phone']"); await t.click("#mvp-next"); await t.waitSel("#mvp-confirm");
    await t.ok("confirm sheet inside the screen, buttons 44px", `(()=>{const r=document.querySelector('#mvp-confirm .sheet').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&[...document.querySelectorAll('#mvp-confirm button')].every(b=>b.offsetHeight>=44)})()`);
    await t.ok("no horizontal scroll with the dialog open", `document.documentElement.scrollWidth<=innerWidth+1`);
    await t.shot("move_phone_confirm");
    await t.ev(`window.__mockMoveHold(true)`); await t.click("#mvp-confirm-yes"); await t.waitSel("#mvp-progress[data-phase='sending']");
    await t.ok("progress fits", `document.documentElement.scrollWidth<=innerWidth+1 && [...document.querySelectorAll('#mvp-progress button')].every(b=>b.offsetHeight>=44)`);
    await t.shot("move_phone_progress"); await t.ev(`window.__mockMoveHold(false)`); await t.waitSel("#mvp-done");
    await t.ev(`window.__mockMoveIncoming('Signal (+49…)')`); await t.waitSel("#mvp-confirm");
    await t.ok("incoming confirm inside the screen, buttons 44px", `(()=>{const r=document.querySelector('#mvp-confirm .sheet').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&[...document.querySelectorAll('#mvp-confirm button')].every(b=>b.offsetHeight>=44)})()`);
  }),

  test("move (p2p), several accounts: checklist (select all / none), one confirm naming all, per-account rows, a failure does not stop the others", async (t) => {
    await open(t);
    await t.click("#mvp-all"); await t.ok("all movable accounts are selected, footer counts them", `document.querySelector('#mvp-acct-wa-1').checked && document.querySelector('#mvp-acct-mm-1').checked && /2 accounts/.test(document.querySelector('#mvp-sum').textContent)`);
    await t.click("#mvp-all"); await t.ok("select none", `!document.querySelector('#mvp-acct-wa-1').checked && /No account chosen/.test(document.querySelector('#mvp-sum').textContent)`);
    await t.click("#mvp-all"); await t.click("#mvp-dev-Pixel-phone");
    await t.ok("primary button says how many", `document.querySelector('#mvp-next').textContent==='Move 2 accounts'`);
    await t.ev(`window.__mockMoveFail('mm-1')`); await t.click("#mvp-next"); await t.waitSel("#mvp-confirm");
    await t.ok("one confirm names all accounts and the direction", `document.querySelector('#mvp-confirm-title').textContent==='Move 2 accounts from My laptop to Pixel phone?' && /WhatsApp/.test(document.querySelector('#mvp-confirm-list').textContent) && /Work Mattermost/.test(document.querySelector('#mvp-confirm-list').textContent)`);
    await t.shot("move_multi_confirm");
    await t.click("#mvp-confirm-yes");
    await t.waitSel('#mvp-progress [data-acct="mm-1"][data-phase="queued"], #mvp-progress [data-acct="wa-1"][data-phase="sending"]');
    await t.waitSel("#mvp-failed", "1 of 2 accounts moved");
    await t.ok("per-account results: first done, second failed with its reason and 'still on this device'", `document.querySelector('#mvp-progress [data-acct="wa-1"]').dataset.phase==='done' && document.querySelector('#mvp-progress [data-acct="mm-1"]').dataset.phase==='failed' && /could not start/.test(document.querySelector('#mvp-progress [data-acct="mm-1"]').textContent) && /Still on this device/.test(document.querySelector('#mvp-progress [data-acct="mm-1"]').textContent)`);
    t.expectEq("one start call with both ids and the confirm", await t.ev(`${calls("syncMoveStart")}.map(c=>[c.params.accountIds,c.params.confirmed])`), [[["wa-1", "mm-1"], true]]);
    await t.shot("move_multi_done");
  }),

  test("move (p2p), several accounts: cancel stops the remaining ones", async (t) => {
    await open(t); await t.ev(`window.__mockMoveHold(true)`);
    await pick(t, ["wa-1", "mm-1"]); await t.click("#mvp-confirm-yes");
    await t.waitSel('#mvp-progress [data-acct="wa-1"][data-phase="sending"]'); await t.ok("the second one waits its turn", `document.querySelector('#mvp-progress [data-acct="mm-1"]').dataset.phase==='queued'`);
    await t.click("#mvp-cancel"); await t.waitSel("#mvp-failed");
    await t.ok("both stopped, nothing moved", `[...document.querySelectorAll('#mvp-progress [data-acct]')].every(r=>r.dataset.phase==='failed') && !document.querySelector('[data-phase="done"]')`);
    await t.ev(`window.__mockMoveHold(false)`);
  }),

  test("move (p2p), several accounts, target: ONE prompt lists all accounts; untick one; Don't allow refuses all", async (t) => {
    await t.open(); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true); window.__mockMoveIncoming('Signal (+49…)', 3)`);
    await t.waitSel("#mvp-confirm");
    await t.ok("title and list", `document.querySelector('#mvp-confirm-title').textContent==='Move 3 accounts from Pixel phone to My laptop?' && document.querySelectorAll('#mvp-confirm-list li').length===3`);
    await t.ok("one answer pair", `[...document.querySelectorAll('#mvp-confirm button')].map(b=>b.textContent).join('|')==="Move here|Don't allow"`);
    await t.shot("move_multi_incoming");
    await t.click("#mvp-confirm-no"); await t.waitGone(`document.querySelector('#mvp-confirm')`);
    await t.waitSel("#mvp-toast", "not moved");
    await t.ev(`window.__mockMoveIncoming('Signal (+49…)', 3)`); await t.waitSel("#mvp-confirm");
    await t.click("#mvp-in-signal-10"); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-toast", "2 of 3 accounts are now connected here");
    t.expectEq("the unticked account was left out", await t.ev(`${calls("syncMoveRespond")}.map(c=>c.params.accountIds||null)`), [null, ["signal-9", "signal-11"]]);
  }),

  test("move (p2p), history: 'Also move the chat history' is on by default with a size line; files and 'remove afterwards' are sub-options; the choices go to the backend", async (t) => {
    await open(t); await pick(t);
    await t.ok("history on, files on, remove off", `document.querySelector('#mvp-hist').checked && document.querySelector('#mvp-media').checked && !document.querySelector('#mvp-remove').checked`);
    await t.ok("size line with messages and files", `document.querySelector('#mvp-est').textContent==='About 540 MB: 88,000 messages, 9,300 files'`);
    await t.click("#mvp-media"); await t.ok("without files the size shrinks", `document.querySelector('#mvp-est').textContent==='About 40 MB: 88,000 messages'`);
    await t.click("#mvp-media"); await t.click("#mvp-remove"); await t.shot("move_history_confirm");
    await t.click("#mvp-hist"); await t.ok("history off: the sub-options go and the line says only the sign-in moves", `!document.querySelector('#mvp-media') && /Only the sign-in moves/.test(document.querySelector('#mvp-est').textContent)`);
    await t.click("#mvp-hist"); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-progress[data-phase='sending']"); await t.waitSel("#mvp-progress", "Chat history");
    await t.ok("history progress: messages x of y", `/Chat history · [\\d,]+ of 88,000 messages/.test(document.querySelector('#mvp-progress').textContent)`);
    await t.waitSel("#mvp-done", "now runs on Pixel phone"); await t.ok("result says it moved with its history and the copy is removed", `/with its chat history/.test(document.querySelector('#mvp-progress').textContent) && /history was removed from this device/.test(document.querySelector('#mvp-progress').textContent)`);
    t.expectEq("start call options", await t.ev(`${calls("syncMoveStart")}.map(c=>[c.params.includeHistory,c.params.includeMedia,c.params.removeHistoryAfter])`), [[true, true, true]]);
    await t.shot("move_history_done");
  }),

  test("move (p2p), history: a history failure leaves the account here and offers 'Move without history', which then works", async (t) => {
    await open(t); await t.ev(`window.__mockMoveHistFail(true)`); await pick(t); await t.click("#mvp-confirm-yes");
    await t.waitSel("#mvp-failed", "did not happen"); await t.ok("explains and keeps the account", `/chat history could not be transferred/.test(document.querySelector('#mvp-progress').textContent) && /Still on this device/.test(document.querySelector('#mvp-progress').textContent)`);
    await t.ev(`window.__mockMoveHistFail(false)`); await t.click("[data-nohist='wa-1']");
    await t.waitSel("#mvp-done", "now runs on Pixel phone");
    t.expectEq("the retry asked for no history", await t.ev(`${calls("syncMoveStart")}.map(c=>c.params.includeHistory)`), [true, false]);
  }),

  test("move (p2p), history, target: the prompt mentions the history and its size", async (t) => {
    await t.open(); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true); window.__mockMoveIncoming('Signal (+49…)', 1, true)`); await t.waitSel("#mvp-confirm");
    await t.ok("history line with size", `/Includes the chat history\\. About 540 MB: 88,000 messages, 9,300 files/.test(document.querySelector('#mvp-in-hist').textContent)`);
    await t.click("#mvp-confirm-yes"); await t.waitSel("#mvp-receiving", "Chat history"); await t.waitSel("#mvp-toast", "now connected here");
  }),
];

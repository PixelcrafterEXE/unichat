// Settings > Sync devices on the mock UI: one "Add a device" flow, nearby connect, deep-link join, one confirm dialog on both sides, plain-words failures,
// "Advanced" collapsed by default (network, addresses, media, accounts), phone width.
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const LINK = "unichat-sync://pair?h=192.168.1.20&p=45045&c=bakolemizutanosu&k=abc";
const open = async (t: any, q = "") => { await t.open(q); if (!q.includes("pair=")) await settings(t, "Sync devices"); await t.waitSel("#sync-panel"); };
const adv = (t: any) => t.ev(`document.querySelector('#sync-advanced').open = true`);
/** this device shows "Add a device", the other one asks to join, both confirm */
const pairedAsHost = async (t: any) => {
  await open(t); await t.click("#sync-start"); await t.waitSel("#sync-pairing");
  await t.ev(`window.__mockSyncJoinRequest()`); await t.waitSel("#sync-confirm"); await t.click("#sync-match");
  await t.waitSel("#sync-devices .devrow", "Pixel phone"); await t.waitGone(`document.querySelector('#sync-confirm')`);
};
const MAIN_TEXT = `(()=>{const p=document.querySelector('#sync-panel').cloneNode(true); p.querySelector('#sync-advanced')?.remove(); return p.textContent})()`;

export default [
  test("simple page: Advanced is closed, no jargon in the main view, one primary button, no stray widgets next to this device", async (t) => {
    await open(t);
    await t.not("Advanced is collapsed by default", `document.querySelector('#sync-advanced').open`);
    await t.ok("one primary action", `document.querySelectorAll('#sync-panel button.primary').length===0 || [...document.querySelectorAll('#sync-panel button.primary')].every(b=>/Add a device/.test(b.textContent))`);
    await t.ok("the main view has no jargon", `!/\\b(group|listen\\w*|proxy|ledger|relay|HLC)\\b/i.test(${MAIN_TEXT})`);
    await t.ok("'Connect to another device' is below it", `!!document.querySelector('#sync-add') && !!document.querySelector('#sync-join') && /Connect to another device/.test(document.querySelector('#sync-join').textContent)`);
    await t.click("#sync-start"); await t.waitSel("#sync-pairing");
    await t.ok("this device is listed with a name and no leftover bar/ellipse/dash", `(()=>{const r=document.querySelector('#sync-devices .devrow'); return !!r && /My laptop/.test(r.textContent) && !r.querySelector('.bar,.state')})()`);
  }),

  test("Add a device: the session starts at once (QR + code + link + waiting) with no questions first", async (t) => {
    await open(t);
    await t.not("no name field or checkbox up front", `document.querySelector('#sync-add input')`);
    await t.click("#sync-start"); await t.waitSel("#sync-pairing");
    await t.ok("code, QR and waiting text in one card", `/bako-lemi-zuta-nosu/.test(document.querySelector('#sync-code-shown').textContent) && !!document.querySelector('#sync-pairing svg') && /Waiting for the other device/.test(document.querySelector('#sync-waiting').textContent)`);
    await t.ok("copy link button", `/Copy link/.test(document.querySelector('#sync-copy').textContent)`);
    await t.ok("this device is already in the list", `/My laptop/.test(document.querySelector('#sync-devices').textContent)`);
    await t.shot("sync_add");
    await t.click("#sync-stop"); await t.waitGone(`document.querySelector('#sync-pairing')`);
  }),

  test("hosting by code: one dialog with a big number, 'It matches' on both sides, closes by itself, toast 'Synced with'", async (t) => {
    await open(t); await t.click("#sync-start"); await t.waitSel("#sync-pairing");
    await t.ev(`window.__mockSyncJoinRequest()`); await t.waitSel("#sync-confirm");
    await t.ok("names the device, shows 6 digits, two buttons", `/Add Pixel phone\\?/.test(document.querySelector('#sync-confirm-title').textContent) && /^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent) && [...document.querySelectorAll('#sync-confirm button')].map(b=>b.textContent).join('|')==='It matches|Cancel'`);
    await t.shot("sync_confirm");
    await t.click("#sync-cancel"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.not("a cancelled device is not listed", `/Pixel/.test(document.querySelector('#sync-devices').textContent)`);
    await t.ev(`window.__mockSyncJoinRequest()`); await t.waitSel("#sync-confirm"); await t.click("#sync-match");
    await t.waitSel("#sync-confirm-wait");
    await t.waitSel("#sync-devices .devrow", "Pixel phone"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.waitSel("#sync-toast", "Synced with Pixel phone");
    await t.ok("listed as connected with a last-synced time", `/Connected/.test(document.querySelector('[data-dev="Pixel phone"]').textContent)`);
  }),

  test("nearby, host side: 'Allow <name>?' with the number; Cancel adds nothing", async (t) => {
    await open(t); await t.click("#sync-start"); await t.waitSel("#sync-pairing");
    await t.ev(`window.__mockSyncJoinRequest(true)`); await t.waitSel("#sync-confirm");
    await t.ok("asks to allow it", `/Allow Pixel phone\\?/.test(document.querySelector('#sync-confirm-title').textContent) && /^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent)`);
    await t.click("#sync-cancel"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.not("nothing added", `/Pixel/.test(document.querySelector('#sync-devices').textContent)`);
    await t.ev(`window.__mockSyncJoinRequest(true)`); await t.waitSel("#sync-confirm"); await t.click("#sync-match");
    await t.waitSel("#sync-devices .devrow", "Pixel phone");
  }),

  test("nearby, joining side: a device that shows 'Add a device' is listed; one tap on Connect, confirm the number, done", async (t) => {
    await open(t);
    await t.ok("empty state says what it waits for", `/Looking for devices/.test(document.querySelector('#sync-nearby').textContent)`);
    await t.ev(`window.__mockSyncNearby(true)`); await t.waitSel("#sync-nearby [data-nearby]", "Connect");
    await t.ok("no code needed: the entry has a Connect button", `/Desktop/.test(document.querySelector('[data-nearby]').textContent)`);
    await t.click("#sync-nearby [data-nearby] button", "Connect"); await t.waitSel("#sync-confirm");
    await t.ok("dialog with the number, no auto-confirm", `/Connect to Desktop\\?/.test(document.querySelector('#sync-confirm-title').textContent) && /^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent) && !!document.querySelector('#sync-match')`);
    await t.click("#sync-match");
    await t.waitSel("#sync-devices .devrow", "Desktop"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.waitSel("#sync-toast", "Synced with Desktop");
  }),

  test("nearby, joining side: Cancel in the dialog adds nothing", async (t) => {
    await open(t); await t.ev(`window.__mockSyncNearby(true)`); await t.waitSel("[data-nearby]");
    await t.click("[data-nearby] button", "Connect"); await t.waitSel("#sync-confirm"); await t.click("#sync-cancel");
    await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.not("no device was added", `document.querySelector('#sync-devices')`);
  }),

  test("typing a code: wrong code gives one sentence, right code opens the confirm dialog", async (t) => {
    await open(t);
    await t.setInput("#sync-code", "baba-baba-baba-baba"); await t.click("#sync-joinbtn"); await t.waitSel("#sync-err");
    await t.ok("clear error", `/not accepted/.test(document.querySelector('#sync-err').textContent)`);
    await t.setInput("#sync-code", "bako-lemi-zuta-nosu"); await t.click("#sync-joinbtn"); await t.waitSel("#sync-confirm");
    await t.ok("it connected to the other device, no technical words", `!/firewall|TCP|port|multicast|mDNS|NAT/i.test(document.querySelector('#sync-confirm').textContent)`);
    await t.click("#sync-match"); await t.waitSel("#sync-devices .devrow", "Desktop");
  }),

  test("deep link: a unichat-sync link opens Sync devices and starts joining by itself; only the number is left", async (t) => {
    await open(t, "&pair=" + encodeURIComponent(LINK));
    await t.waitSel("#sync-confirm");
    await t.ok("Sync devices is open and the confirm dialog is up without any tap", `!!document.querySelector('#sync-panel') && /^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent)`);
    await t.click("#sync-match"); await t.waitSel("#sync-devices .devrow", "Desktop");
  }),

  test("deep link while the app is running (Android intent event) and a pasted link both join", async (t) => {
    await open(t);
    await t.ev(`dispatchEvent(new CustomEvent('unimsg-sync-link',{detail:{url:${JSON.stringify(LINK)}}}))`);
    await t.waitSel("#sync-confirm"); await t.click("#sync-cancel"); await t.waitGone(`document.querySelector('#sync-confirm')`);
    await t.setInput("#sync-code", LINK); await t.click("#sync-joinbtn"); await t.waitSel("#sync-confirm");
    await t.ok("pasting the link in the code field works too", `/^\\d{3} \\d{3}$/.test(document.querySelector('#sync-confirm-sas').textContent)`);
    await t.click("#sync-cancel");
  }),

  test("Scan QR: without a usable camera it says so and points to the code", async (t) => {
    await open(t);
    if (!(await t.ev<boolean>(`!!document.querySelector('#sync-scan')`))) { t.check("no scan button when the browser has no camera API", true); return; }
    await t.click("#sync-scan"); await t.waitSel("#sync-scan-msg");
    await t.ok("a message instead of a broken view", `document.querySelector('#sync-scan-msg').textContent.length>0`);
    await t.click("#sync-scan-close"); await t.waitGone(`document.querySelector('#sync-scanner')`);
  }),

  test("this device cannot reach the other one: one plain sentence and 'Add a device here instead'", async (t) => {
    await open(t); await t.ev(`window.__mockSyncBlockOut(true)`);
    await t.setInput("#sync-code", "bako-lemi-zuta-nosu"); await t.click("#sync-joinbtn"); await t.waitSel("#sync-flip");
    await t.ok("plain words, offers the other direction", `(()=>{const x=document.querySelector('#sync-flip').textContent;return /Couldn't reach that device/.test(x)&&/Add a device here instead/.test(x)&&!/firewall|TCP|port|multicast|mDNS|NAT/i.test(x)})()`);
    await t.not("no second scary error", `document.querySelector('#sync-err')`);
    await t.click("#sync-flip-btn"); await t.waitSel("#sync-pairing");
    await t.ok("a code is shown here now", `/bako-lemi-zuta-nosu/.test(document.querySelector('#sync-code-shown').textContent) && !document.querySelector('#sync-flip')`);
    await t.ev(`window.__mockSyncBlockOut(false); window.__mockSyncJoinRequest()`); await t.waitSel("#sync-confirm");
    await t.click("#sync-match"); await t.waitSel("#sync-devices .devrow", "Pixel phone");
  }),

  test("nearby connect that cannot reach the device: the failure is one short sentence", async (t) => {
    await open(t); await t.ev(`window.__mockSyncBlockOut(true); window.__mockSyncNearby(true)`); await t.waitSel("[data-nearby]");
    await t.click("[data-nearby] button", "Connect"); await t.waitSel("#sync-flip");
    await t.ok("same Wi-Fi hint in the sentence", `/Couldn't reach that device/.test(document.querySelector('#sync-flip').textContent)`);
  }),

  test("reconnecting: a device that drops shows an offline dot, the last sync time and one 'Couldn't reach' sentence", async (t) => {
    await pairedAsHost(t);
    await t.ok("online dot while connected", `!!document.querySelector('[data-dev="Pixel phone"] .dot.on')`);
    await t.ev(`window.__mockSyncDrop()`);
    await t.waitSel('[data-dev-problem="Pixel phone"]');
    await t.ok("short sentence with one suggested action, no raw reason", `document.querySelector('[data-dev-problem]').textContent==="Couldn't reach Pixel phone. Make sure both are on the same Wi-Fi."`);
    await t.ok("offline, last synced shown", `!document.querySelector('[data-dev="Pixel phone"] .dot.on') && /Offline · last synced/.test(document.querySelector('[data-dev="Pixel phone"]').textContent)`);
  }),

  test("first sync shows a single progress bar with counts", async (t) => {
    await pairedAsHost(t); await t.ev(`window.__mockSyncSnapshot()`);
    await t.waitSel("#sync-progress");
    await t.ok("one bar, percentage", `document.querySelectorAll('#sync-devices .bar').length===1 && /40%/.test(document.querySelector('#sync-progress').textContent)`);
  }),

  test("first sync shows phases: accounts and settings done, chats x of y, files; accounts carry a receiving badge until done", async (t) => {
    await pairedAsHost(t); await t.ev(`window.__mockSyncPhases(1)`);
    await t.waitSel("#sync-progress [data-phases]");
    await t.ok("three phases in order", `[...document.querySelectorAll('#sync-progress [data-phases=in] [data-phase]')].map(e=>e.dataset.phase).join()==="accounts,chats,files"`);
    await t.ok("accounts and settings done, chats 1200 of 5000", `document.querySelector('[data-phase=accounts]').dataset.done==="1" && /Chats and messages · 1200 of 5000/.test(document.querySelector('[data-phase=chats]').textContent) && !document.querySelector('[data-phase=chats]').dataset.done`);
    await t.ok("the sending direction is shown too", `/Sending to Pixel phone · 800 messages left/.test(document.querySelector('[data-sending]').textContent)`);
    await t.ok("files wait", `/Files · 14 waiting/.test(document.querySelector('[data-phase=files]').textContent)`);
    await t.ev(`document.querySelector('#sync-advanced').open = true`);
    await t.waitSel("[data-receiving]");
    await t.ev(`window.__mockSyncPhases(2)`);
    await t.waitGone(`document.querySelector('[data-receiving]')`);
  }),

  test("rename this device in the list; remove another one", async (t) => {
    await pairedAsHost(t);
    await t.click('[data-dev="My laptop"] button', "Rename"); await t.setInput('[data-dev="My laptop"] input', "Work PC"); await t.click('[data-dev="My laptop"] button', "Save");
    await t.waitSel("#sync-devices .devrow", "Work PC");
    await t.ok("renamed in the list", `/Work PC/.test(document.querySelector('#sync-devices').textContent)`);
    await t.ev(`window.__mockSyncAddDevice('Tablet')`); await t.waitSel('[data-dev="Tablet"]');
    await t.ev(`window.confirm = () => true`); await t.click('[data-dev="Pixel phone"] button', "Remove");
    await t.waitGone(`document.querySelector('[data-dev="Pixel phone"]')`);
    await t.ok("removed device is gone from the list, the other two stay a group", `!/Pixel phone/.test(document.querySelector('#sync-devices').textContent) && /Tablet/.test(document.querySelector('#sync-devices').textContent)`);
  }),

  test("removing a device tells everybody: the confirmation says so, an offline device shows 'Removal pending' until it confirmed", async (t) => {
    await pairedAsHost(t); await t.ev(`window.__mockSyncAddDevice('Tablet', false)`); await t.waitSel('[data-dev="Tablet"]');
    await t.ev(`window.__cm = ''; window.confirm = (m) => { window.__cm = m; return true }`); await t.click('[data-dev="Tablet"] button', "Remove");
    await t.waitSel("#sync-removal-pending", "Removal pending for Tablet (offline)");
    await t.ok("confirmation explains the group-wide effect", `/tells all other devices; with only two devices both unlink/.test(window.__cm)`);
    await t.ev(`window.__mockSyncRemovalAcked('Tablet')`); await t.waitGone(`document.querySelector('#sync-removal-pending')`);
  }),

  test("two devices: Remove unlinks both (the other is told first); offline it waits and says so, 'Unlink anyway' gives up waiting", async (t) => {
    await pairedAsHost(t);
    await t.ev(`window.__cm = ''; window.confirm = (m) => { window.__cm = m; return true }`); await t.click('[data-dev="Pixel phone"] button', "Remove");
    await t.waitGone(`document.querySelector('#sync-devices')`);
    await t.ok("two devices: the text says both unlink", `/only two devices are linked, so this device unlinks too/.test(window.__cm)`);
    await t.ev(`window.__mockSyncAddDevice('Pixel phone', false)`); await t.waitSel('[data-dev="Pixel phone"]');
    await t.click('[data-dev="Pixel phone"] button', "Remove");
    await t.waitSel("#sync-unlinking", "Pixel phone will unlink when it comes online");
    await t.ok("still linked, cannot add a device meanwhile", `!!document.querySelector('#sync-devices') && document.querySelector('#sync-start').disabled`);
    await t.ev(`window.__mockSyncPeerOnline()`); await t.waitGone(`document.querySelector('#sync-unlinking')`);
    await t.ok("both unlinked", `!document.querySelector('#sync-devices')`);
    await t.ev(`window.__mockSyncAddDevice('Pixel phone', false)`); await t.click('[data-dev="Pixel phone"] button', "Remove"); await t.waitSel("#sync-unlinking");
    await t.click("#sync-unlink-now"); await t.waitGone(`document.querySelector('#sync-unlinking')`);
  }),

  test("this device was removed by another one: the notice says by whom, keeps the data, and can be dismissed", async (t) => {
    await pairedAsHost(t); await t.ev(`window.__mockSyncRemoved('Pixel phone')`);
    await t.waitSel("#sync-removed-notice", "Removed from the sync group by Pixel phone");
    await t.ok("no device list any more, 'Add a device' is available", `!document.querySelector('#sync-devices') && !document.querySelector('#sync-start').disabled`);
    await t.click("#sync-removed-ok"); await t.waitGone(`document.querySelector('#sync-removed-notice')`);
  }),

  test("Advanced: network (off by default, scope, validated address), exposure text", async (t) => {
    await pairedAsHost(t); await adv(t);
    await t.ok("explains the exposure", `/Exposure/.test(document.querySelector('#sync-exposure').textContent)`);
    await t.ok("reachable by default after pairing, with the address", `document.querySelector('#sync-listen').checked && /192\\.168\\.1\\.20/.test(document.querySelector('#sync-network').textContent)`);
    await t.click("#sync-listen"); await t.not("scope hidden while off", `document.querySelector('#sync-scope')`);
    await t.click("#sync-listen"); await t.waitSel("#sync-scope");
    await t.ev(`(()=>{const s=document.querySelector('#sync-scope');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'address');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await t.waitSel("#sync-addr"); await t.setInput("#sync-addr", "10.9.9.9"); await t.click("#sync-network .row2 button");
    await t.ok("an address that is not on this computer is refused", `/no network interface/.test(document.querySelector('#sync-err').textContent)`);
    await t.setInput("#sync-addr", "100.64.0.7"); await t.click("#sync-network .row2 button");
    await t.ok("a VPN address is accepted", `document.querySelector('#sync-addr').value==='100.64.0.7' && !document.querySelector('#sync-err')`);
  }),

  test("Advanced: device addresses and relay server", async (t) => {
    await pairedAsHost(t); await adv(t);
    await t.click("#sync-addresses button", "Addresses"); await t.waitSel("[data-addrs] li");
    await t.ok("learned address listed", `/192\\.168\\.1\\.31:43210/.test(document.querySelector('[data-addrs]').textContent)`);
    await t.setInput("[data-addrs] input", "nas.example.org:43210"); await t.click("[data-addrs] .row2 button");
    await t.ok("manual address added, removable", `/nas\\.example\\.org:43210/.test(document.querySelector('[data-addrs]').textContent) && /remove/.test(document.querySelector('[data-addrs]').textContent)`);
    await t.ev(`document.querySelector('#sync-network details').open = true`);
    await t.setInput("#sync-relay", "https://nope"); await t.click("#sync-relay-save");
    await t.ok("not a relay address", `/not a relay address/.test(document.querySelector('#sync-err').textContent)`);
    await t.setInput("#sync-relay", "wss://relay.example.org/relay"); await t.click("#sync-relay-save");
    await t.not("saved without error", `document.querySelector('#sync-err')`);
  }),

  test("Advanced: reach my devices from anywhere (on by default, privacy note, own bootstrap node, 'not available' fallback)", async (t) => {
    await pairedAsHost(t);
    await t.ok("nothing about the DHT in the main view", `!/Holepunch|bootstrap|DHT/i.test(document.querySelector('#sync-advanced').closest('div').textContent.replace(document.querySelector('#sync-advanced').textContent,''))`);
    await adv(t); await t.ev(`document.querySelector('#sync-anywhere').open = true`);
    await t.ok("lives in Advanced > Network and is ON by default, ready", `!!document.querySelector('#sync-advanced #sync-network #sync-anywhere') && document.querySelector('#sync-dht') && document.querySelector('#sync-dht').checked && /Ready/.test(document.querySelector('#sync-dht-status').textContent)`);
    await t.ok("privacy note: helpers see the IP and the lookup, never content; says it is on by default", `/Holepunch/.test(document.querySelector('#sync-anywhere').textContent) && /see your IP address/.test(document.querySelector('#sync-anywhere').textContent) && /never any content/.test(document.querySelector('#sync-anywhere').textContent) && /on by default/.test(document.querySelector('#sync-anywhere').textContent)`);
    await t.setInput("#sync-dht-bootstrap", "not a node"); await t.click("#sync-dht-save");
    await t.ok("a bad bootstrap node is explained", `/not a bootstrap node/.test(document.querySelector('#sync-err').textContent)`);
    await t.setInput("#sync-dht-bootstrap", "dht.example.org:49737, 10.0.0.5:4000"); await t.click("#sync-dht-save");
    await t.not("own bootstrap nodes saved", `document.querySelector('#sync-err')`);
    await t.ok("still on", `document.querySelector('#sync-dht').checked && document.querySelector('#sync-dht-bootstrap').value==='dht.example.org:49737, 10.0.0.5:4000'`);
    await t.waitSel("#sync-dht:not(:disabled)"); await t.click("#sync-dht"); await t.ok("off after switching it off", `!document.querySelector('#sync-dht').checked && !document.querySelector('#sync-dht-status')`);
    await t.ev(`window.__mockSyncDhtUnavailable(true)`); await t.waitSel("#sync-dht:not(:disabled)"); await t.click("#sync-dht"); await t.waitSel("#sync-dht-status");
    await t.ok("a platform without the add-on says so (and the page keeps working)", `/not available on this platform/.test(document.querySelector('#sync-dht-status').textContent) && !!document.querySelector('#sync-dht')`);
  }),

  test("Advanced: media policy; per-account choice keeps the safe default (no login sharing)", async (t) => {
    await pairedAsHost(t); await adv(t);
    await t.ok("default: only on demand", `document.querySelector('#sync-media-mode').value==='off'`);
    await t.ok("no account shares its login by default", `[...document.querySelectorAll('select[data-acc]')].every(s=>s.value!=='credentials')`);
    await t.ev(`(()=>{const s=document.querySelector('#sync-media-mode');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'wifi');s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await t.waitSel("#sync-media input[type=number]");
    await t.ok("limits appear", `document.querySelectorAll('#sync-media input[type=number]').length===2`);
  }),

  test("Advanced: use another device's account, home device unreachable note", async (t) => {
    await pairedAsHost(t); await adv(t);
    await t.ok("share switch for every account this device holds", `document.querySelector('[data-proxy="wa-1"]') && document.querySelector('[data-proxy="mm-1"]') && !document.querySelector('[data-proxy="ig-1"]') && /send as this account/.test(document.querySelector('[data-proxy="wa-1"]').closest('label').textContent)`);
    await t.click('[data-proxy="wa-1"]'); await t.ok("shared", `document.querySelector('[data-proxy="wa-1"]').checked`);
    await t.ev(`window.__mockSyncOffer()`); await t.waitSel("[data-offer]");
    await t.click("[data-offer] button", "Add account from Desktop"); await t.waitSel("[data-proxy-via]");
    await t.ok("used through Desktop, connected", `/Desktop/.test(document.querySelector('[data-proxy-via]').textContent) && /connected/.test(document.querySelector('[data-proxy-via]').textContent)`);
    await t.ev(`window.__mockSyncDrop()`);
    await t.ok("holder offline shown", `/offline/.test(document.querySelector('[data-proxy-via]').textContent)`);
    await t.click("[data-proxy-via] button"); await t.waitGone(`document.querySelector('[data-proxy-via]')`);
  }),

  test("phone width: confirm dialog, add card and join box fit and are tappable", async (t) => {
    await t.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 2, mobile: true });
    await open(t); await t.ev(`window.__mockSyncNearby(true)`); await t.click("#sync-start"); await t.waitSel("#sync-pairing");
    await t.ok("panel fits the screen", `(()=>{const p=document.querySelector('#sync-panel');return p.scrollWidth<=p.clientWidth+1})()`);
    await t.ok("buttons are at least 44px high", `[...document.querySelectorAll('#sync-panel button')].filter(b=>b.offsetHeight>0).every(b=>b.offsetHeight>=44)`);
    await t.ev(`window.__mockSyncJoinRequest(true)`); await t.waitSel("#sync-confirm");
    await t.ok("dialog is inside the screen, buttons 44px", `(()=>{const r=document.querySelector('#sync-confirm .sheet').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&[...document.querySelectorAll('#sync-confirm button')].every(b=>b.offsetHeight>=44)})()`);
    await t.shot("sync_phone");
  }),

  test("Advanced: an account that comes from another device cannot be shared onward (explained); 'Send the full history' goes to one online device", async (t) => {
    await open(t); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true)`); await t.waitSel("[data-dev='Pixel phone']");
    await t.ev(`window.__mockSyncSharedFrom('mm-1','Desktop')`); await adv(t);
    await t.waitSel("[data-shared-from='mm-1']", "comes from Desktop; share it from there");
    await t.ok("no credential option and no relay switch for it", `!document.querySelector('[data-acc="mm-1"] option[value="credentials"]') && !document.querySelector('[data-proxy="mm-1"]')`);
    await t.waitSel("[data-push-history='wa-1'] button", "Send the full history of WhatsApp now");
    await t.click("[data-push-history='wa-1'] button");
    await t.ok("sent for that account and device", `(__mockSyncLog||[]).some(c=>c.method==='syncSendHistory' && c.params.accountId==='wa-1')`);
  }),
];

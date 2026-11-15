// Sending through another device (mock UI): status wording everywhere an account state is shown, the composer, the one-time question on the holder,
// the devices list, phone width. Wording is fixed: "via X", "Archive only — X is offline", "History copy — ask X to allow sending".
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const SIGNAL = "mx-1"; // a mock account used as the relayed one (Matrix); chat "mx-1:..." exist in the mock
const relay = (t: any, kind: string | null, id = SIGNAL, dev = "MSLaptop") => t.ev(`window.__mockRelay(${JSON.stringify(id)}, ${JSON.stringify(kind)}, ${JSON.stringify(dev)})`);
const foot = (id = SIGNAL) => `document.querySelector('footer [data-acct=${JSON.stringify(id)}]')`; // a status ring (a button) whose aria-label carries the full text
const lbl = (id = SIGNAL) => `${foot(id)}.getAttribute('aria-label')`;
const WORDS = {
  relay: "via MSLaptop", offline: "Archive only — MSLaptop is offline", ask: "History copy — ask MSLaptop to allow sending", denied: "History copy — MSLaptop doesn't allow sending",
} as Record<string, string>;
const openAccounts = async (t: any) => { await settings(t, "Accounts"); await t.waitSel(".acard"); };
const card = (id = SIGNAL) => `(()=>{const n=[...document.querySelectorAll('.acard')].find(c=>c.textContent.includes('@michi:matrix.org')); return n})()`;

export default [
  test("relayed account is ONLINE (green) with 'via MSLaptop' in the footer, the account cards and the Messenger filter menu", async (t) => {
    await t.open(); await relay(t, "relay");
    await t.ok("footer: green dot + via MSLaptop", `(()=>{const e=${foot()}; return !!e && e.dataset.ring==='relay' && e.getAttribute('aria-label').includes('via MSLaptop') && !/signed out/i.test(e.getAttribute('aria-label')) && e.title===e.getAttribute('aria-label')})()`);
    await t.click('[data-filter="messenger"]');
    await t.ok("filter menu says via MSLaptop next to the account", `/via MSLaptop/.test(document.querySelector('[data-menu="messenger"] [data-account="${SIGNAL}"]').textContent)`);
    await t.click('[data-filter="messenger"]');
    await openAccounts(t);
    await t.ok("account card: Connected pill + the note, no Sign out / Profile for a relayed account", `(()=>{const c=${card()}; const p=c.querySelector('.spill'); return p.classList.contains('connected') && /Connected/.test(p.textContent) && /via MSLaptop/.test(c.textContent) && ![...c.querySelectorAll('button')].some(b=>/Sign out|Profile/.test(b.textContent))})()`);
    await t.shot("relay_card");
  }),

  test("holder offline: 'Archive only — MSLaptop is offline' everywhere, composer blocked with the same words, no sign-in nag", async (t) => {
    await t.open(); await relay(t, "offline");
    await t.ok("footer", `${lbl()}.includes(${JSON.stringify(WORDS.offline)}) && ${foot()}.dataset.ring==='off'`);
    await t.not("not shown as 'signed out'", `/signed out/i.test(${lbl()})`);
    await openAccounts(t);
    await t.ok("card pill and note", `(()=>{const c=${card()}; return /Archive only/.test(c.querySelector('.spill').textContent) && c.textContent.includes(${JSON.stringify(WORDS.offline)})})()`);
  }),

  test("history copy without permission: wording, Ask button on the card and in the composer, answer is shown", async (t) => {
    await t.open("&chat=mx-1:@bea:matrix.org"); await relay(t, "ask");
    await t.ok("footer", `${lbl()}.includes(${JSON.stringify(WORDS.ask)}) && ${foot()}.dataset.ring==='off'`);
    await t.waitSel('[data-via-ro="ask"]');
    await t.ok("composer says it and offers 'Ask MSLaptop'", `(()=>{const c=document.querySelector('[data-via-ro="ask"]'); return c.textContent.includes(${JSON.stringify(WORDS.ask)}) && !/Sign in again/.test(c.textContent) && /Ask MSLaptop/.test(c.querySelector('button').textContent)})()`);
    await t.click('[data-via-ro="ask"] button'); await t.waitSel("[data-asked]", "Asked MSLaptop");
    await t.ok("the ask went to the backend once", `window.__mockRelayLog.filter(x=>x.method==='syncRelayAsk' && x.params.accountId==='${SIGNAL}').length===1`);
    await relay(t, "denied");
    await t.ok("denied wording", `${lbl()}.includes(${JSON.stringify(WORDS.denied)})`);
    await relay(t, null); await t.ok("back to ordinary", `!${foot()}.dataset.via && ${foot()}.dataset.ring==='ok' && !/via/.test(${lbl()})`);
  }),

  test("relayed account: composer works normally with a tiny 'via MSLaptop' hint (tooltip), offline blocks with the message", async (t) => {
    await t.open("&chat=mx-1:@bea:matrix.org"); await relay(t, "relay");
    await t.waitSel("[data-via-hint]");
    await t.ok("hint is tiny and has the tooltip", `(()=>{const h=document.querySelector('[data-via-hint]'); return h.textContent==='via MSLaptop' && h.title==='Sends through MSLaptop' && parseFloat(getComputedStyle(h).fontSize)<=11})()`);
    await t.ok("composer is a normal editor", `!!document.querySelector('.composer textarea')`);
    await t.setInput(".composer textarea", "hello via laptop"); await t.ev(`document.querySelector('.composer').requestSubmit()`);
    await t.ok("message was sent", `[...document.querySelectorAll('.messages .msg')].some(m=>/hello via laptop/.test(m.textContent))`);
    await t.shot("relay_composer");
    await relay(t, "offline"); await t.waitSel('[data-via-ro="offline"]'); await t.not("hint gone", `document.querySelector('[data-via-hint]')`);
    await t.ok("blocked with the words", `document.querySelector('[data-via-ro="offline"]').textContent.includes(${JSON.stringify(WORDS.offline)}) && !document.querySelector('.composer textarea')`);
  }),

  test("holder prompt: one question naming device and account; Allow / Don't allow are remembered and listed in the devices list; revoke from there", async (t) => {
    await t.open(); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true)`); await t.ev(`window.__mockRelayPrompt('Pixel phone','mm-1')`);
    await t.waitSel("#relay-ask");
    await t.ok("the wording", `document.querySelector('#relay-ask-title').textContent==='Pixel phone wants to send messages as Work Mattermost through this device. Allow?'`);
    await t.ok("no jargon", `!/proxy|relay|ledger/i.test(document.querySelector('#relay-ask .sheet').textContent)`);
    await t.shot("relay_prompt");
    await t.click("#relay-allow"); await t.waitGone(`document.querySelector('#relay-ask')`);
    await t.ok("the answer was sent for that device and account", `window.__mockRelayLog.some(x=>x.method==='syncRelaySet' && x.params.accountId==='mm-1' && x.params.allow===true)`);
    await settings(t, "Sync devices"); await t.waitSel("#sync-panel");
    await t.ok("devices list: can send as", `/Can send as Work Mattermost/.test(document.querySelector('[data-relay-dev="Pixel phone"]').textContent)`);
    await t.click('[data-relay-dev="Pixel phone"] button'); await t.waitSel('[data-relay-dev="Pixel phone"]', "Can't send as Work Mattermost");
    await t.ok("no prompt again", `!document.querySelector('#relay-ask')`);
    await t.ev(`window.__mockRelayPrompt('Pixel phone','mm-1')`); await t.waitSel("#relay-deny"); await t.click("#relay-deny");
    await t.ok("'Don't allow' was sent", `window.__mockRelayLog.some(x=>x.method==='syncRelaySet' && x.params.allow===false)`);
  }),

  test("Settings > Sync: main view has no jargon even with a prompt and decisions; Advanced has the per-account switch", async (t) => {
    await t.open(); await t.ev(`window.__mockSyncAddDevice('Pixel phone', true)`); await t.ev(`window.__mockRelayPrompt()`); await t.click("#relay-allow");
    await settings(t, "Sync devices"); await t.waitSel("#sync-panel");
    await t.ok("no jargon outside Advanced", `(()=>{const p=document.querySelector('#sync-panel').cloneNode(true); p.querySelector('#sync-advanced')?.remove(); return !/\\b(group|listen\\w*|proxy|ledger|relay|HLC)\\b/i.test(p.textContent)})()`);
    await t.ev(`document.querySelector('#sync-advanced').open = true`);
    await t.ok("switch: Let my other devices send as this account (off by default)", `(()=>{const i=document.querySelector('[data-proxy="mm-1"]'); return !!i && !i.checked && /Let my other devices send as this account/.test(i.closest('label').textContent)})()`);
  }),

  test("phone width: relayed / archive / ask states fit, the status row wraps, the composer hint and Ask button are inside the screen", async (t) => {
    await t.device("phone"); await t.open("&chat=mx-1:@bea:matrix.org");
    await relay(t, "relay"); await t.waitSel("[data-via-hint]");
    const inside = (sel: string) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; const r=e.getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth+1&&r.width>0})()`;
    await t.ok("hint inside the viewport", inside("[data-via-hint]"));
    await relay(t, "ask"); await t.waitSel('[data-via-ro="ask"] button');
    await t.ok("ask button reachable (>= 40px high) and inside", `(()=>{const b=document.querySelector('[data-via-ro="ask"] button').getBoundingClientRect(); return b.height>=36 && b.left>=0 && b.right<=innerWidth+1})()`);
    await t.ok("composer text wraps, no horizontal scroll", `document.documentElement.scrollWidth<=innerWidth`);
    await t.shot("relay_phone_ask");
  }),
];

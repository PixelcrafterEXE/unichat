// Disappearing messages (mock connectors only: WhatsApp and Signal "can" set the timer, Matrix cannot).
import { test } from "../lib/test.ts";

const BEN = "&chat=wa-1:ben&info=1";
const pick = (v: number) => `(()=>{const s=document.querySelector('[data-act=disappearing-select]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,'${v}'); s.dispatchEvent(new Event('change',{bubbles:true})); return true})()`;

export default [
  test("disappearing: set the timer in chat info -> header badge, system note; turn it off again", async (t) => {
    await t.open(BEN);
    await t.waitSel('[data-act=disappearing-select]');
    await t.eq("offers off + the WhatsApp timers", `[...document.querySelectorAll('[data-act=disappearing-select] option')].map(o=>o.textContent).join('|')`, "Off|24 hours|7 days|90 days");
    await t.not("no badge while off", `document.querySelector('.dtbadge')`);
    await t.ev(pick(604800));
    await t.ok("header badge shows 7d", `document.querySelector('main header .dtbadge')?.textContent === '7d'`);
    await t.ok("system note in the timeline", `[...document.querySelectorAll('.sysmsg.k-info')].some(e=>e.textContent.includes('Disappearing messages: 7 days') && e.querySelector('[data-timer-note]'))`);
    await t.eq("select shows the current value", `document.querySelector('[data-act=disappearing-select]').value`, "604800");
    await t.shot("badge"); await t.ev("document.querySelector('.infobody').scrollTop=99999;true"); await t.shot("info");
    await t.ev(pick(0));
    await t.not("badge gone after turning it off", `document.querySelector('.dtbadge')`);
    await t.ok("off note", `[...document.querySelectorAll('.sysmsg.k-info')].some(e=>e.textContent.includes('Disappearing messages turned off'))`);
  }),

  test("disappearing: a message that carries a timer shows the mark; plain ones do not", async (t) => {
    await t.open("&chat=wa-1:ben");
    await t.ev(`__mockInjectExp('wa-1:ben','Ben Fischer','this will vanish',86400); __mockInject('wa-1:ben','Ben Fischer','stays'); true`);
    await t.ok("mark on the timed message", `(()=>{const m=__e2e.msg('this will vanish'); return !!m?.querySelector('.expmark[data-expires="86400"]')})()`);
    await t.ok("no mark on the other", `(()=>{const m=__e2e.msg('stays'); return !!m && !m.querySelector('.expmark')})()`);
  }),

  test("disappearing: hidden where the connector cannot set it; shown read-only when the chat has a timer", async (t) => {
    await t.open("&chat=mx-1:@bea:matrix.org&info=1");
    await t.waitSel(".hero");
    await t.not("no setting for Matrix", `document.querySelector('.dtsec')`);
    await t.ev(`__mockSetChat('mx-1:@bea:matrix.org',{disappearing:86400}); true`);
    await t.ok("badge appears", `document.querySelector('main header .dtbadge')?.textContent === '1d'`);
    await t.ok("read-only line, no select", `!!document.querySelector('[data-act=disappearing-readonly]') && !document.querySelector('[data-act=disappearing-select]')`);
  }),

  test("disappearing: a failing change shows the error and keeps the old timer", async (t) => {
    await t.open(BEN);
    await t.waitSel('[data-act=disappearing-select]');
    await t.ev(`globalThis.__mockDisFail = true; true`);
    await t.ev(pick(86400));
    await t.ok("error shown", `document.querySelector('[data-act=disappearing-error]')?.textContent.includes('not allowed')`);
    await t.not("no badge", `document.querySelector('.dtbadge')`);
  }),

  test("disappearing: Signal offers its own list", async (t) => {
    await t.open("&chat=wa-1:ben&info=1");
    await t.waitSel('[data-act=disappearing-select]');
    await t.ev(`__mockSetCaps('wa-1',{disappearingDurations:[30,3600]}); true`);
    await t.eq("options follow the connector's list", `[...document.querySelectorAll('[data-act=disappearing-select] option')].map(o=>o.textContent).join('|')`, "Off|30 seconds|1 hour");
  }),
];

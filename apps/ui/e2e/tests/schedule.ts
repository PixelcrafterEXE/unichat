// Sending through another device, part 2: a Retry reuses the same client id (so a lost answer never makes a duplicate), and scheduled messages
// for an account that is used through another device wait for it / are not sent silently when far too late. Mock UI.
import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const sched = (t: any, text: string, chat = "wa-1:anna") => t.ev(`__mockCall('scheduleMessage', { chatId: ${JSON.stringify(chat)}, text: ${JSON.stringify(text)}, at: Date.now() + 3600000 })`);
const openSched = async (t: any) => { await settings(t, "Scheduled messages"); await t.waitSel(".acard[data-job]"); };

export default [
  test("Retry of a failed send uses the SAME client id as the first try", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.typeIn("/fail first try"); await t.enter();
    await t.waitSel(".msg .retry, .msg button", "Retry");
    await t.ok("the first try carried a random client id", `(()=>{const l=globalThis.__mockSendLog||[]; return l.length===1 && /^[0-9a-f]{32}$/.test(l[0].clientId)})()`);
    await t.click(".msg button", "Retry");
    await t.ok("the retry reused it", `(()=>{const l=globalThis.__mockSendLog||[]; return l.length===2 && l[0].clientId===l[1].clientId})()`);
    await t.typeIn("another message"); await t.enter();
    await t.ok("a new message gets a new id", `(()=>{const l=globalThis.__mockSendLog; return l.length===3 && l[2].clientId!==l[0].clientId})()`);
  }),

  test("scheduled message waiting for the other device: shown in Settings and in the chat with the same words", async (t) => {
    await t.open("&chat=wa-1:anna"); await sched(t, "good morning"); await t.ev(`__mockJobState(0, 'waiting')`);
    await t.waitSel("[data-sched-note]", "Waiting for MSLaptop to come online");
    await openSched(t);
    await t.ok("card says Waiting with the reason, can be cancelled", `(()=>{const c=document.querySelector('[data-job-state=waiting]'); return !!c && /Waiting/.test(c.querySelector('.spill').textContent) && c.querySelector('[data-job-note]').textContent==='Waiting for MSLaptop to come online' && /Cancel/.test(c.textContent) && /good morning/.test(c.textContent)})()`);
    await t.shot("schedule_waiting");
    await t.ev(`globalThis.__jobs[0].status='done'; __mockEmit('job', globalThis.__jobs[0])`); await t.waitGone(`document.querySelector('[data-job-state=waiting]')`);
  }),

  test("scheduled message that is too late is NOT sent silently: sentence, Send now / Delete", async (t) => {
    await t.open("&chat=wa-1:anna"); await sched(t, "old news"); await sched(t, "older news"); await t.ev(`__mockJobState(0, 'late'); __mockJobState(1, 'late')`);
    await openSched(t);
    await t.ok("the sentence and both choices", `(()=>{const c=document.querySelector('[data-job-state=late]'); const n=c.querySelector('[data-job-note]').textContent; return /could not be sent within 24 hours, so it was not sent\\. Send it now or delete it\\./.test(n) && !!c.querySelector('[data-act=job-send-now]') && !!c.querySelector('[data-act=job-delete]') && /Not sent/.test(c.querySelector('.spill').textContent)})()`);
    await t.click('[data-act=job-send-now]'); await t.waitFor(`document.querySelectorAll('[data-job-state=late]').length===1`, { desc: "one left" });
    await t.click('[data-job-state=late] [data-act=job-delete]'); await t.waitGone(`document.querySelector('[data-job-state=late]')`);
    await t.ok("nothing left", `/Nothing is scheduled/.test(document.body.textContent)`);
  }),

  test("scheduled message of an account that is not relayed any more: failed with the reason", async (t) => {
    await t.open("&chat=wa-1:anna"); await sched(t, "lost"); await t.ev(`__mockJobState(0, 'aborted')`);
    await openSched(t);
    await t.ok("reason shown, only Delete", `(()=>{const c=document.querySelector('[data-job-state=failed]'); return /doesn't allow sending as this account\\. Nothing was sent\\./.test(c.querySelector('[data-job-note]').textContent) && !c.querySelector('[data-act=job-send-now]') && !!c.querySelector('[data-act=job-delete]')})()`);
  }),

  test("phone width: waiting / late cards and the chat note fit", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna"); await sched(t, "phone message"); await t.ev(`__mockJobState(0, 'waiting')`);
    await t.waitSel("[data-sched-note]");
    await t.ok("note inside the screen", `(()=>{const r=document.querySelector('[data-sched-note]').getBoundingClientRect(); return r.left>=0&&r.right<=innerWidth+1})()`);
    await t.ev(`__mockJobState(0, 'late')`); await t.ev(`document.querySelector('.burger')?.click()`);
    await t.ok("no horizontal scroll", `document.documentElement.scrollWidth<=innerWidth`);
  }),
];

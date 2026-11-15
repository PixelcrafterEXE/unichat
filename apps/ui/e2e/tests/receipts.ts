// "Message info": click the ticks of one of my messages to see who received / read it and when.
import { test } from "../lib/test.ts";

const FAM = "&chat=wa-1:family";
const CAKE = `__e2e.msg("Who is bringing the cake?")`;
const ticks = `${CAKE}.querySelector('button.ticks[aria-label="Message info"]')`;
const names = (sec: string) => `[...document.querySelectorAll('.minfo [data-section=${sec}] .mi-name')].map((x) => x.textContent).join(",")`;

export default [
  test("group: ticks open Message info with Read by / Delivered to / Not yet, names, times", async (t) => {
    await t.open(FAM);
    await t.waitFor(CAKE);
    await t.ok("the ticks of my message are a button", ticks);
    await t.ev(`${ticks}.click()`);
    await t.waitSel(".minfo");
    await t.ok("header shows the message and its sent time", `document.querySelector('.minfo .mi-preview').textContent.includes('cake') && /^Sent /.test(document.querySelector('.minfo .mi-sent').textContent)`);
    await t.eq("Read by lists who read it (newest first)", names("read"), "Ben Fischer,Anna Becker");
    await t.eq("Delivered to lists who only got it", names("delivered"), "Tom,Carl");
    await t.eq("Not yet lists the rest of the members", names("pending"), "Lea");
    await t.ok("every row has an exact time (with seconds) except Not yet", `[...document.querySelectorAll('.minfo [data-section=read] .mi-time')].every((x) => /\\d:\\d\\d:\\d\\d/.test(x.textContent)) && !document.querySelector('.minfo [data-section=pending] .mi-time')`);
    await t.eq("section counts", `[...document.querySelectorAll('.minfo h4 [data-count]')].map((x) => x.textContent).join(",")`, "2,2,1");
    await t.shot("message-info-group");
  }),

  test("live: a new receipt event moves a member from Not yet to Read while the dialog is open", async (t) => {
    await t.open(FAM);
    await t.waitFor(CAKE);
    await t.ev(`${ticks}.click()`);
    await t.waitSel(".minfo");
    await t.eq("starts with Lea pending", names("pending"), "Lea");
    const msgId = await t.ev(`${CAKE}.dataset.mid`);
    await t.ev(`__mockReceipt("wa-1:family", ${JSON.stringify(msgId)}, "wa-1:family/c4", "read")`);
    await t.eq("Lea is now in Read by (newest first)", names("read"), "Lea,Ben Fischer,Anna Becker");
    await t.not("nobody is pending any more", `document.querySelector('.minfo [data-section=pending]')`);
    // an older time never moves a receipt backwards
    await t.ev(`__mockReceipt("wa-1:family", ${JSON.stringify(msgId)}, "wa-1:family/c4", "read", "2000-01-01T00:00:00Z")`);
    await t.stays("time did not move backwards", `/2000/.test(document.querySelector('.minfo [data-section=read] [data-who="wa-1:family/c4"] .mi-time').textContent)`, 300);
    await t.ev(`__mockReceipt("wa-1:family", ${JSON.stringify(msgId)}, "wa-1:family/c3", "read", new Date(Date.now() - 3 * 864e5).toISOString())`);
    await t.ok("a receipt from another day shows the date", `/\\d\\s\\w+,|\\w+\\s\\d+,/.test(document.querySelector('.minfo [data-section=read] [data-who="wa-1:family/c3"] .mi-time').textContent) || /,/.test(document.querySelector('.minfo [data-section=read] [data-who="wa-1:family/c3"] .mi-time').textContent)`);
    await t.click('.modal button[aria-label="Close"]');
    await t.not("closes", `document.querySelector('.minfo')`);
  }),

  test("1:1: the single recipient's Delivered / Read times, and a plain-language note when nothing is known", async (t) => {
    await t.open("&chat=wa-1:anna");
    const mine = `__e2e.msg("10am at the station")`;
    await t.waitFor(mine);
    await t.ev(`${mine}.querySelector('button.ticks[aria-label="Message info"]').click()`);
    await t.waitSel(".minfo");
    await t.ok("Read and Delivered rows have times", `['Read','Delivered'].every((l) => /\\d:\\d\\d:\\d\\d/.test(document.querySelector('.minfo [data-row=' + l + '] .mi-time').textContent))`);
    await t.shot("message-info-dm");
    await t.click('.modal button[aria-label="Close"]');
    // a delivered message without per-recipient data: aggregate state + note
    await t.open("&chat=wa-1:ben");
    const ben = `__e2e.msg("Will pay tomorrow")`;
    await t.waitFor(ben);
    await t.ev(`${ben}.querySelector('button.ticks[aria-label="Message info"]').click()`);
    await t.waitSel(".minfo");
    await t.eq("delivered time known", `document.querySelector('.minfo [data-row=Delivered] .mi-time').textContent.includes(':')`, true);
    await t.eq("not read yet", `document.querySelector('.minfo [data-row=Read] .mi-time').textContent`, "Not yet");
  }),

  test("groups without receiptDetails have plain ticks; 1:1 always offers the popover; matrix shows read only", async (t) => {
    await t.open(FAM);
    await t.waitFor(CAKE);
    await t.ev(`__mockSetCaps('wa-1',{receiptDetails:false})`);
    await t.ok("ticks are no button without receiptDetails", `!${ticks} && ${CAKE}.querySelector('.ticks[role=img]')`);
    await t.ev(`__mockSetCaps('wa-1',{receiptDetails:true})`);
    await t.ok("and a button again when the account says so", ticks);
    await t.open("&chat=mx-1:!rust-general");
    const q = `__e2e.msg("Anyone tried them")`;
    await t.waitFor(q);
    await t.ev(`${q}.querySelector('button.ticks[aria-label="Message info"]').click()`);
    await t.waitSel(".minfo");
    await t.ok("Matrix: Read by listed, nobody under Delivered to", `document.querySelectorAll('.minfo [data-section=read] .mi-row').length === 2 && !document.querySelector('.minfo [data-section=delivered]')`);
  }),

  test("sending a message in a 1:1 chat fills its receipts live", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.typeIn("receipt please");
    await t.enter();
    const mine = `__e2e.msg("receipt please")`;
    await t.waitFor(`${mine}?.querySelector('button.ticks[data-status=read]')`);
    await t.ev(`${mine}.querySelector('button.ticks').click()`);
    await t.waitSel(".minfo");
    await t.ok("Read row has a time", `/\\d:\\d\\d:\\d\\d/.test(document.querySelector('.minfo [data-row=Read] .mi-time').textContent)`);
  }),
];

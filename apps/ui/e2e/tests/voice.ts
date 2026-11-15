// Voice notes: recording (fake microphone), sending, helpers.
import { test } from "../lib/test.ts";

export default [
  test("record a voice message with the (fake) microphone and send it", async (t) => {
    await t.open("&chat=wa-1:ben");
    await t.waitSel(".msg");
    const n0 = await t.ev(`document.querySelectorAll('.messages .voice').length`);
    await t.click('button[title="Record voice message"]');
    await t.waitSel(".composer.recording");
    await t.ok("recording UI shows a timer and live bars", `document.querySelector('.composer.recording .rectime') && document.querySelector('.recbars')`);
    await t.ok("send is disabled until 1 s was recorded", `document.querySelector('button[title="Send voice message"]').disabled`);
    await t.not("after about a second send becomes available", `document.querySelector('button[title="Send voice message"]').disabled`, { timeout: 6000 });
    await t.click('button[title="Send voice message"]');
    await t.not("recording bar closes", `document.querySelector('.composer.recording')`, { timeout: 10000 });
    await t.ok("a new voice message appears in the timeline", `document.querySelectorAll('.messages .voice').length > ${n0}`, { timeout: 10000 });
  }),

  test("discarding a recording sends nothing", async (t) => {
    await t.open("&chat=wa-1:ben");
    const n0 = await t.ev(`document.querySelectorAll('.messages .msg').length`);
    await t.click('button[title="Record voice message"]');
    await t.waitSel(".composer.recording");
    await t.click('.composer.recording button[title="Discard"]');
    await t.not("recording UI closes", `document.querySelector('.composer.recording')`);
    await t.eq("nothing was sent", `document.querySelectorAll('.messages .msg').length`, n0);
  }),

  test("voice helpers: duration format and waveform bars", async (t) => {
    await t.open();
    await t.eq("fmtDuration", `[__voice.fmtDuration(0), __voice.fmtDuration(65), __voice.fmtDuration(3599.6)]`, ["0:00", "1:05", "60:00"]);
    await t.eq("toBars of nothing is a flat default", `__voice.toBars([],4)`, [8, 8, 8, 8]);
    await t.ok("toBars normalises the loudest bar to 100", `Math.max(...__voice.toBars([0.1,0.5,0.25,0.5],4))===100`);
  }),
];

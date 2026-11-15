// Backend heartbeat (Android bridge): a silent backend shows "Reconnecting…", a restart is requested after a long silence, and the UI recovers by itself.
// The mock simulates the bridge with ?mock&hb=<ms>: window.__mockSilent = true makes the fake backend stop answering pings.
import { test } from "../lib/test.ts";

export default [
  test("silent backend: 'Reconnecting…' banner, then the app recovers by itself when the backend answers again", async (t) => {
    await t.open("&hb=150");
    await t.not("no banner while the backend answers", `document.querySelector('.error.reconnect')`);
    await t.ev(`window.__mockSilent = true`);
    await t.ok("banner appears", `/Reconnecting/.test(document.querySelector('.error.reconnect')?.textContent ?? '')`);
    await t.ev(`window.__mockSilent = false`);
    await t.waitGone(`document.querySelector('.error.reconnect')`);
  }),
  test("a backend that stays silent makes the UI ask the native side for a restart (once), then recovers", async (t) => {
    await t.open("&hb=100");
    await t.ev(`window.__mockSilent = true`);
    await t.eq("restart requested once", `window.__mockRestarts`, 1);
    await t.waitGone(`document.querySelector('.error.reconnect')`);
    await t.ok("calls work again", `document.querySelectorAll('.chatrow, [data-chat]').length >= 0`);
  }),
];

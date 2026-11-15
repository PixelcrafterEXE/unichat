import { test } from "../lib/test.ts";
import { settings } from "../lib/ui.ts";

const card = (id: string) => `[data-history="${id}"]`;
const ready = `window.__mockHistGap = 150`;

export default [
  test("fetch history is offered only for messengers that can do it", async (t) => {
    await t.open();
    await settings(t, "Storage & downloads");
    await t.waitSel(card("mx-1"));
    await t.ok("Matrix and Discord accounts have it", `document.querySelector('${card("mx-1")}') && document.querySelector('${card("dc-1")}')`);
    await t.not("WhatsApp, Instagram do not (capability not declared)", `document.querySelector('${card("wa-1")}') || document.querySelector('${card("ig-1")}')`);
  }),

  test("Storage & downloads: running job bars survive leaving and re-entering the tab", async (t) => {
    await t.open();
    await settings(t, "Storage & downloads");
    await t.waitSel('[data-act="download-media"]');
    await t.ev(`window.__mockMediaGap = 400; window.__mockHistGap = 400`);
    await t.click('[data-act="download-media"]');
    await t.waitSel("[data-media-progress]");
    await t.ev(`window.__mockMediaGap = 400`);
    await t.click(".settings nav button", "Appearance");
    await t.click(".settings nav button", "Storage & downloads");
    await t.waitSel("[data-media-progress]");
    await t.ok("the media job bar is still there after coming back", `!!document.querySelector('[data-media-progress]')`);
    await t.click(`${card("mx-1")} [data-act="fetch-history"]`);
    await t.waitSel(`${card("mx-1")} [data-hist-progress]`);
    await t.click(".settings nav button", "Appearance");
    await t.click(".settings nav button", "Storage & downloads");
    await t.waitSel(`${card("mx-1")} [data-hist-progress]`);
    await t.ok("the history job bar is still there too", `!!document.querySelector('${card("mx-1")} [data-hist-progress]')`);
  }),

  test("fetch history: progress, finish and a summary of new messages", async (t) => {
    await t.open();
    await settings(t, "Storage & downloads");
    await t.waitSel(card("mx-1"));
    await t.ev(`window.__mockHistGap = 120`);
    await t.click(`${card("mx-1")} [data-act="fetch-history"]`);
    await t.waitSel(`${card("mx-1")} [data-hist-progress]`);
    await t.ok("shows chats done / total and messages fetched", `/\\d+\\/\\d+ chats · \\d+ messages fetched/.test(document.querySelector('${card("mx-1")} [data-hist-progress]').textContent)`);
    await t.ok("finishes with a summary", `document.querySelector('${card("mx-1")} [data-hist-done="done"]')`, { timeout: 15000 });
    await t.ok("the summary counts new messages", `/[1-9]\\d* new messages/.test(document.querySelector('${card("mx-1")} [data-hist-done]').textContent)`);
    await t.ev(`document.querySelector('.settings .close, .settings header button')?.click()`);
  }),

  test("fetch history: cancel and failure reasons", async (t) => {
    await t.open();
    await settings(t, "Storage & downloads");
    await t.waitSel(card("mx-1"));
    await t.ev(`window.__mockHistGap = 400`);
    await t.click(`${card("mx-1")} [data-act="fetch-history"]`);
    await t.waitSel(`${card("mx-1")} [data-act="cancel-history"]`);
    await t.click(`${card("mx-1")} [data-act="cancel-history"]`);
    await t.ok("cancelled summary", `document.querySelector('${card("mx-1")} [data-hist-done="cancelled"]')`, { timeout: 10000 });
    await t.ev(`window.__mockHistGap = 10; for (const id of Object.keys(window.__mockHistFail)) delete window.__mockHistFail[id]; `);
    await t.click(`${card("mx-1")} [data-act="pick-chats"]`);
    await t.waitSel(`${card("mx-1")} [data-hist-pick] input`);
    await t.click(`${card("mx-1")} [data-hist-pick] input`);
    await t.click(`${card("mx-1")} [data-hist-pick] input`, undefined, 1);
    await t.ok("button says 2 chats", `/Fetch 2 chats/.test(document.querySelector('${card("mx-1")} [data-act="fetch-history"]').textContent)`);
    // make one selected chat fail with a reason
    await t.ev(`(()=>{const ids=[...document.querySelectorAll('${card("mx-1")} [data-hist-pick] input')].slice(0,2); window.__mockHistFail = {}; window.__pickedNames = ids.map(i=>i.parentElement.textContent.trim());})()`);
    await t.ev(`window.__mockHistFail = new Proxy({}, { get: (_, id) => (typeof id === 'string' && id.startsWith('mx-1:') && !window.__failedOnce ? (window.__failedOnce = 1, 'rate-limited') : undefined) })`);
    await t.click(`${card("mx-1")} [data-act="fetch-history"]`);
    await t.ok("failure reasons are summarised", `/Not completed: 1 rate limited by the service/.test(document.querySelector('${card("mx-1")} [data-hist-done]')?.textContent ?? '')`, { timeout: 10000 });
  }),
];

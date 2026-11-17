// Archive, unread counts and desktop notifications in plain chats.
import { NOTIFY_INIT, test } from "../lib/test.ts";

export default [
  test("archiving a chat with 2 unread lowers the Home badge by 2", async (t) => {
    await t.open("", { settle: true });
    const badge = `Number(document.querySelector('.rail .pbadge')?.textContent ?? 0)`;
    const b0 = await t.ev(badge);
    await t.rowMenu("A24");
    await t.menuItem(/^\s*Archive\s*$/);
    await t.eq("Home badge drops by the chat's unread", badge, b0 - 2);
    await t.not("the chat left the list", `__e2e.rows().includes('A24')`);
  }),

  test("a live message in a plain chat: notification names the sender, unread counts up, opening clears it", async (t) => {
    await t.open("", { settle: true });
    const unread = `__e2e.row('A24').querySelector('.unread')?.textContent`;
    await t.eq("A24 starts with 2 unread", unread, "2");
    await t.ev(`window.__notes.length=0; globalThis.__mockInject('wa-1:a24','Chris','ping')`);
    await t.eq("notification uses the sender and chat tag", `[window.__notes[0]?.[0], window.__notes[0]?.[1]]`, ["Chris", "wa-1:a24"]);
    await t.eq("unread of a plain chat counts up", unread, "3");
    await t.openRow("A24");
    await t.not("opening clears unread", `__e2e.row('A24')?.querySelector('.unread')`);
    await t.ok("and takes the notification off the system shade", `window.__closed.includes('wa-1:a24')`);
  }, { init: NOTIFY_INIT }),

  test("a chat read somewhere else (phone, other device) takes its notification down too", async (t) => {
    await t.open("", { settle: true });
    await t.ev(`window.__notes.length=0; window.__closed.length=0; globalThis.__mockInject('wa-1:a24','Chris','ping')`);
    await t.eq("notification shown", `window.__notes.length`, 1);
    await t.ev(`globalThis.__mockSetChat('wa-1:a24',{unread:0})`); // what a read receipt from another device looks like here
    await t.ok("the notification is closed without opening the chat", `window.__closed.includes('wa-1:a24')`);
  }, { init: NOTIFY_INIT }),

  test("mute removes the unread colour and silences notifications", async (t) => {
    await t.open("", { settle: true });
    await t.rowMenu("A24"); await t.menuItem("Mute");
    await t.ok("muted flag shown", `__e2e.row('A24').querySelector('.name svg')`);
    await t.ev(`window.__notes.length=0; globalThis.__mockInject('wa-1:a24','Chris','quiet')`);
    await t.sleep(300);
    t.expectEq("no notification for a muted chat", await t.ev(`window.__notes.length`), 0);
  }, { init: NOTIFY_INIT }),
];

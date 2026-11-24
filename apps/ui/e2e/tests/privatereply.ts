// "Reply privately" (WhatsApp): a group message is quoted in the direct chat with its sender.
import { test } from "../lib/test.ts";

const msgMenu = (t: any, txt: string) => t.contextMenu({ expr: `__e2e.msg(${JSON.stringify(txt)})` }, 500, 300);

export default [
  test("reply privately: opens the direct chat with the sender, quoting the group message; the send names the group chat", async (t) => {
    await t.open("&chat=wa-1:family");
    await t.waitFor(`__e2e.msg("Sunday lunch at 1?")`);
    await msgMenu(t, "Sunday lunch at 1?");
    await t.click(".ctxmenu button", /Reply privately/);
    await t.waitFor(`document.querySelector('main header')?.textContent.includes('Mum') && !!document.querySelector('.replybar')`, { desc: "direct chat with Mum, reply bar" });
    await t.ok("the reply bar quotes the group message", `/Sunday lunch at 1\\?/.test(document.querySelector('.replybar').textContent)`);
    await t.typeIn("yes, I'll bring dessert"); await t.enter();
    await t.waitFor(`globalThis.__lastSend?.text === "yes, I'll bring dessert"`, { desc: "sent" });
    const s = await t.ev<any>(`globalThis.__lastSend`);
    t.check("sent to the direct chat, quoting the group message from the group", s.chatId !== "wa-1:family" && s.replyToChatId === "wa-1:family" && !!s.replyToMessageId, JSON.stringify({ chatId: s.chatId, replyToChatId: s.replyToChatId, replyToMessageId: s.replyToMessageId }));
  }),
  test("reply privately is offered only in groups, for other people's messages", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.waitFor(`__e2e.msg("Are we still on for Saturday?")`);
    await msgMenu(t, "Are we still on for Saturday?");
    await t.waitSel(".ctxmenu");
    await t.not("not in a direct chat", `[...document.querySelectorAll('.ctxmenu button')].find(b=>/Reply privately/.test(b.textContent))`);
  }),
];

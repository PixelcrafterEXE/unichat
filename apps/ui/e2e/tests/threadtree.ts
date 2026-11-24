// Threads (Chat.parentId) are folded under their chat in the list: hidden until that chat (or the thread) is open.
import { test } from "../lib/test.ts";

const row = (id: string) => `document.querySelector('.chats li[data-chat=${JSON.stringify(id)}]')`;
const T = "mx-1:$thread-release", P = "mx-1:!rust-general";

export default [
  test("thread tree: a thread is not its own chat in the list; it shows indented under its chat while that chat is open", async (t) => {
    await t.open("&chat=mx-1:!rust-help");
    await t.click('[data-space="mx-1:!rust"] .pill, [data-space="mx-1:!rust"] button');
    await t.waitSel(".chats li[data-chat]");
    await t.ok("the parent is listed", `!!${row(P)}`);
    await t.ok("the thread is folded away while another chat is open", `!${row(T)}`);
    await t.click(`.chats li[data-chat="${P}"]`);
    await t.waitFor(row(T));
    await t.ok("open parent: the thread follows right under it, marked as a child", `(()=>{const p=${row(P)}, c=${row(T)}; return p.nextElementSibling===c && c.classList.contains('threadchild')})()`);
    await t.click(`.chats li[data-chat="${T}"]`);
    await t.ok("the open thread keeps its place under the parent", `(()=>{const p=${row(P)}, c=${row(T)}; return !!c && c.classList.contains('active') && p.nextElementSibling===c})()`);
    await t.ev(`(()=>{const i=document.querySelector('.chats input'); i.focus(); __e2e.setv(i,'Release')})()`);
    await t.ok("the name search finds a thread like any chat", `!!${row(T)}`);
  }),
  test("discord: an archived thread opens on the first click, says it is opening, shows its messages and sits under its channel", async (t) => {
    await t.open("&chat=dc-1:dev-talk");
    await t.waitFor(`__e2e.msg("Who wants to plan the old release?")`);
    await t.not("the archived thread is not listed yet", row("dc-1:old-plans"));
    await t.ev(`__e2e.msg("Who wants to plan the old release?").querySelector('[data-open-thread]').click()`);
    await t.waitFor(`/Opening the thread/.test(document.querySelector('.notice')?.textContent ?? '')`, { desc: "feedback while the network is asked" });
    await t.waitFor(`__e2e.msg("Then I'll do the blog post")`, { desc: "the thread's messages on the first open" });
    await t.ok("the thread is the open chat", `document.querySelector('main header')?.textContent.includes('Old release plans')`);
    await t.ok("listed under its channel, as a tree item", `(()=>{const p=${row("dc-1:dev-talk")}, c=${row("dc-1:old-plans")}; return !!c && c.classList.contains('threadchild') && p?.nextElementSibling===c})()`);
  }),
];

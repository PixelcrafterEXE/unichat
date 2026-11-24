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
];

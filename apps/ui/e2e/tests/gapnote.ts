// "N unread messages couldn't be loaded here" only when a real unread count says more arrived than the chat shows.
import { test } from "../lib/test.ts";

export default [
  test("gap note: a chat marked unread by hand opens without the 'couldn't be loaded' note", async (t) => {
    await t.open("&chat=wa-1:family");
    await t.waitSel(".messages .msg, .messages .sysmsg");
    await t.rowMenu("Ben Fischer");
    await t.menuItem(/Mark as unread/);
    await t.openRow("Ben Fischer");
    await t.waitSel(".messages .msg");
    await t.sleep(600);
    await t.not("no gap note for a hand-set mark", `document.querySelector('.gapnote')`);
  }),
];

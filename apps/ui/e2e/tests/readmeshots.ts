// Reference screenshots for the README (mock data only): run with --update-shots, the pictures land in e2e/shots/readme/.
import { test } from "../lib/test.ts";

export default [
  test("readme screenshots: desktop chat + info panel", async (t) => {
    await t.open();
    await t.tap(`__e2e.row('Weekend crew')`);
    await t.waitSel(".messages .msg");
    t.check("conversation is shown", await t.ev(`document.querySelectorAll(".messages .msg").length >= 1`));
    await t.shot("desktop");
  }),
  test("readme screenshots: phone chat list and conversation", async (t) => {
    await t.device("phone"); await t.open();
    await t.shot("phone-list");
    await t.tap(`__e2e.row('Weekend crew')`);
    await t.waitSel(".messages .msg");
    t.check("conversation is shown", await t.ev(`document.querySelectorAll(".messages .msg").length >= 1`));
    await t.shot("phone-chat");
  }),
];

// Group info panel: picture, description editor, members, a person's own name.
import { test } from "../lib/test.ts";

const FAMILY = "&chat=wa-1:family&info=1";

export default [
  test("group picture: change, shown, remove", async (t) => {
    await t.open("&chat=wa-1:family");
    await t.click('button[title*="nfo" i], button[aria-label*="nfo" i]');
    await t.waitSel(".grouppic");
    await t.eq("change/remove buttons are shown for groups", `document.querySelectorAll('.grouppic button').length`, 2);
    const before = await t.ev(`document.querySelector('.hero .avatar img')?.src ?? null`);
    await t.upload(".grouppic input[type=file]", [t.fixture("red.png")]);
    await t.ok("uploading changes the shown group picture", `(()=>{const s=document.querySelector('.hero .avatar img')?.src ?? null; return !!s && s!==${JSON.stringify(before)}})()`, { timeout: 8000 });
    await t.shot("grouppic");
    await t.click(".grouppic button", /Remove/);
    await t.eq("remove goes back to no picture", `document.querySelector('.hero .avatar img')?.src ?? null`, null);
    await t.not("no error shown", `document.querySelector('.grouppic .err')`);
  }),

  test("member avatars keep their circular grid layout", async (t) => {
    await t.open(FAMILY);
    await t.waitSel(".member .avatar");
    await t.ok("every member avatar is an inline-grid circle", `[...document.querySelectorAll('.member .avatar')].every(e=>getComputedStyle(e).display==='inline-grid')`);
    await t.shot("members");
  }),

  test("group description: edit, save, cancel", async (t) => {
    await t.open(FAMILY);
    await t.waitSel(".chatabout");
    await t.ok("current description shown", `document.querySelector('.chatabout p').textContent.includes('Sunday lunch planning')`);
    await t.click('.chatabout button[title="Edit description"]');
    await t.ok("editing shows a textarea pre-filled with the text", `document.querySelector('.chatabout textarea').value.includes('Sunday lunch planning')`);
    await t.setInput(".chatabout textarea", "Lunch every Sunday, 1pm");
    await t.shot("about_edit");
    await t.click(".chatabout .aboutbtns button", "Save");
    await t.ok("saved: the new text is shown and the editor closed", `!document.querySelector('.chatabout textarea') && document.querySelector('.chatabout p').textContent==='Lunch every Sunday, 1pm'`);
    await t.click('.chatabout button[title="Edit description"]');
    await t.setInput(".chatabout textarea", "discard me");
    await t.click(".chatabout .aboutbtns button", "Cancel");
    await t.ok("cancel keeps the old text", `!document.querySelector('.chatabout textarea') && document.querySelector('.chatabout p').textContent==='Lunch every Sunday, 1pm'`);
    await t.click('.chatabout button[title="Edit description"]');
    await t.setInput(".chatabout textarea", "");
    await t.click(".chatabout .aboutbtns button", "Save");
    await t.ok("an empty text clears it ('No description yet.')", `document.querySelector('.chatabout p.hint')?.textContent==='No description yet.'`);
  }),

  test("group description is not editable in a DM or without the capability", async (t) => {
    await t.open(FAMILY);
    await t.waitSel(".chatabout");
    await t.ok("editable on a WhatsApp group", `document.querySelector('.chatabout button[title="Edit description"]')`);
    await t.ev(`__mockSetCaps('wa-1',{chatDescription:false})`);
    await t.not("capability off: the edit button disappears (live)", `document.querySelector('.chatabout button[title="Edit description"]')`);
    await t.open("&chat=wa-1:ben&info=1");
    await t.waitSel("aside.info");
    await t.not("a DM has no description section", `document.querySelector('.chatabout')`);
  }),

  test("person: 'your own name for this person' form", async (t) => {
    await t.open(FAMILY);
    await t.click(".member .avbtn");
    await t.waitSel(".nickform");
    await t.shot("person");
    await t.ok("modal shows the person with the form", `document.querySelector('.modal .spacehero h2')?.textContent && document.querySelector('.nickform input')`);
    await t.ok("Save name is disabled while the field is empty", `document.querySelector('.nickform .nickbtns button').disabled`);
    await t.setInput(".nickform input", "Mamma");
    await t.not("typing enables Save name", `document.querySelector('.nickform .nickbtns button').disabled`);
    await t.click(".nickform .nickbtns button", "Save name");
    await t.ok("confirmation is shown", `/Saved\\. This name now shows/.test(document.querySelector('.nickform .hint')?.textContent ?? '')`);
    await t.click(".nickform .nickbtns button", "Remove my name");
    await t.ok("removing confirms too", `document.querySelector('.nickform .hint')?.textContent==='Removed.'`);
  }),
];

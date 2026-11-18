// Shared higher-level UI helpers for the tests (built on the Page primitives).
import type { Page } from "./harness.ts";

/** Chat names shown in the list (rows with a name), in order */
export const rows = (t: Page): Promise<string[]> => t.ev(`__e2e.rows()`);
/** Rail pill titles without the fixed buttons */
export const rail = (t: Page): Promise<string[]> => t.ev(`__e2e.rail()`);
/** Names of rows in the list that start with a prefix */
export const rowsStarting = (t: Page, p: string) => t.ev(`[...document.querySelectorAll('.chats li[data-chat] .name')].map(e=>e.textContent).filter(n=>n.startsWith(${JSON.stringify(p)}))`);

/** Right-click on a rail pill (its wrapper carries the context menu). */
export async function railMenu(t: Page, titlePrefix: string) {
  await t.waitFor(`document.querySelector('.rail .pill[title^=${JSON.stringify(titlePrefix)}]')`, { desc: "rail pill " + titlePrefix });
  await t.ev(`document.querySelector('.rail .pill[title^=${JSON.stringify(titlePrefix)}]').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:200}))`);
}
/** Click the (visible) menu/modal button whose text matches. */
export function btn(t: Page, re: RegExp | string) { return t.click("button", re); }

/** Context menu on a chat row of the CURRENT list (by name prefix) */
export async function chatMenu(t: Page, namePrefix: string) {
  const get = `[...document.querySelectorAll('.chats li[data-chat]')].find(e=>e.querySelector('.name').textContent.startsWith(${JSON.stringify(namePrefix)}))`;
  await t.waitFor(get, { desc: "chat row " + namePrefix });
  await t.ev(`${get}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
}
/** Move a chat (by name prefix in the current list) to a target id from the 'Move to folder' modal. */
export async function moveChatTo(t: Page, namePrefix: string, target: string) {
  await chatMenu(t, namePrefix);
  await t.click("button", /Move to folder/);
  await t.click(`.movelist button[data-target=${JSON.stringify(target)}]`);
}

/** Merge the WhatsApp and Matrix 'Anna Becker' DMs through the chat menu and wait for ONE row. */
export async function mergeAnna(t: Page) {
  await t.rowMenu("Anna Becker", 0);
  await t.menuItem("Merge with");
  await pickMergeRow(t, "Anna Becker");
  await t.clickLast(".modal button.primary");
  await t.waitFor(`__e2e.rows().filter(n=>n==='Anna Becker').length===1`, { desc: "merged Anna row" });
}
/** Open the (merged) Send via menu and pick a network. */
export async function pickVia(t: Page, name: string) {
  await t.click(".viabtn");
  await t.click(".viamenu button", name);
  await t.waitFor(`document.querySelector('.viabtn b')?.textContent.includes(${JSON.stringify(name)})`, { desc: "via " + name });
}
export const viaName = (t: Page): Promise<string | undefined> => t.ev(`document.querySelector('.viabtn b')?.textContent`);
/** + menu entries of the composer */
export async function plusItems(t: Page): Promise<string[]> {
  await t.click(".composer .tools .icon.big");
  await t.waitSel(".composer .popmenu button");
  const r = await t.ev(`[...document.querySelectorAll('.composer .popmenu button')].map(b=>b.textContent.trim())`);
  await t.click(".composer .tools .icon.big");
  await t.not("popmenu closed", `document.querySelector('.composer .popmenu')`).catch(() => {});
  t.checks.pop();
  return r;
}
/** Open Settings and one of its sections */
export async function settings(t: Page, section?: string) {
  await t.click(".pill.gear");
  await t.waitSel(".settings");
  if (!section) return;
  const bar = await t.ev(`!!document.querySelector('#settings-chapters')`); // phone: one long list, the bar jumps to a chapter
  await t.click(bar ? "#settings-chapters button" : ".settings nav button", section);
}

/** Same as moveChatTo, but addressing the chat by its id (when names are ambiguous). */
export async function moveChatIdTo(t: Page, chatId: string, target: string) {
  const get = `document.querySelector('.chats li[data-chat=${JSON.stringify(chatId)}]')`;
  await t.waitFor(get, { desc: "chat " + chatId });
  await t.ev(`${get}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
  await t.click("button", /Move to folder/);
  await t.click(`.movelist button[data-target=${JSON.stringify(target)}]`);
}

/** Tick one candidate in the merge picker by name (the list reorders once suggestions arrive, so address it by text). */
export async function pickMergeRow(t: Page, name: string) {
  await t.waitFor(`__e2e.all('.mergerow').some(r=>r.innerText.includes(${JSON.stringify(name)}))`, { desc: "merge candidate " + name });
  await t.ev(`__e2e.all('.mergerow').find(r=>r.innerText.includes(${JSON.stringify(name)})).querySelector('input').click()`);
}

/** Synthetic drag from one element to a point of another: `at` is the vertical position inside the target (0 = top edge, 0.5 = middle, 1 = bottom edge). */
export async function dragAt(t: Page, fromExpr: string, toExpr: string, at = 0.5) {
  await t.ev(`(()=>{const from=${fromExpr}, to=${toExpr}; if(!from||!to) throw new Error('drag: element missing'); const r=to.getBoundingClientRect(), y=r.top+r.height*${at}, x=r.left+r.width/2; const dt=new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart',{dataTransfer:dt,bubbles:true}));
    to.dispatchEvent(new DragEvent('dragover',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:x,clientY:y}));
    to.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true,clientX:x,clientY:y}));
    from.dispatchEvent(new DragEvent('dragend',{dataTransfer:dt,bubbles:true}));})()`);
}
/** Rail icon wrapper by space id, and a chat row by chat id (expressions for the page). */
export const spaceEl = (id: string) => `document.querySelector('.rail [data-space=${JSON.stringify(id)}]')`;
export const rowEl = (id: string) => `document.querySelector('.chats li[data-chat=${JSON.stringify(id)}]')`;
/** Click an element (expression) with modifier keys held. */
export function clickMod(t: Page, expr: string, mods: { shift?: boolean; ctrl?: boolean } = {}) {
  return t.ev(`${expr}.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,shiftKey:${!!mods.shift},ctrlKey:${!!mods.ctrl}}))`);
}
/** Look-at-it screenshot into e2e/out (git-ignored). */
export const look = (t: Page, name: string) => t.screenshot(t.fixturesDir.replace(/fixtures$/, "out") + "/" + name + ".png");

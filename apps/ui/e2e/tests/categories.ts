// User categories: the user's own headings inside a community / folder / Personal (local only; next to the provider's categories).
// Seed: Hiking Club (wa-1:hike) has the user categories "Planning" (holds Trip planning, 5 unread) and the empty "Gear ideas", and the provider heading "Official" (Announcements).
import { test } from "../lib/test.ts";
import { chatMenu, clickMod, dragAt, rowEl } from "../lib/ui.ts";
import type { Page } from "../lib/harness.ts";

const HIKE = "wa-1:hike", ANN = "wa-1:hike-ann", TRIPS = "wa-1:hike-trips";
const head = (name: string) => `document.querySelector('.chats li.cathead[data-cat=${JSON.stringify(name)}]')`;
const heads = `[...document.querySelectorAll('.chats li.cathead')].map(e=>e.dataset.cat).join('|')`;
/** Chats listed under each heading: "Heading:a,b;..." ('' = above the first heading). */
const layout = `(()=>{const o=[];let cur='';const m={'':[]};for(const e of document.querySelectorAll('.chats ul li')){if(e.classList.contains('cathead')){cur=e.dataset.cat;m[cur]=[];}else if(e.dataset.chat)m[cur].push(e.dataset.chat.split(':').slice(1).join(':'));}return Object.entries(m).filter(([k,v])=>k||v.length).map(([k,v])=>k+':'+v.join(',')).join(';')})()`;
const snapChat = (id: string) => `__mockCall('snapshot').then(s=>{const c=s.chats.find(x=>x.id===${JSON.stringify(id)});return c&&[c.category??'',c.categoryId??'',c.providerCategory??'',c.spaceId??''].join('|')})`;
const cats = (space: string) => `__mockCall('snapshot').then(s=>(s.categories[${JSON.stringify(space)}]||[]).map(c=>c.name).join('|'))`;

async function open(t: Page, space = HIKE) { await t.open(); await t.space(space); await t.waitSel(".chats li.cathead"); }
async function headMenu(t: Page, name: string) { await t.contextMenu({ expr: head(name) }); await t.waitSel(".railmenu"); }
async function modalName(t: Page, v: string) { await t.setInput(".modal input", v); }
async function pickCat(t: Page, rowId: string, target: string) {
  await t.ev(`__e2e.ctx(${rowEl(rowId)})`); await t.waitSel(".chatmenu");
  await t.click(".chatmenu button", /Move to category/); await t.click(`.movelist button[data-target=${JSON.stringify(target)}]`);
}
const planning = "cat:seed-planning";

export default [
  test("seed: user categories come first (in their order, empty ones too), then provider categories; counts and unread totals", async (t) => {
    await open(t);
    await t.eq("headings: user ones first, then the provider's", heads, "Planning|Gear ideas|Official");
    await t.eq("chats sit under their heading", layout, "Planning:hike-trips;Gear ideas:;Official:hike-ann");
    await t.ok("an empty user category shows a drop hint", `document.querySelector('[data-catempty="cat:seed-gear"]')?.textContent==='Drop chats here'`);
    await t.eq("count on the heading", `${head("Planning")}.querySelector('.catcount').textContent`, "1");
    await t.eq("unread total on the heading", `${head("Planning")}.querySelector('.unread')?.textContent`, "5");
    await t.eq("effective category name in the snapshot", snapChat(TRIPS), "Planning|cat:seed-planning||wa-1:hike");
    await t.eq("provider chat keeps its own", snapChat(ANN), "Official||Official|wa-1:hike");
    await t.shot("categories-user");
  }),

  test("create: header button, space menu, name rules, colour; empty category shows; collapse is remembered", async (t) => {
    await open(t);
    await t.click('button[data-act="new-category"][title="New category"]');
    await t.waitSel(".modal");
    await t.ok("dialog is named after the view", `document.querySelector('.modal .hint').textContent.includes('Hiking Club')`);
    await t.not("cannot save an empty name", `!document.querySelector('.modal button.primary').disabled`);
    await modalName(t, "Huts");
    await t.click('.modal [aria-label="Colour #e0a030"]');
    await t.click(".modal button.primary");
    await t.eq("new heading is last of the user ones", heads, "Planning|Gear ideas|Huts|Official");
    await t.ok("with its colour", `${head("Huts")}.querySelector('.catdot').style.background.includes('rgb(224, 160, 48)')`);
    await t.ok("and an empty hint", `document.querySelector('.catempty')`);
    // duplicate names are refused with a message
    await t.click('button[data-act="new-category"][title="New category"]'); await modalName(t, "huts"); await t.click(".modal button.primary");
    await t.ok("duplicate name is refused", `document.querySelector('.error')?.textContent.includes('already a category')`);
    // the space context menu has it too
    await t.ev(`document.querySelector('.rail .pill[title^="Hiking"]').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:200}))`);
    await t.click('.railmenu button[data-act="new-category"]'); await modalName(t, "Food"); await t.click(".modal button.primary");
    await t.ok("created from the space menu", `${head("Food")}`);
    await t.eq("stored in the backend", cats(HIKE), "Planning|Gear ideas|Huts|Food");
    await t.click(".chats li.cathead", "Huts");
    await t.reload();
    await t.space(HIKE); await t.waitSel(".chats li.cathead");
    await t.eq("collapse state of a user category survives a reload", `${head("Planning")}.getAttribute('aria-expanded')`, "true");
    await t.click(".chats li.cathead", "Planning");
    await t.reload(); await t.space(HIKE); await t.waitSel(".chats li.cathead");
    await t.eq("a collapsed user category stays collapsed", `${head("Planning")}.getAttribute('aria-expanded')`, "false");
    await t.not("its chat is hidden", rowEl(TRIPS));
    await t.eq("collapsed heading keeps the unread total", `${head("Planning")}.querySelector('.unread')?.textContent`, "5");
  }),

  test("rename, colour, move up / down, delete (chats go back to the provider category)", async (t) => {
    await open(t);
    await headMenu(t, "Gear ideas");
    await t.ok("menu offers the heading actions", `['Rename','Colour','Collapse','Move up','Delete category'].every(x=>document.querySelector('.railmenu').textContent.includes(x)) && !document.querySelector('.railmenu').textContent.includes('Move down') && !document.querySelector('.railmenu').textContent.includes('Mark category as read')`);
    await t.click(".railmenu button", "Rename");
    await modalName(t, "  Kit  "); await t.click(".modal button.primary");
    await t.eq("renamed (trimmed)", heads, "Planning|Kit|Official");
    await headMenu(t, "Kit"); await t.click(".railmenu button", "Colour");
    await t.click('.modal [aria-label="Colour #23a559"]'); await t.click(".modal button.primary");
    await t.ok("colour changed", `${head("Kit")}.querySelector('.catdot').style.background.includes('rgb(35, 165, 89)')`);
    await headMenu(t, "Kit"); await t.click(".railmenu button", "Move up");
    await t.eq("moved up", heads, "Kit|Planning|Official");
    await t.eq("order stored", cats(HIKE), "Kit|Planning");
    await headMenu(t, "Kit"); await t.click(".railmenu button", "Move down");
    await t.eq("moved down again", heads, "Planning|Kit|Official");
    // put Announcements into Kit, then delete Kit: it falls back to "Official"
    await pickCat(t, ANN, (await t.ev(`__mockCall('snapshot').then(s=>s.categories['${HIKE}'].find(c=>c.name==='Kit').id)`)) as string);
    await t.eq("Announcements moved under Kit", layout, "Planning:hike-trips;Kit:hike-ann");
    await headMenu(t, "Kit"); await t.click(".railmenu button", "Delete category");
    await t.ok("asks first and says nothing is deleted", `document.querySelector('.modal').textContent.includes('go back to their provider')`);
    await t.click(".modal .btnrow button:last-child");
    await t.eq("heading gone, chat back under Official", layout, "Planning:hike-trips;Official:hike-ann");
    await t.eq("snapshot agrees", snapChat(ANN), "Official||Official|wa-1:hike");
  }),

  test("Move to category…: single chat, No category hides the provider heading, Provider category: X resets", async (t) => {
    await open(t);
    await t.ev(`__e2e.ctx(${rowEl(ANN)})`); await t.waitSel(".chatmenu");
    await t.click(".chatmenu button", /Move to category/);
    await t.waitSel(".modal .movelist");
    await t.eq("lists the view's categories", `[...document.querySelectorAll('.movelist button')].map(b=>b.textContent.trim()).join('|')`, "No category|Planning|Gear ideas");
    await t.not("no reset while following the provider", `document.querySelector('.modal button[data-target="reset"]')`);
    await t.click('.movelist button[data-target="cat:seed-gear"]');
    await t.ok("notice", `document.querySelector('.notice')?.textContent==='Moved “Announcements” to category “Gear ideas”'`);
    await t.eq("moved under Gear ideas; Official heading is gone (no chats)", heads, "Planning|Gear ideas");
    await pickCat(t, ANN, "none");
    await t.eq("No category: the chat is on top, no heading for it", layout, ":hike-ann;Planning:hike-trips;Gear ideas:");
    await t.eq("snapshot: uncategorised but the provider's category is remembered", snapChat(ANN), "||Official|wa-1:hike");
    await t.ev(`__e2e.ctx(${rowEl(ANN)})`); await t.click(".chatmenu button", /Move to category/);
    await t.ok("reset button names the provider category", `document.querySelector('.modal button[data-target="reset"]')?.textContent.includes('Provider category: Official')`);
    await t.click('.modal button[data-target="reset"]');
    await t.eq("back under the provider heading", heads, "Planning|Gear ideas|Official");
    await t.eq("override gone", snapChat(ANN), "Official||Official|wa-1:hike");
  }),

  test("New category… from the Move dialog creates it and moves the chats", async (t) => {
    await open(t);
    await t.ev(`__e2e.ctx(${rowEl(ANN)})`); await t.click(".chatmenu button", /Move to category/);
    await t.click('.modal button[data-act="new-category"]');
    await modalName(t, "Docs"); await t.click(".modal button.primary");
    await t.eq("created and moved", layout, "Planning:hike-trips;Gear ideas:;Docs:hike-ann");
    await t.not("pick dialog closed", `document.querySelector('.movelist')`);
  }),

  test("bulk: shift/ctrl selection → Move to category… from the bar and the bulk menu", async (t) => {
    await open(t, "dc-1:g1"); // provider categories only: Text Channels / Projects
    await t.eq("no user headings in Dev yet", heads, "Text Channels|Projects");
    await t.click('button[data-act="new-category"][title="New category"]'); await modalName(t, "Mine"); await t.click(".modal button.primary");
    await t.eq("an empty user category sits before the provider ones", heads, "Mine|Text Channels|Projects");
    await clickMod(t, rowEl("dc-1:general"), { ctrl: true }); await clickMod(t, rowEl("dc-1:bugs"), { ctrl: true });
    await t.click('.selbar [data-act="sel-category"]');
    await t.ok("dialog is about both", `document.querySelector('.modal h3').textContent==='Move 2 chats to a category'`);
    await t.click('.movelist button:not([data-target="none"])');
    await t.ok("one summary notice", `document.querySelector('.notice')?.textContent==='Moved 2 chats to category “Mine”'`);
    await t.ok("both chats are under Mine", `(()=>{const l=${layout};return l.includes('Mine:')&&/Mine:[^;]*general/.test(l)&&/Mine:[^;]*bugs/.test(l)})()`);
    await t.not("selection cleared", `document.querySelector('.selbar')`);
    await t.eq("effective name is the user category, the provider one is remembered", `__mockCall('snapshot').then(s=>{const c=s.chats.find(x=>x.id==='dc-1:general');return c.category+'|'+c.providerCategory+'|'+!!c.categoryId})`, "Mine|Text Channels|true");
    // bulk context menu: back to the provider categories
    await clickMod(t, rowEl("dc-1:general"), { ctrl: true }); await clickMod(t, rowEl("dc-1:bugs"), { ctrl: true });
    await t.ev(`${rowEl("dc-1:bugs")}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
    await t.click(".railmenu button", /to category/);
    await t.ok("mixed provider categories: no single reset target", `!document.querySelector('.modal button[data-target="reset"]')`);
    await t.click('.movelist button[data-target="none"]');
    await t.eq("both uncategorised now (the provider heading is hidden for them)", snapChat("dc-1:general"), "||Text Channels|dc-1:g1");
  }),

  test("drag and drop: chats onto a heading (bulk too) and onto a row; headings reorder", async (t) => {
    await open(t);
    await dragAt(t, rowEl(ANN), head("Gear ideas"));
    await t.eq("a chat dropped on a heading moves into it", layout, "Planning:hike-trips;Gear ideas:hike-ann");
    await dragAt(t, rowEl(ANN), rowEl(TRIPS));
    await t.ok("both under Planning", `/Planning:[^;]*hike-ann/.test(${layout}) && /Planning:[^;]*hike-trips/.test(${layout})`);
    await t.ok("the empty hint is back for Gear ideas", `document.querySelector('[data-catempty="cat:seed-gear"]')`);
    // headings reorder: Gear ideas above Planning (top half of Planning)
    await dragAt(t, head("Gear ideas"), head("Planning"), 0.1);
    await t.eq("heading dragged above another", heads, "Gear ideas|Planning");
    await dragAt(t, head("Gear ideas"), head("Planning"), 0.9);
    await t.eq("…and below it", heads, "Planning|Gear ideas");
    await t.eq("order stored", cats(HIKE), "Planning|Gear ideas");
    // a provider heading is not a drop target
    await dragAt(t, rowEl(TRIPS), head("Official")).catch(() => {});
    await t.ok("dropping on a provider heading does nothing", `/Planning:[^;]*hike-trips/.test(${layout})`);
  }),

  test("moving a categorised chat to another place clears its category; categories of a deleted folder go with it", async (t) => {
    await open(t);
    await t.eq("trips is in Planning", snapChat(TRIPS), "Planning|cat:seed-planning||wa-1:hike");
    await t.ev(`__mockCall('moveChat',{chatId:'${TRIPS}',folderId:'folder:fav'})`);
    await t.eq("moved: no user category any more", snapChat(TRIPS), "||" + "|folder:fav");
    await t.ev(`__mockCall('moveChat',{chatId:'${TRIPS}',folderId:null})`);
    await t.eq("moved back: the override does not come back", snapChat(TRIPS), "|||wa-1:hike");
    // a folder with a category
    await t.ev(`(async()=>{const f=await __mockCall('createFolder',{name:'Tmp'});const c=await __mockCall('createCategory',{spaceId:f.id,name:'Inside'});await __mockCall('moveChat',{chatId:'${ANN}',folderId:f.id});await __mockCall('setChatCategory',{chatIds:['${ANN}'],categoryId:c.id});window.__tmp=f.id;})()`);
    await t.eq("category in a user folder", `__mockCall('snapshot').then(s=>(s.categories[window.__tmp]||[]).map(c=>c.name).join()+'/'+s.chats.find(c=>c.id==='${ANN}').category)`, "Inside/Inside");
    await t.ev(`__mockCall('deleteFolder',{id:window.__tmp})`);
    await t.eq("folder categories deleted, chat back home under its provider category", `__mockCall('snapshot').then(s=>JSON.stringify(s.categories[window.__tmp]||null)+'/'+s.chats.find(c=>c.id==='${ANN}').category)`, "null/Official");
    await t.eq("the override of the folder chat is gone from the stored state", `__mockCall('categories').then(c=>String('${ANN}' in c.chatCategory))`, "false");
  }),

  test("Personal view: categories for personal chats (no provider headings), mark category as read", async (t) => {
    await t.open();
    await t.pill("Personal chats");
    await t.waitSel(".chats li[data-chat]");
    await t.not("no headings yet", `document.querySelector('.chats li.cathead')`);
    await t.click('button[data-act="new-category"][title="New category"]');
    await t.ok("dialog is about Personal", `document.querySelector('.modal .hint').textContent.includes('Personal')`);
    await modalName(t, "Family & friends"); await t.click(".modal button.primary");
    await t.eq("empty heading with a hint", heads, "Family & friends"); await t.ok("hint", `document.querySelector('.catempty')`);
    await pickCat(t, "wa-1:family", (await t.ev(`__mockCall('snapshot').then(s=>s.categories.personal[0].id)`)) as string);
    await pickCat(t, "wa-1:anna", (await t.ev(`__mockCall('snapshot').then(s=>s.categories.personal[0].id)`)) as string);
    await t.ok("both chats under the heading", `/Family & friends:(anna,family|family,anna)$/.test(${layout})`);
    await t.eq("heading shows the count", `${head("Family & friends")}.querySelector('.catcount').textContent`, "2");
    await t.eq("heading shows the unread total (Anna has 2)", `${head("Family & friends")}.querySelector('.unread')?.textContent`, "2");
    await headMenu(t, "Family & friends");
    await t.click(".railmenu button", "Mark category as read");
    await t.not("unread is gone", `${head("Family & friends")}.querySelector('.unread')`);
    await t.eq("snapshot", snapChat("wa-1:family"), "Family & friends|" + (await t.ev(`__mockCall('categories').then(c=>c.chatCategory['wa-1:family'])`)) + "||");
    await headMenu(t, "Family & friends"); await t.click(".railmenu button", "Delete category"); await t.click(".modal .btnrow button:last-child");
    await t.not("deleted", `document.querySelector('.chats li.cathead')`);
    await t.ok("chats are still there", rowEl("wa-1:family"));
  }),

  test("keyboard: headings are focusable, Enter/Space collapse, the menu key opens the menu, Move to category… reachable from the row menu", async (t) => {
    await open(t);
    await t.eq("heading is a focusable button", `${head("Planning")}.getAttribute('role')+${head("Planning")}.tabIndex`, "button0");
    await t.ev(`${head("Planning")}.focus()`);
    await t.ev(`${head("Planning")}.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await t.eq("Enter collapses", `${head("Planning")}.getAttribute('aria-expanded')`, "false");
    await t.ev(`${head("Planning")}.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true}))`);
    await t.eq("Space expands", `${head("Planning")}.getAttribute('aria-expanded')`, "true");
    await t.ev(`${head("Planning")}.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true}))`);
    await t.ok("the menu key opens the heading menu", `document.querySelector('.railmenu')?.textContent.includes('Rename')`);
    await t.key("Escape");
    await t.click(`.chats li.cathead[data-cat="Planning"] button[aria-label="Category options"]`).catch(() => {});
    await chatMenu(t, "Trip planning");
    await t.ok("row menu has Move to category…", `[...document.querySelectorAll('.chatmenu button')].some(b=>b.textContent.includes('Move to category'))`);
  }),
];

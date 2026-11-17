// Multi-select in the chat list (shift+click range, ctrl+click toggle) and moving / archiving / muting / marking read together.
import { test } from "../lib/test.ts";
import { btn, clickMod, dragAt, look, mergeAnna, rowEl, spaceEl } from "../lib/ui.ts";

const DEV = "dc-1:g1";
// list order in UniChat Dev (newest first inside each category): welcome, rules | Text Channels: general, dev-talk | Projects: bugs, roadmap
const id = (n: string) => `dc-1:${n}`;
const selected = `[...document.querySelectorAll('.chats li.selected')].map(e=>e.dataset.chat.split(':')[1]).join()`;

export default [
  test("shift+click selects a range, ctrl+click toggles, plain click clears and opens, Escape clears", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await t.click('.chats li[data-chat="dc-1:rules"]');
    await t.not("a plain click selects nothing", `document.querySelector('.chats li.selected')`);
    await t.ok("…and opens the chat", `document.querySelector('main header .titlebtn')?.textContent.includes('rules')`);
    // "Text Channels" holds general and dev-talk, newest first, so the row after `rules` (across the category head) is general
    await clickMod(t, rowEl(id("general")), { shift: true });
    await t.eq("shift+click selects the range from the last clicked chat", selected, "rules,general");
    await t.eq("selection bar counts them", `document.querySelector('.selbar b').textContent`, "2 selected");
    await clickMod(t, rowEl(id("roadmap")), { ctrl: true });
    await t.eq("ctrl+click adds a single chat", selected, "rules,general,roadmap");
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await t.eq("ctrl+click again removes it", selected, "rules,roadmap");
    await look(t, "select-bar");
    await t.ok("selection bar actions", `['Move to folder','Archive','Mute'].every(x=>document.querySelector('.selbar').textContent.includes(x)) && !!document.querySelector('.selbar [aria-label="Clear selection"]')`);
    await t.key("Escape");
    await t.not("Escape clears the selection", `document.querySelector('.chats li.selected') || document.querySelector('.selbar')`);
    await clickMod(t, rowEl(id("bugs")), { shift: true });
    await t.ok("shift+click without anchor starts from the open chat", `document.querySelectorAll('.chats li.selected').length>=2`);
    await t.click('.chats li[data-chat="dc-1:general"]');
    await t.not("a plain click on another chat clears the selection", `document.querySelector('.selbar')`);
    await t.ok("and opens it", `document.querySelector('main header .titlebtn')?.textContent.includes('general')`);
  }),

  test("move the selected chats to a folder from the bar; progress/summary notice; the list updates", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await clickMod(t, rowEl(id("dev-talk")), { shift: true });
    await clickMod(t, rowEl(id("bugs")), { shift: true });
    const n = await t.ev(`document.querySelectorAll('.chats li.selected').length`);
    await t.ok("a few chats selected", `${n} >= 2`);
    await t.click('.selbar [data-act="sel-move"]');
    await t.waitSel(".modal .movelist");
    await t.ok("the dialog is about all of them", `document.querySelector('.modal h3').textContent==='Move ${n} chats'`);
    await look(t, "select-move");
    await t.click('.movelist button[data-target="folder:fav"]');
    await t.ok("one summary notice", `document.querySelector('.notice')?.textContent==='Moved ${n} chats to Favourites'`);
    await t.not("they left the list and the selection is gone", `document.querySelector('.selbar') || document.querySelector('.chats li.selected')`);
    await t.eq("all of them are in Favourites now", `__mockCall('snapshot').then(s=>s.chats.filter(c=>c.spaceId==='folder:fav' && c.id.startsWith('dc-1:')).length)`, n);
  }),

  test("right-click on a selected row acts on the whole selection (bulk menu)", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await clickMod(t, rowEl(id("bugs")), { ctrl: true });
    await t.ev(`${rowEl(id("bugs"))}.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:200,clientY:200}))`);
    await t.waitSel(".railmenu");
    await t.ok("menu is about 2 chats", `document.querySelector('.railmenu .hd').textContent==='2 chats' && document.querySelector('.railmenu').textContent.includes('Move 2 chats to folder')`);
    await btn(t, /Mute/);
    await t.ok("both are muted", `['general','bugs'].every(n=>document.querySelector('.chats li[data-chat="dc-1:'+n+'"] .unread.muted'))`);
    await t.ok("notice", `document.querySelector('.notice')?.textContent==='Muted 2 chats'`);
    await t.not("selection is done after a successful action", `document.querySelector('.selbar')`);
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await clickMod(t, rowEl(id("bugs")), { ctrl: true });
    await t.click('.selbar [data-act="sel-read"]');
    await t.not("mark as read clears their unread badges", `document.querySelector('.chats li[data-chat="dc-1:general"] .unread') || document.querySelector('.chats li[data-chat="dc-1:bugs"] .unread')`);
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await clickMod(t, rowEl(id("bugs")), { ctrl: true });
    await t.click('.selbar [data-act="sel-archive"]');
    await t.not("archive hides them (archived chats are hidden by default)", `document.querySelector('.chats li[data-chat="dc-1:general"]') || document.querySelector('.chats li[data-chat="dc-1:bugs"]')`);
    await t.ok("the archive button in the rail offers to show archived items", `!!document.querySelector('.pill[title^="Show archived"]')`);
  }),

  test("dragging one of several selected chats drags all of them onto a rail icon", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await clickMod(t, rowEl(id("roadmap")), { ctrl: true });
    await clickMod(t, rowEl(id("welcome")), { ctrl: true });
    await dragAt(t, rowEl(id("roadmap")), spaceEl("home"));
    await t.ok("notice names the count", `document.querySelector('.notice')?.textContent==='Moved 3 chats to Personal'`);
    await t.eq("all three are Personal chats now", `__mockCall('snapshot').then(s=>s.chats.filter(c=>c.id.startsWith('dc-1:') && !c.spaceId).map(c=>c.id.split(':')[1]).sort().join())`, "general,roadmap,welcome");
    // dragging an UNselected row moves only that row
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await dragAt(t, rowEl(id("bugs")), spaceEl("folder:fav"));
    await t.eq("a single drag moves one chat", `__mockCall('snapshot').then(s=>s.chats.filter(c=>c.spaceId==='folder:fav' && c.id.startsWith('dc-1:')).map(c=>c.id).join())`, id("bugs"));
  }),

  test("a failed move is summarised, only the failed chats stay selected", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await t.ev(`window.__failMoves = new Set(['dc-1:general'])`);
    await clickMod(t, rowEl(id("dev-talk")), { shift: true });
    await clickMod(t, rowEl(id("general")), { ctrl: true });
    await t.click('.selbar [data-act="sel-move"]');
    await t.click('.movelist button[data-target="folder:fav"]');
    await t.waitSel(".error");
    await t.ok("error summary says how many failed and which", `(()=>{const e=document.querySelector('.error').textContent; return /1 of 2 done, 1 failed/.test(e) && e.includes('general') && e.includes('Simulated failure')})()`);
    await t.eq("only the failed chat stays selected", selected, "general");
    await look(t, "select-failure");
  }),

  test("merged chats move as their merged row", async (t) => {
    await t.open();
    await mergeAnna(t);
    await t.ev(`__e2e.row("Anna Becker").dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
    await t.ev(`__e2e.row("Ben Fischer").dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))`);
    await t.eq("two rows selected (the merged row counts once)", `document.querySelector('.selbar b').textContent`, "2 selected");
    await t.click('.selbar [data-act="sel-move"]');
    await t.click('.movelist button[data-target="folder:fav"]');
    await t.ok("both moved", `document.querySelector('.notice')?.textContent==='Moved 2 chats to Favourites'`);
    await t.space("folder:fav");
    await t.ok("the merged chat is one row in the folder", `__e2e.rows().filter(n=>n==='Anna Becker').length===1 && __e2e.rows().includes('Ben Fischer')`);
  }),

  test("selected rows are highlighted and the bar fits a narrow list (screenshot)", async (t) => {
    await t.open();
    await t.space(DEV);
    await t.waitSel(".chats li.cathead");
    await clickMod(t, rowEl(id("welcome")), { shift: true });
    await clickMod(t, rowEl(id("roadmap")), { shift: true });
    await t.ok("all six rows selected", `document.querySelectorAll('.chats li.selected').length===6`);
    await t.ok("selected rows carry a visible bar (non-transparent background)", `getComputedStyle(document.querySelector('.chats li.selected')).backgroundColor !== 'rgba(0, 0, 0, 0)'`);
    await look(t, "select-highlight");
  }),
];

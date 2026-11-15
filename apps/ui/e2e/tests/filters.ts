// Chat list filters (Unread / Messenger / Type / Online) and presence (green dot, "online" / "last seen" text).
// Mock seed (Personal view): unread: wa anna(2) mx anna(1) a24(2) ig alice(1) (+ mallory request); online: wa anna, dc-2 dana (mx bea sits in the Favourites folder); wa ben last seen 2 h ago.
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";

const ids = `[...document.querySelectorAll('.chats li[data-chat]')].map(e=>e.dataset.chat).sort().join(',')`;
const idsOf = (...l: string[]) => l.sort().join(",");
const bar = (f: string) => `document.querySelector('.cfilters [data-filter="${f}"]')`;
const clickF = (t: Page, f: string) => t.ev(`${bar(f)}.click()`);
async function pickMenu(t: Page, f: "messenger" | "kind", item: string) {
  await clickF(t, f); await t.waitSel(`.cfmenu[data-menu="${f}"]`);
  await t.ev(`document.querySelector('.cfmenu button[${f === "kind" ? "data-kind" : "data-account"}="${item}"]').click()`);
}
const stored = `(()=>{try{return JSON.parse(localStorage.getItem('unimsg.settings')).chatFilters}catch(e){return null}})()`;
const CH = ["dc-2:general", "mx-1:!old-gen", "wa-1:neigh-ann"]; // single-chat communities are collapsed into Personal
const personalAll = ["wa-1:anna", "wa-1:ben", "mx-1:@anna:matrix.org", "wa-1:a24", "wa-1:family", "mesh:1", "dc-2:dana", "dc-2:gdm", "ig-1:alice", "ig-1:mallory", "ig-1:crew", ...CH];

// a tall window so the windowed list renders every row
async function open(t: Page, extra = "") { await t.open(extra); await t.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 2600, deviceScaleFactor: 1, mobile: false }); await t.waitSel(".cfilters"); }

export default [
  test("filter bar: compact single row above the list; no filters = nothing hidden; Online shown only with presence", async (t) => {
    await open(t);
    await t.ok("bar is there", `document.querySelector('.cfilters')`);
    await t.ok("height stays small (at most two rows)", `document.querySelector('.cfilters').getBoundingClientRect().height<=76`);
    await t.eq("all personal chats listed", ids, idsOf(...personalAll));
    await t.ok("Online filter shown (mock accounts support presence)", bar("online"));
    await t.not("no clear button without active filters", bar("clear"));
    await t.ev(`['wa-1','mx-1','dc-2'].forEach(a=>__mockSetCaps(a,{presence:false}))`);
    await t.not("Online hidden when no connected account supports presence", bar("online"));
    await t.ev(`__mockSetCaps('mx-1',{presence:true})`);
    await t.ok("Online back when one does", bar("online"));
    await t.shot("filters-bar");
  }),

  test("filter bar: tags never overflow the bar, they wrap on a narrow screen", async (t) => {
    await t.open("");
    for (const w of [320, 360, 420]) {
      await t.send("Emulation.setDeviceMetricsOverride", { width: w, height: 800, deviceScaleFactor: 1, mobile: true });
      await t.waitSel(".cfilters");
      await t.ok(`all tags inside the bar at ${w}px`, `(()=>{const b=document.querySelector('.cfilters').getBoundingClientRect(); return [...document.querySelectorAll('.cfilters > *')].every(e=>{const r=e.getBoundingClientRect(); return r.left>=b.left-1&&r.right<=b.right+1})})()`);
      await t.ok(`no horizontal scroll at ${w}px`, `document.documentElement.scrollWidth<=innerWidth+1`);
    }
  }),
  test("right-click: Mark as unread on a read chat shows a dot, counts for Unread, and opening the chat clears it", async (t) => {
    await open(t);
    const row = `document.querySelector('.chats li[data-chat="wa-1:ben"]')`;
    await t.ok("ben is read", `${row} && !${row}.querySelector('.unread, .unreaddot')`);
    await t.ev(`__e2e.ctx(${row})`);
    await t.waitSel(".chatmenu"); await t.waitSel('.chatmenu [data-act="mark-unread"]');
    await t.ev(`document.querySelector('.chatmenu [data-act="mark-unread"]').click()`);
    await t.waitSel('.chats li[data-chat="wa-1:ben"] .unreaddot');
    await t.ok("dot shown", `!!${row}.querySelector('.unreaddot')`);
    await t.ev(`__e2e.ctx(${row})`);
    await t.ok("menu now offers Mark as read", `!!document.querySelector('.chatmenu [data-act="mark-read"]')`);
    await t.ev(`document.querySelector('.chatmenu [data-act="mark-read"]').click()`);
    await t.ok("mark as read clears the dot", `!${row}.querySelector('.unreaddot')`);
  }),
  test("sidebar media: thumbnails come from the whole chat and clicking one scrolls to its message", async (t) => {
    await open(t);
    await t.openChat("wa-1:anna");
    await t.ev(`document.querySelector('button.icon[title="Chat info"]').click()`);
    await t.waitSel(".thumbs .thumb");
    await t.ok("thumbnails offer to show the message", `document.querySelectorAll('.thumbs .thumb[data-jump]').length>0`);
    const mid = await t.ev(`document.querySelector('.thumbs .thumb[data-jump]').dataset.jump`);
    await t.ev(`document.querySelector('.thumbs .thumb[data-jump]').click()`);
    await t.waitFor(`(()=>{const e=document.querySelector('[data-mid="${mid}"]'); if(!e) return false; const r=e.getBoundingClientRect(), b=document.querySelector('.messages, .msglist, main').getBoundingClientRect(); return r.bottom>b.top && r.top<b.bottom})()`, { desc: "message scrolled into view" });
    await t.ok("the message is on screen", `!!document.querySelector('[data-mid="${mid}"]')`);
  }),
  test("browser notification: clicking it opens the chat of the message", async (t) => {
    await t.open();
    await t.ev(`localStorage.setItem('unimsg.settings', JSON.stringify({notifications:true,notifyContent:'full'}))`);
    await t.open();
    await t.ev(`window.__notes=[]; window.Notification = class { constructor(title, o){ this.title=title; this.o=o; window.__notes.push(this); } close(){} static get permission(){return 'granted'} static requestPermission(){return Promise.resolve('granted')} }`);
    await t.waitSel('.chats li[data-chat="wa-1:family"]');
    await t.ok("family is not the open chat", `!document.querySelector('.chats li[data-chat="wa-1:family"].active')`);
    await t.ev(`window.__mockInject('wa-1:family', 'Someone', 'ping from the notification test')`);
    await t.waitFor(`window.__notes.length>0`, { desc: "a notification was shown" });
    await t.ev(`window.__notes[0].onclick && window.__notes[0].onclick()`);
    await t.waitFor(`!!document.querySelector('.chats li[data-chat="wa-1:family"].active')`, { desc: "chat opened by the click" });
    await t.ok("the notification's chat is open", `!!document.querySelector('.chats li[data-chat="wa-1:family"].active')`);
  }),
  test("sidebar media still works against an older backend without chatMedia (falls back to paging history)", async (t) => {
    await t.open();
    await t.ev(`window.__mockNoChatMedia = true`);
    await t.openChat("wa-1:anna");
    await t.ev(`document.querySelector('button.icon[title="Chat info"]').click()`);
    await t.waitSel(".thumbs .thumb[data-jump]");
    await t.ok("thumbnails are listed", `document.querySelectorAll('.thumbs .thumb[data-jump]').length>0`);
  }),
  test("loading state: a skeleton instead of 'No chats' until the first chat list has arrived", async (t) => {
    await t.send("Page.navigate", { url: t.base + "/?mock&slowlist" });
    await t.waitFor(`!!document.querySelector('[data-loading="chats"]')`, { timeout: 10000, desc: "loading skeleton" });
    await t.ok("a loading state is shown", `!!document.querySelector('.loadingchats .skelrow') && /Loading your chats/.test(document.querySelector('.loadingchats').textContent)`);
    await t.not("no misleading 'No chats yet' / 'No accounts yet' while loading", `/No chats yet|No accounts yet/.test(document.querySelector('.chats').textContent)`);
    await t.not("no 'Add an account to get started' in the main area while loading", `/Add an account to get started/.test(document.querySelector('main').textContent)`);
    await t.waitFor(`!document.querySelector('[data-loading="chats"]') && document.querySelectorAll('.chats li[data-chat]').length>3`, { timeout: 15000, desc: "the real list replaces the skeleton" });
  }),
  test("backend not answering: loading state, 'Still starting…' after a while, never 'No accounts yet'; recovers by retrying", async (t) => {
    await t.initScript(`window.__slowStartMs = 700`);
    await t.send("Page.navigate", { url: t.base + "/?mock&failsnap=3" });
    await t.waitFor(`!!document.querySelector('[data-loading="chats"]')`, { timeout: 10000, desc: "loading skeleton" });
    await t.waitFor(`/Still starting/.test(document.querySelector('.loadingchats')?.textContent ?? '')`, { timeout: 5000, desc: "Still starting hint" });
    await t.not("no 'No accounts yet' / 'Add your first account' while the backend has not answered", `/No accounts yet|Add your first account|No chats/.test(document.querySelector('.chats').textContent)`);
    await t.not("no 'Add an account to get started' in the main area", `/Add an account to get started/.test(document.querySelector('main').textContent)`);
    await t.waitFor(`!document.querySelector('[data-loading="chats"]') && document.querySelectorAll('.chats li[data-chat]').length>3`, { timeout: 20000, desc: "the list appears once the backend answers (retry with backoff)" });
    await t.not("the hint is gone", `/Still starting/.test(document.body.textContent)`);
  }),
  test("Unread: only chats with unread messages; muted ones only with '+ muted'", async (t) => {
    await open(t);
    await clickF(t, "unread");
    await t.eq("unread chats", ids, idsOf("wa-1:anna", "mx-1:@anna:matrix.org", "wa-1:a24", "ig-1:alice", "ig-1:mallory"));
    await t.ev(`__mockCall('setChatFlags',{chatId:'wa-1:a24',muted:true})`);
    await t.eq("muted unread chat is excluded", ids, idsOf("wa-1:anna", "mx-1:@anna:matrix.org", "ig-1:alice", "ig-1:mallory"));
    await clickF(t, "unread-muted");
    await t.eq("...and back with '+ muted'", ids, idsOf("wa-1:anna", "mx-1:@anna:matrix.org", "wa-1:a24", "ig-1:alice", "ig-1:mallory"));
    await t.eq("badge shows one active filter", `document.querySelector('.cfilters .cfbadge').textContent`, "1");
  }),

  test("Messenger: multi-select of accounts with icons; filter by one, then two", async (t) => {
    await open(t);
    await clickF(t, "messenger");
    await t.ok("one entry per account, each with an icon", `document.querySelectorAll('.cfmenu[data-menu="messenger"] button').length>=5 && [...document.querySelectorAll('.cfmenu[data-menu="messenger"] button')].every(b=>b.querySelector('svg,img,span'))`);
    await t.ev(`document.querySelector('.cfmenu button[data-account="mx-1"]').click()`);
    await t.eq("Matrix chats only (Personal view)", ids, idsOf("mx-1:@anna:matrix.org", "mx-1:!old-gen"));
    await t.ev(`document.querySelector('.cfmenu button[data-account="ig-1"]').click()`);
    await t.eq("Matrix + Instagram", ids, idsOf("mx-1:@anna:matrix.org", "mx-1:!old-gen", "ig-1:alice", "ig-1:mallory", "ig-1:crew"));
    await t.ev(`document.querySelector('.cfmenu button[data-account="mx-1"]').click()`);
    await t.eq("Instagram only after toggling Matrix off", ids, idsOf("ig-1:alice", "ig-1:mallory", "ig-1:crew"));
    await t.key("Escape");
    await t.not("menu closes with Escape", `document.querySelector('.cfmenu')`);
  }),

  test("Type: personal / groups / community channels; channels live in communities", async (t) => {
    await open(t);
    await pickMenu(t, "kind", "dm");
    await t.eq("personal chats only", ids, idsOf("wa-1:anna", "wa-1:ben", "mx-1:@anna:matrix.org", "dc-2:dana", "ig-1:alice", "ig-1:mallory"));
    await pickMenu(t, "kind", "group");
    await t.eq("groups only", ids, idsOf("wa-1:a24", "wa-1:family", "mesh:1", "dc-2:gdm", "ig-1:crew"));
    await pickMenu(t, "kind", "channel");
    await t.eq("only the collapsed single-chat communities' channels in Personal", ids, idsOf(...CH));
    await pickMenu(t, "messenger", "ig-1");
    await t.ok("empty state offers to clear", `document.querySelector('[data-empty="filters"]')`);
    await t.ev(`document.querySelector('[data-act="clear-filters"]').click()`);
    await t.eq("clear from the empty state", ids, idsOf(...personalAll));
    await pickMenu(t, "kind", "channel");
    await t.space("wa-1:hike");
    await t.eq("channels of a community are listed there", ids, idsOf("wa-1:hike-ann", "wa-1:hike-trips"));
    await pickMenu(t, "kind", "dm");
    await t.eq("a personal-chat filter empties a community view", ids, "");
    await t.ok("rail icons without matches are dimmed", `document.querySelector('.rail .pill[title^="Hiking"]').classList.contains('nomatch')`);
    await t.ok("...the Personal icon is not", `!document.querySelector('.rail .pill[title="Personal chats"]').classList.contains('nomatch')`);
    await pickMenu(t, "kind", "all");
    await t.eq("All = back to everything in the community", ids, idsOf("wa-1:hike-ann", "wa-1:hike-trips"));
  }),

  test("Online: only personal chats whose contact is online; live presence updates", async (t) => {
    await open(t);
    await clickF(t, "online");
    await t.eq("online contacts", ids, idsOf("wa-1:anna", "dc-2:dana"));
    await t.ev(`__mockPresence('wa-1:ben', true)`);
    await t.eq("Ben comes online -> appears", ids, idsOf("wa-1:anna", "wa-1:ben", "dc-2:dana"));
    await t.ev(`__mockPresence('wa-1:anna', false, new Date().toISOString())`);
    await t.eq("Anna goes offline -> disappears", ids, idsOf("wa-1:ben", "dc-2:dana"));
  }),

  test("filters combine (AND), clear in one click, search stays independent", async (t) => {
    await open(t);
    await clickF(t, "unread"); await pickMenu(t, "kind", "dm");
    await t.eq("unread AND personal", ids, idsOf("wa-1:anna", "mx-1:@anna:matrix.org", "ig-1:alice", "ig-1:mallory"));
    await pickMenu(t, "messenger", "mx-1");
    await t.eq("+ Matrix", ids, idsOf("mx-1:@anna:matrix.org"));
    await clickF(t, "online");
    await t.eq("+ online: nothing", ids, "");
    await t.eq("badge counts 4", `document.querySelector('.cfilters .cfbadge').textContent`, "4");
    // search ignores the filters
    await t.setInput(".chatsearch input", "Ben");
    await t.eq("search finds Ben although the filters would hide him", ids, idsOf("wa-1:ben"));
    await t.setInput(".chatsearch input", "");
    await t.ev(`${bar("clear")}.click()`);
    await t.eq("one click clears everything", ids, idsOf(...personalAll));
    await t.not("badge gone", bar("clear"));
    await t.eq("stored state is cleared too", `JSON.stringify(${stored})`, JSON.stringify({ unread: false, unreadMuted: false, accounts: [], kind: "all", online: false }));
  }),

  test("filters apply in folders too (Favourites: Bea online, Carl unread) and dim empty rail icons", async (t) => {
    await open(t);
    await t.space("folder:fav");
    await t.eq("folder list", ids, idsOf("mx-1:@bea:matrix.org", "mx-1:@carl:matrix.org", "wa-1:trail"));
    await clickF(t, "online");
    await t.eq("online in the folder", ids, idsOf("mx-1:@bea:matrix.org"));
    await t.ok("a presence dot in the folder row", `document.querySelector('[data-chat="mx-1:@bea:matrix.org"] .onlinedot')`);
    await clickF(t, "online"); await clickF(t, "unread");
    await t.eq("unread in the folder", ids, idsOf("mx-1:@carl:matrix.org"));
    await t.ok("communities with an unread chat are not dimmed", `!document.querySelector('.rail .pill[title^="Hiking"]').classList.contains('nomatch')`);
  }),

  test("filters persist across reload (settings)", async (t) => {
    await open(t);
    await clickF(t, "unread"); await pickMenu(t, "kind", "group");
    await t.eq("stored", `${stored}.unread+'|'+${stored}.kind`, "true|group");
    await t.reload();
    await t.eq("still filtered after reload", ids, idsOf("wa-1:a24"));
    await t.ok("buttons show the state", `${bar("unread")}.getAttribute('aria-pressed')==='true' && ${bar("kind")}.classList.contains('on')`);
  }),

  test("merged chat passes Messenger / Online filters through its members", async (t) => {
    await open(t);
    await t.rowMenu("Anna Becker", 0); await t.menuItem("Merge with");
    await t.click(".modal .rowbtn, .modal label", /Anna Becker/);
    await t.clickLast(".modal button.primary");
    await t.waitFor(`__e2e.rows().filter(n=>n==='Anna Becker').length===1`, { desc: "merged row" });
    await pickMenu(t, "messenger", "mx-1");
    await t.ok("merged row is in the Matrix filter (one member is Matrix)", `__e2e.rows().includes('Anna Becker')`);
    await clickF(t, "online");
    await t.ok("and online (WhatsApp member is online)", `__e2e.rows().includes('Anna Becker')`);
    await t.ok("the merged row has a presence dot", `!!document.querySelector('.chats li[data-chat^="merge:"] .onlinedot')`);
  }),

  test("online dot on avatars: chat list, header, member list; text in header and contact panel", async (t) => {
    await open(t);
    await t.eq("dots in the list", `[...document.querySelectorAll('.chats li[data-chat] .onlinedot')].map(e=>e.closest('li').dataset.chat).sort().join(',')`, idsOf("wa-1:anna", "dc-2:dana"));
    await t.not("no dot on groups or offline contacts", `document.querySelector('[data-chat="wa-1:ben"] .onlinedot, [data-chat="wa-1:a24"] .onlinedot')`);
    await t.openChat("wa-1:anna");
    await t.ok("dot in the header", `document.querySelector('main header .titlebtn .onlinedot')`);
    await t.eq("header says online", `document.querySelector('main header .hpresence')?.textContent`, "online");
    await t.click('button[title="Chat info"]');
    await t.ok("contact panel shows online + dot", `document.querySelector('aside.info .presence')?.textContent==='online' && document.querySelector('aside.info .hero .onlinedot')`);
    await t.openChat("wa-1:ben");
    await t.ok("offline contact: last seen text, no dot", `/^last seen /.test(document.querySelector('main header .hpresence')?.textContent||'') && !document.querySelector('main header .titlebtn .onlinedot')`);
    await t.ok("contact panel shows last seen", `/^last seen /.test(document.querySelector('aside.info .presence')?.textContent||'')`);
    await t.openChat("wa-1:family");
    await t.ok("group header has no presence text", `!document.querySelector('main header .hpresence')`);
    await t.ok("group member list: online member dot + text", `document.querySelectorAll('aside.info .member .onlinedot').length>=1 && [...document.querySelectorAll('aside.info .member .presence')].some(e=>e.textContent==='online')`);
    await t.shot("presence");
  }),

  test("Settings > Privacy 'Show who is online' hides every dot and the text, and the Online filter's results", async (t) => {
    await open(t);
    await t.ok("dots at first", `document.querySelector('.onlinedot')`);
    await t.ev(`__mockCall('setSetting',{key:'showPresence',value:false})`);
    await t.waitGone(`document.querySelector('.chats .onlinedot')`);
    await t.eq("online filter finds nobody", `(async()=>{const s=await __mockCall('snapshot');return s.chats.filter(c=>c.online!==undefined).length})()`, 0);
    await t.ev(`__mockCall('setSetting',{key:'showPresence',value:true})`);
    await t.ok("back on", `document.querySelector('.chats .onlinedot')`);
    // the settings page toggle
    await t.open("&settings=1"); await t.click(".settingsnav button, nav button", /Privacy/);
    await t.ok("toggle is on by default", `document.querySelector('#showPresence')?.checked===true`);
    await t.ev(`document.querySelector('#showPresence').click()`);
    await t.eq("stored in the backend", `__mockCall('getSettings').then(s=>s.showPresence)`, false);
  }),

  test("phone width: filter bar fits, menus usable, no horizontal scroll", async (t) => {
    await open(t);
    await t.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
    await t.waitSel(".cfilters");
    await t.ok("bar fits the width", `(()=>{const r=document.querySelector('.cfilters').getBoundingClientRect();return r.right<=392&&r.height<=100&&document.documentElement.scrollWidth<=392})()`);
    await t.ok("chips are labelled and at least 34px tall (touch)", `[...document.querySelectorAll('.cfilters .cf:not(.sub):not(.clear)')].every(b=>b.getBoundingClientRect().height>=34&&b.textContent.trim().length>0)`);
    await t.ok("all four filters reachable", `['unread','messenger','kind','online'].every(f=>document.querySelector('.cfilters [data-filter="'+f+'"]'))`);
    await pickMenu(t, "kind", "group");
    await t.ok("active filter shows its label and the clear badge", `${bar("kind")}.textContent.includes('Groups') && ${bar("clear")}`);
    await t.eq("list filtered", ids, idsOf("wa-1:a24", "wa-1:family", "mesh:1", "dc-2:gdm", "ig-1:crew"));
    await t.ok("still no horizontal scroll", `document.documentElement.scrollWidth<=392`);
    await t.shot("filters-phone");
  }),
];

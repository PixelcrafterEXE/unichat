// Rail groups: drop an icon onto the middle of another to group them (like Discord folders), expand/collapse, rename/colour, remove, ungroup, edges reorder.
import { test } from "../lib/test.ts";
import { btn, dragAt, look, rowEl, spaceEl, railMenu } from "../lib/ui.ts";

const HIKE = "wa-1:hike", RUST = "mx-1:!rust", SELF = "mx-1:!self", DEV = "dc-1:g1", FRIENDS = "folder:fav";
const groups = (t: any) => t.ev(`__mockCall('railGroups')`);

export default [
  test("dropping a community onto the middle of another creates a group; click expands/collapses; badge is the sum", async (t) => {
    await t.open("", { settle: true });
    await t.waitSel(`.rail [data-space="${HIKE}"]`);
    const badge = (id: string) => `Number(document.querySelector('.rail [data-space="${id}"] .pbadge')?.textContent||0)`;
    const before = await t.ev(`${badge(HIKE)}+${badge(DEV)}`);
    await t.ok("both have unread to sum", `${before} > 0`);
    await dragAt(t, spaceEl(DEV), spaceEl(HIKE), 0.5);
    await t.waitSel(".rail .railgroup");
    await t.eq("one group with the two members, created open", `[...document.querySelectorAll('.railgroup .gmembers [data-space]')].map(e=>e.dataset.space).join()`, `${HIKE},${DEV}`);
    await look(t, "railgroup-open");
    await t.eq("stored in the backend (railGroups)", `__mockCall('railGroups').then(g=>JSON.stringify(g.map(x=>x.members)))`, JSON.stringify([[HIKE, DEV]]));
    await t.eq("group badge = sum of its members' unread", `Number(document.querySelector('.railgroup .grouphead')?.parentElement.querySelector('.pbadge')?.textContent||0)`, before);
    await t.click('.railgroup .pill.grouphead');
    await t.not("click collapses: members leave the rail", `document.querySelector('.rail [data-space="${HIKE}"]')`);
    await t.eq("collapsed tile shows mini icons of the members", `document.querySelectorAll('.railgroup .gtile .gmini').length`, 2);
    await t.eq("still shows the summed badge", `Number(document.querySelector('.railgroup .pbadge')?.textContent||0)`, before);
    await look(t, "railgroup-collapsed");
    await t.click('.railgroup .pill.grouphead');
    await t.ok("click expands again", `document.querySelector('.rail [data-space="${HIKE}"]') && document.querySelector('.railgroup.open')`);
    await t.click(`.rail [data-space="${HIKE}"] .pill`);
    await t.ok("a member still opens its chat list", `document.querySelector('.chats header span').textContent.startsWith('Hiking')`);
  }),

  test("group badge follows the muted rule of its members", async (t) => {
    await t.open("", { settle: true });
    await dragAt(t, spaceEl(DEV), spaceEl(HIKE), 0.5);
    await t.waitSel(".rail .railgroup");
    const sum = `[...document.querySelectorAll('.railgroup .gmembers .pbadge')].reduce((n,e)=>n+Number(e.textContent),0)`;
    const grp = `Number(document.querySelector('.railgroup .pill.grouphead').parentElement.querySelector('.pbadge')?.textContent||0)`;
    await t.eq("sum before", grp, await t.ev(sum));
    await railMenu(t, "UniChat Dev");
    await btn(t, /Mute community/);
    await t.eq("muted community no longer counts in the group", `${grp}===${sum} && ${grp} < 6 + 5`, true);
    await t.not("no member badge for the muted one", `document.querySelector('.rail [data-space="${DEV}"] .pbadge')`);
  }),

  test("rename / colour a group, remove a member, ungroup (right-click menu)", async (t) => {
    await t.open();
    await dragAt(t, spaceEl(RUST), spaceEl(HIKE), 0.5);
    await t.waitSel(".rail .railgroup");
    await dragAt(t, spaceEl(SELF), `document.querySelector('.rail .pill.grouphead').parentElement`, 0.5); // onto the header: joins
    await t.eq("a third icon joins by dropping on the group header", `document.querySelectorAll('.railgroup .gmembers [data-space]').length`, 3);
    await t.ev(`document.querySelector('.rail .pill.grouphead').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:200}))`);
    await t.waitSel(".railmenu");
    await t.ok("group menu offers rename/colour, collapse, ungroup", `['Rename / Colour group','Collapse group','Ungroup'].every(x=>document.querySelector('.railmenu').textContent.includes(x))`);
    await btn(t, /Rename \/ Colour group/);
    await t.waitSel(".modal .swatches");
    await t.setInput('.modal input', "Work stuff");
    await t.click('.modal .swatch[aria-label="Colour #eb459e"]');
    await t.click(".modal button.primary");
    await t.ok("renamed", `document.querySelector('.rail .pill.grouphead').title.startsWith('Work stuff')`);
    await t.eq("colour stored", `__mockCall('railGroups').then(g=>g[0].name+' '+g[0].color)`, "Work stuff #eb459e");
    await look(t, "railgroup-renamed");
    await railMenu(t, "Rust");
    await btn(t, /Remove from group/);
    await t.not("member left the group", `document.querySelector('.railgroup [data-space="${RUST}"]')`);
    await t.ok("…and is a normal rail icon again", `document.querySelector('.rail [data-space="${RUST}"]') && !document.querySelector('.railgroup [data-space="${RUST}"]')`);
    await t.eq("group keeps the other two", `document.querySelectorAll('.railgroup .gmembers [data-space]').length`, 2);
    await t.ev(`document.querySelector('.rail .pill.grouphead').parentElement.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:200}))`);
    await btn(t, /Ungroup/);
    await t.not("ungroup dissolves the group", `document.querySelector('.railgroup')`);
    await t.ok("the members are plain icons again", `document.querySelector('.rail [data-space="${HIKE}"]') && document.querySelector('.rail [data-space="${SELF}"]')`);
    await t.eq("backend has no groups", `__mockCall('railGroups').then(g=>g.length)`, 0);
  }),

  test("drag in and out of groups; edges still reorder", async (t) => {
    await t.open();
    await dragAt(t, spaceEl(RUST), spaceEl(HIKE), 0.5);
    await t.waitSel(".rail .railgroup");
    await dragAt(t, spaceEl(SELF), spaceEl(RUST), 0.5); // onto a MEMBER's middle: joins that group
    await t.eq("dropping on a member joins its group", `document.querySelectorAll('.railgroup .gmembers [data-space]').length`, 3);
    // edge of a plain icon outside the group: the dragged member leaves the group
    await dragAt(t, spaceEl(SELF), spaceEl(FRIENDS), 0.05);
    await t.not("dragged out of the group", `document.querySelector('.railgroup [data-space="${SELF}"]')`);
    await t.ok("and sits right before Favourites", `(()=>{const ids=[...document.querySelectorAll('.rail [data-space]')].map(e=>e.dataset.space); return ids.indexOf("${SELF}")===ids.indexOf("${FRIENDS}")-1})()`);
    // edge of a member: reorder inside the group
    const order = () => t.ev(`[...document.querySelectorAll('.railgroup .gmembers [data-space]')].map(e=>e.dataset.space).join()`);
    const o0 = await order();
    await dragAt(t, spaceEl(HIKE), spaceEl(RUST), 0.95);
    await t.ok("dropping on a member's bottom edge reorders inside the group", `__e2e && document.querySelector('.railgroup .gmembers [data-space]').dataset.space === "${RUST}"`);
    await t.ok("order changed", `${JSON.stringify(o0)} !== ${JSON.stringify(await order())}`);
    // plain reorder of two top-level icons still works
    await dragAt(t, spaceEl(FRIENDS), spaceEl(DEV), 0.05);
    await t.ok("two plain icons: edge drop reorders, no group created", `(()=>{const ids=[...document.querySelectorAll('.rail [data-space]')].map(e=>e.dataset.space); return ids.indexOf("${FRIENDS}")===ids.indexOf("${DEV}")-1})() && document.querySelectorAll('.railgroup').length===1`);
    // dragging a whole group (by its header) moves it as a block
    await dragAt(t, `document.querySelector('.rail .pill.grouphead').parentElement`, spaceEl(FRIENDS), 0.95);
    await t.ok("the group moved after Favourites", `(()=>{const ids=[...document.querySelectorAll('.rail [data-space]')].map(e=>e.dataset.space); return ids.indexOf("${FRIENDS}")<ids.indexOf("${HIKE}")})()`);
  }),

  test("keyboard alternative: Add to group… (existing group / new group with…) and Move up/down inside a group", async (t) => {
    await t.open();
    await railMenu(t, "Self-Hosters");
    await btn(t, /Add to group/);
    await t.waitSel(".modal [data-with]");
    await t.click(`.modal [data-with="${RUST}"]`);
    await t.waitSel(".rail .railgroup");
    await t.eq("new group made of the two", `document.querySelectorAll('.railgroup .gmembers [data-space]').length`, 2);
    await railMenu(t, "UniChat Dev");
    await btn(t, /Add to group/);
    await t.waitSel(".modal [data-group]");
    await t.click(".modal [data-group]");
    await t.eq("joined the existing group", `document.querySelectorAll('.railgroup .gmembers [data-space]').length`, 3);
    const first = `document.querySelector('.railgroup .gmembers [data-space]').dataset.space`;
    const f0 = await t.ev(first);
    await t.ev(`document.querySelector('.railgroup .gmembers [data-space]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:200}))`);
    await btn(t, /Move down/);
    await t.ok("Move down inside the group", `${first} !== ${JSON.stringify(f0)}`);
    await t.ok("the group tile has an accessible name and state", `(()=>{const b=document.querySelector('.rail .pill.grouphead'); return b.getAttribute('aria-expanded')==='true' && /group of 3/.test(b.getAttribute('aria-label'))})()`);
  }),

  test("a group member that vanishes is dropped; chats dropped on a group choose one of its members", async (t) => {
    await t.open();
    await dragAt(t, spaceEl(RUST), spaceEl(HIKE), 0.5);
    await t.waitSel(".rail .railgroup");
    await t.click('.rail .pill.grouphead'); // collapse
    await t.openRow("Ben Fischer");
    await dragAt(t, rowEl("wa-1:ben"), `document.querySelector('.rail .pill.grouphead').parentElement`);
    await t.waitSel(".modal .movelist");
    await t.eq("chooser lists only the group's members", `[...document.querySelectorAll('.movelist button')].map(b=>b.dataset.target).join()`, `${HIKE},${RUST}`);
    await t.click(`.movelist button[data-target="${RUST}"]`);
    await t.ok("chat moved into the chosen member", `document.querySelector('.notice')?.textContent.includes('Rust Community')`);
    await t.eq("backend moved it", `__mockCall('snapshot').then(s=>s.chats.find(c=>c.id==='wa-1:ben').spaceId)`, RUST);
    await t.eq("leaving a community removes it from the stored group on read", `__mockCall('leaveSpace',{spaceId:'${HIKE}'}).then(()=>__mockCall('railGroups')).then(g=>JSON.stringify(g.map(x=>x.members)))`, JSON.stringify([[RUST]]));
  }),
];

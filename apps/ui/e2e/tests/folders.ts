// Folders, communities and the rail: seeds, moving chats, reordering, mute, edit/delete, single-chat collapse.
import { test } from "../lib/test.ts";
import { btn, chatMenu, moveChatIdTo, moveChatTo, rail, railMenu, rows, rowsStarting, settings } from "../lib/ui.ts";

const badge = (t: any, title: string) => t.ev(`Number(document.querySelector('.rail .pill[title^="${title}"]').parentElement.querySelector('.pbadge')?.textContent ?? 0)`);

export default [
  test("rail seed: single-chat communities collapsed, multi-chat ones and folder listed", async (t) => {
    await t.open();
    const r = await rail(t);
    t.check("no rail entry for single-chat communities (Neighbours, archived Old Project)", !r.some((x) => /Neighbours|Old Project/.test(x)), JSON.stringify(r));
    t.check("multi-chat communities and the Favourites folder are there", ["Hiking Club", "Rust Community", "Self-Hosters", "Favourites", "UniChat Dev"].every((n) => r.some((x) => x.startsWith(n))), JSON.stringify(r));
    await t.ok("folder has no provider dot, a network community has one", `!document.querySelector('[data-space="folder:fav"] .pdot') && !!document.querySelector('[data-space="wa-1:hike"] .pdot')`);
    await t.pill("Personal");
    const p = await rows(t);
    t.check("Personal lists the collapsed chats (Neighbours announcements, old-general)", p.some((n) => n.startsWith("Neighbours announcements")) && p.some((n) => n.startsWith("old-general")), JSON.stringify(p));
    t.check("chats of a Favourites folder are NOT in Personal", !p.some((n) => /Trail friends|^Bea|^Carl/.test(n)), JSON.stringify(p));
  }),

  test("folder holds chats of mixed networks with provider badges", async (t) => {
    await t.open();
    await t.pill("Favourites");
    await t.waitSel(".chats li[data-chat]");
    const p = await rows(t);
    t.check("Favourites: Bea (Matrix DM), Carl (Matrix DM), Trail friends (WA group)", ["Bea Lorenz", "Trail friends", "Carl"].every((n) => p.some((x) => x.startsWith(n))), JSON.stringify(p));
    t.check("rows show their provider badge", (await t.ev(`document.querySelectorAll('.chats li[data-chat] .avbadge').length`)) >= 3);
    await t.shot("folder_mixed");
  }),

  test("move a chat to another community via the context menu, then reset", async (t) => {
    await t.open();
    await t.pill("Personal");
    await chatMenu(t, "Ben Fischer");
    await btn(t, /Move to folder/);
    await t.waitSel(".movelist button");
    await t.shot("move_modal");
    const targets = await t.ev(`[...document.querySelectorAll('.movelist button')].map(b=>b.dataset.target)`);
    t.check("move list: Personal + communities + folder, but no collapsed ones", targets.includes("personal") && targets.includes("folder:fav") && targets.includes("wa-1:hike") && targets.includes("mx-1:!rust") && !targets.includes("wa-1:neigh"), JSON.stringify(targets));
    await t.click('.movelist button[data-target="mx-1:!rust"]');
    await t.not("moved: gone from Personal", `__e2e.rows().some(n=>n.startsWith("Ben"))`);
    await t.pill("Rust Community");
    await t.ok("shows up in Rust Community with a provider badge", `[...document.querySelectorAll('.chats li[data-chat]')].find(e=>e.querySelector('.name').textContent.startsWith('Ben'))?.querySelector('.avbadge')`);
    await t.ok("a notice about the move is shown", `document.querySelector('.notice')`);
    await t.click(".chats li[data-chat]", "Ben");
    await t.click('.hright button[title="Chat info"]');
    await t.shot("info_place");
    await btn(t, "Reset to original place");
    await t.pill("Personal");
    await t.ok("reset returns the DM to Personal", `__e2e.rows().some(n=>n.startsWith("Ben"))`);
  }),

  test("new folder from the move modal (colour + icon), appears last in the rail", async (t) => {
    await t.open();
    await t.pill("Personal");
    await chatMenu(t, "Ben Fischer");
    await btn(t, /Move to folder/);
    await btn(t, "New folder…");
    await t.shot("newfolder_modal");
    await t.setInput(".modal input", "Work");
    await t.click('.swatch[aria-label="Colour #23a559"]');
    await t.click('.swatch[aria-label="Icon 💼"]');
    await btn(t, "Create folder");
    await t.ok("new folder appears last in the rail", `__e2e.rail().at(-1)?.startsWith("Work")`);
    await t.ok("it has the chosen icon", `document.querySelector('.rail .pill[title^="Work"]')?.textContent.includes('💼')`);
    await t.pill("Work");
    await t.eq("the chat was moved into the new folder", `__e2e.rows()`, ["Ben Fischer"]);
    await t.shot("rail_work");
  }),

  test("reorder the rail: Move up / down in the menu and drag and drop", async (t) => {
    await t.open();
    const before = await rail(t);
    const iFav = before.findIndex((x) => x.startsWith("Favourites"));
    await railMenu(t, "Favourites");
    await btn(t, "Move up");
    await t.ok("Move up moves Favourites one step up", `__e2e.rail().findIndex(x=>x.startsWith("Favourites"))===${iFav - 1}`);
    await t.drag(`document.querySelector('[data-space="folder:fav"]')`, `document.querySelector('[data-space="wa-1:hike"]')`);
    await t.ok("dragging a rail icon onto another reorders (Favourites now before Hiking Club)", `(()=>{const r=__e2e.rail();return r.findIndex(x=>x.startsWith("Favourites"))<r.findIndex(x=>x.startsWith("Hiking"))})()`);
    await railMenu(t, "Rust Community");
    await btn(t, "Move down");
    await t.ok("network communities can be moved too", `(()=>{const r=__e2e.rail();return r.findIndex(x=>x.startsWith("Rust"))>r.findIndex(x=>x.startsWith("Self"))})()`);
  }),

  test("drag a chat onto a rail icon moves it", async (t) => {
    await t.open();
    await t.pill("Favourites");
    const li = `[...document.querySelectorAll('.chats li[data-chat]')].find(e=>e.querySelector('.name').textContent.startsWith('Bea'))`;
    await t.waitFor(li);
    await t.drag(li, `document.querySelector('[data-space="home"]')`);
    await t.pill("Personal");
    await t.ok("dragging a chat onto Personal moves it there", `__e2e.rows().some(n=>n.startsWith("Bea"))`);
    await t.drag(li, `document.querySelector('[data-space="mx-1:!rust"]')`);
    await t.pill("Rust Community");
    await t.ok("dragging a chat onto a community moves it", `__e2e.rows().some(n=>n.startsWith("Bea"))`);
  }),

  test("unread badge follows moved chats; muting a community silences the moved chat", async (t) => {
    await t.open();
    const b0 = await badge(t, "Rust");
    await t.pill("Personal");
    await moveChatIdTo(t, "wa-1:anna", "mx-1:!rust");   // WhatsApp Anna has 2 unread
    await t.pill("Rust");
    await t.waitFor(`document.querySelector('.chats li[data-chat="wa-1:anna"]')`);
    await t.ok("target community badge includes the moved chat's unread", `Number(document.querySelector('.rail .pill[title^="Rust"]').parentElement.querySelector('.pbadge')?.textContent ?? 0) > ${b0}`);
    await railMenu(t, "Rust");
    await btn(t, "Mute community");
    await t.ok("muted community: badge gone", `!document.querySelector('.rail .pill[title^="Rust"]').parentElement.querySelector('.pbadge')`);
    await railMenu(t, "Rust");
    await t.waitSel("button", "Unmute community");
    t.check("menu now offers Unmute", true);
  }),

  test("edit and delete a folder; its chats return to their original place", async (t) => {
    await t.open();
    await t.pill("Personal");
    await chatMenu(t, "Ben Fischer");
    await btn(t, /Move to folder/); await btn(t, "New folder…");
    await t.setInput(".modal input", "Work");
    await btn(t, "Create folder");
    await t.waitFor(`__e2e.rail().some(x=>x.startsWith("Work"))`);
    await railMenu(t, "Work"); await btn(t, "Edit folder");
    await t.setInput(".modal input", "Jobs");
    await btn(t, /^Save$/);
    await t.ok("rename folder", `__e2e.rail().some(x=>x.startsWith("Jobs"))`);
    await railMenu(t, "Jobs"); await btn(t, "Delete folder");
    await t.shot("delete_confirm");
    await t.click(".modal button", /Delete folder/);
    await t.not("delete folder removes it from the rail", `__e2e.rail().some(x=>x.startsWith("Jobs"))`);
    await t.pill("Personal");
    await t.ok("its chat went back to its original place (Personal)", `__e2e.rows().some(n=>n.startsWith("Ben"))`);
  }),

  test("single-chat rule is dynamic: a 2-chat community collapses when one chat leaves", async (t) => {
    await t.open();
    await t.pill("Self-Hosters");
    await t.eq("Self-Hosters has 2 chats", `__e2e.rows().length`, 2);
    await moveChatTo(t, "ops", "personal");
    await t.not("the community leaves the rail", `__e2e.rail().some(x=>x.startsWith("Self-Hosters"))`);
    await t.eq("we were bounced to Personal", `document.querySelector('.chats header span').textContent`, "Personal");
    await t.openRow("chat");
    await t.click('.hright button[title="Chat info"]');
    await t.shot("collapsed_info");
    await t.ok("info panel says 'Part of community Self-Hosters'", `/Part of community Self-Hosters/.test(document.body.textContent)`);
    await btn(t, "Community info");
    await t.ok("community info modal opens", `document.querySelector('.spacehero')`);
    await t.shot("comm_info");
  }),

  test("setting 'collapse single-chat communities' OFF brings their entries back", async (t) => {
    await t.open("&settings=1");
    await t.click(".settings nav button", "Appearance");
    await t.shot("settings");
    await t.ok("setting exists and defaults on", `document.querySelector('#collapseSingle')?.checked === true`);
    await t.click("#collapseSingle");
    await t.ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
    await t.ok("Neighbours gets its own rail entry back", `__e2e.rail().some(x=>x.startsWith("Neighbours"))`);
    await t.ok("the archive switch is there for the archived single-chat community", `document.querySelector('.rail .pill[title^="Show archived"]')`);
    await t.shot("setting_off");
  }),

  test("a community emptied by moving its chats disappears from the rail", async (t) => {
    await t.open();
    await t.ok("Hiking Club is in the rail", `__e2e.rail().some(x=>/Hiking/.test(x))`);
    await t.pill("Hiking");
    for (const name of ["Announcements", "Trip planning"]) await moveChatTo(t, name, "folder:fav");
    await t.not("the emptied community is gone from the rail", `__e2e.rail().some(x=>/Hiking/.test(x))`);
    await t.ok("the folder is still there", `__e2e.rail().some(x=>/Favourites/.test(x))`);
  }),

  test("provider bubble on a community vanishes once another network's chat moves in", async (t) => {
    await t.open();
    const hk = `[...document.querySelectorAll('.pillwrap')].find(e=>/Hiking/.test(e.querySelector('.pill')?.title))`;
    await t.ok("Hiking Club shows its messenger bubble", `${hk}?.querySelector('.pdot')`);
    await t.pill("Personal");
    await moveChatIdTo(t, "mx-1:@anna:matrix.org", "wa-1:hike");   // the Matrix 'Anna Becker' DM
    await t.not("a Matrix chat moved into the WhatsApp community removes the bubble", `${hk}?.querySelector('.pdot')`);
    await t.shot("dot");
  }),

  test("moved chats look like groups (no # hash) and carry an origin", async (t) => {
    await t.open();
    await t.pill("Personal");
    await t.ok("collapsed-community chats show no hash", `(()=>{const r=[...document.querySelectorAll('.chats li')].filter(e=>/Neighbours|old-general/.test(e.textContent)); return r.length>=2 && r.every(e=>!e.querySelector('.hash'))})()`);
    await t.ok("they show an avatar instead", `(()=>{const r=[...document.querySelectorAll('.chats li')].filter(e=>/Neighbours|old-general/.test(e.textContent)); return r.every(e=>e.querySelector('.avatar'))})()`);
    await t.pill("Rust");
    await t.ok("whereas a channel inside its own community keeps the # icon", `document.querySelector('.chats li[data-chat="mx-1:!rust-general"] .hash')`);
    await t.shot("origin");
  }),

  test("a custom folder icon can be uploaded and shows in the rail", async (t) => {
    await t.open();
    await t.click('.pill[title="New folder"]');
    await t.setInput(".modal input:not([type=file])", "Pics");
    await t.upload(".iconupload input[type=file]", [t.fixture("red.png")]);
    await t.ok("preview shows the uploaded picture", `document.querySelector('.folderprev .foldericonimg')`);
    await t.shot("ficon");
    await btn(t, /Create folder/);
    await t.ok("the new folder in the rail uses the picture", `document.querySelector('.pill[title^="Pics"] .foldericonimg')`);
  }),
];

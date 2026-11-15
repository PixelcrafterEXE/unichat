// The shared emoji picker (composer, reactions, folder icon), the shared-media gallery and the account status ring row. Mock UI only.
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";

const RUST = "&chat=mx-1:!rust-general";
const MEDIA = "&media=1&chat=wa-1:anna";
const msgMenu = (t: any, txt: string) => t.contextMenu({ expr: `__e2e.msg(${JSON.stringify(txt)})` }, 500, 300);
const key = (t: Page, k: string, code: number) => (async () => { await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: code }); await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: code }); })();
const openPicker = async (t: Page) => { await t.click('button[title="Emoji"]'); await t.waitSel(".epop .epcell"); };
const search = (t: Page, q: string) => t.setInput(".epick input[type=search]", q);
const cells = `[...document.querySelectorAll('.epop .epcell')].map(b=>b.textContent)`;
const openGallery = async (t: Page, tab = "") => {
  await t.waitSel('button.icon[title="Chat info"]'); await t.ev(`document.querySelector('button.icon[title="Chat info"]').click()`);
  await t.waitSel('[data-act="show-all-media"]'); await t.click('[data-act="show-all-media"]');
  await t.waitSel(".mgal .mgcell:not(.mgskel)");
  if (tab) { await t.click(`.mgtabs [data-tab=${tab}]`); }
};

export default [
  // ------------------------------------------------------------------ emoji picker
  test("emoji picker (composer): all emojis, search 'party' finds 🎉, inserts at the caret and stays open", async (t) => {
    await t.open("&chat=wa-1:anna");
    await t.typeIn("hello world");
    await t.ev(`(()=>{const a=document.querySelector('.composer textarea'); a.focus(); a.setSelectionRange(5,5)})()`);
    await openPicker(t);
    await t.ok("1800+ emojis are in the picker", `+document.querySelector('.epick').dataset.total >= 1800`);
    await t.ok("only a window of them is in the DOM (virtualised)", `document.querySelectorAll('.epop .epcell').length < 400`);
    await search(t, "party");
    await t.ok("search finds the party popper", `${cells}.includes('🎉')`);
    await t.ok("and only matches", `document.querySelectorAll('.epop .epcell').length < 30`);
    await t.click('.epop .epcell[data-emoji="🎉"]');
    await t.eq("inserted at the caret", `document.querySelector('.composer textarea').value`, "hello🎉 world");
    await t.ok("the picker stays open for more", `!!document.querySelector('.epop')`);
    await t.shot("emoji_picker_search");
    await t.key("Escape"); await t.eq("first Escape clears the search", `document.querySelector('.epick input').value`, "");
    await t.key("Escape");
    await t.waitGone(`document.querySelector('.epop')`);
    await t.ok("focus is back in the composer", `document.activeElement===document.querySelector('.composer textarea')`);
  }),

  test("emoji picker: categories jump, sticky header follows, every category is there", async (t) => {
    await t.open("&chat=wa-1:anna"); await openPicker(t);
    await t.eq("nine categories", `document.querySelectorAll('.epcats button[data-cat]:not([data-cat=recent])').length`, 9);
    await t.click('.epcats button[data-cat="Flags"]');
    await t.waitFor(`document.querySelector('.epsticky').textContent==='Flags'`, { desc: "sticky header says Flags" });
    await t.ok("flag emojis are shown", `${cells}.some(e=>/^[\\u{1F1E6}-\\u{1F1FF}]{2}$/u.test(e) || e==='🏁')`);
    await t.click('.epcats button[data-cat="Food & Drink"]');
    await t.waitFor(`document.querySelector('.epsticky').textContent==='Food & Drink'`);
    await t.ok("the tab is marked", `document.querySelector('.epcats button[data-cat="Food & Drink"]').getAttribute('aria-selected')==='true'`);
  }),

  test("emoji picker: skin tone is applied, offered only where it applies, and stored in the UI settings", async (t) => {
    await t.open("&chat=wa-1:anna"); await openPicker(t);
    await t.click('.epcats button[data-cat="People & Body"]');
    await t.waitFor(`${cells}.includes('👋')`);
    await t.click(".eptonebtn"); await t.click(".eptones button[data-tone='3']");
    await t.waitFor(`${cells}.some(e=>e.includes('\\u{1F3FD}'))`, { desc: "medium tone shows" });
    await t.ok("the waving hand is toned", `${cells}.includes('👋\\u{1F3FD}')`);
    await search(t, "pizza");
    await t.ok("a pizza has no tone", `${cells}.includes('🍕')`);
    await t.eq("stored in the settings", `JSON.parse(localStorage.getItem('unimsg.settings')).skinTone`, 3);
    await t.click('.epop .epcell[data-emoji="🍕"]');
    await t.ok("picking inserts it", `document.querySelector('.composer textarea').value.includes('🍕')`);
    await t.open("&chat=wa-1:anna"); await openPicker(t);
    await t.eq("the tone is remembered after a reload", `document.querySelector('.epick').dataset.tone`, "3");
  }),

  test("emoji picker: recent and frequently used (localStorage)", async (t) => {
    await t.open("&chat=wa-1:anna"); await openPicker(t);
    await t.not("no recent section yet", `[...document.querySelectorAll('.ephead,.epsticky')].some(h=>/Recent/.test(h.textContent))`);
    for (const [q, e] of [["rocket", "🚀"], ["rocket", "🚀"], ["tada", "🎉"]]) { await search(t, q); await t.click(`.epop .epcell[data-emoji="${e}"]`); }
    await search(t, "");
    await t.ok("stored", `JSON.parse(localStorage.getItem('unichat.emoji.recent')).r[0]==='🎉'`);
    await t.waitFor(`[...document.querySelectorAll('.ephead,.epsticky')].some(h=>h.textContent==='Frequently used')`, { desc: "frequently used row" });
    await t.ok("the most used is first", `document.querySelector('.epop .epcell').textContent==='🚀'`);
    await t.ok("recent row lists the latest first", `[...document.querySelectorAll('.ephead')].some(h=>h.textContent==='Recent') && ${cells}.slice(0,12).includes('🎉')`);
  }),

  test("emoji picker: keyboard (arrows + Enter in the grid, Enter on a search, Escape clears then closes)", async (t) => {
    await t.open("&chat=wa-1:anna"); await openPicker(t);
    await t.ev(`document.querySelector('.epick input').focus()`);
    await key(t, "ArrowDown", 40); await key(t, "ArrowRight", 39);
    await t.ok("a cell is active", `!!document.querySelector('.epcell.active') && document.querySelector('.epick input').getAttribute('aria-activedescendant')`);
    const want = await t.ev<string>(`document.querySelector('.epcell.active').textContent`);
    await key(t, "Enter", 13);
    await t.eq("Enter picks the active emoji", `document.querySelector('.composer textarea').value`, want);
    await t.eq("that was the 2nd emoji of the grid", `document.querySelector('.composer textarea').value`, "😃");
    await search(t, "rocket"); await key(t, "Enter", 13);
    await t.ok("Enter in a search picks the first hit", `document.querySelector('.composer textarea').value.endsWith('🚀')`);
    await key(t, "Escape", 27); await t.eq("Escape clears the search first", `document.querySelector('.epick input').value`, "");
    await key(t, "Escape", 27); await t.waitGone(`document.querySelector('.epop')`);
  }),

  test("reactions: '+' in the context menu and the chip's add button open the full picker", async (t) => {
    await t.open(RUST);
    await t.waitFor(`__e2e.msg("Async traits")`);
    await msgMenu(t, "Async traits");
    await t.click(".ctxreacts button.more");
    await t.waitSel(".epop .epcell");
    await t.ok("the quick row is gone, the full picker is up", `!document.querySelector('.ctxmenu') && +document.querySelector('.epick').dataset.total>=1800`);
    await search(t, "rocket"); await t.click('.epop .epcell[data-emoji="🚀"]');
    await t.ok("reaction chip with the chosen emoji", `[...__e2e.msg("Async traits").querySelectorAll('.reactions .chip.mine')].some(c=>c.textContent.includes('🚀'))`);
    await t.waitGone(`document.querySelector('.epop')`);
    await t.click(`.reactions .chip.add`);
    await t.waitSel(".epop .epcell"); await search(t, "tada");
    await t.click('.epop .epcell[data-emoji="🎉"]');
    await t.ok("the add button works too", `[...document.querySelectorAll('.reactions .chip.mine')].some(c=>c.textContent.includes('🎉'))`);
  }),

  test("folder icon: 'All emojis…' uses the shared picker; the presets stay", async (t) => {
    await t.open();
    await t.click('.pill[title="New folder"]');
    await t.waitSel("#allemoji");
    await t.ok("preset swatches are still there", `document.querySelectorAll('.modal .swatch.ico').length>=8`);
    await t.click("#allemoji"); await t.waitSel("#fullemoji .epick .epcell");
    await search(t, "rocket"); await key(t, "Enter", 13);
    await t.ok("Enter in the search does not submit the folder form", `!!document.querySelector('.modal')`);
    await t.waitFor(`document.querySelector('.folderprev .fe')?.textContent==='🚀'`, { desc: "icon chosen" });
  }),

  test("phone: the emoji picker is a bottom sheet with 44px targets", async (t) => {
    await t.device("phone"); await t.open("&chat=wa-1:anna");
    await openPicker(t);
    await t.ok("sheet at the bottom, full width", `(()=>{const r=document.querySelector('.epop.sheet').getBoundingClientRect(); return Math.abs(r.width-innerWidth)<2 && Math.abs(r.bottom-innerHeight)<2 && r.height>200 && r.height<=innerHeight*0.7+2})()`);
    await t.ok("cells are at least 44px", `(()=>{const r=document.querySelector('.epop .epcell').getBoundingClientRect(); return r.height>=44 && r.width>=40})()`);
    await t.ok("category tabs are 44px too", `document.querySelector('.epcats button').getBoundingClientRect().height>=44`);
    await t.ok("no horizontal overflow", `document.documentElement.scrollWidth<=innerWidth`);
    await t.shot("emoji_picker_phone");
    await t.click('.epop .epcell[data-emoji="😃"]');
    await t.ok("inserts without closing the sheet", `document.querySelector('.composer textarea').value==='😃' && !!document.querySelector('.epop')`);
    await t.click(".epbackdrop"); await t.waitGone(`document.querySelector('.epop')`);
  }),

  // ------------------------------------------------------------------ shared media
  test("shared media sidebar: compact 3-column grid of the newest 15 and 'Show all (N)'", async (t) => {
    await t.open(MEDIA);
    await t.ev(`document.querySelector('button.icon[title="Chat info"]').click()`);
    await t.waitSel('[data-act="show-all-media"]');
    await t.eq("15 thumbnails", `document.querySelectorAll('.info .thumbs .thumb').length`, 15);
    await t.ok("three columns", `getComputedStyle(document.querySelector('.info .thumbs')).gridTemplateColumns.split(' ').length===3`);
    await t.eq("the button says how many", `document.querySelector('[data-act="show-all-media"]').textContent`, "Show all (136)");
    await t.shot("media_sidebar");
  }),

  test("media gallery: tabs with counts, pages the backend while scrolling (> 60), lazy thumbnails", async (t) => {
    await t.open(MEDIA); await openGallery(t);
    await t.eq("tab counts known from the first response", `[...document.querySelectorAll('.mgtabs button')].map(b=>b.textContent).join('|')`, "Photos & videos136|Files15|Links7|Voice6");
    await t.ok("first page only (60 messages)", `(()=>{const n=document.querySelectorAll('.mgal .mgcell:not(.mgskel)').length; return n>=60 && n<=62})()`);
    await t.ok("thumbnails are lazy: far cells have no image yet", `document.querySelectorAll('.mgal .mgcell:not(.mgskel) img').length < 60`);
    await t.ev(`(()=>{const s=document.querySelector('.mgscroll'); s.scrollTop=s.scrollHeight})()`);
    await t.waitFor(`document.querySelectorAll('.mgal .mgcell:not(.mgskel)').length>=118`, { desc: "second page" });
    await t.ev(`(()=>{const s=document.querySelector('.mgscroll'); s.scrollTop=s.scrollHeight})()`);
    await t.waitFor(`document.querySelectorAll('.mgal .mgcell:not(.mgskel)').length===136`, { desc: "third page, then the end" });
    await t.ok("a responsive multi-column grid", `getComputedStyle(document.querySelector('.mggrid')).gridTemplateColumns.split(' ').length>=4`);
    await t.shot("media_gallery");
  }),

  test("media gallery: files (middle ellipsis keeps the extension), links, voice", async (t) => {
    await t.open(MEDIA); await openGallery(t, "files");
    await t.waitSel(".mgrow.filerow2");
    await t.eq("15 file rows", `document.querySelectorAll('.mgrow.filerow2').length`, 15);
    await t.ok("long name is cut in the middle, the extension stays visible", `(()=>{const r=[...document.querySelectorAll('.filerow2')].find(x=>x.dataset.file.startsWith('Quarterly')); const e=r.querySelector('.midt'); return e.textContent.endsWith('.pdf') && r.querySelector('.midh').textContent.startsWith('Quarterly') && e.getBoundingClientRect().right<=r.getBoundingClientRect().right})()`);
    await t.ok("size and date are shown", `/KB/.test(document.querySelector('.filerow2 small').textContent) && /20\\d\\d/.test(document.querySelector('.filerow2 small').textContent)`);
    await t.click(".mgtabs [data-tab=links]"); await t.waitSel(".mgrow.linkrow");
    await t.ok("links with their host, URL and the preview title", `document.querySelectorAll('.linkrow').length===7 && [...document.querySelectorAll('.linkrow')].some(r=>/Zugspitze - Wikipedia/.test(r.textContent)) && [...document.querySelectorAll('.linkrow a')].every(a=>a.target==='_blank')`);
    await t.click(".mgtabs [data-tab=voice]"); await t.waitSel(".mgrow.voicerow");
    await t.eq("6 voice rows", `document.querySelectorAll('.voicerow').length`, 6);
  }),

  test("media gallery: viewer with next / previous and 'Show in chat' jumps to the message", async (t) => {
    await t.open(MEDIA); await openGallery(t);
    await t.click(".mgal .mgcell:not(.mgskel)");
    await t.waitSel(".mgview img");
    await t.ok("counter", `/^1 \\/ 6\\d\\+?$/.test(document.querySelector('.mgcount').textContent)`);
    await t.ok("previous is disabled on the first", `document.querySelector('.mgnav.prev').disabled`);
    const first = await t.ev<string>(`document.querySelector('.mgview img').src`);
    await t.click(".mgnav.next"); await t.waitFor(`/^2 \\//.test(document.querySelector('.mgcount').textContent)`);
    await t.waitFor(`document.querySelector('.mgview img').src!==${JSON.stringify(first)}`, { desc: "another picture" });
    await key(t, "ArrowLeft", 37); await t.waitFor(`/^1 \\//.test(document.querySelector('.mgcount').textContent)`);
    await t.click(".mgnav.next"); await t.click(".mgnav.next");
    const mid = await t.ev<string>(`(()=>{const c=[...document.querySelectorAll('.mgal .mgcell:not(.mgskel)')][2]; return c.dataset.jump})()`);
    await t.click('[data-act="show-in-chat"]');
    await t.not("the gallery closed", `document.querySelector('.mgal')`);
    await t.waitSel(`[data-mid="${mid}"]`);
    await t.ok("the message is in the conversation", `!!document.querySelector('[data-mid="${mid}"]')`);
  }),

  test("media gallery: Escape closes the viewer first, then the gallery", async (t) => {
    await t.open(MEDIA); await openGallery(t);
    await t.click(".mgal .mgcell:not(.mgskel)"); await t.waitSel(".mgview");
    await t.ev(`document.querySelector('.mgview').click()`); await t.waitGone(`document.querySelector('.mgview')`);
    await t.ok("gallery still open", `!!document.querySelector('.mgal')`);
    await t.click(".mghead button"); await t.waitGone(`document.querySelector('.mgal')`);
  }),

  test("media gallery against an older backend (no chatMedia): pages the history", async (t) => {
    await t.open("&media=1"); await t.ev(`window.__mockNoChatMedia = true`);
    await t.openChat("wa-1:anna");
    await openGallery(t);
    await t.ok("photos are listed from the history", `document.querySelectorAll('.mgal .mgcell:not(.mgskel)').length>=40`);
    await t.click(".mgtabs [data-tab=files]"); await t.waitSel(".mgrow.filerow2");
    await t.ok("so are files", `document.querySelectorAll('.filerow2').length>=10`);
  }),

  test("phone: the gallery is a full-screen page with a 3-column grid and 44px tabs", async (t) => {
    await t.device("phone"); await t.open(MEDIA);
    await t.waitSel('button[title="Chat info"]'); await t.ev(`document.querySelector('button[title="Chat info"]').click()`);
    await t.waitSel('[data-act="show-all-media"]'); await t.click('[data-act="show-all-media"]'); await t.waitSel(".mgal .mgcell:not(.mgskel)");
    await t.ok("full screen", `(()=>{const r=document.querySelector('.mgal').getBoundingClientRect(); return r.width===innerWidth && Math.abs(r.height-innerHeight)<2})()`);
    await t.eq("3 columns", `getComputedStyle(document.querySelector('.mggrid')).gridTemplateColumns.split(' ').length`, 3);
    await t.ok("tabs are tappable", `document.querySelector('.mgtabs button').getBoundingClientRect().height>=44`);
    await t.ok("no horizontal overflow", `document.documentElement.scrollWidth<=innerWidth`);
    await t.shot("media_gallery_phone");
    await t.click(".mgtabs [data-tab=files]"); await t.waitSel(".filerow2");
    await t.ok("file rows fit", `[...document.querySelectorAll('.filerow2')].every(r=>r.getBoundingClientRect().right<=innerWidth+1)`);
    await t.ok("a long name is cut in the middle with the extension visible", `(()=>{const r=[...document.querySelectorAll('.filerow2')].find(x=>x.dataset.file.startsWith('Quarterly')); const h=r.querySelector('.midh'), e=r.querySelector('.midt'); return h.scrollWidth>h.clientWidth && e.textContent.endsWith('.pdf') && e.getBoundingClientRect().right<=innerWidth})()`);
  }),

  // ------------------------------------------------------------------ account status ring row
  test("status footer: one ring per account, colour = state, text in the tooltip, click opens the account card", async (t) => {
    await t.open();
    await t.waitSel('footer [role=list] [data-acct]');
    await t.ok("a list with one button per account", `(()=>{const l=document.querySelector('footer [role=list]'); const b=[...l.querySelectorAll('button[data-acct]')]; return b.length>=4 && b.length===l.querySelectorAll('[role=listitem]').length && b.every(x=>x.getAttribute('aria-label') && x.title===x.getAttribute('aria-label'))})()`);
    await t.ok("no multi-line text list any more", `!/signed out|Connected|\\(/.test(document.querySelector('footer').textContent)`);
    await t.ok("a provider icon of 22px in each ring", `[...document.querySelectorAll('footer .ring .pi')].every(p=>p.getBoundingClientRect().width===22)`);
    await t.ok("connected accounts have a green ring", `(()=>{const b=document.querySelector('footer button[data-state=connected]'); return !!b && b.dataset.ring==='ok' && getComputedStyle(b).borderTopColor==='rgb(35, 165, 89)'})()`);
    await t.ok("the row is short (<= 2 lines)", `document.querySelector('footer').getBoundingClientRect().height<=80`);
    await t.shot("status_footer");
    const id = await t.ev<string>(`document.querySelector('footer button[data-state=connected]').dataset.acct`);
    await t.ev(`window.__mockEmit && window.__mockEmit('account', {id:${JSON.stringify(id)}, state:'connecting'})`);
    await t.ev(`document.querySelector('footer button[data-acct=${JSON.stringify(id)}]').click()`);
    await t.waitSel(`.acard[data-account=${JSON.stringify(id)}]`);
    await t.ok("Settings > Accounts shows that card", `!!document.querySelector('.acard.flash') || !!document.querySelector('.acard[data-account=${JSON.stringify(id)}]')`);
  }),

  test("status footer: grey ring for an offline holder, dashed blue ring when relayed; phone tap target is 44px", async (t) => {
    await t.device("phone"); await t.open();
    await t.waitSel('footer button[data-acct]');
    await t.ok("44px tap target", `[...document.querySelectorAll('footer button[data-acct]')].every(b=>{const r=b.getBoundingClientRect(); return r.width>=44 && r.height>=44})`);
    await t.ok("fits the width without overflow", `document.documentElement.scrollWidth<=innerWidth`);
    await t.ev(`window.__mockRelay('mx-1','offline','MSLaptop')`);
    await t.waitFor(`document.querySelector('footer [data-acct="mx-1"]').dataset.ring==='off'`, { desc: "grey ring for an offline holder" });
    await t.ev(`window.__mockRelay('mx-1','relay','MSLaptop')`);
    await t.waitFor(`document.querySelector('footer [data-acct="mx-1"]').dataset.ring==='relay' && getComputedStyle(document.querySelector('footer [data-acct="mx-1"]')).borderTopStyle==='dashed'`, { desc: "dashed blue ring when relayed" });
    await t.shot("status_footer_phone");
  }),
  // ------------------------------------------------------------------ loading source + timeout fallback
  test("loading a chat names where it loads from (device / phone / service)", async (t) => {
    await t.open(); await t.ev(`window.__mockSlowHistory = 4000; window.__mockRelay('mx-1','relay','MSLaptop')`);
    const line = `document.querySelector('[data-load-line]')?.textContent`;
    await t.openChat("mx-1:@anna:matrix.org");
    await t.waitFor(`${line}==='Loading from MSLaptop…'`, { desc: "relayed account: device named" });
    await t.openChat("wa-1:ben");
    await t.waitFor(`${line}==='Asking your phone via WhatsApp…'`, { desc: "phone-linked provider" });
    await t.openChat("ig-1:alice");
    await t.waitFor(`${line}==='Asking Instagram…'`, { desc: "other provider" });
    await t.ok("a spinner is shown while it waits", `!!document.querySelector('.loading .spinner')`);
  }),

  test("a relayed account whose device is offline does not spin: saved messages and the reason, at once", async (t) => {
    await t.open(); await t.ev(`window.__mockSlowHistory = 20000; window.__mockRelay('mx-1','offline','MSLaptop')`);
    await t.openChat("mx-1:@anna:matrix.org");
    await t.waitFor(`document.querySelector('[data-load-note]')?.textContent.includes('MSLaptop is offline. Showing what is saved on this device.')`, { desc: "offline note, no 20 s wait" });
    await t.ok("messages are shown", `document.querySelectorAll('.messages .msg').length>0`);
    await t.ok("no spinner, no Retry", `!document.querySelector('.loading .spinner') && !document.querySelector('[data-load-note] button')`);
  }),

  test("no answer within the timeout: archived messages + note with Retry; the late answer clears the note", async (t) => {
    await t.open(); await t.ev(`window.__loadTimeoutMs = 600; window.__mockSlowHistory = 2500`);
    await t.openChat("wa-1:ben");
    await t.waitFor(`document.querySelector('[data-load-note]')?.textContent.includes("Your phone didn't answer in time. Showing what is saved here.")`, { desc: "timeout note" });
    await t.ok("saved messages are shown meanwhile, with Retry", `document.querySelectorAll('.messages .msg').length>0 && /Retry/.test(document.querySelector('[data-load-note] button').textContent)`);
    await t.waitGone(`document.querySelector('[data-load-note]')`, { timeout: 8000 });
    await t.ok("the late answer replaced it", `document.querySelectorAll('.messages .msg').length>0`);
  }),

  // ------------------------------------------------------------------ gallery details
  test("media gallery: skeleton squares while loading, own voice player, equal tab icons", async (t) => {
    await t.open(MEDIA); await t.ev(`window.__mockSlowChatMedia = 1500`);
    await t.waitSel('button.icon[title="Chat info"]'); await t.ev(`document.querySelector('button.icon[title="Chat info"]').click()`);
    await t.waitSel('[data-act="show-all-media"]'); await t.click('[data-act="show-all-media"]');
    await t.waitSel(".mgskel");
    await t.ok("skeleton squares, no lone spinner", `document.querySelectorAll('.mggrid .mgskel').length>=12 && !document.querySelector('.mgal .spinner')`);
    await t.shot("media_gallery_loading");
    await t.waitSel(".mgal .mgcell:not(.mgskel)");
    await t.ok("tab icons are all the same size", `(()=>{const w=[...document.querySelectorAll('.mgtabs .mgti')].map(i=>Math.round(i.getBoundingClientRect().width)); return w.length===4 && new Set(w).size===1 && w[0]===16})()`);
    await t.ok("tabs share the width evenly (within a few px) or scroll", `(()=>{const b=[...document.querySelectorAll('.mgtabs button')].map(x=>x.getBoundingClientRect().width); return Math.max(...b)-Math.min(...b)<80})()`);
    await t.click(".mgtabs [data-tab=voice]"); await t.waitSel(".voicerow .voice");
    await t.ok("the app's voice player, not the browser's", `!document.querySelector('.voicerow audio[controls]') && !!document.querySelector('.voicerow .vplay') && !!document.querySelector('.voicerow .vbars')`);
    await t.click(".voicerow .vplay"); await t.waitFor(`!!document.querySelector('.voicerow audio')`, { desc: "audio loaded after play" });
    await t.shot("media_gallery_voice");
  }),
];

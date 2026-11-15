// Message view polish: messenger indicator only at run starts, compact reactions, placeholder text hidden, file cards, meta inline in the last line.
// Uses the `?mock&ux` fixture (src/mockUx.ts): Lena (1:1), Weekend climbers (group), Mira on WhatsApp + Matrix (merge them from the page).
import { test } from "../lib/test.ts";
import type { Page } from "../lib/harness.ts";

const MSG = (s: string) => `__e2e.msg(${JSON.stringify(s)})`;
const LONG = "export-rtd-locations-au045-band-rehearsal-room-assets-2026-06-25.csv";
async function mergedMira(t: Page) {
  await t.open("&ux");
  const id = await t.ev<string>(`window.__mockCall('mergeChats',{chatIds:['wa-1:ux-mira','mx-1:@ux-mira:matrix.org']}).then(r=>r.id)`);
  await t.openChat(id);
  await t.waitFor(`${MSG("Second floor, the green one")}`);
}

export default [
  test("merged chat: the messenger indicator shows only at run starts (sender/network change, after the date line, after a long pause)", async (t) => {
    await mergedMira(t);
    const has = (s: string) => `!!${MSG(s)}.querySelector('.netbadge')`;
    const expectBadge: [string, boolean][] = [
      ["Hey, are you around tomorrow?", true],            // first message of the chat
      ["I wanted to show you the new flat", false],       // same sender, same network, 1 minute later
      ["Also writing here in case WhatsApp is slow", true], // network change
      ["Hi Mira, yes!", true],                            // sender change
      ["Perfect", true],                                  // first after the date divider (and a long pause)
      ["See you at 5", false],
      ["Sending the address here", true],
      ["Linienstrasse 12", false],
      ["On my way", true], ["Almost there", false], ["Where is the door?", true], ["Second floor, the green one", true],
    ];
    for (const [text, want] of expectBadge) await t.eq(`badge on "${text}": ${want}`, has(text), want);
    await t.ok("a date divider sits before 'Perfect'", `(()=>{const m=${MSG("Perfect")}; return !!m.parentElement.querySelector('.daysep')})()`);
    await t.ok("the badge keeps its tooltip (network + account)", `/WhatsApp/.test(${MSG("Perfect")}.querySelector('.netbadge').title)`);
    await t.shot("merged-netbadge");
  }),

  test("a long pause (>= 15 min) in a merged chat shows the indicator again, a short one does not", async (t) => {
    await mergedMira(t);
    await t.ev(`window.__mockInject('wa-1:ux-mira','Mira Kowalski','fresh one')`);
    await t.waitFor(`${MSG("fresh one")}`);
    await t.ev(`window.__mockInject('wa-1:ux-mira','Mira Kowalski','and a second one right after')`);
    await t.waitFor(`${MSG("and a second one right after")}`);
    await t.ok("first of the run has it (the previous message is 3+ minutes older but from another network/sender)", `!!${MSG("fresh one")}.querySelector('.netbadge')`);
    await t.not("the next one 0 s later does not", `${MSG("and a second one right after")}.querySelector('.netbadge')`);
  }),

  test("reactions are compact chips (<= 26px) that overlap the bubble's lower edge", async (t) => {
    await t.open("&ux&chat=wa-1:ux-lena");
    await t.waitFor(`${MSG("Look at the route setter's new project")}`);
    const r = await t.ev<{ h: number[]; over: boolean; gap: number }>(`(()=>{const m=${MSG("Look at the route setter's new project")}; const chips=[...m.querySelectorAll('.reactions .chip:not(.add)')]; const b=m.querySelector('.body').getBoundingClientRect();
      return {h:chips.map(c=>Math.round(c.getBoundingClientRect().height)), over: chips[0].getBoundingClientRect().bottom > b.bottom, gap: Math.round(parseFloat(getComputedStyle(chips[0].parentElement).columnGap))}})()`);
    t.check("three chips", r.h.length === 3, JSON.stringify(r)); t.check("every chip <= 26px high", r.h.every((h) => h <= 26), JSON.stringify(r.h));
    t.check("chips overlap the bubble's bottom edge", r.over); t.check("4px gap", r.gap === 4, String(r.gap));
    await t.not("add-reaction chip is hidden until hover", `getComputedStyle(${MSG("Look at the route setter's new project")}.querySelector('.chip.add')).display!=='none'`);
    await t.ev(`${MSG("Look at the route setter's new project")}.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}))`);
    const sixRows = await t.ev<number>(`(()=>{const m=${MSG("A message that is long enough to wrap into a second line, and then the last word")}; return new Set([...m.querySelectorAll('.reactions .chip:not(.add)')].map(c=>Math.round(c.getBoundingClientRect().top))).size})()`);
    t.check("six reactions fit in one row on desktop", sixRows === 1, String(sixRows));
  }),

  test("placeholder text ([Photo], [File: …]) is hidden when the attachment is there, and a card replaces it when the media is missing", async (t) => {
    await t.open("&ux&chat=wa-1:ux-lena");
    await t.waitFor(`document.querySelector('.messages .msg')`);
    await t.eq("no bracket placeholder text anywhere in the timeline", `/\\[(Photo|File|Video|Voice message|Sticker|GIF)/i.test(document.querySelector('.messages').innerText)`, false);
    await t.eq("one 'not available' card for the missing photo", `document.querySelectorAll('.messages [data-missing="image"]').length`, 1);
    await t.ok("it says so", `/Photo not available/.test(document.querySelector('[data-missing="image"]').innerText)`);
    await t.ok("the missing file shows its name, not brackets", `/climbing-gym-price-list-2026\\.pdf/.test(document.querySelector('[data-missing="file"]').textContent) && !/\\[/.test(document.querySelector('[data-missing="file"]').textContent)`);
    await t.ok("a photo whose text was '[Photo]' still shows the picture", `(()=>{const imgs=[...document.querySelectorAll('.messages .imgwrap img')]; return imgs.length>=2})()`);
    await t.ok("a caption next to a picture is kept", `!!${MSG("Look at the route setter's new project")}`);
  }),

  test("file card: long name truncated in the middle (extension visible), full name in the tooltip, never overflowing, at 360px too", async (t) => {
    for (const phone of [false, true]) {
      if (phone) await t.device("phone");
      await t.open("&ux&chat=wa-1:ux-lena");
      await t.waitFor(`document.querySelector('.filecard .mid')`);
      const r = await t.ev<any>(`(()=>{const c=[...document.querySelectorAll('.filecard:not(.missing)')].find(e=>e.title===${JSON.stringify(LONG)}); const h=c.querySelector('.mh'), tl=c.querySelector('.mt'), body=c.closest('.body').getBoundingClientRect(), cr=c.getBoundingClientRect();
        return {title:c.title, truncated:h.scrollWidth>h.clientWidth, tail:tl.textContent, full:c.querySelector('.mid').textContent, inside:cr.right<=body.right+1, sub:c.querySelector('small').textContent, tailVisible:tl.getBoundingClientRect().right<=cr.right+1, docW:document.documentElement.scrollWidth, W:innerWidth}})()`);
      const n = phone ? "phone: " : "";
      t.check(n + "head is cut with an ellipsis", r.truncated, JSON.stringify(r)); t.check(n + "tail keeps the extension", r.tail.endsWith(".csv") && r.full === LONG, r.tail);
      t.check(n + "tooltip is the full name", r.title === LONG); t.check(n + "card stays inside its bubble", r.inside && r.tailVisible, JSON.stringify(r));
      t.check(n + "size and type on the second line", /47 KB · CSV/.test(r.sub), r.sub); t.check(n + "page does not scroll sideways", r.docW <= r.W, `${r.docW} > ${r.W}`);
      await t.shot(phone ? "filecard-phone" : "filecard");
    }
  }),

  test("meta (time, ticks) floats into the last text line when it has room and takes its own right-aligned row when it does not", async (t) => {
    await t.device("phone"); await t.open("&ux&chat=wa-1:ux-lena");
    await t.waitFor(`${MSG("Short one")}`);
    for (let n = 8; n <= 36; n += 2) await t.ev(`window.__mockInject('wa-1:ux-lena','Lena Hoffmann','${"m".repeat(n)}')`);
    await t.waitFor(`${MSG("m".repeat(36))}`);
    const probe = (s: string) => `(()=>{const m=${MSG(s)}; const p=m.querySelector('p.tx'), f=p.querySelector('.mfoot'), pr=p.getBoundingClientRect(), fr=f.getBoundingClientRect();
      const rg=document.createRange(); rg.selectNodeContents(p.firstChild); const rs=[...rg.getClientRects()], last=rs[rs.length-1];
      return {inline: fr.top < last.bottom-2, fits: last.right+fr.width+12<=pr.right+1, right: Math.abs(fr.right-pr.right)<=1, below: fr.top>=last.bottom-2, lines: rs.length}})()`;
    let inl = 0, own = 0;
    for (let n = 8; n <= 36; n += 2) {
      const r = await t.ev<any>(probe("m".repeat(n)));
      if (r.inline) inl++; else own++;
      t.check(`${n} chars: inline exactly when the last line has room`, r.inline === r.fits, JSON.stringify(r)); t.check(`${n} chars: meta is right-aligned`, r.right, JSON.stringify(r));
    }
    t.check("both layouts occurred (inline and own row)", inl > 0 && own > 0, `${inl}/${own}`);
    const one = await t.ev<any>(`(()=>{const m=${MSG("Short one")}; const b=m.querySelector('.body').getBoundingClientRect(); return b.height})()`);
    t.check("a short message is a one-line bubble (no extra meta row)", one < 40, String(one));
    await t.shot("meta-inline");
  }),

  test("one chip per emoji even when the source lists it twice", async (t) => {
    await t.open("&ux&chat=wa-1:ux-lena");
    await t.waitFor(`${MSG("ok")}`);
    await t.ev(`window.__mockEmit('message-update',{chatId:'wa-1:ux-lena',messageId:[...document.querySelectorAll('.msg')].length&&window.__e2e.msg('ok').dataset.mid,patch:{reactions:[{emoji:'👍',senderIds:['a']},{emoji:'👍',senderIds:['b']},{emoji:'🔥',senderIds:['a']}]}})`);
    await t.eq("two chips", `${MSG("ok")}.querySelectorAll('.reactions .chip:not(.add)').length`, 2);
    await t.ok("the 👍 chip counts both", `/👍\\s*2/.test(${MSG("ok")}.querySelector('.reactions .chip').textContent)`);
  }),
];

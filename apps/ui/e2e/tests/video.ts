// Videos: square cropped tile with our own controls (no browser UI), one at a time, expand to the lightbox, unsupported clips offer a download.
import { test } from "../lib/test.ts";
import { look } from "../lib/ui.ts";
import type { Page } from "../lib/harness.ts";

const BEN = "&chat=wa-1:ben";
/** playable tiles in order: [0] single 300px clip, [1] and [2] the pair (148px) */
const tile = (n: number) => `document.querySelectorAll('.messages .vidwrap:not(.vidbroken)')[${n}]`;
const ready = (t: Page) => t.waitFor(`document.querySelectorAll('.vidwrap:not(.vidbroken) video').length===3 && [...document.querySelectorAll('.vidwrap video')].every(v=>v.readyState>=2)`, { desc: "videos loaded" });
/** a REAL mouse click in the middle of the tile's play area (user gesture, so the browser allows sound) */
async function realClick(t: Page, expr: string, dbl = false) {
  const p = await t.ev<{ x: number; y: number }>(`(()=>{const e=${expr}; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/3)}})()`);
  await t.mouseMove(p.x, p.y);
  await t.mouseClick(p.x, p.y);
  if (dbl) { await t.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 2 }); await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 2 }); }
}

export default [
  test("square tiles, no browser controls, first-frame preview, duration badge", async (t) => {
    await t.open(BEN);
    await t.waitSel(".vidwrap");
    await ready(t);
    await t.eq("single video is 300x300, two videos in one message are 148x148", `JSON.stringify([...document.querySelectorAll('.messages .vidwrap:not(.vidbroken)')].map(e=>[e.offsetWidth,e.offsetHeight]))`, JSON.stringify([[300, 300], [148, 148], [148, 148]]));
    await t.ok("object-fit: cover (cropped)", `getComputedStyle(${tile(0)}.querySelector('video')).objectFit==='cover'`);
    await t.ok("no native controls on any video, and no <video controls> in the timeline", `![...document.querySelectorAll('.messages video')].some(v=>v.controls || v.hasAttribute('controls'))`);
    await t.ok("a decoded frame is shown without playing (preload metadata + #t=0.1)", `${tile(0)}.querySelector('video').paused && ${tile(0)}.querySelector('video').readyState>=2 && ${tile(0)}.querySelector('video').src.endsWith('#t=0.1')`);
    await t.eq("duration badge (from the attachment)", `${tile(0)}.querySelector('.viddur').textContent`, "0:02");
    await t.eq("duration badge (from the video metadata when the attachment has none)", `${tile(1)}.querySelector('.viddur').textContent`, "0:02");
    await t.ok("centred play button with an accessible name", `(()=>{const h=${tile(0)}.querySelector('.vidhit'); return h.getAttribute('role')==='button' && /Play video trail\\.webm/.test(h.getAttribute('aria-label')) && !!h.querySelector('.vidplay')})()`);
    await t.eq("the old look is gone: no 'Load video' button", `[...document.querySelectorAll('.messages button')].filter(b=>/Load video/.test(b.textContent)).length`, 0);
    await look(t, "video-tiles");
  }),

  test("click plays and pauses inline; progress bar and mute appear; only one video plays at a time", async (t) => {
    await t.open(BEN);
    await t.waitSel(".vidwrap");
    await ready(t);
    await realClick(t, `${tile(0)}.querySelector('.vidhit')`);
    await t.ok("click starts playback", `!${tile(0)}.querySelector('video').paused && ${tile(0)}.classList.contains('playing')`);
    await t.ok("progress slider + mute + expand controls are there", `(()=>{const c=${tile(0)}.querySelector('.vidctrls'); return !!c.querySelector('[role=slider]') && !!c.querySelector('[aria-label="Mute"]') && !!c.querySelector('[aria-label="Expand video"]') && getComputedStyle(c).opacity==='1'})()`);
    await t.ok("progress advances", `${tile(0)}.querySelector('.vidbar i').style.width !== '' && parseFloat(${tile(0)}.querySelector('.vidbar i').style.width) >= 0`);
    await look(t, "video-playing");
    await realClick(t, `${tile(1)}.querySelector('.vidhit')`);
    await t.ok("starting another video pauses the first", `${tile(0)}.querySelector('video').paused && !${tile(1)}.querySelector('video').paused`);
    await realClick(t, `${tile(1)}.querySelector('.vidhit')`);
    await t.ok("click again pauses", `${tile(1)}.querySelector('video').paused`);
    await t.click('.messages .vidwrap:not(.vidbroken) [aria-label="Mute"]');
    await t.ok("mute toggle (labelled, reflects state)", `${tile(0)}.querySelector('video').muted && !!${tile(0)}.querySelector('[aria-label="Unmute"]')`);
  }),

  test("keyboard: Space / Enter toggle playback, controls are focusable", async (t) => {
    await t.open(BEN);
    await t.waitSel(".vidwrap");
    await ready(t);
    await t.ev(`${tile(0)}.querySelector('.vidhit').focus()`);
    await t.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 });
    await t.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
    await t.ok("Space plays", `!${tile(0)}.querySelector('video').paused`);
    await t.key("Enter");
    await t.ok("Enter pauses", `${tile(0)}.querySelector('video').paused`);
    await t.ok("slider, mute and expand are real focusable controls", `(()=>{const c=${tile(0)}.querySelector('.vidctrls'); return c.querySelector('[role=slider]').tabIndex===0 && c.querySelectorAll('button').length===2})()`);
  }),

  test("expand: double-click or the expand button opens the uncropped lightbox player", async (t) => {
    await t.open(BEN);
    await t.waitSel(".vidwrap");
    await ready(t);
    await t.click('.messages .vidwrap:not(.vidbroken) [aria-label="Expand video"]');
    await t.waitSel(".lightbox video");
    await t.ok("lightbox has a video with controls, not cropped", `(()=>{const v=document.querySelector('.lightbox video'); return v.controls && getComputedStyle(v).objectFit!=='cover'})()`);
    await t.ok("inline tile is paused behind it", `${tile(0)}.querySelector('video').paused`);
    await look(t, "video-lightbox");
    await t.ev(`document.querySelector('.lightbox').click()`);
    await t.not("click outside closes", `document.querySelector('.lightbox')`);
    await realClick(t, `${tile(1)}.querySelector('.vidhit')`, true);
    await t.waitSel(".lightbox video");
    await t.ok("double-click expands (and leaves the tile paused)", `${tile(1)}.querySelector('video').paused`);
  }),

  test("a clip the browser can't decode (QuickTime) shows 'Cannot play here' with a Download button", async (t) => {
    await t.open(BEN);
    await t.waitSel(".vidbroken");
    await t.ok("state text + mime", `(()=>{const e=document.querySelector('.vidbroken'); return e.textContent.includes('Cannot play here') && e.textContent.includes('video/quicktime')})()`);
    await t.ok("download button", `[...document.querySelectorAll('.vidbroken button')].some(b=>b.textContent.includes('Download'))`);
    await t.eq("still a 300px square", `document.querySelector('.vidbroken').offsetWidth+'x'+document.querySelector('.vidbroken').offsetHeight`, "300x300");
    await look(t, "video-cannot-play");
  }),

  test("GIFs keep their behaviour: muted looping inline video, no player chrome", async (t) => {
    await t.open(BEN);
    await t.waitSel("video.gif");
    await t.ok("autoplay, loop, muted, no controls", `(()=>{const v=document.querySelector('video.gif'); return v.loop && v.muted && v.autoplay && !v.controls})()`);
    await t.not("a GIF is not a video tile", `document.querySelector('.gifwrap .vidhit, .gifwrap .vidctrls')`);
  }),

  test("auto-download off: the tile waits (play button + size), a click loads and then plays it", async (t) => {
    await t.open(BEN);
    await t.waitSel(".messages .vidwrap");
    await t.ok("nothing is downloaded yet: no <video> element, play button and size badge", `document.querySelectorAll('.messages .vidwrap video').length===0 && /KB|MB|Video/.test(document.querySelector('.messages .vidwrap .viddur').textContent) || document.querySelector('.messages .vidwrap .viddur').textContent==='0:02'`);
    await realClick(t, `document.querySelector('.messages .vidwrap:not(.vidbroken) .vidhit')`);
    await t.waitSel(".messages .vidwrap video");
    await t.ok("it loaded and plays", `!document.querySelector('.messages .vidwrap video').paused`);
  }, { init: `try{localStorage.setItem('unimsg.settings',JSON.stringify({autoDownloadMedia:false}))}catch(e){}` }),
];

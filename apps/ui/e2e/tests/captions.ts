// A picture with a long caption: the bubble stays as wide as its pictures and the caption wraps inside it.
import { test } from "../lib/test.ts";

const LONG = "Look at this view from last week, the lake was completely still and we could see all the way to the glacier on the other side 😍";
const SIZES = `(()=>{const m=__e2e.msg("glacier"), r=(e)=>Math.round(e.getBoundingClientRect().width); return {body:r(m.querySelector('.body')), atts:r(m.querySelector('.atts')), tx:r(m.querySelector('.tx'))}})()`;

export default (["desktop", "phone"] as const).map((dev) =>
  test(`caption (${dev}): a long caption wraps under its pictures instead of widening the bubble`, async (t) => {
    if (dev === "phone") await t.device("phone");
    await t.open("&chat=wa-1:anna");
    await t.waitFor(`__e2e.msg("Look at this view")`);
    await t.ev(`(()=>{const m=__e2e.msg("Look at this view"); globalThis.__mockEmit("message-update", { chatId: "wa-1:anna", messageId: m.dataset.mid, patch: { text: ${JSON.stringify(LONG)} } })})()`);
    await t.waitFor(`__e2e.msg("glacier")`);
    const s = await t.ev<{ body: number; atts: number; tx: number }>(SIZES);
    t.check("the caption is exactly as wide as the pictures", Math.abs(s.tx - s.atts) <= 1, JSON.stringify(s));
    t.check("the bubble is not wider than the pictures plus its padding", s.body <= s.atts + 24, JSON.stringify(s));
  }));

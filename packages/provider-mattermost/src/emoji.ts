import { gemoji } from "gemoji";
// Mattermost emoji NAMES <-> unicode. Only the common ones; anything else is shown as ":name:" (custom emoji or unmapped).
// First name listed for a unicode value is the canonical one used when sending.
const TABLE: [string, string][] = [
  ["+1", "👍"], ["thumbsup", "👍"], ["-1", "👎"], ["thumbsdown", "👎"], ["heart", "❤️"], ["red_heart", "❤️"],
  ["smile", "😄"], ["smiley", "😃"], ["grinning", "😀"], ["grin", "😁"], ["laughing", "😆"], ["satisfied", "😆"], ["joy", "😂"],
  ["rofl", "🤣"], ["slightly_smiling_face", "🙂"], ["upside_down_face", "🙃"], ["wink", "😉"], ["blush", "😊"],
  ["innocent", "😇"], ["heart_eyes", "😍"], ["kissing_heart", "😘"], ["yum", "😋"], ["stuck_out_tongue", "😛"],
  ["stuck_out_tongue_winking_eye", "😜"], ["sunglasses", "😎"], ["nerd_face", "🤓"], ["thinking", "🤔"], ["thinking_face", "🤔"],
  ["neutral_face", "😐"], ["expressionless", "😑"], ["smirk", "😏"], ["unamused", "😒"], ["roll_eyes", "🙄"],
  ["grimacing", "😬"], ["relieved", "😌"], ["pensive", "😔"], ["sleepy", "😪"], ["sleeping", "😴"], ["mask", "😷"],
  ["sweat_smile", "😅"], ["sweat", "😓"], ["disappointed", "😞"], ["worried", "😟"], ["angry", "😠"], ["rage", "😡"],
  ["cry", "😢"], ["sob", "😭"], ["scream", "😱"], ["confounded", "😖"], ["astonished", "😲"], ["open_mouth", "😮"],
  ["hushed", "😯"], ["flushed", "😳"], ["zipper_mouth_face", "🤐"], ["hugs", "🤗"], ["face_palm", "🤦"], ["facepalm", "🤦"],
  ["shrug", "🤷"], ["skull", "💀"], ["ghost", "👻"], ["poop", "💩"], ["hankey", "💩"], ["see_no_evil", "🙈"],
  ["clap", "👏"], ["raised_hands", "🙌"], ["pray", "🙏"], ["handshake", "🤝"], ["wave", "👋"], ["ok_hand", "👌"],
  ["v", "✌️"], ["crossed_fingers", "🤞"], ["muscle", "💪"], ["point_up", "☝️"], ["point_down", "👇"], ["point_left", "👈"],
  ["point_right", "👉"], ["raised_hand", "✋"], ["fist", "✊"], ["eyes", "👀"], ["brain", "🧠"],
  ["broken_heart", "💔"], ["blue_heart", "💙"], ["green_heart", "💚"], ["yellow_heart", "💛"], ["purple_heart", "💜"],
  ["black_heart", "🖤"], ["sparkling_heart", "💖"], ["100", "💯"], ["fire", "🔥"], ["star", "⭐"], ["sparkles", "✨"],
  ["boom", "💥"], ["zap", "⚡"], ["tada", "🎉"], ["confetti_ball", "🎊"], ["balloon", "🎈"], ["gift", "🎁"],
  ["trophy", "🏆"], ["medal", "🏅"], ["rocket", "🚀"], ["bulb", "💡"], ["bell", "🔔"], ["warning", "⚠️"],
  ["white_check_mark", "✅"], ["heavy_check_mark", "✔️"], ["ballot_box_with_check", "☑️"], ["x", "❌"], ["negative_squared_cross_mark", "❎"],
  ["question", "❓"], ["exclamation", "❗"], ["heavy_exclamation_mark", "❗"], ["bangbang", "‼️"], ["no_entry", "⛔"],
  ["heavy_plus_sign", "➕"], ["heavy_minus_sign", "➖"], ["arrow_up", "⬆️"], ["arrow_down", "⬇️"], ["recycle", "♻️"],
  ["coffee", "☕"], ["beer", "🍺"], ["beers", "🍻"], ["pizza", "🍕"], ["cake", "🍰"], ["apple", "🍎"],
  ["sunny", "☀️"], ["cloud", "☁️"], ["umbrella", "☔"], ["snowflake", "❄️"], ["rainbow", "🌈"], ["tree", "🌲"],
  ["dog", "🐶"], ["cat", "🐱"], ["unicorn", "🦄"], ["bug", "🐛"], ["penguin", "🐧"],
  ["computer", "💻"], ["phone", "☎️"], ["email", "📧"], ["memo", "📝"], ["pushpin", "📌"], ["link", "🔗"],
  ["lock", "🔒"], ["key", "🔑"], ["hourglass", "⌛"], ["clock", "🕐"], ["calendar", "📅"], ["eyes_right", "👀"],
  ["muscle_tone", "💪"], ["tongue", "👅"], ["salute", "🫡"], ["pleading_face", "🥺"], ["partying_face", "🥳"],
  ["exploding_head", "🤯"], ["face_with_monocle", "🧐"], ["rolling_on_the_floor_laughing", "🤣"],
];
const toUnicode = new Map<string, string>();
const toName = new Map<string, string>();
for (const [n, u] of TABLE) { if (!toUnicode.has(n)) toUnicode.set(n, u); if (!toName.has(strip(u))) toName.set(strip(u), n); }
// The hand-written table above wins (Mattermost's own names); the full gemoji shortcode set fills in everything else.
for (const e of gemoji) for (const n of e.names) { if (!toUnicode.has(n)) toUnicode.set(n, e.emoji); if (!toName.has(strip(e.emoji))) toName.set(strip(e.emoji), n); }
function strip(s: string) { return s.replace(/️/g, ""); }

/** Mattermost reaction name (may carry "::skin-tone-N") -> unicode, or ":name:" when unknown (custom emoji). */
export function emojiFromName(name: string): string {
  const base = name.split("::")[0];
  return toUnicode.get(base) ?? `:${base}:`;
}
/** Reaction.emoji (unicode or ":name:") -> Mattermost name, or undefined when we cannot map it. */
export function emojiToName(emoji: string): string | undefined {
  const m = /^:([A-Za-z0-9_+\-]+):$/.exec(emoji.trim());
  if (m) return m[1];
  return toName.get(strip(emoji.trim()));
}

/** Replace standard :shortcodes: in message text with unicode; unknown names (custom emoji) stay as :name:. Code spans are left alone. */
export function shortcodesToUnicode(text: string): string {
  if (!text.includes(":")) return text;
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(/:([A-Za-z0-9_+-]{2,64}):/g, (m, n) => { const u = emojiFromName(n); return u.startsWith(":") ? m : u; }))).join("");
}

// "[Photo]", "[Voice message]", "[File: name.csv]" ... : the stand-in text importers (and some bridges) put into a message whose media they
// could not carry. When the real attachment IS there, the stand-in is noise: the UI hides it and the Hub's cleanup removes it.
export type PlaceholderKind = "image" | "video" | "voice" | "audio" | "sticker" | "gif" | "file";
const RE = /^\[\s*(photo|image|picture|video|voice message|voice note|audio|sticker|gif|file|document|attachment)\s*(?::\s*([^\n]*?))?\s*\]$/i;
const KIND: Record<string, PlaceholderKind> = { photo: "image", image: "image", picture: "image", video: "video", "voice message": "voice", "voice note": "voice", audio: "audio", sticker: "sticker", gif: "gif", file: "file", document: "file", attachment: "file" };

/** The whole (trimmed) text is one placeholder: what it stands for and the file name it carries, if any. */
export function placeholderOf(text: string | undefined): { kind: PlaceholderKind; name?: string } | undefined {
  const m = RE.exec((text ?? "").trim()); if (!m) return undefined;
  return { kind: KIND[m[1]!.toLowerCase()]!, ...(m[2] ? { name: m[2] } : {}) };
}
/** `text` without placeholder lines (a caption plus a trailing "[Photo]" keeps the caption). Unchanged when there is none. */
export function stripPlaceholder(text: string): string {
  if (!text) return text;
  const lines = text.split("\n"), keep = lines.filter((l) => !RE.test(l.trim()));
  return keep.length === lines.length ? text : keep.join("\n").trim();
}

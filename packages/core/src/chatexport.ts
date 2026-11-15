// "Export this chat": a human-readable, self-contained HTML page (images inlined when cached) or JSON of one chat (merged chats too).
import type { Message } from "./model.js";
import { isMergeId } from "./model.js";
import type { BackupHost } from "./backup.js";
import { cardsOf } from "./model.js";

export interface ChatExportOptions { chatId: string; format: "html" | "json"; from?: string; to?: string; title?: string }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const MAX_INLINE = 5 * 1024 * 1024, MAX_TOTAL = 150 * 1024 * 1024;

export async function exportChatDocument(h: BackupHost, o: ChatExportOptions) {
  if (!o.chatId) throw new Error("Choose a chat.");
  const ids = isMergeId(o.chatId) ? (h.store.listMerges().find((m) => m.id === o.chatId)?.members ?? []) : [o.chatId];
  if (!ids.length) throw new Error("That chat no longer exists.");
  const from = o.from ? new Date(o.from).toISOString() : "", to = o.to ? new Date(new Date(o.to).getTime() + (/^\d{4}-\d\d-\d\d$/.test(o.to) ? 864e5 : 0)).toISOString() : "";
  const msgs: Message[] = [];
  for (const id of ids) {
    let before: string | undefined;
    for (;;) {
      const page = h.store.listMessages(id, { beforeTime: before, limit: 1000 });
      if (!page.length) break;
      msgs.unshift(...page); before = page[0].time;
      if (from && page[0].time < from) break;
      if (page.length < 1000) break;
    }
  }
  const list = msgs.filter((m) => (!from || m.time >= from) && (!to || m.time < to)).sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  let name = o.title ?? "";
  if (!name) { const al = h.store.listAliases()[o.chatId]; name = al ?? (h.store.listMerges().find((m) => m.id === o.chatId)?.name) ?? ""; }
  if (!name) for (const a of h.store.listAccounts()) { const c = h.store.getChatCache(a.id)?.chats.find((x) => x.id === o.chatId); if (c) name = c.name; }
  name ||= "Chat";
  const base = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 60) || "chat";
  if (o.format === "json") {
    const body = JSON.stringify({ app: "UniChat", exportedAt: new Date().toISOString(), chat: { id: o.chatId, name }, messages: list }, null, 2);
    return { filename: `${base}.json`, mime: "application/json", dataBase64: Buffer.from(body).toString("base64"), count: list.length };
  }
  let total = 0;
  const img = (m: Message, attId: string, mime: string) => {
    const acc = m.accountId ?? m.chatId.split(":")[0];
    const b = h.media.get(acc, `${m.chatId}|${m.id}|${attId}`);
    if (!b || b.data.length > MAX_INLINE || total + b.data.length > MAX_TOTAL) return "";
    total += b.data.length;
    return `<img alt="" src="data:${esc(b.mime || mime)};base64,${Buffer.from(b.data).toString("base64")}">`;
  };
  const rows = list.map((m) => {
    const parts: string[] = [];
    if (m.deleted) parts.push("<i>This message was deleted</i>");
    else {
      if (m.text) parts.push(`<p>${esc(m.text).replace(/\n/g, "<br>")}</p>`);
      for (const a of m.attachments ?? []) {
        const inl = a.kind === "image" || a.kind === "sticker" ? img(m, a.id, a.mime) : "";
        parts.push(inl || `<p class="att">[${esc(a.kind)}: ${esc(a.name ?? a.mime)}]</p>`);
      }
      if (m.location) parts.push(`<p class="att">Location: ${esc(m.location.name ?? `${m.location.lat}, ${m.location.lng}`)}</p>`);
      if (m.poll) parts.push(`<p class="att">Poll: ${esc(m.poll.question)} (${m.poll.options.map((x) => esc(x.text)).join(", ")})</p>`);
      for (const c of cardsOf(m)) parts.push(`<p class="att">${esc(c.title)}${c.subtitle ? " - " + esc(c.subtitle) : ""}</p>`);
      if (m.reactions?.length) parts.push(`<p class="rx">${m.reactions.map((r) => esc(r.emoji) + " " + (r.count ?? r.senderIds.length)).join("  ")}</p>`);
    }
    const reply = m.replyTo ? `<div class="reply">${esc(m.replyTo.sender ?? "")}: ${esc(m.replyTo.textPreview ?? "")}</div>` : "";
    return `<div class="m ${m.fromMe ? "me" : ""}"><div class="meta"><b>${esc(m.fromMe ? "Me" : m.sender)}</b> <time>${esc(m.time.replace("T", " ").slice(0, 16))}</time>${m.editedAt ? " (edited)" : ""}</div>${reply}${parts.join("")}</div>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)}</title>
<style>body{font:15px/1.45 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;background:#f4f4f6;color:#1c1c20}h1{font-size:20px}
.m{background:#fff;border-radius:10px;padding:8px 12px;margin:8px 0;max-width:85%}.m.me{margin-left:auto;background:#dff3e1}.meta{font-size:12px;color:#666}.meta time{margin-left:6px}
p{margin:4px 0}.att,.rx{color:#555;font-size:13px}.reply{border-left:3px solid #aaa;padding-left:8px;color:#666;font-size:13px;margin:4px 0}img{max-width:100%;border-radius:6px;display:block;margin:4px 0}
@media(prefers-color-scheme:dark){body{background:#17171a;color:#e8e8ec}.m{background:#26262b}.m.me{background:#1f3a26}.meta,.att,.rx,.reply{color:#9a9aa5}}</style></head>
<body><h1>${esc(name)}</h1><p class="att">${list.length} messages, exported from UniChat on ${esc(new Date().toISOString().slice(0, 10))}</p>
${rows}</body></html>`;
  return { filename: `${base}.html`, mime: "text/html", dataBase64: Buffer.from(html).toString("base64"), count: list.length };
}

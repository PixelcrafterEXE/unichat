// Mock backend of the WhatsApp history import (whatsappBackupInspect / whatsappBackupImport / whatsappBackupCancel) for the mock UI (?mock).
// A mock "backup file" is a text file `MOCKWA:<crypt15|crypt14>:<64 hex | keyfile>[:mismatch|:unknown|:slow|:nomedia]`; files come from window.__mockFiles (desktop dialog)
// or are any upload (then a valid crypt15 backup with the demo key is assumed). `?mock&whatsappimport` also mounts the import page on its own. Every call is recorded in __mockWhatsAppImportLog (keys redacted).
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { WhatsAppBackupImport } from "./WhatsAppBackupImport";

type Emit = (ev: string, d: unknown) => void;
const METHODS = new Set(["whatsappBackupInspect", "whatsappBackupImport", "whatsappBackupCancel"]);
export const DEMO_KEY = "0123456789abcdef".repeat(4);
const ENABLED = typeof location !== "undefined" && new URLSearchParams(location.search).has("whatsappimport");
export const mockWhatsAppImportHandles = (m: string) => METHODS.has(m);
const log: { method: string; params: any }[] = []; (globalThis as any).__mockWhatsAppImportLog = log;
let cancelled = false, running = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (p: any): string => (p.path ? ((globalThis as any).__mockFiles?.[p.path] ?? "") : `MOCKWA:crypt15:${DEMO_KEY}`);
function parse(p: any) {
  const t = read(p); if (!t.startsWith("MOCKWA:")) { const e: any = new Error("This is not a WhatsApp crypt14/crypt15 backup (the header is not recognised)."); e.code = "not-a-backup"; throw e; }
  const [, fmt, secret, flag] = t.split(":"), c14 = fmt === "crypt14";
  if (c14) { if (!p.keyFileBase64) throw new Error("This is an older crypt14 backup. It can only be opened with the 158-byte `key` file from the phone, which needs a rooted phone."); }
  else if (String(p.key ?? "") !== secret) throw new Error(String(p.key ?? "").length === 64 ? "Wrong key, or this is not a WhatsApp backup made with it. Check the 64 digits and try again. Nothing was imported." : "Enter the 64-digit encryption key (0-9 and a-f) that WhatsApp showed when you switched on end-to-end encrypted backup.");
  return { c14, flag };
}

export async function mockWhatsAppImportCall(method: string, p: any, emit: Emit): Promise<any> {
  log.push({ method, params: JSON.parse(JSON.stringify({ ...p, key: p?.key ? "<redacted>" : undefined, keyFileBase64: p?.keyFileBase64 ? "<redacted>" : undefined, _len: String(p?.key ?? "").length })) });
  switch (method) {
    case "whatsappBackupCancel": cancelled = true; return { cancelled: running };
    case "whatsappBackupInspect": {
      const { c14, flag } = parse(p);
      emit("backup-progress", { op: "whatsapp-inspect", stage: "verifying", done: 1, total: 2 }); await sleep(80); emit("backup-progress", { op: "whatsapp-inspect", stage: "counting", done: 2, total: 2 });
      const media = flag !== "nomedia" || !!p.mediaPath;
      return { format: c14 ? "crypt14" : "crypt15", size: 80_000_000, whatsappVersion: "2.25.1.2", messages: flag === "big" ? 200_000 : 1234, chats: { total: 6, dms: 4, groups: 2, unresolved: 0 },
        attachments: { count: 40, bytes: 31_000_000, present: media ? 38 : 0, missing: media ? 2 : 40 }, firstAt: "2019-03-01T10:00:00.000Z", lastAt: "2026-11-01T18:30:00.000Z", skipped: { "system-59": 12, call: 3 },
        warnings: [], topChats: [{ name: "Anna Alder", kind: "dm", messages: 700 }, { name: "Hikers", kind: "group", messages: 400 }], canAttachments: media, mediaFolder: media,
        accounts: [{ id: "wa-1", label: "WhatsApp · +49 151 2345", match: flag === "mismatch" ? "mismatch" : flag === "unknown" ? "unknown" : "match" }] };
    }
    case "whatsappBackupImport": {
      const { flag } = parse(p);
      if (flag === "mismatch" && !p.confirmMismatch) throw new Error("This backup seems to belong to a different WhatsApp number than the account you chose. Nothing was imported.");
      if (flag === "unknown" && !p.confirmUnverified) throw new Error("UniChat cannot check that this backup belongs to this account.");
      cancelled = false; running = true;
      try {
        for (let i = 0; i <= 6; i++) { if (cancelled) throw new Error("Cancelled. Nothing was imported."); emit("backup-progress", { op: "whatsapp-import", stage: i < 2 ? "verifying" : "importing", done: i, total: 6 }); await sleep(flag === "slow" ? 400 : 100); }
      } finally { running = false; }
      emit("backup-progress", { op: "whatsapp-import", stage: "finished", done: 1, total: 1 }); emit("chats-changed", { accountId: "wa-1" });
      const att = !!p.options?.attachments;
      return { messages: { added: 1200, filled: 3, existing: 31, total: 1234 }, chats: { created: 5, merged: 1, total: 6 }, attachments: { stored: att ? 36 : 0, missing: att ? 2 : 0, mismatch: att ? 1 : 0, skipped: att ? 0 : 40 }, skipped: {}, accountId: "wa-1", warnings: [] };
    }
  }
}

if (ENABLED && !new URLSearchParams(location.search).has("settings") && typeof document !== "undefined") {
  const mount = () => { const el = document.createElement("div"); el.id = "wbi-host"; el.style.cssText = "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bg,#1e1f22);color:var(--text,#ddd);padding:16px 24px"; document.body.appendChild(el);
    createRoot(el).render(createElement(WhatsAppBackupImport, { onOpenChats: (id: string) => { (globalThis as any).__wbiOpened = id; } })); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
}

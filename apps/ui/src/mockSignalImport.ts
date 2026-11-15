// Mock backend of the Signal history import (signalBackupInspect / signalBackupImport / signalBackupCancel) for the mock UI (?mock).
// A mock "backup file" is a text file `MOCKSIG:<legacy|secure>:<30 digits | 64 chars>[:mismatch|:unknown|:big]`; files come from window.__mockFiles (desktop dialog)
// or are any upload (then a valid legacy backup with the demo passphrase is assumed). `?mock&signalimport` also mounts the import page on its own, so it can be
// tested before it is placed in Settings. Every call is recorded in __mockSignalImportLog.
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SignalBackupImport } from "./SignalBackupImport";

type Emit = (ev: string, d: unknown) => void;
const METHODS = new Set(["signalBackupInspect", "signalBackupImport", "signalBackupCancel"]);
export const DEMO_PASS = "123456789012345678901234567890", DEMO_KEY = "a".repeat(64);
const SIGNAL_ACCOUNT = { id: "sg-1", provider: "signal", label: "Signal · +49 160 555", state: "connected", everLinked: true };
const ENABLED = typeof location !== "undefined" && new URLSearchParams(location.search).has("signalimport");
/** With ?signalimport the mock grows a linked Signal account (it is not part of the regular mock seed). */
export const mockSignalImportAccounts = <T,>(base: T[]): T[] => (ENABLED ? [...base, SIGNAL_ACCOUNT as unknown as T] : base);
export const mockSignalImportHandles = (m: string) => METHODS.has(m) || (ENABLED && m === "accounts");
const log: { method: string; params: any }[] = []; (globalThis as any).__mockSignalImportLog = log;
let cancelled = false, running = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (p: any): string => (p.path ? ((globalThis as any).__mockFiles?.[p.path] ?? "") : `MOCKSIG:legacy:${DEMO_PASS}`);
function parse(p: any) {
  const t = read(p); if (!t.startsWith("MOCKSIG:")) { const e: any = new Error("This is not a Signal Android backup file."); e.code = "not-a-backup"; throw e; }
  const [, fmt, secret, flag] = t.split(":"), legacy = fmt === "legacy", given = String(p.passphrase ?? "");
  if (given !== secret || (legacy ? given.length !== 30 : given.length !== 64)) throw new Error(legacy ? "Wrong passphrase, or this is not a Signal backup. Check the 30 digits and try again." : "Wrong backup key or account, or the file is damaged or not a Signal Secure Backup. Nothing was imported.");
  return { legacy, flag };
}

export async function mockSignalImportCall(method: string, p: any, emit: Emit, accounts: any[] = []): Promise<any> {
  if (method === "accounts") return [...accounts, SIGNAL_ACCOUNT];
  log.push({ method, params: JSON.parse(JSON.stringify({ ...p, passphrase: p?.passphrase ? "<redacted>" : undefined, _len: String(p?.passphrase ?? "").length })) });
  switch (method) {
    case "signalBackupCancel": cancelled = true; return { cancelled: running };
    case "signalBackupInspect": {
      const { legacy, flag } = parse(p);
      emit("backup-progress", { op: "signal-inspect", stage: "verifying", done: 1, total: 2 }); await sleep(80); emit("backup-progress", { op: "signal-inspect", stage: "counting", done: 2, total: 2 });
      return { format: legacy ? "android-legacy" : "secure-backup", size: 52_000_000, own: { aci: "mock-me" }, messages: flag === "big" ? 200_000 : 1234, chats: { total: 6, dms: 4, groups: 2, unresolved: 1 }, attachments: { count: 40, bytes: 31_000_000 },
        firstAt: "2019-03-01T10:00:00.000Z", lastAt: "2026-11-01T18:30:00.000Z", skipped: { noise: 12 }, canAttachments: legacy || flag === "media",
        warnings: legacy ? ["1 conversations only know a phone number, not a Signal account id. They are imported as separate chats named by number and are not merged with live chats."] : [],
        topChats: [{ name: "Anna Alder", kind: "dm", messages: 700 }, { name: "Hikers", kind: "group", messages: 400 }],
        accounts: [{ id: "sg-1", label: SIGNAL_ACCOUNT.label, aci: flag === "mismatch" ? "other" : "mock-me", match: flag === "mismatch" ? "mismatch" : flag === "unknown" ? "unknown" : "match" }] };
    }
    case "signalBackupImport": {
      const { flag } = parse(p);
      if (flag === "mismatch" && !p.confirmMismatch) throw new Error("This backup belongs to a different Signal account than the one you chose. Nothing was imported.");
      if (flag === "unknown" && !p.confirmUnverified) throw new Error("The account is not signed in right now, so UniChat cannot check that this backup is its own.");
      cancelled = false; running = true;
      try {
        for (let i = 0; i <= 6; i++) { if (cancelled) throw new Error("Cancelled. Nothing was imported."); emit("backup-progress", { op: "signal-import", stage: i < 2 ? "verifying" : "importing", done: i, total: 6 }); await sleep(flag === "slow" ? 400 : 100); }
      } finally { running = false; }
      emit("backup-progress", { op: "signal-import", stage: "finished", done: 1, total: 1 }); emit("chats-changed", { accountId: "sg-1" });
      return { messages: { added: 1200, filled: 3, existing: 31, total: 1234 }, chats: { created: 5, merged: 1, total: 6 }, attachments: { stored: p.options?.attachments ? 38 : 0, missing: p.options?.attachments ? 2 : 0, skipped: p.options?.attachments ? 0 : 40 }, skipped: {}, accountId: "sg-1",
        warnings: [] };
    }
  }
}

if (ENABLED && !new URLSearchParams(location.search).has("settings") && typeof document !== "undefined") {
  const mount = () => { const el = document.createElement("div"); el.id = "sbi-host"; el.style.cssText = "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bg,#1e1f22);color:var(--text,#ddd);padding:16px 24px"; document.body.appendChild(el);
    createRoot(el).render(createElement(SignalBackupImport, { onOpenChats: (id: string) => { (globalThis as any).__sbiOpened = id; } })); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
}

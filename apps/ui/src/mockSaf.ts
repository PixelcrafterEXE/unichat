// Mock of the Android "Find the backup on this phone" bridge ($backupLocate / $backupCopy / $backupCopyCancel / $backupDiscard) for the mock UI (?mock).
// Enabled by window.__mockSaf (set it in an e2e init script; a string "nomedia" / "empty" / "cancel" picks a variant). Every call is recorded in __mockSafLog.
// The copied "file" is registered in window.__mockFiles under the returned path so the mock importers read it: content comes from window.__mockSafContent.
type Emit = (ev: string, d: unknown) => void;
const METHODS = new Set(["$backupLocate", "$backupCopy", "$backupCopyCancel", "$backupDiscard"]);
export const mockSafHandles = (m: string) => METHODS.has(m);
const log: { method: string; params: any }[] = []; (globalThis as any).__mockSafLog = log;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let cancelled = false;
export async function mockSafCall(method: string, p: any, emit: Emit): Promise<any> {
  const g = globalThis as any, v = String(g.__mockSaf ?? "");
  log.push({ method, params: JSON.parse(JSON.stringify(p ?? {})) });
  switch (method) {
    case "$backupLocate": {
      if (v === "cancel") return { cancelled: true };
      await sleep(60);
      if (p.kind === "signal") return { kind: "signal", folder: "Backups", hasMedia: false, media: [], files: v === "empty" ? [] : [{ name: "signal-2026-11-10-04-00-00.backup", size: 120_000_000, modified: 1_789_000_000_000 }, { name: "signal-2026-10-01-04-00-00.backup", size: 90_000_000, modified: 1_780_000_000_000 }] };
      return { kind: "whatsapp", folder: "WhatsApp", hasMedia: v !== "nomedia", files: v === "empty" ? [] : [{ name: "msgstore.db.crypt15", size: 32_485_598, modified: 1_789_000_000_000 }, { name: "msgstore-2026-11-14.1.db.crypt14", size: 32_612_206, modified: 1_788_000_000_000 }],
        media: v === "nomedia" ? [] : [{ name: "WhatsApp Images", bytes: 3_500_000_000, files: 12000 }, { name: "WhatsApp Video", bytes: 2_500_000_000, files: 300 }, { name: "WhatsApp Documents", bytes: 80_000_000, files: 90 }] };
    }
    case "$backupCopy": {
      cancelled = false;
      for (let i = 0; i <= 4; i++) { if (cancelled) throw new Error("Copy cancelled."); emit("backup-progress", { op: "saf-copy", stage: "copying", done: i * 1000, total: 4000 }); await sleep(g.__mockSafSlow ? 300 : 40); }
      const dir = p.kind === "signal" ? "/data/.backup/saf/signal" : "/data/.backup/saf/whatsapp/WhatsApp/Databases", path = `${dir}/${p.name}`;
      g.__mockFiles = { ...(g.__mockFiles ?? {}), [path]: g.__mockSafContent ?? "" };
      return { path, name: p.name, bytes: 1000, mediaFiles: p.media?.length ? 4242 : 0, ...(p.media?.length ? { mediaPath: "/data/.backup/saf/whatsapp/WhatsApp" } : {}) };
    }
    case "$backupCopyCancel": cancelled = true; return { ok: true };
    default: return { ok: true };
  }
}

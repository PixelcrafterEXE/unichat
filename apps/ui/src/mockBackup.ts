// Tiny in-memory stand-in for the backup RPCs so the Data settings can be tested without a backend.
// A "backup file" for the mock is any file whose text is `MOCKBK:<passphrase>` (+ optional `:sessions`).
type Emit = (ev: string, d: unknown) => void;
const METHODS = new Set(["exportEstimate", "exportData", "importInspect", "importData", "backupCancel", "backupUploadStart", "backupUploadChunk", "backupUploadEnd", "backupDownloadChunk", "backupDiscard", "movedAccounts", "moveAwayAccount", "confirmMovedAccount", "dismissMovedAccount", "exportChat"]);
export const mockBackupHandles = (m: string) => METHODS.has(m);
// every backup call is recorded here so e2e tests can assert what the UI sent
const log: { method: string; params: any }[] = []; (globalThis as any).__mockBackupLog = log;
const awayIds = new Set<string>();
const uploads = new Map<string, string>(); let moved: { accountId: string; at: string; from: string }[] = []; let cancelled = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function mockBackupCall(method: string, p: any, emit: Emit): Promise<any> {
  log.push({ method, params: JSON.parse(JSON.stringify(p ?? {})) });
  switch (method) {
    case "exportEstimate": return { counts: { message: 1234, account: 3, alias: 2, folder: 1, merge: 1 }, media: { files: 40, bytes: 52_000_000 }, sessions: { files: 6, bytes: 90_000 },
      accounts: [{ id: "wa-1", provider: "whatsapp", label: "WhatsApp · +49 151 2345", status: awayIds.has("wa-1") ? "archived" : "active", sessionFiles: 3 }, { id: "dc-1", provider: "discord", label: "Discord · UniChat Bot", status: awayIds.has("dc-1") ? "archived" : "active", sessionFiles: 2 },
        { id: "mx-1", provider: "matrix", label: "@michi:matrix.org", status: "archived", sessionFiles: 1 }], zstd: false, canChoosePath: true };
    case "moveAwayAccount": if (!p.confirmedSaved) throw new Error("Confirm that the backup file is saved first."); awayIds.add(p.accountId); return { accountId: p.accountId };
    case "exportData": {
      if (!p.passphrase || p.passphrase.length < 8) throw new Error("Choose a passphrase of at least 8 characters.");
      cancelled = false;
      for (let i = 0; i <= 5; i++) { if (cancelled) throw new Error("Cancelled."); emit("backup-progress", { op: "export", stage: i < 3 ? "data" : "media", done: i, total: 5 }); await sleep(120); }
      emit("backup-progress", { op: "export", stage: "finished", done: 1, total: 1 });
      return { name: "unimsg-2026-11-13-10-00.unimsg-backup", size: 4_200_000 + (p.parts?.media ? 52_000_000 : 0), sha256: "a".repeat(8) + "0123456789abcdef".repeat(3) + "b".repeat(8), ...(p.targetPath ? { path: p.targetPath } : { downloadId: "mock-dl" }), parts: p.parts, warnings: [] };
    }
    case "backupCancel": cancelled = true; return {};
    case "backupUploadStart": { const id = "up" + uploads.size; uploads.set(id, ""); return { id }; }
    case "backupUploadChunk": uploads.set(p.id, uploads.get(p.id)! + atob(p.dataBase64)); return {};
    case "backupUploadEnd": return { id: p.id };
    case "importInspect": case "importData": {
      const t = p.path ? ((globalThis as any).__mockFiles?.[p.path] ?? "") : uploads.get(p.uploadId) ?? "";
      if (!t.startsWith("MOCKBK:")) throw new Error("This file is not an Unimsg backup.");
      const [, pass, sess, login] = t.split(":");
      if (pass !== p.passphrase) throw new Error("Wrong passphrase. Nothing was imported.");
      const accounts = [{ src: "wa-9", dst: "wa-9", provider: "whatsapp", label: "Old phone", outcome: "added", hasSession: !!sess }, ...(login ? [] : [{ src: "mx-1", dst: "mx-1", provider: "matrix", label: "Work", outcome: "matched", hasSession: false }])];
      if (method === "importInspect") return { manifest: { app: "unimsg", appVersion: "0.1.0", createdAt: "2026-11-12T08:00:00Z", source: { name: "laptop" }, parts: { data: !login, media: false, sessions: !!sess }, counts: { message: 1234, account: accounts.length }, sessionFiles: sess ? 6 : 0 }, targetEmpty: false, suggestedMode: "merge", accounts };
      emit("backup-progress", { op: "import", stage: "verifying", done: 1, total: 2 }); await sleep(100); emit("backup-progress", { op: "import", stage: "restoring", done: 2, total: 2 });
      if (sess && p.parts?.sessions !== false) moved = [{ accountId: "wa-9", at: new Date().toISOString(), from: "laptop" }];
      emit("accounts-changed", {});
      return { mode: p.mode, accounts, messages: { added: 1200, existing: 34 }, mediaFiles: 0, sessionFiles: moved.length ? 6 : 0, needSignIn: 1, moved: moved.map((m) => m.accountId), warnings: [] };
    }
    case "movedAccounts": return moved;
    case "confirmMovedAccount": case "dismissMovedAccount": moved = moved.filter((m) => m.accountId !== p.accountId); return {};
    case "exportChat": return { filename: "chat.html", mime: "text/html", dataBase64: btoa("<p>mock</p>"), count: 3 };
  }
}

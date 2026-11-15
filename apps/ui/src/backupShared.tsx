// Helpers shared by the Data settings (BackupPanel) and the "Move login to another device" wizard (MoveLogin).
import { useEffect, useState } from "react";
import { core } from "./util";
import { getToken } from "./api";

export const w = window as any;
export const kind = (): "mock" | "ws" | "ipc" => (new URLSearchParams(location.search).has("mock") ? "mock" : w.unimsg || w.UnimsgNative ? "ipc" : "ws");
export const httpBase = () => { const u = new URL(import.meta.env.VITE_CORE_URL ?? `ws://${location.hostname}:8765/ws`); u.protocol = u.protocol === "wss:" ? "https:" : "http:"; u.pathname = ""; return u.origin; };

/** Native file dialogs of the desktop shell (window.unimsg.showSaveDialog / showOpenDialog / revealInFolder, see apps/desktop/src/preload.ts). null in the browser and on the phone. */
export interface NativeDialogs {
  showSaveDialog(req?: { suggestedName?: string }): Promise<{ canceled: boolean; path?: string }>;
  showOpenDialog(): Promise<{ canceled: boolean; path?: string }>;
  revealInFolder(path: string): Promise<unknown>;
}
export const native = (): NativeDialogs | null => (typeof w.unimsg?.showSaveDialog === "function" && typeof w.unimsg?.showOpenDialog === "function" ? (w.unimsg as NativeDialogs) : null);
export const stamp = () => new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);

export function passphraseStrength(p: string): { level: "weak" | "ok" | "strong"; text: string } {
  const pool = (/[a-z]/.test(p) ? 26 : 0) + (/[A-Z]/.test(p) ? 26 : 0) + (/\d/.test(p) ? 10 : 0) + (/[^A-Za-z0-9]/.test(p) ? 32 : 0);
  const bits = p.length * Math.log2(Math.max(pool, 2));
  if (p.length < 8 || bits < 40) return { level: "weak", text: "Weak: use at least 8 characters, ideally four or more random words." };
  if (bits < 70) return { level: "ok", text: "Okay. A longer phrase (four or more random words) is much safer." };
  return { level: "strong", text: "Strong." };
}

/** Where should the archive go? Desktop: ask the OS dialog first (the chosen path is then passed as targetPath); browser: a download ticket. */
export async function chooseTarget(suggestedName: string): Promise<{ canceled?: boolean; targetPath?: string; deliver?: "download" }> {
  const nat = native();
  if (nat) { const r = await nat.showSaveDialog({ suggestedName }); return r.canceled || !r.path ? { canceled: true } : { targetPath: r.path }; }
  return kind() === "ws" || (kind() === "ipc" && w.showSaveFilePicker) || kind() === "mock" ? { deliver: "download" } : {};
}

/** Hand the archive to the user: file already written at a chosen path (desktop: revealed in the file manager), browser download or save-file picker. */
export async function deliver(r: any): Promise<string> {
  if (!r.downloadId) {
    if (r.path) { void native()?.revealInFolder(r.path).catch(() => {}); return `Saved to ${r.path}`; }
    return "Saved.";
  }
  const k = kind();
  if (k === "ws") {
    const t = getToken(), a = document.createElement("a");
    a.href = `${httpBase()}/backup/download/${r.downloadId}${t ? `?token=${encodeURIComponent(t)}` : ""}`; a.download = r.name; document.body.appendChild(a); a.click(); a.remove();
    return "Your browser is downloading the file.";
  }
  if (k === "ipc" && w.showSaveFilePicker) {
    const fh = await w.showSaveFilePicker({ suggestedName: r.name }), out = await fh.createWritable();
    for (let off = 0; ;) { const c = await core.call("backupDownloadChunk", { id: r.downloadId, offset: off, length: 4 << 20 }); const bin = Uint8Array.from(atob(c.dataBase64), (ch) => ch.charCodeAt(0)); await out.write(bin); off += bin.length; if (c.end) break; }
    await out.close(); await core.call("backupDiscard", { id: r.downloadId }); return `Saved as ${fh.name}.`;
  }
  return "Export finished.";
}
export async function upload(f: File, onPct: (p: number) => void): Promise<string> {
  if (kind() === "ws") {
    const t = getToken();
    const res = await fetch(`${httpBase()}/backup/upload`, { method: "POST", body: f, headers: { "x-backup-name": f.name, ...(t ? { authorization: `Bearer ${t}` } : {}) } });
    const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error ?? `Upload failed (${res.status})`); onPct(1); return j.id;
  }
  const { id } = await core.call("backupUploadStart", { size: f.size, name: f.name });
  for (let off = 0; off < f.size; off += 4 << 20) {
    const buf = new Uint8Array(await f.slice(off, off + (4 << 20)).arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await core.call("backupUploadChunk", { id, dataBase64: btoa(s) }); onPct(Math.min(1, (off + buf.length) / f.size));
  }
  await core.call("backupUploadEnd", { id }); return id;
}

export type Prog = { op: string; stage: string; done: number; total: number } | null;
const STAGES: Record<string, string> = { preparing: "Preparing…", sessions: "Packing sign-in sessions…", media: "Packing media…", data: "Packing messages and settings…", verifying: "Checking the file…", restoring: "Restoring…", finishing: "Finishing…", finished: "Done" };
export function useProgress(op: string) {
  const [p, setP] = useState<Prog>(null);
  useEffect(() => core.on((ev, d) => { if (ev === "backup-progress" && d.op === op) setP(d); }), [op]);
  return [p, setP] as const;
}
export const Bar = ({ p }: { p: Prog }) => p ? <div><div className="bar"><i style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` }} /></div><small className="sub">{STAGES[p.stage] ?? p.stage}</small></div> : null;

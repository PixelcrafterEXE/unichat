// Android only: "Find the backup on this phone" for the WhatsApp / Signal history import (WhatsAppBackupImport, SignalBackupImport).
// One tap opens Android's folder picker already pointed at the usual backup folder; the user taps "Use this folder". UniChat then lists the backup
// files there, and copies the chosen one (and, for WhatsApp, the chosen Media folders) into its own storage so the importer can read it.
//   Native side: apps/android NodeBridge $backupLocate / $backupCopy / $backupCopyCancel / $backupDiscard (see apps/android/src/bridge-protocol.ts). Mock: mockSaf.ts.
import { useState } from "react";
import { core, fmtBytes } from "./util";
import { useProgress } from "./backupShared";

export type SafKind = "whatsapp" | "signal";
export type SafCopied = { path: string; name: string; mediaPath?: string; mediaFiles: number };
type Found = { folder: string; files: { name: string; size: number; modified: number }[]; hasMedia: boolean; media: { name: string; bytes: number; files: number }[] };
const w = window as any;
/** True in the Android app (and in the mock with window.__mockSaf). */
export const safAvailable = () => !!w.UnimsgNative || !!w.__mockSaf;
export const safDiscard = (kind: SafKind) => { if (safAvailable()) void core.call("$backupDiscard", { kind }).catch(() => {}); };
const BIG = 2 * 1024 ** 3; // media folders above this are not ticked by default

const TEXT: Record<SafKind, { where: string; pick: string }> = {
  whatsapp: { where: "WhatsApp's backup folder (Android > media > com.whatsapp > WhatsApp)", pick: "WhatsApp" },
  signal: { where: "the folder you chose for Signal's backups (usually “Signal” or “Signal/Backups”)", pick: "the Signal backup folder" },
};

export function SafBackupFinder({ kind, onCopied, disabled }: { kind: SafKind; onCopied: (c: SafCopied) => void; disabled?: boolean }) {
  const [found, setFound] = useState<Found | null>(null), [file, setFile] = useState(""), [mediaSel, setMediaSel] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"" | "find" | "copy">(""), [err, setErr] = useState(""), [done, setDone] = useState<SafCopied | null>(null), [asked, setAsked] = useState(false);
  const [prog, setProg] = useProgress("saf-copy");
  const t = TEXT[kind];

  const find = async (pickNew: boolean) => {
    setBusy("find"); setErr(""); setDone(null);
    try {
      const r = await core.call("$backupLocate", { kind, pick: pickNew });
      if (r.cancelled) return;
      setFound(r); setFile(r.files[0]?.name ?? "");
      setMediaSel(Object.fromEntries((r.media ?? []).map((m: any) => [m.name, m.bytes <= BIG])));
      if (!r.files.length) setErr(kind === "whatsapp" ? `No WhatsApp backup file (msgstore….crypt15) in “${r.folder}”. Pick the WhatsApp folder, or the Databases folder inside it.` : `No Signal backup file (signal-….backup) in “${r.folder}”. Pick the folder Signal saves its backups to.`);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const chosen = (found?.media ?? []).filter((m) => mediaSel[m.name]);
  const bytes = (found?.files.find((f) => f.name === file)?.size ?? 0) + chosen.reduce((a, m) => a + m.bytes, 0);
  const copy = async () => {
    setBusy("copy"); setErr(""); setProg(null);
    try { const r = await core.call("$backupCopy", { kind, name: file, media: chosen.map((m) => m.name) }); setDone(r); onCopied(r); }
    catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };

  return (
    <div className="box" id="saf-box">
      <h3 style={{ marginTop: 0 }}>Find the backup on this phone</h3>
      {!found && <>
        <p className="hint" id="saf-explain">UniChat will open Android's folder chooser at {t.where}. Tap <b>Use this folder</b>, then <b>Allow</b>. This lets UniChat read that one folder (nothing else on your phone, and it never changes or deletes anything in it). UniChat then copies the backup into its own private storage. You can withdraw the permission later in Android's file manager.</p>
        <div className="btns"><button className="primary inline" id="saf-find" disabled={disabled || !!busy} onClick={() => { setAsked(true); void find(false); }}>{busy === "find" ? (asked ? "Waiting for the folder chooser…" : "Looking…") : "Find the backup on this phone"}</button></div>
      </>}
      {found && <>
        <p className="sub" id="saf-folder">Folder: <b>{found.folder}</b> <button className="secondary" id="saf-other" disabled={!!busy} onClick={() => { setDone(null); void find(true); }}>Choose another folder</button></p>
        {found.files.length > 0 && <div id="saf-files" role="radiogroup" aria-label="Backup file">
          {found.files.map((f) => <label className="opt" key={f.name}><input type="radio" name="saf-file" checked={file === f.name} disabled={!!busy} onChange={() => setFile(f.name)} />
            <span><b>{f.name}</b><small>{fmtBytes(f.size)}{f.modified ? `, ${new Date(f.modified).toLocaleString()}` : ""}</small></span></label>)}
        </div>}
        {kind === "whatsapp" && found.files.length > 0 && (found.hasMedia
          ? <div id="saf-media"><p className="sub">Photos, videos, voice notes and files are optional. They are copied into UniChat's storage for the import and removed again afterwards. Untick what you do not need; large folders are off by default.</p>
              {found.media.map((m) => <label className="opt" key={m.name}><input type="checkbox" checked={!!mediaSel[m.name]} disabled={!!busy} onChange={(e) => setMediaSel({ ...mediaSel, [m.name]: e.target.checked })} />
                <span><b>{m.name}</b><small>{m.files.toLocaleString()} files, {fmtBytes(m.bytes)}</small></span></label>)}</div>
          : <p className="sub" id="saf-nomedia">The folder you chose has no Media folder next to the backup, so only the messages can be imported. To include photos and videos, choose the whole <b>WhatsApp</b> folder instead.</p>)}
        {found.files.length > 0 && !done && <div className="btns"><button className="primary inline" id="saf-copy" disabled={!file || !!busy || disabled} onClick={copy}>{busy === "copy" ? "Copying…" : `Copy into UniChat (${fmtBytes(bytes)})`}</button>
          {busy === "copy" && <button className="secondary" id="saf-cancel" onClick={() => void core.call("$backupCopyCancel", {}).catch(() => {})}>Cancel</button>}</div>}
        {busy === "copy" && prog && <div id="saf-bar"><div className="bar"><i style={{ width: `${prog.total ? Math.min(100, (prog.done / prog.total) * 100) : 0}%` }} /></div><small className="sub">{fmtBytes(prog.done)} of {fmtBytes(prog.total)}</small></div>}
        {done && <p className="ok" id="saf-done">Copied {done.name}{done.mediaFiles ? ` and ${done.mediaFiles.toLocaleString()} media files` : ""}. Now enter the {kind === "whatsapp" ? "64-digit key" : "passphrase or backup key"} below.</p>}
      </>}
      {err && <p className="err" id="saf-err">{err}</p>}
    </div>);
}

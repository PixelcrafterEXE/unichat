// Settings > "Backup & restore" and "Move to another device": export everything to one encrypted file, import it on another install, and the single-chat export.
import { useEffect, useRef, useState } from "react";
import type { Chat } from "./types";
import { Download, Lock } from "./icons";
import { core, fmtBytes } from "./util";
import { Bar, chooseTarget, deliver, native, passphraseStrength, stamp, upload, useProgress } from "./backupShared";
import { MoveLogin } from "./MoveLogin";
import { MoveP2P } from "./MoveDevice";
import "./backup.css";

export { passphraseStrength };

function ExportBox() {
  const [est, setEst] = useState<any>(null);
  const [media, setMedia] = useState(false), [sess, setSess] = useState(false), [ack, setAck] = useState(false);
  const [pw, setPw] = useState(""), [pw2, setPw2] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState(""), [done, setDone] = useState<any>(null);
  const [prog, setProg] = useProgress("export");
  useEffect(() => { core.call("exportEstimate").then(setEst, () => {}); }, []);
  const st = passphraseStrength(pw), can = pw.length >= 8 && pw === pw2 && (!sess || ack) && !busy;
  const go = async () => {
    setBusy(true); setErr(""); setDone(null); setProg(null);
    try {
      const t = await chooseTarget(`unimsg-${stamp()}.unimsg-backup`);
      if (t.canceled) return;
      const r = await core.call("exportData", { passphrase: pw, parts: { data: true, media, sessions: sess }, ...t });
      const msg = await deliver(r); setDone({ ...r, msg }); setPw(""); setPw2("");
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="box" id="bk-export">
      <h3 style={{ marginTop: 0 }}>Export to a backup file</h3>
      <label className="opt"><input type="checkbox" checked disabled /> <span><b>Messages and settings</b><small>{est ? `${est.counts.message} messages, ${est.counts.account} accounts, ${est.counts.alias} names, ${est.counts.folder} folders, ${est.counts.merge} merged chats` : "…"}</small></span></label>
      <label className="opt"><input type="checkbox" id="bk-media" checked={media} onChange={(e) => setMedia(e.target.checked)} /> <span><b>Media you opened</b><small>{est ? `${est.media.files} files, ${fmtBytes(est.media.bytes)} (the file can get large)` : "…"}</small></span></label>
      <label className="opt"><input type="checkbox" id="bk-sess" checked={sess} onChange={(e) => { setSess(e.target.checked); setAck(false); }} /> <span><b>Sign-in sessions</b> (off by default)<small>{est ? `${est.sessions.files} files of ${est.accounts.length} accounts` : "…"}</small></span></label>
      {sess && <div className="warn"><b>Danger.</b> Sessions are the keys to your messenger accounts: anyone who has this file and its passphrase can read and send as you. Moving a session also means the old and the new device <b>must not run the same account at the same time</b>: WhatsApp and Signal would sign one of them out or break encryption. Sign out of, or stop, the account on this device before you start it on the other one.
        <label className="opt"><input type="checkbox" id="bk-ack" checked={ack} onChange={(e) => setAck(e.target.checked)} /> <span>I understand and will keep the file safe.</span></label></div>}
      {!sess && <p className="sub">Without sessions, your accounts arrive on the other device as read-only archives with a "Sign in again" button. That is the safe default.</p>}
      <input type="password" id="bk-pw" placeholder="Passphrase (at least 8 characters)" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      <input type="password" id="bk-pw2" placeholder="Repeat passphrase" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
      {pw && <div className={`strength ${st.level}`}>{st.text}</div>}
      {pw2 && pw !== pw2 && <div className="strength weak">The passphrases don't match.</div>}
      <p className="sub">The passphrase is not stored anywhere. If you forget it, the backup cannot be opened.</p>
      <Bar p={busy ? prog : null} />
      <div className="btns"><button className="primary inline" id="bk-go" disabled={!can} onClick={go}><Download size={16} /> {busy ? "Exporting…" : "Export"}</button>
        {busy && <button className="secondary" id="bk-cancel" onClick={() => core.call("backupCancel")}>Cancel</button>}</div>
      {err && <p className="err" id="bk-err">{err}</p>}
      {done && <div className="ok" id="bk-done"><b>Backup ready:</b> {done.name} ({fmtBytes(done.size)})<br />{done.msg}<br /><small className="sub">SHA-256 <code title={done.sha256}>{done.sha256}</code></small></div>}
    </div>);
}

function ImportBox() {
  const [file, setFile] = useState<File | null>(null), [nat, setNat] = useState<{ path: string; name: string } | null>(null), [over, setOver] = useState(false), [pw, setPw] = useState("");
  const [upId, setUpId] = useState(""), [info, setInfo] = useState<any>(null), [mode, setMode] = useState<"new-install" | "merge">("merge");
  const [useMedia, setUseMedia] = useState(true), [useSess, setUseSess] = useState(true);
  const [busy, setBusy] = useState(""), [err, setErr] = useState(""), [res, setRes] = useState<any>(null), [pct, setPct] = useState(0);
  const [prog, setProg] = useProgress("import"); const input = useRef<HTMLInputElement>(null);
  const pick = (f?: File) => { if (f) { setFile(f); setNat(null); setInfo(null); setUpId(""); setRes(null); setErr(""); } };
  // desktop: the file is chosen in the OS dialog and only its path goes to the backend (no upload)
  const chooseNative = async () => { const r = await native()!.showOpenDialog(); if (!r.canceled && r.path) { setNat({ path: r.path, name: r.path.split(/[\\/]/).pop() ?? r.path }); setFile(null); setInfo(null); setUpId(""); setRes(null); setErr(""); } };
  const src = () => (nat ? { path: nat.path } : { uploadId: upId });
  const check = async () => {
    setBusy("Reading…"); setErr(""); setInfo(null);
    try {
      let id = upId; if (!nat && !id) { id = await upload(file!, setPct); setUpId(id); }
      const i = await core.call("importInspect", { ...(nat ? { path: nat.path } : { uploadId: id }), passphrase: pw }); setInfo(i); setMode(i.suggestedMode); setUseSess(!!i.manifest.parts?.sessions); setUseMedia(!!i.manifest.parts?.media);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const run = async () => {
    setBusy("Importing…"); setErr(""); setProg(null);
    try { setRes(await core.call("importData", { ...src(), passphrase: pw, mode, parts: { media: useMedia, sessions: useSess } })); setInfo(null); setUpId(""); setFile(null); setNat(null); setPw(""); }
    catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const m = info?.manifest;
  return (
    <div className="box" id="bk-import">
      <h3 style={{ marginTop: 0 }}>Import from a backup file</h3>
      <div className={`drop ${over ? "over" : ""}`} id="bk-drop" onClick={() => (native() ? void chooseNative() : input.current?.click())} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}>
        {nat ? <b>{nat.name}</b> : file ? <b>{file.name} ({fmtBytes(file.size)})</b> : native() ? "Click to choose a .unimsg-backup file" : "Drop a .unimsg-backup file here, or click to choose one"}
        <input ref={input} id="bk-file" type="file" accept=".unimsg-backup" hidden onChange={(e) => pick(e.target.files?.[0])} /></div>
      {(file || nat) && !info && <>
        <input type="password" id="bk-ipw" placeholder="Backup passphrase" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
        <div className="btns"><button className="secondary" id="bk-check" disabled={!pw || !!busy} onClick={check}>{busy || "Check file"}</button></div>
        {busy && pct > 0 && pct < 1 && <div className="bar"><i style={{ width: `${pct * 100}%` }} /></div>}</>}
      {info && <div id="bk-info">
        <table><tbody>
          <tr><td>Made</td><td>{new Date(m.createdAt).toLocaleString()} by UniChat {m.appVersion} on {m.source?.name}</td></tr>
          <tr><td>Contains</td><td>{m.parts.data === false ? `${m.counts.account === 1 ? "one account" : "accounts"}, sign-in session only (${m.sessionFiles} files), no messages` : <>{m.counts.message} messages, {m.counts.account} accounts</>}{m.parts.media ? ", media" : ""}{m.parts.data !== false && m.parts.sessions ? `, sign-in sessions (${m.sessionFiles} files)` : ""}</td></tr>
          <tr><td>Accounts</td><td>{info.accounts.map((a: any) => <div key={a.src}>{a.label} ({a.provider}): {a.outcome === "matched" ? "already here, messages are merged in" : a.hasSession ? "added, session included" : "added as read-only archive"}</div>)}</td></tr></tbody></table>
        <label className="opt"><input type="radio" name="bkmode" checked={mode === "new-install"} disabled={!info.targetEmpty} onChange={() => setMode("new-install")} /> <span><b>New install</b><small>Restore everything. Only possible while this install is empty.</small></span></label>
        <label className="opt"><input type="radio" name="bkmode" id="bk-merge" checked={mode === "merge"} onChange={() => setMode("merge")} /> <span><b>Merge</b><small>Add to what is here. Nothing is deleted or overwritten; accounts are matched by messenger and name.</small></span></label>
        {m.parts.media && <label className="opt"><input type="checkbox" checked={useMedia} onChange={(e) => setUseMedia(e.target.checked)} /> <span>Import media</span></label>}
        {m.parts.sessions && <>
          <label className="opt"><input type="checkbox" id="bk-usess" checked={useSess} onChange={(e) => setUseSess(e.target.checked)} /> <span>Import sign-in sessions</span></label>
          {useSess && <div className="warn"><b>Before you continue:</b> this backup contains sign-in sessions. Imported accounts will <b>not start by themselves</b>. First sign out of, or stop, these accounts on the old device; then start them here from "Moved accounts" below. Running both at once can sign one out or break encryption.</div>}</>}
        <div className="btns"><button className="primary inline" id="bk-import-go" disabled={!!busy} onClick={run}>{busy || "Import"}</button><button className="secondary" onClick={() => { setInfo(null); setFile(null); setNat(null); setUpId(""); }}>Cancel</button>
          {busy === "Importing…" && <button className="secondary" onClick={() => core.call("backupCancel")}>Stop</button>}</div>
        <Bar p={busy === "Importing…" ? prog : null} /></div>}
      {err && <p className="err" id="bk-ierr">{err}</p>}
      {res && <div className="ok" id="bk-result"><b>Import finished.</b> {res.messages.added} messages added{res.messages.existing ? `, ${res.messages.existing} already here` : ""}{res.mediaFiles ? `, ${res.mediaFiles} media files` : ""}.
        {res.needSignIn > 0 && <div id="bk-needsign">{res.needSignIn} account{res.needSignIn === 1 ? "" : "s"} need{res.needSignIn === 1 ? "s" : ""} sign-in{res.moved.length ? " (or confirmation, see below)" : ": open Accounts and press Sign in again"}.</div>}</div>}
    </div>);
}

function Moved() {
  const [list, setList] = useState<any[]>([]), [err, setErr] = useState("");
  const load = () => core.call("movedAccounts").then(setList, () => {});
  useEffect(() => { load(); return core.on((ev) => { if (ev === "accounts-changed" || ev === "chats-changed") load(); }); }, []);
  if (!list.length) return null;
  return (
    <div className="box" id="bk-moved"><h3 style={{ marginTop: 0 }}>Moved accounts</h3>
      <p className="sub">These accounts arrived with their sign-in session from another install. They stay stopped until you confirm that the old install is signed out or stopped.</p>
      {list.map((m) => <div key={m.accountId}><b>{m.accountId}</b> <small className="sub">from {m.from}</small>
        <div className="btns"><button className="primary inline" onClick={() => core.call("confirmMovedAccount", { accountId: m.accountId }).then(load, (e) => setErr(e.message))}>The old install is stopped: start here</button>
          <button className="secondary" onClick={() => core.call("dismissMovedAccount", { accountId: m.accountId }).then(load, (e) => setErr(e.message))}>Don't use the session</button></div></div>)}
      {err && <p className="err">{err}</p>}</div>);
}

/** Settings > "Backup & restore" (part "backup") and "Move to another device" (part "move"). */
export function BackupPanel({ part = "backup" }: { part?: "backup" | "move" }) {
  if (part === "move") return (
    <div className="bk"><h2>Move to another device</h2>
      <p className="hint"><Lock size={13} className="inl" /> Hand an account over to another of your devices, for example from this computer to your phone, so that only that device uses it afterwards. It goes straight to the other device, encrypted. Your chats stay here as read-only archives. For a one-time copy of everything, use <b>Backup &amp; restore</b>; to keep devices up to date automatically, use <b>Sync devices</b>.</p>
      <MoveP2P />
      <h3>What moving an account does and doesn't do</h3>
      <ul className="hint"><li>Only the sign-in moves, not the message history.</li>
        <li>Signal, WhatsApp and Matrix work on <b>one device only</b>: after the move, never start the account here again.</li>
        <li>The account is not signed out of the service, so the other device can take over at once.</li>
        <li>If anything goes wrong on the way, the account stays on this device.</li></ul>
      <details id="mvp-file" className="mvfile"><summary>Use a file instead</summary>
        <p className="hint">Only if the two devices can't connect to each other. This is slower and less safe: the login travels in a file that you carry over yourself. Moving over the network above is the better way.</p>
        <Moved /><MoveLogin /></details></div>);
  return (
    <div className="bk"><h2>Backup &amp; restore</h2>
      <p className="hint"><Lock size={13} className="inl" /> A one-time copy of your UniChat data: one passphrase-encrypted file with your messages and settings. Use it to keep a safe copy or to set up UniChat on another computer. (Old Signal messages are imported from the Signal account in Settings &gt; Accounts.) To hand over a messenger login, use <b>Move to another device</b>.</p>
      <ExportBox /><ImportBox /><Moved />
      <h3>What a backup does and doesn't do</h3>
      <ul className="hint"><li>Your messages, chat names, folders, merged chats and settings move over. They are re-encrypted for the new install; the old install's key is never needed.</li>
        <li>Accounts arrive as <b>read-only archives</b>: you can read everything, and press "Sign in again" to link them on the new device.</li>
        <li>Including sessions skips that sign-in, but is risky and the old device must stop using the account.</li>
        <li>Merging never deletes or overwrites anything that is already on the target.</li>
        <li>Nothing is sent to the messenger networks.</li></ul></div>);
}

/** "Export this chat…" in the chat info panel. */
export function ExportChatButton({ chat }: { chat: Chat }) {
  const [open, setOpen] = useState(false), [fmt, setFmt] = useState<"html" | "json">("html"), [from, setFrom] = useState(""), [to, setTo] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  const go = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await core.call("exportChat", { chat: chat.id, format: fmt, from: from || undefined, to: to || undefined, title: chat.name });
      const blob = new Blob([Uint8Array.from(atob(r.dataBase64), (c) => c.charCodeAt(0))], { type: r.mime }), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = r.filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      setMsg(`Exported ${r.count} messages.`);
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  if (!open) return <button className="secondary wide" id="exportchat" onClick={() => setOpen(true)}><Download size={15} /> Export this chat…</button>;
  return (
    <section className="bk" id="exportchat-form"><h4>Export this chat</h4>
      <select value={fmt} onChange={(e) => setFmt(e.target.value as "html" | "json")}><option value="html">Readable page (HTML, with cached images)</option><option value="json">Data (JSON)</option></select>
      <label className="sub">From (optional)<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="sub">To (optional)<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <div className="btns"><button className="primary inline" id="exportchat-go" disabled={busy} onClick={go}>{busy ? "Exporting…" : "Export"}</button><button className="secondary" onClick={() => setOpen(false)}>Close</button></div>
      {msg && <p className="hint" id="exportchat-msg">{msg}</p>}</section>);
}

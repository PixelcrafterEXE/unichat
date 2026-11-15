// Settings > "Import Signal history": bring old messages from a Signal backup (made on the phone) into the local archive of a linked Signal account.
// Self-contained: mount <SignalBackupImport onOpenChats={(accountId) => ...} /> anywhere inside Settings.
//   Backend (packages/core/src/signalimport): signalBackupInspect (no writes) / signalBackupImport / signalBackupCancel, progress on `backup-progress` (op "signal-import" / "signal-inspect").
//   Formats: Android local backup (signal-….backup + the 30-digit passphrase; keeps photos/files) and Secure Backup (64-character backup key; text only).
import { useEffect, useRef, useState } from "react";
import { core, fmtBytes } from "./util";
import { native, upload, useProgress, type Prog } from "./backupShared";
import { SafBackupFinder, safAvailable, safDiscard } from "./SafBackupFinder";
import "./backup.css";

type Kind = "android-legacy" | "secure-backup";
type Acct = { id: string; label: string; provider: string };
const digits = (s: string) => s.replace(/[^0-9]/g, "");
const groupsOf5 = (s: string) => digits(s).slice(0, 30).replace(/(\d{5})(?=\d)/g, "$1 ");
/** The 64-character backup key is shown in groups of 4; case does not matter. */
const keyNorm = (s: string) => s.replace(/#/g, "o").replace(/=/g, "0").replace(/[^a-zA-Z0-9]/g, "").toLowerCase(); // Signal shows the letter O as "#" and the digit 0 as "="
export const validSecret = (kind: Kind, s: string) => (kind === "android-legacy" ? digits(s).length === 30 : keyNorm(s).length === 64);

const LABEL: Record<string, string> = { verifying: "Checking the file…", counting: "Counting messages…", importing: "Importing…", finishing: "Finishing…", finished: "Done" };
const SBar = ({ p }: { p: Prog }) => (p ? <div id="sbi-bar"><div className="bar"><i style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` }} /></div><small className="sub">{LABEL[p.stage] ?? p.stage}</small></div> : null);

export function SignalBackupImport({ onOpenChats, accountId }: { onOpenChats?: (accountId: string) => void; accountId?: string }) {
  const [step, setStep] = useState<"explain" | "file" | "inspect" | "options" | "running" | "done">("explain");
  const [kind, setKind] = useState<Kind>("android-legacy");
  const [accts, setAccts] = useState<Acct[]>([]), [acct, setAcct] = useState("");
  const [file, setFile] = useState<File | null>(null), [nat, setNat] = useState<{ path: string; name: string } | null>(null), [upId, setUpId] = useState(""), [pct, setPct] = useState(0), [over, setOver] = useState(false);
  const [meta, setMeta] = useState(""), [metaName, setMetaName] = useState(""); const [secret, setSecret] = useState(""), [info, setInfo] = useState<any>(null), [busy, setBusy] = useState(""), [err, setErr] = useState(""), [res, setRes] = useState<any>(null);
  const [att, setAtt] = useState(true), [since, setSince] = useState(""), [until, setUntil] = useState(""), [okMismatch, setOkMismatch] = useState(false), [okUnverified, setOkUnverified] = useState(false);
  const [prog, setProg] = useProgress("signal-import"), [iprog, setIprog] = useProgress("signal-inspect");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { core.call("accounts").then((a: Acct[]) => { const s = a.filter((x) => x.provider === "signal" && (!accountId || x.id === accountId)); setAccts(s); setAcct((c) => c || s[0]?.id || ""); }, () => {}); }, []);
  const has = !!(file || nat);
  const src = (id = upId) => (nat ? { path: nat.path } : { uploadId: id });
  const reset = () => { safDiscard("signal"); if (upId) void core.call("backupDiscard", { id: upId }).catch(() => {}); setFile(null); setNat(null); setUpId(""); setInfo(null); setSecret(""); setRes(null); setErr(""); setStep("explain"); setOkMismatch(false); setOkUnverified(false); };

  const pick = (f?: File) => { if (f) { setFile(f); setNat(null); setUpId(""); setInfo(null); setErr(""); if (/\.(binary|bin)$/i.test(f.name)) setKind("secure-backup"); else if (/\.backup$/i.test(f.name)) setKind("android-legacy"); } };
  const chooseNative = async () => { const r = await native()!.showOpenDialog(); if (!r.canceled && r.path) { const name = r.path.split(/[\\/]/).pop() ?? r.path; setNat({ path: r.path, name }); setFile(null); setUpId(""); setInfo(null); setErr(""); if (/\.(binary|bin)$/i.test(name)) setKind("secure-backup"); else if (/\.backup$/i.test(name)) setKind("android-legacy"); } };

  const secretParam = () => (kind === "android-legacy" ? digits(secret) : keyNorm(secret));
  const check = async () => {
    setBusy("Reading the backup…"); setErr(""); setInfo(null); setIprog(null);
    try {
      let id = upId; if (!nat && !id) { setBusy("Uploading…"); id = await upload(file!, setPct); setUpId(id); setBusy("Reading the backup…"); }
      const i = await core.call("signalBackupInspect", { ...src(id), passphrase: secretParam(), format: kind, accountId: acct || undefined, metadataBase64: meta || undefined });
      setInfo(i); setAtt(!!i.canAttachments); setStep("options");
      setOkMismatch(false); setOkUnverified(false);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const match = info?.accounts?.find((a: any) => a.id === acct)?.match as "match" | "mismatch" | "unknown" | undefined;
  const confirmed = match === "match" || (match === "mismatch" && okMismatch) || (match === "unknown" && okUnverified);
  const run = async () => {
    setStep("running"); setErr(""); setProg(null);
    try {
      const r = await core.call("signalBackupImport", { ...src(), passphrase: secretParam(), format: kind, accountId: acct, metadataBase64: meta || undefined, confirmMismatch: okMismatch, confirmUnverified: okUnverified,
        options: { attachments: att, since: since ? new Date(since + "T00:00:00").toISOString() : undefined, until: until ? new Date(until + "T23:59:59.999").toISOString() : undefined } });
      setRes(r); setStep("done"); setSecret(""); safDiscard("signal"); if (upId) { void core.call("backupDiscard", { id: upId }).catch(() => {}); setUpId(""); }
    } catch (e: any) { setErr(e.message); setStep("options"); }
  };
  const open = () => { if (onOpenChats) onOpenChats(acct); else window.dispatchEvent(new CustomEvent("unichat:open-chats", { detail: { accountId: acct } })); };

  return (
    <div className="bk" id="sbi">
      {!accountId && <h2>Import Signal history</h2>}
      <p className="hint">Signal never sends old messages to a linked device like UniChat. If you have a backup made on your phone, you can add that history to UniChat's local archive. Nothing is sent to Signal, and nothing already here is changed or deleted.</p>

      {step === "explain" && <div className="box" id="sbi-explain">
        <h3 style={{ marginTop: 0 }}>1. Make a backup on your phone</h3>
        <label className="opt"><input type="radio" name="sbi-kind" id="sbi-k-legacy" checked={kind === "android-legacy"} onChange={() => setKind("android-legacy")} /> <span><b>Signal for Android: local backup</b> (best: includes photos, videos and voice notes)
          <small>Signal &gt; Settings &gt; Chats &gt; Chat backups &gt; <b>Create backup</b>. Write down the <b>30 digits</b> shown there (they appear only once). Copy the file <code>signal-…backup</code> from the phone's Signal backup folder to this device.</small></span></label>
        <label className="opt"><input type="radio" name="sbi-kind" id="sbi-k-secure" checked={kind === "secure-backup"} onChange={() => setKind("secure-backup")} /> <span><b>Signal Secure Backup</b> (Android or iPhone, text only)
          <small>Signal &gt; Settings &gt; Backups: you need the <b>64-character backup key</b> and a backup file exported to this device. Media is not part of this file, so photos show up as [Photo] notes. iPhone backups only exist in this form.</small></span></label>
        {!accts.length && <p className="err" id="sbi-noacct">There is no linked Signal account in UniChat yet. Link Signal first (Settings &gt; Accounts), then come back.</p>}
        <div className="btns"><button className="primary inline" id="sbi-start" disabled={!accts.length} onClick={() => setStep("file")}>I have the backup file</button></div>
      </div>}

      {step !== "explain" && step !== "done" && <div className="box" id="sbi-form">
        <h3 style={{ marginTop: 0 }}>2. Choose the file and enter the key</h3>
        {!accountId && <label className="sub">Import into this Signal account
          <select id="sbi-account" value={acct} onChange={(e) => { setAcct(e.target.value); setInfo(null); setStep("file"); }}>{accts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
        {safAvailable() && <SafBackupFinder kind="signal" disabled={step === "running"} onCopied={(c) => { setNat({ path: c.path, name: c.name }); setFile(null); setUpId(""); setInfo(null); setErr(""); if (/\.(binary|bin)$/i.test(c.name)) setKind("secure-backup"); else setKind("android-legacy"); }} />}
        <div className={`drop ${over ? "over" : ""}`} id="sbi-drop" onClick={() => (native() ? void chooseNative() : input.current?.click())} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
          {nat ? <b>{nat.name}</b> : file ? <b>{file.name} ({fmtBytes(file.size)})</b> : safAvailable() ? "Or choose the backup file yourself" : native() ? "Click to choose the backup file" : "Drop the backup file here, or click to choose it"}
          <input ref={input} id="sbi-file" type="file" accept=".backup,.binary,.bin,application/octet-stream" hidden onChange={(e) => pick(e.target.files?.[0])} /></div>
        {kind === "secure-backup" && <label className="sub" id="sbi-meta">On-device backup folder? Also choose its small <code>metadata</code> file (next to <code>main</code>)
          <input type="file" id="sbi-metafile" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) { setMeta(""); setMetaName(""); return; } if (f.size > 4096) { setErr("That is not a Signal metadata file (it is only about 36 bytes)."); return; } const b = new Uint8Array(await f.arrayBuffer()); let t = ""; b.forEach((x) => (t += String.fromCharCode(x))); setMeta(btoa(t)); setMetaName(f.name); setInfo(null); setErr(""); }} />
          {metaName && <small className="sub">metadata loaded: {metaName}</small>}</label>}
        <input type={kind === "android-legacy" ? "text" : "password"} id="sbi-pw" autoComplete="off" spellCheck={false} inputMode={kind === "android-legacy" ? "numeric" : "text"}
          placeholder={kind === "android-legacy" ? "30-digit passphrase (spaces optional): 12345 67890 …" : "64-character backup key"} value={secret}
          onChange={(e) => setSecret(kind === "android-legacy" ? groupsOf5(e.target.value) : e.target.value)} />
        <small className="sub" id="sbi-pwhint">{kind === "android-legacy" ? `${digits(secret).length} of 30 digits` : `${keyNorm(secret).length} of 64 characters`}. It is used only to open this file and is never stored.</small>
        <div className="btns"><button className="primary inline" id="sbi-check" disabled={!has || !acct || !validSecret(kind, secret) || !!busy || step === "running"} onClick={check}>{busy || "Check the backup"}</button>
          <button className="secondary" id="sbi-back" onClick={reset}>Start over</button></div>
        {busy && pct > 0 && pct < 1 && <div className="bar"><i style={{ width: `${pct * 100}%` }} /></div>}
        {busy && <SBar p={iprog} />}
      </div>}

      {(step === "options" || step === "running") && info && <div className="box" id="sbi-info">
        <h3 style={{ marginTop: 0 }}>3. What is in the backup</h3>
        <table><tbody>
          <tr><td>Messages</td><td id="sbi-n-msgs">{info.messages.toLocaleString()}</td></tr>
          <tr><td>Conversations</td><td id="sbi-n-chats">{info.chats.total} ({info.chats.dms} one-to-one, {info.chats.groups} groups)</td></tr>
          <tr><td>Time span</td><td>{info.firstAt ? `${new Date(info.firstAt).toLocaleDateString()} to ${new Date(info.lastAt).toLocaleDateString()}` : "-"}</td></tr>
          <tr><td>Photos, videos, files</td><td id="sbi-n-att">{info.canAttachments ? `${info.attachments.count} (${fmtBytes(info.attachments.bytes)})` : `${info.attachments.count} (no media folder found next to this backup file)`}</td></tr>
        </tbody></table>
        {info.topChats?.length > 0 && <details><summary className="sub">Largest conversations</summary><ul className="hint">{info.topChats.map((c: any, i: number) => <li key={i}>{c.name}: {c.messages}</li>)}</ul></details>}
        {info.warnings?.map((w: string, i: number) => <div className="warn" key={i}>{w}</div>)}
        {match === "match" && <p className="ok" id="sbi-match">This backup belongs to the selected Signal account.</p>}
        {match === "mismatch" && <div className="warn" id="sbi-mismatch"><b>This backup belongs to a different Signal account.</b> Importing it into the selected account would mix someone else's history into it.
          <label className="opt"><input type="checkbox" id="sbi-confirm" checked={okMismatch} onChange={(e) => setOkMismatch(e.target.checked)} /> <span>Import anyway</span></label></div>}
        {match === "unknown" && <div className="warn" id="sbi-unverified"><b>UniChat cannot check whose backup this is</b> (the account is signed out, or the backup does not say). Be sure it belongs to the selected account.
          <label className="opt"><input type="checkbox" id="sbi-confirm" checked={okUnverified} onChange={(e) => setOkUnverified(e.target.checked)} /> <span>Yes, this is this account's backup</span></label></div>}
        <h3>4. Options</h3>
        <label className="opt"><input type="checkbox" id="sbi-att" checked={att && !!info.canAttachments} disabled={!info.canAttachments} onChange={(e) => setAtt(e.target.checked)} /> <span><b>Include photos, videos, voice notes and files</b>
          <small>{info.canAttachments ? `About ${fmtBytes(info.attachments.bytes)} of local storage (encrypted).` : "Not available: choose the main file inside a backup folder that has its media (files) folder."}</small></span></label>
        <div className="btns"><label className="sub">From (optional)<input type="date" id="sbi-from" value={since} onChange={(e) => setSince(e.target.value)} /></label>
          <label className="sub">To (optional)<input type="date" id="sbi-to" value={until} onChange={(e) => setUntil(e.target.value)} /></label></div>
        <p className="sub">Messages UniChat already has stay exactly as they are; only missing messages and missing parts are added. Imported messages never raise unread counters or notifications. It is safe to run the import again.</p>
        <div className="btns"><button className="primary inline" id="sbi-go" disabled={!confirmed || step === "running"} onClick={run}>{step === "running" ? "Importing…" : "Import history"}</button>
          {step === "running" && <button className="secondary" id="sbi-cancel" onClick={() => core.call("signalBackupCancel")}>Cancel</button>}</div>
        {step === "running" && <SBar p={prog} />}
      </div>}

      {err && <p className="err" id="sbi-err">{err}</p>}

      {step === "done" && res && <div className="box" id="sbi-result">
        <h3 style={{ marginTop: 0 }} className="ok">Import finished</h3>
        <p><b>{res.messages.added.toLocaleString()}</b> messages added{res.messages.filled ? `, ${res.messages.filled} completed` : ""}{res.messages.existing ? `, ${res.messages.existing} were already here` : ""} in {res.chats.total} conversation{res.chats.total === 1 ? "" : "s"} ({res.chats.created} new).
          {res.attachments.stored ? ` ${res.attachments.stored} files stored.` : ""}{res.attachments.missing ? ` ${res.attachments.missing} files were not in the backup.` : ""}</p>
        {res.warnings?.map((w: string, i: number) => <div className="warn" key={i}>{w}</div>)}
        <div className="btns"><button className="primary inline" id="sbi-open" onClick={open}>Open chats</button><button className="secondary" id="sbi-again" onClick={reset}>Import another backup</button></div>
      </div>}
    </div>);
}

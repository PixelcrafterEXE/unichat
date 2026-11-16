// WhatsApp account card > "Import chat history": bring old messages (and, from the Media folder, photos/videos/voice notes/files) from a WhatsApp Android local backup into the local archive.
// Self-contained: mount <WhatsAppBackupImport accountId=… onOpenChats={(accountId) => ...} /> inside the account card.
//   Backend (packages/core/src/whatsappimport): whatsappBackupInspect (no writes) / whatsappBackupImport / whatsappBackupCancel, progress on `backup-progress` (op "whatsapp-import" / "whatsapp-inspect").
//   Format: msgstore.db.crypt15 + the 64-digit key of end-to-end encrypted backup (or crypt14 + the 158-byte `key` file, root only).
import { useEffect, useRef, useState } from "react";
import { core, fmtBytes, fmtDateTime, fmtDate } from "./util";
import { native, upload, useProgress, type Prog } from "./backupShared";
import { SafBackupFinder, safAvailable, safDiscard } from "./SafBackupFinder";
import "./backup.css";

type Acct = { id: string; label: string; provider: string };
const keyNorm = (s: string) => s.replace(/[^0-9a-fA-F]/g, "").toLowerCase().slice(0, 64);
export const validKey = (s: string) => keyNorm(s).length === 64;

const LABEL: Record<string, string> = { verifying: "Checking and decrypting the file…", counting: "Counting messages…", importing: "Importing…", finishing: "Finishing…", finished: "Done" };
const SBar = ({ p }: { p: Prog }) => (p ? <div id="wbi-bar"><div className="bar"><i style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` }} /></div><small className="sub">{LABEL[p.stage] ?? p.stage}</small></div> : null);

export function WhatsAppBackupImport({ onOpenChats, accountId }: { onOpenChats?: (accountId: string) => void; accountId?: string }) {
  const [step, setStep] = useState<"explain" | "file" | "options" | "running" | "done">("explain");
  const [accts, setAccts] = useState<Acct[]>([]), [acct, setAcct] = useState("");
  const [file, setFile] = useState<File | null>(null), [nat, setNat] = useState<{ path: string; name: string } | null>(null), [upId, setUpId] = useState(""), [pct, setPct] = useState(0), [over, setOver] = useState(false);
  const [secret, setSecret] = useState(""), [keyFile, setKeyFile] = useState(""), [keyFileName, setKeyFileName] = useState(""), [media, setMedia] = useState("");
  const [info, setInfo] = useState<any>(null), [busy, setBusy] = useState(""), [err, setErr] = useState(""), [res, setRes] = useState<any>(null);
  const [att, setAtt] = useState(true), [since, setSince] = useState(""), [until, setUntil] = useState(""), [okMismatch, setOkMismatch] = useState(false), [okUnverified, setOkUnverified] = useState(false);
  const [prog, setProg] = useProgress("whatsapp-import"), [iprog, setIprog] = useProgress("whatsapp-inspect");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { core.call("accounts").then((a: Acct[]) => { const s = a.filter((x) => x.provider === "whatsapp" && (!accountId || x.id === accountId)); setAccts(s); setAcct((c) => c || s[0]?.id || ""); }, () => {}); }, []);
  const name = nat?.name ?? file?.name ?? "";
  const has = !!(file || nat), c14 = /\.crypt14$/i.test(name);
  const src = (id = upId) => (nat ? { path: nat.path } : { uploadId: id });
  const reset = () => { safDiscard("whatsapp"); if (upId) void core.call("backupDiscard", { id: upId }).catch(() => {}); setFile(null); setNat(null); setUpId(""); setInfo(null); setSecret(""); setKeyFile(""); setKeyFileName(""); setRes(null); setErr(""); setStep("explain"); setOkMismatch(false); setOkUnverified(false); };

  const pick = (f?: File) => { if (f) { setFile(f); setNat(null); setUpId(""); setInfo(null); setErr(""); } };
  const chooseNative = async () => { const r = await native()!.showOpenDialog(); if (!r.canceled && r.path) { setNat({ path: r.path, name: r.path.split(/[\\/]/).pop() ?? r.path }); setFile(null); setUpId(""); setInfo(null); setErr(""); } };
  const keyOk = c14 ? !!keyFile : validKey(secret);
  const params = () => ({ ...src(), key: c14 ? undefined : keyNorm(secret), keyFileBase64: c14 ? keyFile : undefined, mediaPath: media.trim() || undefined });

  const check = async () => {
    setBusy("Reading the backup…"); setErr(""); setInfo(null); setIprog(null);
    try {
      let id = upId; if (!nat && !id) { setBusy("Uploading…"); id = await upload(file!, setPct); setUpId(id); setBusy("Reading the backup…"); }
      const i = await core.call("whatsappBackupInspect", { ...params(), ...(nat ? {} : { uploadId: id }), accountId: acct || undefined });
      setInfo(i); setAtt(!!i.canAttachments); setStep("options"); setOkMismatch(false); setOkUnverified(false);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const match = info?.accounts?.find((a: any) => a.id === acct)?.match as "match" | "mismatch" | "unknown" | undefined;
  const confirmed = match === "match" || (match === "mismatch" && okMismatch) || (match === "unknown" && okUnverified);
  const run = async () => {
    setStep("running"); setErr(""); setProg(null);
    try {
      const r = await core.call("whatsappBackupImport", { ...params(), accountId: acct, confirmMismatch: okMismatch, confirmUnverified: okUnverified,
        options: { attachments: att, since: since ? new Date(since + "T00:00:00").toISOString() : undefined, until: until ? new Date(until + "T23:59:59.999").toISOString() : undefined } });
      setRes(r); setStep("done"); setSecret(""); setKeyFile(""); safDiscard("whatsapp"); if (upId) { void core.call("backupDiscard", { id: upId }).catch(() => {}); setUpId(""); }
    } catch (e: any) { setErr(e.message); setStep("options"); }
  };
  const open = () => { if (onOpenChats) onOpenChats(acct); else window.dispatchEvent(new CustomEvent("unichat:open-chats", { detail: { accountId: acct } })); };

  return (
    <div className="bk" id="wbi">
      {!accountId && <h2>Import WhatsApp history</h2>}
      <p className="hint">WhatsApp only sends recent messages to a linked device like UniChat. If you have a local backup made on your phone, you can add that history to UniChat's local archive. Nothing is sent to WhatsApp, and nothing already here is changed or deleted.</p>

      {step === "explain" && <div className="box" id="wbi-explain">
        <h3 style={{ marginTop: 0 }}>1. Make an encrypted backup on your phone</h3>
        <ol className="hint">
          <li>WhatsApp &gt; Settings &gt; Chats &gt; Chat backup &gt; <b>End-to-end encrypted backup</b> &gt; Turn on. Choose <b>Use 64-digit encryption key instead</b> and <b>write down the 64 digits</b> (they are shown once; UniChat needs them).</li>
          <li>Back on Chat backup, tap <b>Back up</b> (include videos if you want them) and wait until it finishes. It writes <code>msgstore.db.crypt15</code> into the phone's <code>WhatsApp/Databases</code> folder (on newer Android: <code>Android/media/com.whatsapp/WhatsApp/Databases</code>).</li>
          <li>Copy the whole <b>WhatsApp</b> folder (it holds <code>Databases</code> and <code>Media</code>) to this computer.</li>
        </ol>
        <p className="sub">Older crypt14 backups can only be opened with the phone's 158-byte <code>key</code> file, which needs a rooted phone. Without root, switch on the encrypted backup above and back up again.</p>
        {!accts.length && <p className="err" id="wbi-noacct">There is no linked WhatsApp account in UniChat yet. Link WhatsApp first (Settings &gt; Accounts), then come back.</p>}
        <div className="btns"><button className="primary inline" id="wbi-start" disabled={!accts.length} onClick={() => setStep("file")}>I have the backup</button></div>
      </div>}

      {step !== "explain" && step !== "done" && <div className="box" id="wbi-form">
        <h3 style={{ marginTop: 0 }}>2. Choose the file and enter the key</h3>
        {!accountId && <label className="sub">Import into this WhatsApp account
          <select id="wbi-account" value={acct} onChange={(e) => { setAcct(e.target.value); setInfo(null); setStep("file"); }}>{accts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></label>}
        {safAvailable() && <SafBackupFinder kind="whatsapp" disabled={step === "running"} onCopied={(c) => { setNat({ path: c.path, name: c.name }); setFile(null); setUpId(""); setInfo(null); setErr(""); setMedia(c.mediaPath ?? ""); }} />}
        <div className={`drop ${over ? "over" : ""}`} id="wbi-drop" onClick={() => (native() ? void chooseNative() : input.current?.click())} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}>
          {nat ? <b>{nat.name}</b> : file ? <b>{file.name} ({fmtBytes(file.size)})</b> : safAvailable() ? "Or choose msgstore.db.crypt15 yourself" : native() ? "Click to choose msgstore.db.crypt15" : "Drop msgstore.db.crypt15 here, or click to choose it"}
          <input ref={input} id="wbi-file" type="file" accept=".crypt15,.crypt14,application/octet-stream" hidden onChange={(e) => pick(e.target.files?.[0])} /></div>
        {c14
          ? <label className="sub" id="wbi-keyfile-l">This is a crypt14 backup: choose the phone's <code>key</code> file (158 bytes, needs root to get)
              <input type="file" id="wbi-keyfile" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) { setKeyFile(""); setKeyFileName(""); return; } if (f.size > 4096) { setErr("That is not a WhatsApp key file (it is 158 bytes)."); return; } const b = new Uint8Array(await f.arrayBuffer()); let t = ""; b.forEach((x) => (t += String.fromCharCode(x))); setKeyFile(btoa(t)); setKeyFileName(f.name); setInfo(null); setErr(""); }} />
              {keyFileName && <small className="sub">key file loaded: {keyFileName}</small>}</label>
          : <><input type="password" id="wbi-pw" autoComplete="off" spellCheck={false} placeholder="64-digit encryption key (0-9, a-f)" value={secret} onChange={(e) => setSecret(e.target.value)} />
              <small className="sub" id="wbi-pwhint">{keyNorm(secret).length} of 64 characters. It is used only to open this file and is never stored.</small></>}
        <label className="sub" id="wbi-media-l">Folder with the media (optional). Normally found next to the backup file; if not, type the path of the <code>WhatsApp</code> folder on the backend.
          <input type="text" id="wbi-media" autoComplete="off" spellCheck={false} placeholder="/path/to/WhatsApp" value={media} onChange={(e) => { setMedia(e.target.value); setInfo(null); }} /></label>
        <div className="btns"><button className="primary inline" id="wbi-check" disabled={!has || !acct || !keyOk || !!busy || step === "running"} onClick={check}>{busy || "Check the backup"}</button>
          <button className="secondary" id="wbi-back" onClick={reset}>Start over</button></div>
        {busy && pct > 0 && pct < 1 && <div className="bar"><i style={{ width: `${pct * 100}%` }} /></div>}
        {busy && <SBar p={iprog} />}
      </div>}

      {(step === "options" || step === "running") && info && <div className="box" id="wbi-info">
        <h3 style={{ marginTop: 0 }}>3. What is in the backup</h3>
        <table><tbody>
          <tr><td>Messages</td><td id="wbi-n-msgs">{info.messages.toLocaleString()}</td></tr>
          <tr><td>Conversations</td><td id="wbi-n-chats">{info.chats.total} ({info.chats.dms} one-to-one, {info.chats.groups} groups)</td></tr>
          <tr><td>Time span</td><td>{info.firstAt ? `${fmtDate(info.firstAt, {})} to ${fmtDate(info.lastAt, {})}` : "-"}</td></tr>
          <tr><td>Photos, videos, files</td><td id="wbi-n-att">{info.canAttachments ? `${info.attachments.present} of ${info.attachments.count} found in the Media folder (${fmtBytes(info.attachments.bytes)} listed)` : `${info.attachments.count} (no Media folder found next to this backup file)`}</td></tr>
        </tbody></table>
        {info.topChats?.length > 0 && <details><summary className="sub">Largest conversations</summary><ul className="hint">{info.topChats.map((c: any, i: number) => <li key={i}>{c.name}: {c.messages}</li>)}</ul></details>}
        {info.warnings?.map((w: string, i: number) => <div className="warn" key={i}>{w}</div>)}
        {match === "match" && <p className="ok" id="wbi-match">This backup seems to belong to the selected WhatsApp number.</p>}
        {match === "mismatch" && <div className="warn" id="wbi-mismatch"><b>This backup seems to belong to a different WhatsApp number.</b> Importing it into the selected account would mix someone else's history into it.
          <label className="opt"><input type="checkbox" id="wbi-confirm" checked={okMismatch} onChange={(e) => setOkMismatch(e.target.checked)} /> <span>Import anyway</span></label></div>}
        {match === "unknown" && <div className="warn" id="wbi-unverified"><b>UniChat cannot check whose backup this is</b> (the account is signed out, or the backup does not say). Be sure it belongs to the selected account.
          <label className="opt"><input type="checkbox" id="wbi-confirm" checked={okUnverified} onChange={(e) => setOkUnverified(e.target.checked)} /> <span>Yes, this is this account's backup</span></label></div>}
        <h3>4. Options</h3>
        <label className="opt"><input type="checkbox" id="wbi-att" checked={att && !!info.canAttachments} disabled={!info.canAttachments} onChange={(e) => setAtt(e.target.checked)} /> <span><b>Include photos, videos, voice notes and files</b>
          <small>{info.canAttachments ? `Up to ${fmtBytes(info.attachments.bytes)} of local storage (encrypted).` : "Not available: choose the backup inside a WhatsApp folder that has its Media folder, or type that folder above and check again."}</small></span></label>
        <div className="btns"><label className="sub">From (optional)<input type="date" id="wbi-from" value={since} onChange={(e) => setSince(e.target.value)} /></label>
          <label className="sub">To (optional)<input type="date" id="wbi-to" value={until} onChange={(e) => setUntil(e.target.value)} /></label></div>
        <p className="sub">Messages UniChat already has stay exactly as they are; only missing messages and missing parts are added. Imported messages never raise unread counters or notifications. It is safe to run the import again.</p>
        <div className="btns"><button className="primary inline" id="wbi-go" disabled={!confirmed || step === "running"} onClick={run}>{step === "running" ? "Importing…" : "Import history"}</button>
          {step === "running" && <button className="secondary" id="wbi-cancel" onClick={() => core.call("whatsappBackupCancel")}>Cancel</button>}</div>
        {step === "running" && <SBar p={prog} />}
      </div>}

      {err && <p className="err" id="wbi-err">{err}</p>}

      {step === "done" && res && <div className="box" id="wbi-result">
        <h3 style={{ marginTop: 0 }} className="ok">Import finished</h3>
        <p><b>{res.messages.added.toLocaleString()}</b> messages added{res.messages.filled ? `, ${res.messages.filled} completed` : ""}{res.messages.existing ? `, ${res.messages.existing} were already here` : ""} in {res.chats.total} conversation{res.chats.total === 1 ? "" : "s"} ({res.chats.created} new).
          {res.attachments.stored ? ` ${res.attachments.stored} files stored.` : ""}{res.attachments.missing ? ` ${res.attachments.missing} files were not in the Media folder.` : ""}{res.attachments.mismatch ? ` ${res.attachments.mismatch} files did not match the backup and were skipped.` : ""}</p>
        {res.warnings?.map((w: string, i: number) => <div className="warn" key={i}>{w}</div>)}
        <div className="btns"><button className="primary inline" id="wbi-open" onClick={open}>Open chats</button><button className="secondary" id="wbi-again" onClick={reset}>Import another backup</button></div>
      </div>}
    </div>);
}

// Settings > "Move to another device": a guided one-account transfer.
//   SOURCE (this device keeps the history, gives the login away): pick account -> read the rules -> passphrase -> session-only archive -> deliver the file
//     -> separate final confirm "I have the file, wipe the session here" (moveAwayAccount, no remote logout).
//   TARGET (this device receives it): choose file -> inspect -> import in merge mode -> confirm "start this account here" (confirmMovedAccount).
// Backend: exportData({accountIds, parts:{data:false, sessions:true}}), importInspect/importData, movedAccounts/confirmMovedAccount (packages/core/src/backup.ts).
import { useEffect, useRef, useState } from "react";
import { ProviderIcon, core, fmtBytes, fmtDateTime } from "./util";
import { Bar, chooseTarget, deliver, native, passphraseStrength, stamp, upload, useProgress } from "./backupShared";

/** Sessions that are bound to an encryption state on the device: exactly ONE device may ever run them. */
const BOUND = new Set(["whatsapp", "signal", "matrix", "threema", "threema-md"]);
const TOKENS = new Set(["mattermost", "discord", "teams", "instagram"]);
const NAMES: Record<string, string> = { whatsapp: "WhatsApp", signal: "Signal", matrix: "Matrix", threema: "Threema Gateway", "threema-md": "Threema", mattermost: "Mattermost", discord: "Discord", teams: "Microsoft Teams", instagram: "Instagram" };
export const providerName = (p: string) => NAMES[p] ?? p;

export function ProviderWarning({ provider }: { provider: string }) {
  if (BOUND.has(provider)) return (
    <div className="warn" id="mv-warn-bound"><b>{providerName(provider)}: only ONE device may use this login.</b> The session is tied to this device's encryption state. If this device (or a backup of it) ever starts it again while the other device uses it,
      {provider === "whatsapp" || provider === "signal" ? " messages stop arriving, the network signs one of them out or encryption breaks for both" : " encryption keys get out of step and messages can become unreadable"}. After the move, never start this account here again; to use it here later, link it as a new device.</div>);
  if (TOKENS.has(provider)) return (
    <div className="warn" id="mv-warn-token"><b>{providerName(provider)}: the login is a token.</b> It can technically be used on several devices, so sharing it works. One session per device is still better (you can end a single device later without touching the others); consider signing in on the other device directly instead if that is easy.</div>);
  return <div className="warn" id="mv-warn-unknown"><b>Treat this login as usable on ONE device only.</b> We do not know how {providerName(provider)} reacts to the same session on two devices; assume it breaks.</div>;
}

type Acc = { id: string; provider: string; label: string; status: string; sessionFiles: number };

function PassphraseFields({ pw, setPw, pw2, setPw2 }: { pw: string; setPw: (s: string) => void; pw2: string; setPw2: (s: string) => void }) {
  const st = passphraseStrength(pw);
  return <>
    <input type="password" id="mv-pw" placeholder="Passphrase for the file (at least 8 characters)" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
    <input type="password" id="mv-pw2" placeholder="Repeat passphrase" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
    {pw && <div className={`strength ${st.level}`}>{st.text}</div>}
    {pw2 && pw !== pw2 && <div className="strength weak">The passphrases don't match.</div>}
    <p className="sub">Whoever has the file AND the passphrase can use this login. Enter the passphrase on the other device; do not send it together with the file.</p></>;
}

function Source({ onClose }: { onClose: () => void }) {
  const [accs, setAccs] = useState<Acc[] | null>(null), [step, setStep] = useState(0), [ids, setIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false), [pw, setPw] = useState(""), [pw2, setPw2] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const [file, setFile] = useState<any>(null), [saved, setSaved] = useState(false), [wiped, setWiped] = useState<string[] | null>(null);
  const [prog, setProg] = useProgress("export");
  useEffect(() => { core.call("exportEstimate").then((e: any) => setAccs((e.accounts ?? []).filter((a: Acc) => a.status !== "archived")), () => setAccs([])); }, []);
  const movable = (accs ?? []).filter((a) => a.sessionFiles);
  const sel = (accs ?? []).filter((a) => ids.includes(a.id));
  const provs = [...new Set(sel.map((a) => a.provider))];
  const one = sel.length === 1;
  const names = sel.map((a) => a.label).join(", ");
  const toggle = (id: string) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const create = async () => {
    setBusy(true); setErr(""); setProg(null);
    try {
      const t = await chooseTarget(`unimsg-login-${one ? sel[0]!.provider : "accounts"}-${stamp()}.unimsg-backup`);
      if (t.canceled) return;
      const r = await core.call("exportData", { passphrase: pw, accountIds: ids, parts: { data: false, sessions: true }, ...t });
      const msg = await deliver(r); setFile({ ...r, msg }); setPw(""); setPw2(""); setStep(3);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const wipe = async () => {
    setBusy(true); setErr("");
    const done: string[] = [], failed: string[] = [];
    for (const a of sel) { // one by one: a failure of one account must not stop the others
      try { await core.call("moveAwayAccount", { accountId: a.id, confirmedSaved: true }); done.push(a.label); } catch (e: any) { failed.push(`${a.label}: ${e.message}`); }
    }
    setWiped(done); setBusy(false);
    if (failed.length) setErr(`Could not wipe ${failed.length === 1 ? "one account" : `${failed.length} accounts`}: ${failed.join("; ")}. The file still contains them all; they keep working here until wiped.`);
    if (done.length) setStep(4);
  };
  return (
    <div id="mv-source">
      {step === 0 && <>
        <h4>1. Which accounts do you want to move?</h4>
        <p className="sub">Pick one or several. They go into one file with one passphrase.</p>
        {accs === null ? <p className="sub">…</p> : !accs.length ? <p className="sub" id="mv-none">There is no signed-in account on this device to move.</p> :
          accs.map((a) => <label className={"opt acctcard" + (ids.includes(a.id) ? " on" : "") + (a.sessionFiles ? "" : " off")} key={a.id}><input type="checkbox" name="mvacct" id={`mv-acct-${a.id}`} checked={ids.includes(a.id)} disabled={!a.sessionFiles} onChange={() => toggle(a.id)} /><ProviderIcon provider={a.provider} size={32} /><span className="acctname"><b>{a.label}</b><small>{providerName(a.provider)}{a.sessionFiles ? "" : " · no session files found on this device"}</small></span></label>)}
        <div className="btns"><button className="primary inline" id="mv-next" disabled={!sel.length || sel.some((a) => !a.sessionFiles)} onClick={() => setStep(1)}>Next{sel.length > 1 ? ` (${sel.length} accounts)` : ""}</button>
          {movable.length > 1 && <button className="secondary" id="mv-all" onClick={() => setIds(ids.length === movable.length ? [] : movable.map((a) => a.id))}>{ids.length === movable.length ? "Select none" : "Select all"}</button>}
          <button className="secondary" onClick={onClose}>Cancel</button></div></>}
      {step === 1 && sel.length > 0 && <>
        <h4>2. Read this first</h4>
        <ul className="hint">
          <li><b>Set up the other device first.</b> Install UniChat there and open Settings &gt; Move to another device &gt; "Receive an account on this device". You need to carry one file over.</li>
          <li><b>This device will stop using {one ? names : `these ${sel.length} accounts (${names})`}.</b> At the end the sessions are wiped from here and the {one ? "account stays" : "accounts stay"} here as read-only {one ? "archive" : "archives"} of {one ? "its" : "their"} messages. It is <b>not signed out on the network</b> (that would end the login you are moving).</li>
          <li>Only the login moves, not the message history. History stays here; the other device starts from now (or from what its own copy has).</li></ul>
        {provs.map((p) => <ProviderWarning key={p} provider={p} />)}
        <label className="opt"><input type="checkbox" id="mv-ready" checked={ready} onChange={(e) => setReady(e.target.checked)} /> <span>The other device is ready and I understand that this device stops using {one ? "this account" : "these accounts"}.</span></label>
        <div className="btns"><button className="primary inline" id="mv-next" disabled={!ready} onClick={() => setStep(2)}>Next</button><button className="secondary" onClick={() => setStep(0)}>Back</button></div></>}
      {step === 2 && sel.length > 0 && <>
        <h4>3. Protect the file</h4>
        <PassphraseFields pw={pw} setPw={setPw} pw2={pw2} setPw2={setPw2} />
        <Bar p={busy ? prog : null} />
        <div className="btns"><button className="primary inline" id="mv-export" disabled={busy || pw.length < 8 || pw !== pw2} onClick={create}>{busy ? "Creating…" : native() ? "Choose where to save, create file" : "Create file"}</button>
          <button className="secondary" disabled={busy} onClick={() => setStep(1)}>Back</button></div></>}
      {step === 3 && sel.length > 0 && file && <>
        <h4>4. Take the file to the other device</h4>
        <div className="ok" id="mv-file"><b>{file.name}</b> ({fmtBytes(file.size)}){!one && <> · {sel.length} accounts</>}<br />{file.msg}</div>
        <p className="hint">Nothing has changed on this device yet: {one ? `${names} still works` : "your accounts still work"} here. Copy the file to the other device and check there that it opens (Receive &gt; Check file). <b>Only then</b> wipe the {one ? "session" : "sessions"} here. After the wipe {one ? "the session exists" : "the sessions exist"} only in that file.</p>
        {provs.map((p) => <ProviderWarning key={p} provider={p} />)}
        <label className="opt"><input type="checkbox" id="mv-saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>I have the file in a safe place and it is (or will be) on the other device.</span></label>
        <div className="btns"><button className="danger inline" id="mv-wipe" disabled={!saved || busy} onClick={wipe}>{busy ? "Wiping…" : one ? "I have the file, wipe the session here" : `I have the file, wipe the ${sel.length} sessions here`}</button>
          <button className="secondary" id="mv-later" onClick={onClose}>Not now (keep using {one ? "it" : "them"} here)</button></div></>}
      {step === 4 && wiped && <div className="ok" id="mv-done"><b>Done.</b> {wiped.length === 1 ? "The session was" : `${wiped.length} sessions were`} removed from this device. {wiped.join(", ")} {wiped.length === 1 ? "stays" : "stay"} here as read-only {wiped.length === 1 ? "archive" : "archives"}; do not start {wiped.length === 1 ? "it" : "them"} here again.<br />On the other device, import the file and press "Start {wiped.length === 1 ? "this account" : "these accounts"} here".
        <div className="btns"><button className="secondary" onClick={onClose}>Close</button></div></div>}
      {err && <p className="err" id="mv-err">{err}</p>}
    </div>);
}

function Target({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null), [nat, setNat] = useState<{ path: string; name: string } | null>(null), [upId, setUpId] = useState("");
  const [pw, setPw] = useState(""), [info, setInfo] = useState<any>(null), [res, setRes] = useState<any>(null), [busy, setBusy] = useState(""), [err, setErr] = useState("");
  const [oldStopped, setOldStopped] = useState(false), [started, setStarted] = useState(false), [skipped, setSkipped] = useState(false);
  const [, setProg] = useProgress("import"); const input = useRef<HTMLInputElement>(null);
  const reset = () => { setInfo(null); setUpId(""); setErr(""); };
  const chooseNative = async () => { const r = await native()!.showOpenDialog(); if (!r.canceled && r.path) { setNat({ path: r.path, name: r.path.split(/[\\/]/).pop() ?? r.path }); setFile(null); reset(); } };
  const src = () => (nat ? { path: nat.path } : { uploadId: upId });
  const check = async () => {
    setBusy("Reading…"); reset();
    try {
      let id = upId; if (!nat && !id) { id = await upload(file!, () => {}); setUpId(id); }
      const i = await core.call("importInspect", { ...(nat ? { path: nat.path } : { uploadId: id }), passphrase: pw });
      if (!i.manifest.parts?.sessions || !i.accounts.some((a: any) => a.hasSession)) throw new Error("This file contains no sign-in session. For a normal backup use Import above.");
      setInfo(i);
    } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const run = async () => {
    setBusy("Importing…"); setErr(""); setProg(null);
    try { const r = await core.call("importData", { ...src(), passphrase: pw, mode: "merge", parts: { media: false, sessions: true } }); setRes(r); setInfo(null); setPw(""); }
    catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const accs: any[] = ((info ?? res)?.accounts ?? []).filter((a: any) => a.hasSession);
  const isLive = (a: any) => a.outcome === "matched" && !a.adoptSession; // exists here and is signed in: its session in the file would be ignored
  const live = !!info && accs.length > 0 && accs.every(isLive); // nothing at all to import
  const provs = [...new Set(accs.map((a) => a.provider as string))];
  const labels = accs.map((a) => a.label).join(", ");
  const start = async () => {
    setBusy("Starting…"); setErr("");
    try { for (const id of res.moved) await core.call("confirmMovedAccount", { accountId: id }); setStarted(true); } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const drop = async () => { try { for (const id of res.moved) await core.call("dismissMovedAccount", { accountId: id }); setSkipped(true); } catch (e: any) { setErr(e.message); } };
  const m = info?.manifest;
  return (
    <div id="mv-target">
      {!res && <>
        <h4>Receive a login from another device</h4>
        <p className="hint">On the other device, open Settings &gt; Move to another device &gt; "Move an account away from this device" and bring the file here.</p>
        <div className="drop" id="mv-drop" onClick={() => (native() ? void chooseNative() : input.current?.click())}>
          {nat ? <b>{nat.name}</b> : file ? <b>{file.name} ({fmtBytes(file.size)})</b> : "Click to choose the .unimsg-backup file"}
          <input ref={input} id="mv-fileinput" type="file" accept=".unimsg-backup" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setNat(null); reset(); } }} /></div>
        {(file || nat) && !info && <>
          <input type="password" id="mv-ipw" placeholder="Passphrase of the file" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
          <div className="btns"><button className="secondary" id="mv-check" disabled={!pw || !!busy} onClick={check}>{busy || "Check file"}</button></div></>}
        {info && accs.length > 0 && <div id="mv-info">
          <table><tbody>
            <tr><td>From</td><td>{m.source?.name ?? "another device"}, made {fmtDateTime(m.createdAt)}</td></tr>
            {accs.map((a: any) => <tr key={a.id ?? a.label}><td><ProviderIcon provider={a.provider} size={20} /></td><td><b>{a.label}</b> ({providerName(a.provider)}): {a.outcome === "matched" ? (a.adoptSession ? "exists here as a signed-out archive; its history stays and the session from the file is adopted." : "already signed in on this device; the session in the file would be ignored.") : "added as a new account that is stopped until you confirm."}</td></tr>)}
          </tbody></table>
          {provs.map((p) => <ProviderWarning key={p} provider={p} />)}
          <p className="hint">{accs.length > 1 ? "The accounts" : "The account"} will <b>not start automatically</b>. After the import you confirm that the other device wiped (or stopped) {accs.length > 1 ? "them" : "it"}.</p>
          {live && <p className="err" id="mv-live">{accs.length > 1 ? "All of these accounts are" : "This account is"} already signed in here. Sign {accs.length > 1 ? "them" : "it"} out first (Settings &gt; Accounts &gt; Sign out), then check the file again.</p>}
          <div className="btns"><button className="primary inline" id="mv-import" disabled={!!busy || live} onClick={run}>{busy || (accs.length > 1 ? `Import ${accs.length} logins` : "Import the login")}</button><button className="secondary" onClick={() => { setInfo(null); setFile(null); setNat(null); }}>Cancel</button></div></div>}
        {!info && !file && !nat && <div className="btns"><button className="secondary" onClick={onClose}>Close</button></div>}</>}
      {res && !started && !skipped && <div id="mv-confirm">
        <div className="ok"><b>Imported.</b> {labels} {accs.length > 1 ? "are" : "is"} here but stopped.</div>
        {provs.map((p) => <ProviderWarning key={p} provider={p} />)}
        <label className="opt"><input type="checkbox" id="mv-old-stopped" checked={oldStopped} onChange={(e) => setOldStopped(e.target.checked)} /> <span>On the old device I pressed "I have the file, wipe the session here" (or it is stopped and will never be started again).</span></label>
        <div className="btns"><button className="primary inline" id="mv-start" disabled={!oldStopped || !!busy} onClick={start}>{busy || (accs.length > 1 ? "Start these accounts here" : "Start this account here")}</button>
          <button className="secondary" id="mv-dismiss" disabled={!!busy} onClick={drop}>Don't use this session</button></div></div>}
      {started && <div className="ok" id="mv-started"><b>{labels} {accs.length > 1 ? "are" : "is"} starting on this device.</b> Do not run {accs.length > 1 ? "them" : "it"} on the old device.<div className="btns"><button className="secondary" onClick={onClose}>Close</button></div></div>}
      {skipped && <div className="ok" id="mv-skipped">The session was discarded. The account stays here as a read-only archive; press "Sign in again" in Accounts to link it.<div className="btns"><button className="secondary" onClick={onClose}>Close</button></div></div>}
      {err && <p className="err" id="mv-ierr">{err}</p>}
    </div>);
}

export function MoveLogin() {
  const [mode, setMode] = useState<"" | "away" | "here">("");
  return (
    <div className="box" id="bk-move"><h3 style={{ marginTop: 0 }}>Move a login to another device</h3>
      {!mode && <>
        <p className="sub">Move one or several accounts' sign-ins (not their history) from one device to another, for example from the computer to the phone, without linking it again. A small passphrase-protected file carries it.</p>
        <div className="btns"><button className="secondary" id="mv-away" onClick={() => setMode("away")}>Move an account away from this device</button><button className="secondary" id="mv-here" onClick={() => setMode("here")}>Receive an account on this device</button></div></>}
      {mode === "away" && <Source onClose={() => setMode("")} />}
      {mode === "here" && <Target onClose={() => setMode("")} />}
    </div>);
}

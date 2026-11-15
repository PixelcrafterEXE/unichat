// Identity verification UI (Matrix emoji / SAS, cross-signing set-up, recovery key). Provider-independent: it speaks the generic `verification`
// contract of @unimsg/core (event `verification`; calls verificationStart / Action / Status / Setup / Recover / pendingVerifications).
//   <VerifyHost/>      mounted once in App: incoming-request toast + the emoji dialog + the set-up / recovery-key dialogs
//   <AccountVerify/>   status row + buttons on the account card         <PersonVerify/>  status + "Verify <name>" in a contact panel
//   verifyUi.verify / setup / recover   open the dialogs from anywhere
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, Info, KeyRound, Laptop, Loader2, Shield, ShieldAlert, ShieldCheck, ShieldQuestion, UserCheck } from "lucide-react";
import type { VerificationAction, VerificationState, VerificationStatus } from "../../../packages/core/src/provider";
import { core } from "./util";
import "./verify.css";

type Target = { userId?: string; chatId?: string; name?: string };
type Flow = { kind: "verify"; accountId: string; target?: Target; id?: string; error?: string } | { kind: "setup"; accountId: string } | { kind: "recover"; accountId: string };
const bus = new EventTarget();
const fire = (name: string, detail?: unknown) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const verifyUi = {
  verify: (accountId: string, target?: Target) => fire("flow", { kind: "verify", accountId, target } satisfies Flow),
  setup: (accountId: string) => fire("flow", { kind: "setup", accountId } satisfies Flow),
  recover: (accountId: string) => fire("flow", { kind: "recover", accountId } satisfies Flow),
};
const useChanged = (f: () => void) => { useEffect(() => { const h = () => f(); bus.addEventListener("changed", h); return () => bus.removeEventListener("changed", h); }, [f]); };

const msg = (e: any) => String(e?.message ?? e);

/** Shield with the state of an identity. */
function StateShield({ state, size = 18 }: { state: VerificationStatus["state"] | "loading"; size?: number }) {
  if (state === "verified") return <ShieldCheck size={size} className="vshield ok" aria-hidden />;
  if (state === "unverified") return <ShieldAlert size={size} className="vshield warn" aria-hidden />;
  return <ShieldQuestion size={size} className="vshield" aria-hidden />;
}
const stateText = (s: VerificationStatus["state"] | "loading", who: "device" | "person") =>
  s === "verified" ? "Verified" : s === "unverified" ? "Not verified" : s === "loading" ? "Checking…" : who === "device" ? "Unknown" : "Not verified yet";

// ---------------------------------------------------------------------------------------------- host
export function VerifyHost() {
  const [states, setStates] = useState<Record<string, VerificationState>>({});
  const [flow, setFlow] = useState<Flow>();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const seen = useRef(new Set<string>());      // ids that were shown in the dialog (a cancelled request nobody saw stays silent)
  const [toastErr, setToastErr] = useState("");
  const token = useRef<object>();               // identity of the request being started; cleared when the user cancels before the backend answered
  const abandoned = useRef(false);              // set meanwhile: states of that request stay hidden

  useEffect(() => {
    let alive = true;
    core.ready.then(async () => { try { const l: VerificationState[] = (await core.call("pendingVerifications")) ?? []; if (alive && l.length) setStates((s) => ({ ...Object.fromEntries(l.map((x) => [x.id, x])), ...s })); } catch { /* an older backend */ } });
    const off = core.on((ev: string, d: any) => {
      if (ev === "verification-changed" || ev === "account") { fire("changed"); return; } // status shown on the account card / contact panel is re-read
      if (ev !== "verification") return;
      setStates((s) => ({ ...s, [d.id]: d }));
      if (abandoned.current && d.phase !== "incoming") setDismissed((x) => new Set(x).add(d.id));
      if (d.phase === "done") fire("changed");
      if (d.phase === "incoming") notify(d);
    });
    const onFlow = (e: Event) => {
      const f = (e as CustomEvent).detail as Flow; setFlow(f);
      if (f.kind !== "verify") return;
      const mine = token.current = {}; abandoned.current = false;
      core.call("verificationStart", { accountId: f.accountId, ...(f.target?.userId ? { userId: f.target.userId } : {}), ...(f.target?.chatId ? { chatId: f.target.chatId } : {}) }).then(
        (r: { id: string }) => { if (token.current === mine) setFlow({ ...f, id: r.id }); else { setDismissed((x) => new Set(x).add(r.id)); void core.call("verificationAction", { accountId: f.accountId, id: r.id, action: "cancel" }).catch(() => {}); abandoned.current = false; } },
        (e: any) => { if (token.current === mine) setFlow({ ...f, error: msg(e) }); abandoned.current = false; });
    };
    bus.addEventListener("flow", onFlow);
    return () => { alive = false; off(); bus.removeEventListener("flow", onFlow); };
  }, []);

  const dismiss = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), []);
  const incoming = Object.values(states).find((s) => s.phase === "incoming" && !dismissed.has(s.id));
  const own = flow?.kind === "verify" && flow.id ? states[flow.id] : undefined;
  const auto = Object.values(states).find((s) => s.phase !== "incoming" && !dismissed.has(s.id) && (seen.current.has(s.id) || s.phase !== "cancelled" && s.phase !== "done"));
  const shown = own && !dismissed.has(own.id) ? own : auto;
  if (shown) seen.current.add(shown.id);

  const act = async (st: VerificationState, action: VerificationAction) => {
    try { await core.call("verificationAction", { accountId: st.accountId, id: st.id, action }); } catch (e) { setToastErr(msg(e)); }
  };
  const close = (st: VerificationState) => {
    if (st.phase !== "done" && st.phase !== "cancelled") void act(st, "cancel");
    dismiss(st.id); if (flow?.kind === "verify" && (!flow.id || flow.id === st.id)) { if (!flow.id) abandoned.current = true; token.current = undefined; setFlow(undefined); }
  };
  const accept = async (st: VerificationState) => {
    setFlow({ kind: "verify", accountId: st.accountId, id: st.id });
    try { await core.call("verificationAction", { accountId: st.accountId, id: st.id, action: "accept" }); } catch (e) { setToastErr(msg(e)); }
  };

  return <>
    {incoming && !shown && <IncomingDialog st={incoming} onAccept={() => accept(incoming)} onDecline={() => { dismiss(incoming.id); void act(incoming, "decline"); }} />}
    {toastErr && <div className="toast vtoasterr" role="alert"><span>{toastErr}</span><button className="secondary" onClick={() => setToastErr("")}>OK</button></div>}
    {flow?.kind === "verify" && !shown && (!flow.id || flow.error) && <StartDialog flow={flow} onClose={() => { if (!flow.error) abandoned.current = true; token.current = undefined; setFlow(undefined); }} />}
    {shown && <SasDialog st={shown} onAction={(a) => act(shown, a)} onClose={() => close(shown)} />}
    {flow?.kind === "setup" && <SetupDialog accountId={flow.accountId} onClose={() => setFlow(undefined)} />}
    {flow?.kind === "recover" && <RecoverDialog accountId={flow.accountId} onClose={() => setFlow(undefined)} />}
  </>;
}

function notify(st: VerificationState) {
  try {
    const on = JSON.parse(localStorage.getItem("unimsg.settings") ?? "{}").notifications;
    if (on && "Notification" in window && Notification.permission === "granted") { const n = new Notification("UniChat", { body: `${st.other.name} wants to verify you`, tag: "unichat-verify" }); n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); }; }
  } catch { /* notifications are optional */ }
}

function IncomingDialog({ st, onAccept, onDecline }: { st: VerificationState; onAccept: () => void; onDecline: () => void }) {
  return (
    <Dialog title="Verification request" onClose={onDecline} label="incoming" cls="vincoming">
      <div className="vwho"><Shield size={26} className="vshield" aria-hidden /><b>{st.other.name}</b></div>
      <p className="vtext"><b>{st.other.name}</b> wants to verify you. {st.other.kind === "device" ? "This is one of your own devices. Only accept if you just started it." : "Accept only if you are talking to this person right now."}</p>
      <div className="vbtns"><button className="secondary" data-act="decline" onClick={onDecline}>Decline</button><button className="primary" data-act="accept" onClick={onAccept}>Accept</button></div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------- starting a request
function StartDialog({ flow, onClose }: { flow: Extract<Flow, { kind: "verify" }>; onClose: () => void }) {
  const t = flow.target; const user = !!(t?.userId || t?.chatId);
  return (
    <Dialog title={user ? `Verify ${t?.name ?? "this person"}` : "Verify this device"} onClose={onClose} label="verify-start">
      {flow.error
        ? <><div className="vhero bad"><ShieldAlert size={56} aria-hidden /></div><p className="vreason" role="alert">{flow.error}</p><div className="vbtns"><button className="primary" data-act="close" onClick={onClose}>Close</button></div></>
        : <><WaitingBody user={user} name={t?.name} /><div className="vbtns"><button className="secondary" data-act="cancel" onClick={onClose}>Cancel</button></div></>}
    </Dialog>
  );
}

function WaitingBody({ user, name, incoming }: { user: boolean; name?: string; incoming?: boolean }) {
  return <>
    <div className="vhero"><Loader2 size={44} className="spin" aria-hidden /></div>
    {incoming ? <p className="vtext">Starting the emoji comparison…</p>
      : user ? <><p className="vtext">Waiting for {name ?? "them"} to accept…</p><p className="vtext">They see your request in your chat and have to accept it in their Matrix app. This can take a moment.</p></>
      : <><p className="vtext">Waiting for your other device…</p>
        <ol className="vsteps"><li>Open Element (or another Matrix app) on your other device.</li><li>Accept the request <b>“Verify this session”</b>.</li><li>Come back here and compare the emojis.</li></ol></>}
  </>;
}

// ---------------------------------------------------------------------------------------------- the emoji dialog
function Dialog({ title, children, onClose, label, closable = true, cls = "" }: { title: string; children: React.ReactNode; onClose: () => void; label: string; closable?: boolean; cls?: string }) {
  void onClose; void closable;
  return (
    <div className="vdlg" role="presentation">
      <div className={"vsheet vmodal " + cls} role="dialog" aria-modal="true" aria-label={title} data-verify={label}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function SasDialog({ st, onAction, onClose }: { st: VerificationState; onAction: (a: VerificationAction) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [st.phase]);
  const name = st.other.name; const user = st.other.kind === "user";
  const title = st.phase === "done" ? "Verified" : st.phase === "cancelled" ? "Verification stopped" : st.phase === "waiting" && !user && !st.incoming ? "Verify this device" : `Verify ${name}`;
  const grid = st.emoji && (st.phase === "sas" || st.phase === "confirming");
  return (
    <Dialog title={title} onClose={onClose} label={st.phase}>
      {st.phase === "waiting" && <><WaitingBody user={user} name={name} incoming={st.incoming} /><div className="vbtns"><button className="secondary" data-act="cancel" onClick={onClose}>Cancel</button></div></>}
      {grid && <>
        <p className="vtext">Check that {user ? name : "the other device"} shows the <b>same emojis in the same order</b>.</p>
        <ul className={"vemojis" + (st.phase === "confirming" ? " dim" : "")} aria-label="Emojis to compare">
          {st.emoji!.map(([e, n], i) => <li key={i} className="vemoji"><span className="vglyph" aria-hidden>{e}</span><span className="vname">{n}</span></li>)}
        </ul>
        {st.phase === "sas" && <>
          <p className="vtext">{user ? "Ask them over a call or in person, not in this chat." : "The emojis look different on every screen, but their names are the same."}</p>
          <div className="vbtns three">
            <button className="secondary" data-act="cancel" disabled={busy} onClick={onClose}>Cancel</button>
            <button className="secondary danger" data-act="nomatch" disabled={busy} onClick={() => { setBusy(true); onAction("mismatch"); }}>They don't match</button>
            <button className="primary" data-act="match" disabled={busy} onClick={() => { setBusy(true); onAction("confirm"); }}>They match</button>
          </div></>}
        {st.phase === "confirming" && <><div className="vwait" role="status"><Loader2 size={18} className="spin" aria-hidden /> Waiting for {name} to confirm…</div>
          <div className="vbtns"><button className="secondary" data-act="cancel" onClick={onClose}>Cancel</button></div></>}
      </>}
      {st.phase === "done" && <><div className="vhero ok"><ShieldCheck size={72} aria-hidden /></div>
                <p className="vtext">{user ? `You verified ${name}. Their messages now show as coming from a verified person.` : "This device is verified. It can now get your message keys from your other devices."}</p>
        <div className="vbtns"><button className="primary" data-act="done" onClick={onClose}>Done</button></div></>}
      {st.phase === "cancelled" && <><div className="vhero bad"><ShieldAlert size={64} aria-hidden /></div>
        <p className="vreason" role="alert">{st.reason ?? "The verification was cancelled."}</p>
        <div className="vbtns"><button className="primary" data-act="close" onClick={onClose}>Close</button></div></>}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------- set up + recovery key
function SetupDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [pw, setPw] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [key, setKey] = useState<string>();
  const [copied, setCopied] = useState(false); const [saved, setSaved] = useState(false);
  const go = async () => {
    setBusy(true); setErr("");
    try { const r = await core.call("verificationSetup", { accountId, password: pw }); setPw(""); setKey(r?.recoveryKey ?? ""); fire("changed"); } // the password is dropped at once
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(key ?? ""); setCopied(true); } catch { setErr("Could not copy. Select the key and copy it by hand."); } };
  if (key !== undefined) return (
    <Dialog title="Save your recovery key" onClose={onClose} label="setup-done" closable={false}>
      {key ? <>
        <p className="vtext">Your encryption keys are set up. Write down this recovery key: it lets you verify new devices and read your old messages if you lose all your devices.</p>
        <div className="vkeycard"><div className="vkey" data-recovery-key aria-label="Recovery key">{key}</div>
          <button className="secondary" data-act="copy" onClick={copy}><Copy size={16} /> {copied ? "Copied" : "Copy"}</button></div>
        <div className="loginwarn warning" role="note"><AlertTriangle size={18} aria-hidden /><p>This is the only time you see this key. UniChat does <b>not</b> store it and cannot show it again. Keep it somewhere safe (a password manager): without it, and without another verified device, you can lose access to your older encrypted messages.</p></div>
        <label className="vcheck"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my recovery key</label>
      </> : <p className="vtext">Verification is set up.</p>}
      {err && <p className="hint err">{err}</p>}
      <div className="vbtns"><button className="primary" data-act="done" disabled={!!key && !saved} onClick={onClose}>Done</button></div>
    </Dialog>
  );
  return (
    <Dialog title="Set up verification" onClose={onClose} label="setup">
      <p className="vtext">This creates the keys that let your devices and other people verify each other, and an encrypted backup of your message keys.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (pw && !busy) void go(); }}>
        <label>Your account password<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus placeholder="Password of this Matrix account" /></label>
        <div className="loginwarn info"><Info size={18} aria-hidden /><p>The server asks for it once to allow the new keys. UniChat uses it for this one request and does not keep it. If your account signs in with single sign-on and has no password, set up verification in Element instead.</p></div>
        {err && <p className="hint err" role="alert">{err}</p>}
        <div className="vbtns"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!pw || busy}>{busy ? "Setting up…" : "Set up verification"}</button></div>
      </form>
    </Dialog>
  );
}

function RecoverDialog({ accountId, onClose }: { accountId: string; onClose: () => void }) {
  const [v, setV] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState(""); const [ok, setOk] = useState(false);
  const go = async () => {
    setBusy(true); setErr("");
    try { await core.call("verificationRecover", { accountId, recoveryKey: v }); setV(""); setOk(true); fire("changed"); } catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };
  if (ok) return <Dialog title="Verified" onClose={onClose} label="recover-done"><div className="vhero ok"><ShieldCheck size={72} aria-hidden /></div><p className="vtext"><b>This device is verified.</b></p><p className="vtext">Older encrypted messages can now be read where your backup has them.</p><div className="vbtns"><button className="primary" data-act="done" onClick={onClose}>Done</button></div></Dialog>;
  return (
    <Dialog title="Verify with recovery key" onClose={onClose} label="recover">
      <p className="vtext">Use this when you have no other device to compare emojis with. Enter the recovery key (or passphrase) you saved when you set up your encryption keys.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (v.trim() && !busy) void go(); }}>
        <label>Recovery key or passphrase<input type="password" autoComplete="off" spellCheck={false} value={v} onChange={(e) => setV(e.target.value)} autoFocus placeholder="EsTc 4mXk …" /></label>
        {err && <p className="hint err" role="alert">{err}</p>}
        <div className="vbtns"><button type="button" className="secondary" onClick={onClose}>Cancel</button><button className="primary" disabled={!v.trim() || busy}>{busy ? "Checking…" : "Verify"}</button></div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------- entry points
/** Account card: shield + state of this device, "Verify this device", "Set up verification", "Verify with recovery key". */
export function AccountVerify({ accountId }: { accountId: string }) {
  const [st, setSt] = useState<VerificationStatus>(); const [bad, setBad] = useState(false);
  const load = useCallback(() => { core.call("verificationStatus", { accountId }).then((r: VerificationStatus) => { setSt(r); setBad(false); }, () => setBad(true)); }, [accountId]);
  useEffect(load, [load]); useChanged(load);
  if (bad) return null;
  const state = st?.state ?? "loading"; const missing = st?.crossSigning === "missing";
  return (
    <div className="vrow" data-verify-account>
      <div className="vline"><StateShield state={state} /><span><b>This device:</b> <span data-verify-state={state}>{stateText(state, "device")}</span></span></div>
      {state !== "verified" && <p className="hint">{missing ? "This account has no verification keys yet. Set them up once; then you can verify your devices and other people." : "Verify this device by comparing emojis with another device that is already signed in, so it can read your encrypted messages."}</p>}
      <div className="vbtns row">
        {state !== "verified" && !missing && st && <button className="secondary" data-act="verify-device" onClick={() => verifyUi.verify(accountId)}><Laptop size={15} /> Verify this device</button>}
        {missing && <button className="secondary" data-act="setup" onClick={() => verifyUi.setup(accountId)}><ShieldCheck size={15} /> Set up verification</button>}
        {state !== "verified" && !missing && st && <button className="secondary" data-act="recover" onClick={() => verifyUi.recover(accountId)}><KeyRound size={15} /> Verify with recovery key</button>}
      </div>
    </div>
  );
}

/** Contact panel / person: shield + state of that person and "Verify <name>". Renders nothing for messengers without verification. */
export function PersonVerify({ accountId, chatId, userId, name }: { accountId: string; chatId?: string; userId?: string; name: string }) {
  const [st, setSt] = useState<VerificationStatus>(); const [bad, setBad] = useState(false);
  const load = useCallback(() => { core.call("verificationStatus", { accountId, ...(userId ? { userId } : {}), ...(chatId ? { chatId } : {}) }).then((r: VerificationStatus) => { setSt(r); setBad(false); }, () => setBad(true)); }, [accountId, chatId, userId]);
  useEffect(load, [load]); useChanged(load);
  if (bad || !st) return null;
  return (
    <div className="vrow person" data-verify-person>
      <div className="vline"><StateShield state={st.state} /><span data-verify-state={st.state}>{st.state === "verified" ? `${name} is verified` : st.state === "unverified" ? `${name} is not verified` : `${name} has not been verified`}</span></div>
      {st.state !== "verified" && st.crossSigning !== "missing" && <button className="secondary" data-act="verify-person" onClick={() => verifyUi.verify(accountId, { ...(userId ? { userId } : {}), ...(chatId ? { chatId } : {}), name })}><UserCheck size={15} /> Verify {name}</button>}
      {st.state !== "verified" && st.crossSigning === "missing" && <p className="hint">Set up verification in Settings &gt; Accounts first.</p>}
    </div>
  );
}


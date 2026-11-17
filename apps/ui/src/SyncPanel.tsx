// Settings > Sync devices: keep your own devices (computer, phone) in step, with no server of ours.
// Main view = your devices, ONE "Add a device" flow, a small "Connect to another device" for the other side. Everything technical lives under "Advanced" (closed).
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { core, fmtDateTime } from "./util";
import { viaNote } from "./relay";
import { isSyncLink, takeSyncLink } from "./syncLink";
import "./backup.css";
import "./sync.css";

type Mode = "none" | "archive-only" | "credentials";
const MODE_TEXT: Record<Mode, string> = { none: "Don't sync", "archive-only": "Sync history only", credentials: "History and login" };
const ago = (iso?: string) => { if (!iso) return "never"; const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toLocaleDateString(); };
const mb = (n?: number) => (n ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + " MB" : "0 MB");
const addrText = (a: any) => (a.kind === "relay" ? `relay ${a.url}` : `${a.host}:${a.port}`);
export type Run = (f: () => Promise<any>) => void;

/** Android: unless UniChat is exempt from battery optimization, the phone stops answering other devices while the screen is off (Doze). */
function BackgroundHint() {
  const [ignoring, setIgnoring] = useState<boolean>();
  const check = () => core.call("$batteryExemptionState", {}).then((r: any) => setIgnoring(!!(r?.ignoring ?? r?.exempt)), () => setIgnoring(undefined));
  useEffect(() => { void check(); addEventListener("focus", check); return () => removeEventListener("focus", check); }, []);
  if (ignoring !== false) return null;
  return (
    <div className="notifwarn" data-bg-hint role="note"><b>Your other devices can't reach this phone while it sleeps</b>
      <span>Android pauses UniChat's connection when the screen is off. Allow it to run in the background so syncing and "send through this phone" keep working.</span>
      <button className="primary" onClick={() => void core.call("$requestBatteryExemption", {}).then(() => setTimeout(check, 1500), () => {})}>Allow background activity</button></div>);
}

export function SyncPanel() {
  const [st, setSt] = useState<any>(null), [err, setErr] = useState(""), [pair, setPair] = useState<any>(null), [busy, setBusy] = useState(false), [scan, setScan] = useState(false);
  const [host, setHost] = useState(""), [port, setPort] = useState(""), [code, setCode] = useState(""), [toast, setToast] = useState(""), [copied, setCopied] = useState(false);
  const known = useRef<Set<string> | null>(null), fresh = useRef(new Set<string>());
  const load = useCallback(() => core.call("syncStatus").then((s: any) => { setSt(s); if (!s.pairing) setPair(null); }, (e: any) => setErr(e.message)), []);
  useEffect(() => { load(); const off = core.on((ev: string) => { if (ev === "sync-devices" || ev === "sync-progress" || ev === "sync-credentials") load(); }); const t = setInterval(load, 5000); return () => { off(); clearInterval(t); }; }, [load]);
  // "Wi-Fi only" needs to know whether the connection is metered: the browser/WebView tells us when it can (Network Information API)
  useEffect(() => {
    const c = (navigator as any).connection; if (!c || !st?.enabled) return;
    const report = () => { const m = c.type === "cellular" || c.saveData === true; if (m !== !!st.media?.metered) core.call("syncSetMetered", { metered: m }).catch(() => {}); };
    report(); c.addEventListener?.("change", report); return () => c.removeEventListener?.("change", report);
  }, [st?.enabled, st?.media?.metered]);
  // `shown`: the failure has its own place in the panel (joining into the "Connect to another device" box), so the general
  // error line stays empty instead of printing the same sentence a second time underneath it.
  const run: Run = async (f) => { setBusy(true); setErr(""); try { await f(); await load(); } catch (e: any) { if (!e?.shown) setErr(e.message); load(); } finally { setBusy(false); } };

  const midJoin = !!st && !!st.joining && (st.joining.state === "confirm" || st.joining.state === "waiting");
  // keep nearby discovery running while the "Connect to another device" list is visible
  useEffect(() => { if (!st || midJoin) return; const f = () => core.call("syncBrowse").catch(() => {}); f(); const t = setInterval(f, 20_000); return () => clearInterval(t); }, [!!st, midJoin]); // eslint-disable-line react-hooks/exhaustive-deps

  const join = (p: any) => run(async () => { try { await core.call("syncJoin", p); } catch (e: any) { throw Object.assign(e, { shown: true }); } });
  const joinNearby = (d: any) => run(() => core.call("syncJoinNearby", { host: d.host, port: d.port }));
  const startAdd = () => run(async () => setPair(await core.call("syncStartPairing", { keepListening: true })));
  // a pairing link (QR scanned by the system camera, pasted into the web URL as ?pair=) starts joining by itself; only the number comparison is left
  useEffect(() => {
    if (!st) return;
    const take = () => { const l = takeSyncLink(); if (l) join({ link: l }); };
    take(); addEventListener("unichat-sync-link", take); return () => removeEventListener("unichat-sync-link", take);
  }, [!!st]); // eslint-disable-line react-hooks/exhaustive-deps
  // toast "Synced with X" once a device that was just added finished its first sync
  useEffect(() => {
    if (!st) return; const others = st.devices.filter((d: any) => !d.self && !d.revoked);
    if (known.current === null) { known.current = new Set(others.map((d: any) => d.id)); return; }
    for (const d of others) {
      if (!known.current.has(d.id)) { known.current.add(d.id); fresh.current.add(d.id); }
      if (fresh.current.has(d.id) && d.online && d.progress?.state === "idle" && d.progress.lastSync) { fresh.current.delete(d.id); setToast(`Synced with ${d.name}`); setTimeout(() => setToast(""), 5000); }
    }
  }, [st]);

  if (!st) return <div className="bk sync"><h2>Sync devices</h2>{err ? <p className="err">{err}</p> : <p className="hint">Loading…</p>}</div>;
  if (st.loading) return <div className="bk sync" id="sync-panel"><h2>Sync devices</h2><p className="hint" id="sync-loading"><span className="spin" /> Getting ready: preparing your messages for syncing. The first time this can take a few minutes on a phone.</p></div>;
  const others = st.devices.filter((d: any) => !d.self);
  const flip = st.joining?.state === "failed" && st.joining.reason === "unreachable" && !st.pairing && !pair;
  const adding = !!(pair || st.pairing);
  const syncing = others.find((d: any) => d.online && !d.revoked && (d.progress?.phase === "snapshot" || d.progress?.state === "syncing"));
  const nearby = (st.discovered ?? []).filter((d: any) => d.nearby);
  return (
    <div className="bk sync" id="sync-panel"><h2>Sync devices</h2>
      {(window as any).UnimsgNative && <BackgroundHint />}
      <p className="hint">Keep UniChat on your phone and computer in step, directly between them and encrypted.</p>
      {toast && <div className="synctoast" id="sync-toast" role="status">{toast}</div>}
      {st.revoked && <div className="warn" id="sync-revoked"><b>This device was removed from the sync.</b> It keeps what it has but gets nothing new. <button className="secondary" onClick={() => run(() => core.call("syncLeave"))}>Start over</button></div>}
      {st.removedNotice && <div className="warn" id="sync-removed-notice" role="status"><b>{st.removedNotice.reason === "alone" ? "This device was unlinked: all other devices were removed." : `Removed from the sync group by ${st.removedNotice.by}.`}</b> This device is no longer synced with your other devices. It keeps its messages; your account logins are untouched. To sync again, add it to a group with a new code.
        <div className="btns"><button className="secondary" id="sync-removed-ok" onClick={() => run(() => core.call("syncDismissRemoved"))}>OK</button></div></div>}
      {st.unlinking && <div className="warn" id="sync-unlinking"><b>{st.unlinking.online ? `Unlinking: telling ${st.unlinking.name}…` : `${st.unlinking.name} will unlink when it comes online.`}</b> With only two devices, both unlink: this device stays linked until {st.unlinking.name} has been told, so that it does not keep a group of one.
        <div className="btns"><button className="secondary" id="sync-unlink-now" disabled={busy} onClick={() => confirm(`Unlink this device now? ${st.unlinking.name} is not told and stays linked until you remove this device there.`) && run(() => core.call("syncLeave", { force: true }))}>Unlink anyway</button></div></div>}

      <Confirm st={st} busy={busy} run={run} />

      {st.enabled && !st.revoked && <div className="box" id="sync-devices">
        <h3 style={{ marginTop: 0 }}>Your devices {st.paused && <small className="sub">(paused)</small>}</h3>
        {st.devices.filter((d: any) => !d.revoked).map((d: any) => <DeviceRow key={d.id} d={d} busy={busy} run={run} two={st.devices.filter((x: any) => !x.revoked).length === 2} rel={(st.proxy?.decisions ?? []).filter((x: any) => x.deviceId === d.id)} />)}
        {!others.length && <p className="hint">No other device yet.</p>}
        {st.devices.filter((d: any) => d.revoked && d.removalPending).map((d: any) => <p className="hint" key={d.id} data-removal-pending={d.name} id="sync-removal-pending">Removal pending for {d.name} (offline): it is told and unlinks itself when it next connects to one of your devices.</p>)}
        {syncing && <SyncProgress d={syncing} st={st} />}
      </div>}
      {st.pendingCredentials?.map((c: any) => (
        <div className="warn" key={c.accountId} id="sync-cred-offer"><b>{c.fromName} offers the login for {c.label}.</b> Using it here signs this device in to {c.provider} with the same session ({mb(c.bytes)}). Only accept it if you trust that device.
          <div className="btns"><button className="primary inline" onClick={() => run(() => core.call("syncConfirmCredentials", { accountId: c.accountId, accept: true }))}>Use this login</button>
            <button className="secondary" onClick={() => run(() => core.call("syncConfirmCredentials", { accountId: c.accountId, accept: false }))}>Ignore</button></div></div>))}

      <div className="box" id="sync-add">
        {!adding ? <><button className="primary inline big" id="sync-start" disabled={busy || st.revoked || !!st.unlinking} onClick={startAdd}>Add a device</button>
          <p className="hint">Shows a code on this screen for your other device to scan or find.</p></>
          : <Pairing p={pair ?? st.pairing} copied={copied} onCopy={(l) => { navigator.clipboard?.writeText(l).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {}); }} onStop={() => run(() => core.call("syncStopPairing"))} />}
      </div>

      {!midJoin && !st.approval && <div className="box small" id="sync-join">
        <h4>Connect to another device</h4>
        {st.discovery?.available !== false && <div id="sync-nearby"><small className="sub">Nearby devices</small>
          {nearby.map((d: any) => <div className="row2 nearby" key={d.instance} data-nearby={d.name}><span style={{ flex: 1 }}><b>{d.name}</b></span><button className="secondary" disabled={busy} onClick={() => joinNearby(d)}>Connect</button></div>)}
          {!nearby.length && <p className="sub"><span className="spin" /> Looking for devices that show "Add a device"…</p>}</div>}
        <div className="btns" style={{ marginTop: 6 }}>{typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && <button className="secondary" id="sync-scan" disabled={busy} onClick={() => setScan(true)}>Scan QR code</button>}</div>
        {scan && <Scanner onClose={() => setScan(false)} onLink={(l) => { setScan(false); join({ link: l }); }} />}
        <label className="sub">Or type its code<input type="text" id="sync-code" placeholder="bako-lemi-zuta-nosu" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
        <div className="btns"><button className="secondary" id="sync-joinbtn" disabled={busy || !code.trim()} onClick={() => join(isSyncLink(code.trim()) ? { link: code.trim() } : { code, host: host.trim() || undefined, port: port.trim() ? Number(port) : undefined })}>{busy && code ? "Looking for the other device…" : "Connect"}</button></div>
        {flip && <div className="warn" id="sync-flip"><b>Couldn't reach that device.</b> Some devices don't accept connections from others. Show a code here instead and enter it there.
          <div className="btns"><button className="primary inline" id="sync-flip-btn" disabled={busy} onClick={startAdd}>Add a device here instead</button></div></div>}
        {st.joining?.state === "failed" && st.joining.reason === "code" && <p className="err" id="sync-join-badcode">A device answered but did not accept that code. Codes run out after a few minutes: check the letters, and that the other device is still showing <em>this</em> code (start a new one there if not).</p>}
        {st.joining?.state === "failed" && !st.joining.reason && <p className="err" id="sync-join-failed">{st.joining.error}</p>}
      </div>}
      {err && !flip && <p className="err" id="sync-err">{err}</p>}

      <details id="sync-advanced" className="adv"><summary>Advanced</summary>
        <Advanced st={st} busy={busy} run={run} host={host} port={port} setHost={setHost} setPort={setPort} />
      </details>
    </div>);
}

/** The one confirmation dialog: a big number, "It matches" / "Cancel". Shown on both devices; closes by itself when the pairing is over. */
export function Confirm({ st, busy, run }: { st: any; busy: boolean; run: Run }) {
  const a = st.approval, j = st.joining && (st.joining.state === "confirm" || st.joining.state === "waiting") ? st.joining : undefined;
  if (!a && !j) return null;
  const name = a ? a.deviceName : j.hostName, sas = a ? a.sas : j.sas, nearby = a ? a.nearby : j.nearby;
  const waiting = a ? a.hostOk === true : j.state === "waiting";
  const title = a ? (nearby ? `Allow ${name}?` : `Add ${name}?`) : `Connect to ${name}?`;
  const ok = () => run(() => (a ? core.call("syncApproveJoin", { accept: true }) : core.call("syncConfirmJoin", { accept: true, keepListening: true })));
  const no = () => run(() => (a ? core.call("syncApproveJoin", { accept: false }) : core.call("syncCancelJoin")));
  return (
    <div className="syncdlg" role="dialog" aria-modal="true" id="sync-confirm"><div className="sheet">
      <h3 id="sync-confirm-title">{title}</h3>
      <p className="hint">Make sure {name} shows this same number. If it doesn't, or you didn't start this, choose Cancel.</p>
      <div className="sas" id="sync-confirm-sas">{sas}</div>
      {waiting ? <p className="sub" id="sync-confirm-wait"><span className="spin" /> Waiting for {name} to confirm…</p> : null}
      <div className="btns">{!waiting && <button className="primary inline" id="sync-match" disabled={busy} onClick={ok}>It matches</button>}
        <button className="secondary" id="sync-cancel" disabled={busy && !waiting} onClick={no}>Cancel</button></div>
    </div></div>);
}

/** Is a paired device still sending us its accounts (`accounts`) or its chats and messages (`history`)? Fed by sync-progress events, so Settings, the account list and the empty state can say "receiving" instead of "No accounts yet". */
export function useSyncReceiving() {
  const [r, set] = useState({ accounts: false, history: false });
  useEffect(() => {
    const by = new Map<string, any>(), calc = () => { let accounts = false, history = false; for (const p of by.values()) { if (p.state !== "syncing" || p.phase === "snapshot") continue; if (p.accts && p.accts.done < p.accts.total) accounts = true; if (p.chats && p.chats.done < p.chats.total) history = true; } set((o) => (o.accounts === accounts && o.history === history ? o : { accounts, history })); };
    const feed = (devs: any[]) => { for (const d of devs ?? []) if (!d.self) by.set(d.id, d.progress ?? {}); calc(); };
    core.call("syncStatus").then((st: any) => feed(st?.devices), () => {});
    return core.on((ev: string, d: any) => { if (ev === "sync-progress" && d?.peer) { by.set(d.peer, d); calc(); } else if (ev === "sync-devices" && d?.devices) feed(d.devices); });
  }, []);
  return r;
}

function SyncProgress({ d, st }: { d: any; st: any }) {
  const p = d.progress ?? {}, snap = p.phase === "snapshot" && p.snapTotal > 0, pct = snap ? Math.min(100, (100 * p.snapDone) / p.snapTotal) : undefined;
  const files = st.media?.wanted ?? 0, fMB = Math.round((st.media?.fetchedBytes ?? 0) / 1048576);
  const recv = !snap && p.accts && p.chats && (p.accts.done < p.accts.total || p.chats.done < p.chats.total), send = !snap && p.out && (p.out.accts.done < p.out.accts.total || p.out.chats.done < p.out.chats.total);
  const phases = (id: string, ph: { accts: any; chats: any }, withFiles: boolean) => {
    const aDone = ph.accts.done >= ph.accts.total, cDone = ph.chats.done >= ph.chats.total;
    const row = (k: string, label: string, done: boolean, n: any) => <li data-phase={k} data-done={done ? "1" : undefined}>{done ? "✓ " : ""}{label}{!done ? ` · ${n.done} of ${n.total}` : ""}</li>;
    return <ul className="phases" data-phases={id}>{row("accounts", "Accounts and settings", aDone, ph.accts)}{row("chats", "Chats and messages", cDone, ph.chats)}
      {withFiles && <li data-phase="files" data-done={cDone && !files ? "1" : undefined}>{cDone && !files ? "✓ " : ""}Files{files ? ` · ${files} waiting${fMB ? `, ${fMB} MB received` : ""}` : cDone ? "" : " · after the messages"}</li>}</ul>;
  };
  const left = send ? p.out.chats.total - p.out.chats.done : 0;
  return <div id="sync-progress">
    <p className="sub">{recv || !send ? "Syncing with" : "Sending to"} {d.name}{pct !== undefined ? ` · ${Math.round(pct)}%` : ""}{!snap && !recv && !send && p.pending ? ` · ${p.pending} messages left` : ""}{!recv && !send && files ? ` · ${files} files waiting` : ""}</p>
    {recv && phases("in", p, true)}
    {send && <><p className="sub" data-sending>Sending to {d.name} · {left} messages left</p>{phases("out", p.out, false)}</>}
    <div className="bar big"><i style={{ width: `${pct ?? (recv ? Math.min(100, (100 * (p.accts.done + p.chats.done)) / Math.max(1, p.accts.total + p.chats.total)) : 100)}%`, opacity: pct === undefined && !recv ? 0.4 : 1 }} /></div></div>;
}

function DeviceRow({ d, busy, run, rel = [], two = false }: { d: any; busy: boolean; run: Run; rel?: any[]; two?: boolean }) {
  const [renaming, setRenaming] = useState(false), [nm, setNm] = useState(d.name), p = d.progress;
  const syncingNow = d.online && (p?.phase === "snapshot" || p?.state === "syncing");
  const info = d.self ? "This device" : syncingNow ? "Syncing…" : d.online ? `Connected · last synced ${ago(p?.lastSync ?? d.lastSeen)}` : `Offline · last synced ${ago(p?.lastSync ?? d.lastSeen)}`;
  const problem = !d.self && !d.online && (p?.state === "offline" || p?.state === "error" || !(d.addrs?.length))
    ? ((d.addrs?.length) ? `Couldn't reach ${d.name}. Make sure both are on the same Wi-Fi.` : `${d.name} isn't reachable yet. Open UniChat on it while both are on the same Wi-Fi.`) : "";
  const kind: string | undefined = d.online && !d.self ? (d.viaKind ?? (typeof d.via === "string" ? (d.via === "dht" ? "dht" : d.via.startsWith("relay") ? "relay" : "direct") : undefined)) : undefined;
  const kindText = kind === "direct" ? "Direct (Wi-Fi)" : kind === "dht" ? "Through the internet (DHT)" : kind === "relay" ? "Via relay" : "";
  const kindTip = kind === "direct" ? `Connected straight to ${d.name} over your local network${d.lastAddr ? ` (${d.lastAddr})` : ""}: fastest, nothing leaves your Wi-Fi.`
    : kind === "dht" ? `${d.name} is not reachable on your local network right now, so UniChat connected through the internet (encrypted end to end, no server of ours). It switches to a direct connection by itself as soon as both devices can see each other.`
    : kind === "relay" ? `Connected through your relay server because no direct path was possible. Everything stays end-to-end encrypted.` : "";
  return (
    <div className="devrow" data-dev={d.name}>
      <span className={d.online ? "dot on" : "dot"} title={d.online ? "Online" : "Offline"} />
      <div className="who">{renaming ? <div className="row2"><input type="text" value={nm} onChange={(e) => setNm(e.target.value)} aria-label="Device name" /><button className="secondary" disabled={busy || !nm.trim()} onClick={() => { setRenaming(false); run(() => core.call("syncRenameDevice", { name: nm })); }}>Save</button></div> : <b>{d.name}</b>}
        <small className="sub">{info}</small>{kindText && <small className="sub" data-conn-kind={kind} title={kindTip}>{kindText}</small>}{problem && <small className="err" data-dev-problem={d.name}>{problem}</small>}
        {rel.map((x: any) => <small className="sub relayrow" key={x.accountId} data-relay-dev={d.name} data-relay-acct={x.accountId}>{x.allowed ? `Can send as ${x.label}` : `Can't send as ${x.label}`}{" "}
          <button className="linkbtn" disabled={busy} onClick={() => run(() => core.call("syncRelaySet", { deviceId: d.id, accountId: x.accountId, allow: !x.allowed }))}>{x.allowed ? "Stop allowing" : "Allow"}</button></small>)}</div>
      {d.self ? !renaming && <button className="linkbtn" onClick={() => setRenaming(true)}>Rename</button>
        : <button className="secondary" disabled={busy} onClick={() => confirm(`Remove "${d.name}"? This tells all other devices; with only two devices both unlink.${two ? ` Right now only two devices are linked, so this device unlinks too (and if ${d.name} is offline it unlinks as soon as it is online).` : ` ${d.name} unlinks itself and keeps only what it already has.`}`) && run(() => core.call("syncRevoke", { deviceId: d.id }))}>Remove</button>}
    </div>);
}

export function Pairing({ p, onStop, onCopy, copied }: { p: any; onStop: () => void; onCopy: (l: string) => void; copied: boolean }) {
  const [left, setLeft] = useState(Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000)));
  useEffect(() => { const t = setInterval(() => setLeft(Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))), 500); return () => clearInterval(t); }, [p.expiresAt]);
  return (
    <div id="sync-pairing"><h3 style={{ marginTop: 0 }}>Add a device</h3>
      <p className="hint">On your other device, open Sync devices, then scan this code, choose this device under Nearby devices, or type the code.</p>
      <div className="paircard">
        <div className="qr"><QRCodeSVG value={p.link} size={150} /></div>
        <div className="codebox"><div id="sync-code-shown" className="code">{p.code}</div>
          <small className="sub">{left > 0 ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Expired"}</small>
          <div className="btns"><button className="secondary" id="sync-copy" onClick={() => onCopy(p.link)}>{copied ? "Copied" : "Copy link"}</button></div></div></div>
      <p className="sub" id="sync-waiting"><span className="spin" /> Waiting for the other device…</p>
      {p.dht && p.dht !== "off" && <p className="sub" id="sync-pair-net">{p.dht === "ready" ? "Also reachable through the internet: the other device can be on a different network (university, mobile data)." : p.dht === "starting" ? "Opening the internet route for devices on other networks…" : "The internet route is not available here; only devices on the same Wi-Fi can pair."}</p>}
      <div className="btns"><button className="secondary" id="sync-stop" onClick={onStop}>Cancel</button></div></div>);
}

/** Camera QR scanner (getUserMedia + jsQR, bundled; the decoder is loaded only when the camera opens). Falls back to a message when there is no camera or no permission. */
function Scanner({ onLink, onClose }: { onLink: (l: string) => void; onClose: () => void }) {
  const v = useRef<HTMLVideoElement>(null), [msg, setMsg] = useState("Starting the camera…"), [dead, setDead] = useState(false);
  useEffect(() => {
    let stop = false, timer = 0, stream: MediaStream | undefined;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stop) return stream.getTracks().forEach((t) => t.stop());
        const el = v.current!; el.srcObject = stream; await el.play(); setMsg("Point the camera at the QR code on the other device.");
        const jsQR = (await import("jsqr")).default, c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true })!;
        const tick = () => {
          if (stop) return;
          if (el.videoWidth) {
            const k = Math.min(1, 640 / el.videoWidth); c.width = Math.round(el.videoWidth * k); c.height = Math.round(el.videoHeight * k); x.drawImage(el, 0, 0, c.width, c.height);
            const r = jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
            if (r && isSyncLink(r.data)) return onLink(r.data.trim());
          }
          timer = window.setTimeout(tick, 150);
        };
        tick();
      } catch { if (!stop) { setDead(true); setMsg("Couldn't use the camera. Type the code instead."); } }
    })();
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="scanner" id="sync-scanner">{!dead && <video ref={v} playsInline muted />}<p className="sub" id="sync-scan-msg">{msg}</p><div className="btns"><button className="secondary" id="sync-scan-close" onClick={onClose}>Close</button></div></div>;
}

function Advanced({ st, busy, run, host, port, setHost, setPort }: { st: any; busy: boolean; run: Run; host: string; port: string; setHost: (s: string) => void; setPort: (s: string) => void }) {
  const others = st.devices.filter((d: any) => !d.self && !d.revoked);
  return (<>
    {st.enabled && !st.revoked && <>
      <div className="box"><h3 style={{ marginTop: 0 }}>This device</h3>
        <div className="btns"><button className="secondary" disabled={busy} onClick={() => run(() => core.call("syncNow"))}>Sync now</button>
          <button className="secondary" disabled={busy} onClick={() => run(() => core.call(st.paused ? "syncResume" : "syncPause"))}>{st.paused ? "Resume syncing" : "Pause syncing"}</button>
          <button className="secondary" disabled={busy} onClick={() => confirm(others.length === 1 ? `Stop syncing on this device? This tells ${others[0].name}; with only two devices both unlink. Both keep their data.` : "Stop syncing on this device? It tells your other devices, keeps its data and is no longer connected to them.") && run(() => core.call("syncLeave"))}>Stop syncing here</button></div>
        <p className="hint">Rename a device in the list above.</p></div>
      <Accounts st={st} busy={busy} run={run} others={others} />
      <Network st={st} busy={busy} run={run} />
      {others.length > 0 && <div className="box" id="sync-addresses"><h3 style={{ marginTop: 0 }}>Where to find your devices</h3><p className="hint">UniChat remembers addresses by itself. Add one only if a device is never found.</p>
        {others.map((d: any) => <Addresses key={d.id} d={d} run={run} />)}</div>}
      <MediaBox st={st} busy={busy} run={run} /></>}
    <div className="box"><h3 style={{ marginTop: 0 }}>Connect by address</h3><p className="hint">Only if "Connect" finds nothing. Used together with the code above.</p>
      <div className="row2"><label className="sub">Address<input type="text" id="sync-host" placeholder="192.168.1.20" value={host} onChange={(e) => setHost(e.target.value)} /></label>
        <label className="sub">Port<input type="text" id="sync-port" placeholder="45045" value={port} onChange={(e) => setPort(e.target.value)} /></label></div></div>
    <p className="hint">Synced: messages, chat names, pins and folders, settings, accounts. Attachments are fetched when you open them. Signal and WhatsApp logins are never copied.</p>
  </>);
}

/** one-shot: send this device's archive of one account to one device (the other device confirms first) */
function HistoryPush({ a, others, busy, run }: { a: any; others: any[]; busy: boolean; run: Run }) {
  const [dev, setDev] = useState(others[0]?.id ?? "");
  return <div className="row2" data-push-history={a.id} style={{ marginTop: 6 }}><select value={dev} aria-label="Device" onChange={(e) => setDev(e.target.value)}>{others.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
    <button className="secondary" disabled={busy || !dev} onClick={() => run(() => core.call("syncSendHistory", { accountId: a.id, deviceId: dev }))}>Send the full history of {a.label} now</button></div>;
}
function Accounts({ st, busy, run, others }: { st: any; busy: boolean; run: Run; others: any[] }) {
  const recv = useSyncReceiving();
  return (
    <div className="box" id="sync-accounts"><h3 style={{ marginTop: 0 }}>What to share per account</h3><p className="hint">Logins stay on the device where you signed in, unless you choose "History and login".</p>
      {st.accounts.map((a: any) => (
        <div key={a.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}>
          <label className="opt" style={{ alignItems: "center" }}><span style={{ flex: 1 }}><b>{a.label}</b>{recv.history && a.mode !== "none" && <em className="badge" data-receiving={a.id}> receiving history…</em>}<small className="sub">{a.provider}{a.mode === "credentials" ? " · the login is sent encrypted to your other devices" : ""}</small></span>
            <select value={a.mode} disabled={busy} data-acc={a.id} onChange={(e) => {
              const m = e.target.value as Mode;
              if (m === "credentials" && !confirm(`Share the login of "${a.label}" with your other devices?\n\nThey will ask you before using it. Anyone who gets hold of one of your devices could then use this account.`)) return;
              run(() => core.call("syncSetAccountMode", { accountId: a.id, mode: m }));
            }}>
              <option value="none">{MODE_TEXT.none}</option><option value="archive-only">{MODE_TEXT["archive-only"]}</option>
              {a.canShareCredentials && <option value="credentials">{MODE_TEXT.credentials}</option>}</select></label>
          {a.credentialsError && <p className="err" data-cred-err={a.id}>{a.credentialsError}</p>}
          {a.sharedFrom && <p className="hint" data-shared-from={a.id}>This account comes from {a.sharedFrom}; share it from there.</p>}
          {others.some((d: any) => d.online) && <HistoryPush a={a} others={others.filter((d: any) => d.online)} busy={busy} run={run} />}
          {a.canShareProxy && others.length > 0 && <label className="opt"><input type="checkbox" data-proxy={a.id} checked={a.proxyShared} disabled={busy || a.mode === "none"} onChange={(e) => {
            if (e.target.checked && !confirm(`Let your other devices use "${a.label}" through this device?\n\nThey can read and send messages as this account while this device is on and reachable. The login itself never leaves this device.`)) return;
            run(() => core.call("syncSetProxyShare", { accountId: a.id, enabled: e.target.checked }));
          }} /><span>Let my other devices send as this account<small className="sub">{a.proxyShared ? "On: all your devices may send through this one while it is on." : "Off: a device asks first, and you answer once. The login always stays here."}</small></span></label>}
          {a.via && <p className="hint" data-account-via={a.id}>{viaNote(a.via)}</p>}
          {st.devices.filter((d: any) => d.audit?.[a.id]?.recent?.length).map((d: any) => <details key={d.id} className="relaylog" data-relay-log={d.name}><summary>Sent from {d.name}: {d.audit[a.id].byOp.send ?? 0} messages, {d.audit[a.id].calls} requests</summary>
            <ul>{d.audit[a.id].recent.slice().reverse().map((r: any, i: number) => <li key={i}><code>{r.op}</code> <small className="sub">{fmtDateTime(r.at)}{r.err ? " · failed" : ""}</small></li>)}</ul></details>)}
          {a.proxyVia && <p className="hint" data-proxy-via={a.id}>Sending through <b>{a.proxyVia.deviceName ?? "another device"}</b>{a.proxyVia.auto ? " (automatic)" : ""}: {a.proxyVia.online ? "connected" : "that device is offline, showing your archive"}. <button className="linkbtn" onClick={() => run(() => core.call("syncStopProxy", { accountId: a.id }))}>Stop using it through that device</button></p>}
        </div>))}
      {!st.accounts.length && <p className="hint">No accounts yet.</p>}
      {st.proxy?.offers?.filter((o: any) => !o.using).map((o: any) => (
        <div className="row2" key={o.deviceId + o.accountId} data-offer={o.accountId} style={{ borderTop: "1px solid var(--border)", padding: "8px 0" }}><span style={{ flex: 1 }}><b>{o.label}</b><small className="sub">{o.provider} · offered by {o.deviceName}</small></span>
          <button className="secondary" disabled={busy} onClick={() => run(() => core.call("syncUseProxy", { deviceId: o.deviceId, accountId: o.accountId }))}>Add account from {o.deviceName}</button></div>))}
    </div>);
}

function Addresses({ d, run }: { d: any; run: Run }) {
  const [open, setOpen] = useState(false), [txt, setTxt] = useState("");
  const manual = (d.addrs ?? []).filter((a: any) => a.src === "manual");
  const save = (list: any[]) => run(() => core.call("syncSetAddresses", { deviceId: d.id, addrs: list }));
  const add = () => {
    const t = txt.trim(); if (!t) return;
    if (/^wss?:\/\//.test(t)) save([...manual, { kind: "relay", url: t }]);
    else { const m = /^(\[?[^\]]+?\]?):(\d+)$/.exec(t); if (!m) return; save([...manual, { kind: "tcp", host: m[1].replace(/^\[|\]$/g, ""), port: Number(m[2]) }]); }
    setTxt("");
  };
  return (<div data-dev-addr={d.name}><div className="row2"><b style={{ flex: 1 }}>{d.name}</b><button className="secondary" onClick={() => setOpen(!open)}>{open ? "Hide addresses" : "Addresses"}</button></div>
    {open && <div className="addrs" data-addrs={d.name}>
      <ul>{(d.addrs ?? []).map((a: any, i: number) => <li key={i}><code>{addrText(a)}</code><small className="sub">{a.src}{a.good ? ` · worked ${ago(a.good)}` : ""}{a.bad && !a.good ? " · failed" : ""}</small>
        {a.src === "manual" && <button className="linkbtn" onClick={() => save(manual.filter((m: any) => addrText(m) !== addrText(a)))}>remove</button>}</li>)}
        {!(d.addrs ?? []).length && <li><i>none yet: learned when the device connects</i></li>}</ul>
      <div className="row2"><input type="text" placeholder="host:port (Wi-Fi, VPN, IPv6, DDNS name) or wss://…" value={txt} onChange={(e) => setTxt(e.target.value)} /><button className="secondary" onClick={add}>Add address</button></div></div>}</div>);
}

function Network({ st, busy, run }: { st: any; busy: boolean; run: Run }) {
  const L = st.listen ?? {}, [pickAddr, setPickAddr] = useState(false), [addr, setAddr] = useState(L.address ?? ""), [relay, setRelay] = useState((st.relays ?? []).join(", ")), [adv, setAdv] = useState((st.advertise ?? []).map((a: any) => `${a.host}:${a.port}`).join(", "));
  const set = (p: any) => run(() => core.call("syncSetListen", { enabled: L.enabled, scope: L.scope, address: L.address, ...p }));
  return (
    <div className="box" id="sync-network"><h3 style={{ marginTop: 0 }}>Network</h3>
      <label className="opt"><input type="checkbox" id="sync-listen" checked={!!L.enabled} disabled={busy} onChange={(e) => set({ enabled: e.target.checked })} /><span>Stay reachable on my network<small className="sub">{L.enabled ? (st.listening ? `On ${st.binds.join(", ")}.` : L.error || "Not available right now.") : "Off: this device only connects out. At least one of your devices should stay reachable."}</small></span></label>
      {L.enabled && <><label className="sub">Who can reach it
        <select id="sync-scope" value={pickAddr ? "address" : L.scope} disabled={busy} onChange={(e) => { if (e.target.value === "address") setPickAddr(true); else { setPickAddr(false); set({ scope: e.target.value }); } }}>
          <option value="loopback">Only this computer (testing, SSH tunnels)</option><option value="lan">My local network</option><option value="address">One specific address (VPN / Tailscale)…</option></select></label>
        {(pickAddr || L.scope === "address") && <div className="row2"><input type="text" id="sync-addr" placeholder="100.x.y.z" list="sync-ifs" value={addr} onChange={(e) => setAddr(e.target.value)} /><datalist id="sync-ifs">{(L.interfaces ?? []).map((i: any) => <option key={i.address} value={i.address}>{i.name}</option>)}</datalist>
          <button className="secondary" disabled={busy} onClick={() => set({ scope: "address", address: addr })}>Use</button></div>}
        {L.error && <p className="err" id="sync-listen-err">{L.error}</p>}</>}
      <p className="hint" id="sync-exposure">Exposure: only your paired devices get past the encrypted handshake; anyone else is dropped. Never on a public address unless you choose one.</p>
      <details><summary>Other networks (VPN, internet)</summary>
        <p className="hint">Add addresses for a device above, or use a relay server you host: it only forwards encrypted data.</p>
        <label className="sub">Addresses other devices can use to reach this one (host:port, comma separated)<input type="text" id="sync-adv" placeholder="home.example.org:43210" value={adv} onChange={(e) => setAdv(e.target.value)} /></label>
        <div className="btns"><button className="secondary" disabled={busy} onClick={() => run(() => core.call("syncSetAdvertise", { addrs: adv.split(",").map((x: string) => x.trim()).filter(Boolean).map((x: string) => { const m = /^(.+):(\d+)$/.exec(x); return m ? { kind: "tcp", host: m[1], port: Number(m[2]) } : null; }).filter(Boolean) }))}>Save</button></div>
        <label className="sub">Relay server (wss://…, the same on both devices)<input type="text" id="sync-relay" placeholder="wss://relay.example.org/relay" value={relay} onChange={(e) => setRelay(e.target.value)} /></label>
        <div className="btns"><button className="secondary" id="sync-relay-save" disabled={busy} onClick={() => run(() => core.call("syncSetRelays", { urls: relay.split(",").map((x: string) => x.trim()).filter(Boolean) }))}>Save relay</button></div></details>
      <Anywhere st={st} busy={busy} run={run} />
    </div>);
}

/** "Reach my devices from anywhere": HyperDHT transport, ON by default, Advanced only (the switch turns it off). */
function Anywhere({ st, busy, run }: { st: any; busy: boolean; run: Run }) {
  const D = st.dht ?? { enabled: true, bootstrap: [], state: "off" }, [own, setOwn] = useState((D.bootstrap ?? []).join(", "));
  const note = !D.enabled ? "" : D.state === "ready" ? "Ready. Devices that also have this on can find this one from any network." : D.state === "starting" ? "Starting…" : D.state === "unavailable" ? (D.reason || "Not available on this platform.") : D.state === "error" ? (D.reason || "Couldn't start; trying again.") : "";
  return (<details id="sync-anywhere" open={!!D.enabled}><summary>Reach my devices from anywhere</summary>
    <label className="opt"><input type="checkbox" id="sync-dht" checked={!!D.enabled} disabled={busy} onChange={(e) => run(() => core.call("syncSetDht", { enabled: e.target.checked }))} /><span>Reach my devices from anywhere (uses the public Holepunch network)
      <small className="sub">Public helper servers see your IP address and that you look up a device address, never any content: everything is encrypted end to end. It is on by default; turn it off here if your devices only ever sync on your own network.</small></span></label>
    {D.enabled && <p className={D.state === "unavailable" || D.state === "error" ? "err" : "sub"} id="sync-dht-status">{note}</p>}
    <label className="sub">Use my own bootstrap node (host:port, comma separated; empty = the public ones)<input type="text" id="sync-dht-bootstrap" placeholder="dht.example.org:49737" value={own} onChange={(e) => setOwn(e.target.value)} /></label>
    <div className="btns"><button className="secondary" id="sync-dht-save" disabled={busy} onClick={() => run(() => core.call("syncSetDht", { bootstrap: own.split(/[\s,]+/).filter(Boolean) }))}>Save bootstrap nodes</button></div></details>);
}

function MediaBox({ st, busy, run }: { st: any; busy: boolean; run: Run }) {
  const m = st.media ?? {}, pol = m.policy ?? { mode: "off", maxFileMB: 25, maxTotalMB: 2048 }, a = m.active;
  const set = (p: any) => run(() => core.call("syncSetMediaPolicy", { ...pol, ...p }));
  return (
    <div className="box" id="sync-media"><h3 style={{ marginTop: 0 }}>Photos and files</h3>
      <p className="hint">They are fetched from your other devices when you open them, or in the background if you allow it.</p>
      <label className="sub">Download in the background<select id="sync-media-mode" value={pol.mode} disabled={busy} onChange={(e) => set({ mode: e.target.value })}>
        <option value="off">Only when I open one</option><option value="wifi">On Wi-Fi (not mobile data)</option><option value="all">On any connection</option></select></label>
      {pol.mode !== "off" && <div className="row2"><label className="sub">Largest file (MB)<input type="number" min={1} max={256} value={pol.maxFileMB} onChange={(e) => set({ maxFileMB: Number(e.target.value) })} /></label>
        <label className="sub">Total budget (MB)<input type="number" min={16} value={pol.maxTotalMB} onChange={(e) => set({ maxTotalMB: Number(e.target.value) })} /></label></div>}
      {pol.mode === "wifi" && <label className="opt"><input type="checkbox" checked={!!m.metered} onChange={(e) => run(() => core.call("syncSetMetered", { metered: e.target.checked }))} /><span>This connection is metered (mobile data)<small className="sub">Detected automatically where possible.</small></span></label>}
      <p className="sub" id="sync-media-status">{a ? `Fetching ${a.name ?? "a file"}: ${mb(a.got)} of ${mb(a.total)}` : `${m.wanted ?? 0} waiting · ${mb(m.fetchedBytes)} fetched so far`}</p>
      {a && <div className="bar big"><i style={{ width: `${a.total ? Math.min(100, (100 * a.got) / a.total) : 0}%` }} /></div>}
    </div>);
}

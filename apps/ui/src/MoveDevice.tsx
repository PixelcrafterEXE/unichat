// Settings > "Move to another device": hand accounts over to one of YOUR paired devices, directly and encrypted (the same channel as Sync devices).
//   1 accounts (checklist) -> 2 device (or "Add a device" on the spot) -> ONE confirm on both devices -> per-account progress -> result.
// The file-based hand-over is still available under "Use a file instead" (BackupPanel), for devices that cannot reach each other.
// Backend: syncMoveStart / syncMoveRespond / syncMoveCancel + the `moves` list of syncStatus (packages/sync/src/move.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderIcon, core } from "./util";
import { providerName } from "./MoveLogin";
import { Confirm, Pairing } from "./SyncPanel";
import { AlertCircle, Check, Clock } from "./icons";
import "./backup.css";
import "./sync.css";
import "./move.css";

export type Move = { onWithout?: () => void; tid: string; role: "out" | "in"; acct: string; provider: string; label: string; peer: string; peerName: string; from: string; to: string; phase: "queued" | "confirm" | "waiting" | "sending" | "finishing" | "done" | "failed"; done: number; total: number; error?: string; wipeError?: string; at: number;
  batch?: { id: string; n: number; i: number; items: { acct: string; label: string; provider: string }[] };
  kind?: "history"; history?: { media: boolean; removeAfter: boolean }; hist?: { m: number; f: number; b: number }; histDone?: { m: number; f: number }; stage?: "login" | "history"; histFailed?: boolean };
const mbText = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const num = (n: number) => n.toLocaleString("en-US");
const sizeText = (n: number) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n >= 1048576 ? Math.round(n / 1048576) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
export const estText = (e: { messages: number; files: number; bytes: number }) => `About ${sizeText(e.bytes)}: ${num(e.messages)} messages${e.files ? `, ${num(e.files)} files` : ""}`;
const over = (m: Move) => m.phase === "done" || m.phase === "failed";
/** all rows that belong together: a batch, or the single move */
export const groupOf = (moves: Move[], m: Move) => (m.batch ? moves.filter((x) => x.batch?.id === m.batch!.id && x.role === m.role) : [m]).sort((a, b) => (a.batch?.i ?? 0) - (b.batch?.i ?? 0));

/** Sync status + the move list, kept fresh by the backend's events. */
export function useSyncStatus(): [any, () => void] {
  const [st, setSt] = useState<any>(null);
  const load = useCallback(() => { core.call("syncStatus").then(setSt, () => setSt((s: any) => s ?? { enabled: false, devices: [], accounts: [], moves: [] })); }, []);
  useEffect(() => {
    load(); const off = core.on((ev: string, d: any) => { if (ev === "sync-devices" && d?.devices) setSt(d); else if (ev === "sync-progress") load(); });
    const t = setInterval(load, 5000); return () => { off(); clearInterval(t); };
  }, [load]);
  return [st, load];
}

function Status({ m, out }: { m: Move; out: boolean }) {
  const pct = m.total > 0 ? Math.min(100, Math.round((100 * m.done) / m.total)) : 0;
  if (m.phase === "done") return <><span className="mvico ok"><Check size={14} /></span><span className="mvtxt"><small>{m.kind === "history" ? (out ? "Chat history sent." : "Chat history received.") : out ? `Moved${m.hist ? " with its chat history" : ""}. ${m.history?.removeAfter ? "The history was removed from this device." : "Kept here as a read-only archive."}` : `Connected on this device${m.hist ? ", with its chat history" : ""}.`}{m.wipeError ? ` Its login could not be fully deleted here: ${m.wipeError}` : ""}</small></span></>;
  if (m.phase === "failed") return <><span className="mvico bad"><AlertCircle size={14} /></span><span className="mvtxt"><small className="bad">{m.error ?? "Something went wrong."} {m.kind === "history" ? "" : out ? "Still on this device." : "Nothing was installed."}</small></span>{m.histFailed && out && m.onWithout && <button className="secondary" data-nohist={m.acct} onClick={m.onWithout}>Move without history</button>}</>;
  if (m.phase === "queued") return <><span className="mvico"><Clock size={14} /></span><span className="mvtxt"><small>Waiting for its turn</small></span></>;
  if (m.phase === "sending" && m.stage === "history" && m.hist) return <><span className="mvico"><span className="spin" /></span><span className="mvtxt"><small>Chat history · {num(m.histDone?.m ?? 0)} of {num(m.hist.m)} messages · {mbText(m.done)} of {mbText(m.total)}</small><span className="mvbar"><i style={{ width: pct + "%" }} /></span></span></>;
  const text = m.phase === "waiting" ? `Waiting for ${m.peerName} to confirm…` : m.phase === "confirm" ? "Waiting for your answer…" : m.phase === "finishing" ? "Finishing…" : `${out ? "Sending" : "Receiving"} · ${mbText(m.done)} of ${mbText(m.total)}`;
  return <><span className="mvico"><span className="spin" /></span><span className="mvtxt"><small>{text}</small>{m.phase === "sending" && <span className="mvbar"><i style={{ width: pct + "%" }} /></span>}</span></>;
}

/** Per-account rows + one summary line. */
export function MoveRows({ rows, onCancel, onClose, onWithout }: { rows: Move[]; onCancel?: () => void; onClose?: () => void; onWithout?: (m: Move) => void }) {
  const out = rows[0].role === "out", other = out ? rows[0].to : rows[0].from, done = rows.filter((m) => m.phase === "done").length, bad = rows.filter((m) => m.phase === "failed").length, all = rows.every(over);
  const active = rows.some((m) => ["waiting", "sending", "queued"].includes(m.phase)) && !rows.some((m) => m.phase === "finishing");
  const hOnly = rows[0].kind === "history", title = hOnly ? (!all ? `Sending the chat history of ${rows[0].label}` : bad ? "The chat history was not sent." : `The chat history of ${rows[0].label} is on ${other}.`) : !all ? (rows.length === 1 ? `${out ? "Moving" : "Receiving"} ${rows[0].label}` : `${out ? "Moving" : "Receiving"} ${rows.length} accounts`) : bad === 0 ? (rows.length === 1 ? (out ? `${rows[0].label} now runs on ${other}.` : `${rows[0].label} is now connected on this device.`) : `All ${rows.length} accounts ${out ? `now run on ${other}.` : "are now connected on this device."}`)
    : done === 0 ? (rows.length === 1 ? "The move did not happen." : "None of the accounts moved.") : `${done} of ${rows.length} accounts moved. ${bad} did not.`;
  return (
    <div className="mvp-progress" id="mvp-progress" data-phase={all ? (bad ? (done ? "partial" : "failed") : "done") : rows.some((m) => m.phase === "sending") ? "sending" : rows[0].phase} role="status">
      <h4 className={"mvtitle" + (all ? (bad ? (done ? " mix" : " bad") : " good") : "")} id={all ? (bad ? "mvp-failed" : "mvp-done") : "mvp-title"}>{title}</h4>
      <ul className="mvlist">{rows.map((m) => <li className="mvrow static" key={m.tid} data-acct={m.acct} data-phase={m.phase}><ProviderIcon provider={m.provider} size={32} />
        <span className="mvname"><b>{m.label}</b><small>{providerName(m.provider)}</small></span><span className="mvstat"><Status m={onWithout ? { ...m, onWithout: () => onWithout(m) } : m} out={out} /></span></li>)}</ul>
      <div className="btns">
        {active && onCancel && <button className="secondary" id="mvp-cancel" onClick={onCancel}>Cancel</button>}
        {all && onClose && <button className="secondary" id="mvp-close" onClick={onClose}>Close</button>}
      </div>
    </div>);
}

/** The ONE confirm, used on both devices. `items` (several accounts) are listed; the receiving side may untick some. */
function ConfirmMove({ title, from, ok, no, busy, yes = "Move", no_ = "Cancel", items, sel, setSel, extra, text }: { extra?: React.ReactNode; text?: string; title: string; from: string; ok: () => void; no: () => void; busy: boolean; yes?: string; no_?: string;
  items?: { acct: string; label: string; provider: string }[]; sel?: string[]; setSel?: (s: string[]) => void }) {
  return (
    <div className="mvdlg" role="dialog" aria-modal="true" id="mvp-confirm"><div className="sheet">
      <h3 id="mvp-confirm-title">{title}</h3>
      {items && items.length > 1 && <ul className="mvlist dlg" id="mvp-confirm-list">{items.map((i) => <li key={i.acct}><label className={"mvrow" + (setSel ? " pick" : " static") + (sel && !sel.includes(i.acct) ? " off" : "")}>
        {setSel && sel && <input type="checkbox" id={`mvp-in-${i.acct}`} checked={sel.includes(i.acct)} onChange={() => setSel(sel.includes(i.acct) ? sel.filter((x) => x !== i.acct) : [...sel, i.acct])} />}
        <ProviderIcon provider={i.provider} size={28} /><span className="mvname"><b>{i.label}</b><small>{providerName(i.provider)}</small></span></label></li>)}</ul>}
      {extra}
      <p className="hint" id="mvp-confirm-text">{text ?? `${from} will be signed out locally without logging out of the service. ${items && items.length > 1 ? "The accounts then run" : "The account then runs"} only on the other device.`}</p>
      <div className="btns"><button className="primary inline" id="mvp-confirm-yes" disabled={busy || (!!sel && !sel.length)} onClick={ok}>{yes}</button><button className="secondary" id="mvp-confirm-no" disabled={busy} onClick={no}>{no_}</button></div>
    </div></div>);
}
const titleOf = (items: { label: string }[], from: string, to: string) => `Move ${items.length === 1 ? items[0].label : `${items.length} accounts`} from ${from} to ${to}?`;

const Tick = () => <span className="mvtick" aria-hidden><Check size={14} /></span>;

export function MoveP2P() {
  const [st, reload] = useSyncStatus();
  const [step, setStep] = useState<"pick" | "adding" | "confirm">("pick"), [sel, setSel] = useState<string[]>([]), [dev, setDev] = useState(""), [tids, setTids] = useState<string[]>([]), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<any>(null), [copied, setCopied] = useState(false), [hist, setHist] = useState(true), [media, setMedia] = useState(true), [rm, setRm] = useState(false), [est, setEst] = useState<any>(null);
  const known = useRef<Set<string> | null>(null);
  const moves: Move[] = st?.moves ?? [], outs = moves.filter((m) => m.role === "out");
  const mine = tids.length ? outs.filter((m) => tids.includes(m.tid)) : [], running = outs.find((m) => ["queued", "waiting", "sending", "finishing"].includes(m.phase));
  const rows = mine.length ? mine.sort((a, b) => (a.batch?.i ?? 0) - (b.batch?.i ?? 0)) : running ? groupOf(outs, running) : [];
  const run = async (f: () => Promise<any>) => { setBusy(true); setErr(""); try { await f(); reload(); } catch (e: any) { setErr(e.message); reload(); } finally { setBusy(false); } };
  // a device that appears while "Add a device" is open becomes the choice, and we go on
  useEffect(() => {
    if (!st) return; const ids = new Set<string>((st.devices ?? []).filter((d: any) => !d.self && !d.revoked).map((d: any) => d.id));
    if (known.current === null) { known.current = ids; return; }
    if (step === "adding") for (const id of ids) if (!known.current.has(id)) { setDev(id); setStep("pick"); setPair(null); }
    known.current = ids;
  }, [st, step]);
  useEffect(() => { if (step !== "confirm" || !hist || !sel.length) { setEst(null); return; } let off = false; core.call("syncMoveEstimate", { accountIds: sel, includeMedia: media }).then((e: any) => { if (!off) setEst(e); }, () => {}); return () => { off = true; }; }, [step, hist, media, sel.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return <div className="mvp" id="mvp"><p className="hint">Loading…</p></div>;
  if (st.loading) return <div className="mvp" id="mvp"><p className="hint" id="mvp-loading">Getting ready: preparing your messages for syncing. Try again in a moment.</p></div>;
  const all: any[] = st.accounts ?? [], movable = all.filter((a) => a.canMove), stuck = all.filter((a) => !a.canMove && a.moveWhy), devices: any[] = (st.devices ?? []).filter((d: any) => !d.self && !d.revoked);
  const chosen = movable.filter((a) => sel.includes(a.id)), d = devices.find((x) => x.id === dev);
  const adding = step === "adding" || !!st.pairing || !!(st.joining && (st.joining.state === "confirm" || st.joining.state === "waiting"));
  const startAdd = () => run(async () => { setStep("adding"); setPair(await core.call("syncStartPairing", { keepListening: true })); });
  const stopAdd = () => run(async () => { await core.call("syncStopPairing"); setPair(null); setStep("pick"); });
  const go = () => run(async () => { const r = await core.call("syncMoveStart", { accountIds: chosen.map((a) => a.id), deviceId: dev, confirmed: true, includeHistory: hist, includeMedia: hist && media, removeHistoryAfter: hist && rm }); setTids(r.transferIds ?? [r.transferId]); setStep("pick"); });
  const reset = () => { setTids([]); setSel([]); setDev(""); setErr(""); };
  const toggle = (id: string) => setSel((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const n = chosen.length;

  return (
    <div className="mvp" id="mvp">
      <Confirm st={st} busy={busy} run={run} />
      {rows.length ? <section className="mvcard"><MoveRows rows={rows} onCancel={() => { const cur = rows.find((m) => ["waiting", "sending"].includes(m.phase)) ?? rows.find((m) => m.phase === "queued"); if (cur) run(() => core.call("syncMoveCancel", { transferId: cur.tid })); }} onClose={reset} onWithout={(m) => run(async () => { const r = await core.call("syncMoveStart", { accountIds: [m.acct], deviceId: m.peer, confirmed: true, includeHistory: false }); setTids(r.transferIds ?? [r.transferId]); })} /></section> : <>
        <section className="mvcard" id="mvp-step1">
          <header><span className="mvnum">1</span><div><h4>Choose accounts</h4><small>Only the sign-in moves. Chats stay here as read-only archives.</small></div>
            {movable.length > 1 && <button className="linkbtn" id="mvp-all" onClick={() => setSel(sel.length === movable.length ? [] : movable.map((a) => a.id))}>{sel.length === movable.length ? "Select none" : "Select all"}</button>}</header>
          {!movable.length && <p className="sub" id="mvp-noacct">There is no signed-in account on this device to move.</p>}
          <ul className="mvlist">{movable.map((x) => <li key={x.id}><label className={"mvrow pick" + (sel.includes(x.id) ? " on" : "")}><input type="checkbox" id={`mvp-acct-${x.id}`} checked={sel.includes(x.id)} onChange={() => toggle(x.id)} />
            <ProviderIcon provider={x.provider} size={32} /><span className="mvname"><b>{x.label}</b><small>{providerName(x.provider)}</small></span><Tick /></label></li>)}
            {stuck.map((x) => <li key={x.id}><div className="mvrow off" data-stuck={x.id}><ProviderIcon provider={x.provider} size={32} /><span className="mvname"><b>{x.label}</b><small>{providerName(x.provider)} · {x.moveWhy}</small></span></div></li>)}</ul>
        </section>
        <section className="mvcard" id="mvp-step2">
          <header><span className="mvnum">2</span><div><h4>Choose the device</h4><small>One of your own devices, online right now.</small></div></header>
          {!devices.length && !adding && <p className="sub" id="mvp-nopair">You have no other device yet. Add one first; it only takes a moment.</p>}
          <ul className="mvlist">{devices.map((x) => <li key={x.id}><label className={"mvrow pick" + (dev === x.id ? " on" : "") + (x.online ? "" : " off")} data-dev={x.name}><input type="radio" name="mvp-dev" id={`mvp-dev-${x.name.replace(/\W+/g, "-")}`} disabled={!x.online} checked={dev === x.id} onChange={() => setDev(x.id)} />
            <span className={x.online ? "dot on" : "dot"} /><span className="mvname"><b>{x.name}</b><small>{x.online ? "Online" : "Offline. Open UniChat on it while both are on the same Wi-Fi."}</small></span><Tick /></label></li>)}</ul>
          {adding ? (st.pairing || pair) && <div className="mvp-add" id="mvp-adding"><Pairing p={pair ?? st.pairing} copied={copied} onCopy={(l) => { navigator.clipboard?.writeText(l).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {}); }} onStop={stopAdd} /></div>
            : <button className="secondary mvadd" id="mvp-add" disabled={busy} onClick={startAdd}>Add a device</button>}
        </section>
        {err && <p className="err" id="mvp-err">{err}</p>}
        <footer className="mvfoot"><span className="mvsum" id="mvp-sum">{n ? `${n} ${plural(n, "account", "accounts")}` : "No account chosen"}{d ? ` → ${d.name}` : ""}</span>
          <button className="primary inline" id="mvp-next" disabled={busy || !n || !d || !d.online} onClick={() => setStep("confirm")}>{n > 1 ? `Move ${n} accounts` : n === 1 ? "Move 1 account" : "Move"}</button></footer>
      </>}
      {step === "confirm" && n > 0 && d && <ConfirmMove title={titleOf(chosen, st.deviceName, d.name)} items={chosen.map((a) => ({ acct: a.id, label: a.label, provider: a.provider }))} from={st.deviceName} busy={busy} ok={go} no={() => setStep("pick")}
        extra={<div className="mvopts" id="mvp-opts">
          <label className="mvopt"><input type="checkbox" id="mvp-hist" checked={hist} onChange={(e) => setHist(e.target.checked)} /><span>Also move the chat history<small id="mvp-est">{hist ? (est ? estText(est) : "Counting…") : "Only the sign-in moves. The other device starts without old messages."}</small></span></label>
          {hist && <label className="mvopt sub"><input type="checkbox" id="mvp-media" checked={media} onChange={(e) => setMedia(e.target.checked)} /><span>and the downloaded files</span></label>}
          {hist && <label className="mvopt sub"><input type="checkbox" id="mvp-remove" checked={rm} onChange={(e) => setRm(e.target.checked)} /><span>Remove the history from this device afterwards<small>Only after the other device has it. Off: this device keeps a read-only copy.</small></span></label>}
        </div>} />}
    </div>);
}

/** Mounted once at the top of the app: the confirm on the RECEIVING device (whatever page is open), progress while it runs, and a toast when a move is over. */
export function MoveWatcher() {
  const [st] = useSyncStatus(), [toast, setToast] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState(""), [pick, setPick] = useState<{ id: string; sel: string[] } | null>(null);
  const seen = useRef(new Set<string>());
  const moves: Move[] = st?.moves ?? [];
  const key = moves.map((m) => m.tid + m.phase).join();
  useEffect(() => {
    for (const m of moves) {
      const g = groupOf(moves, m), gid = m.batch?.id ?? m.tid;
      if (seen.current.has(gid) || !g.every(over)) continue; seen.current.add(gid);
      if (Date.now() - Math.max(...g.map((x) => x.at)) > 60_000) continue; // an old result from before this page was opened
      const done = g.filter((x) => x.phase === "done"), out = m.role === "out", what = g.length === 1 ? g[0].label : `${done.length} of ${g.length} accounts`;
      if (done.length) setToast(out ? `${done.length === g.length ? (g.length === 1 ? g[0].label : `${g.length} accounts`) : what} moved to ${m.to}` : `${done.length === g.length ? (g.length === 1 ? g[0].label + " is" : `${g.length} accounts are`) : what + " are"} now connected here`);
      else if (!out) setToast(`${g.length === 1 ? g[0].label + " was" : "The accounts were"} not moved. Nothing changed on this device.`);
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 6000); return () => clearTimeout(t); }, [toast]);
  const req = moves.find((m) => m.role === "in" && m.phase === "confirm");
  const recvRows = (() => { const live = moves.find((m) => m.role === "in" && ["sending", "finishing", "queued"].includes(m.phase)); return live && !req ? groupOf(moves, live) : []; })();
  const items = req ? (req.batch?.items ?? [{ acct: req.acct, label: req.label, provider: req.provider }]) : [];
  const withHist = !!req?.hist;
  const sel = req && pick?.id === req.tid ? pick.sel : items.map((i) => i.acct);
  const answer = (m: Move, accept: boolean) => { setBusy(true); setErr(""); core.call("syncMoveRespond", { transferId: m.tid, accept, ...(accept && m.batch ? { accountIds: sel } : {}) }).catch((e: any) => setErr(e.message)).finally(() => setBusy(false)); };
  return (<>
    {req && <><ConfirmMove title={req.kind === "history" ? `Receive the chat history of ${req.label} from ${req.from}?` : titleOf(items, req.from, req.to)} text={req.kind === "history" ? "Messages are added to what this device already has; nothing is replaced or signed out." : undefined} extra={req.hist ? <p className="sub" id="mvp-in-hist">{req.kind === "history" ? "" : "Includes the chat history. "}{estText({ messages: req.hist.m, files: req.hist.f, bytes: req.hist.b })}{req.batch ? " for the first account" : ""}.</p> : undefined} items={items} sel={items.length > 1 ? sel : undefined} setSel={items.length > 1 ? (s) => setPick({ id: req.tid, sel: s }) : undefined} from={req.from} yes={req.kind === "history" ? "Receive" : "Move here"} no_="Don't allow" busy={busy} ok={() => answer(req, true)} no={() => answer(req, false)} />{err && <p className="err mvdlg-err">{err}</p>}</>}
    {recvRows.length > 0 && <div className="mvdlg" role="dialog" id="mvp-receiving"><div className="sheet mvp"><MoveRows rows={recvRows} onCancel={() => { const cur = recvRows.find((m) => m.phase === "sending"); if (cur) core.call("syncMoveCancel", { transferId: cur.tid }).catch(() => {}); }} /></div></div>}
    {toast && <div className="mvtoast" id="mvp-toast" role="status">{toast}</div>}
  </>);
}

/** (Re-created from the relay e2e spec after MoveDevice.tsx was rewritten; the relay owner should review.) The holder's one-time question: "<device> wants to send messages as <account> through this device. Allow?" */
export function RelayWatcher() {
  const [st] = useSyncStatus(), [busy, setBusy] = useState(false);
  const ask = (st?.proxy?.asks ?? [])[0];
  if (!ask) return null;
  const answer = (allow: boolean) => { setBusy(true); core.call("syncRelaySet", { deviceId: ask.deviceId, accountId: ask.accountId, allow }).catch(() => {}).finally(() => setBusy(false)); };
  return (
    <div className="mvdlg" role="dialog" aria-modal="true" id="relay-ask"><div className="sheet">
      <h3 id="relay-ask-title">{ask.deviceName} wants to send messages as {ask.label} through this device. Allow?</h3>
      <p className="hint">Your login stays on this device. You can change this later in Sync devices.</p>
      <div className="btns"><button className="primary inline" id="relay-allow" disabled={busy} onClick={() => answer(true)}>Allow</button><button className="secondary" id="relay-deny" disabled={busy} onClick={() => answer(false)}>Don't allow</button></div>
    </div></div>);
}

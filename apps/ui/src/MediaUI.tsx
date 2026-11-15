// "Download all media": offer inside sign-out / remove dialogs, Settings > Storage, and the "not available offline" marks of read-only archives.
import { useEffect, useState } from "react";
import type { Account, Chat, ProviderInfo } from "./types";
import { capsOf } from "./types";
import { ProviderIcon, core, fmtBytes } from "./util";

interface Est { files: number; cached: number; missing: number; bytes: number; unknownSize: number; available: boolean }
interface Prog { jobId: string; accountId: string; total: number; done: number; failed: number; bytes: number; state: string; finished: boolean; message?: string; reasons?: Record<string, number> }
const approx = (e: Est) => `≈ ${e.missing} file${e.missing === 1 ? "" : "s"}, ${fmtBytes(e.bytes) || "0 B"}${e.unknownSize ? ` (+ ${e.unknownSize} of unknown size)` : ""}`;

export function MediaOffer({ account, note, title }: { account: Account; note?: string; title?: string }) {
  const [est, setEst] = useState<Est>(); const [err, setErr] = useState(""); const [prog, setProg] = useState<Prog>(); const [job, setJob] = useState<string>();
  const load = () => core.call("estimateMedia", { accountId: account.id }).then(setEst, (e) => setErr(e.message));
  useEffect(() => {
    load();
    // leaving and re-entering the tab must not lose a running download: ask the backend for it
    core.call("mediaJobs", {}).then((l: Prog[]) => { const j = (l ?? []).find((x) => x.accountId === account.id && !x.finished); if (j) { setProg(j); setJob(j.jobId); } }, () => {});
    return core.on((ev, d) => { if (ev === "media-progress" && d.accountId === account.id) { setProg(d); if (d.finished) load(); } });
  }, [account.id]);
  const start = async () => { setErr(""); try { const r = await core.call("downloadAllMedia", { accountId: account.id }); setJob(r.jobId); setProg({ jobId: r.jobId, accountId: account.id, total: r.estimate.missing, done: 0, failed: 0, bytes: 0, state: "running", finished: false }); } catch (e: any) { setErr(e.message); } };
  const running = !!prog && !prog.finished;
  if (!est && !err) return <div className="mediaoffer" data-media="loading"><small>Checking which media is saved on this device…</small></div>;
  return (
    <div className="mediaoffer" data-media={account.id}>
      {title && <b>{title}</b>}
      {est && !running && est.missing === 0 && <span>{est.files ? "All media of this account is already saved on this device." : "This account has no media."}</span>}
      {est && !running && est.missing > 0 && est.available && <div className="row2"><button className="secondary" data-act="download-media" onClick={start}>Download all media first ({approx(est)})</button></div>}
      {est && !running && est.missing > 0 && !est.available && <span>{approx(est)} can't be downloaded because the account is signed out.</span>}
      {running && <><div className="bar"><i style={{ width: `${(prog!.done / Math.max(1, prog!.total)) * 100}%` }} /></div>
        <div className="row2"><small data-media-progress>{prog!.done}/{prog!.total} files · {fmtBytes(prog!.bytes)}</small><button className="secondary" onClick={() => core.call("cancelMediaDownload", { jobId: job ?? prog!.jobId })}>Cancel</button></div></>}
      {prog?.finished && <small data-media-done>{prog.state === "cancelled" ? "Cancelled" : prog.state === "limit" ? "Stopped at the size limit" : prog.state === "stopped" ? prog.message : "Finished"}: {prog.done - prog.failed} saved{prog.failed ? `, ${prog.failed} failed (run it again to retry)` : ""}.{prog.failed && prog.reasons ? <> Reasons: {Object.entries(prog.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}.</> : null}</small>}
      {note && <small>{note}</small>}
      {err && <small className="hint err">{err}</small>}
    </div>);
}

/** Settings > Storage. */
export function StoragePanel({ accounts, providers = [], chats = [], loading }: { accounts: Account[]; providers?: ProviderInfo[]; chats?: Chat[]; loading?: boolean }) {
  return (
    <>
      <h2>Storage &amp; downloads</h2>
      <p className="hint">Only files you opened are kept for offline use. Download everything of an account before you sign out, so the read-only archive keeps its photos, voice notes and files. Downloaded media is stored encrypted on this device.</p>
      <p className="hint">Messengers that only load a chat's history when you open it can be filled up front, so search and the offline archive see whole conversations: use "Fetch chat history" below an account.</p>
      {accounts.map((a) => {
        const out = a.state === "signed-out" || (a.state === "needs-login" && !!a.everLinked);
        return <div key={a.id} className="acard"><ProviderIcon provider={a.provider} size={36} /><div className="abody"><div className="ahead"><b className="aname">{a.label}</b></div>
          {out ? <ArchiveInfo accountId={a.id} /> : <MediaOffer account={a} />}
          {!out && capsOf(a, providers)?.fetchHistory && <HistoryOffer account={a} chats={chats} loading={loading} />}</div></div>;
      })}
      {!accounts.length && <p className="hint">{loading ? "Still loading your accounts…" : "No accounts yet."}</p>}
    </>);
}
function ArchiveInfo({ accountId }: { accountId: string }) {
  const [r, setR] = useState<{ files: number; missing: number }>();
  useEffect(() => { core.call("archiveMedia", { accountId }).then(setR, () => {}); }, [accountId]);
  return <div className="asub">{r ? (r.missing ? `${r.missing} of ${r.files} files are not available offline (they were never opened before sign-out).` : r.files ? "All media is saved on this device." : "No media.") : "Checking…"}</div>;
}

/** chat id -> number of files missing from the offline cache, for the accounts that are read-only archives. */
export function useOfflineMedia(accounts: Account[]) {
  const [m, setM] = useState<Record<string, number>>({});
  const key = accounts.filter((a) => a.state === "signed-out" || (a.state === "needs-login" && a.everLinked)).map((a) => a.id).join(",");
  useEffect(() => {
    if (!key) { setM({}); return; }
    let live = true;
    Promise.all(key.split(",").map((id) => core.call("archiveMedia", { accountId: id }).catch(() => ({ chats: {} })))).then((rs) => {
      if (!live) return; const o: Record<string, number> = {};
      for (const r of rs) for (const [c, s] of Object.entries<any>(r.chats ?? {})) if (s.missing > 0) o[c] = s.missing;
      setM(o);
    });
    return () => { live = false; };
  }, [key]);
  return m;
}

// ---------------------------------------------------------------- Fetch chat history
interface HProg { jobId: string; accountId: string; days: number; state: string; chatsTotal: number; chatsDone: number; messages: number; pages: number; current?: string; failures: Record<string, number>; errors?: string[]; finished: boolean; message?: string }
const REASON: Record<string, string> = { "rate-limited": "rate limited by the service", "no-access": "no access to the chat", timeout: "timed out", "not-supported": "not supported for this chat", error: "other errors" };
const RANGES = [{ days: 30, label: "Last 30 days" }, { days: 365, label: "Last year" }, { days: 0, label: "Everything" }];

/** "Fetch chat history" of one account: pick the range (and optionally chats), watch progress, cancel, resume, see why chats failed. */
export function HistoryOffer({ account, chats, loading }: { account: Account; chats: Chat[]; loading?: boolean }) {
  const [days, setDays] = useState(365); const [prog, setProg] = useState<HProg>(); const [err, setErr] = useState("");
  const [pick, setPick] = useState(false); const [sel, setSel] = useState<string[]>([]);
  const mine = chats.filter((c) => c.id.startsWith(account.id + ":") && !c.offline).sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
  useEffect(() => {
    core.call("fetchHistoryJobs", {}).then((l: HProg[]) => { const j = l.find((x) => x.accountId === account.id); if (j) setProg(j); }, () => {});
    return core.on((ev, d) => { if (ev === "history-progress" && d.accountId === account.id) setProg(d); });
  }, [account.id]);
  const start = async (resume = false) => { setErr(""); try { await core.call("fetchHistory", { accountId: account.id, days, ...(sel.length ? { chatIds: sel } : {}), ...(resume ? { resume: true } : {}) }); } catch (e: any) { setErr(e.message); } };
  const running = !!prog && prog.state === "running" && !prog.finished;
  const fails = prog ? Object.entries(prog.failures ?? {}).filter(([, n]) => n > 0) : [];
  return (
    <div className="mediaoffer histoffer" data-history={account.id}>
      <b>Fetch chat history</b>
      {!running && <>
        <span>Walks the chats of this account and loads older messages into the archive, as far back as you choose. It runs slowly on purpose to stay within the service's rate limits.</span>
        <div className="row2"><select aria-label="How far back" value={days} onChange={(e) => setDays(Number(e.target.value))} data-hist-range>{RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}</select>
          <button className="secondary" data-act="fetch-history" onClick={() => start()}>Fetch {sel.length ? `${sel.length} chat${sel.length === 1 ? "" : "s"}` : "all chats"}</button>
          <button className="secondary" onClick={() => setPick((v) => !v)} data-act="pick-chats">{pick ? "Hide chats" : "Choose chats…"}</button>
          {prog?.state === "interrupted" && <button className="secondary" data-act="resume-history" onClick={() => start(true)}>Resume</button>}</div>
        {pick && <div className="histpick" data-hist-pick>{mine.slice(0, 200).map((c) => <label key={c.id}><input type="checkbox" checked={sel.includes(c.id)} onChange={(e) => setSel((l) => (e.target.checked ? [...l, c.id] : l.filter((x) => x !== c.id)))} /> {c.name}</label>)}{!mine.length && <small data-hist-empty>{loading ? "Your chats are still loading…" : chats.some((c) => c.id.startsWith(account.id + ":") && !c.mergedInto) ? "This account is not connected right now, so its chats cannot be fetched. Sign in or wait until it is connected." : "No chats yet."}</small>}</div>}
      </>}
      {running && <><div className="bar"><i style={{ width: `${(prog!.chatsDone / Math.max(1, prog!.chatsTotal)) * 100}%` }} /></div>
        <div className="row2"><small data-hist-progress>{prog!.chatsDone}/{prog!.chatsTotal} chats · {prog!.messages} messages fetched{prog!.current ? ` · ${prog!.current}` : ""}</small>
          <button className="secondary" data-act="cancel-history" onClick={() => core.call("cancelFetchHistory", { jobId: prog!.jobId })}>Cancel</button></div></>}
      {prog && !running && (prog.finished || prog.state === "interrupted") && <small data-hist-done={prog.state}>
        {prog.state === "cancelled" ? "Cancelled" : prog.state === "stopped" ? prog.message : prog.state === "interrupted" ? prog.message ?? "Interrupted" : "Finished"}: {prog.chatsDone}/{prog.chatsTotal} chats, {prog.messages} new messages.
        {fails.length > 0 && <> Not completed: {fails.map(([r, n]) => `${n} ${REASON[r] ?? r}`).join(", ")}.</>}</small>}
      {err && <small className="hint err">{err}</small>}
    </div>);
}

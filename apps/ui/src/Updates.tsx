// Updates: Settings > About > Updates, and the small "Update 0.1.N available" banner. The backend (packages/core/src/updater.ts) does the work.
import { useCallback, useEffect, useState } from "react";
import { core, fmtBytes } from "./util";
import "./updates.css";

export const APP_VERSION: string = typeof __UNICHAT_VERSION__ === "string" ? __UNICHAT_VERSION__ : "dev";
/** set by the banner's "Update" button: Settings opens on About */
export const updatesNav = { pending: false };

export interface UpdateStatus {
  state: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error"; current: string; dev: boolean; installMode: "self" | "manual" | "none"; platform?: string;
  available: boolean; latest?: { version: string; publishedAt: string; notes: string; asset?: { name: string; size: number } }; lastChecked?: number; error?: string; errorKind?: string;
  progress?: { done: number; total: number }; file?: string; settings: { repo: string; hasToken: boolean; channel: "stable" | "prerelease"; auto: boolean };
}

export function useUpdate() {
  const [st, setSt] = useState<UpdateStatus>();
  const [msg, setMsg] = useState("");
  const refresh = useCallback(() => core.call("updateStatus").then(setSt).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    return core.on((ev: string, d: any) => {
      if (ev === "update-available") void refresh();
      else if (ev === "update-progress") { if (d?.ready) void refresh(); else setSt((s) => (s ? { ...s, state: "downloading", progress: { done: d.done, total: d.total } } : s)); }
    });
  }, [refresh]);
  const run = async (m: string, p: object = {}) => { setMsg(""); try { const r = await core.call(m, p); setSt(r?.status ?? r); return r; } catch (e: any) { setMsg(e?.message ?? "Something went wrong."); void refresh(); } };
  return {
    st, msg, setMsg,
    check: () => run("updateCheck"), download: () => run("updateDownload"), cancel: () => run("updateCancel"),
    save: (p: object) => run("updateSettings", p),
    /** desktop: replaces the app and restarts; Android: the verified file goes to the system installer */
    install: async () => {
      const r = await run("updateInstall"); if (!r) return;
      if (r.action === "handoff" && r.file) {
        try {
          const x = await core.call("$installApk", { path: r.file });
          if (x?.needsPermission) setMsg("Android first needs your OK to install apps from UniChat. Allow it on the page that just opened, come back and tap Install again.");
          else if (x?.started) setMsg("Android is asking you to confirm the update. The app restarts when it is done.");
          else setMsg(x?.error ?? "Could not start the installer.");
        } catch (e: any) { setMsg(e?.message ?? "Could not start the installer."); }
      } else if (r.action === "restart") setMsg("Restarting to finish the update…");
      else if (r.action === "manual") setMsg(r.message ?? "The update is downloaded. Install it from the folder that opened.");
    },
  };
}

const when = (t?: number) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");

export function UpdatesSection() {
  const u = useUpdate(); const st = u.st;
  const [confirm, setConfirm] = useState(false);
  const [repo, setRepo] = useState(""); const [token, setToken] = useState(""); const [saved, setSaved] = useState("");
  useEffect(() => { if (st) setRepo(st.settings.repo); }, [st?.settings.repo]); // eslint-disable-line react-hooks/exhaustive-deps
  const busy = st?.state === "checking" || st?.state === "downloading" || st?.state === "installing";
  const v = st?.latest?.version;
  const canSelf = st && st.installMode !== "none" && st.available;
  const line = !st ? "Loading…" : st.state === "checking" ? "Checking…" : st.state === "downloading" ? "Downloading…" : st.state === "ready" ? `Version ${v} is downloaded and checked.`
    : st.available ? `Version ${v} is available.` : st.dev ? "This is a development build; it does not update itself." : st.latest ? "You have the latest version." : st.lastChecked ? "No release found." : "Not checked yet.";
  return (
    <section id="updates" className="upd">
      <h3>Updates</h3>
      <div className="row"><span><b>Version</b></span><span id="upd-version">{APP_VERSION}</span></div>
      <p id="upd-status" className="hint">{line}</p>
      {st?.error && <p id="upd-error" className="warn">{st.error}</p>}
      {u.msg && <p id="upd-msg" className="hint">{u.msg}</p>}
      <p className="hint">Last checked: <span id="upd-last">{when(st?.lastChecked)}</span></p>
      {st?.state === "downloading" && st.progress && <div className="bar" id="upd-bar" role="progressbar" aria-valuenow={Math.round(100 * st.progress.done / Math.max(1, st.progress.total))}><i style={{ width: `${100 * st.progress.done / Math.max(1, st.progress.total)}%` }} /></div>}
      {st?.available && st.latest?.notes && <pre id="upd-notes" className="notes">{st.latest.notes}</pre>}
      <div className="btns">
        <button id="upd-check" className="secondary" disabled={busy} onClick={() => void u.check()}>Check now</button>
        {canSelf && st.state !== "ready" && st.state !== "downloading" && <button id="upd-download" disabled={busy} onClick={() => void u.download()}>{st.installMode === "manual" ? `Download ${v}` : `Download & install ${v}`}</button>}
        {st?.state === "downloading" && <button className="secondary" onClick={() => void u.cancel()}>Cancel</button>}
        {canSelf && st.state === "ready" && !confirm && <button id="upd-install" onClick={() => setConfirm(true)}>{st.installMode === "manual" ? "Show the file" : "Restart to update"}</button>}
      </div>
      {confirm && <div id="upd-confirm" className="confirm"><p><b>Update to {v}?</b> The app restarts.</p><div className="btns"><button id="upd-confirm-go" onClick={() => { setConfirm(false); void u.install(); }}>Update</button><button className="secondary" onClick={() => setConfirm(false)}>Not now</button></div></div>}
      {st && st.installMode === "none" && st.available && <p className="hint">This version of UniChat is updated by whoever runs the server. Ask them to install {v}.</p>}
      <label className="toggle"><span><b>Check for updates automatically</b><small>Once at start and every 6 hours, never on a metered connection.</small></span><input id="upd-auto" type="checkbox" checked={st?.settings.auto ?? true} onChange={(e) => void u.save({ auto: e.target.checked })} /><i /></label>
      <details className="adv"><summary>Advanced</summary>
        <label className="field">Repository (owner/name)<input id="upd-repo" value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck={false} autoCapitalize="off" /></label>
        <label className="field">GitHub access token (read-only){st?.settings.hasToken && <small> · one is saved</small>}<input id="upd-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={st?.settings.hasToken ? "••••••••  (leave empty to keep)" : "Only needed while the repository is private"} /></label>
        <label className="toggle"><span><b>Include pre-releases</b><small>Every build is published as a pre-release for now.</small></span><input id="upd-pre" type="checkbox" checked={st?.settings.channel !== "stable"} onChange={(e) => void u.save({ channel: e.target.checked ? "prerelease" : "stable" })} /><i /></label>
        <div className="btns">
          <button id="upd-save" className="secondary" onClick={async () => { await u.save({ repo, ...(token ? { token } : {}) }); setToken(""); setSaved("Saved."); setTimeout(() => setSaved(""), 2500); }}>Save</button>
          {st?.settings.hasToken && <button id="upd-token-clear" className="secondary" onClick={() => void u.save({ token: "" })}>Remove token</button>}
          <span id="upd-saved" className="hint">{saved}</span>
        </div>
        <p className="hint">The token stays on this device, sealed, and is only sent to GitHub. It is not synced to your other devices.</p>
      </details>
    </section>
  );
}

const LATER_KEY = "unichat.update.later";
/** A small, dismissible note when a check found a newer version. Only where the app can install it (desktop, Android). */
export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const { st } = useUpdate();
  const [later, setLater] = useState(() => { try { return localStorage.getItem(LATER_KEY) ?? ""; } catch { return ""; } });
  if (!st || !st.available || st.installMode === "none" || !st.latest || later === st.latest.version || st.state === "error" && !st.latest) return null;
  const v = st.latest.version;
  return (
    <div id="upd-banner" className="updbanner" role="status">
      <span>Update {v} available{st.state === "downloading" ? " · downloading…" : st.state === "ready" ? " · ready" : ""}{st.latest.asset ? <small> ({fmtBytes(st.latest.asset.size)})</small> : null}</span>
      <button id="upd-banner-go" onClick={() => { updatesNav.pending = true; onOpen(); }}>Update</button>
      <button id="upd-banner-later" className="secondary" onClick={() => { try { localStorage.setItem(LATER_KEY, v); } catch { /* private mode */ } setLater(v); }}>Later</button>
    </div>
  );
}

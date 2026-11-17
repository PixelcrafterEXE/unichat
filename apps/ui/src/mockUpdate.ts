// Fake updater RPCs (updateCheck / updateStatus / updateDownload / updateInstall / updateSettings / updateCancel, $installApk) for the mock backend.
// ?mock                 up to date (nothing to show)
// ?mock&update=avail    0.1.9 is available, installs by itself (desktop / Android style)
// ?mock&update=web      0.1.9 is available but this host cannot install (web / server)
// ?mock&update=fail     the check fails (offline)
// ?mock&update=needperm Android: the system asks for "install unknown apps" first
// ?mock&update=manual   Linux package (Arch pacman): nothing installs itself, the UI has to show the command to run
// ?mock&update=manualfail  the same, but the install call fails (e.g. no file manager to open): the command must still be shown
type Emit = (ev: string, d: unknown) => void;
const METHODS = new Set(["updateCheck", "updateStatus", "updateDownload", "updateCancel", "updateInstall", "updateSettings", "$installApk", "$apkInstallState"]);
export const mockUpdateHandles = (m: string) => METHODS.has(m);
const log: { method: string; params: any }[] = []; (globalThis as any).__mockUpdateLog = log;
const mode = typeof location !== "undefined" ? new URLSearchParams(location.search).get("update") ?? "" : "";
const settings = { repo: "PixelcrafterEXE/unichat", hasToken: false, channel: "prerelease", auto: true };
const NEW = { version: "0.1.9", publishedAt: "2026-11-14T10:00:00Z", notes: "Faster start-up\nFixes for the chat list",
  asset: { name: mode === "manual" || mode === "manualfail" ? "unichat-desktop-0.1.9.pkg.tar.zst" : "unichat-android-0.1.9-debug.apk", size: 82_000_000 } };
let st: any = { state: "idle" }; let lastChecked: number | undefined; let perm = mode !== "needperm";
const manual = mode === "manual" || mode === "manualfail"; // a .deb / pacman package: the user runs the install command
const status = () => ({ ...st, current: "0.1.5", dev: false, platform: mode === "web" ? undefined : manual ? "desktop-linux-pacman" : "android",
  installMode: mode === "web" ? "none" : manual ? "manual" : "self", available: !!st.latest && st.latest.version !== "0.1.5", lastChecked, settings: { ...settings } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function mockUpdateCall(method: string, p: any, emit: Emit): Promise<any> {
  log.push({ method, params: JSON.parse(JSON.stringify(p ?? {})) });
  switch (method) {
    case "updateStatus": return status();
    case "updateCheck":
      lastChecked = Date.now();
      if (mode === "fail") { st = { state: "error", error: "Cannot reach the update server. Check your internet connection.", errorKind: "offline" }; return status(); }
      if (mode === "avail" || mode === "web" || mode === "needperm" || manual) { const first = st.latest?.version !== NEW.version; st = { state: st.state === "ready" ? "ready" : "available", latest: NEW, file: st.file }; if (first) emit("update-available", { version: NEW.version, notes: NEW.notes, installMode: status().installMode }); }
      else st = { state: "idle", latest: { ...NEW, version: "0.1.5", notes: "" } };
      return status();
    case "updateSettings":
      if (p.repo !== undefined) { if (!/^[\w.-]+\/[\w.-]+$/.test(String(p.repo))) throw new Error("The repository must look like owner/name."); settings.repo = p.repo; }
      if (p.channel !== undefined) settings.channel = p.channel; if (p.auto !== undefined) settings.auto = !!p.auto;
      if (p.token !== undefined) settings.hasToken = !!String(p.token).trim();
      return status();
    case "updateDownload": {
      if (st.state !== "available" && st.state !== "error") return status();
      st = { ...st, state: "downloading", error: undefined, progress: { done: 0, total: NEW.asset.size } };
      for (let i = 1; i <= 4; i++) { await sleep(150); st.progress = { done: NEW.asset.size * i / 4, total: NEW.asset.size }; emit("update-progress", st.progress); }
      st = { ...st, state: "ready", file: "/data/updates/" + NEW.asset.name }; emit("update-progress", { ...st.progress, ready: true }); return status();
    }
    case "updateCancel": return status();
    case "updateInstall":
      if (st.state !== "ready") throw new Error("There is no verified update to install. Download it first.");
      if (mode === "manualfail") throw new Error("Could not open the folder."); // the UI must still say how to install the file
      if (manual) return { action: "manual", file: st.file, status: status(), message: `Version ${NEW.version} is downloaded and checked. Install it with: sudo pacman -U ${st.file}` };
      return { action: mode === "avail" || mode === "needperm" ? "handoff" : "restart", file: st.file, status: status() };
    case "$apkInstallState": return { canInstall: perm, sdk: 34 };
    case "$installApk": if (!perm) { perm = true; return { started: false, needsPermission: true }; } return { started: true };
  }
}

// Electron main process = the app's backend. The Hub runs right here, in-process;
// the UI talks to it via IPC. No server, no port.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session, shell, Tray } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startBackend, DataKeyMismatchError, type KeyWrap } from "@unimsg/host";
import { createDialogs } from "./dialogs.js";
import { appVersion, desktopAsset, readPackageType, replaceAppImage } from "./updater.js";

// Chromium flags; they must be set before `ready`.
// Wayland vs X11: `ozone-platform-hint=auto` lets Chromium pick Wayland when WAYLAND_DISPLAY is set and X11 otherwise (the same
// binary/AppImage works on both; passing a hard `--ozone-platform=wayland` would break on X11-only sessions).
// Vulkan: Chromium's Vulkan/ANGLE-Vulkan backend is not compatible with the Wayland Ozone platform and prints
// "'--ozone-platform=wayland' is not compatible with Vulkan". UniChat is a chat UI and needs no Vulkan, so the Vulkan
// feature is disabled on Linux; GL (EGL/ANGLE-GL) keeps hardware acceleration on both Wayland and X11.
if (process.platform === "linux") {
  app.commandLine.appendSwitch("ozone-platform-hint", "auto");
  app.commandLine.appendSwitch("disable-features", "Vulkan");
}

// UNIMSG_DATA overrides the data directory (tests, portable installs). Must be set before `ready`.
// The product is called UniChat, but the data directory stays ~/.config/unimsg so existing users keep their data
// (Electron would otherwise derive it from the product name).
app.setName("UniChat");
app.setPath("userData", process.env.UNIMSG_DATA || join(app.getPath("appData"), "unimsg"));
let dataDir = app.getPath("userData");
/** Where "use a fresh folder" puts the desktop app's own data (separate from ~/.config/unimsg, which the web server/dev backend uses). */
const freshDir = join(app.getPath("appData"), "unimsg-desktop");
const dev = !!process.env.ELECTRON_RENDERER_URL;

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

/** Pick the key protection. Returns the wrap (if the OS keychain is really usable) and a user-facing warning otherwise. Uses the async safeStorage API (the sync one is deprecated). */
async function chooseKeyWrap(): Promise<{ keyWrap?: KeyWrap; warning?: string }> {
  let usable = false;
  try { usable = await safeStorage.isAsyncEncryptionAvailable(); } catch { /* not ready */ }
  // On Linux, Electron reports "available" even with the plaintext `basic_text` backend (no libsecret/kwallet running).
  if (usable && process.platform === "linux") {
    const backend = safeStorage.getSelectedStorageBackend();
    if (backend === "basic_text" || backend === "unknown") usable = false;
  }
  if (usable) {
    const keyWrap: KeyWrap = {
      wrap: async (k) => new Uint8Array(await safeStorage.encryptStringAsync(Buffer.from(k).toString("base64"))),
      unwrap: async (b) => {
        const r = await safeStorage.decryptStringAsync(Buffer.from(b));
        keyWrap.resealNeeded = !!r.shouldReEncrypt; // the host rewrites unimsg.key.enc with a fresh seal
        return new Uint8Array(Buffer.from(r.result, "base64"));
      },
    };
    return { keyWrap };
  }
  return { warning: `No OS keychain is available (on Linux install and unlock gnome-keyring or KWallet, libsecret). The encryption key for your message archive is stored in a file with owner-only permissions (0600) instead: ${join(dataDir, "unimsg.key")}. Anyone who can read both that file and the database can read your messages.` };
}

/** Device sync is off because sync.db is sealed with another key; the rest works. */
async function keyProblemDialog(e: DataKeyMismatchError) {
  const choice = await dialog.showMessageBox({ type: "warning", title: "UniChat: device sync disabled", message: "Device sync is off: its data uses a different key",
    detail: `${e.message}\n\nUniChat runs without device sync this time. Start it from a separate folder to use sync, or open this folder to look at it.`,
    buttons: ["Continue without sync", "Use a separate desktop folder (restarts)", "Open the folder", "Quit"], defaultId: 0, cancelId: 0 });
  if (choice.response === 1) { quitting = true; app.relaunch({ args: process.argv.slice(1), execPath: process.env.APPIMAGE || process.execPath }); process.env.UNIMSG_DATA = freshDir; app.quit(); }
  else if (choice.response === 2) void shell.openPath(e.dataDir);
  else if (choice.response === 3) { quitting = true; app.quit(); }
}

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createTray() {
  try {
    const img = nativeImage.createFromPath(join(import.meta.dirname, "../../build/icon.png")).resize({ width: 22, height: 22 });
    tray = new Tray(img);
    tray.setToolTip("UniChat");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Show UniChat", click: showWindow },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on("click", showWindow);
  } catch (e) { console.warn("[unimsg] tray unavailable:", (e as Error).message); }
}

function installSecurity() {
  const ses = session.defaultSession;
  // Only web notifications are needed; everything else (camera, geolocation, ...) is denied. Microphone for voice notes is allowed.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "notifications" || permission === "media"));
  if (!dev) {
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
    ses.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, "Content-Security-Policy": [csp] } }));
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", showWindow);

app.whenReady().then(async () => {
  installSecurity();
  const { keyWrap, warning } = await chooseKeyWrap();
  if (!keyWrap && existsSync(join(dataDir, "unimsg.key.enc"))) {
    // The archive key was sealed by a keychain that is gone now; silently minting a new key would orphan the database.
    dialog.showErrorBox("UniChat: keychain unavailable", `Your archive key is sealed by the OS keychain, which is not available now. Unlock/start it (libsecret, gnome-keyring or KWallet) and start UniChat again.\n\nData directory: ${dataDir}`);
    app.exit(1); return;
  }
  // Self-update: the Hub downloads + verifies; this process swaps the AppImage (or points to the folder for a .deb) and restarts.
  const asset = desktopAsset(process.env, process.platform, app.isPackaged, readPackageType(process.resourcesPath));
  // A data folder sealed with another key (e.g. by the web server) is a handled condition: explain it, never touch the data.
  let hub: Awaited<ReturnType<typeof startBackend>>;
  for (;;) {
    try { hub = await startBackend(dataDir, { name: "desktop app", onProblem: (e) => { if (!process.env.UNIMSG_NO_DIALOG) void keyProblemDialog(e); }, keyWrap, backup: { paths: "any", dir: join(dataDir, "backups") }, appVersion: appVersion(app.getVersion()),
    update: asset && { platform: asset.key, installMode: asset.mode, install: async (c) => {
      if (asset.key !== "desktop-linux-appimage") { shell.showItemInFolder(c.file); return { action: "manual", file: c.file, message: `Version ${c.version} is downloaded and checked. Install it with: ${asset.key === "desktop-linux-pacman" ? "sudo pacman -U" : "sudo apt install"} ${c.file}` }; }
      const current = process.env.APPIMAGE!;
      replaceAppImage(current, c.file);
      setTimeout(() => { quitting = true; app.relaunch({ execPath: current, args: process.argv.slice(1).filter((a) => a !== "--updated") }); app.quit(); }, 600);
      return { action: "restart" };
    } } }); break; }
    catch (e) {
      if (!(e instanceof DataKeyMismatchError)) throw e;
      console.error("[unimsg] " + e.message);
      if (process.env.UNIMSG_NO_DIALOG) { app.exit(1); return; }
      const choice = await dialog.showMessageBox({ type: "error", title: "UniChat: data folder uses a different key", message: "This data folder was sealed with a different encryption key",
        detail: `${e.message}\n\nThis usually means the folder was created by the web server / dev backend (key file) and is now opened by the desktop app (OS keychain).`,
        buttons: ["Quit", "Use a separate desktop folder", "Open the folder"], defaultId: 0, cancelId: 0 });
      if (choice.response === 2) { void shell.openPath(dataDir); app.exit(1); return; }
      if (choice.response === 0 || dataDir === freshDir) { app.exit(1); return; }
      dataDir = freshDir; app.setPath("userData", dataDir); // nothing is moved, deleted or overwritten in the old folder
    }
  }
  console.log(`[unimsg] data dir: ${dataDir}; key protection: ${keyWrap ? "OS keychain (safeStorage)" : "0600 key file"}`);

  win = new BrowserWindow({ width: 1200, height: 800, minWidth: 420, minHeight: 500, title: "UniChat", backgroundColor: "#1e1f22", icon: join(import.meta.dirname, "../../build/icon.png"),
    webPreferences: { preload: join(import.meta.dirname, "../preload/preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.setMenuBarVisibility(false);
  // Never navigate the app window away or open child windows inside it; links go to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) void shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (url !== win!.webContents.getURL()) { e.preventDefault(); if (/^https?:/i.test(url)) void shell.openExternal(url); } });
  // Close to tray when there is one; the backend keeps syncing.
  win.on("close", (e) => { if (!quitting && tray && !tray.isDestroyed()) { e.preventDefault(); win!.hide(); } });

  // Backup paths come from native dialogs only: the renderer may not name files (see dialogs.ts).
  const dialogs = createDialogs({ dialog: { showSaveDialog: (o) => dialog.showSaveDialog(win!, o as Electron.SaveDialogOptions), showOpenDialog: (o) => dialog.showOpenDialog(win!, o as Electron.OpenDialogOptions) }, shell, home: () => app.getPath("documents") });
  const fromApp = (e: Electron.IpcMainInvokeEvent) => !!win && e.sender === win.webContents;
  ipcMain.handle("core:call", async (e, method: string, params: unknown) => { if (!fromApp(e)) throw new Error("denied"); dialogs.guardCall(String(method), params); return hub.call(method, params); });
  ipcMain.handle("dialog:save", async (e, req: { suggestedName?: string }) => { if (!fromApp(e)) throw new Error("denied"); return dialogs.showSaveDialog(req); });
  ipcMain.handle("dialog:open", async (e) => { if (!fromApp(e)) throw new Error("denied"); return dialogs.showOpenDialog(); });
  ipcMain.handle("dialog:reveal", (e, path: unknown) => { if (!fromApp(e)) throw new Error("denied"); return dialogs.revealInFolder(path); });
  hub.subscribe((event, data) => { if (win && !win.isDestroyed()) win.webContents.send("core:event", { event, data }); });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  createTray();

  if (warning) {
    console.warn("[unimsg] " + warning);
    if (!process.env.UNIMSG_NO_DIALOG) void dialog.showMessageBox(win, { type: "warning", title: "UniChat: no OS keychain", message: "Your archive key is not protected by the OS keychain", detail: warning });
  }
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => app.quit());

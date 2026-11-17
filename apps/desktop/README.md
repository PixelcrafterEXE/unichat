# UniChat desktop (Electron)

Electron shell for UniChat. The backend (`@unimsg/host` `startBackend`, all providers, SQLite store) runs **in-process in the main
process**; the UI (`apps/ui`) is the renderer and talks to it over IPC (`window.unimsg.call` / `onEvent`, see `src/preload.ts`).
No server, no port. Data directory stays `~/.config/unimsg` (Linux), `%APPDATA%/unimsg` (Windows); override with `UNIMSG_DATA=/some/dir`.

## Requirements
- Electron **>= 35** is required: `store-sqlite` uses `node:sqlite` (Node >= 22.13). Electron 32 (Node 20) does not have it. We use Electron 45 (Node 24.22, verified `node:sqlite` works).
- Electron 45 has no postinstall: the binary is downloaded by `pnpm --filter @unimsg/desktop setup` (runs `install-electron`). `electron-vite`/`electron-builder` also fetch it on demand. No pnpm build-script approval is needed.
- `pnpm-workspace.yaml` has `minimumReleaseAgeExclude: [electron@45.3.1]` (added by pnpm because the release is newer than the age gate).

## Commands (from the repo root)
```
flock /tmp/pnpm.lock pnpm install
pnpm --filter @unimsg/desktop setup          # download the Electron binary once
pnpm --filter @unimsg/desktop dev            # electron-vite dev (HMR renderer)
pnpm --filter @unimsg/desktop build          # -> apps/desktop/out/{main,preload,renderer}
pnpm --filter @unimsg/desktop start          # run the built app (electron-vite preview)
pnpm --filter @unimsg/desktop package:dir    # unpacked app in dist/linux-unpacked/unichat
pnpm --filter @unimsg/desktop dist:linux     # AppImage + deb + pacman (.pkg.tar.zst)
pnpm --filter @unimsg/desktop dist:win       # NSIS installer + portable exe (build on Windows, or Linux with wine)
```
Headless run with a throwaway profile:
```
UNIMSG_DATA=$(mktemp -d) xvfb-run -a apps/desktop/node_modules/electron/dist/electron apps/desktop/out/main/main.js --no-sandbox --remote-debugging-port=9333
```
(`--no-sandbox` only because this box has no setuid chrome-sandbox; `UNIMSG_NO_DIALOG=1` suppresses the keychain warning dialog.)

## Design notes
- `electron.vite.config.ts`: everything is bundled into `out/main/main.js` **except** `@signalapp/libsignal-client` (finds its `.node` prebuild relative to its own dir; bundling breaks it). It is a runtime `dependency` of this package and `asarUnpack`ed in `electron-builder.yml`.
- `@unimsg/host` loads WhatsApp via `import(/* @vite-ignore */ name)`, which a bundler cannot follow (the provider silently disappeared). A small Vite plugin in the config rewrites it to a static import. Better fix upstream: import it statically in host.
- Preload is built as CommonJS (`preload.cjs`): ESM preloads do not work with `sandbox: true`.
- Security: contextIsolation + sandbox, CSP header injected for the packaged build (`default-src 'self'`, no remote scripts), window.open/navigation blocked (http(s) links go to the system browser), only `notifications` and `media` permissions granted, single-instance lock.
- Key storage: `safeStorage` if a real keychain backend exists. On Linux Electron reports "available" even for the plaintext `basic_text` backend, which we treat as unavailable. Fallback is the host's 0600 `unimsg.key` file plus a warning dialog. If `unimsg.key.enc` exists but the keychain is gone, the app refuses to start instead of minting a new key. The `.deb` depends on `libsecret-1-0`.
- Tray icon (Open UniChat / Quit, click shows the window); closing the window hides to tray when a tray exists and `keepRunningInBackground` is on, so accounts stay connected and other devices can still sync. Quitting stays explicit (tray Quit, `before-quit`); `quitting` always beats the close-to-tray handler, so the app cannot become unquittable. Web `Notification` is used by the UI (permission auto-granted).
- Shell settings (`src/settings.ts`): `desktop-settings.json` in the data directory holds `keepRunningInBackground` (default on) and `startAtLogin` (default off); unknown or non-boolean values fall back to the defaults. The renderer reads/writes them over `settings:get` / `settings:set` (`window.unimsg.getSettings` / `setSettings`), same sender check as the other IPC handlers. No UI yet.
- Autostart (`src/autostart.ts`): `app.setLoginItemSettings` on macOS/Windows, and on Linux (where it does nothing) an XDG entry at `~/.config/autostart/unichat.desktop` pointing at `$APPIMAGE || process.execPath`. It is re-written on every start while the setting is on, because an updated or moved AppImage changes that path. Autostart passes `--hidden` and the app then comes up in the tray only (ignored when there is no tray, or the window would be unreachable). Flatpak needs its own entry (`~/.var/app/.../autostart` or a portal request) - not done.
- Icon: `build/icon.png` (rendered from `apps/ui/public/favicon.svg`).

## Verified (Linux, Xvfb, Electron 45.3.1)
- `build`, `electron-builder --dir` (libsignal prebuilds present in `app.asar.unpacked`), and running both `out/main/main.js` and the packaged `dist/linux-unpacked/unichat`.
- IPC: `window.unimsg` exists, `providers` returns signal, matrix, mattermost, instagram, discord, threema, whatsapp (+teams in later build); the UI shows the empty state and "Add account" lists the providers (`docs/screenshot-add-account.png`, `docs/screenshot-main.png`).
- Encrypted DB created in the throwaway data dir; keychain path (safeStorage) and 0600 fallback (no D-Bus) both exercised.
- CSP: remote `fetch` blocked; `Notification.requestPermission()` returns granted.

## Not verified
- AppImage/deb/NSIS/portable artifacts (only `--dir` built); Windows and macOS runs. wine exists here but no Windows installer was built.
- Tray rendering and native notification popups (no tray/notification daemon under Xvfb; code paths run without errors).
- Real provider logins (no network services contacted). `pnpm typecheck` currently fails only inside `packages/provider-matrix` (`methodFactory`/`setLevel` on logger).
- `safeStorage.isEncryptionAvailable`/`encryptString` are deprecated in Electron 45 (still work); migrating needs an async KeyWrap in `@unimsg/host`.

## Self-update
Own implementation (no electron-updater: the Hub's `Updater` already does release lookup, token handling, download and SHA-256 verification, see https://github.com/PixelcrafterEXE/unichat/wiki/Architecture "Updates"). `src/updater.ts`: `desktopAsset()` picks `desktop-linux-appimage` (running as AppImage, `$APPIMAGE` set; self-update) or `desktop-linux-deb` or `desktop-linux-pacman` (manual; told apart by electron-builder's `resources/package-type` file); unpackaged runs and other OSes get no updates. `replaceAppImage()` copies the verified file next to the running one, renames the old one to `<name>.AppImage.bak`, renames the new one into place and `main.ts` relaunches. Package version: `0.0.0-dev` locally (shown as `dev`); CI builds with `UNICHAT_VERSION=0.1.N` (`dist:linux` passes it as `extraMetadata.version`). Release file names: `unichat-desktop-<version>.AppImage|deb|pkg.tar.zst`. Not tested on a real AppImage in this environment.

## Arch Linux package (pacman)

`linux.target` includes `pacman`: electron-builder runs fpm and writes `dist/unichat-desktop-<version>.pkg.tar.zst` (zstd; the `pacman:` block in `electron-builder.yml` sets the name, compression and the Arch dependency names gtk3, nss, libsecret, libxss, ...). Install with `sudo pacman -U unichat-desktop-<version>.pkg.tar.zst`; for the key storage install `gnome-keyring` or `kwallet`. The build machine needs `zstd` and `bsdtar` (Ubuntu: `zstd libarchive-tools`; the release workflow installs them). The package is not signed and not in the AUR. The in-app updater downloads and verifies the new file (manifest key `desktop-linux-pacman`) and shows the `pacman -U` command, like the `.deb` case. Not built locally here: only the config, the YAML and the asset selection are verified, the first real build happens in the release workflow.

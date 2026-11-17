# UniChat for Android (`apps/android`)

Capacitor 8 shell that shows the same UI as the other hosts (`apps/ui` build) and runs the TypeScript backend
(`@unimsg/host`: Hub + SQLite store + all providers) **inside the app** on nodejs-mobile (Node 18.20.x for Android).
A foreground service keeps the process alive. The UI reaches the backend through the "Android bridge" transport that already
exists in `apps/ui/src/api.ts` (`window.UnimsgNative.call(method, paramsJson) -> Promise<json string>` and `window.__unimsgEvent(json)`).

```
WebView (https://localhost, apps/ui/dist)
  api.ts androidTransport ── window.UnimsgNative (assets/unimsg/shim.js, injected at document start)
        │ WebMessageListener "__UnimsgHost" (origin-restricted; no JavascriptInterface)
  UnimsgPlugin ── NodeBridge.java ── NDJSON over a Unix socket in filesDir (0600) ── nodejs-project/main.js
                                                                                      (src/backend-entry.ts → startBackend())
NodeService (foreground, specialUse) starts NodeRuntime (JNI → libnode.so, node::Start once per process)
```
Protocol: `src/bridge-protocol.ts` (requests `{id,method,params}`, replies `{id,result|error}`, events `{event,data}`, bridge-only
`{ctl:"ready"|"notify"}`, control methods `$ping $foreground $config $flush $shutdown $reply $markRead` + native-only `$requestBatteryExemption $batteryExemptionState`).

## What is where
| Path | Purpose |
|---|---|
| `capacitor.config.ts` | appName UniChat, appId `app.unimsg.android`, `webDir: ../ui/dist`, https://localhost, no cleartext |
| `src/backend-entry.ts` | backend entry: Hub + socket server + notifications decision (runs in Node) |
| `src/sqlite-shim.ts` | `node:sqlite` replacement (see "SQLite") |
| `src/notify.ts`, `src/bridge-protocol.ts` | notification rules, wire protocol |
| `scripts/build-backend-bundle.mjs` | esbuild bundle → `build/nodejs-project/` and copy into Android assets |
| `scripts/smoke-test.mjs` | protocol end-to-end test under plain Node (also with real Node 18.20.4) |
| `scripts/fetch-nodejs-mobile.mjs` | downloads libnode.so + headers into `android/app/libnode/`, sha256 pinned in `scripts/nodejs-mobile.sha256` |
| `scripts/check-android-env.mjs` | verifies JDK/SDK/NDK/CMake/libnode/bundle (`--release`: signing env), prints the exact missing pieces |
| `scripts/unicode-props.mjs` | lowers regex `\p{..}` escapes in the bundle (nodejs-mobile has no ICU) |
| `scripts/persist-test.mjs`, `src/sqljs-persist.ts` | crash-safe sql.js persistence + its unit tests |
| `scripts/build-hyperdht-android.sh`, `src/dht-native-loader.cjs`, `src/dht-smoke-entry.ts` | HyperDHT add-ons for "Reach my devices from anywhere" (prebuilds + patchelf, unverified on a device), loader, Node 18 smoke entry, see "HyperDHT" |
| `scripts/build-libsignal-android.sh` | libsignal cross-compile (x86_64 verified on the emulator, arm64 built only), see "libsignal" |
| `android/` | Capacitor Gradle project: `MainActivity`, `UnimsgPlugin`, `node/{NodeService,NodeRuntime,NodeBridge,DataKey,Notifier}`, `cpp/` (CMake + JNI), manifest |

## Prerequisites
JDK 21 (`JAVA_HOME`; JDK 22+ breaks AGP 8.13), Android SDK with `platforms;android-36`, `build-tools;36.0.0`, **`ndk;27.2.12479018`**, `cmake;3.22.1`,
`platform-tools`; `ANDROID_HOME` set; `unzip`; Node >= 22 + pnpm. `node scripts/check-android-env.mjs` checks all of it and prints the fix for each gap.
`android/local.properties` (`sdk.dir=...`) is gitignored; `ANDROID_HOME` is enough.

## Build (exact commands; verified on this machine)
```
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk ANDROID_HOME=$HOME/Android/Sdk
pnpm install
pnpm --filter @unimsg/ui build                      # -> apps/ui/dist
cd apps/android
node scripts/check-android-env.mjs
node scripts/fetch-nodejs-mobile.mjs                # verifies the pinned sha256 (see "nodejs-mobile download")
node scripts/build-backend-bundle.mjs               # -> android/app/src/main/assets/nodejs-project
pnpm exec cap sync android                          # copies ../ui/dist into the app
cd android && ./gradlew assembleDebug               # app/build/outputs/apk/debug/app-debug.apk (~195 MB with libsignal: libnode.so + libsignal_client_node.so x 2 ABIs)
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s UnimsgNode UnimsgService UnimsgBridge UnimsgMain UnimsgPlugin UnimsgBoot UnimsgNotif
```
Low-RAM machines: `./gradlew ... --no-daemon -Dorg.gradle.jvmargs=-Xmx1400m`. `pnpm --filter @unimsg/android debug` chains UI build, bundle, sync, gradle.
Debug WebView: `webContentsDebuggingEnabled: true` in `capacitor.config.ts`, then `chrome://inspect`.
Backend only, no phone: `pnpm --filter @unimsg/android smoke` (persistence unit tests + bridge end-to-end test). Node 18 (the nodejs-mobile version):
`SMOKE_NODE=/path/to/node-v18.20.4/bin/node node scripts/smoke-test.mjs`.

Emulator (what was used here): `sdkmanager "emulator" "system-images;android-35;google_apis;x86_64"`, `ANDROID_AVD_HOME=~/Android/avd avdmanager create avd -n unichat35 -k "system-images;android-35;google_apis;x86_64" -d pixel_6`,
`emulator -avd unichat35 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect -memory 2048`. Needs /dev/kvm. With several devices attached always use `adb -s emulator-5556`.

## Release / signing
Signing material is read from environment variables or `~/.gradle/gradle.properties` (same names), never from the repo:
`UNIMSG_KEYSTORE` (path), `UNIMSG_KEYSTORE_PASSWORD`, `UNIMSG_KEY_ALIAS`, `UNIMSG_KEY_PASSWORD`. Without them release builds are produced unsigned.
```
keytool -genkeypair -v -keystore unichat-release.jks -alias unichat -keyalg RSA -keysize 4096 -validity 10000
export UNIMSG_KEYSTORE=$PWD/unichat-release.jks UNIMSG_KEYSTORE_PASSWORD=... UNIMSG_KEY_ALIAS=unichat UNIMSG_KEY_PASSWORD=...
node scripts/check-android-env.mjs --release
cd android && ./gradlew bundleRelease          # app/build/outputs/bundle/release/app-release.aab  (Play)   (or assembleRelease for an APK)
```
`versionName` = `apps/android/package.json` version, `versionCode` = MAJOR*10000 + MINOR*100 + PATCH (override: `-Punimsg.versionCode=N`).
R8 minification + resource shrinking are on for release; rules in `android/app/proguard-rules.pro` (JNI `nativeStart`, Capacitor plugin reflection, androidx.webkit,
manifest components). `mapping.txt` and native debug symbols are produced for Play crash reports. Keep the keystore: the Play upload key cannot be recovered. Changing the
application id or uninstalling destroys the Keystore data key and with it the archive (allowBackup is off on purpose).

## nodejs-mobile download
Asset: `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip` (57,287,354 bytes; name confirmed from the release
API). Upstream publishes **no checksums**. `scripts/nodejs-mobile.sha256` pins `bd7321ea...c2af` which was computed here by trust-on-first-use (not compared with an independent source:
please verify it once yourself). The script refuses to unpack without an expected hash (`--sha256`, `--sha256-file`, or the pin file), and aborts on mismatch.
`--pin` records a new hash for another `--version`.

## Foreground service type (Android 14/15)
`dataSync` services get ~6 h per 24 h on Android 15 (targetSdk 35+, `onTimeout`) and cannot be started from BOOT_COMPLETED: unusable for a 24/7 messenger. Options:
| | `remoteMessaging` | `specialUse` (chosen) |
|---|---|---|
| time limit | none | none |
| Play | review expects device-to-device message transfer; a client holding sockets to third-party servers is a stretch | declaration with free-text justification, manual review |
| permission | `FOREGROUND_SERVICE_REMOTE_MESSAGING` | `FOREGROUND_SERVICE_SPECIAL_USE` + `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` |
| API | 34+ | 34+ |
Decision: **specialUse**, because it describes what the app really does without stretching a category. Switch with `./gradlew ... -Punimsg.fgsType=remoteMessaging`
(manifest type, permission and BuildConfig follow). Below API 34 the two-argument `startForeground` is used (manifest type is ignored there). `NodeService.onTimeout` is still
implemented: it stops the service (mandatory within seconds), posts an alert "UniChat is not connected: open the app to reconnect" and tries one delayed restart (which the OS refuses
while the budget is exhausted; nothing else is possible).
**Play Console declaration text (suggestion):** "UniChat is a unified client for the user's own messenger accounts (Matrix, WhatsApp, Signal, ...). These networks have no push
gateway for third-party clients, so the app must keep client connections open to deliver messages while the app is closed. The service runs only after the user added an account, always shows
an ongoing notification, and can be disabled in the app. No other foreground-service type fits (not data transfer with a finite end, not media, not location)." Prepare a short screen
recording: add account, close app, message arrives with the notification visible.

## Start on boot
`BootReceiver` (BOOT_COMPLETED, MY_PACKAGE_REPLACED) starts the service only if the user enabled **keep running in background** AND the backend last reported >= 1 account.
Both flags live in SharedPreferences `unimsg` (`keepAlive`, `accountCount`; default keepAlive=false). The UI sets it through the bridge: `UnimsgNative.call("$config", JSON.stringify({keepAlive:true}))`
(answered natively, returns `{keepAlive,notifyContent}`); the backend reports accounts with `{ctl:"state",accounts:N}`.
Android 15 forbids starting foreground services of types dataSync, camera, mediaPlayback, phoneCall, mediaProjection, microphone from BOOT_COMPLETED. specialUse/remoteMessaging are not
on that list, but a refusal (OEM, future OS) is caught and the user gets the "UniChat is not connected, tap to open" notification (channel "Connection problems"); opening the app always works.
LOCKED_BOOT_COMPLETED (direct boot) is not handled on purpose: data and Keystore key are credential-protected.

## Battery / Doze / notifications
- `$requestBatteryExemption` (UI button; native-only): opens `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` for this package, falls back to the settings list; returns `{ignoring,launched}`.
- `$backupLocate` / `$backupCopy` / `$backupCopyCancel` / `$backupDiscard` (native-only; "Find the backup on this phone" of the WhatsApp/Signal import): SAF folder picker pre-pointed at the backup folder (MainActivity `pickTree`), persisted read grant, file listing, streamed copy into `<data>/.backup/saf/<kind>/` with `backup-progress` events (`node/SafImport.java`). Verified on a Samsung Android 14 phone for WhatsApp; see https://github.com/PixelcrafterEXE/unichat/wiki/WhatsApp-history-import.
  `$batteryExemptionState` returns `{ignoring,keepAlive,notifyContent,sdk}`. The permission `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is restricted by Play (allowed only for apps whose core function is
  affected, e.g. messengers needing background connections: justify it in the declaration; sideload/F-Droid unaffected). OEM killers (Xiaomi, Huawei, Samsung "sleeping apps"): dontkillmyapp.com.
- Channels: `backend` (low, ongoing, secret on the lock screen), `messages` (high), `alerts` (default, reconnect problems).
- Message notifications: one per chat; actions **Reply** (RemoteInput, sent as `$reply {chatId,text}` -> Hub `send`, then `$markRead`) and **Mark as read** (`$markRead {chatId,messageId}`);
  lock screen shows a generic public version. Privacy `$config {notifyContent}`: `full` (chat + text), `sender` (chat name only), `hidden` (one generic "UniChat / New message" notification, no chat identity, **no actions**).
  `$foreground`, `$flush` are sent on UI start/stop; the service/activity also flush on `onTrimMemory` / low memory / task removed.
- No push: while the process is dead messages arrive only when the app runs again.

## SQLite on Android
nodejs-mobile is Node 18 without `node:sqlite`; `src/sqlite-shim.ts` is aliased in by the bundle. `UNIMSG_SQLITE=auto|node|better|sqljs` (Java sets `auto`; sql.js is the effective default).
**sql.js persistence** (`src/sqljs-persist.ts`, unit-tested by `scripts/persist-test.mjs`): tmp file + fsync + rename, previous good image kept as `.bak`, dir fsync, debounce 1.5 s plus flush on
`$flush`/shutdown; at open the main file, an interrupted `.tmp` and the `.bak` are tried in order (header/size validation + sql.js `PRAGMA quick_check`), bad files are kept as `*.corrupt-<ts>`
(newest 2), and if files exist but none is usable the backend REFUSES to start rather than opening an empty database.
**Native engine evaluation** (not implemented, no code claimed): `better-sqlite3` publishes prebuilds for desktop platforms and Electron/Node ABIs only, none for Android/nodejs-mobile,
so a build is required: `nodejs-mobile-gyp`/node-gyp with `--nodedir` = the unpacked nodejs-mobile headers (`android/app/libnode/include`), NDK clang
(`CC=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang`, `--arch=arm64 --target_platform=android`), output `better_sqlite3.node` placed in
`nodejs-project/node_modules/better-sqlite3/build/Release/` (the shim already tries `require("better-sqlite3")` under `auto`). It needs the same libnode DT_NEEDED linkage as libsignal (see below),
bundles SQLite amalgamation (fine), and for the Gradle build it is best done as a separate script producing per-ABI `.node` files copied into the assets, not through CMake. Switch when
archives reach hundreds of MB (sql.js keeps the whole DB in RAM and copies it on every flush). Not attempted: it cannot be verified without a device and adds an ABI-matrix to maintain.

## HyperDHT ("Reach my devices from anywhere")
Optional transport for two devices on different networks (design: https://github.com/PixelcrafterEXE/unichat/wiki/Architecture "Reach my devices from anywhere"; code `packages/sync/src/dht.ts`). On by default for a device in a paired group (user decision 2026-11-15; the Advanced switch turns it off); the `hyperdht` module is imported lazily only when the user turns it on, so the app starts and syncs normally when it cannot load.
- **Needs two native N-API add-ons**: `udx-native` (UDP streams; NO JavaScript fallback) and `sodium-native` (`sodium-universal` has a pure-JS `sodium-javascript` browser fallback, not used: it is slow and lacks pieces HyperDHT's Noise needs on a phone CPU; not evaluated further). Both are `require-addon` modules: `binding.js` loads `prebuilds/<platform>-<arch>/<name>.node` next to the package, which cannot work in the one-file bundle.
- **Findings (checked in node_modules, udx-native 1.22.1 / sodium-native 5.2.1):** both packages ship Android prebuilds for `android-arm64`, `android-x64`, `android-arm`, `android-ia32` as plain `.node` (N-API v8+, NDK r30, API 29, 16 KB page aligned; `udx` needs `libc++_shared.so`, which the app already loads first). Static checks: every undefined `napi_*` symbol of the arm64 and x64 add-ons is exported by our pinned nodejs-mobile `libnode.so`. **Problem:** their DT_NEEDED lists only libm / libc++_shared / libdl / libc (built for hosts whose `node` executable exports N-API), while on nodejs-mobile the N-API symbols live in `libnode.so`, mapped into the app's namespace by `System.loadLibrary`; the same class of problem as libsignal's neon patch. Fix used: `patchelf --add-needed libnode.so` on a copy (no compiler needed).
- **Wiring (written, bundle verified on the host, NOT run on Android):** `scripts/build-hyperdht-android.sh` copies the prebuilds to `android/app/hyperdht/bin/<abi>/libudx_native.so` + `libsodium_native.so` (patched, then statically checked: ELF type, 16 KB alignment, all napi symbols exported by libnode.so; `PATCHELF=/path` if patchelf is not on PATH, e.g. `pip install patchelf`); `build.gradle` adds `hyperdht/bin` to `jniLibs.srcDirs`; `NodeRuntime.java` `System.loadLibrary`s both (failure = log line only); `build-backend-bundle.mjs` replaces both packages' `binding.js` by `src/dht-native-loader.cjs` (tries `UNIMSG_DHT_NATIVE_DIR`, `<bundle>/prebuilds/<platform>-<arch>/`, then `process.dlopen("libudx_native.so")`). Without the `.so` files the loader throws, dht.ts reports **"not available on this platform"** in `syncStatus().dht.reason` (visible in Advanced > Network) and nothing else changes. `--from-source` (cross-building with the NDK like libsignal) is not implemented: only needed if the prebuilds do not load (they target API 29, minSdk is 24: unproven below 29).
- **Verified here:** `node scripts/build-backend-bundle.mjs --dht-smoke` bundles `hyperdht` with esbuild (target node18, same plugins) and runs two transports over an in-process LOCAL testnet under Node 18.20.4 (the nodejs-mobile version) with the Linux prebuilds: connect, firewall allow list, bytes both ways. The full backend bundle still builds and passes the smoke test (`--smoke`, 18 checks). **Not verified:** loading the Android `.node` files, running on an emulator or phone (arm64 or x86_64), battery / memory of a running DHT node on the phone (a node is a UDP socket + a small routing table; ephemeral nodes do not route for others), mobile-network switches. The foreground service must be alive for the phone to be reachable.
- Order to try on a device: `fetch-nodejs-mobile.mjs`, `build-hyperdht-android.sh`, `build-backend-bundle.mjs`, `cap sync`, `assembleDebug`; turn the switch on in Advanced and read the status line ("Ready" or the dlopen error).

## libsignal (Signal provider)
`@signalapp/libsignal-client@0.106.2` ships no Android prebuild (`node-gyp-build` only knows `prebuilds/<platform>-<arch>`, and `import.meta.dirname` does not exist on Node 18). The port:
- `scripts/build-libsignal-android.sh` clones libsignal `v0.106.2`, builds `libsignal-node` with `cargo ndk` (NDK 27.2.12479018, platform 24, 16 KB page alignment, thin LTO, stripped) for `arm64-v8a` + `x86_64`
  and writes `android/app/libsignal/bin/<abi>/libsignal_client_node.so` (~25 / 27 MB; Gradle packages it as jniLibs, `NodeRuntime` `System.loadLibrary`s it before node starts).
- **neon patch (found on the emulator)**: neon resolves `napi_*` with `dlsym` on `dlopen(NULL)`; on Android libnode.so sits in the app's linker namespace, so neon panicked ("Failed to find N-API version", `panic in a function that cannot unwind`, whole
  process aborted). The script copies neon 1.1.1, makes it open `libnode.so` by soname on Android and `[patch.crates-io]`s it into the libsignal workspace. Linking `-lnode` is not needed (no undefined `napi_*` in the add-on).
- `build-backend-bundle.mjs` bundles the real `@signalapp/libsignal-client` JS automatically when `libsignal_client_node.so` exists (`--no-libsignal` forces the throwing stub) and replaces `node-gyp-build` by `src/libsignal-loader.cjs`
  (`process.dlopen("libsignal_client_node.so")`). If the add-on cannot load, the loader returns a module whose functions throw an actionable error, so the other providers still start. `src/libsignal-modules.ts` registers the four modules the
  Signal backup import (`packages/core/src/signalimport/secure.ts`) loads through a computed `import()`.
- **Verified on the x86_64 emulator (Android 15, nodejs-mobile Node 18.20.4):** the add-on loads, the real backend starts, and packages/provider-signal's 75 offline `node:test` tests plus the signalimport tests (97 in total) run on-device against the real
  libsignal: 95 pass (PQXDH/X3DH prekey sessions + decrypt, sealed sender incl. multi-recipient, group send, zkgroup/Groups v2, profile crypto, storage-service crypto, attachments, Secure Backup via libsignal's `BackupJsonExporter`). The 2 failures
  (`capabilities: ...`) read the provider's `src/index.ts` from disk, which does not exist in an APK: not applicable, not a libsignal fault. No network, no account was used.
- **arm64-v8a: built and statically checked only** (aarch64 ELF, exports `napi_register_module_v1`, packaged in the APK); not executed (no arm64 emulator here, the phone was not touched). Same source, same neon patch, expected to behave like x86_64: **unproven** until run on the phone.
- Not verified: linking a real Signal account, receiving/sending (needs the Signal servers). To repeat the on-device tests see "Provider probe" below.

## Provider probe / on-device tests (emulator only, never shipped)
`node scripts/build-backend-bundle.mjs --probe` builds `src/provider-probe.ts` (-> `build/nodejs-probe/main.js`); `--signal-tests` builds the Signal test suites (-> `build/nodejs-signal-tests/main.js`). They are NOT copied into the APK. Run on a debuggable emulator install:
```
adb -s emulator-5556 push build/nodejs-probe/main.js /data/local/tmp/probe.js          # the emulator's own /data/local/tmp
adb -s emulator-5556 shell am force-stop app.unimsg.android
adb -s emulator-5556 shell run-as app.unimsg.android cp /data/local/tmp/probe.js files/nodejs-project/main.js
adb -s emulator-5556 logcat -c; adb -s emulator-5556 shell am start -n app.unimsg.android/.MainActivity
adb -s emulator-5556 logcat -d -s UnimsgNode | grep PROBE        # or "not ok" / "# pass" for the signal tests;  reinstall the APK to restore the real main.js
```
The probe refuses every non-loopback DNS/fetch and uses the packages' own in-process fake servers (`FakeMM`, `FakeDiscord`, `FakeIG`, `FakeTeams`, `FakeGateway`, fake Threema phone/mediator). Last run (x86_64 emulator, Node 18.20.4, `icu=none`): **23/23 pass**.
| Provider | create + start result on nodejs-mobile (emulator) |
|---|---|
| Mattermost | PASS: login prompt offline; fake server login + REST + websocket -> connected, chats listed |
| Discord | PASS: offline prompt; fake REST + gateway (bot and user mode) -> connected + guild loaded |
| Instagram | PASS: offline prompt; fake REST + MQTT/websocket -> connected |
| Teams | PASS: fake Graph/auth -> connected, chats listed |
| Threema Gateway (deprecated) | PASS: fake gateway, HTTP callback listener, NaCl -> connected |
| Threema linked device | PASS: offline prompt; complete link flow vs fake phone/mediator/rendezvous (QR, CSP, BLAKE2b, NaCl) -> connected |
| Matrix | PASS: offline prompt; matrix-sdk-crypto-wasm init on fake-indexeddb, device keys generated, store snapshot written (needed 2 bundle fixes, below) |
| WhatsApp (patched Baileys) | PASS for load + create + Baileys creds/socket construction against a closed loopback port. `start()` was NOT run: it would dial web.whatsapp.com (no fake exists), so a real connect/QR is unverified |
| Signal | PASS via the on-device test suites above (not via start(): linking dials Signal) |
Bugs this found and fixed: (1) **Matrix crypto never worked in the bundle**: `pkg/matrix_sdk_crypto_wasm_bg.wasm` was not shipped next to main.js (now copied by the bundle script); (2) nodejs-mobile has no ICU so
`new TextDecoder(.., {fatal:true})` throws (the wasm glue does this): the bundle banner emulates it; (3) a `\p{..}` escape built from a string in `packages/core/src/searchquery.ts` was mis-lowered and made the whole bundle throw at load (now taken from a regex literal);
(4) nodejs-mobile `os.tmpdir()` is `/tmp` (EACCES) and ignores TMPDIR: only matters for tests that use it (the probes patch it; the backend uses its data dir). The bundle build fails if the Baileys copy is not the pnpm-patched one.

## Native modules / bundle notes
- **nodejs-mobile has no ICU**: regex `\p{L}` etc. are a SyntaxError (found on the emulator). `scripts/unicode-props.mjs` rewrites them to explicit ranges at bundle time; the smoke test asserts none remain.
  Any new `\p{..}` in the repo is handled automatically (`\P{..}` inside a class throws).
- `libnode.so` needs `libc++_shared.so` (CMake `-DANDROID_STL=c++_shared`, loaded first in `NodeRuntime`).
- Baileys optional peers (`sharp`, `jimp`, `link-preview-js`, `audio-decode`) are external and absent. `globalThis.crypto` is polyfilled for Node 18. `bufferutil`/`utf-8-validate` fall back to JS.

## Data key (Android Keystore)
`DataKey.java`: random 32-byte archive key sealed with a non-exportable AES-256-GCM Keystore key (StrongBox if present, no auth requirement), blob in `filesDir/unimsg.key.android`, passed to the
backend as `UNIMSG_DB_KEY`. A key that cannot be unsealed is an error, never regenerated over an existing archive.

## Permissions
`INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `RECEIVE_BOOT_COMPLETED`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `POST_NOTIFICATIONS`,
`RECORD_AUDIO`/`MODIFY_AUDIO_SETTINGS`/`CAMERA` (runtime, on first use). Back button: cancelable `unimsg-back` window event, else history, else `moveTaskToBack`. Notification tap: `unimsg-open-chat {detail:{chatId}}`.

## Verified (this machine)
- `pnpm --filter @unimsg/android smoke`: 9 persistence unit tests + 18 bridge checks on Node 26 and real Node 18.20.4 (adds `{ctl:state}`, `$config keepAlive`, `$reply`/`$markRead` validation + Hub errors, no `\p{}` in the bundle).
- Gradle: `assembleDebug`, `bundleRelease` (R8, unsigned AAB 73 MB with debug symbols) and signed `assembleRelease` (throwaway key) succeed; CMake/JNI link against the real nodejs-mobile 18.20.4 for arm64-v8a and x86_64.
- APK static check (aapt2/apkanalyzer-equivalent): permissions, `foregroundServiceType=0x40000000` (specialUse) + subtype property, receivers (boot exported, action receiver not), ABIs arm64-v8a+x86_64, libnode/libc++_shared/libunimsg-node, bundle + shim + UI assets.
- **Emulator** (android-35 google_apis x86_64, KVM, headless): app starts, node 18.20.4 boots from the extracted bundle, "backend ready", bridge handshake (`UnimsgBridge: backend ready`), UI loads over the Android transport
  and renders "No accounts yet" from a real `snapshot` call, service is foreground with type 0x40000000, channels `backend`/`alerts` exist, the account count `{ctl:state}` reaches the prefs, MY_PACKAGE_REPLACED restarts the service with keepAlive on,
  a shell-sent BOOT_COMPLETED is refused by the OS (not a real boot) and the fallback notification is posted. The R8 release build runs identically. Screenshots: `~/Android/shots/`.
Bugs found by running it and fixed: missing `libc++_shared.so`, `\p{L}` SyntaxError (no ICU), eager `require.resolve` for the wasm file, `UnsatisfiedLinkError` not caught in the service.

## NOT verified (needs a phone / real accounts)
Notification posting with real messages, Reply and Mark as read actions, `$requestBatteryExemption` dialog, the UI button calling `$config`/`$requestBatteryExemption` (UI not changed here), real reboot (BOOT_COMPLETED),
Android 15 behaviour on a physical device and OEM killers, arm64 execution (only x86_64 ran; arm64 libsignal add-on not executed), getUserMedia/file chooser, Doze, a real WhatsApp/Signal/Matrix account (providers were exercised against fakes, see the probe table), memory use of sql.js with a big archive,
StrongBox, better-sqlite3 (not built), the `$installApk` handoff end to end (that the corrected FileProvider root really shares the file, that the system installer opens, and that the signing-certificate comparison reads an archive's certificates on a real device — it is written so that a failing check never blocks an install).

## Known gaps / follow-ups
1. UI (`apps/ui/src`): settings toggles for keep-running (`$config {keepAlive}`), notification privacy, a "battery optimization" button (`$requestBatteryExemption`), handle `unimsg-open-chat` / `unimsg-back`.
2. Crash loop: if Node dies at start (e.g. bad bundle) the process is killed and START_STICKY restarts it forever; add a backoff/circuit breaker.
3. Node `exit()` inside nodejs-mobile ends in a segfault of the whole process (seen when the bundle failed to parse): always exit via the supervised path.
4. Pin the sha256 independently; set `webContentsDebuggingEnabled` false for release (default).

## Device sync on the phone (packages/sync)
- **Engine:** the Android bundle aliases `node:sqlite` to `src/sqlite-shim.ts` (sql.js); `sync.db` uses the same shim as the message store (no extra work). All primitives sync needs exist in Node 18 (X25519, ChaCha20-Poly1305 with AAD, HKDF, scrypt, HMAC). `pnpm --filter @unimsg/sync test:node18` (needs `SMOKE_NODE=/path/to/node18`) runs the whole sync suite, including two Hubs pairing over loopback and a snapshot transfer, under Node 18 with sql.js.
- **Listener:** the backend does not listen unless pairing is open or "Sync over the network" is on. A phone can stay dial-only (it connects out to the desktop); that needs no native change. Staying reachable needs the foreground service to be alive.
- **Pairing without firewall changes (2026-11-14):** the phone has no inbound firewall, so it is usually the reachable side. When its "Add a device" screen shows a code, the nodejs-mobile backend (same process as the app, no foreground service needed beyond the open screen) listens on the LAN interfaces on port 45045 (fallback 45046-45052), and a laptop that has only the code finds it with a probe of its own /24 (outbound only). When the phone types a code instead, it dials out (code, QR addresses, mDNS, subnet probe, all in parallel). Needs no multicast and no inbound access to the laptop. Caveat: `os.networkInterfaces()` throws on some Android versions; the sync package then sees no interface (no listen address, no probe) and only "type its address too" works: check on the phone, not verified yet.
- **mDNS needs a `WifiManager.MulticastLock`:** done in `MainActivity` (acquired in `onStart`, released in `onStop`, permissions `ACCESS_WIFI_STATE` + `CHANGE_WIFI_MULTICAST_STATE` in the manifest), so "nearby devices" works while the app is open. In the background (service only) multicast is still dropped; pairing by typing only the code (subnet probe), or scanning the QR code, works without multicast. On the phone (2026-11-14) the lock is acquired (WifiService logs acquireMulticastLock) and Sync devices shows "nearby: nothing yet" because the laptop firewall drops UDP 5353 / TCP 45021; discovery itself still unverified.
- **Wi-Fi only media:** the UI reports `navigator.connection` (`syncSetMetered`); the native shell may instead call `hub.call("syncSetMetered", {metered: ConnectivityManager.isActiveNetworkMetered()})` through a `$config`-style control.
- **Smoke test (follow-up, apps/android was not touched):** extend `scripts/smoke-test.mjs` with two `runBackend` instances (different data dirs/keys), `syncStartPairing` on one, `syncJoin` + `syncApproveJoin`/`syncConfirmJoin` on the other over 127.0.0.1 (pass the real `sync` RPCs through `core.call`), then check a message created on one appears on the other; the same flow runs against `packages/sync/src/testkit.ts` under Node 18 today.

## Pairing links and the QR scanner (2026-11-14)
- The QR on "Add a device" encodes `unichat-sync://pair?h=<hosts>&p=<port>&c=<code>&k=<key>`. `AndroidManifest.xml` registers an intent filter on `MainActivity` (VIEW, DEFAULT, BROWSABLE, scheme `unichat-sync`, host `pair`), so the system camera / Google Lens / a browser offers to open UniChat instead of "no app can open this". The activity is `singleTask`, so a running app gets the link in `onNewIntent`; a cold start reads it in `onCreate`.
- `MainActivity.syncLinkFrom` -> `NodeBridge.openSyncLink` (only `unichat-sync://pair?...` up to 2000 chars; kept until a page is attached, delivered once) -> `{"ctl":"sync-link","url":...}` -> `shim.js` stores `window.__unimsgSyncLink` and dispatches `unimsg-sync-link`; the UI opens Settings > Sync devices and starts joining. The user only compares the 6-digit number.
- In-app "Scan QR code" (Sync devices > Connect to another device) uses `getUserMedia` (CAMERA is already declared; Capacitor's WebChromeClient asks at first use) and the bundled jsQR; no camera or a denied permission shows "Couldn't use the camera. Type the code instead."
- Nearby devices need the multicast lock (held while the app is in the foreground, see above). Verified: manifest merges and `:app:compileDebugJavaWithJavac` passes offline with JDK 21. NOT verified on a phone: the intent chooser from a real camera app, cold-start delivery timing (1.5 s delay after the page attaches), mDNS on the phone's Wi-Fi.

## Move to another device: the phone as target (2026-11-14, fake providers only)
- Settings > Move to another device moves an account over the paired-device sync channel (https://github.com/PixelcrafterEXE/unichat/wiki/Architecture "Move to another device"). The phone can be the TARGET: the same `SyncService` runs in nodejs-mobile; the receiving confirm ("Move X from A to B?") is a global dialog in the UI (`MoveWatcher`), shown on whatever page is open while the app is in the foreground. It needs the app (or the foreground service) alive and both devices online in the sync device list; nothing is queued for later.
- **Node 18 / sql.js:** `move.ts` imports only `node:crypto`, `node:fs`, `node:path`; its records live in the ledger kv (the sql.js shim like everything else in `sync.db`); staging is AES-256-GCM sealed files under the sync data dir (no `os.tmpdir()`); a chunk (192 KiB, base64) always fits one 512 KiB channel frame. `Hub.moveInstall` uses sync fs calls only. Covered by `packages/sync/src/android.test.ts` (source assertions + primitives) and by `move.test.ts` run under real Node 18.20.4 with sql.js: `SMOKE_NODE=/path/to/node-v18.20.4/bin/node pnpm --filter @unimsg/sync test:node18 move` (13/13 pass on 2026-11-14).
- **Needs a provider factory on the phone:** the target refuses an account whose provider kind it cannot run ("cannot run this kind of account"), so a source can only move what the phone's bundle contains. Android does not ship every provider; check `providers` before promising a move.
- **Not verified on a device:** the dialog on the phone, a transfer while the screen is off (the connector start after install uses the foreground service), a Signal/WhatsApp session started on the phone after a move. Large sessions (20 MB) were only tested between two desktop-side processes.

## Sending through another device (phone as the relaying client)
The phone mirrors accounts (history only) and, once the laptop allows it (one prompt on the laptop, or its per-account switch), sends through the laptop's live login automatically: status "via <laptop>", "Archive only — <laptop> is offline" when it is off, "History copy — ask <laptop> to allow sending" before permission. No new native pieces: the glue is plain JS in packages/sync (`proxy.ts`) over the existing encrypted session, only Node 18 APIs and the sql.js shim (`android.test.ts` still passes; the Node 18 suite `test:node18` was NOT re-run with relay.test.ts here). The phone never receives the login. Verified with fake providers on the host only, not on a device.

## Backend watchdog, keep-alive and network changes (2026-11-15)
Failure modes found by reading the code (user report: Sync devices spinner for hours, "connection refused" on 45045, only a restart helped):
1. **No liveness check anywhere.** `UnimsgNative.call` has no timeout, `NodeBridge` only noticed a closed socket (a frozen Node thread or a stale WebView reply proxy looked healthy), `core-connection` "down" was only produced on a socket close, and `$ping` was queued while the backend was down. Fix: UI heartbeat (`apps/ui/src/heartbeat.ts`: `$ping` every 10 s while visible and on resume/focus/online; 2 misses = "Reconnecting to the backend…" banner, pending calls fail, new calls fail fast; ~1 min of silence = `$restartBackend`) plus a native watchdog in `NodeBridge` (ping every 15 s; 4 misses, or no socket for 150 s = restart).
2. **Restart = new process** (`NodeRuntime.restartProcess`): node::Start works once per process. It sends `$flush` (sql.js writes tmp+fsync+rename, so a kill never leaves a half file; at most the last 1.5 s debounce is at risk and `$flush` covers it), waits up to 2 s, schedules `NodeService` through an alarm and `Process.killProcess`; START_STICKY is the second path. Max 3 restarts / 10 min (no loops). `$restartBackend` re-pings natively first: a UI-side hiccup never kills a healthy backend.
3. **Listener**: the sync listener was opt-in (`listen.enabled=false` by default, open only while "Add a device" was showing) and bound one socket per interface address found at that moment (`os.networkInterfaces()`, which can throw/return nothing on Android; failures were swallowed), re-evaluated only every 10 s tick and only for scope "lan"; a server that closed was never re-created. Fix in `packages/sync`: a paired device listens by default (LAN scope; the user can turn it off), on Android the host passes `wildcardLan` (one `0.0.0.0` socket on 45045..45052 for every network, connections that did not arrive on a private address are dropped), `NetworkMonitor` (ConnectivityManager callback) reports all addresses as `$network` -> `syncNetworkChanged`, servers that stop listening are rebound, mDNS re-joins its multicast groups.
4. **Foreground service**: notification text now says why it runs (accounts / sync), `stopWithTask=false`, restart alarm on task removal, multicast lock held by the service while a sync group exists, `keepAlive` defaults to true, the boot receiver and the keep-alive logic count a sync group (`{ctl:"state",sync:true}`) like an account, and a one-time dialog (4 s after the UI opens, only if there is something to keep) leads to the system "ignore battery optimisations" screen. (Also fixed: the Settings row read `exempt` while native answers `ignoring`, so it always claimed "not exempt".)
Tests: `apps/ui/src/heartbeat.test.ts` (`npx tsx --test`), `apps/ui/e2e/tests/bridge.ts`, `packages/sync/src/netchange.test.ts` + the migration test in `dht.test.ts`, `pnpm --filter @unimsg/android smoke`; Java compiles (`./gradlew --offline :app:compileDebugJavaWithJavac`).
**Only verifiable on the phone:** that the alarm/sticky restart really brings the service back after `killProcess` (and its time), that the exemption dialog appears once, that `NetworkMonitor` fires on a real Wi-Fi switch and the wildcard socket accepts on the new IP, that the multicast lock keeps mDNS answers coming with the screen off, behaviour under OEM task killers, and that Doze (with and without the exemption) keeps the 45045 listener reachable overnight.

## Self-update (APK)
`updateCheck/Download` run in the Node backend (packages/core/src/updater.ts); the verified APK lands in **`<filesDir>/unimsg-data/accounts/updates/`** — the Hub's data dir is `<UNIMSG_DATA>/accounts` (`new Hub(join(dataDir, "accounts"), …)` in packages/host/src/index.ts) and the updater writes `<Hub data dir>/updates`. That path appears twice natively and both copies must match it: `UPDATES_DIR` in `node/NodeBridge.java` and the `unimsg_updates` entry of `res/xml/file_paths.xml`. (Issue #91: both said `unimsg-data/updates`, so the handoff refused every real download and no installer ever opened.)
The UI then calls `$installApk {path}` (answered natively in `NodeBridge`): only `*.apk` below that folder are accepted; without the "install unknown apps" permission (`REQUEST_INSTALL_PACKAGES`) the system page for UniChat opens and `{needsPermission:true}` comes back; otherwise `ACTION_VIEW application/vnd.android.package-archive` with a FileProvider URI, started from `MainActivity` while it is on screen (an activity start from an application context is dropped silently once the app is backgrounded). Every other outcome is `{started:false, error:"<sentence>"}`, which the UI prints under the status line — no path may end without an answer. `$apkInstallState` reports `canInstall`.
Versions: `UNICHAT_VERSION` (0.1.N) = versionName and baked into the backend bundle; `UNICHAT_VERSION_CODE` (CI: 1000 + run number, must stay above local builds: package.json 0.1.0 gives 100) = versionCode; also `-Punimsg.versionName/-Punimsg.versionCode`. `$network {metered:true}` (not sent by the native side yet) pauses background checks.

### Which key signs the APK, and why a local build blocks the update (issue #92)
Android replaces an installed app only with a build signed by the **same** key; otherwise the install fails with "app not installed" / "a package with the same id already exists". There is no release keystore in this flow — everything is **debug**-signed:

| Build | Key |
|---|---|
| CI (`.github/workflows/release.yml`, job `android`) | the repository secret `ANDROID_DEBUG_KEYSTORE_B64`, base64 of **the maintainer's `~/.android/debug.keystore`**, decoded into `~/.android/debug.keystore` on the runner before the build. The job fails in seconds when the secret is missing. |
| local `pnpm run debug` / `./gradlew assembleDebug` | your own `~/.android/debug.keystore`, which the Android SDK generates per machine (alias `androiddebugkey`, store/key password `android`). |

So the two match only on the machine that keystore came from. On any other machine the CI APK — downloaded by hand or by the in-app updater — cannot install over a locally built UniChat. `$installApk` now compares the signing certificates (`GET_SIGNING_CERTIFICATES`, the installed app's whole certificate history vs. the archive's) before handing the file over and answers with a sentence instead of letting Android fail in its own words; when the comparison cannot be made it stays out of the way and lets the installer decide.

What to do, in order of preference:
1. **Use the same debug keystore**: copy the keystore behind `ANDROID_DEBUG_KEYSTORE_B64` to `~/.android/debug.keystore` (`base64 -d < key.b64 > ~/.android/debug.keystore`) and rebuild. Local builds and CI builds then replace each other freely, and the in-app update works. Back up the file; it is the only copy of that key.
2. **Uninstall first**: `adb uninstall app.unimsg.android`, then install the CI APK. This **deletes the app's data** — the message archive is encrypted with a key in the Android Keystore that the uninstall destroys, and `allowBackup` is off on purpose (see "Release / signing"), so the archive is gone for good. Export/pair with another device first if the data matters.
3. Keep building locally and ignore the published APKs; the updater says what is wrong instead of silently doing nothing.

Do not "fix" this by generating a new keystore in CI: every published APK would then be a one-way street for everyone who already installed one.

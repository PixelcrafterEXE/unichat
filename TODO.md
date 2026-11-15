# UniChat – open todo (kept up to date by Claude)
Last updated 2026-11-14. The README has the per-messenger feature matrix (Verified / Untested / Unimplemented / Unsupported).

## Finished 2026-11-15: pinned messages (fakes only)
- Core `pin` / `pins`, sync LWW register, providers WhatsApp (24h/7d/30d), Signal (+ until removed), Matrix (`m.room.pinned_events`), Discord, Mattermost, Teams (chats only); Instagram/Threema/mesh unsupported. UI bar + menu + info list, mock + e2e `pins`.
- [ ] Nothing verified against real services. WhatsApp: check that the phone shows the pin and that incoming `pinInChatMessage` arrives through messages.upsert on a real account. Signal: pin messages need a recent client; check the duration encoding. Teams: incoming pins by others only appear when `pins()` is asked (no event); Graph pinnedMessages needs Chat.ReadWrite. Discord/Matrix need Manage Messages / power level to pin.
- [ ] Discord uses the deprecated `/channels/{id}/pins` endpoints (the newer `/messages/pins` has paging).

## Finished 2026-11-14: Matrix emoji verification (fake-verified only)
- Generic contract in core (`Capabilities.verification`, event `verification` {accountId, id, phase incoming|waiting|sas|confirming|done|cancelled, other, emoji, reason}, optional `Connector.verificationStart/Action/Status/Setup/Recover`; Hub calls `verificationStart|Action|Status|Setup|Recover`, `pendingVerifications`; proxy accounts do not forward it). Matrix: `packages/provider-matrix/src/verification.ts`. UI: `VerifyDialog.tsx` (emoji grid dialog, incoming toast + notification, account-card row, contact-panel row, set-up with password + recovery key shown once, verify with recovery key), mock `mockMatrixVerify.ts`.
- Tests: provider-matrix 55 (16 verification), core 174 (1 new), UI e2e `matrixverify` 11.
- [ ] NOT tested against a real homeserver or with Element as the second device (real SAS exchange, UIA flow of cross-signing upload, secret-storage bootstrap, recovery-key import, DM requests in encrypted rooms, requests from other users). The lab (`packages/provider-matrix/lab`) has no scenario for it yet; the old lab step that only read the `deviceVerification` privacy entry still applies.
- [ ] The device name in the dialog is the SDK's device display name (or id); QR-code verification and showing a list of own devices are not implemented. Servers that need SSO/OIDC approval to upload cross-signing keys get a plain "do it in Element" message.

## Finished 2026-11-14: avatars persist and sync between paired devices
- Core: profile pictures are stored durably (Store `getAvatar/putAvatar/listAvatars/deleteAvatars/pruneAvatars`, SqliteStore table `avatars` with sealed mime/hash/bytes, MemoryStore too; `packages/core/src/avatarstore.ts`). `hub.avatar` serves memory cache -> store -> live connector; a stored picture older than 7 days (or whose chat/space picture hint changed) is refreshed when the connector is live, a failed refresh keeps the old one; "no picture" is remembered 1 h. Signed-out/archived accounts and restarts keep their pictures. Event `avatars-changed {keys}` makes the UI retry misses.
- Sync: `packages/sync/src/avatars.ts` (RPC `av.list` / `av.get`, outside the ledger): delta by sha-256, last writer wins by fetchedAt, 256 KB per picture, 64 MB total, <= 200 per run, 40 ms gap, one run per peer every 5 min, held back on a metered connection unless the media policy is "all". Verified with fakes only (loopback, two/three in-process devices).
- Follow-up (same day): deletions replicate as tombstones (30 days; leaveChat, picture change, account removal), "no picture" results sync for 1 h and never replace a picture, `avatarRev` hints (Matrix, Mattermost, Discord, Instagram) + `avatar-changed` provider events (WhatsApp, Threema linked device) refresh stored pictures at once, 24 h TTL for recently opened chats without a hint, own-picture changes refresh every stored copy and sync. Tests: core 13, store-sqlite, sync loopback 8 (fakes only).
- Follow-up 2: the synced device lacked many community covers because the laptop's store only held pictures somebody viewed. Now `Hub.warmAvatars` pre-fetches all spaces, folder chats and the 300 newest chats (rate-limited, backs off), sync drains in 15 s steps and on an `av.hint` from the holder. Tests: core warm-up, sync loopback (40 pictures to a connector-less device in seconds, each transferred once; metered hold). Fake-verified only: measure on the real laptop/phone (29/33 covers -> expect all that the providers return).
- [ ] The Android host should call `setAvatarWarmPaused` on metered / low battery (nothing calls it yet).
- [x] Signal profile keys from all sources (2026-11-15, fakes only): inbound messages (DM + group), storage records, Secure Backup import via `Connector.importContacts` (re-run the import to fill already imported chats); names must be valid UTF-8 without control characters. Open: check on a real account; the storage-record PNI tag (24) is unverified.
- [x] Auto merge of provider-declared duplicate chats (`Chat.sameAs`, Signal PNI+ACI) into one merged row (`merge:auto:<hash>`, unmerge is remembered). Fakes only; Signal sync transcripts to a PNI are not used as a source yet.
- [x] Signal avatars (2026-11-14): `avatar()` for DM/contact/own (profile key -> `/v1/profile` -> CDN blob) and groups, `avatarRev` on chats, `avatar-changed` events. Fake-verified only (provider-signal tests); check against a real account with the lead.
- [ ] No hint yet: Teams (Graph photo ETag would need a request per chat), contacts (`Contact.avatarRev` exists but nothing fills it). Check the hint sources against the real services (WhatsApp 'picture' events, Mattermost, Discord) with the lead.

## Finished 2026-11-13 (night)
- Threema Gateway is DEPRECATED (hidden from "Add account", existing accounts keep working). Threema linked device (`packages/provider-threema-md`, shown as "Threema"): all protocol layers written clean-room against fakes only, never live; AGPL/protocol licence question for opensource@threema.ch; needs a throwaway ID for the first live test (README has the plan)
- Signal history import (Settings > Backup & restore): legacy Android .backup + Secure Backup (+ media of on-device folders), media verified against a real on-device backup (2026-11-14: 2113 of 2159 files, idempotent re-import)
- Archive: single global switch with unread bubble, right-click mark-all-read; settings grouped; picture zoom (WhatsApp full size); colours; folder emoji; icons unified; WhatsApp group adding / members fixes

## WhatsApp history import (2026-11-14, built with synthetic fixtures only)
- WhatsApp history import from a local backup (account card > Import chat history; `packages/core/src/whatsappimport/`, docs/WHATSAPP_IMPORT.md, RPCs `whatsappBackupInspect/Import/Cancel`): msgstore.db.crypt15 (64-digit key) and crypt14 (158-byte key file), streamed decrypt (AES-256-GCM + zlib) to a private temp SQLite file, tolerant schema reader (text, replies, reactions, edits, deletes, polls + votes, locations, contacts, view-once, disappearing), media from the Media folder with size/sha256 check, ids = WhatsApp key ids (dedupes against live messages), idempotent, cancellable, one transaction. 22 core tests + 10 e2e (mock) pass.
- [ ] VERIFIED vs FIXTURE-ONLY: everything above is fixture-tested only. Never run against a real crypt15 file: header layout, key derivation constant "backup encryption", GCM tag/md5 trailer, and above all the msgstore.db table/column names (message_media, message_add_on*, message_poll*, message_system action types, jid_map) are from community docs, not seen on a real DB
- [ ] Run the first real import with the lead: inspect first, check counts per chat against the phone, then import; fix schema drift (report `unsupported schema` text) and map the `message_system` action types (group renames, timer changes, member joins are only counted as noise today)
- [ ] Keep `mediaKey`/`direct_path` of imported media so the live provider can still download files that are missing from the Media folder (not stored today; missing files keep a `[Photo]` placeholder)
- [ ] Imports use `node:sqlite` (Node 22.5+); the Android (Node 18 + sql.js shim) build is untested for this feature
- [ ] Calls (`message_type` 8/10/90 + call_log) are skipped, not shown as system notes

## Finished 2026-11-14: full-text search + fetch chat history
- Full-text search (core: searchquery.ts, search-fts.ts, search.ts): SQLite FTS5 in an in-memory DB (never on disk; rebuilt from the sealed archive at start, with progress events `search-index`), prefix/phrase/-exclude, from: in: has: before: after:, ranked + highlighted snippets, chat/contact name hits, scope (chat/account/messenger); fallback to the plain in-memory scan where node:sqlite/FTS5 is missing (Android). UI: search panel with chips, keyboard navigation, in-chat search with operators. Perf run: packages/store-sqlite/src/search.perf.ts.
- Fetch chat history (core: historyjob.ts, `Capabilities.fetchHistory`, Settings > Storage & downloads): per account, optional chat selection, 30 days / 1 year / everything, per-messenger pacing, progress, cancel, resume after restart (explicit "Resume"), failure counts per reason. On for Discord, Matrix, Mattermost; WhatsApp waits for the WhatsApp provider to declare it.
- [ ] Real archive check of the search (never run on real data), CJK search quality, auto-resume of interrupted history jobs when the account reconnects

## Finished 2026-11-14: pairing that needs no firewall or network setup
- Direction-agnostic pairing (packages/sync `discover.ts`, `service.ts`): the device that enters the code dials out, the one that shows it listens on the well-known port 45045 (fallback to 45052); candidates (QR addresses, typed address, hints, known members, mDNS, probe of the own private /24) tried in parallel, first authenticated handshake wins; role flip ("Show a code here instead") and group-holder-hosts rule; UI wording in SyncPanel; mock + e2e; docs/ARCHITECTURE.md "Pairing works from either side".
- Verified only with fakes (loopback + simulated drop-everything firewall + fake LAN connector): 13 new sync tests, 3 new e2e tests.
- [ ] Verify on the real laptop (nftables default drop) and the phone: laptop shows code -> phone types it (expect "could not reach" + flip), phone shows code -> laptop types only the code (expect probe to find it within ~2 s); check `os.networkInterfaces()` on the phone (nodejs-mobile) and that 45045 is bindable there.
- [ ] A hostile LAN host can answer the probe and see only "a pairing handshake started" (mode + ephemeral key); it still cannot verify guesses without the scrypt-keyed handshake cost (unchanged threat model).

## Running now
- (nothing: all agents finished)

## Finished 2026-11-13 (late: message info on tick click, rail groups by dragging, shift multi-select, square video player, Discord grouped-message indentation, Signal profile names + read-only storage-service sync waiting for the phone to hand over the key)
## Finished 2026-11-13 (earlier) (Android too: debug + signed release build and an Android 15 emulator run; restart the backend to run them; nothing here is verified live except Matrix)
- Matrix verified against a local Synapse (25-step lab) + invites, mentions, formatted bodies, key-backup restore, threads, room topic
- Hub/UI batch: global search, mark-all-read written back, download-all-media before sign-out, deleted cards hidden, mixed-community tag, approximate-unread dot, attachment hints, Android back/notification events + notification privacy
- Backup follow-ups: desktop save/open dialogs, move-login wizard (Settings > Data), portable Discord sessions, static-ish WhatsApp import, async Electron key storage
- Device sync phase 1 (packages/sync, Settings > Devices): Noise-based pairing + LWW/CRDT replication of archive/settings/folders/etc.; credentials sharing only for Mattermost/Discord/Teams; see its caveats (LAN listener on all interfaces once a group exists)
- Signal: sealed sender, link previews, Groups v2 create/manage/picture/description, mentions; WhatsApp: mentions, link previews, forwarded, disappearing timers
- UI e2e suite in the repo: `pnpm e2e` (84 tests)
- Group descriptions (WhatsApp, Matrix), your own name for any group member, Discord login with mode selector + token help, Add-account list without notices, error boundary

## Sync UI redesign (2026-11-14)
- [x] Simplified Sync devices page (devices list, one "Add a device", "Connect to another device", closed Advanced), single confirm dialog, toast, one first-sync progress bar; the stray grey ellipse next to "this device" (empty state cell with a dash and a stretched bar) is gone.
- [x] `unichat-sync://` deep link on Android (intent filter, singleTask, bridge event), `?pair=` on the web UI, Copy link, in-app Scan QR (jsQR 1.4.0).
- [x] Nearby pairing without a code (public-psk Noise + commit/reveal numeric comparison, rate limited); 9 new sync tests, 8 new e2e tests, phone 360px check.
- [ ] Verify on the phone + laptop: system camera opens UniChat, nearby list fills over real mDNS, in-app scanner reads the laptop's QR, auto-reconnect after Wi-Fi change.
- [ ] Possible follow-ups: show nearby devices of the same group as "reconnect now"; 8-digit number for nearby; unit test jsQR against a rendered QR.

## Planned: device sync (P2P, no server) – design agreed 2026-11-13
- [x] (built; automated multi-device campaign 2026-11-14 on loopback fakes: pairing failures/forged peers/conflicts/50k messages/A->B->C/revoke/secrets all pass; still untested between real devices) Phase 1: local-network pairing (mDNS + short code / QR), shared device-group key, authenticated encrypted channel, replication of archive + settings/aliases/folders/merges (reuses the backup container for the first bulk transfer), token-based account credentials (Mattermost, Discord, Teams) shared encrypted
- [ ] Signal / WhatsApp: either each device links separately, or one "home" device holds the session and the others proxy through it (the UI already can talk to any backend)
- [x] "Move to another device" runs over the paired-device sync channel (PREPARE/TRANSFER/COMMIT, confirm on both devices, source wipes only after the target durably owns the account, lost-answer resolution by query); the sealed file stays under "Use a file instead"; several accounts in one go (one prompt on the target, per-account progress), and a target holding only a history copy / relayed copy takes the login over it; chat history (messages, files, names) moves with it, with a size estimate, optional removal here afterwards, "Move without history" after a history failure, and a one-off "send the full history of an account to a device"; accounts that came from another device cannot be shared onward. Open: real Signal/WhatsApp/Matrix accounts, phone as target on a device, resumable transfer after a disconnect (a broken move restarts), UI check on the real phone
- [ ] (fake-provider tests pass: sealed package, wipe without remote logout, tamper/wrong passphrase, one owner, one-time package; real Signal/WhatsApp untested) "Move this account's login to another device" (scan the QR on the PC, move the session crypto to the always-on phone): one-account sealed session export/import; the source stops WITHOUT remote logout and wipes its session material; depends on the backup/export work
- [ ] (2026-11-14: HyperDHT fallback "Reach my devices from anywhere" built and tested on a LOCAL testnet only, incl. Node 18.20.4 via `build-backend-bundle.mjs --dht-smoke`; NOT verified: real internet / NAT types, Android device (prebuilds exist for android-arm64/x64 but need `patchelf --add-needed libnode.so`: `apps/android/scripts/build-hyperdht-android.sh`, unrun on a device), pairing over the DHT deliberately not offered (needs a PAKE), `--from-source` Android build not written) (relay + address list built; hostile-relay and Node-18-API-assumption tests pass; libp2p/Hyperswarm not used; Node 18 run of the suite and the Android phone still to do) Phase 2: sync beyond the local network, Android embedded Node check
- Renamed to **UniChat** (display name, 2026-11-13). Internal names stay: @unimsg/* packages, UNIMSG_* env vars, ~/.config/unimsg, `.unimsg-backup`.

## Needs your check (real accounts / phone)
- [ ] HyperDHT fallback ("Reach my devices from anywhere"): with a laptop at home and the phone on mobile data, turn it on on both (while they are connected once so the keys travel), check Sync status says "Ready" on both and they connect; try a symmetric-NAT / CGNAT carrier; on the phone check the add-ons load (`apps/android/scripts/build-hyperdht-android.sh`, then rebuild; "not available on this platform" = they did not). Decide whether the public Holepunch bootstrap nodes are acceptable or run your own (`Use my own bootstrap node`).
- [ ] Pairing across networks over the DHT (needs a PAKE so the rendezvous key is not a function of the low-entropy code alone; see docs/ARCHITECTURE.md)
- [ ] Android on a real phone: authorize USB debugging, `adb -s <serial> install` the debug APK (apps/android/README.md); check notifications + Reply/Mark as read, battery dialog, reboot restart with "Keep running in the background", arm64, file picker, microphone
- [ ] Verify the pinned nodejs-mobile sha256 (apps/android/scripts/nodejs-mobile.sha256) against an independent source; add a crash-loop backoff for the Android service; Signal on Android: libsignal add-on built + on-device crypto tests pass on the x86_64 emulator; arm64 add-on untested on the phone, linking a real account untested
- [x] WhatsApp polls in DMs verified live both ways (2026-11-14); session PN/LID aliasing fixed phone->UniChat decrypt after relink. Group polls still untested.
- [ ] Voice messages end-to-end: send one to Whatsapp-o-mat / Signal-o-mat and check it plays as a voice note (Signal sends Ogg/Opus; fallback documented in the Signal README)
- [ ] Signal group sending + attachment sending (fan-out, unsealed envelopes): `[signal] groups v2: send` / `attachment upload` lines
- [ ] Mattermost against communicating.tuhh.de (read status sync, custom emoji, sending)
- [ ] Instagram and Discord with throw-away accounts (unofficial modes break the services' terms; see their READMEs)
- [ ] Remote logout on a real WhatsApp account: the device must disappear from Linked devices
- [ ] WhatsApp community covers (2 of 8 have none), group-picture change, folders / merged chats on your real data
- [ ] Backend crash when moving a chat into a community: could not be reproduced; the server now logs `[unimsg] uncaught exception` with a stack instead of dying. Send the line if it happens again.

## Multi-device test campaign 2026-11-14 (loopback, fakes, temp dirs)
- Verified: see docs/ARCHITECTURE.md "Tests" (sync campaign.test.ts / android.test.ts, relay hostile test, core movesession.test.ts). Bugs fixed: `unreadMark` was lost on restart with the SQLite store and never replicated by sync; session packages could be imported twice; a failed wipe in "move away" was silent.
- Still untested: real network (NAT, Wi-Fi roaming, mDNS on real LANs), two real phones/PCs, Node 18 run of the new suites (`SMOKE_NODE=... pnpm --filter @unimsg/sync test:node18`), the same package imported on two different installs, real Signal/WhatsApp sessions, battery/background limits on Android, clock skew between devices beyond the HLC future-stamp check.

## Not built yet (after the batch above)
- [ ] Voice and video calls (only call cards are shown)
- [ ] Disappearing messages in the UI (timer indicator, setting it) for all messengers
- [ ] Signal on Android: add-on cross-built (apps/android/scripts/build-libsignal-android.sh) and 95/97 provider tests pass on the emulator; still to verify on the phone (arm64) with a real link. Android APK build (needs the Android SDK), Windows/Linux packages (AppImage, deb, NSIS never built)
- [ ] Web UI hardening: HTTPS deployment guide, per-device tokens
- [ ] Unreproduced: backend crash when moving a chat into a community (server now logs `uncaught exception` with a stack)
- [ ] Device sync phase 2 (beyond the local network), "move session" transfer for Signal/WhatsApp tested on real accounts (the device-to-device path over the sync channel is done and tested with fake providers; real accounts, real phone and an Android UI check are still open)

## Done (recent)
- 2026-11-12: Merge chats across apps; communities as folders (move chats, own folders, single-chat communities collapse, community icon on moved chats, emptied communities disappear, messenger bubble only when pure)
- 2026-11-12: Voice messages (player, recorder, Ogg remux; WhatsApp/Matrix/Signal send), group pictures (WhatsApp, Matrix), who-reacted view, archived chats stay quiet, send-via follows the latest message and no longer reloads the chat, popups no longer close on mouse move
- 2026-11-12: Providers: Mattermost (+ custom emoji, read sync), Instagram, Discord (all fixture-tested only); Signal Groups v2 (name, picture, members, sending) and attachment sending; WhatsApp community covers via the w:g2 request
- 2026-11-12: Feature matrix in README; crash logging in the server
- 2026-11-11: Full system test on the two test chats (Signal API 26/26, WhatsApp API 24/25, mesh group 7/7, real UI 37/37)
- Earlier: archive + encryption at rest, sign-out archives, retention, search sidebar, polls, communities, profiles/privacy, contact page, avatars, rich cards, GIFs, vcf/ics, events, live location, scheduled messages, themes, bubbles, web token prompt, remote logout, notifications guard

- [ ] WhatsApp media of older GROUP messages: the CDN returns a well-formed encrypted blob (200, length ok) but decrypt fails with the stored mediaKey ("bad decrypt"), also after the phone re-uploaded the file (176 group images in 22 chats checked offline 2026-11-14; not an HKDF media-type mix-up; no duplicated keys/paths). DM images either decrypt or the CDN answers 403 (expired -> phone re-upload). Next experiment: a fresh image into a TEST group, see whether new group media decrypt; compare the stored key with the one in a live-received message. The resend queue no longer starves history/media jobs (peerWork gate + circuit breaker) and decrypt `reason` clashes are fixed (`ours` flag).

## Phone run 2026-11-14 (RZCTA04A0QJ, debug APK rebuilt and installed with -r)
- [x] App starts, embedded Node backend ready (node v18.20.4, sqljs), empty-state chat list and Settings open.
- [ ] The phone install has NO accounts (accounts dir empty), so chat list/search/filters/menus/polls/sidebar/notifications/live sending were NOT exercised; needs the user to link Signal/WhatsApp/Mattermost on the phone.
- [ ] uiautomator shows a "Connection to the backend was lost (click to dismiss)" node while not visible on screen; check it is hidden when connected.
- [ ] Phone Sync devices: multicast lock + permissions verified; "nearby devices" still empty until laptop firewall allows UDP 5353/TCP 45021; re-test then. Also device name defaults to "localhost" on the phone.
- [x] Android device name now defaults to "<Manufacturer> <Model>" (NodeRuntime sets UNIMSG_DEVICE_NAME; sync init renames a stored "localhost"). Verified on phone: "Samsung SM-A336B". WhatsApp import bundles fine (node:sqlite aliased to sql.js shim); android smoke passes (18 checks).
- [ ] Phone run (deep link): build/install/startup OK and unichat-sync://pair resolves to MainActivity (dumpsys + resolve-activity); phone locked (PIN) before the on-screen checks (deep link opening Sync devices, page texts, Scan QR camera prompt) - repeat with the phone unlocked.

## Sending through another device (2026-11-14)
- [x] Automatic relay: a mirror-only account uses an online, allowing holder (no manual click); holder allows per device (one prompt, remembered, revocable) or per account switch (default off); status "via X" / "Archive only" / "History copy" in footer, cards, Messenger menu, composer; rate limit + audit; tests (packages/sync/src/relay.test.ts, e2e relay). Fake providers and the mock UI only.
- [ ] Real run laptop + phone with a real Mattermost/Signal account: prompt appears, send/react/edit through the laptop, laptop sleep -> "Archive only", wake -> resumes.
- [x] Idempotent relayed writes (request ids, single flight, 10 min / 500 per device, persisted send references across a holder restart) and relay-aware scheduled messages (wait for the holder, 24 h late cutoff, Send now / Delete, clear failure when the holder is gone). Fake providers + mock UI only.
- [x] Full sync suite under a real Node 18 binary + sql.js: 109/109 (dht.test.ts is covered separately); android.test.ts path bug fixed.
- [ ] Real-device check of scheduled messages while the laptop sleeps (waiting card, goes out once on wake).
- [ ] Ask automatically when the user first taps the composer? (today: explicit "Ask <device>" button.)
- [ ] Phone run (HyperDHT build): hyperdht .so staged (patchelf via ~/unichat-build/pyenv), APK 195 MB has udx/sodium for arm64-v8a+x86_64, installed, backend ready; phone locked so Sync devices/Advanced UI checks and DHT load status NOT done (do not enable DHT toggle on phone without user ok).

- [ ] Instagram login (2026-11-14, probed with throwaway credentials, no real account): fixed two real bugs — Node's fetch adds `Sec-Fetch-*` headers so EVERY request got 400 'SecFetch Policy violation' (now `src/http.ts`, node:http(s)) and `/api/v1/qe/sync/` is 404 (the key headers now come from GET /api/v1/accounts/login/). Still blocked: the login answers `needs_upgrade` ('version of Instagram is out of date') for every spoofed app version tried (275 … 450; version codes guessed). Needs a current app version + version code (+ possibly bloks id / device fingerprint / signature key) taken from a real recent APK; cat-and-mouse and untestable without a real account. Decide whether to keep the integration.

- [ ] HyperDHT is now ON by default (2026-11-15). Still unverified: arm64 add-on loading on the real phone, real NAT traversal, battery/memory cost with the DHT always on; consider telling users in the pairing flow.

- [ ] Android bridge watchdog / keep-alive / network changes (2026-11-15): see apps/android/README.md "Backend watchdog...". Needs the real phone: process restart via alarm + START_STICKY, battery-exemption dialog, NetworkMonitor on a real Wi-Fi switch (home -> university), wildcard listener on the new IP, multicast lock with screen off, overnight Doze. Not done: DHT mutable `put/get` address record (a peer can learn addresses only through a DHT *session*: the members/`addrs` frames; mutable records need an extra signed+encrypted format and are untested on the testnet), LAN probe for known peers when saved addresses fail (the DHT is the fallback), WifiLock.

## Auto-update (2026-11-15)
- [x] Updater service + RPCs, manifest `latest.json`, desktop AppImage swap, Android APK handoff, UI (About > Updates, banner), tests (core 20, desktop 7, e2e 8) against a fake GitHub only.
- [ ] Needs the first real release: private-repo token flow, asset redirect to the real CDN, real AppImage replacement + relaunch, real Android install (keystore secret must be set, versionCode 1000+run), .deb hint text.
- [ ] Android native side does not report `metered` yet (`$network {metered}`), so background checks are not paused on mobile data.
- [ ] Consider checksum-signing the manifest (today trust = repo write access + TLS); Windows/macOS assets.

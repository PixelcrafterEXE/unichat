# @unimsg/provider-threema-md - Threema as a linked device (multi-device protocol)

Provider name `threema-md`, display name "Threema (linked device)". UniChat becomes an **additional device of your PERSONAL Threema ID**, exactly
like Threema Desktop 2.0: it sends and receives as you, needs no Gateway credits, no callback URL and no server of ours. (The Gateway based provider
`packages/provider-threema` is unrelated and unchanged.)

> **UNOFFICIAL and UNTESTED AGAINST THREEMA.** The protocol layers were re-implemented from public documentation and verified only against fake
> servers written in this package (all on 127.0.0.1). No byte of this code has ever talked to a Threema server. Read "Risks" and the live test plan
> before linking a real account. Research notes with sources and `[V]erified / [M]emory / [?]unknown` tags: `Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes)`.

## What it does

| Area | State |
|---|---|
| Link (QR, "request to join"), emoji check, essential data import (identity + key, contacts, groups, settings, own nickname, avatars) | implemented, fixture-tested |
| Mediator (D2M): handshake, device info, reflect/reflected + acks, ledger resume, transactions, leader promotion, reconnect with linear backoff, no-reconnect close codes, device drop | implemented, fixture-tested |
| Receive (reflected from the phone): text, quotes, files/images/voice/video (blob mirror download + decrypt), locations, polls + votes + close, delivery receipts (per-recipient `receipt` events), reactions (new + legacy thumbs), edits, deletes, typing, group messages | implemented, fixture-tested |
| Contacts/groups/settings sync (reflected `ContactSync`, `GroupSync`, `UserProfileSync`, `SettingsSync`) | implemented (create/update/delete, names, members, block list, read receipt/typing policy) |
| **Leader mode** (phone offline, mediator promotes UniChat): CSP login, `unblock`, decrypt, reflect, ack, automatic delivery receipts, implicit contacts, group-setup/-name/-leave | implemented, fixture-tested; **highest-risk part**, see below |
| Send: text (6000 byte limit), replies (`> quote #id` format), files/images (blob mirror upload), locations, polls + votes, reactions, edit, delete, typing, read receipts (`markRead`), `startChat` by Threema ID (directory lookup) | implemented, fixture-tested |
| Own profile nickname, block/unblock | implemented, fixture-tested |
| **Groups you create**: create (directory lookup, reflected `GroupSync` create, `group-setup` + `group-name` to every member), rename, add / remove members (setup to old + new, empty setup to the removed person), leave (member: `group-leave` to creator + members; creator: dissolves with an empty setup), answering a member's `group-sync-request` while leading. Groups made by others cannot be changed (only the creator may), they can be left | implemented, fixture-tested; protocol from docs, **never run against Threema** |
| @mentions in groups: sent as `@[IDENTITY]`, received `@[IDENTITY]` / `@[@@@@@@@@]` shown as `@Name` / `@All` | implemented, fixture-tested |
| Privacy: read receipts and typing indicator (reflected `SettingsSync` update, the phone follows) | implemented, fixture-tested |
| Unlink: drops this device's slot (transaction DROP_DEVICE), wipes local state first | implemented, fixture-tested |
| Revoked/removed on the phone (close 4113 / slot state mismatch 4115) -> `needs-login` | implemented, fixture-tested |
| Message history | none (Threema has no server history): UniChat's own archive only; messages reflected while UniChat was offline arrive once with `historical: true` |

Capabilities declared (and implemented): reactions, edits, deletes, replies, attachments, typing, readReceipts, markRead, startChat, e2ee, location, polls (+vote), block, avatars,
profile.displayName, createGroup, manageMembers, leaveChat, renameChat, mentions, privacy. **Not** declared (not implemented): chatPicture, chatDescription (Threema groups have none), voiceNotes (sending), contactCards, sync, requests, events.

## Honest verification table

| Item | Source of truth | Status |
|---|---|---|
| BLAKE2b with key/salt/personal; DGK tree; rendezvous keys (STK/RPH/RIDTK/RRDTK); CSP vouch; metadata key; directory response | formulas from Threema's public docs; vectors generated independently (Python hashlib + cryptography + own HSalsa20) | **self-derived vectors** (no official vectors exist), RFC 7693 + RFC 8439 vectors included |
| NaCl box/secretbox | libsodium vectors (copied from provider-threema) | verified |
| Rendezvous / join / D2M / D2D / CSP wire formats | public protocol docs (vendored in the Threema Desktop repo) | implemented from docs, **only checked against our own fake server** (same author, same reading of the docs) |
| Production endpoints, chat-server public keys, blob mirror HTTP details, directory `fetch_bulk` | constants/URLs from the public Desktop/libthreema config and client source | **unverifiable offline**; a typo or a change on Threema's side breaks it |
| Reaction/edit/delete/poll/location/file body formats | csp.struct.yml, csp-e2e.proto | implemented from docs, fixture-only |
| `threema://device-group/join#<base64url>`: unpadded base64url, accepted by the real phone apps? | docs say "URL safe Base64 (RFC 3548)" | **unknown** |
| TLS | Threema pins its servers' certificates. Node's `ws`/`fetch` use the normal trust store, **no pinning is done** | gap (weaker than official clients; the E2E layer is unaffected) |
| Forward security (Ibex) | docs say FS is off while MD is active | messages with an FS envelope are skipped with one `forward-security` error event; not decryptable |

## Protocol gaps (what is NOT done)

* No forward security (needed only if a peer sends FS envelopes to an MD identity: should not happen, see PROTOCOL-NOTES 6).
* No history exchange protocol (`md-d2d-history`): UniChat starts with an empty archive; only messages from now on (plus the mediator's reflection queue for this slot).
* Group management is creator-only and has no group picture upload; no own profile picture change, no distribution lists, no calls, no group calls, no Threema Work/OnPrem, no legacy audio/video message types (legacy images are supported), no thumbnails when sending files.
* No mediator TLS pinning; no "unblock incoming messages" retry if the leader role is promoted again mid-session beyond the first.
* Contact cards, voice-note sending, the "block unknown contacts" policy and `sync()` are not offered.
* Leader mode answers group syncs for setup/name/leave of other people's groups and `group-sync-request` for groups UniChat created; periodic group re-sync (creator duty) is not implemented. Sent control messages are not reflected as outgoing messages (assumption: only the `GroupSync` record is).

## Risks (read this)

1. **Terms of use.** Threema's terms: only approved clients (§4.2), no automated access (§5.5); authorisation may be revoked without notice (§6.3). A linked UniChat is an unapproved client. The login form shows this and requires a checkbox.
2. **Device slot.** UniChat occupies one of the (server-defined, typically three) device slots, shown as "UniChat" under *Threema > Settings > Linked Devices*. Remove it there at any time.
3. **Your identity key leaves your phone.** The join protocol hands the permanent secret key of your Threema ID to the new device (the new device logs into Threema's chat server itself). It is stored sealed (AES-256-GCM, 0600 files, key from `UNIMSG_THREEMA_MD_KEY` or a random key file next to it), but anyone who can read the whole account directory owns your Threema identity. Back it up like a password.
4. **Possible damage if the implementation is wrong.** The device group is shared state. Bugs in leader mode or in transactions could, in the worst case, lose or duplicate messages (UniChat acks messages to the server only after reflecting them), desynchronise contacts/groups/settings, or get the device dropped. UniChat never writes group/contact data except what the protocol requires for the actions you take (new contact, group setup received as leader, block list, nickname).
5. **Leader duty.** If your phone is offline when UniChat connects, the mediator makes UniChat the leader: it then fetches, decrypts and acknowledges your incoming messages. If UniChat mishandles one, it is acknowledged and lost for the phone too. Use a spare ID first.
6. The unofficial protocol re-implementation can break whenever Threema changes anything.

## How to unlink

* In UniChat: *Sign out* of the account (drops the slot on Threema's mediator, then wipes local data).
* From the phone: *Settings > Linked Devices > UniChat > Remove*. UniChat notices (close code 4113 / 4115), wipes its session and asks you to link again.
* If UniChat was uninstalled or its data deleted, remove "UniChat" on the phone the same way. If a linking attempt crashed after the slot was created, the phone also lists it.

## Configuration

| Env | Purpose |
|---|---|
| `UNIMSG_THREEMA_MD_KEY` | sealing key for the session/state files (else a 0600 key file `threema-md.key` in the account dir) |
| `UNIMSG_DEBUG=1` | debug lines on stderr (states/counts only: no ids, names, keys, texts, URLs) |
| `UNIMSG_THREEMA_MD_RENDEZVOUS` / `_MEDIATOR` / `_BLOB` / `_DIRECTORY` / `_CSP_KEY` | endpoint overrides for the offline tests; **honoured only for loopback hosts** (`127.0.0.1`, `localhost`, `[::1]`) |
| `UNIMSG_THREEMA_MD_RETRY_MS`, `_MAX_RETRIES`, `_PACE_MS`, `_BLOCK_MS`, `_JOIN_TTL_MS` | backoff base (5 s, linear), retry limit (8, then `disconnected`), spacing of HTTP requests (400 ms), block after HTTP 429 (10 s), QR validity (4 min) |

Files in the account dir (all 0600): `threema-md-session.json` (sealed: identity, key, DGK, device ids), `threema-md-state.json` (sealed: contacts, groups, caches), `threema-md-nonces.json` (sealed: replay protection), `threema-md.key`.
Note: like Threema/Teams, the sealing key lives outside the sealed file, so account export/backup needs the same hook the other providers have (not wired here).

## Tests

`pnpm --filter @unimsg/provider-threema-md test` (47 tests, ~25 s, fully offline) and `typecheck`.
`src/fake/servers.ts` = fake rendezvous relay, mediator with embedded chat server (CSP handshake, queues, acks, transactions, drops, leader election, device slots), blob mirror + directory (HTTP, incl. 429);
`src/fake/phone.ts` = the existing device (QR scan, emoji, essential data, then reflecting like a leader). Covered: join, same emoji on both sides, declined join, slot limit, reflect receive (all types),
send (reflect-then-CSP order, per-receiver encryption, group, attachments), leader mode, replay protection, ledger resume, reconnect, revoked (4113/4115), no-auto-reconnect codes, logout, startChat + rate limit,
secrets (`secrets.test.ts`, UNIMSG_DEBUG=1), protocol too new, unfinished earlier link, transaction contention.

## SAFE LIVE TEST PLAN (do this in order; stop at the first surprise)

0. **Preparation.** Use a **throwaway second Threema ID on a second phone** (or a second ID in a second Threema install) that only talks to one test contact. If you must use your real ID: make a full **Threema Safe backup** first, tell yourself that leader mode may acknowledge messages. Do not do this while important messages are pending.
1. Keep the **phone online with Threema open** during the whole first test (the phone then leads; UniChat only follows, no leader duty).
2. Start UniChat with `UNIMSG_DEBUG=1` and a dedicated account dir. Read the warning, tick the box, click *Continue*; scan the QR with *Threema > Settings > Linked Devices > Link device*.
3. **Compare the three emoji** on the phone and in UniChat. If they differ: cancel on the phone.
4. Expected debug lines (sanitised counts only), e.g. `linked: N contacts, M groups imported`, `chat server login ok`, `reflection queue dry`. The account should show **connected**; the phone lists "UniChat".
5. **Read-only phase (10 minutes):** only receive. Have the test contact write 1:1 and in a group; check text, an image, a voice message appear in UniChat and the phone is unaffected. Do **not** send from UniChat yet.
6. **Send phase:** send one text, then one image to the test contact. Verify it arrives on the contact's phone, and that it shows as sent on your phone too (reflected).
7. Test reconnect (disable Wi-Fi 1 min), then *Sign out* in UniChat and verify "UniChat" disappeared from Linked Devices. Then link again once.
8. Only after all of this consider the real account; leader mode (phone offline) is the part to try last and only with the spare ID.
9. **What to send me (sanitised only):** the `[threema-md]` debug lines (they contain no IDs/names/keys/texts), the account state/detail strings shown in UniChat, the Threema app versions of phone and contact, and *which step* failed. **Never** send the account directory, `threema-md-*.json`, the QR/URL, emoji, Threema IDs or screenshots with names.

## Needed from the host (not done here, per instructions)

* Register the provider in `packages/host` (`@unimsg/provider-threema-md` default export; `login: "qr"`; the first prompt is a `form` with the consent checkbox + `danger` warning, then a `qr` prompt, then an info `form` showing the emoji).
* The UI must render `LoginPrompt.kind "form"` with `fields: []` (the emoji notice) without a submit button, or tolerate an unused one. Icons for threema exist.

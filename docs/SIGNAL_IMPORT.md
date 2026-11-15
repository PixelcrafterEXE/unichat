# Importing Signal chat history from a backup

Signal never sends old messages to a linked device, so UniChat's Signal archive starts at the moment of linking. This feature adds
the history from a backup made on the phone to the **local archive** of an existing, linked Signal account.
Code: `packages/core/src/signalimport/*`, UI `apps/ui/src/SignalBackupImport.tsx`, RPCs `signalBackupInspect`, `signalBackupImport`, `signalBackupCancel`.

## Supported formats
| Format | File | Key | Content | Status |
|---|---|---|---|---|
| Signal Android local backup (legacy) | `signal-YYYY-MM-DD-HH-MM-SS.backup` | 30-digit passphrase (Settings > Chats > Chat backups) | text, replies, reactions, edits, deletes, calls, **photos/videos/voice/files** | implemented, tested against a byte-compatible synthetic encoder only (no real backup was available) |
| Signal Secure Backup (2025), Android or iOS | single encrypted file (IV, AES-256-CBC, gzip, HMAC-SHA256) | 64-character backup key + the account's ACI | text, replies, reactions, edits, deletes, calls, contact cards; media: photos, videos, voice notes and files when the backup is an on-device folder with its `files/` directory (see below), otherwise `[Photo]`-style notes | implemented through libsignal (`MessageBackupKey`, `BackupJsonExporter`); the container layout is accepted by libsignal's own `validate()`; frame field names beyond those exercised by the tests are from the public Backup.proto and unverified |
| Signal iOS | only the Secure Backup form above (iOS has no legacy local backup) | | | see above |
| Signal Desktop export, `signal-cli` | not supported | | | |

The new format's *local-archive folder* variant (a directory with a `main` file and a separate `files/` tree, 2025+) is not read; only a single-file backup
whose layout libsignal's `validate()` accepts is. Media of Secure Backups lives outside that file. Imported from an on-device backup folder (layout read from Signal-Android's `LocalArchiver` and `Backup.proto`, not from a real backup):
`<root>/<snapshot>/{main,metadata,files}` plus the shared `<root>/files/<xx>/<name>`. Each attachment's `FilePointer.locatorInfo` carries `plaintextHash`, `size` and a 64-byte `localKey` (AES key || HMAC key); the file name is `hex(sha256(plaintextHash || localKey))`; the file is `IV(16) || AES-256-CBC(zero-padded plaintext) || HMAC-SHA256(IV||ciphertext)`. UniChat checks the MAC, cuts to `size` and checks `plaintextHash`; anything that fails counts as "missing" and the message keeps its `[Photo]` placeholder. The snapshot's `files` file is only a name index and is not read. `mediaRootBackupKey`/`deriveMediaId`/`deriveMediaEncryptionKey` belong to the remote (CDN) media tier and are not used for local backups.
Verified against a real on-device backup (2026-11-14, 26,048 messages, 82 chats, 2,159 attachments / 1.78 GB): the JSON field names, `files/` next to the snapshot folder, the MAC + plaintextHash checks. 2,113 attachments were decrypted and stored (46 were not in the backup; they keep their placeholder); a decrypted image is a valid JPEG; a second import adds nothing (idempotent).

## What the importer does
1. **Authenticate**: every MAC of the file is verified (pass 1) before anything is written. Wrong passphrase, damaged or cut-off files give plain-language errors.
2. **Interpret, never execute**: legacy backups carry SQL statements. They are tokenised by `sql.ts`; only `CREATE TABLE` (column order) and `INSERT ... VALUES` (bound parameters) are understood, everything else is ignored.
   Positional inserts need the `CREATE TABLE` statements of the backup (the real exporter writes them); without them the file is refused with a clear message.
3. **Map** rows to UniChat messages (see below), streamed row by row (memory is independent of file size; only the small tables are kept: recipients, threads, groups, parts, reactions).
4. **Write in ONE store transaction** with the existing archive rules: never overwrite or delete, only missing fields are filled (text, attachments, reply, contacts, card, reactions union, status).
   Cancel or any error rolls the archive back and removes media written meanwhile. Writes by the running app during the import join that transaction (same caveat as the backup importer): keep imports short, do them while idle.
5. Then `reload()` rebuilds the search index and chat lists; imported messages never touch unread counters, notifications or mesh relays (they do not go through the live event path).

## Mapping decisions
- **Ids** are the live provider's: `messageId = "<author ACI>.<sent timestamp ms>"`, chats are the ACI uuid (1:1) or `g.<base64url(groupId)>` (v2 groups). A message that also arrived live is therefore the same row and is not duplicated.
  An edited message keeps the id of its first revision (`editedAt` = time of the last edit).
- **Direction**: type bitfield base type (20 incoming; 21-26 outgoing; calls 1/2/3/8/10/11/12) or the `from_recipient_id` of the own recipient. Delivery/read receipt counters become `status`.
- **Sender**: recipient -> ACI; phone-only contacts (no ACI in the backup) are resolved through the connector's known contacts (`Connector.importIdentity().numberToAci`), otherwise imported as separate chats `e164:+…`.
- **Skipped as noise**: drafts, "joined Signal", profile/number changes, safety-number and key-exchange rows, group updates, end-session, stories, old v1/MMS groups (dead). **Kept as `system: info`**: calls, disappearing-message timer changes.
- **Attachments**: bytes are stored in the sealed media cache under `"<chatId>|<messageId>|<messageId>#<n>"` (the live id scheme), so the normal `attachment` RPC serves them offline. Voice notes, GIFs, stickers keep their flags. View-once media is not kept (Signal deletes it on the phone too); its placeholder text is.
- **Chat list**: chats the provider has no record for are kept in the setting `signalImport.chats.<accountId>` and merged by `Hub.collect()` (`withImportedChats`); a chat the provider knows wins. Imported groups are listed and readable; sending into a group works once the provider has the group (first live message).
- **Account check**: the backup's own ACI (KeyValue/preference frames) must match the chosen account, else the user must confirm; a signed-out account cannot be verified and needs a confirmation as well.

## Security
The passphrase / backup key exists only in the RPC parameters and the key-derivation call: it is never stored, logged or put in an event. Derived keys are zeroed after use where possible; decrypted rows live in memory only
until written to the sealed archive (AES-256-GCM at rest like all archive data). No plaintext temp files are created. Uploaded files (browser) are removed through `backupDiscard` after the import.

## On the Android app: "Find the backup on this phone"
Same mechanism as the WhatsApp import (docs/WHATSAPP_IMPORT.md, Storage Access Framework folder picker, `$backupLocate` / `$backupCopy`): one tap opens the system folder picker (hint: `primary:Signal`); the user picks the folder Signal writes its on-device backups to (Android 11+: Signal lets you choose it, there is no fixed default path; typically `Signal/Backups`, or the folder shown in Signal > Settings > Chats > Chat backups). UniChat lists `signal-*.backup` (and `*.binary` secure-backup files), newest first, streams the chosen one into `<data>/.backup/saf/signal/` and the usual passphrase / backup-key step follows; the copy is removed after the import. No media step (Signal backups are single files).
**Not verified on a phone:** Signal is not installed on the test phone and no `.backup` file existed there, so only the shared mechanism (verified with WhatsApp's folder) and the mock e2e cover this path. Whether the picker can open Signal's chosen folder depends on where the user put it (anything outside `Android/data` and `Android/obb` should work).

## Known unknowns
- Tables/columns for Signal versions before ~2020 (no `recipient` table) and database versions I could not inspect are not supported; the importer refuses instead of guessing.
- Header `version` fields of future legacy layouts are rejected as unsupported.
- Reaction/mention/quote details follow the public Signal-Android schema as remembered; unknown columns are ignored, missing ones mean "not available".

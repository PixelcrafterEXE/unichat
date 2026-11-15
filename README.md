# UniChat

One app for WhatsApp, Signal, Matrix, Mattermost, Instagram and Discord (more messengers plug in the same way): a Discord-style UI with a rail of communities,
personal chats, polls, reactions, attachments, locations, contact cards, mesh groups that span platforms, a local encrypted
message archive, and read-only archives for accounts you signed out of.

## Run it

```
pnpm install                         # needs pnpm >= 11 and Node >= 22.13
pnpm --filter @unimsg/server dev     # backend on ws://127.0.0.1:8765/ws  (data in ~/.config/unimsg)
pnpm --filter @unimsg/ui dev         # UI on http://localhost:5173
```
Open http://localhost:5173, click **+** → *Add an account*. Add `?mock` to the URL to try the UI with fake data and no accounts.

Environment (backend): `UNIMSG_DATA` (data dir), `HOST`/`PORT`, `UNIMSG_TOKEN` (required when HOST is not loopback),
`UNIMSG_ALLOWED_ORIGINS` (hosted UI origins), `UNIMSG_DB_KEY` (32-byte archive key, hex/base64; otherwise a 0600 key file is
created next to the data), `UNIMSG_DEBUG=1` (counts-only provider diagnostics on stderr).

## Check it

```
pnpm -r typecheck
pnpm --filter @unimsg/core test  &&  pnpm --filter @unimsg/store-sqlite test
pnpm --filter @unimsg/provider-whatsapp test  # likewise provider-signal, provider-matrix
```
The pnpm workspace sets `blockExoticSubdeps: false` because Baileys (WhatsApp) depends on a git-hosted `libsignal-node` fork.
Build scripts (Electron download, esbuild, protobufjs) are skipped by pnpm 11+; the web UI and server do not need them.

## Feature matrix (as of 2026-11-12)

How to read it:

| Rating | Meaning |
|---|---|
| ✅ Verified | Seen working against the **real service** in this project: my live test run on the two test chats (2026-11-11, WhatsApp "Whatsapp-o-mat" and Signal "Signal-o-mat"), or you saw it working in daily use. |
| 🧪 Untested | Implemented and covered by unit tests or a fake server, but **not yet run against the real service**. Expect small bugs. |
| 🛠️ Unimplemented | The messenger offers it, but UniChat does not do it yet. |
| ⛔ Unsupported | The messenger itself has no such feature (or no way for a third-party client to use it). |

| Feature | WhatsApp | Signal | Matrix | Mattermost | Instagram | Discord | Teams | Threema |
|---|---|---|---|---|---|---|---|---|
| **Messages** | | | | | | | | |
| Receive text | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Send text | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Live updates (realtime) | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Older history from the service | ✅ Verified | ⛔ Unsupported | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | ⛔ Unsupported |
| Fetch chat history in bulk (Settings > Storage & downloads, `Capabilities.fetchHistory`) | 🛠️ Unimplemented | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | 🛠️ Unimplemented | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Import old history from a local phone backup (account card > Import chat history; docs/WHATSAPP_IMPORT.md, docs/SIGNAL_IMPORT.md) | 🧪 Untested (msgstore.db.crypt15 / crypt14 + Media folder; format implemented from the wa-crypt-tools spec, fixture-tested only, never run on a real backup) | ✅ Verified (Secure Backup on-device folder incl. media; legacy .backup fixture-tested only) | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported |
| Full-text search of the local archive (SQLite FTS5, operators, snippets) | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Replies / quotes | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Reactions (send + show) | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Pin messages (pin / unpin, pinned bar, list) | 🧪 Untested (fake only: Baileys `pinInChatMessage`, 24 h / 7 d / 30 d) | 🧪 Untested (fake only: `DataMessage.pinMessage`, incl. until-removed) | 🧪 Untested (fake only: `m.room.pinned_events`) | 🧪 Untested (fake only) | ⛔ Unsupported | 🧪 Untested (fake only) | 🧪 Untested (fake only: chats, not channels) | ⛔ Unsupported |
| Edit own message | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🛠️ Unimplemented | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Delete own message for everyone | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Typing indicators | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested |
| Online status (presence): green dot, "online" / "last seen" for 1:1 contacts | 🧪 Untested (see note) | ⛔ Unsupported (by messenger) | 🧪 Untested (fake server only) | 🧪 Untested (fake server only) | 🛠️ Unimplemented | 🧪 Untested (user accounts only; bots get none) | ⛔ Unsupported | ⛔ Unsupported |
| Chat list filters: Unread / Messenger / Type (personal, groups, community channels) | ✅ UniChat feature, works for every messenger (mock-tested) | ✅ | ✅ | ✅ | ✅ | ✅ | 🧪 Untested | 🧪 Untested |
| "Online" filter (only 1:1 chats whose contact is online) | needs presence | ⛔ Unsupported (by messenger) | needs presence | needs presence | 🛠️ Unimplemented | needs presence | ⛔ Unsupported | ⛔ Unsupported |
| Read receipts (see who read) | ✅ Verified | ✅ Verified | ✅ Verified | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested |
| Mark chat read on the service | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Custom emoji / animated emoji | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported |
| @mentions when sending | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Link previews when sending | 🧪 Untested | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported |
| Disappearing / view-once messages | 🛠️ Unimplemented | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported | 🛠️ Unimplemented | ⛔ Unsupported | ⛔ Unsupported | 🛠️ Unimplemented |
| **Media** | | | | | | | | |
| Receive images, video, files | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Send images, video, files | ✅ Verified | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Play voice messages | ✅ Verified | 🧪 Untested | ✅ Verified | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🛠️ Unimplemented |
| Send voice messages | 🧪 Untested | 🧪 Untested | ✅ Verified | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🛠️ Unimplemented |
| GIFs | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | ⛔ Unsupported |
| Stickers (receive) | 🧪 Untested | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested |
| **Rich content** | | | | | | | | |
| Polls: show and vote | 🧪 Untested | ✅ Verified | ✅ Verified | ⛔ Unsupported | 🛠️ Unimplemented | 🧪 Untested | ⛔ Unsupported | 🧪 Untested |
| Location sharing | 🧪 Untested | ⛔ Unsupported | ✅ Verified | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested |
| Contact cards (vCard) | 🧪 Untested | ✅ Verified | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported |
| Events / calendar invites | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported |
| Voice and video calls | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented | 🛠️ Unimplemented |
| **Groups and communities** | | | | | | | | |
| Group chats: receive | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Group chats: send | ✅ Verified | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Group name and picture shown | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Create a group | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Add / remove members | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Rename a group | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Change group description | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported |
| Change group picture | 🧪 Untested | 🧪 Untested | ✅ Verified | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported |
| Leave a group | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Communities / spaces / servers: show | ✅ Verified | ⛔ Unsupported | ✅ Verified | ✅ Verified | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported |
| Create / join / leave a community | 🧪 Untested | ⛔ Unsupported | ✅ Verified | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | 🛠️ Unimplemented | ⛔ Unsupported |
| **Account** | | | | | | | | |
| Link / log in | ✅ Verified | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Remove account and sign out remotely | ✅ Verified | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Profile pictures of people and chats | ✅ Verified | 🧪 Fake-verified (DM + group pictures, fake servers only) | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Edit own profile (name, about, picture) | 🧪 Untested | 🧪 Untested | ✅ Verified | 🧪 Untested | ⛔ Unsupported | 🧪 Untested | 🛠️ Unimplemented | 🛠️ Unimplemented |
| Identity verification: emoji comparison with another device or a person, incoming requests, cross-signing + recovery-key set-up, "verify with recovery key" (Settings > Accounts, contact panel) | ⛔ Unsupported | ⛔ Unsupported | 🧪 Fake-verified (fake SDK objects + mock UI only, no real homeserver or second device) | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported |
| Privacy settings | 🧪 Untested | 🧪 Untested | ✅ Verified | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested |
| Start a chat with a new contact | 🧪 Untested | ✅ Verified | ✅ Verified | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested | 🧪 Untested |
| Block a contact | 🧪 Untested | 🧪 Untested | ✅ Verified | ⛔ Unsupported | 🧪 Untested | 🧪 Untested | ⛔ Unsupported | 🧪 Untested |
| Message requests inbox | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported |
| End-to-end encrypted by the messenger | ✅ Verified | ✅ Verified | ✅ Verified | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | ⛔ Unsupported | 🧪 Untested |

Notes, because one cell cannot say everything:

- **Matrix** was verified against a throwaway local Synapse 1.165.0 (25-step suite in `packages/provider-matrix/lab`): that counts as Verified for the rows marked so, but federation, single sign-on and Element-produced events are untested. The new verification dialogs (emoji comparison, set-up, recovery key) are only fake-verified: unit tests with fake SDK objects and UI tests against the mock, never against a real homeserver or a second device. **Instagram** and **Discord** were written against fake servers only; the Instagram and Discord (user-token) modes use unofficial APIs that violate the services' terms (see their READMEs for the risks). **Mattermost** has run live against one server, but only reading, history and display are Verified; sending and the recent fixes (read status sync, custom emoji) are Untested.
- **WhatsApp polls:** votes cast on the phone show up in UniChat (Verified), but votes cast from UniChat do not reach the phone reliably yet, so the cell is Untested (2026-11-14: single/multiple-choice detection, the explicit poll secret on creation and vote replacement were reworked and unit-tested only). **WhatsApp media download-all** now asks the phone to re-upload expired files (`updateMediaMessage`) and the job reports failures per reason; **WhatsApp online status** and on-demand older history from the phone while scrolling are Untested. **WhatsApp communities:** the list and most covers work (live probe); two communities return "no picture" from WhatsApp.
- **WhatsApp voice / GIFs / contact cards / locations** are implemented and unit-tested; sending voice, contact cards and locations has not been confirmed on a phone. **Signal** attachment and voice-message sending, Signal group sending (fan-out to each member) and group name/picture were built from the protocol without a live send check (group name and picture did resolve on a live run). Signal cannot fetch old history (a linked device only receives new messages), so UniChat keeps its own archive.
- **Edit on Instagram** is marked Unimplemented from the API knowledge available when it was written; Instagram has been adding edit and polls for DMs, so verify before relying on it.
- **Read receipts on Mattermost and Discord** do not exist per message. Both can still mark a chat as read on the service, which is a separate row (Mattermost's was fixed after you reported read status not syncing, and is Untested).
- **Presence** (`Capabilities.presence`, `Connector.setPresenceEnabled`, core event `presence`): kept in memory only, never archived, shown as a green dot on 1:1 avatars (list, header, member list, contact panel) and as "online" / "last seen ..." text. Settings > Privacy > "Show who is online" (default on) turns the whole thing off: connectors stop asking, events are dropped. UniChat never announces your own status. Matrix: passes on `m.presence` of people you have a 1:1 room with and asks `GET /presence/{user}/status` for at most 40 such peers every 5 minutes (sequential, stops after 3 refusals; many homeservers, matrix.org among them, disable presence, then nothing is shown). Mattermost: one `POST /users/status/ids` per minute for the peers of your direct messages. Discord: user accounts only (friends' `PRESENCE_UPDATE`, only for people you have a DM with; online/idle/dnd = online, offline/invisible = offline; the READY_SUPPLEMENTAL initial list is a hypothesis); bots would need the privileged GUILD_PRESENCES intent, so they report none. Signal has no presence at all. Instagram, Teams, Threema: not implemented. WhatsApp: see its provider.
- **Chat list filters** (bar above the list; local, remembered in the UI settings, combine with AND): *Unread* (chats with unread messages; muted ones only with "+ muted"), *Messenger* (pick one or more accounts), *Type* (all / personal chats / groups / community channels = chats that live in a community or folder), *Online* (only shown when a connected account supports presence). They apply to every view (Personal, communities, folders): a rail icon whose view has no matching chat is dimmed but still clickable, and an empty list offers "Clear filters". A merged chat matches Messenger / Online if any member does. The "Find a chat" search is independent: while it has text the filters are not applied. A badge on the clear button shows how many filters are active.
- **Full-text search** works on whatever is in the local archive, whatever the messenger. It is a local feature, tested only against synthetic archives and the mock UI (core unit tests, a 500k-message performance run, UI e2e): never run on a real archive yet, hence Untested everywhere. Query syntax: words (prefix match, any case/accents), `"exact phrase"`, `-exclude`, `from:` `in:` `has:image|video|file|voice|link|poll` `after:` `before:`; results are ranked, grouped by chat with highlighted snippets; chat and contact names are matched too. The index is SQLite FTS5 held **in memory only** (rebuilt from the sealed archive at every start, never written to disk); where `node:sqlite`/FTS5 is missing (Android's embedded Node) the same interface falls back to an in-memory scan with identical results. Startup cost on a synthetic 500k-message sealed archive: see `packages/store-sqlite/src/search.perf.ts` (mostly decrypting the archive, not indexing). Languages without spaces (Chinese, Japanese) are matched by whole run of characters from its start only (unicode61 tokenizer).
- **Fetch chat history** (Settings > Storage & downloads, per account, optionally selected chats; last 30 days / 1 year / everything): pages backwards through the provider's `history()` into the archive with a per-messenger pause (Discord about 1 request/s), progress, cancel, resume after a restart, and a summary with failures counted per reason. Offered only where `Capabilities.fetchHistory` is true: Discord, Matrix, Mattermost. Tested against fake connectors only. WhatsApp: its `history()` asks the phone on demand, but the capability stays off until the WhatsApp provider declares it; Instagram is left off on purpose (unofficial API, ban risk).
- **Not per messenger (work for all of them):** mesh groups across platforms, merged chats, folders, the encrypted local archive and read-only archives of signed-out accounts, search, scheduled messages, themes and notifications. Those are tested in UniChat itself, not against a particular messenger.
- This table is meant to be kept current: when a cell is confirmed on a real account, change it to Verified.

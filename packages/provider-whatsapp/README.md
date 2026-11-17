# @unimsg/provider-whatsapp

WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys` **6.7.24**, pinned; npm `legacy` tag,
the last stable line). 7.0.0 is still `-rc` (breaking: LID-first addressing, rust bridge) and is not used yet. Unofficial protocol:
accounts can be banned and WhatsApp can break the library at any time.

## Design
- **Login:** QR. Emits `login` prompt `kind:"qr"`, stable `promptId` `whatsapp-qr` (refreshes replace it), account state `needs-login`.
  After scan WhatsApp forces a restart (code 515), handled with an immediate reconnect; `connected` closes the prompt.
- **Session:** Baileys multi-file auth state in `<dataDir>/auth/`. Local cache in `<dataDir>/unimsg-whatsapp.json` (mode 0600).
- **Reconnect:** exponential backoff with jitter (1s..60s). `loggedOut` (401) wipes data, reports `needs-login` and starts a fresh QR.
  `connectionReplaced` (440) and `forbidden` (403) are fatal errors and are not retried.
- **Spaces/chats:** Communities -> Spaces. Groups linked to a community (incl. the announcement group) -> `kind:"channel"` with `spaceId`;
  announcement/admin-only groups are `readOnly` unless we are admin. Other groups -> `group`, 1:1 -> `dm`.
  Baileys has no chat-list API, so chats/contacts/names are learned from history sync + events and cached locally.
  Status, broadcast lists and newsletters are ignored.
- **Ids:** chat id = remote JID without device suffix. LID JIDs are mapped to phone-number JIDs when a mapping is known
  (from `sender_pn`/`participant_pn`, contacts, `chats.phoneNumberShare`, `onWhatsApp`); otherwise the LID is used. `senderId` likewise.
- **Messages:** text, media (image/video/audio/voice/file/sticker; one attachment per WhatsApp message, id `a0`), replies, edits,
  revokes, reactions, receipts (sent/delivered/read; per-participant `byId` in groups), typing (presence; DM presence is subscribed
  when `history()` is called for the chat). Contacts/locations/polls/etc. become placeholder texts.
- **history():** served from the local cache (max 2000 msgs/chat, ordered, `beforeMessageId` paging). When the cache is exhausted it
  does a real **on-demand history sync** (`fetchMessageHistory`, needs the phone online, waits up to 12s); hence `backfill: true`.
  Messages arriving via sync are also emitted as `message` events so the Hub persists them.
- **Own sends** are applied locally (`emitOwnEvents:false`) and also emit `message-update` for edit/delete/react.
- **Attachments:** media keys/URLs are cached per message. `downloadAttachment` downloads from the CDN; on 404/410/403 (expired copy) it
  sends `sock.updateMediaMessage` (media-retry request to the phone, one at a time, 30s limit), stores the fresh `directPath`/`url` and retries once.
  Failures carry a `reason` (`not-cached`, `no-media-key`, `no-media-path`, `expired`, `offline`, `phone-offline`, `disk-full`, `network`, `bad-media`, `error`);
  the Hub media job counts them per reason (`MediaProgress.reasons`, shown in Storage & downloads). History-sync placeholders have no media key at all (`no-media-key`).
- Baileys' logger is silenced; errors surface only as `{type:"error"}` with codes and status numbers, never content.

## Group management
`leaveChat` (groupLeave), `addMembers` (handles resolved via `onWhatsApp`, then add), `removeMember`, `renameChat` (groupUpdateSubject)
work for **groups only**; for DMs they reject with a clear error (WhatsApp has no "leave" for a 1:1 chat; the Hub should just hide it locally).
`addMembers` throws a summary such as "added 1 of 2: 1 not on WhatsApp" listing only status reasons, never numbers; `removeMember`
resolves the participant id as the group addresses it (may be a LID). `blockChat` uses `updateBlockStatus` on the DM peer; `Chat.blocked`
comes from the block list fetched on connect and kept current via `blocklist.set/update`.

## Communities
`createSpace` = `communityCreate` (+ `communityMetadata`), then communities and groups are re-synced so the announcement group appears as a
read-only channel. `joinSpace` accepts a `chat.whatsapp.com` link or bare code; it checks `communityGetInviteInfo`, and if the invite is a plain
group it throws "this invite is a group, not a community" (it does not join it). Communities needing admin approval throw "join request sent".

## History, names, avatars, diagnostics
- **Device name:** `browser = ["UniChat", "Desktop", "1.0.0"]` -> the phone lists the linked device as "UniChat" (platform DESKTOP).
  `syncFullHistory: true` is on; with this browser the socket stays open (checked 3x20s against a throwaway dir: QR arrives, no drops).
  The earlier 1006 drop came from `Browsers.macOS("Desktop")` combined with that flag.
- **Why there used to be no messages/contacts:** Baileys 6.7.24 defaults `shouldSyncHistoryMessage` to `() => syncFullHistory`; with the flag
  off it skipped the initial history, push names, on-demand history AND the app-state sync (saved contact names). We now pass an explicit
  `shouldSyncHistoryMessage` (always for ON_DEMAND/PUSH_NAME; for the initial types only within 15 min of a new link, so ordinary
  reconnects are not held back by Baileys' 20s sync buffering). Store writes are debounced to 1s and flushed on every history set.
- **WhatsApp delivers the initial history only once, at link time.** An already-linked session that never received it must be removed and
  linked again to import history. Older messages can then be pulled per chat via `history()` (on-demand sync, needs the phone online);
  it anchors on the oldest stored message, else on the chat's last message from the chat list, else returns `[]`.
- **Names:** saved contact name (contacts / app-state `contactAction`) > push name > verified business name > formatted phone number >
  "WhatsApp user" (unmapped @lid); never a raw jid. Unnamed groups get their metadata fetched lazily (2 concurrent, 700ms spacing,
  once per session) and fall back to their first members' names. 22s after connect an app-state resync pulls saved contact names; `sync()` repeats it.
- **Avatars:** `avatar({kind,id})` = `profilePictureUrl(jid,'preview')` + server-side fetch; cached under `<dataDir>/avatars` (7 days,
  "no picture" 1 day), max 2 lookups at once; transient failures are not cached; no remote URLs are put into Chat/Space.
- **Debug:** `UNIMSG_DEBUG=1` prints counts-only lines to stderr (`[wa] history-set type=RECENT chats=.. contacts=.. messages=.. stored=..`,
  `contacts.upsert n=..`, scrubbed Baileys sync/state log messages). No names, numbers or text.

## Chat list, LID/PN identity, names (v0.3)
- `chats()` returns only conversations: chats with at least one stored message, groups/communities we are still a member of (live group
  fetch; leaving/removal clears the flag), and chats created via `startChat`/`createGroup`. Address-book stubs stay in the cache for name lookups.
- A person can appear as `<n>@lid` or `<n>@s.whatsapp.net`. Mappings come from group participants (`lid` + `jid`), conversation
  `pnJid`/`lidJid`, contacts, `sender_pn`/`participant_pn` on message keys, and `onWhatsApp`. Baileys 6.7.24 has no lid->pn lookup API.
  As soon as a mapping is learned (and on every start) everything keyed by the LID (names, chat, messages, unread, history anchor) is merged
  into the phone-number chat, and name lookups try both ids. Note: messages already emitted to the Hub under the LID chat id stay there.
- Names: saved contact > push name (recorded from every incoming message, live or history, under both ids) > verified > formatted number >
  "WhatsApp user". `Message.sender` is a snapshot, so earlier messages keep the old label; `chats()`/`members()` use the new names.
- Baileys 6.7.24 drops `contactAction.pnJid` and `firstName`, so contacts without a `fullName` cannot be named from app-state sync.
- Communities: in 6.7.24 the "participating" query returns communities inside the *groups* node (`isCommunity`), so `groups fetched ...
  communities=N` counts them while `communityFetchAllParticipating` (a separate node) is usually empty. Spaces are replaced by the live list on
  each connect; sub-groups carry `spaceId` from `linkedParent`. `leaveSpace` = `communityLeave` and drops the community's chats locally.

## Polls
Receive: `pollCreationMessage` V1-V3 -> `Message.poll` (option id = sha256 hex of the option text; multiple = selectableCount != 1). Baileys
6.7.24 does not decrypt votes (that code is commented out), so `poll.ts` decrypts `pollUpdateMessage` itself with the poll's stored
`messageSecret` (trying phone-number and LID forms of creator/voter), keeps per-voter selections (newest wins), and emits
`message-update {poll}`. Send: `{poll: {name, values, selectableCount}}` (0 = any number). `vote()` encrypts the vote with the same scheme
(round-trip tested against Baileys' `decryptPollVote`) and relays a `pollUpdateMessage` with `<meta polltype="vote">`; this relay path is
verified live (2026-11-14, DM: UniChat->phone shows and replaces votes, phone->UniChat decrypts; the Baileys patch adds the poll `<meta>` tags and the vote keys use the LID form). Polls whose secret was never seen (e.g. missing from history) cannot be voted on or tallied.

## What a linked device can get (history)
WhatsApp pushes the initial history once, right after linking, and only for some conversations (recent ones; with `syncFullHistory` the phone
may send more, in chunks that can keep arriving for a long time; all chunks are persisted and the store flushed on each). The rest is only
reachable by on-demand sync (`fetchMessageHistory`), which needs the phone online and a real anchor message (id + timestamp). Anchors used,
in order: oldest stored message, the chat's last message from the chat list, then a *synthetic* key (random id, time just after the chat's last
activity) for chats with no message at all. The synthetic case is a guess: the phone resolves the id in its own database and probably returns
nothing; it costs one 6s wait per chat per session. Chats WhatsApp never synced and that the phone does not answer for stay empty.
After a restart the first reconnect no longer buffers events waiting for history: only Baileys' bare startup probe is gated; real chunks are always accepted.

## Avatars
`profilePictureUrl` errors are Boom objects whose `data` is the WhatsApp error code (and `output.statusCode` is always 500), so they are
classified by code/text: item-not-found/404 (tries the full-size `image` once, then caches "none" for a day), not-authorized/401/403 (privacy;
cached for a day), rate-overlimit/429 (30s global back-off, never cached), anything else/timeouts (never cached). An empty answer without an error
is cached for only one hour. Each lookup has a hard 8s limit; 2 lookups at a time, 150ms apart.

## Own profile, privacy, sender names
- `capabilities.profile = {displayName, about, avatar}`: name = `updateProfileName` (1-25 chars), about = `updateProfileStatus` (1-139 chars;
  read with `fetchStatus(own)`), picture = `updateProfilePicture(own, bytes, 640x640)` / `removeProfilePicture` (read with
  `profilePictureUrl(own,'image')`). Pictures are validated first (JPEG/PNG/WebP by magic bytes, must match the mime, 64..8192 px, <= 8 MB);
  Baileys then crops/scales them with `sharp` or `jimp`, which must be installable in the host (otherwise a clear error is returned).
  Handle = `+<phone digits>`. After a picture change the own avatar cache is dropped.
- `privacy`: last seen, online, profile picture, about, read receipts, who can add me to groups (+ "who can call me" / "who can message me" only when
  WhatsApp reports those categories), each with only the values WhatsApp accepts for it (`all`/`contacts`/`contact_blacklist`/`none`,
  `match_last_seen`, `known`). "My contacts except..." keeps the exclusion list from the phone; it cannot be edited here. The default
  disappearing-message timer is not exposed (reading it needs an extra usync query).
- Better names (contact/push/lid mapping) patch `sender` on earlier stored messages via `message-update {sender}` (changed ones only).
- `avatar({kind:'contact'})` works like chats (a LID is mapped to its phone number first, both ids are tried). Lookups share the 2-slot limiter, are
  bounded (queue of 80, 6s per lookup, an unreachable one is skipped for 60s) and keep the 30s rate-limit back-off.

## Rich content, notices, logout
- Non-text content becomes `Message.card` (+ a plain-text summary in `text`): events, group/community/channel invites, calls (call log, scheduled calls),
  lists, buttons, templates, interactive/native-flow, highly-structured messages, products, orders, payments. Locations fill `Message.location`,
  contact cards `Message.contacts`, video notes are videos. Pin notices and group/community/security "stub" messages become `system:{kind:"info"}`
  English notices (joined, left, added, removed, renamed, timer changed, ...); encryption banners, event responses and similar noise create nothing.
  Times in text are UTC. Anything unmapped reads `[unsupported message: <proto field>]` with a card `{kind:"other"}`; with `UNIMSG_DEBUG=1`
  a counts-only `[wa] unsupported type <field> n=<count>` line is printed. Re-delivered history replaces an old placeholder text (not edited messages).
- `logout()` sends `remove-companion-device` itself and waits for the server's reply (up to 10s, waiting for/creating a connection first),
  wipes local state either way, and throws a user-facing error if removal could not be confirmed.

## Where names come from (non-contacts)
Wired sources: app-state `contactAction.fullName` (address book), history `PUSH_NAME` chunks and `contacts.update` (`notify` -> push name),
`WebMessageInfo.pushName` on live and history messages (group messages: the participant, stored under the LID and the phone number), `verifiedBizName`,
a DM conversation's `name`, and every LID<->phone pair from keys (`participantPn/Lid`, `senderPn/Lid`), group participants, conversations and contacts.
Not available in Baileys 6.7.24: `contactAction.firstName/pnJid` (dropped before the event; raw patches are not exposed) and names inside group
participant lists (only id/jid/lid). WhatsApp does not give a linked device the push name of someone who is neither a saved contact nor has written
since linking (history messages usually carry no `pushName`); the first live message from them records it and patches all their earlier messages
(`message-update {sender}`) and the member list.
History notifications are logged (`UNIMSG_DEBUG=1`: type, inline, direct, handle, chunk, progress). The companion asks for
`inlineInitialPayloadInE2EeMsg`, so the bootstrap chunk may arrive inline in the notification; Baileys 6.7.24 cannot read that, so the connector
decodes it itself (zlib + HistorySync) and tells Baileys to skip it. Notifications addressed by `encHandle` only cannot be downloaded by this version.
An app-state resync runs when the app-state key arrives and 22s after connect.

## Stub messages
WAMessageStubType 1 = REVOKE (-> a deleted message, or marks the stored one deleted); 2 = CIPHERTEXT (message not decrypted yet; nothing is shown and the
retried message arrives later under the same id). Unmapped stubs are counted by name (`[wa] unsupported stub CIPHERTEXT n=..`).

## Polls, events, locations, GIFs (v0.4)
- **Polls:** the secret is read from `WebMessageInfo.messageSecret` (history) or `messageContextInfo` (live); history polls also deliver already-decrypted
  `pollUpdates`, which are merged (this is where my own phone votes come from). Own live votes are decrypted with my pn or LID form. `vote()` updates the
  tally at once (my id in the same form as other voters, `Poll.mine`). A poll with no secret is shown read-only (`closed`); `vote()` first asks the phone to
  resend it (`requestPlaceholderResend`) and otherwise fails with a clear message.
- **Events:** `OutgoingMessage.event` relays an `eventMessage` + `messageSecret` with stanza `type=event` and `<meta event_type="creation"/>` (recipe of Baileys 7; 6.7.24
  has no public API). `editEvent` sends a `secretEncryptedMessage(EVENT_EDIT)` whose payload is a `Message{eventMessage}` encrypted with the "Event Edit"
  key (no AAD); incoming edits are decrypted the same way. Both were derived from Baileys 7 / whatsmeow and are only round-trip tested here, **not verified
  against WhatsApp**. NOTHING about events (create, edit, incoming edit decryption, `capabilities.events`/`eventEdit`) has been verified against a live WhatsApp account; treat both capability flags as unproven until tested on the test chat. No video-call link can be created (needs a call-link IQ missing in 6.7.24), so `videoCall` is ignored.
- **Live locations:** the first `liveLocationMessage` becomes `Message.location{live:true, updatedAt}`; later positions with the same message id (or via `messages.update`)
  replace it in place if their sequence number is not older. 6.7.24 shows no explicit "stopped sharing" signal and the duration is not in the message, so a share
  without updates for 30 minutes is marked ended (`live:false`). How WhatsApp really delivers updates is unverified.
- GIFs (`videoMessage.gifPlayback`) are videos with `Attachment.gif`. Reactions on deleted messages are refused/ignored. Community covers fall back to the announcement group.
- **Sending GIFs:** only an mp4 sent as `{video, gifPlayback:true}` animates on WhatsApp, so an attachment marked `gif` whose bytes are an mp4 goes out that way; a real `image/gif` cannot animate (WhatsApp would have to be given mp4, and there is no ffmpeg on Android or the desktop; Baileys' jimp writes images only), so it is sent as the still image the recipient sees and is never echoed with `Attachment.gif` (`src/gif.test.ts`).

## Undecryptable messages ("Waiting for this message")
After a (re)link some messages cannot be decrypted yet (`CIPHERTEXT` stub, "No matching sessions found"). Baileys 6.7.24 already sends a retry receipt
(`maxMsgRetryCount` 5, `retryRequestDelayMs` 250 are left at their defaults; `getMessage` only serves our own sent messages and `shouldIgnoreJid`
only ignores broadcasts/newsletters, so nothing suppresses the retry) and asks the phone once for a resend on the first retry, but it never
retries that request. Each placeholder is therefore also queued here (`resend.ts`): at most one request start per 1.5s, 3 in flight, dedup per message id,
retried after 30s, 5min and 1h, then the placeholder reads "This message couldn't be decrypted. Open WhatsApp on your phone to read it."
The pending set is persisted in the cache and re-armed on every reconnect; placeholders written by older versions are migrated.
The phone answers with `peerDataOperationRequestResponseMessage`; Baileys re-emits the message as `messages.upsert` type `notify` WITH a `requestId`.
Such upserts are treated as replays (flagged `historical`, no unread bump) and replace the placeholder under the same id. A retry receipt answered by
the sender (new session / sender key) arrives the same way without a requestId and replaces it too (flagged historical because it replaces).
`refreshChat()` ("ask the phone again") requests all pending placeholders of a chat at once (max 50, 5 at a time), re-runs the unread-gap fetch even
if it ran before, and waits up to 8s to report whether the phone answered. If the unread-gap fetch returns nothing it also asks for the chat's newest
message by key (when known from the chat list). `UNIMSG_DEBUG=1` logs `unread gap chat unread=N held=M fetched=K resend=R` and resend counts only.
The phone must be online for any of this; Baileys also keeps its own 15s "no response" window per request.

## Poll wire format (reference check)
Vote crypto = whatsmeow `generateMsgSecretKey`: HKDF(secret, info = pollMsgId + creator(non-AD) + voter(non-AD) + "Poll Vote"), AAD = pollMsgId + `\0` + voter,
selected options = sha256 BYTES of the option names. Outgoing votes use stanza `type="poll"` (Baileys 6.7.24 labels unknown content `text`; 7.x labels
pollUpdateMessage `poll`) plus `<meta polltype="vote"/>`, key = {remoteJid: chat, fromMe: poll is mine, participant: creator non-AD only for others' group polls}.
Incoming `cleanMessage` rewrites `pollCreationMessageKey` to our perspective, so the poll is looked up by message id only; creator/voter jids for the key
derivation are tried in every known form (pn, lid, raw, mapped). `UNIMSG_DEBUG=1` prints per vote (counts only):
`[wa] poll-update in: fromMe= chat=dm|group creatorForm=pn|lid|? voterForm= secret=have|missing pollKnown=yes|no decrypt=ok|deferred|fail:<why> options=<n>`
and `[wa] poll-vote out: chat= creatorForm= voterForm= secret=have options=<n> relay=ok|error:<name>`, plus `[wa] dropped: <proto field>` for content that created nothing.

## Library defect handled
Baileys 6.7.24 logs `unexpected error in 'processing offline nodes'` when a handler throws while draining the offline queue; its queue then
never resumes for that connection (flag not reset), so later offline nodes (messages, receipts) are not processed. They were not acked, so the
connector restarts the socket once (at most every 10 min) to get them redelivered, and reports a non-fatal `offline-queue` error.
Root cause inside Baileys is unknown (`UNIMSG_DEBUG=1` prints the error name and the first two library file:line frames).

## Mentions, link previews, forwarded, disappearing messages (v0.5; offline-tested only, NOT verified live)
- **Mentions** (`capabilities.mentions`, groups only): each `OutgoingMention` span `@Name` is rewritten to `@<user part of the jid>` and the jids go into
  `contextInfo.mentionedJid` (Baileys `mentions`, also on media captions). The jid form follows the group's `addressingMode`: `lid` groups use the member's LID
  (falls back to the number if no LID is known), `pn` groups the number (falls back to the LID). Unknown ids/invalid or overlapping spans are sent as plain text.
  The returned/stored message shows `@Name` again. Incoming `@<digits>` tokens listed in `mentionedJid` are shown as `@Name` (contact > push > formatted number;
  both LID and number forms match; an unnamed LID token stays as digits); applies to text, captions and edits. Edited messages (`edit()`) are sent as plain text
  (no mentions). Whether WhatsApp accepts the LID user part in the text of LID groups is a hypothesis taken from Baileys/WA Web behaviour.
- **Link previews**: the first `http(s)://` or `www.` URL of a plain text message (not captions) is fetched (`linkpreview.ts`): DNS is resolved and ALL addresses must be public
  (private/loopback/link-local/CGNAT/multicast/reserved, v4-mapped/NAT64/6to4 v6 are refused), the connection goes to the checked IP (no rebinding), redirects (max 3) are re-checked,
  no credentials in URLs, `text/html` only, 1 MB body cap, one 5 s deadline for page + image (so a send can be delayed up to 5 s). `og:title|description|image|url`
  (fallback `<title>`, meta description, twitter:*) fill `matchedText/title/description/jpegThumbnail` (previewType NONE). The 6.7.24 proto has **no `canonicalUrl`
  field**, so it cannot be sent. Thumbnail: a JPEG <= 64 KB is used as is, else Baileys' `extractImageThumb` (sharp/jimp, optional) shrinks it; without them the preview has no image.
  Baileys' own unguarded fetch (`link-preview-js`) is always disabled by passing an explicit `linkPreview`. Opt-out: `UNIMSG_WA_LINK_PREVIEW=0` (the contract has no provider setting).
- **Forwarded**: `OutgoingMessage.forwarded` -> `contextInfo.isForwarded + forwardingScore 1` on every part; incoming `isForwarded` -> `Message.forwarded`.
- **Disappearing messages**: the timer is learned from group metadata (`ephemeralDuration`; a fetched group without it = off), `chats.update` (`ephemeralExpiration`, from
  EPHEMERAL_SETTING protocol messages and history), timer-change notices (stub 72/130) and positive `contextInfo.expiration` of messages; the newest setting wins.
  Kept as `StoredChat.ephemeral` / `ephemeralOf(chatId)` and reported as `Chat.disappearing`; incoming messages carry `Message.expiresIn` (contextInfo.expiration). `setDisappearing(chatId, seconds)` (24 h / 7 d / 90 d / off; groups via `groupToggleEphemeral`, DMs via `disappearingMessagesInChat`) is fake-socket tested only, NOT verified live. While it is > 0 every send (text, media, replies, polls, contacts, locations) passes
  `ephemeralExpiration` so the message carries the chat's timer. Events and poll votes (relayed by hand) do not carry it. This connector never deletes messages when they expire.

## Limitations / TODO
- Media thumbnails/duration on upload need Baileys' optional deps (`sharp` or `jimp`); not added.
- No contacts/locations send or receive (shown as placeholder text), no forward, no mute/archive writes, no group admin ops.
- Quoting a message sends only its text as the quoted preview (not the original media).
- Chat ids may change from LID to phone JID once a mapping is learned (possible duplicate chat until the Hub merges).
- Full-history sync is NOT requested (`syncFullHistory` together with the Desktop `browser` makes WhatsApp drop the connection before the QR appears); the phone sends its normal recent-history sync, and `history()` can ask for older messages on demand.
- Cache is a JSON file rewritten (debounced) on change: fine for modest accounts, replace with SQLite if it grows.
- Upgrade path: Baileys 7 (use `remoteJidAlt`/`participantAlt`, `lid-mapping.update`).

## Tests
`pnpm --filter @unimsg/provider-whatsapp test` runs offline unit tests (mapping helpers, connector fixtures, `features.test.ts`: mentions, previews against a loopback fake server reachable only through an injected resolver, forwarded, disappearing). No test touches WhatsApp.

## 2026-11-14 additions (all fake-tested only; see `src/features2.test.ts`)
- **Polls sent from UniChat:** the 32-byte `messageSecret` is generated by us, passed to Baileys (`poll.messageSecret`), verified on the
  returned message (patched + error logged if missing), stored with the poll and persisted in `unimsg-whatsapp.json`, so votes decrypt after
  a restart. Single choice = `pollCreationMessageV3` / `selectableOptionsCount 1`, multiple = `pollCreationMessage` / `0` (Baileys' mapping).
  I could not find a defect in the Baileys 6.7.24 send path by reading it (it sets the secret, stanza `type=poll`, `<meta polltype="creation"/>`);
  if "Waiting for this message" persists, read the new counts-only debug lines `poll-create out: version=.. selectable=.. secret=..` and
  `poll-create in: ...` (UNIMSG_DEBUG=1) to compare with a poll created on WhatsApp Web (version/selectable of the real thing).
  `Poll.multiple` is `selectableOptionsCount !== 1`; the UI is radio-like for single choice (a new pick replaces the vote).
- **Older history while scrolling:** `history()` asks the phone for 50 older messages (`fetchMessageHistory`, anchored on the oldest stored message),
  waits up to 15s for the ON_DEMAND chunk, shares one request between concurrent calls, marks the chat exhausted only when the phone answered
  with nothing new, and after a timeout (phone offline) pauses requests for that chat for 60s.
- **Full "transfer chat history" for an already linked device: not possible.** The `requireFullSync` / `historySyncConfig`
  (storageQuotaMb, recentSyncDaysLimit, ...) flags live in `DeviceProps`, which Baileys sends once in the *pairing* registration payload
  (`generateRegistrationNode`); the phone decides then which history chunks (INITIAL_BOOTSTRAP, RECENT, FULL, ...) it pushes, and does so once.
  There is no post-link message to change it, and a normal login payload (`generateLoginNode`) carries no such field. The only ways to get more:
  unlink and link again (UniChat already sets `syncFullHistory: true` and a DESKTOP platform at link time; the phone's own "Transfer chat
  history" prompt/limit on the phone side still applies), or the per-chat on-demand fetch above, which is limited by what the phone keeps.
- **Presence:** `Capabilities.presence`. DM presence is requested with `presenceSubscribe` for the 30 most recent DMs active in the last 14 days
  after each (re)connect and for chats the user opens (oldest subscription dropped beyond 30). `presence.update` -> `{type:"presence"}` event
  (`online` unless `unavailable`; `lastSeen` only when the contact shares it). Groups are ignored.

## Baileys patch (patches/@whiskeysockets__baileys@6.7.24.patch, pnpm patchedDependencies)
Baileys 6.7.24 unwraps `deviceSentMessage` and drops the OUTER `messageContextInfo`. For a poll created on the user's own phone that outer context holds the poll `messageSecret`, so votes on such polls could never be decrypted ("no-secret"). The patch copies the outer secret into the unwrapped message. Verified live 2026-11-14 on the Signal-o-mat test chat: a vote cast on the phone now shows up in UniChat.

## Live poll test log (2026-11-14, Signal-o-mat chat only)
- Poll created on the phone (single or multiple): arrives with the right mode (v3 + selectable=1 = single). OK.
- Vote on the phone -> UniChat tally: OK (after the patch above).
- Poll created in UniChat (single V3 and multiple V1): the phone shows "Waiting for this message" and never resolves. NOT FIXED. Hand-built relayMessage variants (with/without deviceListMetadata) showed nothing at all on the phone.
- Vote sent from UniChat on a phone-created poll: relay + server ack OK, but the phone does not show it. NOT FIXED.


## Session address aliasing (PN <-> LID)
Baileys 6.7.24 stores Signal sessions per `<user>.<device>` and has no PN<->LID migration. A session built when UniChat sent to the phone-number address was invisible when the same person's reply arrived from the LID address, so every message from the phone failed with `No matching sessions found` (symptom after a relink: "Waiting for this message", phone votes/texts missing). `sessionalias.ts` wraps the key store: session ids of a known LID are rewritten to the phone-number form, legacy LID-form records are still read and move over on their next write. Verified live after a relink (0 decrypt failures; phone texts, reactions and poll votes arrive). `UNICHAT_STANZA_TRACE=1` also logs the decrypt-failure kinds.
- Pin in chat: `pin()` sends `pinInChatMessage` (24 h / 7 d / 30 d, default 7 d); incoming pins/unpins (also from other own devices) mark the target message. Fake-verified only.

# @unimsg/provider-signal

Unofficial Signal client for UniChat, implemented as a **linked secondary device** (like Signal-Desktop).
Status: first working skeleton. It compiles against the real libsignal typings and its offline tests pass,
but it has **never been run against Signal's servers** (see "Unverified").

## DESIGN

### Decision: (a) service layer in TypeScript on `@signalapp/libsignal-client` 0.106.2
Research result: the current npm package is no longer "just crypto primitives". Besides sessions, prekeys,
sealed sender, group ciphers and zkgroup it ships libsignal's Rust **network stack** (`Net`): TLS with Signal's
pinned roots, proxy/censorship-circumvention support, websocket framing, and the chat protocol:

- `Net.connectProvisioning()` - provisioning websocket (device linking), plus `RecvProvisionCiphertextState`
  (provision-envelope decryption, in `dist/Provisioning.js`).
- `Net.connectAuthenticatedChat()` - the authenticated websocket (message delivery, acks) with typed services
  `AuthKeysService` (prekey counts/upload), `AuthMessagesService` (send 1:1 / sync), `AuthDevicesService`, ...
  and a generic `fetch(ChatRequest)` for any REST-over-websocket call (we use it for `GET /v2/keys/...`).
- `Net.connectUnauthenticatedChat()` - used for the `PUT /v1/devices/link` registration call.

So the remaining "service layer" is protobuf, linking orchestration, prekey management, decrypt/encrypt
orchestration and mapping to the UniChat model - all pure TypeScript/JS, runs on Node and nodejs-mobile, no JVM.
Option (b) (wrapping the `signal-cli` JSON-RPC daemon) was therefore not needed. If ever required it should be a
second `Connector` implementation behind the same `ProviderFactory`; nothing here depends on it.

Because libsignal owns TLS/websocket, we do **not** need Signal's private CA bundle for chat traffic. We *would* need
it for plain-HTTPS endpoints (CDN attachments, `storage.signal.org` groups) - that is the reason attachments and
group state are TODO (below).

### Layout
```
src/index.ts            Connector + ProviderFactory (thin adapter, capabilities)
src/service/client.ts   SignalClient: Net, link loop, authenticated receive loop + reconnect, write operations
src/service/linking.ts  provisioning websocket -> QR URL -> decrypt envelope -> PUT /v1/devices/link
src/service/keys.ts     signed / one-time EC / Kyber / last-resort prekey generation, upload, refresh/rotation
src/service/decrypt.ts  Envelope -> Content (double ratchet, prekey msg, sealed sender, sender-key)
src/service/inbound.ts  Content -> CoreEvents (messages, edits, deletes, reactions, receipts, typing, sync transcripts)
src/service/sender.ts   per-device encrypt + send, prekey-bundle fetch, mismatched-device recovery
src/service/groups.ts   group identifier derivation from master key (zkgroup)
src/protocol/*          protobuf codec (protobufjs reflection over embedded Signal .proto), padding, device-name crypto
src/store/*             sealed JSON store + libsignal Session/Identity/PreKey/SignedPreKey/Kyber/SenderKey stores
src/test/offline.test.ts  offline tests (real libsignal crypto, no network)
```

### Protocol flow implemented
**Linking** (`login: "qr"`): `connectProvisioning` yields an opaque address -> we emit a `LoginPrompt` of kind `qr`
with `sgnl://linkdevice?uuid=<address>&pub_key=<base64 pubkey>&capabilities=nopni,nopni2` (format taken from
Signal-Desktop `signalRoutes`). Provisioning sockets expire after ~1 min; we reconnect and emit a fresh QR
automatically. The phone sends a `ProvisionEnvelope`; libsignal decrypts it to a `ProvisionMessage` (ACI/PNI
identity keys, profile key, provisioning code). We then generate registration ids, a password, signed EC prekeys and
last-resort Kyber prekeys (ACI and, if present, PNI), encrypt the device name (port of Desktop `encryptDeviceName`),
and `PUT /v1/devices/link` (basic auth `aci:password`) -> server assigns `deviceId`. After the first authenticated
connection we upload 100 one-time EC + 100 one-time Kyber prekeys per identity.

**Receive**: authenticated websocket `aci.deviceId` / password. `onIncomingMessage` -> protobuf `Envelope` ->
`decryptEnvelope` -> unpad -> `Content`. Envelope types: 1 double ratchet, 3 prekey message, 6 sealed sender (verified
against the two production trust roots; 1:1 ratchet or sender-key via `groupDecrypt`), 5 server delivery receipt.
Every envelope is acked 200 after processing (also on failure, to avoid redelivery loops; failure is reported as an
`error` event with a content-free message). Reconnect with exponential backoff 1s..60s; `needs-login` only for
`DeviceDelinked`; `AppExpired` is fatal.

**Send** (1:1, and groups by fan-out, see "Groups v2 sending"): `signalEncrypt` per device -> `sendMessage` (authenticated, unsealed); prekey bundles from
`GET /v2/keys/<aci>/*`; `MismatchedDevices` handled (drop extra/stale sessions, refetch missing/stale, retry). A
sent-transcript `SyncMessage.Sent` is then sent to our other devices (`sendSyncMessage`).

**Prekeys**: counts checked on each connect (<10 -> re-upload 100); signed + last-resort Kyber rotated every 2 days
(old ones kept for decryption).

### IDs
Chat ids: DM = peer ACI (UUID; our own ACI = Note to Self); group = `g.<base64url(groupId)>` (groupId = zkgroup identifier derived locally from the
group master key). Message ids: `<authorAci>.<sentTimestampMs>` - stateless, so replies/reactions/edits/deletes/receipts
can address any message without a local message log. Phone numbers are stored only inside the sealed store (contacts from contact sync / lookups, used as display-name fallback) and are never logged.

### Storage and secrets
One AES-256-GCM sealed blob `signal-store.bin` (0600, atomic rename, debounced writes) holding identity keys, sessions,
prekeys, sender keys, chat index, reactions, sent-index. Data key in `signal-store.key` (0600) **unless** the host uses
`factory.createWithKeyProvider({..., keyProvider})` (Electron `safeStorage`, Android Keystore). With the default file
key, encryption only protects against separated copies of the data file, not against anyone who can read `dataDir`.
The whole file is rewritten on change (fine for a personal account; move to SQLite if it grows). Logging: this package
never logs; `error` events carry only error class/message strings.

## What works (verified how)
Verified by **offline tests** (`pnpm test`, 30 tests, real libsignal crypto): padding, protobuf codecs, link URL,
sealed-store encryption/permissions/tamper detection, group-id derivation, device-name encryption, attachment crypto round trip (+ tamper detection), an encrypted `ContactDetails` stream round trip, handle parsing, the always-present Note to Self chat / contact-named chats / blocked-sender drop / own-only contact-sync trigger, and an end-to-end
peer->us PQXDH prekey message through `decryptEnvelope` -> `Inbound` (message event, one-time prekey consumed, sync
spoof rejection, own-device transcript, receipt routing, reactions with `mine`).
Verified by **type-checking** against the real `.d.ts` of libsignal-client 0.106.2 and the real core contract (`tsc`
5.9.3, strict, NodeNext; run in a scratch tree populated with `deno install` because pnpm is unavailable here).

Implemented (capabilities are set accordingly): linking by QR, receive loop with reconnect, text messages,
quotes/replies, edits, deletes, reactions, typing, read/delivery receipts, forwarded flag, contact cards (send+receive),
own-device sync transcripts, 1:1 send with delivery status `sent` and later `delivered`/`read` receipts,
group *receive* (messages appear in a `g.` chat, named once the group state resolved), group *send* by fan-out (below).

### Content types (receive)
`src/service/richContent.ts` (pure, tested with codec fixtures) + `Inbound`. Every mapped type gets a short plain-text
`Message.text` (previews/search) plus a `Card` or an `info` notice (`Message.system = {kind:"info"}`):
- stickers -> attachment kind `sticker` (downloadable), text `Sticker <emoji>`; view-once media -> attachment listed but
  deliberately NOT downloadable, text "[View-once media - open it in Signal on your phone]";
- link previews (`DataMessage.preview`) -> `link` card (first preview) in addition to the text; mentions -> `@name` in the text
  (U+FFFC placeholders replaced, also in edits); other formatting ranges keep the plain text;
- story replies / story reactions (`storyContext`) -> `other` card ("Reply to a story" / "Story reaction"); the story itself is not
  available (we do not subscribe to stories; `Content.storyMessage` is ignored);
- gift badge -> `payment` card; payment notification -> `payment` card with the note (the amount is MobileCoin-encrypted and not
  readable); payments activation -> `payment` card; group call update -> `call` card;
- calls: modern 1:1 calls are signalled with opaque RingRTC messages we cannot interpret, so the call log is taken from the phone's
  `SyncMessage.CallEvent` (incoming/outgoing/missed/unanswered, voice/video/group; DELETE/OBSERVED ignored). A legacy
  `CallMessage.offer` becomes an "Incoming call" card; hangup/busy/answer/ICE/opaque produce nothing;
- notices: disappearing-message timer changes ("Disappearing messages: 1 week" / "turned off"), pinned/unpinned message,
  "Your safety number with X has changed" (identity store callback, replaces the old error banner); admin-delete removes the target.
  Skipped on purpose: profile-key updates, session resets (END_SESSION), sticker-pack sync, read/viewed sync.
  Signal has no "screenshot"/"media saved" message type in the current protocol.
- unknown content (a `DataMessage` field or `Content` member we do not know) -> `[unsupported message: <field>]` + `other` card and
  a counts-only `console.debug` line (`[signal] unsupported content field=<name> count=<n>`). Fields added to Signal after the
  embedded `.proto` snapshot are invisible to the decoder (see "Updating protobufs").
Sending is unchanged (text, quotes, edits, deletes, reactions, contact cards, polls); sending stickers/cards is not implemented.

### Groups v2 sending (fan-out; never run against Signal)
Text, replies, reactions, edits, deletes, typing, read receipts and attachments/voice notes (uploaded once, same pointers fanned out) work in `g.` chats. Not in groups: polls/votes, group creation/administration.
- Before each send the cached state (`ChatRecord.groupMembers/groupMasterKey/groupRevision`) is used if fetched < 5 min ago,
  else refetched (`GroupResolver.ensure`); a failed refetch of old state keeps the old state. No state at all -> error
  "Couldn't load this group's details from Signal..." and nothing is sent. If our own ACI is not in the member list -> "You are no
  longer a member of this group...".
- The same `DataMessage` (with `groupV2 { masterKey, revision = cached revision }`; for edits inside `EditMessage.dataMessage`)
  is sent as an individual envelope to every member except ourselves, through the same `Sender.deliver` as 1:1 (authenticated,
  unsealed; 409/410 device mismatches handled there). Sequential, no sender keys / GroupSendEndorsements (optimisation, TODO).
- Then one `SyncMessage.Sent` (no destination; the group is identified by `groupV2` inside the message) goes to our other devices.
  It is skipped if nobody received the message.
- Success = at least one member accepted (`status: "sent"`). Failures for some members (unregistered, rate limit, ...) emit a
  non-fatal `error` event `group-partial-send`: "The message was not delivered to N person/people in this group." (count only).
  Nobody reached -> the send throws "could not be delivered to anyone in this group".
- Typing: `TypingMessage.groupId` to every member, best effort, cached state only, never throws. Read receipts go to the message author.
- `UNIMSG_DEBUG=1` lines (counts only): `[signal] groups v2: send state=<cached|refreshed> members=N delivered=N failed=N sync=<ok|failed|none>`,
  `[signal] groups v2: send state=missing`, `[signal] groups v2: typing members=N delivered=N failed=N`.
- Unverified live: that recipients' clients accept an unsealed 1:1 envelope with `groupV2` as a group message from a member
  (Signal-Desktop does for legacy clients without sender keys; sealed sender is normally used and may be expected), that the
  revision we send is accepted when slightly stale, and that other devices render the destination-less group transcript.

### Own profile and privacy
**Profile** (`getProfile` / `updateProfile`, `capabilities.profile = {displayName, about, avatar}`): the profile service stores
name / about / emoji / avatar encrypted with the account *profile key* (delivered by the phone while linking). Implemented
exactly like Signal-Desktop: `src/service/profileCrypto.ts` ports `ts/Crypto.node.ts` (`encryptProfile`, `decryptProfile`,
`encryptProfileItemWithPadding`, `decryptProfileName`, `PaddedLengths` name 53/257, about 128/254/512, emoji 32; AES-256-GCM,
IV(12)|ct|tag) and `ts/util/zkgroup.node.ts` (`ProfileKey.getProfileKeyVersion` / `getCommitment`, via libsignal zkgroup);
`src/service/ownProfile.ts` ports `ts/services/writeProfile.preload.ts`, `ts/util/encryptProfileData.preload.ts` and
`ts/textsecure/WebAPI.preload.ts` (`putProfile`, `uploadAvatar`, `makePutParams`, `getAvatar`).
- Read: `GET /v1/profile/<aci>/<version>` on the authenticated connection, fields decrypted; avatar fetched from
  `cdn.signal.org/<path>` (pinned Signal root) and decrypted. Name = `given \0 family` (UI display name is split at the first space).
  "About" is one string in UniChat: a leading emoji goes to Signal's separate emoji field and is shown joined again.
- Write: `PUT /v1/profile` replaces the whole profile, so the current one is read first and everything is re-sent; opaque
  server-held values (`phoneNumberSharing`, `paymentAddress`, visible badge ids) are carried over unchanged so they are not
  erased. A new avatar is encrypted (`encryptProfile`, unpadded) and POSTed as the S3 multipart form returned by the PUT to
  `cdn.signal.org` (pinned root); `null` removes it. Afterwards a `SyncMessage.FetchLatest(LOCAL_PROFILE)` tells the phone to refetch.
- A profile name is mandatory (Signal-Desktop asserts the same); without a stored profile key the calls fail with a clear error.
- Not read/changed: badges, payment address, username/QR link, phone-number sharing mode ("who can see my number").
- **Unverified live**: the exact JSON of the PUT response for avatar uploads and of `badges` (carry-over assumes `{id, visible}`
  objects, anything else is dropped), and that the websocket accepts `PUT /v1/profile` (Desktop does the same over its socket).

**Privacy** (`getPrivacy` / `setPrivacy`, `capabilities.privacy = true`): *Send read receipts* (`readReceipts`) and, once the
phone's `SyncMessage.Configuration` has been received, *Typing indicators* (`typingIndicators`). Changing one stores it locally
(read receipts are honoured by `markRead`; typing off stops sending and drops incoming typing events) and pushes a
`SyncMessage.Configuration` (only the fields we know) to the other devices - the protocol supports it, but whether a given phone
applies it was not verified. Not offered: phone-number discoverability / who can find me (needs `PUT /v1/accounts/attributes`
with full account attributes plus profile phoneNumberSharing; no simple, safe call - TODO), last seen (Signal has none).

### Polls (1:1 only)
Polls exist on the wire (`DataMessage.pollCreate/pollVote/pollTerminate`, current Signal-Desktop `SignalService.proto`).
Receive: a poll is the message itself (`Message.poll`, option ids = option indexes as strings); votes are keyed by
`<pollAuthor>.<timestamp>`, a voter's newest vote (highest `voteCount`) replaces the older one, `[]` retracts, only the creator
can terminate (-> `closed`), each change emits `message-update {poll}` (`mine` = my picks). Send: `OutgoingMessage.poll`
(2-10 options) and `Connector.vote()` (still 1:1 only); both mirror to other devices via sync transcripts. State lives in the sealed store
(`polls`, capped at 500). Not implemented: polls in groups (with the rest of group support), terminating a poll from UniChat
(no Connector API), vote-count display of other people's `voteCount` for multi-device races beyond "highest wins".
It has not been exercised against real Signal clients: field semantics are taken from the protobuf comments/names only.

### Chats, contacts and starting chats
- **Note to Self** (id = own ACI) is always in `chats()`, so a working chat exists immediately. Messages to it are sent as
  sync transcripts to your other devices; transcripts coming from the phone land in the same chat.
- **Contact sync**: after connecting (when no contacts are stored yet) and on `Connector.sync()` the provider sends
  `SyncMessage.Request` CONTACTS, BLOCKED and CONFIGURATION to our own other devices (the primary phone). The phone answers
  automatically with `SyncMessage.Contacts` (an attachment pointer to an encrypted blob on the CDN), `Blocked` and
  `Configuration`. The blob is downloaded from `cdn*.signal.org`, verified (SHA-256 digest + HMAC) and decrypted
  (AES-256-CBC), the length-delimited `ContactDetails` stream is parsed, and every contact with an ACI is stored and shown
  as a DM chat named by contact name, falling back to phone number, then to a short ACI. `chats-changed` is emitted.
  The user has nothing to do except keep Signal on the phone online (open the app once if nothing shows up after a minute,
  then trigger the app's sync/refresh). Contacts that only exist as phone numbers without an ACI are skipped.
  Blocked contacts are marked and their incoming messages are dropped. The `CONFIGURATION` answer updates the read-receipt
  setting.
- **CDN TLS**: `cdn.signal.org`, `cdn2`, `cdn3` and `storage.signal.org` present certificates chaining to Signal's private
  root ("CN=Signal Messenger"), not to system roots (checked with an unauthenticated TLS handshake). The root PEM is embedded
  verbatim from Signal-Desktop `config/default.json` (`certificateAuthority`); handshakes to all four hosts verify against
  it, and only that root is trusted for those requests (`src/service/attachments.ts`).
- **Incoming attachments**: pointers are remembered (id = `<messageId>#<index>`) and `downloadAttachment` works
  (download from the CDN, verify digest + MAC, decrypt, trim to `size`). Sending: see "Sending attachments" below.
- **startChat(handle)**: accepts an E.164 number (CDSI lookup through libsignal `Net.cdsiLookup`, credentials from
  `GET /v2/directory/auth` on the authenticated connection), a username `name.NN` (`usernames.hash` +
  `lookUpUsernameHash` on an unauthenticated connection) or a bare ACI UUID. Errors are `LookupError`s with clear messages
  (not found / invalid / lookup failed, incl. rate limits). The number is stored as the contact's name fallback.
- Groups are **not** part of the primary's sync any more (`SyncMessage.Request.GROUPS` is reserved in the current
  protocol; groups live in the storage service), so groups still appear only after a message arrives.

Capabilities: reactions, edits, deletes, replies, typing, readReceipts, contactCards, e2ee, startChat, sync, polls, attachments, voiceNotes, privacy = true; profile = {displayName, about, avatar} = true. Everything else false.

## Sending attachments and voice notes (never run against Signal)
`src/service/attachmentUpload.ts`. Flow per attachment: size checks (<= 100 MB, <= 32 per message, not empty) -> pad plaintext with zeros to
Signal's size bucket (`max(541, floor(1.05^ceil(log1.05 n)))`) -> AES-256-CBC + HMAC-SHA256 with a random 64-byte key -> `GET /v4/attachments/form/upload`
on the authenticated chat connection -> resumable upload over HTTPS pinned to Signal's root (cdn3: TUS `POST` create + `PATCH`; cdn2: `POST` + `PUT`) ->
`AttachmentPointer {cdnKey, cdnNumber, contentType, key, size (real), digest = SHA-256(blob), fileName, flags, width, height, caption, uploadTimestamp, clientUuid, audioDurationSeconds, audioWaveform}`.
Uploads happen once, before fan-out; the same pointers go into every recipient message, the group messages (with `groupV2`) and the `SyncMessage.Sent` transcript.
Own sent attachments are remembered like received ones (id `<messageId>#<index>`), so they can be downloaded again.
Voice: kind `voice` -> flag `VOICE_MESSAGE` (1), contentType `audio/ogg` (codec parameters stripped), fileName `signal-voice-note-<timestamp>.ogg`, duration and waveform (0-100 scaled to 0-255, max 100 bars).
**Risk**: other Signal clients may expect AAC (`audio/aac`, m4a) voice notes; Ogg/Opus may render as a generic audio file or fail to play on some versions. No transcoding is done. If a live
test shows this, the fallback is to send the Ogg as a normal audio attachment (without flag 1) or transcode to AAC in the host before `send`.
GIF flag (8) is set for `gif: true` on `image/gif` or `video/*`. Errors are plain language (too large, busy, couldn't upload); with `UNIMSG_DEBUG=1` each step logs
`[signal] attachment upload: step=<encrypt|form|upload|send> bytes=N cdn=N result=<ok|error:class>` (no names, ids or content).

## Unverified (never executed against real Signal servers)
0. Attachment upload: the JSON of `GET /v4/attachments/form/upload` (`cdn`, `key`, `headers`, `signedUploadLocation`; libsignal's typed `UploadForm` has the same shape with `signedUploadUrl`),
   TUS headers for cdn3 and the GCS-style flow for cdn2, `Location` handling, bucket padding formula, omitting `incrementalMac`, `audio/ogg` voice notes on other clients.
1. `PUT /v1/devices/link` through the *unauthenticated websocket* with an explicit `Authorization` header. Desktop uses
   HTTPS with pinned CA. If the server rejects the websocket variant, switch `completeLinking` to `node:https` with
   Signal's CA (needed for the CDN work anyway).
2. `GET /v2/keys/<aci>/*` via the authenticated websocket `fetch` (Desktop does the same through its socket manager,
   so likely fine) and the JSON shapes (copied from Desktop `WebAPI`).
3. `spqr: true` capability and the user-agent `Unimsg-Signal/0.1` (unknown whether the server filters unknown agents).
4. Sealed-sender decrypt for sender-key (group) messages, `MismatchedDevices` retry path, key rotation, DeviceDelinked
   handling - written from libsignal docs and Desktop source, only the PQXDH prekey path is covered by tests.
5. Contact-sync request/response with a real phone, the CDN path layout (`/attachments/<cdnKey>`, taken from Signal-Desktop),
   the CDSI flow (`/v2/directory/auth` + `Net.cdsiLookup`) and the username lookup have only been type-checked and unit-tested
   against fixtures; no request was ever sent to Signal.
6. The self-device list for sync: we rely on `GET /v2/keys/<ownAci>/*` returning our *other* devices.

## TODO (each throws a clear `NotImplementedError` or is simply absent; do not fake)
1. **Groups v2 remainder**: state fetch and fan-out send are done (see above). Open: process `groupChange` revisions
   incrementally (today a newer announced revision triggers a full refetch), sender keys
   (`SenderKeyDistributionMessage.create`, `groupEncrypt`, multi-recipient sealed sender with `GroupSendEndorsementsResponse`) to
   replace the per-member fan-out, pending/invited members, polls in groups, group creation/admin.
2. Attachments: sending is implemented (below, unverified live). Avatars in the contact stream are skipped (could become `Chat.avatarUrl`). Not done: `incrementalMac`, thumbnails/blurHash generation, per-attachment captions from the UI, width/height/gif for outgoing media (the Hub drops these fields today; the provider honours them if `OutgoingAttachment` ever carries them), resuming an interrupted upload.
3. **Profile names for unknown senders**: people who are not in the phone's contacts show as their number/short ACI.
   Steps: fetch profiles (`GET /v1/profile/<aci>/<version>`, profile-key crypto via zkgroup `ProfileKey`; profile keys arrive in
   `DataMessage.profileKey`) and fill `store.data.names`. Also: group names/members (see 1) and group avatars.
4. **Sealed-sender sending** and sender certificate (`GET /v1/certificate/delivery`), access keys from profile keys
   (`UnauthMessagesService`). Currently sends are authenticated/unsealed.
5. **createGroup**: needs Groups v2 creation (see 1). `startChat` is implemented (see above) but also unverified live.
6. **Decryption-failure recovery**: send `DecryptionErrorMessage` (libsignal `DecryptionErrorMessage.forOriginal`) as
   plaintext content so the sender resends; handle END_SESSION; handle inbound `DecryptionErrorMessage`/resend requests.
7. **markRead** acknowledges only the given message (no local log); inbound `SyncMessage.Read`, `Viewed`, configuration,
   blocked, message-request responses are ignored. Implement by remembering unread incoming timestamps per chat.
8. Disappearing-message timers (`expireTimer` ignored), view-once, stories, calls, polls, pins, payments: ignored.
9. `history()` returns [] (Signal has no server history; the Hub owns history). `backfill=false`.
10. Safety-number changes are auto-accepted (TOFU) and reported as an `identity-changed` error event. Add strict mode.
11. Linking UX: the device name is fixed (`UniChat`); make configurable; show completion detail.
12. Android (nodejs-mobile): `@signalapp/libsignal-client` ships prebuilds only for linux/darwin/win32 x64/arm64.
    Android needs libsignal's node bridge cross-built (`aarch64-linux-android`) - unproven; keep behind this Connector.
13. Run `pnpm install` and `pnpm typecheck` in the real workspace (not possible here); add a live smoke test against a
    *test* account / Signal staging (`Net.Environment.Staging`) before shipping.

## Caveats of unofficial clients
Signal's terms forbid unauthorised/automated clients and the service can change or block unknown clients; accounts
could be rate-limited or banned (the mesh-relay feature in core increases that risk). Linked devices are removed by
the phone after ~30 days offline. Protocol constants (capabilities, user agent) track Signal-Desktop and may need
updates; libsignal raises `AppExpired` when the server drops support for an old client version - keep the dependency
current. Licensing: `@signalapp/libsignal-client` and the embedded `.proto` files (`src/protocol/protos.ts`) are
**AGPL-3.0-only**; distributing UniChat with this provider has AGPL implications.

## Updating protobufs
`src/protocol/protos.ts` embeds `protos/SignalService.proto`, `DeviceMessages.proto`, `DeviceName.proto` from
Signal-Desktop (`main`). Re-fetch and re-wrap them as template-literal strings (escape backslashes, backticks, `${`).

## Contract change requests for packages/core
None required. Notes: (1) `Chat` has no field for "members unknown/loading"; (2) `receipt.byId` for groups would be
more useful with per-recipient status; (3) a `Capabilities` split between 1:1 and group support would let Signal
declare reactions/edits for DMs only - today they are declared true and group calls throw a clear error.

## Dependencies
`@signalapp/libsignal-client` 0.106.2 (exact), `protobufjs` 7.6.6, `@unimsg/core` workspace. Dev (root): typescript ^5.5.4
(code needs >= 5.7 because libsignal's `Bytes` is `Uint8Array<ArrayBuffer>`; verified with 5.9.3), `@types/node` ^22.


## Sealed sender, link previews, Groups v2 modify, mentions, disappearing timer (added; 68 offline tests)

**Sealed sender sending** (`service/sealed.ts`, `service/sender.ts`): 1:1 and group sends first try unidentified delivery.
Sender certificate: `GET /v1/certificate/delivery?includeE164=false` (retry without the query on 400/404), cached, validated against the
production trust roots and checked to be our aci/device. Recipient access key = `ProfileKey.deriveAccessKey()` of the profile key learned
from their messages (`ContactRecord.profileKey`), or `unrestricted` (profile flag via `GET /v1/profile/<aci>[/<version>]`, cached 6 h).
Send = `signalEncrypt` -> `UnidentifiedSenderMessageContent` -> `sealedSenderEncrypt` -> unauthenticated `sendMessage`.
401 -> unrestricted check, else authenticated fallback and no sealing to that contact for 1 h; connection errors fall back too;
409/410 mismatched devices are handled as before (drop extra/stale, refetch missing/stale, retry). Sync transcripts stay authenticated.
Groups: when the state response carried `groupSendEndorsementsResponse` (validated with zkgroup, stored per chat) and the group has >= 2 other
members, ONE `sendMultiRecipientMessage` with a `GroupSendFullToken` is used (sender key per group; SKDM sent pairwise once per device and
remembered in `ChatRecord.skSharedWith`; sender key rotates when a member leaves). Anything else -> per-member `deliver()` (sealed or not).
Debug: `[signal] send: mode=<sealed|authenticated> recipients=N delivered=N failed=N fallback=N`.

**Link previews** (`service/linkPreview.ts`): first URL of the text; https only, DNS resolved first and every address must be public (the
request then connects to that IP, TLS verified for the host), 3 redirects max (each re-validated), 1 MB, 5 s, text/html only; og:/twitter:
metadata, relative image URLs resolved, image uploaded through `uploadAttachment`. Opt-out: `OutgoingMessage.linkPreview === false` (not in the
core contract; read defensively) or privacy setting `linkPreviews` (also learned from the phone's Configuration sync). Skipped with attachments/polls/contacts.
Loopback can only be enabled by injecting `allowPrivate` (tests). Incoming previews also get their image as `Card.image`.

**Groups v2 modify** (`service/groupModify.ts`): createGroup, addMembers, removeMember, renameChat, setChatDescription, setChatPicture, leaveChat.
`PUT /v2/groups/` (create) and `PATCH /v2/groups/` (GroupChange.Actions, version = revision + 1), group auth credential presentation as for reads.
Members need a ProfileKeyCredential presentation (`getProfileKeyCredential` on the unauthenticated chat); without a known profile key the person is
invited as a pending member (an `group-invited` notice is emitted). 409 -> refetch state and rebuild (3 tries); 403 -> "Only group admins can ...".
Afterwards the members (incl. invitees and people just removed) get a DataMessage with `groupV2 {masterKey, revision, groupChange}` and our other
devices a transcript. The only admin cannot leave while others remain (clear message).

**Mentions**: `OutgoingMessage.mentions` -> one U+FFFC per `@Name` span + `BodyRange.mentionAci`; incoming ranges (string/binary ACI) render `@Name` (`@You` for us).

**Disappearing timer** (receive only): stored as `ChatRecord.expireTimer` from messages, timer-update messages, contact sync and group state;
`SignalClient.disappearing(chatId)`. The core `Chat` has no field for it, so it is not exposed. Nothing is ever deleted by this provider.

### Unverified (never run against the real service)
- Groups modify wire format: `GroupChange.Actions` field numbers (written from memory of Signal-Desktop's Groups.proto), that `Member` in a create/add
  carries only `role` + `presentation`, `PATCH /v2/groups/` + `GroupChangeResponse`, `GET /v2/groups/avatar/form` + the multipart POST to cdn0, empty
  `ModifyAvatarAction` clearing the picture, what a 409 body contains (we just refetch), the default AccessControl values on create.
- Sealed sender: that the server accepts our linked-device certificate and `includeE164=false`; profile JSON field `unrestrictedUnidentifiedAccess`; that the
  multi-recipient token must cover exactly the recipient set (we combine the endorsements of the included members); endorsement response only appearing in GET /v2/groups/.
- Link preview: `Preview` fields as the official clients fill them (no image dimensions are sent).

## Storage Service sync (read-only)
Why: the contact-sync blob has no profile keys and often no names; Signal keeps them in the Storage Service. `service/storageSync.ts`
reads it as a linked device: key from the primary (`SyncMessage.Request KEYS` -> `SyncMessage.Keys`, or the provisioning message),
`GET /v1/storage/auth` on the chat connection, then `storage.signal.org` (pinned CA): `GET /v1/storage/manifest[/version/N]`
(204 = unchanged), `PUT /v1/storage/read` (a READ with a body; batches of 100). Only new storage ids are read on later syncs.
Applied: ContactRecord (profile key, nickname > address-book > profile name -> `contacts[aci].name`, parts kept in
`nickName/systemName/profileName/syncName`, blocked/archived/muted/hidden), GroupV2Record (master key -> group chat + resolver,
archived/muted/blocked), AccountRecord (read receipts, typing, link previews, pinned chats). Keys are requested with backoff
(0, 2 min, 10 min, 1 h, 6 h, 24 h, then weekly) and the sync degrades silently if the phone never answers.
**It never writes**: `StorageSync.req` refuses anything but GET and `PUT /v1/storage/read`. Only the derived storage key is stored.
Debug (UNIMSG_DEBUG): `storage: keys requested attempt=N`, `keys received (aep|master)`, `manifest v=N records=N contacts=N groups=N applied=N skipped=N`.

Unverified hypotheses (never run against the live service): all field numbers in `STORAGE_PROTO` (ContactRecord 1-22, GroupV2Record,
AccountRecord incl. pinnedConversations=14, PinnedConversation.contact.serviceId=1 / groupMasterKey=4, ManifestRecord.recordIkm=4,
Identifier types 1/3/4); storageKey = `SvrKey.deriveStorageServiceKey()` (test shows it equals HMAC(master,"Storage Service Encryption"));
manifestKey = HMAC(storageKey,"Manifest_"+version); itemKey = HKDF(recordIkm, info "20240801_SIGNAL_STORAGE_SERVICE_ITEM_"+raw)
with fallback HMAC(storageKey,"Item_"+b64(raw)); AES-256-GCM with 12-byte IV prefix; endpoints and the 204 on `/manifest/version/N`;
the server-pushed "manifest changed" notification is not handled (only `FetchLatest STORAGE_MANIFEST` and a 30-minute re-check).

## Blocking and disappearing timers (added; fakes only, never run against Signal)
- **Block / unblock a 1:1 contact** (`blockChat`, `Capabilities.block`): a linked device cannot write the phone's block list (the Storage Service is read-only here), so the block is **local to UniChat**: `ContactRecord.localBlocked` makes the connector drop that contact's incoming messages, refuse `send()` and show `Chat.blocked`. It is kept apart from the phone's `blocked` flag, so Storage Service / blocked-list syncs never clear it (and a block set on the phone still shows). Groups cannot be blocked from here. The contact is not told, and the phone keeps receiving their messages.
- **Disappearing timer** (`Chat.disappearing`, `Message.expiresIn`, `Capabilities.disappearing`, `setDisappearing`): the timer last seen (messages, timer-update messages, contact sync, group state) is shown on the chat and on each message that carried one. Every message we send in a chat with a timer carries it as `expireTimer`. `setDisappearing(chatId, seconds)` (1:1 only, 0 to 4 weeks) sends an `EXPIRATION_TIMER_UPDATE` DataMessage to the peer plus a transcript to the phone. Changing the timer of a **group** needs a GroupChange (not implemented; change it on the phone). Nothing is ever deleted locally by the timer (UniChat keeps its archive; `expiresIn` is informational).
- **View-once** media is received as a placeholder text with `Message.viewOnce = true`; the content is deliberately not downloadable.
- **Stickers (receive)**: the sticker image arrives as an attachment of kind `sticker` (download through the normal attachment path), text `Sticker <emoji>`. Sticker packs themselves are not fetched; sending stickers is not implemented.
- Tests: `src/test/block-timer.test.ts` (block, timer set/receive/ride-along, view-once, sticker, voice/GIF/image/file receive kinds).

## Avatars

`avatar({kind, id})` (capability `avatars`) never throws and returns `undefined` when there is no picture.
- **Groups** (`kind: chat`, id `g.*`): the avatar is fetched and decrypted with the group cipher while the group state resolves (`groupState.ts`), stored in the sealed store (up to 1 MB; larger ones are kept in memory), re-fetched only when the CDN path in the snapshot changes.
- **DMs / contacts / Note to Self** (`service/peerAvatars.ts`): `GET /v1/profile/<aci>/<profileKeyVersion>` on the authenticated connection with the contact's stored profile key (our own key for our own chat), then the avatar blob from the CDN, decrypted with the profile key; mime sniffed. No profile key, no avatar or a 404 gives `undefined`. `full` returns the same image.
- **Limits**: lookups are serialized with a 250 ms gap and de-duplicated, cached 6 h per person (misses 1 h), 429/401/503 pause lookups for 10 min without caching a miss; lookups run on demand only and never on the receive loop. Nothing (ids, keys, paths) is logged.
- **Hints**: `chats()` sets `avatarRev` (group: hash of the avatar path; DM: hash of the profile avatar path once seen, else of the profile key version). `avatar-changed` is emitted when a group avatar path changes, when a person's picture path changes between lookups, and when their profile key changes.
- Verified with fake servers only (tests `peerAvatars.test.ts`, `groups.test.ts`); not yet against real Signal.

## Where profile keys come from, names, and PNI/ACI duplicates (added 2026-11-15; fakes only)

Profile pictures and profile names of other people need THEIR profile key (`store.data.contacts[aci].profileKey`). Sources, in the order they
are normally learned:

1. **Messages** (`inbound.ts learnProfileKey`): every `DataMessage.profileKey` (32 bytes only; DMs and group messages, sealed or not) of a
   sender who is not blocked. A message is authoritative for its own sender, so a changed key replaces the old one (and resets the
   sealed-sender / name-check state); `onProfileKey` then refreshes the avatar and the profile name. Keys are never logged.
2. **Storage Service contact records** (`storageSync.ts applyContact`): `profileKey` is mapped for every record, with or without a name; a
   record with a key is never pruned by the contact-sync cleanup (`client.ts`).
3. **Secure Backup import** (`Connector.importContacts`, `client.importBackupContacts`): the backup's Contact frames carry the profile key.
   After an import the Hub hands `{aci, profileKey, name, e164}` to the connector, which only ADDS keys (never overwrites an existing one),
   fills missing names/numbers, skips blocked contacts and emits `avatar-changed`. Re-running the import (which dedupes messages) is the way to
   fill keys for chats that were imported earlier; the result reports `contacts: {inBackup, newProfileKeys}`.

Names are only accepted when the AES-GCM tag verifies AND the text is valid UTF-8 without control characters / U+FFFD (`cleanName` in
`profileCrypto.ts`; applied to profile names, storage-record names and the displayed contact name), otherwise ignored.

### PNI / ACI duplicate chats
A chat started from a phone number can be addressed by the person's PNI; their first reply arrives from their ACI, which created a second
chat. `store.data.pnis` (pni -> aci) is filled ONLY from (a) a storage contact record that names both (read with a tolerant second decode,
`ContactPniProbe`, tag 24: **the tag is unverified against upstream**, a wrong tag just yields nothing) and (b) a `PniSignatureMessage`
whose signature verifies (`PublicKey.verifyAlternateIdentity` with the PNI identity key we saved when sending to that PNI and the sender's
ACI identity key). A shared phone number alone never merges anything. `chatRecordToChat` then sets `Chat.sameAs = <aci>` on the PNI chat
(the ACI chat is created empty if missing) and the Hub folds the pair into one row (see packages/core, "auto merge").

Why the Hub's merge machinery and not a fold inside the provider: it already gives one unified timeline, summed unread, send routing
(`sendVia` = the ACI chat) and replication through sync (kind `me`) for free, and it keeps both ids valid so old message ids keep working.
The auto merge record has the stable id `merge:auto:<sha1 of the sorted pair>` (same on every device) and `auto: true`; "Unmerge" keeps
it as a `dismissed` tombstone so it is not re-created. A user merge that already holds the ACI chat is extended by the PNI chat.
- Pinned messages: `DataMessage.pinMessage/unpinMessage` sent and received (durations incl. forever). Fake-verified only.

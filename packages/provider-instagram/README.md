# @unimsg/provider-instagram

Instagram direct messages for **personal accounts**, through Instagram's **unofficial private mobile API**. No SDK, no new dependency beyond `ws`:
Node's `fetch` plus a small own implementation of the pieces needed (HTTP client, password encryption, MQTT-over-WebSocket realtime).

> **Not verified against the real service.** This package was written and tested only against an in-process fake server (see Tests). Every
> endpoint, header and wire detail comes from memory of publicly known client behaviour; the list under "Hypotheses" says which parts are unsure.
> Expect that the first real run needs fixes. Instagram changes this API without notice.

## The reality (read this before logging in)
* There is **no official API** for the direct messages of a personal account. Meta's official messaging (Instagram Graph API / Messenger Platform for
  Instagram) works only for **Business/Creator accounts attached to a Facebook Page**, via webhooks + Send API, inside a 24 h reply window, and needs a
  Meta developer app (review for production). It cannot read a person's normal inbox.
* So this provider (mode **A**) logs in like the Instagram Android app. That is **against Instagram's terms of use**. Possible consequences:
  security checkpoints ("confirm it's you"), forced password reset, temporary action blocks, rate limits, a restricted or **permanently banned account**.
  Use an account you can afford to lose; consider not using it for your main/business account.
* Mode **B** (official Graph API for Business accounts) is **not implemented**. See "Contract changes / next steps". It would be a separate login
  kind, not a hidden switch of this one.

The login form shows all of this in a prominent warning box and requires ticking its **required checkbox** (`confirm` = `"true"`; the legacy `YES` is still accepted) before anything is sent.

### Library decision
`instagram-private-api` 1.46.1 (MIT, last published 2024-03) and `instagram_mqtt` 1.2.3 (MIT, last published 2024-04) are the usual choices.
I judged them from npm metadata only (I did not install them): no release for 2+ years while the app version they impersonate keeps aging, and
they pull in a large dependency tree (lodash, request-era HTTP, rxjs, chance, ...). For a tool whose main risk is "looks like a real, current app and
behaves politely", a small, auditable own implementation that we can adapt is the better trade. Licences are no obstacle (MIT), maintenance is.

## Logging in
Form fields: Instagram **username** (not e-mail), **password**, and the consent checkbox.
1. `GET /qe/sync/` -> server announces the password-encryption key (`ig-set-password-encryption-key-id` / `-pub-key` headers).
2. `POST /accounts/login/` with `enc_password` = `#PWD_INSTAGRAM:4:<ts>:<base64>` (RSA-PKCS1 wrapped AES-256-GCM key, as the app does). The plain
   password never goes over the wire unencrypted and is never stored or logged.
3. Two-factor (`two_factor_required`) -> second form for the TOTP/SMS code (`/accounts/two_factor_login/`).
4. Checkpoint (`challenge`) -> UniChat asks Instagram to e-mail/SMS a code and shows a third form. If that is not possible the message tells you to
   open the Instagram app or website, approve "This was me", and try again.
5. The session (`Authorization: Bearer IGT:2:...` plus `x-mid` / `rur`) is stored in `dataDir/instagram-session.json` (**mode 0600**, atomic write)
   and rewritten when Instagram rotates it. Restart restores it without a prompt. A 401 / `login_required` or a checkpoint wipes it and shows a
   fresh form (`needs-login`).
6. `dataDir/instagram-device.json` (0600) is the **persistent device identity** (device id, android id, phone id, UA). It is created once and
   deliberately **kept on logout**, so a later login does not look like a new phone. `instagram-sync.json` holds only per-chat "last delivered"
   timestamps.
Logout wipes local files first, then calls `POST /accounts/logout/`; if that fails, a plain-English message tells the user to end the session
in the Instagram app (Accounts Center > Where you're logged in).

## Behaving conservatively
* All API calls go through **one serial queue** with a minimum gap of 1.2 s + 0-100 % random jitter. No parallel bursts.
* **Polling is slow and jittered**: inbox every ~75 s (+-25 %) without realtime, every ~8 min as a safety net while realtime is up. Pending
  inbox (message requests) is checked only every 3rd-5th poll. Chat list is capped at 5 pages (100 threads); history at 4 pages per call.
* HTTP 429 / `rate_limit` opens a client-wide cooldown (`Retry-After`, default 5 min); `feedback_required` / `action_blocked` / `sentry_block`
  pause for 30 min. During cooldown no request leaves the process; user actions get "slow down, try again in N min"; an `error` event
  (`rate-limited` / `action-blocked`, non-fatal) is emitted once a minute at most.
* Network failures back off exponentially (20 s -> 15 min). Realtime reconnects 30 s -> 15 min, and after 4 failed connection attempts only every
  30 min; polling continues meanwhile.
* Typing is never sent by HTTP; it needs the realtime channel and is silently skipped otherwise.
* Disappearing (view-once) media is deliberately **not** downloaded (it would mark it as seen / look like a client behaviour no real app has).
* Media/avatar downloads go only to `*.cdninstagram.com`, `*.fbcdn.net`, `*.instagram.com` over https and **without credentials**; the API host
  can only be redirected to a loopback address (used by tests).
* Debug output (`UNIMSG_DEBUG=1`) contains only `METHOD /path-with-numbers-masked status ms`. Error text is fixed English text; server
  messages, response bodies, usernames, ids and message text are never copied into errors, events or logs (`secrets.test.ts`).

## Realtime
Instagram's app uses MQTT (dialect "MQTToT") over WebSocket to `edge-mqtt.facebook.com`. `mqtt.ts` implements the needed subset: a CONNECT
whose client-id slot carries a zlib-deflated compact-Thrift struct (device, user agent, subscribe topics, session as password), PUBLISH/PUBACK/PING,
deflated JSON payloads. After CONNACK it subscribes to "iris" with the `seq_id` / `snapshot_at_ms` from the last inbox fetch, then handles
`/ig_message_sync` operations (`add`/`replace`/`remove` on `/direct_v2/threads/<id>/items/<id>`, `has_seen` receipts) and `/pubsub` typing
indicators. If the realtime channel never works, the provider is simply a (slow) poller. `UNIMSG_IG_NO_REALTIME=1` disables it.

## Capabilities and mapping
| Capability | Status |
|---|---|
| reactions (any emoji, remove) | yes (`broadcast/reaction/`) |
| deletes ("unsend") | yes, own messages only |
| replies | yes (`replied_to_item_id`); incoming `replied_to_message` -> `replyTo` |
| attachments | send photo / video / voice note; receive photo, video, voice, GIF (mp4 -> `gif:true`), sticker |
| typing, readReceipts, markRead | receive typing (realtime), receive "seen" -> `receipt` read, `markRead` sends "seen" |
| startChat | existing conversation, else a **provisional chat** `new:<user pk>` (`provisional: true`): the first `send()` creates the thread (addressed by `recipient_users`) and returns a message with the real `chatId`; the Hub re-keys the chat |
| requests | `Chat.request`, `acceptRequest` (`/approve/`), `declineRequest` (`/decline/`), capability `requests`; replying still accepts |
| createGroup, renameChat, leaveChat | yes |
| backfill | yes (cursor paging, `beforeMessageId`) |
| avatars | yes: DM = the person's picture, `contact` = a member; groups have none |
| **false**: edits (Instagram has none), spaces, e2ee, manageMembers (add/remove), block, location sending, contact cards, polls, events, profile, privacy, refreshChat, sync |

Message mapping: `text`, `like` (heart), `link` (-> `Card` kind `link`), `media` (photo/video attachment), `voice_media` (voice + waveform downsampled to
64 bars), `animated_media` (GIF/sticker), `media_share` / `clip` (post / reel -> text "Shared a reel by @x" + `Card` kind `other` with
`https://www.instagram.com/{p|reel}/<code>/` + `Card.image`, a preview loaded through `downloadAttachment`, not an attachment), `story_share`, `reel_share` (**story reply / reaction / mention** -> "Replied to your
story: ...", "Mentioned you in their story", ...), `profile` (link card), `location` (-> `Message.location` when received), `action_log` (info notice),
`video_call_event` (call card), `placeholder`, `xma_*` (generic shared content card), `raven_media`/`visual_media` (view-once -> text placeholder).
Unknown types never fail: "[Unsupported Instagram message (type)]". Emoji reactions and the classic heart are merged into `reactions`.
Unsent messages arrive as `message-update {deleted:true}`.

Chats: id = `thread_id`; message ids = `item_id`; sender ids = user `pk`. Group = `is_group` or more than one other participant; name = thread
title, else the member names. `muted` / `archived` from the thread; **unread is approximated as 1 or 0** (Instagram gives no count; `unreadApprox: true` makes the UI show a dot) from
`read_state` / "last seen" vs. newest item. **Message requests** (pending inbox) are listed with `Chat.request: true`; sending a reply first calls `/approve/`, i.e. replying accepts the request. `mentions` are sent in groups (see below).

Delivery to the Hub: the first sync after a login and every message older than 15 min is delivered `historical:true`; a restart only delivers
messages newer than the stored per-chat timestamp. Hub dedup by (chat, id) makes re-delivery safe; ids we sent ourselves are pre-marked as seen.

## Features beyond messaging (all fixture-tested only)

| Feature | How | Verified? |
|---|---|---|
| Link previews when sending | a message with `http(s)` URLs goes to `broadcast/link/` (`link_text`, `link_urls`); Instagram builds the card, a received `link` item maps to a link card. Replies keep using `broadcast/text/` | endpoint from the app's behaviour, unverified |
| @mentions (groups) | `@Name` spans become `@username` and `mentioned_user_ids` is added to the text broadcast | **field name is a hypothesis**: if ignored the text still shows `@username` |
| Add / remove members | `threads/{id}/add_user/`, `threads/{id}/remove_users/` (`user_ids` JSON); groups only, removing needs group admin | endpoints from memory |
| Block / unblock | `friendships/block|unblock/{pk}/` for the person of a 1:1 chat | endpoint from memory |
| Privacy | one setting: private / public account (`accounts/set_private|set_public/`, state from `accounts/current_user/`) | endpoints from memory |

**Not implemented on purpose:** *edit own message* (Instagram added editing to its apps in 2025, but no edit endpoint is known to this client, so a guessed call would
be worse than none), *polls* (item format and create/vote endpoints unknown), *disappearing messages*. `edits` and `polls` stay false.

## Hypotheses (could not be verified against the real service)
Everything below is reconstructed from memory of public client behaviour and the fake server mirrors the same assumptions, so a green test run
proves internal consistency only.
1. Base host `i.instagram.com`, `/api/v1/...`, app id `567067343352427`, the UA / version `275.0.0.27.98` / bloks version string (these age; an old
   app version may be rejected with "update required").
2. `#PWD_INSTAGRAM:4` layout: `[1, keyId, iv(12), rsaLen(u16 LE), rsa(PKCS1 v1.5), tag(16), ciphertext]`, AAD = timestamp string; key from base64 PEM header.
3. Login body (`signed_body=SIGNATURE.<json>`), 2FA fields (`verification_method` 3 = TOTP, 1 = SMS), challenge flow (`choice`, then `security_code`),
   and the exact error markers (`bad_password`, `invalid_user`, `two_factor_required`, `checkpoint_challenge_required`, `login_required`).
4. Session in `ig-set-authorization` header (`Bearer IGT:2:...`) and `Authorization` on requests; `x-mid`, `ig-u-rur` rotation.
5. Inbox JSON shapes: `inbox.threads`, `oldest_cursor`, `has_older`, `seq_id`, `snapshot_at_ms`, `last_seen_at`, `read_state`, `archived`/`is_archived`
   (unsure of the archive field), microsecond timestamps, all item field names listed in `map.ts` (esp. `reel_share.type`, `story_share`, `xma_*`,
   `voice_media.media.audio`, `animated_media.images`).
6. Send endpoints and form fields: `broadcast/text|reaction|configure_photo|configure_video|share_voice`, `replied_to_item_id` +
   `replied_to_client_context`, `reaction_type=like` with `emoji`, ack shape `payload.item_id`, `rupload_igphoto|igvideo` params
   (`media_type` 1/2/11, `is_direct_voice`), `/items/<id>/delete/`, `/items/<id>/seen/`, `/threads/<id>/approve|leave|update_title/`,
   `/create_group_thread/`, `/threads/get_by_participants/`, `/users/search/`. Voice upload container format (m4a/AAC) and GIF sending are untested.
7. **Realtime is the least certain part**: MQTToT connect framing, the Thrift field ids in `buildConnectPayload`, numeric topic ids
   (146 message sync, 134/135 iris, 88 pubsub, 132/133 send), the iris subscribe payload, the `has_seen` / `activity_indicator_id` paths, and
   sending typing as `{action:"indicate_activity"}` on topic 132. If these are wrong, connect is refused, the provider logs one debug line, retries
   rarely, and polling carries on.
8. Retry / `Retry-After` behaviour and which responses mean "blocked" are guesses.

## Tests
`pnpm --filter @unimsg/provider-instagram test` (Node >= 22; `--experimental-strip-types`, so no parameter properties / enums in sources).
`fake-server.ts` is an in-process HTTP + MQTT-over-WebSocket server on 127.0.0.1 with a fake RSA key, fake users/threads and fixtures in a temp
directory; **no real host is contacted and no real credentials exist anywhere**. Covered: capabilities gating, login (confirmation, bad
password/user, 2FA, checkpoint), session/device files 0600 and persistence, logout, chat mapping (DM/group/request/muted/unread/avatars), history
paging, all item mappings, send (text/reply/photo/voice/video/caption), react/unsend/seen, message-request approval, startChat/createGroup/rename/leave,
realtime message/patch/unsend/receipt/typing, reconnect, refused realtime -> polling, polling-only mode, revoked session, rate-limit cooldown,
request pacing, device-id stability, thrift/MQTT/image-size units, and `secrets.test.ts` (no password, token, mid, message text, usernames, display
names, ids or server error text in errors, `error`/`account` events or `UNIMSG_DEBUG=1` output).
Test-only env: `UNIMSG_IG_BASE`, `UNIMSG_IG_MQTT` (loopback only), `UNIMSG_IG_PACE_MS`, `UNIMSG_IG_POLL_MS`, `UNIMSG_IG_RT_RETRY_MS`, `UNIMSG_IG_NO_REALTIME`.

## Contract changes (done) / next steps
* Done: `Chat.request`, `acceptRequest/declineRequest`, provisional `startChat`, `unreadApprox`, `Card.image`, login `checkbox` + `warning`.
* Mode B (Business accounts): a second provider or login kind with a webhook receiver, which needs a public HTTPS endpoint; out of scope here.
* Not done: removing/adding group members, block, sending GIFs from Giphy, profile editing, `refreshChat`.

## Host registration (not done here)
Register the factory like the other providers (`@unimsg/provider-instagram`, default export), add an icon/label, and add `ws` to whatever
the Electron bundle treats as external, as for Mattermost.

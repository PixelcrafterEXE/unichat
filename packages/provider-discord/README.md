# @unimsg/provider-discord

Discord for UniChat: servers become Spaces, channels / threads / forum posts / DMs / group DMs become Chats. REST v10 and Gateway v10 are
implemented in about 600 lines on Node's `fetch` and `ws` (no discord.js).

## The reality (read this before logging in)

There are two ways in, and they are **not** equally allowed.

| | Bot token | User account token |
|---|---|---|
| Allowed by Discord | **Yes**, this is the official API | **No.** Automating a personal account ("self-botting") violates Discord's Terms of Service. Accounts get suspended or terminated, sometimes without warning. |
| Sees | Only the servers the bot was invited to, and DMs *with the bot* | Everything you see: your servers, your DMs, your group DMs |
| Needs | A bot in the Developer Portal | A token you extract yourself from your own logged-in client |

* **User mode is an explicit opt-in.** The login form shows the warning in a prominent box and its **required checkbox** must be ticked (the UI refuses to submit otherwise; the
  provider also refuses user mode unless the `confirm` value is `true`, or the legacy `YES`). Nothing is sent to Discord before that.
* **UniChat does not log in with a password** and has no password / MFA / token-extraction code (the one captcha it relays is described below). You paste a token you obtained yourself.
  UniChat does not tell you how to extract it.
* We reduce the risk (see "Behaving conservatively") but **cannot remove it**. Use a throw-away or test account if you can. If the
  account matters to you, use a bot token or the official app.
* Logging out of UniChat only deletes the local copy. It cannot revoke the token: reset the bot token in the Developer Portal, or change
  the account password (that invalidates user tokens).

## Logging in

The form has three fields: `mode` (`bot` or `user`), `token` (password field), and `confirm` (a required checkbox, sent as `"true"`; enforced server-side for user mode).

Bot setup: Developer Portal > New Application > Bot > copy the token. On the same page enable the privileged
**Message Content Intent** (otherwise server messages arrive without their text; UniChat detects the refusal, keeps working, and tells you).
Invite the bot with the `bot` scope and at least *View Channels, Read Message History, Send Messages, Add Reactions, Attach Files*.
The Server Members intent is optional: without it the member list shows only people who have written in the channel.

The token is validated with one `GET /users/@me`, then stored **sealed** (AES-256-GCM) in `discord-session.json` (0600). The key is
`UNIMSG_DISCORD_KEY` (if set) or a random key in `discord-session.key` (0600). This keeps the token out of plain-text greps and backups
of the single file; it does **not** protect against someone who can read the whole data directory unless you provide
`UNIMSG_DISCORD_KEY`. User mode also keeps `discord-identity.json` (0600): the fixed client identity (see below).

## Behaving conservatively

Always: one request in flight at a time (priority queue: things the user clicked first, background lookups later), per-bucket
`X-RateLimit-Remaining/Reset-After` honoured, 429 uses `Retry-After` / body `retry_after` / `X-RateLimit-Global`, waits are capped (a
longer wait fails the call with a plain message instead of hanging the UI), IDs / texts / tokens never in errors or debug output.

User mode additionally:
* **Stable identity**: one browser-like User-Agent, `X-Super-Properties`, locale generated at first login and never changed.
* **Human-like pacing**: 700 ms minimum gap between requests plus up to 100 % random jitter. After any 429 the pace triples for 10 minutes
  and the user gets an `error` event. Only one retry after a 429; a non-JSON 429 (a block page) is treated as a long cooldown and calls
  fail fast instead of retrying.
* **No unnecessary endpoints**: servers, channels, roles, own member data and read state come from the gateway (`READY` /
  `GUILD_CREATE`), not from per-server REST calls. No chat-list preview prefetch. No member listing or searching. No presence, no
  profile reads of strangers. DMs by username only match people already seen in this session; otherwise use the numeric user id.
* The gateway never reconnects faster than 3 s * 2^n (cap 60 s), prefers RESUME to IDENTIFY, enforces 5.5 s between IDENTIFYs and backs
  off 10 minutes after 6 IDENTIFYs in an hour.
* Presence is announced as `online` while UniChat is connected (that is what a client does).

## Realtime

Gateway v10 over `ws`, JSON, optional `zlib-stream` (default on; `UNIMSG_DISCORD_ZLIB=0` turns it off). HELLO -> jittered first heartbeat
-> IDENTIFY (bot: intents; user: capabilities + properties) or RESUME. A missing heartbeat ACK terminates and resumes. `RECONNECT` and
`INVALID_SESSION` follow the documented behaviour (random 1-5 s wait, identify afresh if not resumable). Close codes: 4004 -> `needs-login`
and the stored token is wiped; 4014 -> Message Content intent dropped and the user told; 4007/4009 -> new session; 4008 -> long wait.
If a session cannot be resumed, chats that moved while away are topped up with `after=` pages delivered as `historical: true`
(no notification). Events handled: `MESSAGE_CREATE/UPDATE/DELETE(_BULK)`, `MESSAGE_REACTION_ADD/REMOVE/REMOVE_ALL/REMOVE_EMOJI`,
`MESSAGE_POLL_VOTE_ADD/REMOVE`, `TYPING_START`, `CHANNEL_*`, `THREAD_*`, `GUILD_*`, `GUILD_ROLE_*`, own `GUILD_MEMBER_UPDATE`,
`GUILD_EMOJIS_UPDATE`, `MESSAGE_ACK` (user mode), `READY`, `RESUMED`.

## Capabilities and mapping

| UniChat | Discord |
|---|---|
| Space | Server (guild); icon via `avatar({kind:"space"})` |
| Chat `channel` | text channel, announcement channel (read-only unless you may post), thread, forum post / media post |
| Chat `dm` / `group` | DM, group DM (user mode; a bot only gets DMs written to it) |
| not a chat | voice, stage, category, forum container (their posts are chats) |
| Category | `Chat.category` = the parent category's name (threads: their parent's category, description says `Thread in #parent`); `chats()` is returned in Discord's own order; server channels carry `canManage: false` |
| Permissions | `VIEW_CHANNEL` missing -> hidden; `SEND_MESSAGES` (threads: `SEND_MESSAGES_IN_THREADS`) missing, locked/archived thread, timed-out member -> `readOnly`. Full overwrite maths (owner, administrator, @everyone, roles, member). Archived threads are not listed. |
| Unread | user mode: from `read_state` at READY (mention count, else 1 when behind) + local increments + `MESSAGE_ACK` from other clients. Bot mode: counted locally while running, reset by `markRead`. |
| Mentions | `<@id>` `<@&id>` `<#id>` -> `@name` `@role` `#channel` (markdown otherwise untouched; `<t:..>` -> UTC time) |
| Custom emoji | `<:n:id>` / `<a:n:id>` -> `:n:` everywhere (text, reactions, polls); name -> id map feeds `avatar({kind:"emoji", id:name})` (png/gif from the CDN); outgoing `:n:` of a known emoji is converted back |
| Reply | `message_reference`; preview from `referenced_message` |
| Forward | `message_snapshots` -> `forwarded: true` |
| Attachments | files by content type, voice messages (`voice` with waveform + duration), stickers (PNG/APNG/GIF as `sticker`; Lottie stickers are named in the text), Tenor / Giphy `gifv` embeds as video `gif: true`, embed images/thumbnails as `image` |
| Embeds | one `Card` per embed in `Message.cards` (title, subtitle = author/provider, body, footer, url, fields as rows; `link`/`article`/`video` embeds are kind `link`) with `Card.image` = the embed image / thumbnail (`layout: "thumb"` for thumbnails), loaded through `downloadAttachment` (id `e<i>i`, allow-listed CDN hosts, never hot-linked) |
| Polls | `Poll` incl. multiple choice / closed / mine; sending a poll (24 h); `vote()` in user mode only |
| System messages | joins, pins, boosts, calls, group renames, thread starts, AutoMod, poll results -> `system: {kind:"info"}` |
| Reactions | `react(emoji | null)` unicode and custom; Discord only reports *counts*: `senderIds` holds the reactor ids we know, `Reaction.count` the exact total (no fake ids). Poll options likewise (`Poll.options[].count`) |
| Send | text, reply, multipart attachments, poll; `allowed_mentions` = users only (never `@everyone`/roles); structured `OutgoingMessage.mentions` become real `<@id>` (users only, validated); a typed `@username` of a person seen this session still works |
| Voice notes | send: one `audio/ogg` attachment with flag `1<<13`, `duration_secs`, base64 `waveform` (bytes), no text; mixed with text/files it is sent as a plain audio file |
| Group DMs (user mode) | `createGroup` (`POST /users/@me/channels {recipients}` + name), `renameChat`, `addMembers`/`removeMember` (`/channels/{id}/recipients/{user}`); bots and server channels are refused |
| Edit / delete | own messages |
| Typing | `POST /typing`, throttled to once per 8 s per chat |
| `markRead` | user mode: `POST .../ack` (only when something is unread); bot mode: local counter only |
| `startChat` | `POST /users/@me/channels`; handle = numeric id, `<@id>`, or a username already seen (bots also search up to 5 servers) |
| `leaveChat` | DM / group DM: close / leave; thread: leave; server channel: refused with an explanation. `leaveSpace` leaves the server. |
| `members` | DM / group DM: participants. Server channel: bot with the Server Members intent: first 100 members filtered by `VIEW_CHANNEL`; otherwise (and always in user mode) people seen writing in the channel. Never the full list of a big server. |
| `avatar` | users, servers, group DM icons, custom emoji from `cdn.discordapp.com`; media hosts are allow-listed and never receive the token |

**Capabilities are per account** (`connector.capabilities` is a getter, published by the Hub as `Account.capabilities`):

| | bot | user |
|---|---|---|
| `pollVote` (vote in polls) | no | yes |
| `createGroup` / `manageMembers` / `renameChat` (group DMs) | no | yes |
| `markRead` | local counter only | real ack |
| `voiceNotes`, `mentions`, `polls` (send), `reactions`, ... | yes | yes |
| `chatDescription` (channel topic, needs Manage Channels; the UI offers it only where `Chat.canManage`), `renameChat` of a server channel (same permission, user mode) | topic only | yes |
| `events` / `eventEdit` (scheduled "external" events with a place; the message carries the event link + an event card; needs Manage Events) | yes | yes |
| `profile` (name: bots change their username, users their display name; picture; **about me: user only**) | name + picture | name + about + picture |
| `chatPicture` (group DM icon), `block` (DM -> relationship type 2), `privacy`, `createSpace`, `joinSpace` (invite code or link) | no | yes |

Declared `false` in both modes: `e2ee`, `readReceipts`, `sync`, `refreshChat`, `location`, `contactCards`. **Link previews** need nothing from the client: Discord unfurls links itself and the embed arrives as a message update (shown as a link card).

All of these go through the paced request queue (user mode: jittered gaps, 10-minute slow-down after any 429). Joining and creating servers is the kind of
action Discord's anti-abuse system watches closely (captcha / "verify your account"): do it with an account you can afford to lose, or in the app.

### Captcha when you message someone new (user mode, best-effort)

When Discord answers a request of a user account with `400 {"captcha_key":["captcha-required"], ...}` (typically opening a DM with a new person), UniChat shows the
hCaptcha challenge in a "Discord wants to check that you are human" dialog, takes the solved token and **retries that one request once** with the headers Discord clients
send (`X-Captcha-Key`, `X-Captcha-Rqtoken`) and the same body. The hCaptcha script is loaded from `js.hcaptcha.com` only when the dialog opens. The token, site key and
rqtoken are never logged, stored or put into error text. Cancelling, a timeout (about 3 minutes), a refused answer or a background job produce the plain explanatory
error instead. **Uncertain:** Discord's site key is configured for discord.com, so hCaptcha may refuse to render it on other origins; the dialog then says so and offers
"Open Discord instead" (solve it in the official app, then try again). Using a user token breaks Discord's Terms of Service whatever the captcha does. This is verified
only against the fake server, never the real service.

## Hypotheses (could not be verified against the real service)

Everything here is written from memory of public documentation and community notes. Nothing was run against Discord.
* **User-only management calls**: `PATCH /users/@me/profile {bio}` (about me), `GET /users/{id}/profile`, `PUT/DELETE /users/@me/relationships/{id}` (block), `GET/PATCH /users/@me/settings` (`friend_source_flags`, `default_guilds_restricted`, `explicit_content_filter`; the real client increasingly uses the protobuf settings instead), `POST /guilds`, `POST /invites/{code}`. Bot-side calls (channel topic, group/channel PATCH, scheduled events, `PATCH /users/@me`) are the documented ones.
* **User-mode READY shape**: that `guilds` carry channels/roles/threads, that `merged_members[i][0]` is our own member for `guilds[i]`,
  `private_channels[].recipient_ids` + `users`, and `read_state.entries[] {id, last_message_id, mention_count}`. If the real shape
  differs, user mode degrades to: no unread numbers, no permission hiding (everything the gateway sends is shown), DMs only after a message.
* **User IDENTIFY**: `capabilities: 16381`, the `properties` set, `client_state`, that no `intents` is sent. An outdated value may be
  rejected (close 4004/4012/4013) or make the account look unusual.
* **`X-Super-Properties` / User-Agent** content and `client_build_number` are placeholders; a real client sends current values.
* **Ack body** `{token: null}` for `POST /channels/{c}/messages/{m}/ack`; **poll voting** `PUT /channels/{c}/polls/{m}/answers/@me`
  `{answer_ids}`. Both only in user mode.
* **Bot member list** `GET /guilds/{id}/members?limit=100` needs the privileged Server Members intent; a 403 is handled silently.
* `GET /guilds/{id}/members/{botId}` for the bot's roles; GUILD_CREATE channels for bots contain hidden channels (we filter ourselves).
* Poll field names (`poll.question.text`, `answers[].poll_media`, `results.answer_counts`), forwarded messages (`message_reference.type`
  1 + `message_snapshots`), voice-message flag `1 << 13` and `waveform` base64 encoding, sticker CDN paths (`cdn/stickers/{id}.png|gif`; we
  use `media.discordapp.net/stickers`), Tenor `gifv` embeds (`video.url`).
* Intents bit values, close codes 4004/4007/4008/4009/4010-4014, zlib-stream suffix handling (`00 00 ff ff` + sync flush).
* Rate-limit headers: `X-RateLimit-Remaining/Reset-After/Global`, `Retry-After`; non-JSON 429 = Cloudflare block.
* Archived threads / forum posts that are not active are not listed (Discord needs extra calls for them).

## Tests

`pnpm --filter @unimsg/provider-discord test` runs offline against `src/fake-server.ts`: an in-process fake Discord (HTTP v10 + gateway ws,
optionally zlib-stream) on 127.0.0.1 with fake tokens and fixtures in temp dirs. **No test contacts any Discord host**; endpoint
overrides are honoured only for loopback addresses. Covered: capability gating, loopback/CDN/gateway allow-lists, login gate (mode, YES,
bad tokens, nothing sent before acknowledgement), sealed 0600 storage, bot and user mode lists/permissions/DMs, permission maths, history
paging and every message mapping, live events, sending/edit/delete/reactions/polls/typing, startChat/members/leave, heartbeat,
RESUME, fresh IDENTIFY + historical catch-up, INVALID_SESSION, intent fallback, revoked token -> `needs-login`, pacing / 429 /
block-page behaviour, and `secrets.test.ts` (no token, message text, names or ids in errors, events or `UNIMSG_DEBUG=1` output).

Env (loopback only unless noted): `UNIMSG_DISCORD_BASE`, `UNIMSG_DISCORD_GATEWAY`, `UNIMSG_DISCORD_CDN`, `UNIMSG_DISCORD_PACE_MS`,
`UNIMSG_DISCORD_ZLIB`, `UNIMSG_DISCORD_KEY` (any, secret), `UNIMSG_DISCORD_GW_FAST` (tests; ignored for non-loopback gateways).

## Contract changes (done)

`Chat.category`/`canManage`, `Reaction.count` + `Poll.options[].count`, `Card.image` + `Message.cards[]`, per-account capabilities (`Account.capabilities`),
`OutgoingMessage.mentions`, login `checkbox` + `warning`. Still open: voice-message permission pre-check (`SEND_VOICE_MESSAGES`), voter lists for polls.

## Host registration (not done here)

Add `import discord from "@unimsg/provider-discord"` to `packages/host/src/index.ts` and the provider list; add `@unimsg/provider-discord` to
the host's dependencies; list `ws` where the Electron build externalises it (as for Mattermost); brand icon for the account picker.
- Pinned messages: `PUT/DELETE /channels/{id}/pins/{message}`, `GET /channels/{id}/pins`, `MESSAGE_UPDATE {pinned}`. Fake-verified only.

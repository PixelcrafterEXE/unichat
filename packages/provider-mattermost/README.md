# @unimsg/provider-mattermost

Mattermost provider for self-hosted servers (REST API v4 + WebSocket events, server 6.x-9.x). No SDK: Node's `fetch` plus `ws` 8.22.2.
**Never run against a real server.** It is verified only by typecheck and offline tests against an in-process fake server (see Tests). The endpoint
shapes follow the public Mattermost API reference; the first real run may reveal differences (see "Testing against communicating.tuhh.de").

## Logging in (SSO / SAML / LDAP / password)
The login form asks for: **server** (`communicating.tuhh.de` or a full URL; https by default, plain http only for localhost), **login + password**,
and/or a **token**. Leave the token empty for password login (LDAP and email/username accounts; an MFA code is requested in a second step if the server
wants one). Before logging in, UniChat reads `GET /api/v4/config/client?format=old` to see which login methods exist and tailors the error text.

Many universities disable password login (SAML / GitLab / Shibboleth). Then use a token instead:
1. **Personal access token** (best): in Mattermost, Profile > Security > Personal Access Tokens > Create (only if the admin enabled
   `EnableUserAccessTokens` and gave you the permission; otherwise the menu entry does not exist).
2. **MMAUTHTOKEN cookie**: sign in with your browser as usual, open developer tools > Application/Storage > Cookies > the server, copy the value of
   `MMAUTHTOKEN`. Paste it into the token field. It is a normal session: it ends if you sign out in the browser or the server's session length expires
   (then UniChat shows a fresh login form).

The session (server URL + token) is stored in `dataDir/mattermost-session.json` with mode 0600; restart restores it without a prompt. Any HTTP 401 ->
session wiped, account `needs-login`, new form prompt. Passwords are never stored. Logout calls `POST /users/logout` only for tokens obtained by password
login (never for a pasted token, which would also kill your browser session or is not ours to revoke).

Self-signed / internal CA servers: not supported through a form switch (disabling TLS verification is a risk and Node's fetch has no per-request
switch without extra dependencies). Start UniChat with `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` instead.

## Permissions
Ordinary user permissions suffice for reading, posting, reacting, editing/deleting own posts. A personal access token acts with your permissions.
Adding/removing members, renaming and leaving channels need the matching channel/team permission; a 403 is shown as "you do not have permission
to ... (ask a channel or team admin)". Profile edits may be refused when the field is managed by LDAP/SAML.

## Mapping
| Mattermost | UniChat |
|---|---|
| team | `Space` (id = team id; icon via `avatar({kind:"space"})`, only when a custom icon exists) |
| public / private channel (`O`/`P`) | `Chat` kind `channel`, `spaceId` = team id. Name = `display_name`; description = purpose, else header |
| direct message (`D`) | kind `dm`, no space, name = other user per the server's teammate name display (`full_name` / `nickname_full_name` / `username`; the user's own `display_settings/name_format` preference wins), fallback username |
| group message (`G`) | kind `group`, no space, name = server `display_name` ("a, b, c") |
| archived channel | hidden by the server by default; if one shows up (`delete_at != 0`) it is `readOnly` |
| `notify_props.mark_unread == "mention"` | `muted` |
| unread | `total_msg_count - member.msg_count` (from `/users/me/channels` + `/users/me/channel_members`) |
| post | `Message` (id = post id). Thread replies appear flat with `replyTo` (root id, root sender + 120-char preview) |
| `metadata.files` | `attachments` (kind from mime; name, size, width/height) |
| `metadata.reactions` | `reactions` grouped by emoji, `senderIds`, `mine` |
| `edit_at` / `delete_at` | `editedAt` / `deleted` |
| `metadata.embeds` opengraph / permalink | `Message.card` kind `link` |
| `system_join_channel`, `..._leave_...`, `..._add_to_channel`, `..._remove_from_channel`, header/purpose/rename/archive | `Message.system {kind:"info"}` with a short English text; other system posts hidden |

Emoji: `src/emoji.ts` maps ~190 common names (`+1`/`thumbsup`, `heart`, `joy`, ...) to unicode and back; unknown names (custom emoji) become `:name:`;
`react()` accepts unicode or `:name:`. Skin-tone suffixes are dropped.

Previews are fetched with one request each for the 30 most recently active chats at connect time, then kept current from live events.
Users are cached (max 5000) and looked up in batches (`POST /users/ids`), never one request per message.

## Real time
WebSocket `/api/v4/websocket` with `Authorization: Bearer` header, `Origin` header set to the server origin (proxies), and an
`authentication_challenge` message as a fallback. Handled: `posted` (own sends are suppressed via `pending_post_id` + post-id dedupe; own posts from
another device are delivered as `fromMe`), `post_edited`, `post_deleted`, `reaction_added/removed`, `typing` (auto-expires after 6 s), `channel_viewed`,
`multiple_channels_viewed`, `channel_created/updated/deleted`, `direct_added`, `user_added/removed` (for me), `user_updated`, `preferences_changed`,
team events. `hello` marks the account connected. Ignored: `status_change` (presence), `new_user`, everything else.
Reconnect: exponential backoff 1 s .. 60 s with jitter; the account shows `disconnected`. On reconnect everything is reloaded and, for each channel
whose `last_post_at` is newer than the newest post seen, `GET /channels/{id}/posts?since=` delivers missed posts (as messages), edits, deletions and
reactions. REST rate limiting: HTTP 429 and `X-RateLimit-Reset` / `Retry-After` are honoured (waits up to 60 s, 3 retries); at most 4 requests in flight.

## Capabilities / behaviour notes
spaces, reactions, edits, deletes, replies, attachments, typing, startChat, createGroup, backfill, leaveChat, manageMembers, renameChat, avatars,
refreshChat, sync = true; profile = displayName (reads nickname, else first+last, else username; writes **nickname**), about (= `position`), avatar.
`readReceipts = false` (Mattermost has none). `markRead` IS implemented (`POST /channels/members/me/view`) but the current UI only calls it when
`capabilities.readReceipts && settings.sendReadReceipts` - see "Contract issues" in the report: unread counters will not clear from UniChat until that is fixed.
- `react(null)` removes ALL of my reactions on that post (the contract does not say which one). Adding a reaction does not remove others.
- `createGroup`: group messages have no name (ignored) and 3-8 people including you. Channel creation in a team is not offered (the contract has no team context).
- `leaveChat` on a DM/GM hides it (preference `direct_channel_show` / `group_channel_show` = false) because Mattermost cannot leave them.
- Attachments: uploaded with `POST /files`, size checked against `MaxFileSize`.
- Edited text / reactions arrive through the WebSocket (as events); if the socket is down they appear after the next catch-up.

## Not supported
Channel categories / favourites, custom status, polls, locations, contact cards, block, joining/creating channels (teams: see below), threads view
(replies are flat), collapsed-reply-thread unread semantics (reply posts are not counted in channel unread), slash commands, interactive message
attachments (Slack-style `props.attachments` are not rendered), file thumbnails, `/users/me/teams/unread` (counts come from the channel members instead),
pinned posts, drafts, scheduled posts, calls, boards/playbooks, bots' rich content.

## Debugging
`UNIMSG_DEBUG=1` prints counts only (teams/channels loaded, reconnect delays, catch-up count, server major version) to stderr. Never message text, tokens,
passwords, user names or ids. Error texts contain only HTTP status and Mattermost's error id (e.g. `api.context.session_expired.app_error`).

## Testing against communicating.tuhh.de (step by step, you never show me the token)
1. In a browser sign in to https://communicating.tuhh.de. Either create a token (Profile > Security > Personal Access Tokens > Create Token; if the entry is
   missing your admin disabled it) or copy the `MMAUTHTOKEN` cookie value (developer tools > Application > Cookies).
2. In UniChat: Add account > Mattermost. Server: `communicating.tuhh.de`. Leave login and password empty, paste the token. Submit.
3. Expected: the account turns "connected" within a few seconds; your teams appear as spaces, their channels inside, DMs/group messages in the DM list; unread
   counts roughly match the browser; open a channel and older messages load when scrolling; send a test message to yourself (DM with yourself) and see it
   once; edit, react, delete it; a message sent from the browser shows up live.
4. If something fails, send me (without any token): the text of the error shown in the form or the account status; the output of UniChat started with
   `UNIMSG_DEBUG=1` (it contains no secrets - counts and HTTP status/error ids only; skim it once anyway); the Mattermost server version (Help > About);
   which step above failed. If login fails with "rejected this token", the token expired/was revoked or tokens are disabled: generate a new one.
5. To log out: remove the account in UniChat (this deletes `mattermost-session.json`); revoke a personal access token in Mattermost if you want it dead.

## Mentions and teams (added; fake server only)
- **@mentions when sending**: the composer's structured mentions are turned into plain `@username` text (Mattermost parses them server-side and notifies). Unknown ids / unsafe usernames stay as typed.
- **Teams = communities**: `createSpace(name, description)` (`POST /teams`, private/invite-only type `I`, URL name derived from the title, retried with a suffix if taken; needs the "create teams" permission), `joinSpace(input)` accepts a team name, a team URL (`https://host/team/...`) or an invite link (`.../signup_user_complete/?id=INVITE`); open teams join directly, closed ones need the invite link. `leaveSpace(id)` (`DELETE /teams/{id}/members/me`). After each, teams and channels are reloaded (`spaces-changed` + `chats-changed`).
- **Link previews**: Mattermost's server builds them from the post text (when enabled in the server's settings), so a client has nothing to send; received previews appear as link cards.
- **Disappearing messages**: Mattermost has no per-chat timer for normal posts (burn-on-read exists only in the Enterprise advanced-permissions edition and is not reachable through the public API for a third-party client): Unsupported.

## Tests
`pnpm --filter @unimsg/provider-mattermost test` (offline): `src/fake-server.ts` is a fake Mattermost (http + ws on 127.0.0.1) used by
`connector.test.ts` (login password/MFA/token/bad token/SSO-only, session restore + 401, mapping, unread, history paging, threads, send/reply/attachment/
edit/delete/react, WS events, reconnect + since catch-up, 429, avatars, group/member management, profile) and `secrets.test.ts` (no token, password, user
name or message text in error text, error/account events or debug output). `pnpm typecheck` for types.
- Pinned posts: `POST /posts/{id}/pin|unpin`, `GET /channels/{id}/pinned`, `is_pinned` via `post_edited` (a pin is not shown as an edit). Fake-verified only.

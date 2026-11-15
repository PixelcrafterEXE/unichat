# @unimsg/provider-teams

Microsoft Teams for UniChat through **Microsoft Graph v1.0** with *delegated* permissions (you act as yourself; no bot, no tenant admin
tool). Teams become Spaces; team channels, 1:1 chats, group chats and meeting chats become Chats. No dependencies beyond Node's `fetch`.

**Status: written against the documented Graph API and tested only against a local fake server. It has not been run against a real tenant** (see "Hypotheses").

## Receiving messages is POLLING, not push

Graph change notifications need a public HTTPS webhook, which a desktop app does not have. UniChat therefore polls with *delta queries*:

* every ~20 s (60 s when idle for 15 min) one request to `/me/chats` ordered by last message: finds new chats, new messages, read-state changes;
* chats with activity (open/recently used/just changed) are polled with `/chats/{id}/messages/delta` about every 10 s;
* other chats only every 5 min or more, and channels every 60 s or more (the interval grows with the number of chats; at most 2 requests per 5 s tick);
* all intervals are jittered by +-20 %; one request in flight; `429 Retry-After` is honoured (polling pauses, a notice is shown); failures back off exponentially (account shows "disconnected" after 3).

Consequences: new messages in a *busy* chat arrive within about 10 s, in an idle chat within the list interval (~20 s). Edits/reactions in an
idle chat appear when the chat becomes active, is opened, or on its slow sweep (minutes). Typing indicators and read receipts do not exist in Graph.
After a restart messages missed meanwhile are delivered with `historical: true` (no notifications).

## Creating the app registration (once, ~5 minutes)

UniChat ships **no client id**: Microsoft ties permissions to an app registration, so you create your own (or use one your organisation allows).

1. Sign in at <https://entra.microsoft.com> with your work account, **Identity > Applications > App registrations > New registration**.
2. Name `UniChat`, supported account types *Accounts in this organizational directory only* (or multi-tenant if you need it). No redirect URI needed.
3. **Authentication**: under *Advanced settings* set **Allow public client flows = Yes** (required for the device code flow). Save.
4. **API permissions > Add a permission > Microsoft Graph > Delegated permissions**, add:
   `User.Read`, `User.ReadBasic.All` (names and photos of other people), `Chat.ReadWrite`, `ChatMessage.Send`, `Team.ReadBasic.All`,
   `Channel.ReadBasic.All`, `ChannelMessage.Send`, `offline_access`, and optionally
   * `ChannelMessage.Read.All` (read channel messages; **needs admin consent** in many tenants),
   * `Files.Read.All` + `Files.ReadWrite` (open attachments / upload files),
   * `ChannelMember.Read.All` (channel member lists; otherwise only people who wrote are listed).
5. If your tenant requires it, ask an admin to **Grant admin consent** (needed for `ChannelMessage.Read.All`). Many tenants also restrict who may
   register apps or consent: then ask your IT department for an approved client id.
6. Copy the **Application (client) ID** from the Overview page.

## Logging in

Add a Teams account in UniChat, enter the client id (required), optionally the tenant (empty = `organizations`; or a tenant id / domain), and tick
the optional boxes only for permissions you added and have consent for (requesting a permission that needs unapproved admin consent makes Microsoft's sign-in fail).
UniChat shows a **code and a link**; open the link (microsoft.com/devicelogin), enter the code, sign in. No callback address is needed.
If sign-in is declined, expires, or the client id is wrong, the form comes back with a plain message.

Tokens: the refresh token (and cached access token) is stored **sealed** (AES-256-GCM) in `teams-session.json` (0600); the key is
`UNIMSG_TEAMS_KEY` (if set) or a random key in `teams-session.key` (0600). That keeps tokens out of plain greps and file backups but does **not**
protect against someone who can read the whole data directory; set `UNIMSG_TEAMS_KEY` or use disk encryption for that. Access tokens are refreshed
silently (single-flight, rotated refresh tokens saved). If the grant is revoked/expired (password change, admin revoke, 90 days unused) the account
goes to **needs-login** with a fresh prompt. Logout deletes local files only; to revoke the grant remove the app at <https://myapplications.microsoft.com> (Profile > Manage apps).

## What works

| Feature | How |
|---|---|
| Spaces / chats | `/me/joinedTeams`, `/teams/{id}/allChannels` (fallback `/channels`), `/me/chats?$expand=members,lastMessagePreview`. Chat names: topic, else other members' names. Meeting chats in category "Meetings"; private/shared channels in categories. Chat ids are native (`19:..`); channel chat ids are `<teamId>/<channelId>`. |
| History | newest-first pages (`$top`, `@odata.nextLink`, `$filter createdDateTime lt`) returned oldest-to-newest; channel replies via `$expand=replies` (flattened, `replyTo` = parent). Always `historical: true`. |
| Messages | HTML to text (mentions as `@name`, links, lists, emoji), reactions (like/heart/laugh/surprised/sad/angry + Unicode), replies (`messageReference`), files (reference attachments), inline images (hostedContents), GIFs/stickers, adaptive/hero cards as `other` cards, edits, deletes, system events (members added/removed, renamed, call ended...) as `info` system messages, importance as `[Important]`/`[Urgent]` prefix. |
| Sending | text (escaped, line breaks), @mentions, replies (channel: `/replies`; chat: quote attachment), reactions, edit, delete (`softDelete`), mark read (`markChatReadForUser`), startChat (work email), createGroup (>= 2 others), rename, add/remove members, leave group chat. |
| Attachments out | images <= 4 MB inline (`hostedContents`, no extra permission). Other files <= 100 MB (Graph documents 250 MB) by simple OneDrive upload (`Microsoft Teams Chat Files`, or the channel's files folder) + organisation view link; needs `Files.ReadWrite`. No resumable upload sessions. |
| Avatars | `/users/{id}/photo/$value` (people, 1:1 chats), `/teams/{id}/photo/$value` (usually 403 without `Group.Read.All`; then none). Misses are cached. |

Optional, switched on only by the login boxes (the capability exists only when Microsoft really granted the scope; without it nothing is sent):

| Login box | Scope | What it enables |
|---|---|---|
| "change my profile picture and about text" | `User.ReadWrite` | `updateProfile`: picture (`PUT /me/photo/$value`, JPEG/PNG <= 4 MB) and about-me (`PATCH /me {aboutMe}`). The display name is managed by the directory and is not offered; Graph cannot remove a picture |
| "create teams" | `Team.Create` (admin consent in most tenants) | `createSpace`: `POST /teams` (standard template), follows the async operation until it succeeds |

Not supported (capabilities false, nothing faked): typing indicators, read receipts, polls, locations, contact cards, blocking, group pictures and descriptions (Graph has no API for chats), joining teams (invite links only), leaving teams, privacy settings, link previews (Graph does not unfurl), e2ee. 1:1 and meeting chats cannot be left/renamed; team channels are managed in Teams.

Without `ChannelMessage.Read.All` channels are listed but empty (one notice is shown); sending still works with `ChannelMessage.Send`.
Without `Team.ReadBasic.All` only chats are shown.

## Hypotheses (could not be verified against the real service)

* `$expand=replies` on the channel message list (falls back to no replies on HTTP 400).
* `$orderby/$filter` on `createdDateTime` for channel messages and `lastModifiedDateTime gt` as the first delta filter; channel delta including replies.
* Chat replies via a `messageReference` attachment in `POST /chats/{id}/messages` (known from beta behaviour).
* `PATCH` edit of channel messages and replies in v1.0; `leaveChat` by deleting your own membership; `/shares/u!{base64url}/driveItem/content` for downloads (needs `Files.Read.All`).
* GIF/sticker markup (`<img>` from giphy/tenor/Microsoft hosts, fetched without auth); adaptive card parsing is best-effort.
* Reaction Unicode in `setReaction` is accepted by v1.0.
* `$expand=members` on `/me/chats` returns all members for chats of reasonable size.
* `PATCH /me {aboutMe}` accepted for work accounts with `User.ReadWrite`; `POST /teams` answering 202 with `Content-Location`/`Location` headers; `GET /teams/{id}/operations/{id}` reporting `succeeded`.

## Safety

The Graph token is sent only to the Graph origin (`@odata.nextLink`s to other hosts are refused; redirects for downloads are followed without the token and only to Microsoft/SharePoint hosts). Public media (GIFs) is fetched without credentials from an allow-list.
Errors and `UNIMSG_DEBUG=1` output contain only method, masked path and status: never tokens, message text, names or ids; server error bodies are never surfaced.

## Testing offline

`pnpm test` runs against `src/fake-server.ts` (fake Entra + Graph on 127.0.0.1, fake tokens, temp dirs). `UNIMSG_TEAMS_AUTH` / `UNIMSG_TEAMS_GRAPH` redirect
endpoints but are honoured **only for loopback addresses**. Other knobs: `UNIMSG_TEAMS_POLL_MS` (tick, default 5000), `UNIMSG_TEAMS_PACE_MS` (gap between requests, default 250), `UNIMSG_TEAMS_DEVICE_POLL_MS` (loopback only).
Sovereign clouds (GCC High, China) are not supported yet.

## Trying it with your own account, safely

1. Do the app registration above using a test or your normal work account; start with only the base permissions (leave both boxes unticked).
2. Add the account, enter your client id, open the link, enter the code. Check that your chats appear and that a message sent from another device arrives within ~10-20 s.
3. Send a test message to yourself or a colleague who agrees; try a reaction, an edit, a delete.
4. Only then, if allowed, add `ChannelMessage.Read.All` / Files permissions (admin consent) and tick the boxes after signing out and in again.
5. Never share tokens or `teams-session.*` files; remove the app consent at myapplications.microsoft.com when done. Run with `UNIMSG_DEBUG=1` if something fails: the log is safe to share.
- Pinned messages in chats: Graph `pinnedMessages` (POST/DELETE/GET); channels refused; others' pins appear through `pins()` only. Fake-verified only.

# @unimsg/provider-threema

Threema via the **Threema Gateway in end-to-end mode**. Read "What is possible" first: this is **not** a client for your personal Threema account.

## What is possible (feasibility verdict, blunt)

Threema has no official client API for personal accounts. Evaluated from public knowledge (the Gateway endpoints below were cross-checked against the public Gateway API docs; nothing was run against a real server):

| Path | Verdict |
|---|---|
| **(a) Gateway Basic mode** (`send_simple`) | Send-only, server-side encryption (Threema's server sees the text). Not implemented: E2E mode is strictly better. |
| **(a) Gateway E2E mode** (own `*XXXXXXX` ID + own key pair, `send_e2e`, `pubkeys`, `upload_blob`, incoming **callback** webhook) | **Implemented.** Real E2E (encryption happens in UniChat). Limits: (1) messages go to/from the **Gateway ID**, not your personal Threema ID; contacts must write to the bridge ID. (2) Incoming messages exist **only** as an HTTPS POST to a public callback URL with a trusted certificate. There is no pull/poll API. A local desktop app has no public endpoint, so locally the account is **send-only** unless you expose the port yourself. (3) Every message, receipt and file upload costs Gateway credits, and the ID has a monthly/one-off fee. (4) No groups you can create; no typing, edits, deletes. |
| **(b) Threema Work / OnPrem / Broadcast / MDM** | Business products for organisations (admin APIs, broadcast lists, user provisioning). They do not give a personal-account message stream. Not useful here. |
| **(c) Multi-device (D2D) protocol, linking as a second device via the Mediator server** | The only route to a *personal* account, and the one Threema's own Desktop/Web clients use (open source, AGPL; protocol docs published by Threema). **Not implemented, not responsibly doable offline**: it needs the CSP handshake, the Mediator WebSocket + protobuf framing, the Device Join (rendezvous) protocol, the device-group key hierarchy (Blake2b-derived keys, XChaCha20-Poly1305 streams), reflect/task state machines, and a *live phone* to approve the link. None of that can be verified without a real account, and a wrong guess can desync or lock the device group. Also, the Threema terms are written for the official apps; a third-party linked client is at least a grey area (the protocol is public, the legal position of unofficial clients is unclear to me; check before using a personal ID). |

**Decision:** deliver (a), and document (c) as the real solution. What (c) would take: port the join + mediator + CSP layers from the open-source Threema Desktop (threema-ch on GitHub) with test vectors from their repository, then validate against a throw-away Threema account on a spare phone (links are limited, and it uses up a device slot). The NaCl layer in `src/nacl.ts` is reusable for it.

### How receiving works (and the options)
UniChat listens on a local HTTP port (default bind `127.0.0.1`, path `/threema/callback`) **only if you enter a port** in the login form. Threema's server must reach it:
- **Hosted/server variant of UniChat** with a public domain: reverse-proxy `https://your.domain/threema/callback` to the port and enter that URL in the Gateway portal (Gateway ID > callback URL).
- **Local desktop:** only via a tunnel you set up yourself (Tailscale Funnel, cloudflared, a VPS reverse proxy). This publishes an endpoint on the internet; each request is authenticated with the HMAC-SHA256 MAC over the Gateway secret (checked before anything is parsed) and bodies are capped at 64 KB. Set `UNIMSG_THREEMA_CALLBACK_HOST` to bind a different interface (default `127.0.0.1`).
- **Without a port:** send-only. The capabilities then drop to `reactions/readReceipts/markRead = false` (they need incoming data).
UniChat never talks to a third party for this; the callback URL itself is configured in the Threema Gateway portal, UniChat only listens.

## What works
| Feature | Notes |
|---|---|
| Login | Form: Gateway ID, API secret, private key (hex, optional `private:` prefix), optional callback port, mandatory confirmation. Validates the secret (`/credits`) and compares the derived public key with the one registered at Threema (`/pubkeys/<own id>`). |
| Contacts / chats | `startChat("ABCD1234")` resolves the public key (`/pubkeys/{id}`, cached; 404 = unknown ID). Chat id = the peer's Threema ID (native, uppercase). Name = the nickname the peer sent, else the ID. |
| 1:1 text | Send (`send_e2e`, max 3500 bytes) and receive (callback). Padding and framing per the Gateway docs. |
| Delivery status | Incoming receipts: received -> `delivered`, read -> `read` (never downgraded). |
| Reactions | Incoming ack/decline receipts show as 👍/👎 on your message. `react()` sends ack (👍) or decline (👎) for a *received* message. Threema cannot withdraw it or use other emoji (errors say so). |
| markRead | Sends one `read` receipt per up-to-50 unread messages (costs a credit each; not automatic). |
| Files / images | Encrypted with a fresh key (XSalsa20-Poly1305, nonce 0..01), uploaded via `upload_blob`, sent as file message (type 0x17, `j`=1 for image/video/audio). Incoming file messages are downloaded and decrypted on demand (`downloadAttachment`). No thumbnails. |
| Groups | Incoming group text (0x41) only, shown as a read-only chat `g:<creator>:<groupIdHex>`. Group names/members are not known to a Gateway ID. |
| Not supported (capability false) | spaces, edits, deletes, replies, typing, createGroup, polls, locations, contact cards, avatars, profile, privacy. |
| e2ee | `true`: boxes are built on this device; Threema's servers see metadata (IDs, times, sizes) only. |

## Hypotheses (not verified against a real Gateway)
- Message-type bytes 0x01/0x10/0x15/0x16/0x17/0x80 and receipt statuses 1-4 are from the public Gateway E2E doc; group text **0x41** layout (8 ASCII creator + 8 byte group id + text) and blob nonces (file 0..01, thumbnail 0..02) are from memory of the Threema protocol, not the Gateway page.
- Receipt message ids: the 8 bytes are used in the order of the hex id the Gateway returns/delivers. The doc calls them `u64-le`; if the real Gateway shows them byte-swapped, receipts will not match.
- Media rendering (`j`/`i` flags without thumbnail) may look plain in the official app.
- Poly1305 is BigInt based (not constant time). Acceptable for a local single-user client, but it is hand-written NaCl; it is tested against libsodium vectors (`src/nacl.test.ts`), not audited.

## Storage and secrets
`dataDir/threema-session.json` (ID, secret, private key, port) and `threema-state.json` (contact keys, last 600 messages, file keys needed for download) are AES-256-GCM sealed, mode 0600, key in `threema.key` (0600) or `UNIMSG_THREEMA_KEY`. A key file next to the data protects against copying one file, not against reading the whole directory. Logout wipes everything (a Gateway ID has no device list to clean up remotely; revoke the secret in the Gateway portal if the machine is lost). Only HTTP status/endpoint class is logged under `UNIMSG_DEBUG=1`; never keys, IDs or text.

## Environment
`UNIMSG_THREEMA_BASE` overrides the API endpoint for **loopback hosts only** (127.0.0.1/localhost); any other value is ignored. `UNIMSG_THREEMA_CALLBACK_HOST`, `UNIMSG_THREEMA_KEY`, `UNIMSG_THREEMA_RETRY_MS` (reconnect backoff base).

## Tests
`pnpm test` (offline): libsodium vectors for NaCl, in-process fake Gateway on 127.0.0.1 with fake peers that POST encrypted, MAC-signed callbacks, login validation, send/receive, receipts, reactions, files, groups, outage/recovery, 401, port conflicts, logout, secrets test (no key/secret/ID/text in errors, events, debug output or stored files). No test contacts any threema.ch host.

## Safe real-world test
1. Create a **Gateway ID in E2E mode** with a small credit pack, generate its key pair (Threema's tool), note ID, secret, private key.
2. Use a throw-away personal Threema ID (not your main one) as the other side; add the Gateway ID as a contact there.
3. Start with no port (send-only): add the account, `startChat` your test ID, send "hello". Check it arrives, check credits dropped by 1.
4. Only then expose a callback (tunnel/reverse proxy), set it in the Gateway portal, enter the port, and reply from the phone.

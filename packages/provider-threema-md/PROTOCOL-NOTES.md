# Threema multi-device (linked device) – protocol research notes

Status tags used below: **[V]** verified in the quoted public source I read, **[M]** from memory / general knowledge, **[?]** unknown / not found.
Research was read-only (docs + public source). No Threema server was ever contacted. Date of research: 2026-11.

## 0. Where the specification actually lives (and its licence – FLAG)

* **[V]** The multi-device protocol documents are NOT on a standalone public spec site. The Threema repository `github.com/threema-ch/threema-protocols` (named in `threema-desktop`'s README, "update:protocol") returns 404 (private/not public). `github.com/threema-ch/libthreema` also 404s.
* **[V]** What is public: the Threema Desktop repo (https://github.com/threema-ch/threema-desktop, AGPL-3.0, README: "licensed under the GNU Affero General Public License v3") vendors a snapshot of both under
  `packages/libthreema-wasm/libs/libthreema/threema-protocols/src/` (`version.txt` = `23`): `md.md`, `md-d2m.proto`, `md-d2m.struct.yml`, `md-d2d.proto`, `md-d2d-sync.proto`, `md-d2d-join.proto`, `md-d2d-rendezvous.proto`, `url-payloads.proto`, `common.proto`, `csp.struct.yml` (CSP + e2e), `csp-e2e.proto`, `csp-e2e-fs.proto`, `directory.openapi.yml`, `extra.struct.yml`, and the Rust implementation `libthreema` (Cargo licence `AGPL-3.0-only`).
  Base URL: https://github.com/threema-ch/threema-desktop/tree/main/packages/libthreema-wasm/libs/libthreema/threema-protocols/src
* **LICENCE FLAG (important):** The protocol/proto/yml files carry **no licence header** of their own (grep for MIT/AGPL/licence: nothing). They are shipped inside an AGPL-3.0 repository, and the Desktop `@threema/protocol` package that is generated from them says `"license": "AGPL-3.0+"`. I found **no public statement that the protocol documents are MIT** (the claim "MIT per public sources" is **not verified**; the only MIT texts in the repo are third-party licences). Consequence for this package: **no code, no generated code and no .proto/.yml file was copied.** The wire formats (field numbers, constants, key-derivation tags) are interoperability facts that I re-expressed in my own hand-written, descriptor-style codec (`src/proto.ts`, `src/schemas.ts`). Whether even that is acceptable for your distribution model is a legal question; if in doubt ask opensource@threema.ch (address from the Desktop README) before publishing the provider.
* **[V]** The Threema Cryptography Whitepaper (publicly downloadable, https://threema.com/assets/documents/cryptography_whitepaper.pdf; revision 2024-12-20 "Document Multi-Device Protocol, add Desktop 2.0") documents the rendezvous + key hierarchy at a high level (pp. 13-17).
* **[V]** Blog "Threema Multi-Device: An Architectural Overview": https://threema.com/en/blog/md-architectural-overview (2020, high level: DGK, mediator, leader, reflect, anonymous grouping, self-hostable).
* Unofficial CSP analyses (o3ma/o3, JanAhrens/threema-protocol-analysis, PST22 paper) describe the OLD CSP only; I did not need them because `csp.struct.yml` is complete and current.

## 1. Layers and clean-room feasibility

| Layer | Source read | Implementable from public docs? |
|---|---|---|
| Crypto: BLAKE2b (key/salt/personal), X25519+HSalsa20, XSalsa20-Poly1305, ChaCha20-Poly1305 | whitepaper, md.md, rendezvous proto | yes (own BLAKE2b; NaCl from provider-threema; chacha from node:crypto) |
| Connection Rendezvous (relayed WebSocket) | md-d2d-rendezvous.proto | yes |
| Device Join (ND "request to join") | md-d2d-join.proto, url-payloads.proto | yes |
| D2M mediator protocol | md-d2m.proto, md-d2m.struct.yml | yes |
| D2D envelopes + sync | md-d2d.proto, md-d2d-sync.proto | yes |
| CSP login + frames + message payloads (proxied) | csp.struct.yml | yes |
| CSP e2e message bodies (text/file/poll/location/group/receipts/typing/reaction/edit/delete) | csp.struct.yml, csp-e2e.proto | yes |
| Blob mirror, directory identity fetch | libthreema config.rs, desktop fetch-blob.ts, directory.openapi.yml | yes for what we need, some details only from client source [V but code, not doc] |
| Forward security (Ibex, csp-e2e-fs) | csp-e2e-fs.proto | **not implemented** (see gaps) |
| History exchange (md-d2d-history.proto) | present, not implemented | optional, out of scope |

## 2. Key hierarchy and KDF tags  [V: md.md, whitepaper p.15-16]

All BLAKE2b: output 32 bytes unless said, `key` = keyed mode, `salt` and `personal` zero-padded to 16 bytes (BLAKE2b parameter block).

```
DGPK.secret = BLAKE2b(key=DGK, salt='p',   personal='3ma-mdev'); DGPK.public = X25519(DGPK.secret)
DGRK        = BLAKE2b(key=DGK, salt='r',   personal='3ma-mdev')   // reflect envelopes
DGDIK       = BLAKE2b(key=DGK, salt='di',  personal='3ma-mdev')   // device info
DGSDDK      = BLAKE2b(key=DGK, salt='sdd', personal='3ma-mdev')   // shared device data
DGTSK       = BLAKE2b(key=DGK, salt='ts',  personal='3ma-mdev')   // transaction scope
```
Rendezvous [V: md-d2d-rendezvous.proto]:
```
RIDAK = BLAKE2b(key=AK, salt='rida', personal='3ma-rendezvous'); RRDAK salt 'rrda'
STK   = BLAKE2b(key=AK || X25519HSalsa20(local.ETK.secret, remote.ETK.public), salt='st', personal='3ma-rendezvous')   // key is 64 bytes
RIDTK = BLAKE2b(key=STK, salt='ridt'..); RRDTK salt 'rrdt'
RPH   = BLAKE2b(out=32, salt='ph', personal='3ma-rendezvous', input=STK)   // unkeyed, STK is the INPUT
```
CSP [V: csp.struct.yml]: `VouchKey = BLAKE2b(key=SS1||SS2, salt='v2', personal='3ma-csp')`, `vouch = BLAKE2b(key=VouchKey, input=SCK||TCK.public)` (no salt/personal), `MMK = BLAKE2b(key=X25519HSalsa20(CK.secret, peer.public), salt='mm', personal='3ma-csp')`.
Directory auth [V: libthreema keys.rs, code]: `k = BLAKE2b(key=X25519HSalsa20(CK.secret, tokenRespKeyPub), salt='dir', personal='3ma-csp')`; `response = BLAKE2b(key=k, input=token)`. (Only needed for blob *server* credentials; the MD blob mirror in the consumer build needed no token, see 8.)

"X25519HSalsa20" = NaCl `crypto_box_beforenm` [V: whitepaper writes X25519HSalsa20; libthreema code uses SharedSecretHSalsa20].

## 3. Rendezvous (relayed WebSocket)  [V md-d2d-rendezvous.proto]

* AK = 32 random bytes. `RendezvousInit` protobuf: `version(1)=0, ak(2), relayed_web_socket(3){path_id(1) u32, network_cost(2), url(3)}`, `direct_tcp_server(4)` (we never offer it).
* URL: `wss://rendezvous-{p4}.threema.ch/{p8}/<64 hex chars random path>` where p4/p8 are the high nibble / the first byte of the random path (hex) [V: libthreema config.rs `RendezvousServerBaseUrl`; whether the byte is zero padded: **[?]**, libthreema prints `{:x}` (unpadded), Desktop prints 2 digits for the device-group variants. I use 2-digit and make the template overridable].
* Framing: every transmitted datum is `u32-le length || data` (a stream: one WS message may carry several frames or part of one) [V].
* Nonce: `u32le(PID) || u32le(SN) || 4*0x00`, ChaCha20-Poly1305, SN starts at **1**, one counter per direction that **keeps counting from the AK phase into the TK phase** [V: proto text + libthreema rxdxk.rs `new_from`].
* Handshake (RID = initiator = the device that shows the QR; for UniChat = RID because the phone scans): RRD sends `Hello{challenge(16), etk(32)}` (RRDAK, SN1) -> RID answers `AuthHello{response=challenge, challenge(16), etk}` (RIDAK, SN1) -> RRD sends `Auth{response}` (RRDAK, SN2) -> nomination by the side the upper-layer protocol defines (join: **ED** = the existing device = RRD) `Nominate{}` (RRDTK, SN3).
* Both devices show the first three bytes of RPH as emoji: `EMOJI_LIST[rph[i] % 128]` (128 entries) [V: Desktop `LinkingEmojiLoader.svelte`/`emoji-list.ts`; the table is data, copied into `src/emoji.ts`, flagged AGPL-origin data table].
* Close codes: 1000 normal, 4000 protocol error, 4003 init timeout, 4004 other device disconnected, 41xx upper layer error [V].

## 4. Device Join  [V md-d2d-join.proto, url-payloads.proto]

* "ND starts" (= request to join, recommended as more secure): ND is RID. URL: `threema://device-group/join#<url-safe-base64(DeviceGroupJoinRequestOrOffer)>` with `{version(1)=0, variant(2){request_to_join(1)=Unit{}}, d2d_protocol_version(4), rendezvous_init(3)}` [V]. QR payload = that URL [M that the phone's scanner takes exactly this string; the doc says "URL or QR code"].
* Phone (ED) nominates after >=3 s; both show RPH emoji; user confirms **on the phone**; ED sends `EdToNd{begin}`, `blob_data` x N (`common.BlobData{id,data}`), then `EssentialData` [V].
* `EssentialData`: `identity_data{identity(1), ck(2) 32 bytes CLIENT KEY, csp_device_cookie(3), csp_server_group(4)}`, `device_group_data{dgk}`, `user_profile`, `settings`, `contacts[]{contact, last_update_at}`, `groups[]`, `distribution_lists[]`, hashed nonce lists (HMAC-SHA256 keyed by identity) [V]. => **UniChat receives the permanent identity secret key (CK) of the personal Threema ID.** This is inherent to the protocol (the new device logs into the chat server itself).
* ND then: random D2M device id (u64) + CSP device id (u64) generated, connects to the mediator, `ServerInfo.device_slot_state` MUST be NEW, sends `NdToEd{registered}` and may close [V].
* Mediator URL needs the server group (`csp_server_group`) and DGPK.public [V].

## 5. D2M mediator  [V md-d2m.proto / .struct.yml]

* WebSocket (binary), URL = `wss://mediator-{p4}.threema.ch/{p8}/` + lowercase-hex(protobuf `ClientUrlInfo{device_group_id(1)=DGPK.public, server_group(3)}`) [V; template from libthreema config.rs; p4/p8 = high nibble/first byte of DGPK.public]. TLS pinning is mandated by the doc; Node `ws` cannot pin the Threema CA without a pinned-CA option -> **gap**, see README.
* Every WS message is a `container`: `type u8 || 3 reserved || payload`. Types: 0x00 proxy(CSP bytes), 0x10 ServerHello, 0x11 ClientHello, 0x12 ServerInfo, 0x20 ReflectionQueueDry, 0x21 RolePromotedToLeader, 0x30 GetDevicesInfo, 0x31 DevicesInfo, 0x32 DropDevice, 0x33 DropDeviceAck, 0x34 SetSharedDeviceData, 0x40-0x45 transactions (Begin, BeginAck, Commit, CommitAck, Rejected, Ended), 0x80 reflect, 0x81 reflect-ack, 0x82 reflected, 0x83 reflected-ack [V].
* Handshake: server `ServerHello{version, esk(32), challenge(32)}` -> client `ClientHello{version, response, device_id(fixed64), device_slots_exhausted_policy(4), device_slot_expiration_policy(5), expected_device_slot_state(7), encrypted_device_info(6)}` with `response = nonce24 || XSalsa20Poly1305(key=X25519HSalsa20(DGPK.secret, ESK), nonce, challenge)` (72 bytes) [V]. Device info = `nonce || secretbox(DeviceInfo, DGDIK)`. Then `ServerInfo{current_time(4), max_device_slots(1), device_slot_state(2), encrypted_shared_device_data(3), reflection_queue_length(5)}`; then reflected messages; `ReflectionQueueDry`; maybe `RolePromotedToLeader`.
* reflect (0x80): `header-length u8 (=8) || reserved u8 || flags u16le || reflect-id u32le || envelope`; reflect-ack (0x81): `4 reserved || reflect-id u32le || timestamp u64le(ms)`; reflected (0x82): `header-length u8 (=16) || reserved || flags u16le || reflected-id u32le || timestamp u64le || envelope`; reflected-ack (0x83): `4 reserved || id u32le`. flags 0x0001 = ephemeral (do not ack) [V]. Envelope = `nonce24 || secretbox(protobuf d2d.Envelope, DGRK)`.
* Close codes [V]: 4110 unsupported version, 4111 device limit, 4112 duplicate connection, 4113 dropped by other device, 4114 queue limit, 4115 slot state mismatch; `41xx` = no automatic reconnect, `1xxx`/`40xx` auto reconnect with **linear backoff**, user interaction after repeated failures. Max message 65536 bytes. Clock skew >20 min => warn.
* Slot count: `ServerInfo.max_device_slots` is announced by the server; the whitepaper lists "Maximum number of device slots" as a setting; the user text says phone + 2 computers (**[M]**, not stated in the docs I read: the number comes from the server).
* Drop a device [V md-d2d.proto `Device Flows`... in csp.struct.yml e2e doc]: BeginTransaction(scope DROP_DEVICE) -> GetDevicesInfo -> DropDevice(id) -> DropDeviceAck (or close 4113 when dropping self) -> commit.
* Leader: server promotes one connected device; only the leader fetches CSP messages: after `ReflectionQueueDry` and `RolePromotedToLeader` it sends CSP payload `unblock-incoming-messages (0x03)`. Non-leaders must not process incoming CSP messages (the doc says abort the connection) [V].

## 6. CSP over the mediator  [V csp.struct.yml]

* CSP bytes are carried in `proxy` containers as a plain byte stream (reassemble). Handshake: `client-hello(tck.pub 32 || cck 16)` -> `server-hello(sck 16 || box 64)` where `box = secretbox(tsk.pub 32 || cck 16, nonce=SCK||u64le(SSN+), key=X25519HSalsa20(SK.public.., TCK.secret))` -> `login(box 144 || extensions-box)`, `login-ack(box 32)`.
* `login-data` (128 bytes before box): identity(8) || "threema-clever-extension-field"(30)||u16le(len of extensions box incl. 16-byte tag) || sck(16) || 24*0 || vouch(32) || 16*0. Extensions are concatenated (`type u8 | len u16le | payload`) and encrypted as ONE box with the next client sequence number [V proto + libthreema]. Types: 0 client-info, 1 csp-device-id (u64le), 2 message-payload-version / supported features (we send 0x01 = message-with-metadata-box), 3 device-cookie(16) [V; 0x02 as bitfield with echo bit in libthreema: **[?]**, we send plain 0x01].
* Frames: `u16le length || box`, box = secretbox(container(type u8 | 3 reserved | data)) with nonce `cookie || u64le(seq)` (client uses CCK/CSN, server SCK/SSN, both starting at 1 and **sharing the counter with the handshake boxes**). Payload types: 0x00/0x80 echo, 0x01 outgoing message, 0x81 ack for outgoing, 0x02 incoming, 0x82 ack for incoming, 0x03 unblock-incoming, 0xd0 queue-send-complete, 0xd2 device-cookie-change, 0xe0 close-error(can-reconnect u8 + utf8), 0xe1 alert.
* The **permanent chat-server public keys** are constants of the client (`config.rs`), not in the docs. They are configuration in this package (`UNIMSG_THREEMA_MD_CSP_KEYS`, defaults copied from public Desktop config **[V as client constant, unverifiable offline]**).
* message-with-metadata-box: `sender(8) receiver(8) message-id u64le created-at u32le(seconds) flags u8 reserved u8 metadata-length u16le legacy-nickname(32) metadata-box nonce(24) message-box`. Flags: 0x01 push, 0x02 no server queuing, 0x04 no server ack, 0x20 short-lived, 0x80 no automatic delivery receipt. Metadata = `secretbox(csp_e2e.MessageMetadata{padding, message_id, created_at ms, nickname}, MMK, same nonce)`. Message-box = `secretbox(container(type | padded-data), X25519HSalsa20(sender.CK, receiver.pk), nonce)`; padding PKCS#7 style 1..255 bytes, total padded >= 32.
* Incoming message steps: dedupe by nonce, check receiver, metadata, FS envelope 0xa0 -> FS steps, block checks, implicit contacts (transaction CONTACT_SYNC + reflect `ContactSync.Create`), **reflect `IncomingMessage` (outer type/body + nonce) and wait for reflect-ack BEFORE acking to the server**, send automatic delivery receipt `received` (not in groups), then `message-ack` (0x82: identity + message-id).
* Outgoing steps (bundled messages send steps): choose ids/nonces, **reflect `OutgoingMessage` first and await ack**, send CSP, await `message-ack (0x81)`, reflect `OutgoingMessageUpdate.Sent`.
* MD note [V]: the docs contain `TODO(SE-199): ... once multi-device supports FS`: **FS is switched off while MD is active**, so peers should send plain (non-0xa0) messages to an MD identity. Whitepaper p.7 says the same.

## 7. D2D / sync  [V md-d2d.proto, md-d2d-sync.proto]

`d2d.Envelope{padding(1), device_id(13) fixed64, protocol_version(3), oneof: outgoing_message(2), outgoing_message_update(10), incoming_message(4), incoming_message_update(11), user_profile_sync(5), contact_sync(6), group_sync(7), distribution_list_sync(8), settings_sync(9), mdm_parameter_sync(12)}`. D2D protocol version we announce: 0x0003 (V0.3) [V; must not be lower than the group minimum in `SharedDeviceData.version`: **[?] behaviour when a newer minimum is announced**]. Sync messages need a transaction (`TransactionScope`). Replay protection: nonces of incoming/outgoing D2D and CSP messages must be stored permanently (md.md) [V].

## 8. Blobs, directory  [V desktop fetch-blob.ts; libthreema config.rs / directory.rs]

* MD blob mirror: `https://blob-mirror-{p4}.threema.ch/{p8}/` + `upload?persist=0|1` (POST multipart field `blob`, response text = blob id hex), `<blobIdHex>` (GET), `<blobIdHex>/done` (POST, 204). Query params on all requests: `deviceId` (device id as 8 bytes LE hex), `deviceGroupId` (DGPK.public hex), `scope` (`local` for reflect-only blobs, `public` for blobs referenced by CSP messages). No Authorization header in the consumer flavour (only OnPrem adds `Token`) [V from Desktop source].
* Encryption: file `secretbox(key=file.key, nonce=00..01)`, thumbnail nonce `00..02`; profile picture nonce `00..01`; file JSON keys `j,i,k,b,m,n,s,t,p,d,c,x` [V csp.struct.yml].
* Identity lookup: `POST https://ds-apip.threema.ch/identity/fetch_bulk {"identities":[...]}` -> `{"identities":[{identity,type,publicKey(b64),state,featureMask}]}`; invalid ids are omitted; HTTP 429 -> back off >=10 s [V libthreema directory.rs + csp.struct.yml "Valid Contacts Lookup Steps"]. Public, no auth.
* Production host names: chat via mediator; directory `https://ds-apip.threema.ch/`; blob mirror as above; rendezvous & mediator as above [V config.rs].

## 9. Quotes, reactions, edit, delete  

* Quote in text: `> quote #<16 hex>\n\n<comment>` where the hex is the quoted message id bytes in wire (LE) order [V: Desktop `quotes.ts` regex, unit test]. The protocol docs only mention that quotes exist.
* New reactions `csp_e2e.Reaction{message_id, apply|withdraw = emoji utf8}` (type 0x82; group 0x83), legacy delivery-receipt statuses 0x03 (thumbs up) / 0x04 (thumbs down); edit `EditMessage{message_id,text}` 0x91/0x93; delete `DeleteMessage{message_id}` 0x92/0x94; edit window 6 h, both need feature mask bits (0x0100 edit, 0x0200 delete, 0x0400 reaction) [V csp-e2e.proto / common.proto].

## 10. Unknown / not verified

* [?] Exact shape of the QR as scanned by iOS/Android (documented as URL; we encode the URL string).
* [?] Whether the production rendezvous/mediator accept the unpadded vs. padded prefix.
* [?] Real server behaviour for `DROP_LEAST_RECENT` etc.: we always use REJECT.
* [?] Max device slots in practice (server value, shown to user from ServerInfo).
* [?] FS compatibility of peers with an MD identity beyond the doc TODO.
* Everything here is verified only against the fixtures in this package (own fake servers), never against Threema.

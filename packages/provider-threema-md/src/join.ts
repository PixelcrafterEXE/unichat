// Device Join Protocol, "ND requests to join" variant: UniChat is the new device (ND) and the rendezvous initiator (RID); the phone scans the QR.
// Written from md-d2d-join.proto + url-payloads.proto (Threema-protocol-notes (https://github.com/PixelcrafterEXE/unichat/wiki/Threema-protocol-notes) section 4).
import { randomBytes } from "node:crypto";
import { rendezvousBase } from "./config.js";
import { rphEmoji } from "./emoji.js";
import { RendezvousChannel, wsTransport } from "./rendezvous.js";
import { decode, encode, type Msg } from "./proto.js";
import { DeviceGroupJoinRequestOrOffer, EdToNd, NdToEd } from "./schemas.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export function joinUrl(ak: Uint8Array, wsUrl: string, pid = 1): string {
  const payload = encode(DeviceGroupJoinRequestOrOffer, {
    version: 0, d2dProtocolVersion: 3, variant: { requestToJoin: {} },
    rendezvousInit: { version: 0, ak, relayedWebSocket: { pathId: pid, networkCost: 0, url: wsUrl } },
  });
  return "threema://device-group/join#" + b64url(payload);
}

export interface JoinOutcome { essential: Msg; blobs: Map<string, Uint8Array>; channel: RendezvousChannel }
export interface JoinHooks { onQr(url: string): void; onEmoji(emoji: string[]): void; ttlMs: number; signal?: AbortSignal }

export async function joinAsNewDevice(h: JoinHooks): Promise<JoinOutcome> {
  const ak = new Uint8Array(randomBytes(32)), path = new Uint8Array(randomBytes(32)), pid = 1;
  const wsUrl = rendezvousBase(path[0]) + hex(path);
  const transport = await wsTransport(wsUrl);
  const abort = () => transport.close(1000);
  h.signal?.addEventListener("abort", abort, { once: true });
  const ch = new RendezvousChannel("rid", ak, pid, transport);
  try {
    h.onQr(joinUrl(ak, wsUrl, pid));
    const { rph } = await ch.handshake(h.ttlMs);
    await ch.awaitNominate(30_000);
    h.onEmoji(rphEmoji(rph));
    let began = false; const blobs = new Map<string, Uint8Array>();
    for (;;) {
      const m = decode(EdToNd, await ch.recv(15 * 60_000)); // the user may take their time confirming the emoji on the phone
      if (m.begin) { if (began) throw new Error("join: duplicate begin"); began = true; }
      else if (!began) throw new Error("join: data before begin");
      else if (m.blobData) blobs.set(hex(m.blobData.id), m.blobData.data);
      else if (m.essentialData) return { essential: m.essentialData, blobs, channel: ch };
    }
  } catch (e) { ch.close(4100); throw e; }
}
export const registeredFrame = () => encode(NdToEd, { registered: {} });

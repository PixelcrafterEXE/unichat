// Threema key hierarchy (see PROTOCOL-NOTES.md section 2). All tags are public protocol constants.
import { blake2b } from "./blake2b.js";
import { beforenm, publicKeyOf } from "./nacl.js";

const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
export { cat };

export interface DeviceGroupKeys { dgk: Uint8Array; dgpkSecret: Uint8Array; dgpkPublic: Uint8Array; dgrk: Uint8Array; dgdik: Uint8Array; dgsddk: Uint8Array; dgtsk: Uint8Array }
export function deriveDeviceGroupKeys(dgk: Uint8Array): DeviceGroupKeys {
  const k = (salt: string) => blake2b(new Uint8Array(0), { key: dgk, salt, personal: "3ma-mdev" });
  const dgpkSecret = k("p");
  return { dgk, dgpkSecret, dgpkPublic: publicKeyOf(dgpkSecret), dgrk: k("r"), dgdik: k("di"), dgsddk: k("sdd"), dgtsk: k("ts") };
}

export interface RendezvousKeys { ridak: Uint8Array; rrdak: Uint8Array }
export const deriveAuthKeys = (ak: Uint8Array): RendezvousKeys => ({
  ridak: blake2b(new Uint8Array(0), { key: ak, salt: "rida", personal: "3ma-rendezvous" }),
  rrdak: blake2b(new Uint8Array(0), { key: ak, salt: "rrda", personal: "3ma-rendezvous" }),
});
export function deriveTransportKeys(ak: Uint8Array, localEtkSecret: Uint8Array, remoteEtkPublic: Uint8Array) {
  const stk = blake2b(new Uint8Array(0), { key: cat(ak, beforenm(remoteEtkPublic, localEtkSecret)), salt: "st", personal: "3ma-rendezvous" });
  return {
    stk,
    rph: blake2b(stk, { salt: "ph", personal: "3ma-rendezvous" }),
    ridtk: blake2b(new Uint8Array(0), { key: stk, salt: "ridt", personal: "3ma-rendezvous" }),
    rrdtk: blake2b(new Uint8Array(0), { key: stk, salt: "rrdt", personal: "3ma-rendezvous" }),
  };
}

export function cspVouch(ckSecret: Uint8Array, skPublic: Uint8Array, tskPublic: Uint8Array, sck: Uint8Array, tckPublic: Uint8Array): Uint8Array {
  const vouchKey = blake2b(new Uint8Array(0), { key: cat(beforenm(skPublic, ckSecret), beforenm(tskPublic, ckSecret)), salt: "v2", personal: "3ma-csp" });
  return blake2b(cat(sck, tckPublic), { key: vouchKey });
}
export const metadataKey = (ckSecret: Uint8Array, peerPublic: Uint8Array) => blake2b(new Uint8Array(0), { key: beforenm(peerPublic, ckSecret), salt: "mm", personal: "3ma-csp" });
export function directoryResponse(ckSecret: Uint8Array, tokenRespKeyPub: Uint8Array, token: Uint8Array): Uint8Array {
  const k = blake2b(new Uint8Array(0), { key: beforenm(tokenRespKeyPub, ckSecret), salt: "dir", personal: "3ma-csp" });
  return blake2b(token, { key: k });
}

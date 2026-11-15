// libsignal's `Bytes` is Uint8Array<ArrayBuffer> (no SharedArrayBuffer). protobufjs/Node Buffers are typed
// Uint8Array<ArrayBufferLike>, so copy at the boundary.
export type Bytes = Uint8Array<ArrayBuffer>;
export const toBytes = (u: Uint8Array): Bytes => new Uint8Array(u);
export const fromB64 = (s: string): Bytes => new Uint8Array(Buffer.from(s, "base64"));
export const toB64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

// Large messages over the sync channel. A frame is at most 512 KiB, so anything bigger (a credential session, an attachment, a proxied chat
// list) travels as numbered pieces of its JSON text: {t:"big", id, kind, i, n, d}. The receiver reassembles under hard caps (total size,
// number of transfers in flight), so a peer cannot make us buffer without bound. Pieces ride the normal encrypted, authenticated, ordered channel.
export const BIG_PIECE = 120_000; // characters per piece: <= ~360 KB UTF-8 even for non-ASCII text, below the frame limit
export const BIG_MAX_DEFAULT = 96 * 1024 * 1024;
export class BigTooLarge extends Error { constructor(public bytes: number, public limit: number) { super(`That is ${(bytes / 1048576).toFixed(1)} MB; the limit is ${(limit / 1048576).toFixed(0)} MB.`); } }

export async function sendBig(ch: { send(m: object): Promise<void> }, id: string, kind: string, payload: unknown, max = BIG_MAX_DEFAULT): Promise<number> {
  const text = JSON.stringify(payload ?? null);
  if (text.length > max) throw new BigTooLarge(text.length, max);
  const n = Math.max(1, Math.ceil(text.length / BIG_PIECE));
  for (let i = 0; i < n; i++) await ch.send({ t: "big", id, kind, i, n, d: text.slice(i * BIG_PIECE, (i + 1) * BIG_PIECE) });
  return text.length;
}

export class BigAssembler {
  private parts = new Map<string, { kind: string; n: number; next: number; chunks: string[]; bytes: number }>(); private total = 0;
  constructor(private max = BIG_MAX_DEFAULT, private maxInFlight = 8) {}
  /** Feed one `big` frame; returns the finished transfer, undefined while pieces are missing. Throws on protocol abuse (the session is then dropped). */
  push(x: any): { id: string; kind: string; payload: unknown } | undefined {
    if (!x || typeof x.id !== "string" || typeof x.kind !== "string" || typeof x.d !== "string" || !Number.isInteger(x.i) || !Number.isInteger(x.n) || x.n < 1 || x.n > 1 + Math.ceil(this.max / BIG_PIECE) || x.i < 0 || x.i >= x.n || x.d.length > BIG_PIECE) throw new Error("bad bulk piece");
    let p = this.parts.get(x.id);
    if (!p) { if (x.i !== 0) throw new Error("bulk piece out of order"); if (this.parts.size >= this.maxInFlight) throw new Error("too many bulk transfers"); p = { kind: x.kind, n: x.n, next: 0, chunks: [], bytes: 0 }; this.parts.set(x.id, p); }
    if (x.i !== p.next || x.n !== p.n || x.kind !== p.kind) throw new Error("bulk piece out of order");
    p.chunks.push(x.d); p.bytes += x.d.length; p.next++; this.total += x.d.length;
    if (p.bytes > this.max || this.total > this.max * 2) throw new Error("bulk transfer too large");
    if (p.next < p.n) return undefined;
    this.parts.delete(x.id); this.total -= p.bytes;
    let payload: unknown; try { payload = JSON.parse(p.chunks.join("")); } catch { throw new Error("bad bulk payload"); }
    return { id: x.id, kind: p.kind, payload };
  }
  clear() { this.parts.clear(); this.total = 0; }
}

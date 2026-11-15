// Signal sessions are stored per address "<user>.<device>", group sender keys per "<group>::<user>::<device>". WhatsApp reaches one
// person under two user ids (phone number and LID), and this Baileys version has no PN<->LID migration: a session UniChat builds when
// it sends to the phone-number address is invisible when the same person's message arrives from the LID address ("No matching
// sessions found for message"), and a group sender key delivered under one form is not found under the other ("bad MAC", missing
// group messages). This wrapper makes both ids share one record: every id is rewritten to its phone-number form when the LID is known,
// legacy records stored under the LID form are still found (and move over on their next write).
import type { SignalKeyStore } from "@whiskeysockets/baileys";

type Maps = { lidToPn: Record<string, string>; own?: { pn?: string; lid?: string } };
const userOf = (jid: string) => jid.replace(/[:@].*$/, "");
const TYPES = new Set(["session", "sender-key"]);

/** Maps a LID user id to the phone-number user id (both without domain / device). */
export function userMap(m: Maps): Map<string, string> {
  const out = new Map<string, string>();
  for (const [lid, pn] of Object.entries(m.lidToPn)) if (lid.endsWith("@lid") && pn.endsWith("@s.whatsapp.net")) out.set(userOf(lid), userOf(pn));
  if (m.own?.lid && m.own.pn) out.set(userOf(m.own.lid), userOf(m.own.pn));
  return out;
}

/** Splits a store id into [prefix, user, suffix] so the user part can be swapped: session "<u>.<dev>", sender key "<g>::<u>::<dev>". */
function parts(type: string, id: string): [string, string, string] | undefined {
  if (type === "session") { const i = id.lastIndexOf("."); return i < 0 ? undefined : ["", id.slice(0, i), id.slice(i)]; }
  const a = id.indexOf("::"), b = id.lastIndexOf("::");
  return a < 0 || b <= a ? undefined : [id.slice(0, a + 2), id.slice(a + 2, b), id.slice(b)];
}

/** Session id "<lidUser>.<dev>" -> "<pnUser>.<dev>"; anything else unchanged. */
export const canonicalSessionId = (id: string, map: Map<string, string>): string => canonicalId("session", id, map);
export function canonicalId(type: string, id: string, map: Map<string, string>): string {
  const p = parts(type, id); if (!p) return id;
  const pn = map.get(p[1]);
  return pn ? `${p[0]}${pn}${p[2]}` : id;
}

export function aliasSessions(inner: SignalKeyStore, getMap: () => Map<string, string>): SignalKeyStore {
  return {
    async get(type, ids) {
      if (!TYPES.has(type)) return inner.get(type, ids);
      const map = getMap(), canon = ids.map((i) => canonicalId(type, i, map));
      const got = await inner.get(type, [...new Set(canon)]);
      const missing = ids.filter((id, k) => canon[k] !== id && !got[canon[k]!]); // legacy record under the LID form
      const legacy = missing.length ? await inner.get(type, missing) : {};
      const out: Record<string, unknown> = {};
      ids.forEach((id, k) => { const v = got[canon[k]!] ?? legacy[id]; if (v) out[id] = v; });
      return out as never;
    },
    async set(data) {
      const d = data as Record<string, Record<string, unknown> | undefined>;
      if (!d.session && !d["sender-key"]) return inner.set(data);
      const map = getMap(), next: Record<string, Record<string, unknown>> = {};
      for (const type of TYPES) {
        const s = d[type]; if (!s) continue;
        const rec: Record<string, unknown> = {}, drop: Record<string, null> = {};
        for (const [id, v] of Object.entries(s)) {
          const c = canonicalId(type, id, map);
          rec[c] = v;
          if (c !== id) drop[id] = null; // the old LID-form record is superseded
          // a write/delete under the PN form must also clear a legacy LID-form twin, else a deleted record resurrects via the fallback read
          const p = parts(type, c);
          if (p) for (const [lid, pn] of map) if (pn === p[1]) drop[`${p[0]}${lid}${p[2]}`] = null;
        }
        next[type] = { ...drop, ...rec };
      }
      return inner.set({ ...data, ...next } as never);
    },
    clear: inner.clear?.bind(inner),
  } as SignalKeyStore;
}

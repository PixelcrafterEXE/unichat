// Resolving user-entered handles to an ACI:
//   * bare ACI UUID            -> used as is
//   * E.164 phone number       -> CDSI (Contact Discovery) via libsignal Net.cdsiLookup; credentials come from
//                                 GET /v2/directory/auth on our authenticated chat connection
//   * username (nick.NN)       -> usernames.hash + unauthenticated chat lookUpUsernameHash
import { ErrorCode, LibSignalErrorBase, usernames, type Net } from "@signalapp/libsignal-client";
import type { AuthChat } from "./chatTypes.js";

export class LookupError extends Error {
  constructor(message: string, readonly kind: "not-found" | "invalid" | "failed") { super(message); this.name = "LookupError"; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME_RE = /^@?([a-zA-Z_][a-zA-Z0-9_]{2,31})\.(\d{2,})$/;

export type ParsedHandle = { kind: "aci"; aci: string } | { kind: "e164"; e164: string } | { kind: "username"; username: string };

export function parseHandle(raw: string): ParsedHandle {
  const h = raw.trim();
  if (UUID_RE.test(h)) return { kind: "aci", aci: h.toLowerCase() };
  const digits = h.replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(digits)) return { kind: "e164", e164: digits };
  if (USERNAME_RE.test(h)) return { kind: "username", username: h.replace(/^@/, "") };
  throw new LookupError("Enter a phone number in international format (+49...), a Signal username (name.42) or an ACI UUID.", "invalid");
}

function wrap(e: unknown, what: string): LookupError {
  if (e instanceof LookupError) return e;
  if (LibSignalErrorBase.is(e, ErrorCode.RateLimitedError)) return new LookupError(`${what}: rate limited, retry in ${e.retryAfterSecs}s`, "failed");
  return new LookupError(`${what} failed: ${e instanceof Error ? e.message : "unknown error"}`, "failed");
}

export async function lookupE164(net: Net.Net, chat: AuthChat, e164: string): Promise<string> {
  try {
    const res = await chat.fetch({ verb: "GET", path: "/v2/directory/auth", headers: [] });
    if (res.status !== 200) throw new Error(`directory auth HTTP ${res.status}`);
    const auth = JSON.parse(Buffer.from(res.body ?? new Uint8Array()).toString("utf8")) as { username?: string; password?: string };
    if (!auth.username || !auth.password) throw new Error("directory auth response malformed");
    const out = await net.cdsiLookup({ username: auth.username, password: auth.password }, { e164s: [e164], acisAndAccessKeys: [] });
    const entry = out.entries.get(e164);
    if (!entry?.aci) throw new LookupError("No Signal account found for this phone number (or it is hidden by the owner's privacy settings).", "not-found");
    return entry.aci.toLowerCase();
  } catch (e) { throw wrap(e, "Phone number lookup"); }
}

export async function lookupUsername(net: Net.Net, username: string): Promise<string> {
  let hash;
  try { hash = usernames.hash(username); } catch { throw new LookupError("Invalid Signal username.", "invalid"); }
  let conn: Net.UnauthenticatedChatConnection | undefined;
  try {
    conn = await net.connectUnauthenticatedChat({ onConnectionInterrupted: () => {} });
    const aci = await (conn as Net.UnauthenticatedChatConnection & Net.UnauthUsernamesService).lookUpUsernameHash({ hash });
    if (!aci) throw new LookupError("No Signal account has this username.", "not-found");
    return aci.getRawUuid().toLowerCase();
  } catch (e) { throw wrap(e, "Username lookup"); }
  finally { await conn?.disconnect().catch(() => {}); }
}

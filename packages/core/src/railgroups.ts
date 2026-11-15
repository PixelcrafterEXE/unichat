// Rail groups (local only): like Discord server folders, several rail entries (network communities and user folders) can be
// put into one named, coloured group that the UI shows as one expandable entry. Stored as the Hub setting `railGroups`
// (JSON `[{id,name,color?,members:[spaceIds]}]`); the group's own place in the rail is its id in the existing `railOrder`.
// Nothing here touches chats, folders or networks. Pure validation + a tiny store wrapper kept out of hub.ts.
import { PERSONAL } from "./model.js";

export interface RailGroup { id: string; name: string; color?: string; members: string[] }
export const GROUP_PREFIX = "group:";
export const isGroupId = (id: string) => id.startsWith(GROUP_PREFIX);
const MAX_GROUPS = 200, MAX_NAME = 40, MAX_ID = 200;
const COLOR = /^#[0-9a-f]{3,8}$/i;

/** Can this id be a member? Personal / the pseudo "home" entry and other groups never can; spaces and folders can. */
const memberOk = (id: unknown): id is string => typeof id === "string" && !!id && id.length <= MAX_ID && id !== PERSONAL && id !== "home" && !isGroupId(id);

/**
 * Clean up groups: drops malformed entries, trims names, keeps only valid colours, removes duplicate ids and members (a rail entry
 * belongs to at most one group, first wins), removes ids that are not in `known` (vanished spaces / deleted folders; skipped when
 * `known` is empty/absent: nothing is known yet) and groups left without a member.
 * `strict` throws a user-facing error for input that is not an array of groups instead of silently repairing it.
 */
export function normalizeRailGroups(input: unknown, known?: Iterable<string>, strict = false): RailGroup[] {
  if (!Array.isArray(input)) { if (strict) throw new Error("Rail groups must be a list."); return []; }
  if (strict && input.length > MAX_GROUPS) throw new Error("Too many groups.");
  const have = known ? new Set(known) : undefined, seenGroup = new Set<string>(), seenMember = new Set<string>(), out: RailGroup[] = [];
  for (const g of input.slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== "object") { if (strict) throw new Error("A rail group is malformed."); continue; }
    const id = (g as any).id;
    if (typeof id !== "string" || !isGroupId(id) || id.length > MAX_ID || seenGroup.has(id)) { if (strict) throw new Error(`Bad group id “${String(id)}” (must be unique and start with “${GROUP_PREFIX}”).`); continue; }
    if (strict && !Array.isArray((g as any).members)) throw new Error("A group needs a list of members.");
    const members: string[] = [];
    for (const x of Array.isArray((g as any).members) ? (g as any).members : []) {
      if (!memberOk(x) || seenMember.has(x) || (have?.size && !have.has(x))) continue;
      seenMember.add(x); members.push(x);
    }
    if (!members.length) continue;
    seenGroup.add(id);
    const name = String((g as any).name ?? "").trim().slice(0, MAX_NAME) || "Group";
    const color = typeof (g as any).color === "string" && COLOR.test((g as any).color) ? (g as any).color : undefined;
    out.push({ id, name, ...(color ? { color } : {}), members });
  }
  return out;
}

interface Port { getSetting(k: string): string | undefined; setSetting(k: string, v: string): void }
/** The Hub's rail-group storage: `get()` returns the stored groups cleaned against the spaces that exist now; `set()` validates and persists. */
export class RailGroups {
  constructor(private store: () => Port, private emit: (e: string, d: unknown) => void, private known: () => Promise<string[]>) {}
  private stored(): unknown { try { return JSON.parse(this.store().getSetting("railGroups") ?? "[]"); } catch { return []; } }
  async get(): Promise<RailGroup[]> { return normalizeRailGroups(this.stored(), await this.known()); }
  async set(groups: unknown): Promise<RailGroup[]> {
    const clean = normalizeRailGroups(groups, await this.known(), true);
    this.store().setSetting("railGroups", JSON.stringify(clean));
    this.emit("spaces-changed", {}); return clean;
  }
}

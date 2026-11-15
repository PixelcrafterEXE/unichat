// Folder semantics (local only, pure so the Hub and the UI mock share ONE implementation).
// The left rail shows network communities AND user folders; any chat can be moved into any of them or back to Personal.
// The override is a per-chat `folderId`; messages and the network's own structure are never touched.
import { isFolderId, PERSONAL, type Chat, type Folder, type Space } from "./model.js";

export interface FolderInput {
  spaces: Space[];                                         // network spaces, aliases/flags already applied
  chats: Chat[];                                           // member chats of merges included (they carry `mergedInto`), merged rows included
  folders: Folder[];
  overrides: Record<string, string>;                       // chat id -> folderId
  order: string[];                                         // user's rail order (space + folder ids); unknown ids are ignored, missing ones go last
  collapseSingle: boolean;                                 // "Show communities with only one chat as a normal chat"
  flags: Record<string, { muted?: boolean; archived?: boolean }>;
}

export function applyFolders(i: FolderInput): { spaces: Space[]; chats: Chat[] } {
  const folderSpaces: Space[] = i.folders.map((f) => ({
    id: f.id, accountId: "", provider: "folder", name: f.name, local: true, ...(f.color ? { color: f.color } : {}), ...(f.icon ? { icon: f.icon } : {}),
    ...(i.flags[f.id]?.muted ? { muted: true } : {}), ...(i.flags[f.id]?.archived ? { archived: true } : {}),
  }));
  const all = [...i.spaces, ...folderSpaces];
  const known = new Set(all.map((s) => s.id));
  // 1. effective folder per chat
  const eff = i.chats.map((c) => {
    const o = i.overrides[c.id];
    const valid = o === PERSONAL || (!!o && known.has(o));
    const spaceId = valid ? (o === PERSONAL ? undefined : o) : c.spaceId;
    const { spaceId: _drop, ...rest } = c;
    return { ...rest, ...(c.spaceId ? { networkSpaceId: c.spaceId } : {}), ...(valid ? { folderId: o } : {}), ...(spaceId ? { spaceId } : {}) } as Chat;
  });
  // 2. a network community with exactly one (visible) chat has no rail entry: its chat is a normal Personal chat
  const count = new Map<string, number>();
  for (const c of eff) if (c.spaceId && !c.mergedInto) count.set(c.spaceId, (count.get(c.spaceId) ?? 0) + 1);
  const collapsed = new Set<string>();
  if (i.collapseSingle) for (const s of i.spaces) if (count.get(s.id) === 1) collapsed.add(s.id);
  const chats = eff.map((c) => {
    if (!c.spaceId || !collapsed.has(c.spaceId)) return c;
    const sp = i.spaces.find((s) => s.id === c.spaceId);
    const { spaceId, ...rest } = c;
    return { ...rest, collapsedFrom: spaceId, ...(sp?.muted ? { muted: true } : {}) } as Chat; // a muted community stays quiet; archive does not follow (the chat's own flag decides)
  });
  // 3. rail order
  const pos = new Map(i.order.map((id, n) => [id, n]));
  const spaces = all.map((s, n) => ({ s: collapsed.has(s.id) ? { ...s, collapsed: true } : s, n }))
    .sort((a, b) => (pos.get(a.s.id) ?? 1e6 + a.n) - (pos.get(b.s.id) ?? 1e6 + b.n)).map((x) => x.s);
  return { spaces, chats };
}


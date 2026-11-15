// Pure rail-group operations (drag & drop, menus). State = the rail order of ALL space ids (`all`, the Hub's railOrder as the UI sees it) and
// the groups. A group sits in the rail where its first member sits; its members are kept next to each other in `all`, in `members` order.
import type { RailGroup } from "./types";

export interface RailState { all: string[]; groups: RailGroup[] }
export const GROUP_COLORS = ["#5865f2", "#3b82f6", "#23a559", "#e0a030", "#e67e22", "#eb459e", "#9b59b6", "#16a085", "#80848e",
  "#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981", "#06b6d4", "#0ea5e9", "#6366f1", "#a855f7", "#d946ef", "#f43f5e", "#78716c", "#334155", "#0f766e"];
export const isGroupKey = (k: string) => k.startsWith("group:");
export const groupOf = (groups: RailGroup[], id: string) => groups.find((g) => g.members.includes(id));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Move `ids` (as one block, in this order) next to `anchor` in `all` (anchor must not be one of `ids`). */
export function moveBlock(all: string[], ids: string[], anchor: string, after: boolean): string[] {
  const rest = all.filter((x) => !ids.includes(x)), i = rest.indexOf(anchor);
  if (i < 0) return all;
  rest.splice(after ? i + 1 : i, 0, ...ids); return rest;
}
/** A group needs two members: smaller ones dissolve (their member stays a normal rail icon). */
const tidy = (groups: RailGroup[]) => groups.filter((g) => g.members.length >= 2);
const without = (groups: RailGroup[], ids: string[]) => groups.map((g) => ({ ...g, members: g.members.filter((m) => !ids.includes(m)) }));
/** First / last member of a group that exists in `all` (the group's visual edges). */
const edge = (all: string[], g: RailGroup, last: boolean) => { const ids = all.length ? g.members.filter((m) => all.includes(m)) : g.members; return last ? ids[ids.length - 1] : ids[0]; };

/** Drop on the MIDDLE of a rail icon: onto a plain icon makes a new group of both; onto a group header or one of its members adds to that group. */
export function dropOnto(s: RailState, drag: string, target: string, newGroupId: string, color?: string): RailState | undefined {
  if (isGroupKey(drag) || drag === target) return undefined;
  const tg = isGroupKey(target) ? s.groups.find((g) => g.id === target) : groupOf(s.groups, target);
  if (tg) {
    if (tg.members.includes(drag)) return undefined;
    const anchor = edge(s.all, tg, true); if (!anchor) return undefined;
    const groups = tidy(without(s.groups, [drag]).map((g) => (g.id === tg.id ? { ...g, members: [...g.members, drag] } : g)));
    return { all: moveBlock(s.all, [drag], anchor, true), groups };
  }
  const base = without(s.groups, [drag]);
  return { all: moveBlock(s.all, [drag], target, true), groups: [...tidy(base), { id: newGroupId, name: "New group", ...(color ? { color } : {}), members: [target, drag] }] };
}

/** Drop on the TOP/BOTTOM EDGE of `anchor` (a space id or a group id): reorder. Next to a group member the dragged icon joins that group at that spot; next to a header or a plain icon it is top-level. */
export function dropEdge(s: RailState, drag: string, anchor: string, after: boolean): RailState | undefined {
  if (drag === anchor) return undefined;
  if (isGroupKey(drag)) { // a whole group moves as a block (never into another group)
    const g = s.groups.find((x) => x.id === drag); if (!g) return undefined;
    const ag = isGroupKey(anchor) ? s.groups.find((x) => x.id === anchor) : groupOf(s.groups, anchor);
    if (ag?.id === g.id) return undefined;
    const a = ag ? edge(s.all, ag, after) : anchor; if (!a) return undefined;
    return { all: moveBlock(s.all, g.members, a, after), groups: s.groups };
  }
  if (isGroupKey(anchor)) { // edge of a group header: top-level, before / after the whole group
    const ag = s.groups.find((x) => x.id === anchor); if (!ag) return undefined;
    const a = edge(s.all, { ...ag, members: ag.members.filter((m) => m !== drag) }, after); if (!a) return undefined;
    return { all: moveBlock(s.all, [drag], a, after), groups: tidy(without(s.groups, [drag])) };
  }
  const ag = groupOf(s.groups, anchor);
  if (ag) { // beside a member: reorder inside / join that group
    const members = ag.members.filter((m) => m !== drag), i = members.indexOf(anchor); members.splice(after ? i + 1 : i, 0, drag);
    const groups = tidy(without(s.groups, [drag]).map((g) => (g.id === ag.id ? { ...g, members } : g)));
    return { all: moveBlock(s.all, [drag], anchor, after), groups };
  }
  return { all: moveBlock(s.all, [drag], anchor, after), groups: tidy(without(s.groups, [drag])) };
}

/** "Remove from group": the icon becomes a normal rail icon right after its group. */
export function removeFromGroup(s: RailState, id: string): RailState {
  const g = groupOf(s.groups, id); if (!g) return s;
  const keep = g.members.filter((m) => m !== id), anchor = edge(s.all, { ...g, members: keep }, true);
  return { all: anchor ? moveBlock(s.all, [id], anchor, true) : s.all, groups: tidy(without(s.groups, [id])) };
}
export const ungroup = (s: RailState, gid: string): RailState => ({ all: s.all, groups: s.groups.filter((g) => g.id !== gid) });
/** "Add to group…" (keyboard alternative to dragging): into an existing group, or (gid undefined) a new group made with `with`. */
export function addToGroup(s: RailState, id: string, gid: string): RailState | undefined {
  const g = s.groups.find((x) => x.id === gid); if (!g) return undefined;
  return dropOnto(s, id, g.id, "");
}
/** Move a group member up / down inside its group, or a top-level entry among the entries (keyboard alternative to dragging). */
export function nudgeInGroup(s: RailState, id: string, dir: -1 | 1): RailState | undefined {
  const g = groupOf(s.groups, id); if (!g) return undefined;
  const i = g.members.indexOf(id), n = g.members[i + dir]; if (!n) return undefined;
  return dropEdge(s, id, n, dir > 0);
}
export const changed = (a: RailState, b: RailState) => !sameSet(a.all, b.all) || JSON.stringify(a.groups) !== JSON.stringify(b.groups);

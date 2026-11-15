// User categories (local only): the user's own headings INSIDE a view (a network community, a user folder or Personal) to organise its chats,
// next to the provider's own `Chat.category` (Discord categories ...). Nothing here touches the network, messages, folders or chat moves.
//
// Stored as two Hub settings (so they travel with backups and a future device sync like `railGroups` does):
//   `userCategories` = JSON `{ [spaceKey]: [{ id:"cat:<uuid>", name, color?, order }] }`  (spaceKey = community id, "folder:<uuid>" or "personal")
//   `chatCategories` = JSON `{ [chatId]: "cat:<uuid>" | "none" }`
// Per chat: absent = follow the provider's category; "none" = explicitly uncategorised (hides the provider's category); an id = that user category.
// An override only counts while its category belongs to the chat's CURRENT view; moving a chat to another view clears it (reconcile()).
import { PERSONAL, isFolderId, type Chat } from "./model.js";

export interface UserCategory { id: string; name: string; color?: string; order: number }
export type CategoriesBySpace = Record<string, UserCategory[]>;
export interface CategoryState { categories: CategoriesBySpace; chatCategory: Record<string, string> }
export const CAT_PREFIX = "cat:";
export const NO_CATEGORY = "none";
export const isCategoryId = (id: unknown): id is string => typeof id === "string" && id.startsWith(CAT_PREFIX) && id.length <= 200;
export const MAX_CAT_NAME = 40, MAX_CATS_PER_SPACE = 50;
const MAX_ID = 200, MAX_CHATS = 20000;
const COLOR = /^#[0-9a-f]{3,8}$/i;
const spaceOk = (k: string) => !!k && k.length <= MAX_ID && k !== "home" && !k.startsWith(CAT_PREFIX) && !k.startsWith("group:");

/**
 * Clean up categories: drops malformed entries, trims names (max 40), keeps only valid colours, removes duplicate ids (ids are unique across ALL spaces,
 * first wins), removes spaces that are not in `known` (when given and non-empty; Personal is always kept), re-numbers `order` 0..n by the given order
 * and drops empty lists. `strict` throws a user-facing error for input that is not a map of lists instead of silently repairing it.
 */
export function normalizeCategories(input: unknown, known?: Iterable<string>, strict = false): CategoriesBySpace {
  if (!input || typeof input !== "object" || Array.isArray(input)) { if (strict) throw new Error("Categories must be a map of lists."); return {}; }
  const have = known ? new Set([...known, PERSONAL]) : undefined, seen = new Set<string>(), out: CategoriesBySpace = {};
  for (const [space, list] of Object.entries(input as Record<string, unknown>)) {
    if (!spaceOk(space) || (have && have.size > 1 && !have.has(space))) { if (strict && !spaceOk(space)) throw new Error(`Bad space “${space}”.`); continue; }
    if (!Array.isArray(list)) { if (strict) throw new Error("A category list is malformed."); continue; }
    if (strict && list.length > MAX_CATS_PER_SPACE) throw new Error("Too many categories here.");
    const cleaned: UserCategory[] = [];
    for (const c of list.slice(0, MAX_CATS_PER_SPACE)) {
      if (!c || typeof c !== "object") { if (strict) throw new Error("A category is malformed."); continue; }
      const { id, name, color, order } = c as any;
      if (!isCategoryId(id) || seen.has(id)) { if (strict) throw new Error(`Bad category id “${String(id)}” (must be unique and start with “${CAT_PREFIX}”).`); continue; }
      seen.add(id);
      cleaned.push({ id, name: String(name ?? "").trim().slice(0, MAX_CAT_NAME) || "Category", ...(typeof color === "string" && COLOR.test(color) ? { color } : {}), order: Number.isFinite(order) ? Number(order) : cleaned.length });
    }
    const sorted = cleaned.map((c, i) => ({ c, i })).sort((a, b) => a.c.order - b.c.order || a.i - b.i).map(({ c }, n) => ({ ...c, order: n }));
    if (sorted.length) out[space] = sorted;
  }
  return out;
}

/**
 * Clean up per-chat overrides: values must be "none" or the id of an existing category. With `chatSpace` (chat id -> its current view) a chat must be
 * known and the category must belong to that view, otherwise the override is dropped (and `strict` throws).
 */
export function normalizeChatCategories(input: unknown, categories: CategoriesBySpace, chatSpace?: Map<string, string>, strict = false): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) { if (strict) throw new Error("Chat categories must be a map."); return {}; }
  const owner = new Map<string, string>(); for (const [s, l] of Object.entries(categories)) for (const c of l) owner.set(c.id, s);
  const out: Record<string, string> = {};
  for (const [chat, v] of Object.entries(input as Record<string, unknown>).slice(0, MAX_CHATS)) {
    const ok = !!chat && chat.length <= MAX_ID && typeof v === "string" && (v === NO_CATEGORY || owner.has(v));
    const here = chatSpace?.get(chat);
    if (!ok || (chatSpace && (here === undefined || (v !== NO_CATEGORY && owner.get(v as string) !== here)))) { if (strict) throw new Error("A chat category is not valid for that chat."); continue; }
    out[chat] = v as string;
  }
  return out;
}

/** The view a chat is listed in. */
export const viewOf = (c: { spaceId?: string }) => c.spaceId ?? PERSONAL;

/**
 * Snapshot step (after folders were applied, so `spaceId` is the effective view): sets the EFFECTIVE `category` (user category name, else the provider's
 * category while the chat is inside a community / folder, none for "none"), `categoryId` (user category) and `providerCategory` (the original).
 * An override whose category is not of the chat's view is ignored. Personal has no provider headings, only the user's.
 */
export function applyCategories(chats: Chat[], st: CategoryState): Chat[] {
  const byId = new Map<string, UserCategory>(); const owner = new Map<string, string>();
  for (const [s, l] of Object.entries(st.categories)) for (const c of l) { byId.set(c.id, c); owner.set(c.id, s); }
  return chats.map((c) => {
    const { category: provider, ...rest } = c, ov = st.chatCategory[c.id], uc = ov && ov !== NO_CATEGORY && owner.get(ov) === viewOf(c) ? byId.get(ov) : undefined;
    const effective = uc ? uc.name : ov === NO_CATEGORY || !c.spaceId ? undefined : provider;
    return { ...rest, ...(effective ? { category: effective } : {}), ...(uc ? { categoryId: uc.id } : {}), ...(provider ? { providerCategory: provider } : {}) } as Chat;
  });
}

interface Port { getSetting(k: string): string | undefined; setSetting(k: string, v: string): void }
/** What the manager needs to know about the world now (the Hub passes its snapshot). */
export interface CategoryWorld { spaces: string[]; chats: { id: string; spaceId?: string; mergedInto?: string }[] }
const parse = (s: string | undefined): unknown => { try { return JSON.parse(s ?? "{}"); } catch { return {}; } };
const uuid = () => globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** The Hub's category storage and rules. `state()` is cheap and synchronous (used by the snapshot); mutations validate against `world()`. */
export class Categories {
  constructor(private store: () => Port, private emit: (e: string, d: unknown) => void, private world: () => Promise<CategoryWorld>) {}
  /** Stored state, repaired but not checked against the world. */
  state(): CategoryState { const categories = normalizeCategories(parse(this.store().getSetting("userCategories"))); return { categories, chatCategory: normalizeChatCategories(parse(this.store().getSetting("chatCategories")), categories) }; }
  private save(st: CategoryState) {
    this.store().setSetting("userCategories", JSON.stringify(st.categories)); this.store().setSetting("chatCategories", JSON.stringify(st.chatCategory));
    this.emit("spaces-changed", {}); this.emit("chats-changed", {});
  }
  private spaceMap(w: CategoryWorld) { return new Map(w.chats.map((c) => [c.id, viewOf(c)])); }
  /** The state cleaned against what exists now (vanished spaces / chats pruned, mismatched overrides dropped). */
  async get(): Promise<CategoryState> {
    const w = await this.world(), st = this.state(), categories = normalizeCategories(st.categories, w.spaces);
    return { categories, chatCategory: normalizeChatCategories(st.chatCategory, categories, this.spaceMap(w)) };
  }
  private find(st: CategoryState, id: string) { for (const [space, list] of Object.entries(st.categories)) { const c = list.find((x) => x.id === id); if (c) return { space, list, cat: c }; } return undefined; }
  private nameClash(list: UserCategory[], name: string, except?: string) { return list.some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase()); }
  private cleanName(v: unknown) { const n = String(v ?? "").trim(); if (!n) throw new Error("Give the category a name."); if ([...n].length > MAX_CAT_NAME) throw new Error(`A category name has at most ${MAX_CAT_NAME} characters.`); return n; }
  private color(v: unknown) { if (v === undefined || v === null || v === "") return undefined; if (typeof v !== "string" || !COLOR.test(v)) throw new Error("That colour is not valid."); return v; }

  async create(p: { spaceId: string; name: string; color?: string }): Promise<UserCategory & { spaceId: string }> {
    const w = await this.world(), space = String(p.spaceId ?? ""), name = this.cleanName(p.name), color = this.color(p.color);
    if (space !== PERSONAL && !w.spaces.includes(space)) throw new Error("That folder or community no longer exists.");
    const st = { categories: normalizeCategories(this.state().categories), chatCategory: this.state().chatCategory }, list = st.categories[space] ?? [];
    if (list.length >= MAX_CATS_PER_SPACE) throw new Error("Too many categories here.");
    if (this.nameClash(list, name)) throw new Error(`There is already a category “${name}” here.`);
    const cat: UserCategory = { id: CAT_PREFIX + uuid(), name, ...(color ? { color } : {}), order: list.length };
    st.categories[space] = [...list, cat]; this.save(st); return { ...cat, spaceId: space };
  }
  async update(p: { id: string; name?: string; color?: string | null }): Promise<UserCategory & { spaceId: string }> {
    const st = this.state(), f = this.find(st, String(p.id)); if (!f) throw new Error("That category no longer exists.");
    const next: UserCategory = { ...f.cat };
    if (p.name !== undefined) { next.name = this.cleanName(p.name); if (this.nameClash(f.list, next.name, next.id)) throw new Error(`There is already a category “${next.name}” here.`); }
    if (p.color !== undefined) { const c = this.color(p.color); if (c) next.color = c; else delete next.color; }
    st.categories[f.space] = f.list.map((c) => (c.id === next.id ? next : c)); this.save(st); return { ...next, spaceId: f.space };
  }
  /** Deleting a category sends its chats back to following the provider's category (their overrides are removed). */
  async delete(id: string) {
    const st = this.state(), f = this.find(st, String(id)); if (!f) throw new Error("That category no longer exists.");
    const rest = f.list.filter((c) => c.id !== f.cat.id).map((c, n) => ({ ...c, order: n }));
    if (rest.length) st.categories[f.space] = rest; else delete st.categories[f.space];
    for (const [chat, v] of Object.entries(st.chatCategory)) if (v === f.cat.id) delete st.chatCategory[chat];
    this.save(st);
  }
  /** `categoryId`: a category of the chats' CURRENT view, "none" (uncategorised, hides the provider category) or null (follow the provider). All chats are checked first: nothing is changed on error. */
  async setChat(p: { chatIds: string[]; categoryId: string | null }): Promise<{ changed: number }> {
    if (!Array.isArray(p.chatIds) || !p.chatIds.length) throw new Error("No chat given.");
    const w = await this.world(), st = this.state(), byId = new Map(w.chats.map((c) => [c.id, c])), cid = p.categoryId ?? null;
    const f = cid !== null && cid !== NO_CATEGORY ? this.find(st, cid) : undefined;
    if (cid !== null && cid !== NO_CATEGORY && !f) throw new Error("That category no longer exists.");
    const targets = [...new Set(p.chatIds.map(String).map((id) => { const c = byId.get(id); if (!c) throw new Error("That chat no longer exists."); return c.mergedInto ?? c.id; }))];
    for (const id of targets) if (f && viewOf(byId.get(id)!) !== f.space) throw new Error("That category belongs to another folder: move the chat there first.");
    let changed = 0;
    for (const id of targets) { const had = st.chatCategory[id]; if (cid === null) delete st.chatCategory[id]; else st.chatCategory[id] = cid; if (had !== (cid ?? undefined)) changed++; }
    this.save(st); return { changed };
  }
  /** Order of the user categories of one view; unknown ids are ignored, categories not mentioned follow in their old order. */
  async setOrder(p: { spaceId: string; ids: string[] }): Promise<UserCategory[]> {
    const st = this.state(), list = st.categories[String(p.spaceId)]; if (!list) throw new Error("There are no categories here.");
    const want = (Array.isArray(p.ids) ? p.ids : []).map(String), first = want.map((id) => list.find((c) => c.id === id)).filter((c): c is UserCategory => !!c);
    st.categories[p.spaceId] = [...new Set([...first, ...list])].map((c, n) => ({ ...c, order: n })); this.save(st); return st.categories[p.spaceId];
  }
  /**
   * After chats moved / folders were deleted: persist the clean state. Categories of deleted FOLDERS go (network communities are kept, they may only be
   * offline), as do overrides to missing categories and overrides of known chats whose category is not of their view (or "none" after a move: the other
   * view has other provider headings). Overrides of chats that are not known right now are kept (the provider may just be offline).
   */
  async reconcile(movedChatIds: string[] = []) {
    const w = await this.world(), st = this.state(), live = new Set(w.spaces), view = this.spaceMap(w), moved = new Set(movedChatIds), before = JSON.stringify(st);
    for (const s of Object.keys(st.categories)) if (isFolderId(s) && !live.has(s)) delete st.categories[s];
    const owner = new Map<string, string>(); for (const [s, l] of Object.entries(st.categories)) for (const c of l) owner.set(c.id, s);
    for (const [chat, v] of Object.entries(st.chatCategory)) {
      const here = view.get(chat);
      if ((v !== NO_CATEGORY && !owner.has(v)) || (v === NO_CATEGORY && moved.has(chat)) || (v !== NO_CATEGORY && here !== undefined && owner.get(v) !== here)) delete st.chatCategory[chat];
    }
    if (JSON.stringify(st) !== before) this.save(st);
  }
}

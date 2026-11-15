// Keeps a SearchIndex current from every write that goes through the Hub's store (live messages, edits, deletions, history top-ups,
// own sends, retention, account removal) without touching the call sites: the Hub hands this wrapper to its own code.
import type { Store } from "./store.js";
import type { SearchIndex } from "./search.js";

export function withSearchIndex(store: Store, idx: SearchIndex): Store {
  const refresh = (chatId: string, id: string) => { try { const m = store.getMessage(chatId, id); if (m) idx.upsert(m); else idx.remove(chatId, id); } catch { /* index is best effort */ } };
  return new Proxy(store, {
    get(t, prop) {
      const v = (t as any)[prop];
      if (typeof v !== "function") return v;
      switch (prop) {
        case "putMessages": return (ms: { chatId: string; id: string }[]) => { (v as Function).call(t, ms); for (const m of ms) refresh(m.chatId, m.id); };
        case "patchMessage": return (chatId: string, id: string, patch: unknown) => { (v as Function).call(t, chatId, id, patch); refresh(chatId, id); };
        case "deleteMessagesBefore": return (iso: string) => { const n = (v as Function).call(t, iso); idx.removeBefore(iso); return n; };
        case "deleteAccountData": return (id: string) => { (v as Function).call(t, id); idx.removeAccount(id); };
      }
      return (v as Function).bind(t);
    },
  });
}

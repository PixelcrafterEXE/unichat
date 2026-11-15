// User categories in the chat list (local, see packages/core/src/categories.ts): the dialogs. The list itself is rendered by App.tsx.
import { useState } from "react";
import type { Chat, UserCategory } from "./types";
import { Modal, FOLDER_COLORS, ColourPicker } from "./Modals";
import { Check, ListPlus, RotateCcw } from "./icons";

/** "New category" / "Rename category" / "Category colour". `focus` only decides which field gets the cursor. */
export function CategoryModal({ category, where, focus, onSave, onClose }: { category?: UserCategory; where: string; focus?: "name" | "colour"; onSave: (v: { name: string; color: string | null }) => void; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState<string | null>(category?.color ?? null);
  return (
    <Modal title={category ? (focus === "colour" ? "Category colour" : "Rename category") : "New category"} onClose={onClose}>
      <p className="hint">Your own heading in “{where}”. Only exists in UniChat: nothing changes on the network.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), color }); }}>
        <label>Name<input autoFocus={focus !== "colour"} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Planning" onFocus={(e) => e.currentTarget.select()} /></label>
        <label>Colour</label>
        <ColourPicker value={color} onChange={setColor} allowNone autoFocusValue={focus === "colour"} />
        <button className="primary" disabled={!name.trim()}>{category ? "Save" : "Create category"}</button>
      </form>
    </Modal>
  );
}

/** "Move to category…": the user's categories of the chats' view, "No category", a new category and a way back to the provider's category. */
export function CategoryPickModal({ chats, cats, onPick, onNew, onClose }: { chats: Chat[]; cats: UserCategory[]; onPick: (target: string | null) => void; onNew: () => void; onClose: () => void }) {
  const here = (id: string) => chats.every((c) => c.categoryId === id);
  const provider = [...new Set(chats.map((c) => c.providerCategory))], pc = provider.length === 1 ? provider[0] : undefined;
  const overridden = chats.some((c) => c.categoryId || (c.providerCategory && !c.category));
  const uncategorised = chats.every((c) => !c.category);
  return (
    <Modal title={chats.length > 1 ? `Move ${chats.length} chats to a category` : `Move “${chats[0].name}” to a category`} onClose={onClose}>
      <p className="hint">Categories are your own headings; only UniChat knows them. Nothing changes on the network.</p>
      <ul className="pick tall movelist">
        <li><button className={"rowbtn" + (uncategorised ? " sel" : "")} data-target="none" onClick={() => onPick("none")}><span className="mname">No category</span>{uncategorised && <Check size={14} className="where" />}</button></li>
        {cats.map((c) => (
          <li key={c.id}><button className={"rowbtn" + (here(c.id) ? " sel" : "")} data-target={c.id} onClick={() => onPick(c.id)}>
            <i className="catdot" style={{ background: c.color ?? "var(--muted)" }} /><span className="mname">{c.name}</span>{here(c.id) && <Check size={14} className="where" />}</button></li>))}
      </ul>
      <button className="secondary wide" data-act="new-category" onClick={onNew}><ListPlus size={15} /> New category…</button>
      {overridden && pc && <button className="secondary reset" data-target="reset" onClick={() => onPick(null)}><RotateCcw size={15} /> Provider category: {pc}</button>}
      {overridden && !pc && provider.every((p) => !p) && chats.some((c) => c.categoryId) && <button className="secondary reset" data-target="reset" onClick={() => onPick(null)}><RotateCcw size={15} /> Remove from my categories</button>}
    </Modal>
  );
}

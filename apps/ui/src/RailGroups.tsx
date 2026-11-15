// Rail groups (UI): the group tile (mini icons of its members), the name/colour dialog and the "Add to group…" chooser.
import { useState } from "react";
import type { RailGroup, Space } from "./types";
import { SpaceIcon } from "./util";
import { Folder, FolderPlus, Check } from "./icons";
import { Modal, ColourPicker } from "./Modals";
import { GROUP_COLORS } from "./railGroupOps";

/** Content of a group's rail button: collapsed = the first four member icons (a fixed 2x2 grid, never a "+N" cell: a fifth child overflowed the tile); expanded = a folder glyph. */
export function GroupTile({ members, color, open }: { members: Space[]; color?: string; open: boolean }) {
  const bg = color ?? "var(--accent)";
  if (open) return <span className="gtile open" style={{ background: bg }}><Folder size={22} color="#fff" /></span>;
  const shown = members.slice(0, 4);
  return (
    <span className="gtile" style={{ background: `color-mix(in srgb, ${bg} 38%, var(--bg3))`, boxShadow: `inset 0 0 0 2px ${bg}` }} aria-hidden>
      {shown.map((m) => <span className="gmini" key={m.id}><SpaceIcon space={m} size={20} /></span>)}
    </span>);
}

/** "Rename / Colour group…" (also names a new group). */
export function GroupModal({ group, onSave, onClose }: { group: RailGroup; onSave: (v: { name: string; color: string }) => void; onClose: () => void }) {
  const [name, setName] = useState(group.name);
  const [color, setColor] = useState(group.color ?? GROUP_COLORS[0]);
  return (
    <Modal title="Rename / colour group" onClose={onClose}>
      <p className="hint">Groups only exist in UniChat. They keep communities and folders together in the left bar.</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), color }); }}>
        <label>Name<input autoFocus value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work" /></label>
        <label>Colour</label>
        <ColourPicker value={color} onChange={(c) => setColor(c ?? GROUP_COLORS[0]!)} />
        <button className="primary" disabled={!name.trim()}>Save</button>
      </form>
    </Modal>);
}

/** "Add to group…": the keyboard / menu alternative to dragging an icon onto another. Pick an existing group, or another icon to make a new group with. */
export function AddToGroupModal({ space, groups, others, current, onPick, onClose }: { space: Space; groups: RailGroup[]; others: Space[]; current?: string; onPick: (target: string) => void; onClose: () => void }) {
  return (
    <Modal title={`Add “${space.name}” to a group`} onClose={onClose}>
      {groups.length > 0 && <><label>Existing group</label>
        <ul className="pick grouplist">
          {groups.map((g) => (
            <li key={g.id}><button className={"rowbtn" + (g.id === current ? " sel" : "")} data-group={g.id} onClick={() => onPick(g.id)}>
              <span className="foldericon sm" style={{ background: g.color ?? "var(--accent)" }}><Folder size={14} color="#fff" /></span><span className="mname">{g.name}</span>
              <small className="where">{g.members.length} in group</small>{g.id === current && <Check size={14} className="where" />}</button></li>))}
        </ul></>}
      {others.length > 0 && <><label>New group together with</label>
        <ul className="pick tall grouplist">
          {others.map((o) => (
            <li key={o.id}><button className="rowbtn" data-with={o.id} onClick={() => onPick(o.id)}><SpaceIcon space={o} size={28} /><span className="mname">{o.name}</span><FolderPlus size={14} className="where" /></button></li>))}
        </ul></>}
      {!groups.length && !others.length && <p className="hint">There is nothing to group this with yet.</p>}
    </Modal>);
}

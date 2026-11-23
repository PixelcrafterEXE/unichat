import { memo } from "react";
import type { Chat, Space } from "./types";
import { Avatar, ProviderIcon, useLongPress } from "./util";
import { Archive, ArchiveRestore, Bell, BellOff, CloudOff, FolderInput, GitMerge, Hash, LogOut, MoreHorizontal, Pencil, Pin, PinOff, MarkRead, Star, StarOff, Tag, Unlink } from "./icons";

/** Everything a row needs from the app. ONE stable object whose members are always the latest closures, so a row only re-renders when ITS data changes. */
export interface RowApi {
  click(e: React.MouseEvent, c: Chat): void;
  context(x: number, y: number, c: Chat): void;
  more(e: React.MouseEvent, c: Chat): void;
  longPress(c: Chat): void;
  dragStart(e: React.DragEvent, c: Chat): void;
  dragOver(e: React.DragEvent, c: Chat): void;
  drop(e: React.DragEvent, c: Chat): void;
  closeMenu(): void;
  togglePin(c: Chat): void; toggleStar(c: Chat): void; toggleMute(c: Chat): void; markRead(c: Chat): void; markUnread(c: Chat): void; archive(c: Chat): void; rename(c: Chat): void;
  move(c: Chat): void; category(c: Chat): void; merge(c: Chat): void; unmerge(c: Chat): void;
}
export interface RowProps {
  c: Chat; api: RowApi; active: boolean; menuOpen: boolean; selected: boolean; selMode: boolean; muted: boolean; pinned: boolean;
  /** media that is not available offline (signed-out chats) */ noOffline: number;
  /** the community the chat left (or its own), when known */ origin?: Space;
  /** providers of the members of a merged chat, joined by "," */ memberProviders?: string;
  coarse: boolean;
  /** green presence dot (DM contact online; merged rows: any member) */ online?: boolean;
}

export const ChatRow = memo(function ChatRow({ c, api, active, menuOpen, selected, selMode, muted, pinned, noOffline, origin, memberProviders, coarse, online }: RowProps) {
  const lp = useLongPress(() => api.longPress(c));
  const away = !!origin && origin.id !== c.spaceId && !c.mergeMembers;
  return (
    <li data-chat={c.id} draggable={!coarse} aria-selected={selected || undefined} onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
      onDragOver={(e) => api.dragOver(e, c)} onDrop={(e) => api.drop(e, c)} onDragStart={(e) => api.dragStart(e, c)}
      className={(active ? "active" : "") + (c.archived ? " archivedrow" : "") + (menuOpen ? " menuopen" : "") + (selected ? " selected" : "") + (selMode ? " selmode" : "")}
      onClick={(e) => { if (lp.swallow()) return; api.click(e, c); }}
      onTouchStart={lp.onTouchStart} onTouchMove={lp.onTouchMove} onTouchEnd={lp.onTouchEnd} onTouchCancel={lp.onTouchCancel}
      onContextMenu={(e) => { e.preventDefault(); api.context(e.clientX, e.clientY, c); }}>
      {selMode && <span className={"selbox" + (selected ? " on" : "")} aria-hidden />}
      {/* a chat that left its community looks like a normal group: its own picture, else the community's */}
      {(c.kind === "channel" && !away) ? <span className="hash hb"><Hash size={18} /><span className="avbadge"><ProviderIcon provider={c.provider} size={13} /></span></span>
        : <Avatar name={away && c.kind === "channel" ? origin!.name : c.name} url={c.avatarUrl} of={{ kind: "chat", id: c.id }} size={36} provider={c.provider} online={online}
            providers={memberProviders ? memberProviders.split(",") : undefined} fallback={away ? { kind: "space", id: origin!.id, url: origin!.iconUrl } : undefined} />}
      <span className="ctext"><span className="name"><span className="nm">{c.name}</span>{muted && <BellOff size={12} className="inl" />}</span>{(c.preview || c.request) && <small>{c.request && <em className="reqtag">Message request</em>}{c.preview}</small>}</span>
      {c.offline && <LogOut size={12} className="pinned" aria-label="Signed out: read-only" />}
      {c.offline && noOffline > 0 && <CloudOff size={13} className="nooffline" data-nooffline={noOffline} aria-label="Some media is not available offline" />}
      {c.starred && <Star size={12} className="pinned" aria-label="Starred" data-starred />}
      {pinned && <Pin size={12} className="pinned" />}
      {!!c.unread && (c.unreadApprox ? <i className={"unreaddot" + (muted ? " muted" : "")} title="New messages" aria-label="New messages" /> : <b className={"unread" + (muted ? " muted" : "")}>{c.unread}</b>)}
      <button className="icon more" aria-label="Chat options" onClick={(e) => { e.stopPropagation(); api.more(e, c); }}><MoreHorizontal size={16} /></button>
      {menuOpen && (
        <div className="popmenu chatmenu" onClick={(e) => e.stopPropagation()} onMouseLeave={() => { if (!coarse) api.closeMenu(); }}>
          <button onClick={() => { api.togglePin(c); api.closeMenu(); }}>{pinned ? <><PinOff size={16} /> Unpin</> : <><Pin size={16} /> Pin to top</>}</button>
          <button data-act="star" onClick={() => { api.toggleStar(c); api.closeMenu(); }}>{c.starred ? <><StarOff size={16} /> Unstar</> : <><Star size={16} /> Star (prioritize)</>}</button>
          <button onClick={() => { api.toggleMute(c); api.closeMenu(); }}>{muted ? <><Bell size={16} /> Unmute</> : <><BellOff size={16} /> Mute</>}</button>
          {!!c.unread ? <button data-act="mark-read" onClick={() => { api.markRead(c); api.closeMenu(); }}><MarkRead size={16} /> Mark as read</button>
            : <button data-act="mark-unread" onClick={() => { api.markUnread(c); api.closeMenu(); }}><MarkRead size={16} /> Mark as unread</button>}
          <button onClick={() => { api.archive(c); api.closeMenu(); }}>{c.archived ? <><ArchiveRestore size={16} /> Unarchive</> : <><Archive size={16} /> Archive</>}</button>
          <button onClick={() => { api.rename(c); api.closeMenu(); }}><Pencil size={16} /> Rename</button>
          <button onClick={() => { api.move(c); api.closeMenu(); }}><FolderInput size={16} /> Move to folder…</button>
          <button data-act="chat-category" onClick={() => { api.category(c); api.closeMenu(); }}><Tag size={16} /> Move to category…</button>
          {c.kind === "dm" && c.provider !== "mesh" && <button onClick={() => { api.merge(c); api.closeMenu(); }}><GitMerge size={16} /> {c.mergeMembers ? "Merge with more…" : "Merge with…"}</button>}
          {c.mergeMembers && <button onClick={() => { api.unmerge(c); api.closeMenu(); }}><Unlink size={16} /> Unmerge</button>}
        </div>)}
    </li>
  );
});

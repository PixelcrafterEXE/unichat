import { useEffect, useRef, useState } from "react";
import type { Account, Attachment, Capabilities, Chat, Contact, Message, ProviderInfo, Space } from "./types";
import { Play, FolderInput, RotateCcw, GitMerge, Unlink, Star, Clock3, Info, RefreshCw, Ban, LogOut, UserMinus, UserPlus, Pencil, Bell, BellOff, FileText, ImageIcon, Lock, MapPin, Plus, Search, Trash2, X } from "./icons";
import { capsOf } from "./types";
import { PinnedList, usePins } from "./Pins";
import { acctStatus, viaNote } from "./relay";
import { focusAccount, settingsNav } from "./StatusDots";
import { BackupPanel, ExportChatButton } from "./BackupPanel";
import { hasSyncLink } from "./syncLink";
import { SyncPanel } from "./SyncPanel"; // device sync
import { SignalBackupImport } from "./SignalBackupImport";
import { WhatsAppBackupImport } from "./WhatsAppBackupImport";
import { StoragePanel } from "./MediaUI";
import { AccountVerify, PersonVerify } from "./VerifyDialog"; // identity verification
import { MediaGallery, VideoCover, type MediaTab } from "./MediaGallery";
import { Marked } from "./GlobalSearch";
import { DisappearingSetting } from "./Disappearing";
import { UpdatesSection, updatesNav } from "./Updates";
import { Avatar, ProviderIcon, SpaceIcon, core, fmtBytes, fmtTime, forgetAvatar, presenceText, squareImage, useAttachment, type Settings } from "./util";

function Thumb({ chat, m, a, onJump }: { chat: Chat; m: Message; a: Attachment; onJump: (m: Message) => void }) {
  const video = a.kind === "video";
  const { r } = useAttachment(m.chatId || chat.id, m.id, a, !video); // (a merged chat's messages live in their member chats)
  const src = r?.url ?? a.thumbnailDataUrl;
  return <button className="thumb" data-jump={m.id} data-kind={a.kind} title="Show in the conversation" onClick={() => onJump(m)}>{video ? <><VideoCover chat={chat} m={m} a={a} on /><span className="thumbplay"><Play size={12} fill="currentColor" /></span></> : src ? <img src={src} alt="" /> : <ImageIcon size={20} />}</button>;
}

export interface PlaceInfo {
  /** the network community this (collapsed, single-chat) chat is part of */ community?: Space; folder?: Space; original?: Space;
  onMove: () => void; onReset: () => void; onCommunityInfo: () => void; onCommunityRename: () => void; onCommunityMute: () => void; onCommunityLeave?: () => void;
}
/** Android 13+: notifications need a permission. Shown in Settings > Notifications with a button that asks (or opens Android's settings once it stopped asking). */
function AndroidNotifPermission() {
  const [granted, setGranted] = useState<boolean>();
  const check = () => core.call("$notificationState", {}).then((r: { granted: boolean }) => setGranted(!!r.granted), () => setGranted(undefined));
  useEffect(() => { void check(); addEventListener("focus", check); return () => removeEventListener("focus", check); }, []);
  if (granted === undefined || granted) return granted ? <p className="hint ok" data-notif-granted>Notifications are allowed.</p> : null;
  return (
    <div className="notifwarn" data-notif-denied role="alert"><b>Notifications are turned off for UniChat</b>
      <span>Android is blocking them, so you won't hear about new messages while the app is closed.</span>
      <button className="primary" onClick={() => void core.call("$requestNotifications", {}).then(() => setTimeout(check, 1500), () => {})}>Allow notifications</button></div>);
}
/** DM info: groups (and communities) you are both in. Asks the backend, which lists the members of your groups; shows nothing while there is nothing. */
function CommonChats({ chat }: { chat: Chat }) {
  const [r, setR] = useState<{ groups: Chat[]; communities: { id: string; name: string }[] } | "loading" | "none">("loading");
  useEffect(() => { let on = true; setR("loading"); core.call("commonChats", { chatId: chat.id }).then((x: { groups: Chat[]; communities: { id: string; name: string }[] }) => on && setR(x), () => on && setR("none")); return () => { on = false; }; }, [chat.id]);
  if (r === "none") return null;
  if (r === "loading") return <section className="commonsec"><h4>Groups in common</h4><p className="hint">Looking…</p></section>;
  if (!r.groups.length) return <section className="commonsec"><h4>Groups in common</h4><p className="hint">None found.</p></section>;
  return (
    <section className="commonsec"><h4>Groups in common · {r.groups.length}</h4>
      {r.communities.length > 0 && <p className="hint">Communities: {r.communities.map((c) => c.name).join(", ")}</p>}
      {r.groups.map((g) => (
        <button key={g.id} type="button" className="netrow linklike" onClick={() => window.dispatchEvent(new CustomEvent("unichat-open-chat", { detail: g.id }))}>
          <Avatar name={g.name} url={g.avatarUrl} of={{ kind: "chat", id: g.id }} size={30} /><span className="mtext"><b>{g.name}</b></span></button>))}
    </section>);
}
export function ContactPanel({ place, merge, onMerge, chat, caps, messages, muted, onMute, onSearch, onClose, onImage, onJump, onRename, providerName, reloadKey, onLeave, onBlock, onAddMembers, onRemoveMember, onRenameNetwork, onPerson }: {
  place?: PlaceInfo;
  /** merged chat: its member chats with what is needed to describe them, and the merge actions */
  merge?: { members: Chat[]; providers: ProviderInfo[]; accounts: Account[]; onUnmerge: () => void; onMergeMore: () => void; onPrimary: (chatId: string) => void; onRemove: (chatId: string) => void };
  onMerge?: () => void;
  onPerson: (c: Contact) => void; reloadKey: number; onRename: () => void; onLeave: () => void; onBlock: () => void; onAddMembers: () => void; onRemoveMember: (c: Contact) => void; onRenameNetwork: () => void;
  chat: Chat; caps?: Capabilities; messages: Message[]; muted: boolean; onMute: () => void; onSearch: () => void; onClose: () => void; onImage: (u: string) => void; onJump?: (messageId: string, chatId?: string) => void; providerName: string;
}) {
  // shared media comes from the whole archive, not only from the messages the conversation view has loaded
  const [archived, setArchived] = useState<{ messages: Message[]; places: number; count?: Partial<Record<MediaTab, number>> }>();
  const [gallery, setGallery] = useState(false);
  useEffect(() => { let on = true; setArchived(undefined); core.call("chatMedia", { chatId: chat.id, limit: 60, kinds: ["media", "files"] }).then((r: { messages: Message[]; places: number; count?: Partial<Record<MediaTab, number>> }) => on && setArchived(r), async () => {
      // an older backend without `chatMedia`: page back through the history until there is enough media (or the chat ends)
      try {
        const got: Message[] = []; let before: string | undefined, places = 0;
        for (let i = 0; i < 12 && on && got.length < 40; i++) {
          const page: Message[] = await core.call("history", { chatId: chat.id, limit: 200, ...(before ? { beforeMessageId: before } : {}) });
          if (!page?.length) break;
          before = page[0]!.id; places += page.filter((m) => m.location).length;
          got.push(...page.filter((m) => !m.deleted && (m.attachments ?? []).some((a) => a.kind === "image" || a.kind === "video" || a.kind === "file")));
        }
        if (on) setArchived({ messages: got, places });
      } catch { /* the sidebar then shows what the conversation view has loaded */ }
    }); return () => { on = false; }; }, [chat.id, reloadKey]);
  const [members, setMembers] = useState<(Contact & { chatId?: string })[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (reloadKey === 0 || members.length === 0) setLoading(true); // keep the list visible on background reloads
    if (chat.provider === "mesh") { setMembers([]); setLoading(false); return; }
    core.call("members", { chatId: chat.id }).then((m: Contact[]) => setMembers(m ?? []), () => setMembers([])).finally(() => setLoading(false));
  }, [chat.id, reloadKey]);
  const dm = chat.kind === "dm"; const person = dm ? members[0] : undefined;
  const all = (() => { const seen = new Set<string>(), out: Message[] = []; for (const m of [...(archived?.messages ?? []), ...messages]) { const k = (m.chatId ?? chat.id) + "|" + m.id; if (!seen.has(k)) { seen.add(k); out.push(m); } } return out.sort((a, b) => a.time.localeCompare(b.time)); })();
  const pinCaps = !!caps?.pinMessages || !!merge?.members.some((c) => capsOf(merge.accounts.find((x) => x.id === c.accountId), merge.providers, c.provider)?.pinMessages);
  const pinSec = <PinnedList pins={usePins(chat.id, messages, pinCaps)} canUnpin={pinCaps} onJump={onJump} />;
  const media = all.flatMap((m) => (m.deleted ? [] : m.attachments ?? []).filter((a) => a.kind === "image" || a.kind === "video").map((a) => ({ m, a }))).slice(-15).reverse();
  const files = all.flatMap((m) => (m.deleted ? [] : m.attachments ?? []).filter((a) => a.kind === "file").map((a) => ({ m, a }))).slice(-5).reverse();
  const cn = archived?.count, shownTotal = cn ? (cn.media || (cn.files ?? 0) + (cn.links ?? 0) + (cn.voice ?? 0)) : 0;
  const places = Math.max(messages.filter((m) => m.location).length, archived?.places ?? 0);
  return (
    <aside className="info">
      <header><span>{dm ? "Contact info" : chat.kind === "channel" ? "Channel info" : "Group info"}</span><button className="icon" onClick={onClose}><X size={18} /></button></header>
      <div className="infobody">
        <div className="hero"><Avatar name={chat.name} url={chat.avatarUrl ?? person?.avatarUrl} of={{ kind: "chat", id: chat.id }} size={96} zoom online={dm && (chat.online ?? person?.online)} /><h2>{chat.kind === "channel" ? "# " : ""}{chat.name}<button className="icon" title="Rename" onClick={onRename}><Pencil size={15} /></button></h2>
          {chat.originalName && <div className="handle">{merge ? "Original" : providerName} name: {chat.originalName}</div>}
          {person?.handle && !merge && <div className="handle">{person.handle}</div>}
          {dm && !merge && (() => { const p = { online: chat.online ?? person?.online, lastSeen: chat.lastSeen ?? person?.lastSeen }, t = presenceText(p); return t ? <div className="handle presence" data-presence={p.online ? "online" : "seen"}>{t}</div> : null; })()}
          {caps?.e2ee && <div className="tags"><span className="tag"><Lock size={11} /> End-to-end encrypted</span></div>}</div>
        {(chat.description || (!dm && chat.provider !== "mesh" && caps?.chatDescription && chat.canManage !== false)) && <ChatAbout chat={chat} editable={!dm && chat.provider !== "mesh" && !!caps?.chatDescription && chat.canManage !== false} />}
        <div className="infoactions">
          <button onClick={onSearch}><Search size={15} /> Search</button>
          <button onClick={onMute}>{muted ? <><Bell size={15} /> Unmute</> : <><BellOff size={15} /> Mute</>}</button>
        </div>
        <ExportChatButton chat={chat} />
        <DisappearingSetting chat={chat} caps={caps} />
        {dm && !merge && caps?.verification && <PersonVerify accountId={chat.accountId} chatId={chat.id} name={chat.name} />}
        {dm && chat.provider !== "mesh" && <CommonChats chat={chat} />}
        {place && (
          <section className="placesec"><h4>Place</h4>
            <div className="placerow"><span className="mtext"><b>{chat.spaceId ? (place.folder?.name ?? "Folder") : "Personal"}</b>
              {chat.folderId ? <small>Moved here by you{place.original ? ` · originally in ${place.original.name}` : chat.networkSpaceId ? "" : " · originally Personal"}</small> : <small>{chat.spaceId ? "Where the network put it" : chat.collapsedFrom ? "Shown with your normal chats" : "Not part of a community"}</small>}</span>
              <button className="secondary" onClick={place.onMove}><FolderInput size={15} /> Move to folder…</button></div>
            {chat.folderId && <button className="secondary wide" onClick={place.onReset}><RotateCcw size={15} /> Reset to original place</button>}
            {place.community && (
              <div className="commsec"><div className="placerow"><SpaceIcon space={place.community} size={32} /><span className="mtext"><b>Part of community {place.community.name}</b><small>It only has this one chat, so it is listed with your normal chats{place.community.muted ? " · community muted" : ""}</small></span></div>
                <div className="mergebtns"><button className="secondary" onClick={place.onCommunityInfo}><Info size={15} /> Community info</button><button className="secondary" onClick={place.onCommunityRename}><Pencil size={15} /> Rename community</button>
                  <button className="secondary" onClick={place.onCommunityMute}>{place.community.muted ? <><Bell size={15} /> Unmute community</> : <><BellOff size={15} /> Mute community</>}</button>
                  {place.onCommunityLeave && <button className="danger" onClick={place.onCommunityLeave}><LogOut size={15} /> Leave community</button>}</div></div>)}
          </section>)}
        {merge && (
          <section className="mergesec"><h4>Networks · {merge.members.length}</h4>
            {merge.members.map((c, i) => { const prov = merge.providers.find((x) => x.name === c.provider)?.displayName ?? c.provider, acc = merge.accounts.find((a) => a.id === c.accountId)?.label ?? c.accountId;
              const handle = members.find((x) => x.chatId === c.id)?.handle;
              return (
                <div key={c.id} className="netrow"><ProviderIcon provider={c.provider} size={26} />
                  <span className="mtext"><b>{prov}{i === 0 && <em className="primtag" title="Name and picture come from this chat"> primary</em>}</b><small>{handle ?? c.name}</small><small>{acc}{c.offline ? " · signed out" : ""}</small></span>
                  {i > 0 && <button className="icon" title="Use this chat's name and picture" aria-label={`Make ${prov} primary`} onClick={() => merge.onPrimary(c.id)}><Star size={15} /></button>}
                  <button className="icon rm" title="Remove from this merged chat" aria-label={`Remove ${prov} from merge`} onClick={() => merge.onRemove(c.id)}><Unlink size={15} /></button>
                </div>); })}
            <p className="hint">One person, several chats: this view is local to UniChat. Each message keeps going through its own network.</p>
            <div className="mergebtns"><button className="secondary" onClick={merge.onMergeMore}><GitMerge size={15} /> Merge with more…</button><button className="secondary" onClick={merge.onUnmerge}><Unlink size={15} /> Unmerge</button></div>
          </section>)}
        {onMerge && <button className="secondary wide" onClick={onMerge}><GitMerge size={15} /> Merge with other chats of this person…</button>}
        {pinSec}
        {!dm && chat.provider !== "mesh" && (
          <section><h4>Members{members.length ? ` · ${members.length}` : ""}</h4>
            {loading ? <p className="hint">Loading…</p> : members.map((c) => (
              <div key={c.id} className="member"><button className="avbtn" title={`Show ${c.name}`} onClick={() => onPerson(c)}><Avatar name={c.name} url={c.avatarUrl} of={{ kind: "contact", id: `${chat.accountId}:${c.id}` }} size={32} online={c.online} /></button><span className="mtext" onClick={() => onPerson(c)}><b>{c.name}</b>{c.handle && <small>{c.handle}</small>}{presenceText(c) && <small className="presence" data-presence={c.online ? "online" : "seen"}>{presenceText(c)}</small>}</span>{caps?.manageMembers && chat.canManage !== false && <button className="icon rm" title={`Remove ${c.name}`} onClick={() => onRemoveMember(c)}><UserMinus size={15} /></button>}</div>))}
            {!loading && caps?.manageMembers && chat.canManage !== false && <button className="secondary addm" onClick={onAddMembers}><UserPlus size={15} /> Add people</button>}
            {!loading && !members.length && <p className="hint">Member list unavailable.</p>}</section>)}
        {!dm && chat.provider !== "mesh" && caps?.renameChat && chat.canManage !== false && <button className="secondary wide" onClick={onRenameNetwork}><Pencil size={15} /> Rename for everyone</button>}
        {!dm && chat.provider !== "mesh" && caps?.chatPicture && chat.canManage !== false && <GroupPicture chat={chat} />}
        {chat.provider === "mesh" && <section><h4>Mesh group</h4><p className="hint">Messages are relayed between members on different platforms by your accounts. Members see relayed messages as coming from you.</p></section>}
        <section><h4>Shared media</h4>
          {media.length ? <div className="thumbs">{media.map(({ m, a }) => <Thumb key={m.chatId + m.id + a.id} chat={chat} m={m} a={a} onJump={(x) => onJump?.(x.id, x.chatId)} />)}</div> : <p className="hint">No media yet</p>}
          {(media.length > 0 || files.length > 0 || !!shownTotal) && <button className="secondary wide" data-act="show-all-media" onClick={() => setGallery(true)}>Show all{shownTotal ? ` (${shownTotal})` : ""}</button>}
          {!!files.length && files.map(({ m, a }) => <div key={m.id + a.id} className="filerow" data-jump={m.id} role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={() => onJump?.(m.id, m.chatId)}><FileText size={14} className="inl" /> {a.name ?? "File"} <small>{fmtBytes(a.size)}</small></div>)}
          {!!places && <div className="filerow"><MapPin size={14} className="inl" /> {places} shared location{places === 1 ? "" : "s"}</div>}</section>
        {chat.blocked && <p className="hint">You blocked this contact.</p>}
        {((caps?.block && dm) || (caps?.leaveChat && !dm && chat.provider !== "mesh")) && (
          <section className="dangerzone">
            {dm && caps?.block && <button className="danger wide" onClick={onBlock}><Ban size={15} /> {chat.blocked ? "Unblock contact" : "Block contact"}</button>}
            {caps?.leaveChat && !dm && chat.provider !== "mesh" && <button className="danger wide" onClick={onLeave}><LogOut size={15} /> {chat.kind === "channel" ? "Leave channel" : "Leave group"}</button>}
          </section>)}
      </div>
      {gallery && <MediaGallery chat={chat} counts={archived?.count} onClose={() => setGallery(false)} onJump={(id, cid) => { onJump?.(id, cid); if (matchMedia("(max-width: 720px)").matches) onClose(); }} />}
    </aside>
  );
}

// ---------------- settings ----------------
type Section = "accounts" | "appearance" | "notifications" | "privacy" | "scheduled" | "storage" | "backup" | "move" | "sync" | "about";
export function SettingsPage({ loading, accounts, providers, settings, onChange, onAdd, onClose, onLogin, onAccountAction, chats, onMarkAllRead }: {
  /** the first snapshot has not arrived yet: the account list is unknown, not empty */ loading?: boolean;
  chats: Chat[]; onMarkAllRead?: (scope: string, label: string) => void;
  onLogin: (accountId: string) => void; onAccountAction: (kind: "signout" | "signin" | "remove" | "profile", a: Account) => void;
  accounts: Account[]; providers: ProviderInfo[]; settings: Settings; onChange: (s: Settings) => void; onAdd: () => void; onClose: () => void;
}) {
  const [sec, setSec] = useState<Section>(() => { const w = settingsNav.section as Section | undefined; settingsNav.section = undefined; return w ?? (updatesNav.pending ? "about" : hasSyncLink() && !focusAccount.id ? "sync" : "accounts"); });
  useEffect(() => { updatesNav.pending = false; const f = () => { updatesNav.pending = false; setSec("about"); setTimeout(() => document.getElementById("updates")?.scrollIntoView({ block: "start" }), 50); }; addEventListener("unichat-open-updates", f); return () => removeEventListener("unichat-open-updates", f); }, []);
  useEffect(() => { // opened from a status ring in the chat list footer: show that account's card
    const id = focusAccount.id; if (!id) return; focusAccount.id = undefined;
    const t = setTimeout(() => { const el = document.querySelector(`.acard[data-account="${CSS.escape(id)}"]`); el?.scrollIntoView({ block: "center" }); el?.classList.add("flash"); setTimeout(() => el?.classList.remove("flash"), 1800); }, 60);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => { const f = () => setSec("sync"); addEventListener("unichat-sync-link", f); return () => removeEventListener("unichat-sync-link", f); }, []);
  const [notifMsg, setNotifMsg] = useState("");
  const [retention, setRetention] = useState(0);
  const [collapse, setCollapse] = useState(true);
  const [showPresence, setShowPresence] = useState(true);
  useEffect(() => { core.call("getSettings").then((s: { retentionDays: number; collapseSingleChatCommunities?: boolean; showPresence?: boolean }) => { setShowPresence(s?.showPresence !== false); setRetention(s?.retentionDays ?? 0); setCollapse(s?.collapseSingleChatCommunities !== false); }).catch(() => {}); }, []);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  const Toggle = ({ k, label, hint }: { k: keyof Settings; label: string; hint?: string }) => (
    <label className="toggle"><span><b>{label}</b>{hint && <small>{hint}</small>}</span><input type="checkbox" checked={!!settings[k]} onChange={(e) => set(k, e.target.checked as never)} /><i /></label>);
  // Grouped so that the purpose of each page is clear without reading its text.
  const NAV: { title: string; items: [Section, string][] }[] = [
    { title: "Messengers", items: [["accounts", "Accounts"], ["privacy", "Privacy & chats"]] },
    { title: "App", items: [["appearance", "Appearance"], ["notifications", "Notifications"], ["scheduled", "Scheduled messages"]] },
    { title: "Your data", items: [["storage", "Storage & downloads"], ["backup", "Backup & restore"]] },
    { title: "Other devices", items: [["sync", "Sync devices"], ["move", "Move to another device"]] },
    { title: "", items: [["about", "About"]] },
  ];
  return (
    <div className="settings">
      <nav><h5>Settings</h5>{NAV.map((g) => <div className="navgroup" key={g.title || "more"}>{g.title && <h6>{g.title}</h6>}{g.items.map(([k, l]) => <button key={k} className={sec === k ? "on" : ""} onClick={() => setSec(k)}>{l}</button>)}</div>)}</nav>
      <section>
        <button className="closex" onClick={onClose} title="Close (Esc)"><X size={18} /></button>
        {sec === "accounts" && <>
          <h2>Accounts</h2><p className="hint"><b>Sign out</b> keeps your chats as a read-only archive. <b>Remove</b> deletes the account and its data from this device.</p>
          {accounts.map((a) => <AccountCard key={a.id} a={a} p={providers.find((x) => x.name === a.provider)} onLogin={() => onLogin(a.id)} onAction={(k) => onAccountAction(k, a)} />)}
          {!accounts.length && <p className="hint" data-loading={loading ? "accounts" : undefined}>{loading ? "Still loading your accounts…" : "No accounts yet."}</p>}
          <button className="primary inline" onClick={onAdd}><Plus size={16} /> Add account</button></>}
        {sec === "appearance" && <>
          <h2>Appearance</h2>
          <label className="row"><span><b>Theme</b></span><select value={settings.theme} onChange={(e) => set("theme", e.target.value as Settings["theme"])}><option value="dark">Dark</option><option value="light">Light</option><option value="system">Follow system</option></select></label>
          <label className="row"><span><b>Message style</b><small className="rowhint">Bubbles show your messages on the right, like WhatsApp; Flat lists everything on the left, like Discord.</small></span><select value={settings.messageStyle} onChange={(e) => set("messageStyle", e.target.value as Settings["messageStyle"])}><option value="bubbles">Bubbles</option><option value="flat">Flat</option></select></label>
          <label className="toggle"><span><b>Show communities with only one chat as a normal chat</b><small>A community that holds just one chat gets no entry in the left bar; its chat is listed under Personal. Chats you moved into a folder count too.</small></span>
            <input type="checkbox" id="collapseSingle" checked={collapse} onChange={(e) => { setCollapse(e.target.checked); core.call("setSetting", { key: "collapseSingleChatCommunities", value: e.target.checked }).catch(() => setCollapse(!e.target.checked)); }} /><i /></label></>}
        {sec === "notifications" && <>
          <h2>Notifications</h2>
          {(window as any).UnimsgNative && <AndroidNotifPermission />}
          {(window as any).UnimsgNative && <p className="hint" data-android-notif>On Android, UniChat shows its own system notifications for messages that arrive while the app is not on screen. Turn them off per chat (mute) or in Android's settings for UniChat; there is no separate switch here.</p>}
          {!(window as any).UnimsgNative && <label className="toggle"><span><b>Desktop notifications</b><small>Show a notification for messages in chats you're not looking at</small></span>
            <input type="checkbox" checked={settings.notifications} onChange={async (e) => {
              const on = e.target.checked; // read BEFORE awaiting: React resets a controlled checkbox once the handler yields
              setNotifMsg("");
              if (on) {
                if (!("Notification" in window)) return setNotifMsg("This browser doesn't support notifications.");
                if (Notification.permission === "denied") return setNotifMsg("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
                if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return setNotifMsg("Permission wasn't granted, so notifications stay off.");
              }
              set("notifications", on);
            }} /><i /></label>}
          {notifMsg && <p className="hint err">{notifMsg}</p>}
          <label className="row"><span><b>What notifications show</b><small className="rowhint">Full: sender and text. Sender only: who wrote, not what. Hidden: just “New message”. Applies to desktop notifications and, on Android, to notifications while the app is in the background.</small></span>
            <select id="notifyContent" value={settings.notifyContent} onChange={(e) => set("notifyContent", e.target.value as Settings["notifyContent"])}><option value="full">Full</option><option value="sender">Sender only</option><option value="hidden">Hidden</option></select></label>
          {(window as any).UnimsgNative && <AndroidBackground settings={settings} set={set} />}</>}
        {sec === "privacy" && <>
          <h2>Privacy & chats</h2>
          <label className="row"><span><b>Keep message history</b><small className="rowhint">UniChat stores your messages on this device, encrypted. Older ones are deleted automatically.</small></span>
            <select value={retention} onChange={(e) => { const v = Number(e.target.value); if (v > 0 && !confirm(`Messages older than ${e.target.selectedOptions[0].text.toLowerCase()} will be deleted from this device now. Continue?`)) return; setRetention(v); core.call("setSetting", { key: "retentionDays", value: v }).catch((er) => alert(er.message)); }}>
              <option value={0}>Forever</option><option value={365}>1 year</option><option value={180}>6 months</option><option value={90}>3 months</option><option value={30}>1 month</option><option value={7}>1 week</option></select></label>
          <label className="toggle"><span><b>Show who is online</b><small>Green dot and "last seen" for people you chat with one-to-one, on messengers that report it (WhatsApp, Matrix, Mattermost, Discord user accounts). Off: UniChat stops asking for and showing presence. UniChat never announces your own status.</small></span>
            <input type="checkbox" id="showPresence" checked={showPresence} onChange={(e) => { setShowPresence(e.target.checked); core.call("setSetting", { key: "showPresence", value: e.target.checked }).catch(() => setShowPresence(!e.target.checked)); }} /><i /></label>
          <Toggle k="sendReadReceipts" label="Send read receipts" hint="Let others see when you've read their messages" />
          {onMarkAllRead && <MarkAllRow accounts={accounts} onGo={onMarkAllRead} />}
          <Toggle k="sendTyping" label="Send typing indicators" />
          <Toggle k="autoDownloadMedia" label="Auto-download photos and voice messages" hint="Off: tap to load, saves data" />
          <Toggle k="mapPreviews" label="Show map previews for locations" hint="Loads map tiles from OpenStreetMap, which tells their server roughly which area you viewed" />
          <Toggle k="enterToSend" label="Press Enter to send" hint="Shift+Enter always inserts a new line" /></>}
        {sec === "scheduled" && <ScheduledList chats={chats} />}
        {sec === "storage" && <StoragePanel accounts={accounts} providers={providers} chats={chats} loading={loading} />}
        {sec === "backup" && <BackupPanel part="backup" />}
        {sec === "move" && <BackupPanel part="move" />}
        {sec === "sync" && <SyncPanel />}
        {sec === "about" && <><h2>About UniChat</h2><p>One app for all your messengers. Providers: {providers.map((p) => p.displayName).join(", ") || "none"}.</p><p className="hint">Messages stay on your device; accounts are linked as secondary devices.</p><UpdatesSection /></>}
      </section>
    </div>
  );
}

function AccountCard({ a, p, onLogin, onAction }: { a: Account; p?: ProviderInfo; onLogin: () => void; onAction: (k: "signout" | "signin" | "remove" | "profile") => void }) {
  const signedOut = a.state === "signed-out" || (a.state === "needs-login" && !!a.everLinked);
  const stateText = a.state === "signed-out" ? `signed out${a.signedOutAt ? " " + new Date(a.signedOutAt).toLocaleDateString() : ""}` : a.state === "needs-login" && a.everLinked ? "unlinked, sign in again" : a.state.replace("-", " ");
  const [label, setLabel] = useState(a.label); const [editing, setEditing] = useState(false);
  const caps = capsOf(a, p ? [p] : [], a.provider);
  const feats = caps ? Object.entries({ Reactions: caps.reactions, Edits: caps.edits, Voice: caps.voiceNotes, Location: caps.location, Contacts: caps.contactCards, Communities: caps.spaces, "E2EE": caps.e2ee, Mentions: caps.mentions }).filter(([, v]) => v).map(([k]) => k) : [];
  const save = () => { setEditing(false); if (label.trim() && label !== a.label) core.call("renameAccount", { accountId: a.id, label: label.trim() }).catch((e) => alert(e.message)); };
  const [syncing, setSyncing] = useState(false); const [importing, setImporting] = useState(false);
  const sync = async () => { setSyncing(true); try { await core.call("syncAccount", { accountId: a.id }); } catch (err: any) { alert(err.message); } finally { setSyncing(false); } };
  const stateLabel = a.state === "signed-out" ? "Signed out" : a.state === "needs-login" && a.everLinked ? "Unlinked" : a.state === "needs-login" ? "Waiting to link" : a.state === "connected" ? "Connected" : a.state === "connecting" ? "Connecting…" : "Disconnected";
  const st = acctStatus(a, stateLabel);
  const notices: string[] = [];
  const [asked, setAsked] = useState("");
  const askHome = async () => { try { const r = await core.call("syncRelayAsk", { accountId: a.id }); setAsked(r.state === "pending" ? `Asked ${a.via?.device}. It shows a question there.` : r.state === "denied" ? `${a.via?.device} doesn't allow sending.` : ""); } catch (err: any) { setAsked(err.message); } };
  if (a.via) notices.push(viaNote(a.via));
  else if (signedOut) notices.push(`Read-only archive${a.signedOutAt ? ` since ${new Date(a.signedOutAt).toLocaleDateString()}` : ""}: your chats and messages stay here, but messages sent to you while signed out won't arrive.`);
  if (!signedOut && caps?.sync) notices.push("Contacts only arrive when your phone shares them. That happens automatically after linking; use Sync contacts if people you added later are missing.");
  return (
    <div className={"acard" + (signedOut ? " dim" : "")} data-account={a.id}>
      <ProviderIcon provider={a.provider} size={44} />
      <div className="abody">
        <div className="ahead">
          {editing ? <input className="aname" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && save()} /> : <><b className="aname" onDoubleClick={() => setEditing(true)} title="Double-click to rename">{a.label}</b><button className="icon arename" title="Rename this account" aria-label="Rename account" onClick={() => setEditing(true)}><Pencil size={14} /></button></>}
          <span className={"spill " + st.cls} data-via={a.via?.kind} title={st.note}><i className={"state " + st.cls} />{st.label}</span>
        </div>
        <div className="asub">{p?.displayName ?? a.provider}</div>
        {!!feats.length && <div className="afeats" title="What this account can do in UniChat">{feats.join(" · ")}</div>}
        {!signedOut && !a.via && a.state === "connected" && caps?.verification && <AccountVerify accountId={a.id} />}
        {notices.map((n, k) => <div key={k} className="notice" data-via-note={a.via && k === 0 ? a.via.kind : undefined}><Info size={15} /><span>{n}</span></div>)}
        {asked && <div className="notice" data-asked><Info size={15} /><span>{asked}</span></div>}
        <div className="aactions">
          {a.state === "needs-login" && !a.everLinked && <button className="primary inline" onClick={onLogin}>{p?.login === "qr" ? "Show QR code" : "Sign in"}</button>}
          {a.via?.kind === "ask" && <button className="primary inline" data-act="ask-allow" onClick={askHome}>Ask {a.via.device} to allow sending</button>}
          {signedOut && <button className={a.via ? "secondary" : "primary inline"} onClick={() => onAction("signin")}>{a.via ? "Sign in on this device" : "Sign in again"}</button>}
          {!signedOut && !a.via && a.state === "connected" && (caps?.profile || caps?.privacy) && <button className="secondary" onClick={() => onAction("profile")}>Profile &amp; privacy</button>}
          {!signedOut && caps?.sync && <button className="secondary" disabled={syncing} title="Ask your phone to send its contact list again (it must be online)" onClick={sync}><RefreshCw size={14} className={syncing ? "spin" : ""} /> {syncing ? "Syncing…" : "Sync contacts"}</button>}
          {a.provider === "signal" && !signedOut && <button className="secondary" id="signal-history" title="Add old messages from a Signal backup made on your phone" onClick={() => setImporting((v) => !v)}>Import chat history</button>}
          {a.provider === "whatsapp" && !signedOut && <button className="secondary" id="whatsapp-history" title="Add old messages from a WhatsApp backup made on your phone" onClick={() => setImporting((v) => !v)}>Import chat history</button>}
          <span className="aspacer" />
          {!signedOut && a.everLinked && !a.via && <button className="secondary" title="Log out but keep your chats and messages as a read-only archive" onClick={() => onAction("signout")}>Sign out</button>}
          <button className="danger" title="Delete this account and all its data from this device" onClick={() => onAction("remove")}>{signedOut ? "Delete archive" : "Remove"}</button>
        </div>
        {importing && a.provider === "signal" && <div className="aimport"><SignalBackupImport accountId={a.id} /></div>}
        {importing && a.provider === "whatsapp" && <div className="aimport"><WhatsAppBackupImport accountId={a.id} /></div>}
      </div>
    </div>
  );}

/** What a message looks like as a one-line search hit (text, or a description of its non-text content). */
function hitText(m: Message): string {
  if (m.text) return m.text;
  if (m.poll) return `Poll: ${m.poll.question}`;
  if (m.location) return `Location: ${m.location.name ?? m.location.address ?? `${m.location.lat.toFixed(4)}, ${m.location.lng.toFixed(4)}`}`;
  if (m.contacts?.length) return `Contact: ${m.contacts.map((c) => c.name).join(", ")}`;
  if (m.attachments?.length) return m.attachments.map((a) => a.name ?? a.kind).join(", ");
  return "";
}
/** ~150 chars of text around the first match, with the match highlighted. */
function Snippet({ text, q }: { text: string; q: string }) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0 || !q) return <>{text.slice(0, 150)}</>;
  const start = Math.max(0, i - 40), end = Math.min(text.length, i + q.length + 90);
  return <>{start > 0 && "…"}{text.slice(start, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length, end)}{end < text.length && "…"}</>;
}

/** Search in the right sidebar: results from the whole archive of this chat, newest first; a click jumps to the message. */
export function SearchPanel({ chat, members, providers, accounts, onJump, onClose }: { chat: Chat; members?: Chat[]; providers: ProviderInfo[]; accounts: Account[]; onJump: (messageId: string, chatId?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(""); const [res, setRes] = useState<(Message & { snippet: string; ranges: [number, number][] })[]>(); const [total, setTotal] = useState(0); const [qerr, setQerr] = useState<string[]>([]); const [err, setErr] = useState(""); const [active, setActive] = useState<string>();
  const LIMIT = 100;
  useEffect(() => {
    const term = q.trim(); setErr("");
    if (!term) { setRes(undefined); return; }
    let live = true;
    const t = setTimeout(() => core.call("searchAll", { query: term, chatIds: [chat.id], limit: LIMIT }).then((r: any) => {
      if (!live) return;
      const hits = (r.groups as any[]).flatMap((g) => g.hits).map((h) => ({ ...h, id: h.messageId, senderId: h.sender })).sort((a, b) => b.time.localeCompare(a.time));
      setRes(hits); setTotal(r.total); setQerr(r.parsed?.errors ?? []);
    }, (e) => live && setErr(e.message)), 220);
    return () => { live = false; clearTimeout(t); };
  }, [q, chat.id]);
  const term = q.trim();
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  return (
    <aside className="info sidesearch">
      <header><span>Search in {chat.kind === "channel" ? "#" : ""}{chat.name}</span><button className="icon" onClick={onClose} aria-label="Close search"><X size={18} /></button></header>
      <div className="sbox"><Search size={15} /><input autoFocus placeholder="Search this chat (from: has: before: after: &quot;phrase&quot;)" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } if (e.key === "Enter" && res?.[0]) { setActive(res[0].chatId + "|" + res[0].id); onJump(res[0].id, res[0].chatId); } }} />
        {q && <button className="icon" onClick={() => setQ("")} aria-label="Clear"><X size={14} /></button>}</div>
      <div className="sresults">
        {!term && <p className="hint pad">Search the messages, file names, polls, locations and contacts of this chat. Results come from everything stored on this device, not just what is loaded. Try <code>from:name</code>, <code>has:image</code>, <code>"exact phrase"</code>, <code>after:2026-01-01</code>.</p>}
        {term && res === undefined && !err && <p className="hint pad">Searching…</p>}
        {err && <p className="hint err pad">{err}</p>}
        {qerr.map((e) => <p key={e} className="hint err pad">{e}</p>)}
        {term && res && <div className="scount">{res.length === 0 ? "No messages found" : `${total} result${total === 1 ? "" : "s"}${total > res.length ? ` (showing the best ${res.length})` : ""}`}</div>}
        {res?.map((m, i) => (
          <button key={m.chatId + "|" + m.id} className={"sres" + (active === m.chatId + "|" + m.id ? " on" : "")} onClick={() => { setActive(m.chatId + "|" + m.id); onJump(m.id, m.chatId); }}>
            {(i === 0 || day(res[i - 1].time) !== day(m.time)) && <span className="sday">{day(m.time)}</span>}
            <span className="shead"><b>{m.fromMe ? "You" : members ? chat.name : m.sender || m.senderId}</b><time>{fmtTime(m.time)}</time>{members && (() => { const o = members.find((c) => c.id === m.chatId); return o ? <ProviderIcon provider={o.provider} size={13} title={`${providers.find((x) => x.name === o.provider)?.displayName ?? o.provider} · ${accounts.find((a) => a.id === o.accountId)?.label ?? o.accountId}`} /> : null; })()}</span>
            <span className="ssnip"><Marked text={m.snippet} ranges={m.ranges} /></span>
          </button>))}
      </div>
    </aside>
  );
}

interface JobRow { id: string; kind: string; runAt: number; status: string; attempts: number; lastError?: string; payload: { chatId?: string; text?: string; due?: number; waiting?: boolean; late?: boolean; aborted?: boolean } }
/** Messages waiting to be sent later. They only go out while UniChat's backend is running at that time. A message for an account that is used through another device
 *  waits for that device when it is off; one that is far too late is not sent silently: the user decides (Send now / Delete). */
function ScheduledList({ chats }: { chats: Chat[] }) {
  const [jobs, setJobs] = useState<JobRow[]>(); const [err, setErr] = useState("");
  const load = () => core.call("jobs").then((j: JobRow[]) => setJobs((j ?? []).filter((x) => x.kind === "send" && ((x.status === "pending" && (x.payload.waiting || x.runAt > Date.now() - 60_000)) || (x.status === "failed" && (x.payload.late || x.payload.aborted))))), (e) => setErr(e.message));
  useEffect(() => { load(); const i = setInterval(load, 5000); const off = core.on((ev: string) => { if (ev === "job") load(); }); return () => { clearInterval(i); off(); }; }, []);
  const name = (id?: string) => chats.find((c) => c.id === id)?.name ?? "a chat";
  const when = (j: JobRow) => new Date(j.payload.due ?? j.runAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const act = (m: string, id: string) => core.call(m, { id }).then(load, (e) => { alert(e.message); load(); });
  return (
    <>
      <h2>Scheduled messages</h2>
      <p className="hint">Messages waiting to be sent. They go out at the chosen time <b>only while UniChat is running</b> (desktop app open, or the backend server up). If the account is used through another device that is off, the message waits for it and goes out once when it is back (not after more than a day).</p>
      {err && <p className="hint err">{err}</p>}
      {jobs && !jobs.length && <p className="hint">Nothing is scheduled. Write a message, open the + menu and choose “Schedule send”.</p>}
      {jobs?.sort((a, b) => (a.payload.due ?? a.runAt) - (b.payload.due ?? b.runAt)).map((j) => {
        const failed = j.status === "failed", waiting = !failed && !!j.payload.waiting;
        return (
        <div key={j.id} className="acard" data-job={j.id} data-job-state={failed ? (j.payload.late ? "late" : "failed") : waiting ? "waiting" : "scheduled"}><Clock3 size={22} />
          <div className="abody"><div className="ahead"><b className="aname">To {name(j.payload.chatId)}</b><span className={"spill " + (failed ? "disconnected" : waiting ? "signed-out" : "connected")}>{failed ? "Not sent" : waiting ? "Waiting" : ""}{failed || waiting ? " · " : ""}{when(j)}</span></div>
            <div className="asub" style={{ whiteSpace: "pre-wrap" }}>{(j.payload.text ?? "").slice(0, 240)}</div>
            {(waiting || failed) && <div className="notice" data-job-note><Info size={15} /><span>{j.lastError}</span></div>}
            {!failed && !waiting && j.attempts > 0 && <div className="notice"><Info size={15} /><span>Tried {j.attempts} time{j.attempts === 1 ? "" : "s"}: {j.lastError ?? "waiting to retry"}</span></div>}
            <div className="aactions"><span className="aspacer" />
              {failed && j.payload.late && <button className="primary inline" data-act="job-send-now" onClick={() => act("sendJobNow", j.id)}>Send now</button>}
              {failed ? <button className="danger" data-act="job-delete" onClick={() => act("discardJob", j.id)}>Delete</button> : <button className="danger" onClick={() => act("cancelJob", j.id)}>Cancel</button>}</div></div></div>); })}
    </>
  );
}


/** Change or remove the picture of a group on the network. */
function GroupPicture({ chat }: { chat: Chat }) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const apply = async (img: { dataBase64: string; mime: string } | null) => {
    setBusy(true); setErr("");
    try { await core.call("setChatPicture", { chatId: chat.id, ...(img ?? {}) }); forgetAvatar("chat", chat.id); }
    catch (e: any) { setErr(e?.message ?? "Could not change the picture."); }
    finally { setBusy(false); }
  };
  return (
    <div className="grouppic">
      <input ref={file} type="file" accept="image/*" hidden onChange={async (e) => {
        const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
        try { const r = await squareImage(f, 640); await apply({ dataBase64: r.dataBase64, mime: r.mime }); } catch (x: any) { setErr(x?.message ?? "Not a usable image."); }
      }} />
      <button className="secondary wide" disabled={busy} onClick={() => file.current?.click()}><ImageIcon size={15} /> {busy ? "Saving…" : "Change group picture"}</button>
      <button className="secondary wide" disabled={busy} onClick={() => apply(null)}><Trash2 size={15} /> Remove picture</button>
      {err && <p className="hint err">{err}</p>}
    </div>);
}


/** The description (about) of a group; editable on the network where the messenger allows it. */
function ChatAbout({ chat, editable }: { chat: Chat; editable: boolean }) {
  const [editing, setEditing] = useState(false); const [text, setText] = useState(chat.description ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { if (!editing) setText(chat.description ?? ""); }, [chat.description, editing]);
  const save = async () => {
    setBusy(true); setErr("");
    try { await core.call("setChatDescription", { chatId: chat.id, text }); setEditing(false); }
    catch (e: any) { setErr(e?.message ?? "Could not change the description."); }
    finally { setBusy(false); }
  };
  return (
    <section className="chatabout"><h4>About{editable && !editing && <button className="icon" title="Edit description" aria-label="Edit description" onClick={() => setEditing(true)}><Pencil size={13} /></button>}</h4>
      {editing
        ? <><textarea value={text} maxLength={2048} rows={4} autoFocus onChange={(e) => setText(e.target.value)} placeholder="Describe this group…" />
            <div className="aboutbtns"><button className="primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button><button className="secondary" disabled={busy} onClick={() => { setEditing(false); setErr(""); }}>Cancel</button></div>
            {err && <p className="hint err">{err}</p>}</>
        : chat.description ? <p>{chat.description}</p> : <p className="hint">No description yet.</p>}
    </section>);
}

/** Settings: mark every unread chat read, on the services where that is possible (receipts setting respected). */
function MarkAllRow({ accounts, onGo }: { accounts: Account[]; onGo: (scope: string, label: string) => void }) {
  const [scope, setScope] = useState("all");
  return (
    <div className="row"><span><b>Mark all chats as read</b><small className="rowhint">Tells each messenger you've read everything, where it supports that. Chats that can't be told (or when read receipts are off) are cleared here only. Takes a few seconds per dozen chats.</small></span>
      <select aria-label="Which accounts" value={scope} onChange={(e) => setScope(e.target.value)}><option value="all">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
      <button className="secondary" data-act="markall-settings" onClick={() => onGo(scope, scope === "all" ? "all chats" : accounts.find((a) => a.id === scope)?.label ?? "chats")}>Mark as read</button></div>);
}


/** Android only: keep UniChat connected in the background, restart after a reboot, and ask the system not to put it to sleep. */
function AndroidBackground({ settings, set }: { settings: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => void }) {
  const [exempt, setExempt] = useState<boolean | undefined>(undefined); const [msg, setMsg] = useState("");
  const refresh = () => core.call("$batteryExemptionState", {}).then((r: any) => setExempt(typeof r === "boolean" ? r : !!(r?.ignoring ?? r?.exempt)), () => setExempt(undefined));
  useEffect(() => { void refresh(); }, []);
  return (
    <>
      <label className="toggle"><span><b>Keep running in the background</b><small>Keeps UniChat connected so messages arrive while the app is closed, and restarts it after a reboot. Android shows a permanent notification while this is on.</small></span>
        <input type="checkbox" checked={settings.keepAlive} onChange={(e) => set("keepAlive", e.target.checked)} /><i /></label>
      <div className="row"><span><b>Battery optimisation</b><small className="rowhint">{exempt === true ? "UniChat is exempt, so Android is less likely to put it to sleep." : "Android may put UniChat to sleep to save battery, which delays messages. Allowing the exemption helps."}</small></span>
        {exempt !== true && <button className="secondary" onClick={async () => { setMsg(""); try { await core.call("$requestBatteryExemption", {}); setTimeout(() => void refresh(), 1500); } catch (e: any) { setMsg(e?.message ?? "Could not open the system dialog."); } }}>Allow</button>}</div>
      {msg && <p className="hint err">{msg}</p>}
    </>);
}

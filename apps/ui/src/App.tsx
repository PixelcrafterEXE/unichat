import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { initSyncLink, offerSyncLink } from "./syncLink";
import { StatusDots, focusAccount , settingsNav } from "./StatusDots";
import { offlineLine, sourceOf, timeoutNote } from "./loadsource";
import { capsOf, type Account, type Chat, type Contact, type LoginPrompt, type Message, type ProviderInfo, type RailGroup, type Space, type UserCategory } from "./types";
import { CategoryModal, CategoryPickModal } from "./Categories";
import { X } from "./icons";
import { setToken } from "./api";
import { UpdateBanner } from "./Updates";
import { useSyncReceiving } from "./SyncPanel";
import { Avatar, notificationIcon, ProviderIcon, ProviderStack, SpaceIcon, core, initials, isCoarse, loadSet, lpHandlers, type LPState, loadSettings, saveSet, saveSettings, useLongPress, presenceText, setDateFormat, type Settings } from "./util";
import { ChatRow, type RowApi } from "./ChatRow";
import { ChatFilterBar, activeCount, isOnline, matchesFilters, normFilters, type ChatFilters } from "./ChatFilters";
import { VList } from "./VList";
import Conversation from "./Conversation";
import type { GGroup, GHit } from "./GlobalSearch";
// heavy, rarely-open screens load on first use (own chunks; Suspense shows nothing while they arrive)
const GlobalSearch = lazy(() => import("./GlobalSearch"));
const Watchers = lazy(() => import("./Watchers")); // device-move / relay / identity-verification hosts: loaded once the chat list is up
const ContactPanel = lazy(() => import("./Panels").then((m) => ({ default: m.ContactPanel })));
const SearchPanel = lazy(() => import("./Panels").then((m) => ({ default: m.SearchPanel })));
const SettingsPage = lazy(() => import("./Panels").then((m) => ({ default: m.SettingsPage })));
import { MarkReadToast, useMarkRead } from "./MarkReadUI";
import { MediaOffer, useOfflineMedia } from "./MediaUI";
import { AddToGroupModal, GroupModal, GroupTile } from "./RailGroups";
import { GROUP_COLORS, addToGroup, changed, dropEdge, dropOnto, groupOf, nudgeInGroup, removeFromGroup, ungroup, type RailState } from "./railGroupOps";
import type { PlaceInfo } from "./Panels";
import { DisappearBadge } from "./Disappearing";
import { ChevronDown, ChevronRight, FolderInput, FolderPlus, ArrowUp, ArrowDown, Folder, GitMerge, Unlink, LogOut, Info as InfoIcon, Trash2, Archive, ArchiveRestore, MoreHorizontal, Pin, PinOff, MarkRead, CloudOff, Pencil, Bell, Hash, BellOff, ChevronLeft, Info, Lock, Menu, MessageCircle, Search, Settings as SettingsIcon, SquarePen, Plus, FolderMinus, Tag, Palette, ListPlus } from "./icons";
import { CaptchaModal } from "./Captcha";
import { ProfileModal, PersonModal, ArchivedSpacesModal, PopMenu, SpaceInfoModal, ConfirmModal, AddMembersModal, AddMenuModal, CommunityModal, AddAccount, LoginModal, NewChatModal, Lightbox, QuickSwitcher, RenameModal, MergeModal, FolderModal, MoveModal } from "./Modals";

const RANK = ["failed", "sending", "sent", "delivered", "read"]; // delivery status only ever moves forward
const HOME = "home"; // pseudo-space holding personal chats (DMs & ad-hoc groups)
/** Keep the previous object of every entry whose content did not change, so memoised rows / panels skip the re-render after a refresh. */
function same(a: any, b: any): boolean {
  if (a === b) return true; if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a), kb = Object.keys(b); if (ka.length !== kb.length) return false;
  for (const k of ka) { const x = a[k], y = b[k]; if (x !== y && !(x && y && typeof x === "object" && typeof y === "object" && JSON.stringify(x) === JSON.stringify(y))) return false; }
  return true;
}
function reuse<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (!prev.length) return next; const m = new Map(prev.map((x) => [x.id, x])); let all = prev.length === next.length;
  const out = next.map((n, i) => { const o = m.get(n.id); if (o && same(o, n)) { if (prev[i] !== o) all = false; return o; } all = false; return n; });
  return all ? prev : out;
}
const isPend = (x: Message) => x.id.startsWith("pend-"), isLocal = (x: Message) => isPend(x) || x.id.startsWith("local-");
/** Add a message to a chat's list unless it is there (native ids may repeat across the members of a merged chat).
 *  `replaces`: the id of the optimistic placeholder this message answers. A real message of mine that arrives (event or reply of `send`) also retires the
 *  oldest placeholder of the same chat with the same text and attachment count, whichever of the two comes first. */
const upsert = (list: Message[], m: Message, replaces?: string) => {
  let l = replaces ? list.filter((x) => x.id !== replaces) : list;
  if (l.some((x) => x.id === m.id && x.chatId === m.chatId)) return l;
  if (m.fromMe && !isLocal(m)) { const i = l.findIndex((x) => isPend(x) && x.chatId === m.chatId && x.text === m.text && (x.attachments?.length ?? 0) === (m.attachments?.length ?? 0)); if (i >= 0) l = l.filter((_, j) => j !== i); }
  return [...l, m];
};
const CHAT_DRAG = "application/x-unimsg-chat", SPACE_DRAG = "application/x-unimsg-space", CAT_DRAG = "application/x-unimsg-category";
const PERSONAL_VIEW = "personal"; // the Hub's key of the Personal view (the UI calls it HOME)
interface CatGroup { key: string; name?: string; id?: string; color?: string; chats: Chat[] }
const ChatIcon = () => <MessageCircle size={24} />;
const Gear = () => <SettingsIcon size={18} />;

/** Messenger dots of a merged chat: the primary chat's messenger first, then the others by most recent message in the chat (last use). */
function dotOrder(c: Chat, members?: Chat[]): string | undefined {
  if (!members?.length) return undefined;
  const primary = c.mergeMembers?.[0], last = c.mergeLastVia;
  return [...members].sort((a, b) => (a.id === primary ? -1 : b.id === primary ? 1 : 0) || (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "") || (a.id === last ? -1 : b.id === last ? 1 : 0)).map((m) => m.provider).join(",");
}

export default function App() {
  const q = new URLSearchParams(location.search); // ?space=..&chat=..&settings=1&info=1 (deep links / screenshots)
  const [error, setError] = useState<string>();
  const errorFrom = useRef<string>(); // the account whose non-fatal problem is on screen: cleared when it connects again
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [watchers, setWatchers] = useState(false); useEffect(() => { const t = setTimeout(() => setWatchers(true), 0); return () => clearTimeout(t); }, []); // after the first paint: the hosts load while the first snapshot is in flight
  const [listReady, setListReady] = useState(false); // false until the first chat list arrived: show a loading state, never "No chats"
  // The backend may need a while after a start (a big archive loads, accounts connect): "Still starting…" after 10 s, never "No accounts yet" before a snapshot really arrived (listReady is only set by a snapshot).
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => { if (listReady) { setSlowStart(false); return; } const t = setTimeout(() => setSlowStart(true), Number((window as any).__slowStartMs) || 10_000); return () => clearTimeout(t); }, [listReady]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [chats, setChats] = useState<Chat[]>([]);
  const [space, setSpace] = useState(q.get("space") ?? HOME);
  const [chatId, setChatId] = useState<string | undefined>(q.get("chat") ?? undefined);
  const [msgs, setMsgs] = useState<Record<string, Message[]>>({});
  const [typing, setTyping] = useState<Record<string, string[]>>({}); // chat -> sender ids currently typing
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()); // safety expiry: a lost "stopped typing" must not stick forever
  const [login, setLogin] = useState<LoginPrompt>();
  const [navOpen, setNavOpen] = useState(!q.get("chat")); // phone: a deep-linked chat opens full screen
  const [dialog, setDialog] = useState<"archived" | "addmenu" | "add" | "createspace" | "joinspace" | "newchat">();
  const [settingsOpen, setSettingsOpen] = useState(() => q.has("settings") || initSyncLink());
  const [settings, setSettings] = useState<Settings>(loadSettings);
  setDateFormat(settings.dateFormat); // every date the render below writes goes through the one formatter in util.tsx
  const [panel, setPanel] = useState<"info" | "search" | undefined>(q.has("search") ? "search" : q.has("info") ? "info" : undefined); // right sidebar
  const info = panel === "info";
  const setInfo = (v: boolean) => setPanel(v ? "info" : undefined);
  const acctStateRef = useRef(new Map<string, string>()); // last announced state per account (see the 'account' event)
  const pickRef = useRef<((id: string) => void) | undefined>();
  const openChatRef = useRef<((id: string) => void) | undefined>(); // set below; a clicked notification opens its chat
  const jumpRef = useRef<((messageId: string, chatId?: string) => void) | undefined>(); // set by the open conversation; used by the search sidebar
  const [conn, setConn] = useState<"up" | "down">("up"); // backend connection (web transport reconnects by itself)
  const [fatal, setFatal] = useState<string>(); // first connection failed
  const [openedUnread, setOpenedUnread] = useState<Record<string, number>>({}); // unread count a chat had when it was opened
  const [loadNote, setLoadNote] = useState<Record<string, string>>({});
  const [hist, setHist] = useState<Record<string, { status: "loading" | "error"; since: number; error?: string }>>({});
  // pin / mute / archive live in the backend (apply on every device); these are derived views of them
  const mutedSpaces = useMemo(() => new Set(spaces.filter((s) => s.muted).map((s) => s.id)), [spaces]);
  const archivedSpaceIds = useMemo(() => new Set(spaces.filter((s) => s.archived).map((s) => s.id)), [spaces]);
  const muted = useMemo(() => new Set(chats.filter((c) => c.muted || (c.spaceId && mutedSpaces.has(c.spaceId)) || (c.networkSpaceId && mutedSpaces.has(c.networkSpaceId))).map((c) => c.id)), [chats, mutedSpaces]);
  // Archived chats and chats of archived communities stay quiet like muted ones: no desktop notification and no badge in the rail (their messages are still received and stored).
  const quiet = useMemo(() => new Set(chats.filter((c) => muted.has(c.id) || c.archived || (c.spaceId && archivedSpaceIds.has(c.spaceId))).map((c) => c.id)), [chats, muted, archivedSpaceIds]);
  const pinned = useMemo(() => new Set(chats.filter((c) => c.pinned).map((c) => c.id)), [chats]);
  const [showArchived, setShowArchived] = useState(false);
  const [histTick, setHistTick] = useState(0); // bumps when cached histories are invalidated
  const [tick, setTick] = useState(0); // bumps on chats-changed so open panels reload
  const [addingMembers, setAddingMembers] = useState<Chat>();
  const [renamingNet, setRenamingNet] = useState<Chat>();
  const [archiveMenu, setArchiveMenu] = useState<{ x: number; y: number }>();
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; space: Space | "home" }>();
  const [spaceInfo, setSpaceInfo] = useState<Space>();
  const [profileFor, setProfileFor] = useState<Account>();
  const [person, setPerson] = useState<{ chat: Chat; senderId: string; name: string }>();
  const [renamingSpace, setRenamingSpace] = useState<Chat>();
  const [lightbox, setLightbox] = useState<string>();
  useEffect(() => {
    const h = async (e: Event) => {
      const d = (e as CustomEvent<{ url: string; of?: { kind: string; id: string } }>).detail;
      setLightbox(d.url); // the small picture straight away, the biggest one the messenger has as soon as it arrives
      if (!d.of || d.of.kind === "emoji") return;
      try {
        const r = await core.call("avatar", { kind: d.of.kind, id: d.of.id, full: true });
        if (!r?.dataBase64) return;
        const bin = atob(r.dataBase64), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([u8], { type: r.mime })); setLightbox((cur) => (cur === d.url ? url : cur));
      } catch { /* keep the small picture */ }
    };
     window.addEventListener("unichat-zoom", h); return () => window.removeEventListener("unichat-zoom", h); }, []); // profile / group pictures open in the big viewer
  const [filter, setFilter] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<Chat>();
  const [switcher, setSwitcher] = useState(false);
  const [gsearch, setGsearch] = useState<{ q: string; n: number }>(); // "Search all messages" panel in the left column
  const pendingJump = useRef<{ key: string; messageId: string; chatId: string; tries: number }>();
  const [jumpTick, setJumpTick] = useState(0);
  const [more, setMore] = useState<Record<string, boolean>>({});
  const [merging, setMerging] = useState<Chat>(); // "Merge with…" dialog (source chat)
  const [moving, setMoving] = useState<Chat>(); // "Move to folder…" dialog
  const [folderEdit, setFolderEdit] = useState<{ folder?: Space; thenMove?: Chat; thenMoveMany?: Chat[] }>(); // new / edit folder dialog
  const [notice, setNotice] = useState<string>();
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => loadSet("unimsg.collapsedCategories")); // "<space id>|<category>" the user folded (remembered locally)
  const toggleCat = (key: string) => setCollapsedCats((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); saveSet("unimsg.collapsedCategories", n); return n; });
  const [dropOver, setDropOver] = useState<string>(); // rail icon under a dragged chat / folder
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  // rail groups (local, Hub setting `railGroups`): several rail icons in one expandable entry
  const [railGroups, setRailGroupsState] = useState<RailGroup[]>([]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => loadSet("unimsg.openRailGroups"));
  const toggleGroup = (id: string, force?: boolean) => setOpenGroups((s) => { const n = new Set(s); (force ?? !n.has(id)) ? n.add(id) : n.delete(id); saveSet("unimsg.openRailGroups", n); return n; });
  const railWrites = useRef(0);
  const [groupMenu, setGroupMenu] = useState<{ x: number; y: number; group: RailGroup }>();
  const [groupEdit, setGroupEdit] = useState<RailGroup>();
  const [addGroup, setAddGroup] = useState<Space>();
  // multi-select in the chat list (shift+click range, ctrl/cmd+click toggle) to move / archive / mute / mark read together
  // user categories (local, Hub): the user's own headings inside a view; per view in display order
  const [cats, setCats] = useState<Record<string, UserCategory[]>>({});
  const [catMenu, setCatMenu] = useState<{ x: number; y: number; g: CatGroup }>();
  const [catEdit, setCatEdit] = useState<{ cat?: UserCategory; view: string; where: string; focus?: "name" | "colour"; thenMove?: Chat[] }>();
  const [catPick, setCatPick] = useState<Chat[]>();
  const [catOver, setCatOver] = useState<{ key: string; zone: "before" | "after" | "in" }>();
  const [sel, setSel] = useState<string[]>([]);
  const selAnchor = useRef<string>();
  const [selMenu, setSelMenu] = useState<{ x: number; y: number }>();
  const [bulkMove, setBulkMove] = useState<{ chats: Chat[]; only?: string[] }>();

  useEffect(() => { const f = (e: Event) => setSettings((s) => ({ ...s, ...(e as CustomEvent).detail })); addEventListener("unichat-settings-patch", f); return () => removeEventListener("unichat-settings-patch", f); }, []); // e.g. the emoji picker's skin tone
  useEffect(() => {
    saveSettings(settings);
    const mq = matchMedia("(prefers-color-scheme: light)");
    const apply = () => { document.documentElement.dataset.theme = settings.theme === "system" ? (mq.matches ? "light" : "dark") : settings.theme; };
    apply(); mq.addEventListener("change", apply);
    document.documentElement.classList.remove("compact"); // the compact layout was retired (it looked bad with bubbles); an old stored value is ignored
    document.documentElement.classList.toggle("bubbles", settings.messageStyle === "bubbles");
    return () => mq.removeEventListener("change", apply);
  }, [settings]);
  const [confirmBox, setConfirmBox] = useState<{ title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }>();
  const relinking = useRef(new Set<string>()); // accounts the user is signing in AGAIN (cancelling returns them to the archive)
  const fresh = useRef(new Set<string>()); // accounts created by "Add account" in this session whose linking isn't finished
  useEffect(() => { const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSettingsOpen(false); setMenuFor(null); setSel([]); setSelMenu(undefined); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && openRef.current) { e.preventDefault(); setPanel("search"); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSwitcher((s) => !s); }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); setGsearch((g) => ({ q: g?.q ?? "", n: (g?.n ?? 0) + 1 })); setNavOpen(true); }
    }; addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, []);

  // Android shell: notification tap opens a chat; the system Back button asks the page first (cancelable event)
  const backRef = useRef<() => boolean>(() => false), openRef2 = useRef<(id: string) => void>(() => {});
  useEffect(() => {
    const open = (e: Event) => { const id = (e as CustomEvent).detail?.chatId; if (typeof id === "string") openRef2.current(id); };
    const back = (e: Event) => { if (backRef.current()) e.preventDefault(); };
    addEventListener("unimsg-open-chat", open); addEventListener("unimsg-back", back);
    return () => { removeEventListener("unimsg-open-chat", open); removeEventListener("unimsg-back", back); };
  }, []);
  useEffect(() => { const f = () => setSettingsOpen(true), n = (e: Event) => offerSyncLink((e as CustomEvent).detail?.url); addEventListener("unichat-sync-link", f); addEventListener("unimsg-sync-link", n); return () => { removeEventListener("unichat-sync-link", f); removeEventListener("unimsg-sync-link", n); }; }, []);
  useEffect(() => { if ((window as any).UnimsgNative) core.call("$config", { notifyContent: settings.notifyContent }).catch(() => {}); }, [settings.notifyContent]);
  useEffect(() => { if ((window as any).UnimsgNative) core.call("$config", { keepAlive: settings.keepAlive }).catch(() => {}); }, [settings.keepAlive]);

  const refreshNow = async (groups = true) => {
    const s = await core.call("snapshot");
    setAccounts(s.accounts ?? await core.call("accounts"));
    if (groups) core.call("railGroups").then((g: RailGroup[]) => { if (!railWrites.current) setRailGroupsState(g ?? []); }, () => {}); // (not while one of our own writes is in flight: it would flash the old groups) // older backends have none
    setCats(s.categories ?? {});
    setListReady(true);
    setSpaces((p) => reuse(p, s.spaces)); setChats((p) => reuse(p, s.chats.map((c: Chat) => (c.unread && mrRef.current?.has(c.id) && (c.lastMessageAt ?? "") <= mrRef.current.get(c.id)! ? { ...c, unread: 0 } : c))));
  };
  /** Direct snapshot (callers that just changed something and need the result). */
  const refresh = (): Promise<void> => refreshNow();
  /** Coalescing refresh for event bursts: any number of chats-changed / spaces-changed / account events while a snapshot is in flight cost ONE more snapshot. */
  const rf = useRef<{ cur?: Promise<void>; again?: boolean; groups?: boolean; wait?: ReturnType<typeof setTimeout> }>({});
  /** `groups`: also re-read the rail groups (an extra backend call that itself computes a snapshot); only space changes can alter them. The first refresh of a burst runs at once, follow-ups at most every 250 ms (a history sync can emit hundreds of chats-changed, each worth a 400 kB snapshot). */
  const refreshSoon = (groups = true): void => {
    const r = rf.current; if (groups) r.groups = true;
    if (r.cur || r.wait) { r.again = true; return; }
    const run = () => { r.again = false; const g = !!r.groups; r.groups = false; r.cur = refreshNow(g).catch(() => {}).finally(() => { r.cur = undefined; if (r.again) { r.wait = setTimeout(() => { r.wait = undefined; run(); }, 250); } }); };
    run();
  };
  const mrRef = useRef<Map<string, string>>();
  const resolvedRef = useRef(new Map<string, string>()); // provisional chat id -> real chat id
  const liveNotes = useRef(new Map<string, Notification>()); // shown desktop notifications by chat: dismissed again once that chat is opened
  useEffect(() => { const seen = () => { if (chatId && document.hasFocus()) { liveNotes.current.get(chatId)?.close(); liveNotes.current.delete(chatId); } }; seen(); addEventListener("focus", seen); return () => removeEventListener("focus", seen); }, [chatId]);
  // A notification whose chat is not unread any more has been read: here, through "Mark as read", or on another device (sync).
  // Leaving it standing is what made them pile up; the list is the authority, so this covers every way a chat can become read.
  useEffect(() => {
    for (const [id, note] of [...liveNotes.current]) {
      const c = chats.find((x) => x.id === id);
      if (c && !c.unread && !c.unreadMark) { note.close(); liveNotes.current.delete(id); }
    }
  }, [chats]);
  const listReadyRef = useMemoRef(listReady); // no notification before the chat list (and with it the mute / archive state) has loaded
  const chatsRef = useMemoRef(chats), settingsRef = useMemoRef(settings), mutedRef = useMemoRef(quiet), openRef = useMemoRef(chatId);

  useEffect(() => {
    let gone = false;
    core.ready.then(async () => {
      // First load: a backend that is still starting (or frozen for a while) answers late or not at all. Keep the loading state and retry with a growing pause; the banner is only for errors after the first snapshot.
      for (let i = 0; !gone; i++) {
        try { await Promise.all([core.call("providers").then(setProviders), refresh()]); break; }
        catch { await new Promise((r) => setTimeout(r, Math.min(5000, 600 * (i + 1)))); }
      }
      if (gone) return;
      try { const pend: LoginPrompt[] = (await core.call("pendingLogins").catch(() => [])) ?? []; if (pend.length) setLogin(pend[0]); } catch (e: any) { setError(e.message); }
    }, (e) => setFatal(e.message));
    const handle = (ev: string, d: any) => {
      // Events of a chat that belongs to a merged chat carry `mergeId`; the UI keeps the unified timeline / typing / unread under that key.
      const k: string = d.mergeId ?? d.chatId;
      if (ev === "message") {
        setMsgs((m) => (m[k] ? { ...m, [k]: upsert(m[k], d) } : m));
        // History syncs / backfills arrive as messages too: they are neither new (no unread bump) nor notification-worthy.
        const stale = !!d.historical || Date.now() - Date.parse(d.time) > 2 * 60_000;
        if (!d.fromMe) setTyping((t) => ((t[k] ?? []).includes(d.senderId) ? { ...t, [k]: t[k].filter((x) => x !== d.senderId) } : t));
        const open = openRef.current === k && document.hasFocus();
        setChats((cs) => cs.map((c) => (c.id === d.chatId || c.id === d.mergeId ? { ...c, ...(stale ? {} : { preview: d.text || c.preview, lastMessageAt: d.time, unread: d.fromMe || open ? c.unread : (c.unread ?? 0) + 1 }) } : c)));
        if (!d.fromMe && !open && !stale && listReadyRef.current && chatsRef.current.some((c) => c.id === k || c.id === d.chatId) && settingsRef.current.notifications && !mutedRef.current.has(k) && "Notification" in window && Notification.permission === "granted")
          { const mode = settingsRef.current.notifyContent; const title = mode === "hidden" ? "UniChat" : (d.mergeId && chatsRef.current.find((c) => c.id === d.mergeId)?.name) || d.sender || "New message";
            // The chat's avatar is the notification icon (not in "hidden" mode, and the app icon stays when there is none or it is slow to load).
            void notificationIcon(d.mergeId ?? d.chatId, mode).then((icon) => {
              const nt = new Notification(title, { body: mode === "full" ? d.text || "Attachment" : "New message", tag: mode === "hidden" ? "unichat" : k, ...(icon ? { icon } : {}) }); liveNotes.current.get(k)?.close(); liveNotes.current.set(k, nt); nt.onclose = () => { if (liveNotes.current.get(k) === nt) liveNotes.current.delete(k); }; nt.onclick = () => { try { window.focus(); } catch { /* ignore */ } openChatRef.current?.(d.mergeId ?? k); nt.close(); }; }); }
      }
      if (ev === "message-update") setMsgs((m) => ({ ...m, [k]: (m[k] ?? []).map((x) => (x.id === d.messageId && x.chatId === d.chatId ? { ...x, ...d.patch, ...(d.patch.deleted ? { reactions: [], attachments: undefined, card: undefined, cards: undefined, poll: undefined, location: undefined, contacts: undefined } : {}) } : x)) }));
      if (ev === "receipt") setMsgs((m) => ({ ...m, [k]: (m[k] ?? []).map((x) => (x.id === d.messageId && x.chatId === d.chatId && RANK.indexOf(d.status) >= RANK.indexOf(x.status ?? "sending") ? { ...x, status: d.status } : x)) }));
      if (ev === "typing") {
        const key = `${d.chatId}|${d.senderId}`, drop = () => { clearTimeout(typingTimers.current.get(key)); typingTimers.current.delete(key); setTyping((t) => ({ ...t, [k]: (t[k] ?? []).filter((x) => x !== d.senderId) })); };
        if (d.typing) { clearTimeout(typingTimers.current.get(key)); typingTimers.current.set(key, setTimeout(drop, 9000)); setTyping((t) => ({ ...t, [k]: [...new Set([...(t[k] ?? []), d.senderId])] })); }
        else drop();
      }
      if (ev === "presence") { // presence of a contact: the Hub sends the global chat id when the provider knew the 1:1 chat; the contact id may also be the native chat id
        const gid = d.chatId ?? `${d.accountId}:${d.contactId}`, cid = `${d.accountId}:${d.contactId}`;
        setChats((cs) => cs.map((c) => ((c.id === gid || c.id === cid) && c.kind === "dm" && (c.online !== d.online || c.lastSeen !== d.lastSeen) ? { ...c, online: d.online, lastSeen: d.lastSeen } : c)));
      }
      if (ev === "history-updated") { if (openRef.current === k) loadChat(k, true); else setMsgs((m) => { const n = { ...m }; delete n[k]; return n; }); } // other chats: drop the stale copy, it reloads when opened
      if (ev === "core-connection") { setConn(d.state); if (d.state === "up") { setError((e) => (e && /Connection to the backend was lost|Not connected to the backend|cannot reach the backend/i.test(e) ? undefined : e)); refreshSoon(); setMsgs({}); if (openRef.current) loadChat(openRef.current, true); } } // events were missed while disconnected: forget every cached chat
      if (ev === "chat-resolved") { // a provisional chat (startChat before the first message) became the real chat: keep the typed conversation under the new id
        resolvedRef.current.set(d.from, d.to);
        setMsgs((m) => { if (!m[d.from]) return m; const { [d.from]: old, ...rest } = m; return { ...rest, [d.to]: (old ?? []).map((x) => ({ ...x, chatId: d.to })).reduce((l: Message[], x) => upsert(l, x), rest[d.to] ?? []) }; });
        setChats((cs) => cs.filter((c) => c.id !== d.from));
        if (openRef.current === d.from) setChatId(d.to);
        refreshSoon();
      }
      if (ev === "login") setLogin(d);
      if (ev === "chats-changed" || ev === "spaces-changed") {
        if (d?.mergeId && !d.quiet) { setMsgs({}); setHistTick((t) => t + 1); } // a merge changed: every cached timeline may now be keyed differently
        setTick((t) => t + 1); refreshSoon(ev === "spaces-changed"); }
      if (ev === "account") {
        // a link change adds timeline markers / read-only state: drop this account's cached histories so open chats reload.
        // Only on a REAL change: a provider that re-announces the state it already has (e.g. "connected" again) must not blank the open chat.
        const was = acctStateRef.current.get(d.id); acctStateRef.current.set(d.id, d.state);
        if (was !== d.state && ["signed-out", "needs-login", "connected"].includes(d.state)) { setMsgs((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(d.id + ":") && !k.startsWith("merge:")))); setHistTick((t) => t + 1); }
        // A problem message belongs to the account that reported it: once that account is connected again it is history,
        // and leaving it on screen made a connection that had already recovered look broken.
        if (d.state === "connected") { setLogin(undefined); fresh.current.delete(d.id); relinking.current.delete(d.id); if (errorFrom.current === d.id) { errorFrom.current = undefined; setError(undefined); } } refreshSoon(); }
      if (ev === "error") { errorFrom.current = d.fatal ? undefined : d.id; setError(d.message); }
        };
    // High-frequency events (a busy account can deliver hundreds per second) are applied together once per 40 ms: one render, not one per event.
    const HF = new Set(["message", "message-update", "receipt", "typing", "presence"]);
    let buf: [string, any][] = [], timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => { clearTimeout(timer); timer = undefined; const b = buf; buf = []; for (const [e, dd] of b) { try { handle(e, dd); } catch (err) { console.error("event", e, err); } } };
    const off = core.on((ev, d) => { if (HF.has(ev)) { buf.push([ev, d]); timer ??= setTimeout(flush, 40); return; } if (buf.length) flush(); handle(ev, d); });
    return () => { gone = true; off(); clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (!chatId) return;
    setChats((cs) => cs.map((c) => (c.id === chatId || c.mergedInto === chatId ? { ...c, unread: 0 } : c)));
    if (!msgs[chatId] && !hist[chatId]) loadChat(chatId);
  }, [chatId, chats.length, histTick]);
  // a chat that was merged (here or on another device) is only ever shown as its merged chat
  useEffect(() => { const c = chats.find((x) => x.id === chatId); if (c?.mergedInto) setChatId(c.mergedInto); }, [chats, chatId]);

  const listChats = useMemo(() => chats.filter((c) => !c.mergedInto), [chats]); // member chats of a merge live behind their merged row
  // Chat filters (Unread / Messenger / Type / Online): AND-combined, remembered in the settings, applied to every view (Personal, communities, folders); the name search below ignores them.
  const filters = useMemo(() => normFilters(settings.chatFilters), [settings.chatFilters]);
  const setFilters = (f: ChatFilters) => setSettings((s) => ({ ...s, chatFilters: f }));
  const nFilters = activeCount(filters);
  const passes = useMemo(() => {
    if (!nFilters) return (_: Chat) => true;
    const byId = new Map(chats.map((c) => [c.id, c]));
    return (c: Chat) => matchesFilters(c, filters, { members: c.mergeMembers?.map((id) => byId.get(id)).filter((x): x is Chat => !!x), isMuted: (x) => muted.has(x.id) });
  }, [filters, nFilters, chats, muted]);
  const inView = (c: Chat, v: string) => (v === HOME ? !c.spaceId : c.spaceId === v) && (showArchived || !c.archived);
  const visible = useMemo(() => listChats
    .filter((c) => (filter ? c.name.toLowerCase().includes(filter.toLowerCase()) : inView(c, space) && passes(c)))
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "")), [listChats, space, filter, pinned, showArchived, passes]);
  /** Rail icons of views without a single matching chat are dimmed (still clickable) while filters are on. */
  const emptyViews = useMemo(() => {
    const out = new Set<string>(); if (!nFilters) return out;
    const hit = new Set<string>(); for (const c of listChats) if (inView(c, c.spaceId ?? HOME) && passes(c)) hit.add(c.spaceId ?? HOME);
    for (const v of [HOME, ...spaces.map((x) => x.id)]) if (!hit.has(v)) out.add(v);
    return out;
  }, [listChats, spaces, passes, nFilters, showArchived]);
  // Chats with a category are listed under collapsible headings: uncategorised chats on top, then the user's own categories (their order, empty ones included),
  // then the provider's categories (first-seen order = the network's own order). Personal has only the user's.
  const view = space === HOME ? PERSONAL_VIEW : space;
  const viewCats = cats[view] ?? [];
  const groups = useMemo<CatGroup[]>(() => {
    if (filter) return [{ key: "", chats: visible }];
    const out: CatGroup[] = [{ key: "", chats: visible.filter((c) => !c.category) }];
    for (const uc of cats[view] ?? []) out.push({ key: space + "|" + uc.id, name: uc.name, id: uc.id, color: uc.color, chats: visible.filter((c) => c.categoryId === uc.id) });
    const order: string[] = []; if (space !== HOME) for (const c of listChats) if (c.spaceId === space && c.category && !c.categoryId && !order.includes(c.category)) order.push(c.category);
    for (const name of order) { const cs = visible.filter((c) => c.category === name && !c.categoryId); if (cs.length) out.push({ key: space + "|" + name, name, chats: cs }); }
    return out;
  }, [visible, listChats, space, filter, cats, view]);
  const flatIds = useMemo(() => groups.flatMap((g) => (g.name !== undefined && collapsedCats.has(g.key) ? [] : g.chats.map((c) => c.id))), [groups, collapsedCats]);
  useEffect(() => setSel((s) => (s.some((id) => !listChats.some((c) => c.id === id)) ? s.filter((id) => listChats.some((c) => c.id === id)) : s)), [listChats]); // moved / archived / merged chats leave the selection
  const chat = chats.find((c) => c.id === chatId);
  const pinfo = (p?: string) => providers.find((x) => x.name === p);
  /** Capabilities that apply to a chat/space: the ACCOUNT's live ones (they can differ per instance), else the provider's. */
  const capsFor = (x?: { accountId: string; provider: string }) => (x ? capsOf(accounts.find((a) => a.id === x.accountId), providers, x.provider) : undefined);
  // single-chat communities (`collapsed`) have no rail entry: their chat is listed under Personal
  // A network community whose chats were all moved elsewhere has nothing left to show: no rail entry either (your own folders stay, even when empty).
  const railSpaces = useMemo(() => {
    const filled = new Set(chats.filter((c) => !c.mergedInto).map((c) => c.spaceId));
    return spaces.filter((s) => !s.collapsed && (s.local || !chats.length || filled.has(s.id)));
  }, [spaces, chats]);
  // The archive button is one global switch: while it is on, archived communities, folders and chats show up everywhere (dimmed).
  const visibleSpaces = railSpaces.filter((s) => showArchived || !s.archived), archivedSpaces = railSpaces.filter((s) => s.archived);
  const archivedChatTotal = useMemo(() => chats.filter((c) => c.archived && !c.mergedInto).length, [chats]);
  useEffect(() => { if (showArchived && !archivedSpaces.length && !archivedChatTotal) setShowArchived(false); }, [showArchived, archivedSpaces.length, archivedChatTotal]); // nothing archived any more: the switch resets
  /** Unread messages waiting in archived chats / archived communities (muted chats don't count): the archive button's message bubble. */
  const archivedUnread = useMemo(() => chats.reduce((n, c) => (!c.mergedInto && (c.archived || (c.spaceId && archivedSpaceIds.has(c.spaceId))) && !muted.has(c.id) ? n + (c.unread ?? 0) : n), 0), [chats, archivedSpaceIds, muted]); // muted = the chat itself or its community
  useEffect(() => { if (!showArchived && space !== HOME && railSpaces.find((s) => s.id === space)?.archived) setSpace(HOME); }, [showArchived, space, railSpaces]);
  /** Rail entries: plain icons and groups. A group sits where its first (visible) member sits; its members follow in the group's own order. */
  const railEntries = useMemo(() => {
    const vis = new Map(visibleSpaces.map((x) => [x.id, x])), out: ({ space: Space } | { group: RailGroup; members: Space[] })[] = [], done = new Set<string>();
    const gm = (g: RailGroup) => g.members.map((id) => vis.get(id)).filter((x): x is Space => !!x);
    for (const x of visibleSpaces) {
      const g = railGroups.find((y) => y.members.includes(x.id));
      if (!g) out.push({ space: x }); else if (!done.has(g.id)) { done.add(g.id); out.push({ group: g, members: gm(g) }); }
    }
    return out;
  }, [visibleSpaces, railGroups]);
  const railState = (): RailState => ({ all: spaces.map((x) => x.id), groups: railGroups });
  /** Apply a rail change (order + groups) optimistically, then store it in the Hub. */
  const applyRail = (next?: RailState) => {
    if (!next || !changed(railState(), next)) return;
    const created = next.groups.find((g) => !railGroups.some((x) => x.id === g.id)); if (created) toggleGroup(created.id, true);
    const groupsChanged = JSON.stringify(next.groups) !== JSON.stringify(railGroups);
    setRailGroupsState(next.groups); setSpaces((ss) => next.all.map((id) => ss.find((x) => x.id === id)).filter((x): x is Space => !!x));
    railWrites.current++;
    (async () => { try { if (groupsChanged) { const saved = await core.call("setRailGroups", { groups: next.groups }); if (railWrites.current === 1) setRailGroupsState(saved); } await core.call("setRailOrder", { ids: next.all }); } catch (e: any) { setError(e.message); } finally { railWrites.current--; await refresh().catch(() => {}); } })();
  };
  const newGroupId = () => "group:" + (crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2));
  const dropOnRail = (from: string, key: string, zone: "before" | "mid" | "after") =>
    applyRail(zone === "mid" ? dropOnto(railState(), from, key, newGroupId(), GROUP_COLORS[railGroups.length % GROUP_COLORS.length]) : dropEdge(railState(), from, key, zone === "after"));
  const saveGroup = (g: RailGroup, v: { name: string; color: string }) => applyRail({ all: spaces.map((x) => x.id), groups: railGroups.map((x) => (x.id === g.id ? { ...x, ...v } : x)) });
  const dragChats = (raw: string): Chat[] => (raw.startsWith("[") ? (JSON.parse(raw) as string[]) : [raw]).map((id) => chats.find((c) => c.id === id)).filter((c): c is Chat => !!c);
  useEffect(() => { if (space !== HOME && spaces.length && !railSpaces.some((s) => s.id === space)) setSpace(HOME); }, [spaces, railSpaces, space]); // the open folder was deleted / collapsed
  // A community icon carries its messenger's badge only while everything inside it is from that one messenger (chats can be moved in from others).
  const chatById = useMemo(() => new Map(chats.map((c) => [c.id, c])), [chats]);
  const spaceById = useMemo(() => new Map(spaces.map((x) => [x.id, x])), [spaces]);
  const provsBySpace = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const c of chats) if (c.spaceId && !c.mergedInto) { let st = m.get(c.spaceId); if (!st) m.set(c.spaceId, (st = new Set())); for (const p of c.mergeMembers ? c.mergeMembers.map((id) => chatById.get(id)?.provider).filter((x): x is string => !!x) : [c.provider]) st.add(p); }
    return m;
  }, [chats, chatById]);
  const railDot = (sp: Space) => { const provs = provsBySpace.get(sp.id); return !provs || provs.size === 0 || (provs.size === 1 && provs.has(sp.provider)) ? sp.provider : undefined; };
  /** Rail badge: a count of exact unread numbers; chats that only know "something new" (unreadApprox) add a dot only when nothing else is unread there. (One pass over the chats, not one per icon.) */
  const unreadAgg = useMemo(() => {
    // with the archive switch on, archived chats' unread counts show up where they live
    const exact = new Map<string, number>(), approx = new Map<string, number>();
    for (const c of listChats) { if (!c.unread || (showArchived ? muted.has(c.id) : quiet.has(c.id))) continue; const k = c.spaceId ?? HOME, m = c.unreadApprox ? approx : exact; m.set(k, (m.get(k) ?? 0) + c.unread); }
    return { exact, approx };
  }, [listChats, quiet, muted, showArchived]);
  const dotIn = (id: string) => !(unreadAgg.exact.get(id) ?? 0) && (unreadAgg.approx.get(id) ?? 0) > 0;
  const unreadIn = (id: string) => unreadAgg.exact.get(id) ?? 0;
  const pick = (id: string) => { setSel([]); setSpace(id); setChatId(undefined); setNavOpen(true); setPanel(undefined); };
  const openChat = (id0: string) => { const id = chats.find((x) => x.id === id0)?.mergedInto ?? id0; const c = chats.find((x) => x.id === id); if (c) { setSpace(c.spaceId ?? HOME); setOpenedUnread((o) => ({ ...o, [id]: c.unread ?? 0 })); if (c.unreadMark) setFlag(id, { unreadMark: false }); } setChatId(id); setNavOpen(false); };
  openChatRef.current = openChat; pickRef.current = pick;
  useEffect(() => { const h = (e: Event) => openChatRef.current?.((e as CustomEvent<string>).detail); window.addEventListener("unichat-open-chat", h); return () => window.removeEventListener("unichat-open-chat", h); }, []);
  useEffect(() => { const h = (e: Event) => pickRef.current?.((e as CustomEvent<string>).detail); window.addEventListener("unichat-open-space", h); return () => window.removeEventListener("unichat-open-space", h); }, []); // a community listed in a contact's info // e.g. a group listed in a contact's info
  openRef2.current = openChat;
  backRef.current = () => {
    const close = (el: Element | null) => { if (!el) return false; el.dispatchEvent(new MouseEvent(el.classList.contains("lightbox") ? "click" : "mousedown", { bubbles: true, cancelable: true })); return true; };
    if (sel.length) { setSel([]); setSelMenu(undefined); return true; }
    const layers = Array.from(document.querySelectorAll(".lightbox, .modalbg")); // topmost = last in the document
    if (layers.length) return close(layers[layers.length - 1]);
    if (document.querySelector(".railmenu, .popmenu, .ctxmenu")) { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); setMenuFor(null); setRailMenu(undefined); setCatMenu(undefined); setGroupMenu(undefined); setSelMenu(undefined); return true; }
    if (settingsOpen) { setSettingsOpen(false); return true; }
    if (gsearch) { setGsearch(undefined); return true; }
    if (panel) { setPanel(undefined); return true; }
    if (chatId && matchMedia("(max-width: 720px)").matches) { setChatId(undefined); setNavOpen(true); return true; }
    return false;
  };
  const setFlag = (id: string, patch: Partial<Pick<Chat, "pinned" | "muted" | "archived" | "unreadMark">>) => {
    const c: Partial<Chat> | undefined = chats.find((x) => x.id === id) ?? spaces.find((x) => x.id === id); if (!c) return;
    const next = { pinned: !!c.pinned, muted: !!c.muted, archived: !!c.archived, unreadMark: !!c.unreadMark, ...patch };
    setChats((cs) => cs.map((x) => (x.id === id ? { ...x, ...next } : x))); // optimistic
    setSpaces((ss) => ss.map((x) => (x.id === id ? { ...x, muted: next.muted, archived: next.archived } : x)));
    core.call("setChatFlags", { chatId: id, ...next }).catch((e) => { setError(e.message); refresh(); });
  };
  const toggleMute = (id: string) => setFlag(id, { muted: !muted.has(id) });
  const togglePin = (id: string) => setFlag(id, { pinned: !pinned.has(id) });
  const act = async (method: string, params: object) => {
    try {
      const r = await core.call(method, params);
      await refresh();
      // signing out / removing worked locally, but the messenger may still list this device: tell the user what to do
      if (r?.warning) setConfirmBox({ title: "Removed here, but not confirmed at the messenger", body: String(r.warning), confirmLabel: "OK, I'll check my phone", onConfirm: () => {} });
    } catch (e: any) { setError(e.message); }
  };
  const leave = async (c: Chat) => { if (!confirm(`Leave “${c.name}”?`)) return; await act("leaveChat", { chatId: c.id }); setChatId(undefined); setInfo(false); };
  const block = (c: Chat) => {
    if (c.blocked) { act("blockChat", { chatId: c.id, blocked: false }); return; }
    const note = c.provider === "matrix" ? " On Matrix this uses your account-wide ignore list: you also stop seeing everything this person writes in every other room." : "";
    setConfirmBox({ title: `Block ${c.name}?`, confirmLabel: "Block", danger: true, body: `They won't be able to message you.${note}`, onConfirm: () => act("blockChat", { chatId: c.id, blocked: true }) });
  };
  const removeMember = (c: Chat, m: Contact) => { if (confirm(`Remove ${m.name} from “${c.name}”?`)) act("removeMember", { chatId: c.id, memberId: m.id }); };
  /** Load a chat's newest page, with a visible loading / error state (the Hub may have to ask the provider). */
  const loadSeq = useRef<Record<string, number>>({});
  const sourceFor = (id: string) => { const c = chats.find((x) => x.id === id); return c ? sourceOf(c, chats, accounts, providers) : undefined; };
  const loadChat = (id: string, quiet = false) => {
    const mine = (loadSeq.current[id] = (loadSeq.current[id] ?? 0) + 1), live = () => loadSeq.current[id] === mine;
    const src = sourceFor(id);
    let settled = false;
    const apply = (h: Message[], note?: string) => {
      settled = true;
      setMsgs((m) => ({ ...m, [id]: h ?? [] })); setMore((m) => ({ ...m, [id]: (h ?? []).length >= 100 }));
      setHist((s) => { const n = { ...s }; delete n[id]; return n; });
      setLoadNote((n) => { const x = { ...n }; if (note) x[id] = note; else delete x[id]; return x; });
    };
    const local = () => core.call("history", { chatId: id, limit: 100, local: true });
    if (!quiet) { setHist((h) => ({ ...h, [id]: { status: "loading", since: Date.now() } })); setLoadNote((n) => { const x = { ...n }; delete x[id]; return x; }); }
    // the device that holds this account is off: nothing will answer, so read what is saved here at once
    if (src?.kind === "offline") return local().then((h: Message[]) => live() && apply(h, offlineLine(src)), (e) => setHist((s) => ({ ...s, [id]: { status: "error", since: Date.now(), error: e?.message ?? String(e) } })));
    // First paint from the local archive. A chat opened from a notification must show that message at once; waiting for the
    // messenger's own answer left the chat looking empty for as long as it took (issue #94). The answer replaces this when it comes.
    if (!quiet) local().then((h: Message[]) => { if (live() && !settled && h?.length) setMsgs((m) => (m[id] ? m : { ...m, [id]: h })); }, () => {});
    let timedOut = false;
    const timer = setTimeout(() => { // no answer in time: show the archive, keep waiting in the background
      timedOut = true; if (!live()) return;
      local().then((h: Message[]) => live() && apply(h, src ? timeoutNote(src) : "The messenger didn't answer in time. Showing what is saved here."), () => {});
    }, (globalThis as any).__loadTimeoutMs ?? 15000);
    return core.call("history", { chatId: id, limit: 100 }).then((h: Message[]) => { clearTimeout(timer); if (live()) apply(h); }, (e) => {
      clearTimeout(timer); if (!live() || timedOut) return;
      setHist((s) => ({ ...s, [id]: { status: "error", since: Date.now(), error: e?.message ?? String(e) } }));
    });
  };
  const loadOlder = async (id: string, limit = 50) => {
    const merged = id.startsWith("merge:"); // a merged chat pages by its first real message (timeline markers have no archive row)
    const first = merged ? msgs[id]?.find((x) => !x.system) : msgs[id]?.[0]; if (!first) return 0;
    const h: Message[] = (await core.call("history", { chatId: id, limit, beforeMessageId: first.id, ...(merged ? { beforeChatId: first.chatId } : {}) })) ?? [];
    setMsgs((m) => ({ ...m, [id]: [...h.filter((x) => !(m[id] ?? []).some((y) => y.id === x.id && y.chatId === x.chatId)), ...(m[id] ?? [])] }));
    setMore((m) => ({ ...m, [id]: h.length >= limit }));
    return h.length;
  };
  /** Message request banner: accept keeps the chat, decline removes it (the provider drops it from the list). */
  const requestAnswer = async (c: Chat, accept: boolean) => {
    try {
      await core.call(accept ? "acceptRequest" : "declineRequest", { chatId: c.id });
      if (accept) setChats((cs) => cs.map((x) => (x.id === c.id ? { ...x, request: false } : x)));
      else { setChats((cs) => cs.filter((x) => x.id !== c.id)); if (chatId === c.id) setChatId(undefined); say("Message request declined"); }
      await refresh();
    } catch (e: any) { setError(e.message); }
  };
  const say = (t: string) => { setNotice(t); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(undefined), 4000); };
  const mr = useMarkRead({ say, setChats, settings, setError, getChats: () => chatsRef.current });
  /** Archived chats with unread messages, muted ones included (for the "mark all archived as read" action). */
  const archivedUnreadList = () => chatsRef.current.filter((c) => !c.mergedInto && (c.archived || (c.spaceId && archivedSpaceIds.has(c.spaceId))) && (c.unread ?? 0) > 0);
  const archivedUnreadAll = archivedUnread + chats.filter((c) => !c.mergedInto && muted.has(c.id) && (c.archived || (c.spaceId && archivedSpaceIds.has(c.spaceId))) && (c.unread ?? 0) > 0).reduce((n, c) => n + (c.unread ?? 0), 0);
  const markArchivedRead = async () => {
    const list = archivedUnreadList(); if (!list.length) { say("Nothing unread in the archive."); return; }
    say(`Marking ${list.length} archived chat${list.length === 1 ? "" : "s"} as read…`);
    for (const c of list) await mr.markChat(c);
    say(`${list.length} archived chat${list.length === 1 ? "" : "s"} marked as read.`);
  };
  mrRef.current = mr.localRead;
  const offlineMedia = useOfflineMedia(accounts);
  /** Global search hit: open the chat and jump to (and flash) the message once the timeline is loaded. */
  const openHit = (g: GGroup, h: GHit) => { pendingJump.current = { key: g.chatId, messageId: h.messageId, chatId: h.chatId, tries: 0 }; openChat(g.chatId); setJumpTick((t) => t + 1); };
  useEffect(() => {
    const pj = pendingJump.current; if (!pj || chatId !== pj.key || msgs[pj.key] === undefined) return;
    const t = setTimeout(() => { if (jumpRef.current) { jumpRef.current(pj.messageId, pj.chatId); pendingJump.current = undefined; } else if (pj.tries++ < 10) setJumpTick((x) => x + 1); else pendingJump.current = undefined; }, 200);
    return () => clearTimeout(t);
  }, [jumpTick, chatId, msgs, hist]);
  const moveChat = async (c: Chat, folderId: string | null) => {
    setMoving(undefined);
    try {
      await core.call("moveChat", { chatId: c.id, folderId }); await refresh();
      const to = folderId === null ? "its original place" : folderId === "personal" ? "Personal" : spaces.find((x) => x.id === folderId)?.name ?? "the folder";
      say(`Moved “${c.name}” to ${to}`);
    } catch (e: any) { setError(e.message); }
  };
  const targetName = (folderId: string | null) => (folderId === null ? "their original places" : folderId === "personal" ? "Personal" : spaces.find((x) => x.id === folderId)?.name ?? "the folder");
  /** Run one backend call per chat with a progress notice; failures are summarised in one message and stay selected. */
  const forEach = async (cs: Chat[], verb: string, done: string, fn: (c: Chat) => Promise<unknown>) => {
    const failed: Chat[] = [], why: string[] = [];
    for (const [i, c] of cs.entries()) { if (cs.length > 3) say(`${verb} ${i + 1}/${cs.length}…`); try { await fn(c); } catch (e: any) { failed.push(c); why.push(`“${c.name}”: ${e?.message ?? e}`); } }
    await refresh();
    setSel(failed.map((c) => c.id));
    if (failed.length) setError(`Partly done: ${cs.length - failed.length} of ${cs.length} done, ${failed.length} failed. ${why.slice(0, 3).join(" · ")}${why.length > 3 ? ` · and ${why.length - 3} more` : ""}`);
    else say(done);
  };
  const moveMany = async (cs: Chat[], folderId: string | null) => {
    setMoving(undefined); setBulkMove(undefined);
    if (cs.length === 1) return moveChat(cs[0], folderId);
    if (cs.length) await forEach(cs, "Moving", `Moved ${cs.length} chats to ${targetName(folderId)}`, (c) => core.call("moveChat", { chatId: c.id, folderId }));
  };
  // ---- user categories ----
  const viewOfChat = (c: Chat) => c.spaceId ?? PERSONAL_VIEW;
  const viewName = (v: string) => (v === PERSONAL_VIEW ? "Personal" : spaces.find((x) => x.id === v)?.name ?? "this view");
  const catName = (id: string) => Object.values(cats).flat().find((c) => c.id === id)?.name ?? "the category";
  const setCategoryFor = async (cs: Chat[], target: string | null) => {
    setCatPick(undefined);
    if (!cs.length) return;
    try {
      await core.call("setChatCategory", { chatIds: cs.map((c) => c.id), categoryId: target }); await refresh();
      const what = cs.length === 1 ? `“${cs[0].name}”` : `${cs.length} chats`;
      say(target === null ? `${what} follow${cs.length === 1 ? "s" : ""} the provider's category again` : target === "none" ? `Removed ${what} from its category` : `Moved ${what} to category “${catName(target)}”`);
      setSel([]);
    } catch (e: any) { setError(e.message); }
  };
  const saveCategory = async (v: { name: string; color: string | null }) => {
    const ce = catEdit; setCatEdit(undefined); if (!ce) return;
    try {
      if (ce.cat) await core.call("updateCategory", { id: ce.cat.id, name: v.name, color: v.color });
      else {
        const c = await core.call("createCategory", { spaceId: ce.view, name: v.name, ...(v.color ? { color: v.color } : {}) });
        if (ce.thenMove?.length) { await core.call("setChatCategory", { chatIds: ce.thenMove.map((x) => x.id), categoryId: c.id }); setCatPick(undefined); setSel([]); say(`Moved ${ce.thenMove.length === 1 ? `“${ce.thenMove[0].name}”` : `${ce.thenMove.length} chats`} to category “${c.name}”`); }
      }
      await refresh();
    } catch (e: any) { setError(e.message); }
  };
  const deleteCategory = (g: CatGroup) => setConfirmBox({ title: `Delete category “${g.name}”?`, confirmLabel: "Delete category", danger: true,
    body: `The ${g.chats.length} chat${g.chats.length === 1 ? "" : "s"} in it go back to their provider's category (or stay uncategorised). No chat or message is deleted.`,
    onConfirm: async () => { try { await core.call("deleteCategory", { id: g.id }); await refresh(); } catch (e: any) { setError(e.message); } } });
  const applyCatOrder = (v: string, ids: string[]) => {
    setCats((c) => ({ ...c, [v]: ids.map((id) => (c[v] ?? []).find((x) => x.id === id)).filter((x): x is UserCategory => !!x).map((x, i) => ({ ...x, order: i })) }));
    core.call("setCategoryOrder", { spaceId: v, ids }).then(refresh, (e) => { setError(e.message); refresh(); });
  };
  const nudgeCat = (id: string, dir: -1 | 1) => { const ids = viewCats.map((c) => c.id), i = ids.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; applyCatOrder(view, ids); };
  const dropCatBefore = (drag: string, anchor: string, after: boolean) => { const rest = viewCats.map((c) => c.id).filter((x) => x !== drag), i = rest.indexOf(anchor); if (i < 0 || drag === anchor) return; rest.splice(after ? i + 1 : i, 0, drag); applyCatOrder(view, rest); };
  /** Dropped chats can only go to a category of the view they are in (a search can list chats of other views). */
  const dropChatsOnCat = (raw: string, target: string) => { const cs = dragChats(raw).filter((c) => viewOfChat(c) === view); if (cs.length) void setCategoryFor(cs, target); };
  const newCategory = (thenMove?: Chat[]) => setCatEdit({ view: thenMove?.length ? viewOfChat(thenMove[0]) : view, where: viewName(thenMove?.length ? viewOfChat(thenMove[0]) : view), thenMove });
  const catZone = (e: React.DragEvent): "before" | "after" => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY - r.top < r.height / 2 ? "before" : "after"; };
  const oneView = (cs: Chat[]) => cs.length > 0 && new Set(cs.map(viewOfChat)).size === 1;
  const selChats = () => sel.map((id) => chats.find((c) => c.id === id)).filter((c): c is Chat => !!c);
  const bulkFlags = (cs: Chat[], patch: { muted?: boolean; archived?: boolean }, verb: string, done: string) => {
    setChats((all) => all.map((x) => (cs.some((c) => c.id === x.id) ? { ...x, ...patch } : x)));
    return forEach(cs, verb, done, (c) => core.call("setChatFlags", { chatId: c.id, pinned: !!c.pinned, muted: !!c.muted, archived: !!c.archived, ...patch }));
  };
  const bulkRead = async (cs: Chat[]) => { const todo = cs.filter((c) => !!c.unread); if (!todo.length) { say("Nothing unread in the selection."); return; } for (const [i, c] of todo.entries()) { if (todo.length > 3) say(`Marking ${i + 1}/${todo.length} as read…`); await mr.markChat(c); } say(`Marked ${todo.length} chat${todo.length === 1 ? "" : "s"} as read`); setSel([]); };
  const clickRow = (e: React.MouseEvent, c: Chat) => {
    if (e.shiftKey) { // range from the last clicked chat (or the open one); ctrl/cmd+shift adds it to what is selected
      const a0 = selAnchor.current && flatIds.includes(selAnchor.current) ? selAnchor.current : chatId && flatIds.includes(chatId) ? chatId : c.id;
      const i = flatIds.indexOf(a0), j = flatIds.indexOf(c.id), range = flatIds.slice(Math.min(i, j), Math.max(i, j) + 1);
      selAnchor.current = a0; setSel(e.ctrlKey || e.metaKey ? [...new Set([...sel, ...range])] : range); return;
    }
    if (e.ctrlKey || e.metaKey) { selAnchor.current = c.id; setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id])); return; }
    selAnchor.current = c.id; setSel([]); openChat(c.id);
  };
  const saveFolder = async (v: { name: string; color: string; icon: string }) => {
    const fe = folderEdit; setFolderEdit(undefined); if (!fe) return;
    try {
      if (fe.folder) await core.call("updateFolder", { id: fe.folder.id, ...v });
      else { const f = await core.call("createFolder", v); for (const c of fe.thenMoveMany ?? (fe.thenMove ? [fe.thenMove] : [])) await core.call("moveChat", { chatId: c.id, folderId: f.id }); setMoving(undefined); setBulkMove(undefined); }
      await refresh();
    } catch (e: any) { setError(e.message); }
  };
  const deleteFolder = (f: Space) => setConfirmBox({ title: `Delete folder “${f.name}”?`, confirmLabel: "Delete folder", danger: true,
    body: `The ${chats.filter((c) => c.spaceId === f.id).length} chats in it go back to where they were before (their own community, or Personal). No chat or message is deleted.`,
    onConfirm: async () => { try { if (space === f.id) pick(HOME); await core.call("deleteFolder", { id: f.id }); await refresh(); } catch (e: any) { setError(e.message); } } });
  /** Put rail entry `id` before/after `anchor` (ids of all spaces incl. archived ones keep their relative order). */
  const reorder = (id: string, anchor: string, after: boolean) => {
    const rest = spaces.map((s) => s.id).filter((x) => x !== id); const i = rest.indexOf(anchor); if (i < 0 || id === anchor) return;
    rest.splice(after ? i + 1 : i, 0, id);
    setSpaces((ss) => rest.map((x) => ss.find((s) => s.id === x)!).filter(Boolean)); // optimistic
    core.call("setRailOrder", { ids: rest }).then(refresh, (e) => { setError(e.message); refresh(); });
  };
  /** The sibling list an icon moves within: its group's members, or the top-level entries (groups count as one). */
  const siblings = (id: string) => { const g = groupOf(railGroups, id); return g ? railEntries.flatMap((e) => ("group" in e && e.group.id === g.id ? e.members.map((m) => m.id) : [])) : railEntries.map((e) => ("group" in e ? e.group.id : e.space.id)); };
  const nudge = (id: string, dir: -1 | 1) => { if (groupOf(railGroups, id)) { applyRail(nudgeInGroup(railState(), id, dir)); return; } const ids = siblings(id), n = ids[ids.indexOf(id) + dir]; if (n) applyRail(dropEdge(railState(), id, n, dir > 0)); };
  const leaveSpace = (s: Space) => setConfirmBox({ title: `Leave “${s.name}”?`, confirmLabel: "Leave community", danger: true,
    body: "You'll stop receiving messages from this community and its channels disappear from your list. You may need a new invite to join again.",
    onConfirm: () => { if (space === s.id) pick(HOME); act("leaveSpace", { spaceId: s.id }); } });
  const saveAlias = async (c: Chat, name: string | null) => { setRenaming(undefined); try { await core.call("setAlias", { chatId: c.id, name }); await refresh(); } catch (e: any) { setError(e.message); } };
  const accountAction = (kind: "signout" | "signin" | "remove" | "profile", a: Account) => {
    if (kind === "profile") { setProfileFor(a); return; }
    if (kind === "signin") { relinking.current.add(a.id); core.call("signIn", { accountId: a.id }).then(refresh, (e) => { relinking.current.delete(a.id); setError(e.message); }); return; }
    if (kind === "signout") setConfirmBox({ title: `Sign out of ${a.label}?`, confirmLabel: "Sign out",
      body: <>Your chats and messages stay on this device as a read-only archive. Messages people send you while you're signed out won't arrive, so the history will have a gap. You can sign in again at any time.
        {a.state === "connected" && <MediaOffer account={a} note="Photos, voice notes and files you never opened can't be shown in the archive once you are signed out." />}</>,
      onConfirm: () => act("signOut", { accountId: a.id }) });
    else setConfirmBox({ title: a.state === "signed-out" ? `Delete the archive of ${a.label}?` : `Remove ${a.label}?`, confirmLabel: a.state === "signed-out" ? "Delete archive" : "Remove and delete", danger: true,
      body: <>This deletes the account together with all of its chats, messages, contacts and cached media from this device. It can't be undone.
        {a.state === "connected" && <MediaOffer account={a} note="Removing deletes downloaded media too: this only helps if you export the chats first." />}</>,
      onConfirm: () => { if (a.id === chat?.accountId) setChatId(undefined); act("removeAccount", { accountId: a.id, deleteData: true }); } });
  };
  const memberChats = (c?: Chat) => (c?.mergeMembers ? c.mergeMembers.map((id) => chatById.get(id)).filter((x): x is Chat => !!x) : undefined);
  const doMerge = async (ids: string[], name?: string) => {
    try { const row: Chat = await core.call("mergeChats", { chatIds: ids, name: name || undefined }); setMerging(undefined); await refresh(); setSpace(HOME); setChatId(row.id); setNavOpen(false); }
    catch (e: any) { setError(e.message); setMerging(undefined); }
  };
  const unmerge = (c: Chat) => setConfirmBox({ title: `Unmerge “${c.name}”?`, confirmLabel: "Unmerge",
    body: `The ${c.mergeMembers?.length ?? ""} chats become separate chats again, each with its own history. No messages are deleted or copied, and nothing is sent to ${(memberChats(c) ?? []).map((m) => pinfo(m.provider)?.displayName ?? m.provider).join(", ")}.`,
    onConfirm: async () => { const first = c.mergeMembers?.[0]; try { await core.call("unmergeChat", { mergeId: c.id }); await refresh(); if (chatId === c.id) setChatId(first); } catch (e: any) { setError(e.message); } } });
  const placeOf = (c: Chat): PlaceInfo | undefined => {
    const community = c.collapsedFrom ? spaces.find((x) => x.id === c.collapsedFrom) : undefined;
    const caps = community ? capsFor(community) : undefined;
    return { community, folder: c.spaceId ? spaces.find((x) => x.id === c.spaceId) : undefined, original: c.networkSpaceId ? spaces.find((x) => x.id === c.networkSpaceId) : undefined,
      onMove: () => setMoving(c), onReset: () => moveChat(c, null),
      onCommunityInfo: () => community && setSpaceInfo(community), onCommunityRename: () => community && setRenamingSpace({ id: community.id, accountId: community.accountId, provider: community.provider, kind: "group", name: community.name, originalName: community.originalName }),
      onCommunityMute: () => community && setFlag(community.id, { muted: !community.muted }), onCommunityLeave: community && caps?.leaveSpace ? () => leaveSpace(community) : undefined };
  };
  const spaceName = space === HOME ? "Personal" : spaces.find((s) => s.id === space)?.name;
  const hasAccount = accounts.length > 0, syncRecv = useSyncReceiving();

  const spacePill = (s: Space) => (
    <Pill id={s.id} draggable drop={dropOver === s.id} setOver={setDropOver} onDropChat={(raw) => moveMany(dragChats(raw), s.id)}
      onDropSpace={(from, zone) => dropOnRail(from, s.id, zone)}
      onContext={(e) => setRailMenu({ x: e.clientX, y: e.clientY, space: s })} key={s.id} cls={[s.archived ? "archivedpill" : "", emptyViews.has(s.id) ? "nomatch" : ""].filter(Boolean).join(" ") || undefined} active={space === s.id} title={s.local ? `${s.name} · folder` : railDot(s) ? `${s.name} · ${s.provider}` : `${s.name} · mixed`} badge={unreadIn(s.id)} badgeDot={dotIn(s.id)} dot={s.local ? undefined : railDot(s)} onClick={() => pick(s.id)}>
      <SpaceIcon space={s} size={48} />
    </Pill>);
  // ---- chat list: stable row api (members are always the latest closures), touch selection mode, windowing
  const coarse = useMemo(() => isCoarse(), []);
  const [touchSel, setTouchSel] = useState(false); // selection started by a long press: taps toggle chats until it is cleared
  useEffect(() => { if (!sel.length) setTouchSel(false); }, [sel]);
  const selSet = useMemo(() => new Set(sel), [sel]);
  const selMode = touchSel && sel.length > 0;
  const lastLong = useRef(0), lpShared = useRef<LPState>({ x: 0, y: 0, fired: false });
  const rowApi = useRef({} as RowApi).current;
  Object.assign(rowApi, {
    click: (e: React.MouseEvent, c: Chat) => { if (touchSel && sel.length && !e.shiftKey) { selAnchor.current = c.id; setSel((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id])); return; } clickRow(e, c); },
    context: (x: number, y: number, c: Chat) => { if (Date.now() - lastLong.current < 1200) return; if (sel.length > 1 && sel.includes(c.id)) setSelMenu({ x, y }); else setMenuFor(c.id); },
    more: (e: React.MouseEvent, c: Chat) => { if (sel.length > 1 && sel.includes(c.id)) setSelMenu({ x: e.clientX, y: e.clientY }); else setMenuFor(menuFor === c.id ? null : c.id); },
    longPress: (c: Chat) => { lastLong.current = Date.now(); setMenuFor(null); setTouchSel(true); selAnchor.current = c.id; setSel((s) => (s.includes(c.id) ? s : [...s, c.id])); },
    dragStart: (e: React.DragEvent, c: Chat) => { const ids = sel.includes(c.id) && sel.length > 1 ? sel : [c.id]; e.dataTransfer.setData(CHAT_DRAG, ids.length > 1 ? JSON.stringify(ids) : c.id); e.dataTransfer.effectAllowed = "move"; },
    dragOver: (e: React.DragEvent, c: Chat) => { if (!filter && e.dataTransfer.types.includes(CHAT_DRAG) && (c.categoryId || !c.category)) e.preventDefault(); },
    drop: (e: React.DragEvent, c: Chat) => { const raw = e.dataTransfer.getData(CHAT_DRAG); if (!filter && raw && (c.categoryId || !c.category)) { e.preventDefault(); e.stopPropagation(); dropChatsOnCat(raw, c.categoryId ?? "none"); } },
    closeMenu: () => setMenuFor(null),
    togglePin: (c: Chat) => togglePin(c.id), toggleMute: (c: Chat) => toggleMute(c.id), markRead: (c: Chat) => mr.markChat(c), markUnread: (c: Chat) => setFlag(c.id, { unreadMark: true }), archive: (c: Chat) => setFlag(c.id, { archived: !c.archived }),
    rename: (c: Chat) => setRenaming(c), move: (c: Chat) => setMoving(c), category: (c: Chat) => setCatPick([c]), merge: (c: Chat) => setMerging(c), unmerge: (c: Chat) => unmerge(c),
  } satisfies RowApi);
  type Item = { k: "row"; c: Chat } | { k: "head"; g: CatGroup } | { k: "empty"; id: string };
  const items = useMemo<Item[]>(() => groups.flatMap((g): Item[] => g.name === undefined ? g.chats.map((c) => ({ k: "row", c })) : [{ k: "head", g },
    ...(collapsedCats.has(g.key) ? [] : [...(g.id && !g.chats.length ? [{ k: "empty", id: g.id } as Item] : []), ...g.chats.map((c): Item => ({ k: "row", c }))])]), [groups, collapsedCats]);
  const focusIndex = useMemo(() => items.findIndex((it) => it.k === "row" && it.c.id === chatId), [items, chatId]);
  const renderItem = (it: Item) => {
    if (it.k === "row") { const c = it.c, origin = spaceById.get(c.collapsedFrom ?? c.networkSpaceId ?? "");
      return <ChatRow c={c} api={rowApi} active={c.id === chatId} menuOpen={menuFor === c.id} selected={selSet.has(c.id)} selMode={selMode} muted={muted.has(c.id)} pinned={pinned.has(c.id)}
        noOffline={c.offline ? (c.mergeMembers ? c.mergeMembers.reduce((t, id) => t + (offlineMedia[id] ?? 0), 0) : offlineMedia[c.id] ?? 0) : 0} origin={origin}
        memberProviders={c.mergeMembers ? dotOrder(c, memberChats(c)) : undefined} coarse={coarse} online={isOnline(c, memberChats(c))} />; }
    if (it.k === "empty") return <li className="catempty" data-catempty={it.id}>Drop chats here</li>;
    const g = it.g, closed = collapsedCats.has(g.key), live = g.chats.filter((c) => !quiet.has(c.id) && !!c.unread), total = live.reduce((n, c) => n + (c.unread ?? 0), 0);
    const openMenu = (x: number, y: number) => setCatMenu({ x, y, g });
    const lp = lpHandlers(lpShared.current, (x, y) => { lastLong.current = Date.now(); openMenu(x, y); });
    return (
      <li className={"cathead" + (g.id ? " usercat" : "") + (catOver?.key === g.key ? " over-" + catOver.zone : "")} data-cat={g.name} data-catid={g.id} role="button" tabIndex={0} aria-expanded={!closed}
        style={g.color ? { "--cc": g.color } as React.CSSProperties : undefined} onClick={() => { if (lp.swallow()) return; toggleCat(g.key); }}
        onTouchStart={lp.onTouchStart} onTouchMove={lp.onTouchMove} onTouchEnd={lp.onTouchEnd} onTouchCancel={lp.onTouchCancel}
        onKeyDown={(e) => { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleCat(g.key); } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left + 24, r.bottom); } }}
        onContextMenu={(e) => { e.preventDefault(); if (Date.now() - lastLong.current < 1200) return; openMenu(e.clientX, e.clientY); }}
        draggable={!!g.id && !coarse} onDragStart={g.id ? (e) => { e.dataTransfer.setData(CAT_DRAG, g.id!); e.dataTransfer.effectAllowed = "move"; } : undefined}
        onDragOver={g.id ? (e) => { const t = e.dataTransfer.types; if (t.includes(CHAT_DRAG)) { e.preventDefault(); setCatOver({ key: g.key, zone: "in" }); } else if (t.includes(CAT_DRAG)) { e.preventDefault(); setCatOver({ key: g.key, zone: catZone(e) }); } } : undefined}
        onDragLeave={g.id ? () => setCatOver(undefined) : undefined}
        onDrop={g.id ? (e) => { setCatOver(undefined); const c = e.dataTransfer.getData(CHAT_DRAG), k = e.dataTransfer.getData(CAT_DRAG);
          if (c) { e.preventDefault(); e.stopPropagation(); dropChatsOnCat(c, g.id!); } else if (k) { e.preventDefault(); e.stopPropagation(); dropCatBefore(k, g.id!, catZone(e) === "after"); } } : undefined}>
        {closed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{g.id && <i className="catdot" style={{ background: g.color ?? "var(--muted)" }} />}<span className="catname">{g.name}</span>
        <small className="catcount" title={`${g.chats.length} chat${g.chats.length === 1 ? "" : "s"}`}>{g.chats.length}</small>
        {live.length > 0 && <b className="unread">{total || "•"}</b>}
        <button className="icon more" aria-label="Category options" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenu(r.left, r.bottom); }}><MoreHorizontal size={14} /></button>
      </li>);
  };
  if (fatal) return <ConnectScreen message={fatal} />;
  return (
    <div className={"app" + (panel && chat ? " withinfo" : "") + (chat && !navOpen ? " inchat" : "")}>
      <nav className="rail">
        <Pill id="home" drop={dropOver === "home"} onDropChat={(raw) => moveMany(dragChats(raw), "personal")} setOver={setDropOver}
          onContext={(e) => setRailMenu({ x: e.clientX, y: e.clientY, space: "home" })} cls={emptyViews.has(HOME) ? "nomatch" : undefined} active={space === HOME} title="Personal chats" badge={unreadIn(HOME)} badgeDot={dotIn(HOME)} onClick={() => pick(HOME)}><ChatIcon /></Pill>
        <div className="sep" />
        {railEntries.map((e) => {
          if ("space" in e) return spacePill(e.space);
          const g = e.group, open = openGroups.has(g.id), unread = e.members.reduce((n, m) => n + unreadIn(m.id), 0), dot = unread === 0 && e.members.some((m) => dotIn(m.id));
          return (
            <div key={g.id} className={"railgroup" + (open ? " open" : "")} data-group={g.id} style={{ "--gc": g.color ?? "var(--accent)" } as React.CSSProperties}>
              <Pill id={g.id} draggable cls="grouphead" expanded={open} drop={dropOver === g.id} setOver={setDropOver}
                onDropChat={(raw) => { const cs = dragChats(raw); if (cs.length) setBulkMove({ chats: cs, only: e.members.map((m) => m.id) }); }}
                onDropSpace={(from, zone) => dropOnRail(from, g.id, zone)}
                onContext={(ev) => setGroupMenu({ x: ev.clientX, y: ev.clientY, group: g })} active={!open && e.members.some((m) => m.id === space)}
                title={`${g.name} · group of ${e.members.length}`} badge={unread} badgeDot={dot} onClick={() => toggleGroup(g.id)}><GroupTile members={e.members} color={g.color} open={open} /></Pill>
              {open && <div className="gmembers">{e.members.map((m) => spacePill(m))}</div>}
            </div>);
        })}
        <div className="sep" />
        <Pill title="New folder" cls="add" onClick={() => setFolderEdit({})}><FolderPlus size={21} /></Pill>
        <Pill title="Add a community or account" cls="add" onClick={() => setDialog("addmenu")}><Plus size={22} /></Pill>
        <div className="grow" />
        <div className="railbottom">
          {(archivedSpaces.length > 0 || archivedChatTotal > 0) && <Pill onContext={(e) => setArchiveMenu({ x: e.clientX, y: e.clientY })} title={(showArchived ? "Hide archived chats and communities" : `Show archived (${archivedSpaces.length + archivedChatTotal})`) + (archivedUnread ? ` · ${archivedUnread} unread` : "")} badge={archivedUnread} cls={"gear" + (showArchived ? " archiveon" : "")} active={showArchived} onClick={() => setShowArchived(!showArchived)}><Archive size={20} /></Pill>}
          <Pill title="Settings" cls="gear" onClick={() => setSettingsOpen(true)}><Gear /></Pill>
        </div>
      </nav>

      <aside className={"chats" + (navOpen ? " open" : "")}>
        {gsearch && <Suspense fallback={null}><GlobalSearch key={gsearch.n} initial={gsearch.q} providers={providers} accounts={accounts} chats={listChats} current={chat ? { id: chat.id, name: chat.name } : undefined} onOpen={openHit} onOpenChat={(id) => { openChat(id); }} onClose={() => setGsearch(undefined)} /></Suspense>}
        {!gsearch && <>
        <header>
          <span>{spaceName}</span>
          <span className="hbtns">
            {!gsearch && <button className="icon" title="New category" aria-label="New category" data-act="new-category" onClick={() => newCategory()}><ListPlus size={17} /></button>}
            {hasAccount && <button className="icon" title="New chat" onClick={() => setDialog("newchat")}><SquarePen size={17} /></button>}
            <button className={"icon" + (gsearch ? " on" : "")} title="Search all messages (Ctrl+Shift+F)" aria-label="Search all messages" data-act="gsearch" onClick={() => setGsearch((g) => (g ? undefined : { q: "", n: 1 }))}><Search size={17} /></button>
          </span>
        </header>
        <div className="chatsearch"><Search size={14} /><input placeholder="Find a chat  (Ctrl+K)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && <button className="icon" onClick={() => setFilter("")} aria-label="Clear"><X size={14} /></button>}</div>
        {!gsearch && <ChatFilterBar value={filters} onChange={setFilters} accounts={accounts} providers={providers} />}
        {sel.length > 0 && (() => { const cs = selChats(), allArch = cs.every((c) => c.archived), allMuted = cs.every((c) => c.muted); return (
          <div className="selbar" role="toolbar" aria-label="Selected chats" data-sel={sel.length}>
            <b>{sel.length} selected</b>
            <button data-act="sel-move" onClick={() => setBulkMove({ chats: cs })}><FolderInput size={14} /> Move to folder…</button>
            {oneView(cs) && <button data-act="sel-category" onClick={() => setCatPick(cs)}><Tag size={14} /> Move to category…</button>}
            <button data-act="sel-archive" onClick={() => bulkFlags(cs, { archived: !allArch }, allArch ? "Unarchiving" : "Archiving", `${allArch ? "Unarchived" : "Archived"} ${cs.length} chats`)}>{allArch ? <><ArchiveRestore size={14} /> Unarchive</> : <><Archive size={14} /> Archive</>}</button>
            <button data-act="sel-mute" onClick={() => bulkFlags(cs, { muted: !allMuted }, allMuted ? "Unmuting" : "Muting", `${allMuted ? "Unmuted" : "Muted"} ${cs.length} chats`)}>{allMuted ? <><Bell size={14} /> Unmute</> : <><BellOff size={14} /> Mute</>}</button>
            {cs.some((c) => c.unread) && <button data-act="sel-read" onClick={() => bulkRead(cs)}><MarkRead size={14} /> Mark as read</button>}
            <button data-act="sel-clear" className="icon" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSel([])}><X size={14} /></button>
          </div>); })()}
        <VList items={items} sizeOf={(it, m) => (it.k === "row" ? m.row : it.k === "head" ? m.head : m.empty)} itemKey={(it) => (it.k === "row" ? it.c.id : it.k === "head" ? "cat:" + it.g.key : "empty:" + it.id)}
          renderItem={renderItem} focusKey={chatId} focusIndex={focusIndex}>
          {!listReady && !visible.length && <li className="empty loadingchats" data-loading="chats" role="status" aria-live="polite"><div className="skelrows" aria-hidden>{[0, 1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="skelrow" style={{ opacity: 1 - i * 0.11 }}><span className="skelav" /><span className="skeltext"><i /><i /></span></div>)}</div><p className="hint"><span className="spin" /> {slowStart ? "Still starting…" : "Loading your chats…"}</p>{slowStart && <p className="hint" data-loading="slow">UniChat is opening a large archive. This can take a minute on first start; your chats and accounts are safe.</p>}</li>}
          {listReady && !visible.length && (!viewCats.length || (nFilters > 0 && !filter)) && (
            <li className="empty">{nFilters > 0 && !filter && hasAccount ? <><p data-empty="filters">No chats match the filters</p><button className="secondary" data-act="clear-filters" onClick={() => setFilters(normFilters({}))}>Clear filters</button></> : !hasAccount && syncRecv.accounts ? <p data-empty="receiving"><span className="spin" /> Receiving your accounts from your other device…</p> : !hasAccount ? <><p>No accounts yet</p><button className="primary inline" onClick={() => setDialog("add")}>Add your first account</button><button className="secondary inline" data-act="link-other-device" onClick={() => { settingsNav.section = "sync"; setSettingsOpen(true); }}>Link to another device</button></>
              : space === HOME ? <><p>No chats yet</p>
                {accounts.some((a) => capsOf(a, providers)?.sync) && <p className="hint">Some accounts only show chats once your phone has shared them.</p>}
                {accounts.filter((a) => capsOf(a, providers)?.sync).map((a) => <button key={a.id} className="secondary" onClick={() => act("syncAccount", { accountId: a.id })}>Sync contacts from {a.label}</button>)}
                <button className="secondary" onClick={() => setDialog("newchat")}>Start a chat</button></> : <><p>Nothing here yet</p><p className="hint">Right-click a chat and choose “Move to folder…”, or drag a chat onto this icon.</p></>}</li>)}
        </VList>
        <footer onClick={() => setSettingsOpen(true)} title="Manage accounts">
          <StatusDots accounts={accounts} loading={!listReady} onOpen={(a) => { focusAccount.id = a.id; setSettingsOpen(true); }} />
        </footer>
        </>}
      </aside>

      <main>
        <header>
          <button className="burger" onClick={() => setNavOpen(true)} aria-label="Chats"><ChevronLeft size={26} /></button>
          {chat ? <button className="titlebtn" onClick={() => setInfo(!info)} title="Chat info">
            {chat.kind === "channel" ? <span className="hash"><Hash size={18} /></span> : <Avatar name={chat.name} url={chat.avatarUrl} of={{ kind: "chat", id: chat.id }} size={28} online={isOnline(chat, memberChats(chat))} />}<span>{chat.name}</span></button> : <span>UniChat</span>}
          {chat && <DisappearBadge chat={chat} />}
          {chat && chat.kind === "dm" && (() => { const pr = chat.mergeMembers ? (memberChats(chat) ?? []).find((m) => m.online) ?? (memberChats(chat) ?? []).filter((m) => m.lastSeen).sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""))[0] : chat, t = pr ? presenceText(pr) : ""; return t ? <small className="hpresence" data-presence={pr!.online ? "online" : "seen"}>{t}</small> : null; })()}
          {chat && <span className="hright">
            <button className={"icon" + (panel === "search" ? " on" : "")} title="Search in chat (Ctrl+F)" onClick={() => setPanel(panel === "search" ? undefined : "search")}><Search size={17} /></button>
            <em className="prov">{chat.mergeMembers ? <><ProviderStack providers={(memberChats(chat) ?? []).map((m) => m.provider)} size={16} /><span className="pnames">{[...new Set((memberChats(chat) ?? []).map((m) => pinfo(m.provider)?.displayName ?? m.provider))].join(" + ")}</span></> : <><ProviderIcon provider={chat.provider} size={16} />{pinfo(chat.provider)?.displayName ?? (chat.provider === "mesh" ? "Mesh" : chat.provider)}</>}{capsFor(chat)?.e2ee && <><span> · </span><Lock size={11} className="inl" /></>}</em>
            <button className={"icon" + (info ? " on" : "")} title="Chat info" onClick={() => setInfo(!info)}><Info size={18} /></button>
          </span>}
        </header>
        {notice && <div className="notice" role="status" onClick={() => setNotice(undefined)}>{notice}</div>}
        {conn === "down" && <div className="error reconnect" role="alert"><span className="spinner" aria-hidden /> Reconnecting to the backend…</div>}
        {error && <div className="error" onClick={() => setError(undefined)}>{error} <small>(click to dismiss)</small></div>}
        {chat
          ? <Conversation onPerson={(senderId, name) => setPerson({ chat, senderId, name })} key={chat.id} chat={chat} messages={msgs[chat.id] ?? []} typing={typing[chat.id] ?? []} caps={chat.offline ? undefined : capsFor(chat)} settings={settings} members={memberChats(chat)} providers={providers} accounts={accounts} onSignIn={(aid) => { const a = accounts.find((x) => x.id === (aid ?? chat.accountId)); if (a) accountAction("signin", a); }}
              chats={listChats} jumpRef={jumpRef} unreadAtOpen={openedUnread[chat.id] ?? 0} loaded={msgs[chat.id] !== undefined} loadState={hist[chat.id]} loadSource={sourceFor(chat.id)} loadNote={loadNote[chat.id]} onRetry={() => loadChat(chat.id)} onInfo={() => setInfo(true)} onOpenChat={openChat} hasMore={!!more[chat.id]} onLoadOlder={(n) => loadOlder(chat.id, n)} onRemove={(id) => setMsgs((s) => ({ ...s, [chat.id]: (s[chat.id] ?? []).filter((x) => x.id !== id) }))}
              onSent={(m, r) => setMsgs((s) => { const k = resolvedRef.current.get(chat.id) ?? chat.id; return { ...s, [k]: upsert(s[k] ?? [], m, r) }; })} onRequest={(accept) => requestAnswer(chat, accept)} />
          : <div className="placeholder" data-loading={!listReady ? "main" : undefined}>{!listReady ? <span className="hint"><span className="spin" /> {slowStart ? "Still starting…" : "Loading…"}</span> : hasAccount ? "Select a chat" : "Add an account to get started"}</div>}
      </main>

      {panel === "search" && chat && <Suspense fallback={null}><SearchPanel key={chat.id} chat={chat} members={memberChats(chat)} providers={providers} accounts={accounts} onJump={(id, cid) => jumpRef.current?.(id, cid)} onClose={() => setPanel(undefined)} /></Suspense>}
      {info && chat && <Suspense fallback={null}><ContactPanel place={placeOf(chat)} merge={chat.mergeMembers ? { members: memberChats(chat) ?? [], providers, accounts, onUnmerge: () => unmerge(chat), onMergeMore: () => setMerging(chat),
          onPrimary: (cid) => act("setMergePrimary", { mergeId: chat.id, chatId: cid }), onRemove: (cid) => act("removeMergeMember", { mergeId: chat.id, chatId: cid }) } : undefined}
        onMerge={chat.kind === "dm" && !chat.mergeMembers && chat.provider !== "mesh" ? () => setMerging(chat) : undefined} onPerson={(c) => setPerson({ chat, senderId: c.id, name: c.name })} reloadKey={tick} chat={chat} caps={capsFor(chat)} messages={msgs[chat.id] ?? []} muted={muted.has(chat.id)} providerName={pinfo(chat.provider)?.displayName ?? chat.provider}
        onRename={() => setRenaming(chat)} onLeave={() => leave(chat)} onBlock={() => block(chat)} onAddMembers={() => setAddingMembers(chat)} onRemoveMember={(m) => removeMember(chat, m)} onRenameNetwork={() => setRenamingNet(chat)} onMute={() => toggleMute(chat.id)} onSearch={() => setPanel("search")} onClose={() => setInfo(false)} onImage={setLightbox} onJump={(id, cid) => jumpRef.current?.(id, cid)} /></Suspense>}

      {settingsOpen && <Suspense fallback={null}><SettingsPage chats={chats} onAccountAction={accountAction} onLogin={async (id) => { const pend: LoginPrompt[] = (await core.call("pendingLogins").catch(() => [])) ?? []; const p = pend.find((x) => x.accountId === id); if (p) { setSettingsOpen(false); setLogin(p); } else setError("No login is waiting yet. The provider may still be connecting; try again in a few seconds."); }} accounts={accounts} providers={providers} settings={settings} onChange={setSettings} loading={!listReady} onClose={() => setSettingsOpen(false)} onAdd={() => setDialog("add")} onMarkAllRead={(scope, label) => { setSettingsOpen(false); mr.markAll(scope, label); }} /></Suspense>}
      <MarkReadToast prog={mr.prog} onCancel={mr.cancel} onDismiss={mr.dismiss} />
      <UpdateBanner onOpen={() => { setSettingsOpen(true); setTimeout(() => dispatchEvent(new Event("unichat-open-updates")), 0); }} />
      {watchers && <Suspense fallback={null}><Watchers /></Suspense>}
      {login?.kind === "captcha" && <CaptchaModal key={login.promptId} prompt={login} onClose={() => setLogin(undefined)} />}
      {login && login.kind !== "captcha" && <LoginModal prompt={login} onCancel={() => {
        const id = login.accountId; setLogin(undefined);
        // Closing the linking dialog of a brand-new account cancels it (no half-created account is left behind).
        if (fresh.current.delete(id)) core.call("removeAccount", { accountId: id }).then(refresh, () => refresh());
        else if (relinking.current.delete(id)) core.call("cancelSignIn", { accountId: id }).then(refresh, () => refresh());
      }} />}
      {dialog === "add" && <AddAccount providers={providers} onClose={() => setDialog(undefined)}
        onAdd={async (p) => { setDialog(undefined); try { const a = await core.call("addAccount", { provider: p }); if (a?.id) fresh.current.add(a.id); await refresh(); } catch (e: any) { setError(e.message); } }} />}
      {dialog === "addmenu" && <AddMenuModal providers={providers} accounts={accounts} onClose={() => setDialog(undefined)} onPick={(w) => setDialog(w)} />}
      {(dialog === "createspace" || dialog === "joinspace") && <CommunityModal mode={dialog === "createspace" ? "create" : "join"} providers={providers} accounts={accounts} onClose={() => setDialog(undefined)}
        onDone={async (sp) => { setDialog(undefined); await refresh(); pick(sp.id); }} />}
      {dialog === "newchat" && <NewChatModal providers={providers} accounts={accounts} chats={chats} onClose={() => setDialog(undefined)}
        onDone={async (c) => { setDialog(undefined); await refresh(); openChat(c.id); }} />}
      {confirmBox && <ConfirmModal {...confirmBox} onClose={() => setConfirmBox(undefined)} />}
      {archiveMenu && (
        <PopMenu x={archiveMenu.x} y={archiveMenu.y} title="Archive" onClose={() => setArchiveMenu(undefined)}>
          <button data-act="archive-mark-read" disabled={!archivedUnreadAll} onClick={async () => { setArchiveMenu(undefined); await markArchivedRead(); }}><MarkRead size={15} /> Mark all archived as read{archivedUnreadAll ? ` (${archivedUnreadAll})` : ""}</button>
          <button onClick={() => { setShowArchived(!showArchived); setArchiveMenu(undefined); }}><Archive size={15} /> {showArchived ? "Hide archived" : "Show archived"}</button>
        </PopMenu>)}
      {railMenu && (() => { const sp = railMenu.space; const isHome = sp === "home"; const caps = isHome ? undefined : capsFor(sp);
        return (
          <PopMenu x={railMenu.x} y={railMenu.y} title={isHome ? "Personal chats" : sp.name} onClose={() => setRailMenu(undefined)}>
            <button onClick={() => mr.markAll(isHome ? "personal" : sp.id, isHome ? "Personal chats" : sp.name)}><MarkRead size={15} /> Mark all as read</button>
            <button data-act="new-category" onClick={() => { const v = isHome ? PERSONAL_VIEW : sp.id; setCatEdit({ view: v, where: isHome ? "Personal" : sp.name }); }}><ListPlus size={15} /> New category…</button>
            {!isHome && (() => { const ids = siblings(sp.id), i = ids.indexOf(sp.id), ing = !!groupOf(railGroups, sp.id); return <>
              {i > 0 && <button onClick={() => nudge(sp.id, -1)}><ArrowUp size={15} /> Move up</button>}
              {i >= 0 && i < ids.length - 1 && <button onClick={() => nudge(sp.id, 1)}><ArrowDown size={15} /> Move down</button>}
              <button onClick={() => setAddGroup(sp)}><Folder size={15} /> {ing ? "Move to another group…" : "Add to group…"}</button>
              {ing && <button onClick={() => applyRail(removeFromGroup(railState(), sp.id))}><FolderMinus size={15} /> Remove from group</button>}</>; })()}
            {!isHome && sp.local && <>
              <button onClick={() => setFlag(sp.id, { muted: !sp.muted })}>{sp.muted ? <><Bell size={15} /> Unmute folder</> : <><BellOff size={15} /> Mute folder</>}</button>
              <button onClick={() => { setFlag(sp.id, { archived: true }); if (space === sp.id) pick(HOME); }}><Archive size={15} /> Archive folder</button>
              <button onClick={() => setFolderEdit({ folder: sp })}><Pencil size={15} /> Edit folder…</button>
              <div className="sepline" /><button className="dangeritem" onClick={() => deleteFolder(sp)}><Trash2 size={15} /> Delete folder</button></>}
            {!isHome && !sp.local && <>
              <button onClick={() => setFlag(sp.id, { muted: !sp.muted })}>{sp.muted ? <><Bell size={15} /> Unmute community</> : <><BellOff size={15} /> Mute community</>}</button>
              <button onClick={() => { setFlag(sp.id, { archived: true }); if (space === sp.id) pick(HOME); }}><Archive size={15} /> Archive community</button>
              <button onClick={() => setRenamingSpace({ id: sp.id, accountId: sp.accountId, provider: sp.provider, kind: "group", name: sp.name, originalName: sp.originalName })}><Pencil size={15} /> Rename</button>
              <button onClick={() => setSpaceInfo(sp)}><InfoIcon size={15} /> Community info</button>
              {caps?.leaveSpace && <><div className="sepline" /><button className="dangeritem" onClick={() => leaveSpace(sp)}><LogOut size={15} /> Leave community</button></>}</>}
          </PopMenu>); })()}
      {catMenu && (() => { const g = catMenu.g, ids = viewCats.map((c) => c.id), i = g.id ? ids.indexOf(g.id) : -1, closed = collapsedCats.has(g.key), cat = viewCats.find((c) => c.id === g.id); return (
        <PopMenu x={catMenu.x} y={catMenu.y} title={g.name} onClose={() => setCatMenu(undefined)}>
          {cat && <button data-act="cat-rename" onClick={() => setCatEdit({ cat, view, where: viewName(view) })}><Pencil size={15} /> Rename…</button>}
          {cat && <button data-act="cat-colour" onClick={() => setCatEdit({ cat, view, where: viewName(view), focus: "colour" })}><Palette size={15} /> Colour…</button>}
          <button data-act="cat-toggle" onClick={() => toggleCat(g.key)}>{closed ? <><ChevronDown size={15} /> Expand</> : <><ChevronRight size={15} /> Collapse</>}</button>
          {g.chats.some((c) => c.unread) && <button data-act="cat-read" onClick={() => bulkRead(g.chats)}><MarkRead size={15} /> Mark category as read</button>}
          {cat && i > 0 && <button data-act="cat-up" onClick={() => nudgeCat(cat.id, -1)}><ArrowUp size={15} /> Move up</button>}
          {cat && i >= 0 && i < ids.length - 1 && <button data-act="cat-down" onClick={() => nudgeCat(cat.id, 1)}><ArrowDown size={15} /> Move down</button>}
          {cat && <><div className="sepline" /><button data-act="cat-delete" className="dangeritem" onClick={() => deleteCategory(g)}><Trash2 size={15} /> Delete category</button></>}
        </PopMenu>); })()}
      {catPick && <CategoryPickModal chats={catPick} cats={cats[viewOfChat(catPick[0])] ?? []} onClose={() => setCatPick(undefined)} onPick={(t) => setCategoryFor(catPick, t)} onNew={() => newCategory(catPick)} />}
      {catEdit && <CategoryModal category={catEdit.cat} where={catEdit.where} focus={catEdit.focus} onClose={() => setCatEdit(undefined)} onSave={saveCategory} />}
      {groupMenu && (() => { const g = groupMenu.group, ids = siblings(g.id), i = ids.indexOf(g.id), open = openGroups.has(g.id); return (
        <PopMenu x={groupMenu.x} y={groupMenu.y} title={g.name} onClose={() => setGroupMenu(undefined)}>
          <button onClick={() => setGroupEdit(g)}><Pencil size={15} /> Rename / Colour group…</button>
          <button onClick={() => toggleGroup(g.id)}>{open ? <><ChevronRight size={15} /> Collapse group</> : <><ChevronDown size={15} /> Expand group</>}</button>
          {i > 0 && <button onClick={() => nudge(g.id, -1)}><ArrowUp size={15} /> Move up</button>}
          {i >= 0 && i < ids.length - 1 && <button onClick={() => nudge(g.id, 1)}><ArrowDown size={15} /> Move down</button>}
          <div className="sepline" /><button className="dangeritem" onClick={() => applyRail(ungroup(railState(), g.id))}><Unlink size={15} /> Ungroup</button>
        </PopMenu>); })()}
      {groupEdit && <GroupModal group={groupEdit} onClose={() => setGroupEdit(undefined)} onSave={(v) => { saveGroup(groupEdit, v); setGroupEdit(undefined); }} />}
      {addGroup && <AddToGroupModal space={addGroup} current={groupOf(railGroups, addGroup.id)?.id} groups={railGroups.filter((g) => g.members.some((m) => railSpaces.some((x) => x.id === m)))}
        others={visibleSpaces.filter((x) => x.id !== addGroup.id && !groupOf(railGroups, x.id))} onClose={() => setAddGroup(undefined)}
        onPick={(t) => { const sp = addGroup; setAddGroup(undefined); applyRail(t.startsWith("group:") ? addToGroup(railState(), sp.id, t) : dropOnto(railState(), sp.id, t, newGroupId(), GROUP_COLORS[railGroups.length % GROUP_COLORS.length])); }} />}
      {selMenu && (() => { const cs = selChats(), allArch = cs.every((c) => c.archived), allMuted = cs.every((c) => c.muted); return (
        <PopMenu x={selMenu.x} y={selMenu.y} title={`${cs.length} chats`} onClose={() => setSelMenu(undefined)}>
          <button onClick={() => setBulkMove({ chats: cs })}><FolderInput size={15} /> Move {cs.length} chats to folder…</button>
          {oneView(cs) && <button data-act="sel-category" onClick={() => setCatPick(cs)}><Tag size={15} /> Move {cs.length} chats to category…</button>}
          <button onClick={() => bulkFlags(cs, { archived: !allArch }, allArch ? "Unarchiving" : "Archiving", `${allArch ? "Unarchived" : "Archived"} ${cs.length} chats`)}>{allArch ? <><ArchiveRestore size={15} /> Unarchive</> : <><Archive size={15} /> Archive</>}</button>
          <button onClick={() => bulkFlags(cs, { muted: !allMuted }, allMuted ? "Unmuting" : "Muting", `${allMuted ? "Unmuted" : "Muted"} ${cs.length} chats`)}>{allMuted ? <><Bell size={15} /> Unmute</> : <><BellOff size={15} /> Mute</>}</button>
          {cs.some((c) => c.unread) && <button onClick={() => bulkRead(cs)}><MarkRead size={15} /> Mark as read</button>}
          <button onClick={() => setSel([])}><X size={15} /> Clear selection</button>
        </PopMenu>); })()}
      {bulkMove && <MoveModal chat={{ ...bulkMove.chats[0], name: `${bulkMove.chats.length} chats`, spaceId: new Set(bulkMove.chats.map((c) => c.spaceId)).size === 1 ? bulkMove.chats[0].spaceId : "mixed", folderId: bulkMove.chats.some((c) => c.folderId) ? "x" : undefined }}
        count={bulkMove.chats.length} groupOnly={!!bulkMove.only} spaces={bulkMove.only ? railSpaces.filter((x) => bulkMove.only!.includes(x.id)) : railSpaces} onClose={() => setBulkMove(undefined)}
        onMove={(f) => moveMany(bulkMove.chats, f)} onNew={() => setFolderEdit({ thenMoveMany: bulkMove.chats })} />}
      {profileFor && pinfo(profileFor.provider) && <ProfileModal account={profileFor} provider={pinfo(profileFor.provider)!} onClose={() => setProfileFor(undefined)} />}
      {person && <PersonModal chat={person.chat} senderId={person.senderId} name={person.name} providerName={pinfo(person.chat.provider)?.displayName ?? person.chat.provider}
        canStartChat={!!capsFor(person.chat)?.startChat && !person.chat.offline}
        existingDm={chats.find((c) => c.kind === "dm" && c.accountId === person.chat.accountId && c.id === `${person.chat.accountId}:${person.senderId}`)}
        onOpenChat={openChat} onClose={() => setPerson(undefined)} onNamed={() => { setMsgs({}); setHistTick((t) => t + 1); if (openRef.current) loadChat(openRef.current, true); void refresh(); }} />}
      {spaceInfo && <SpaceInfoModal space={spaceInfo} channels={chats.filter((c) => c.spaceId === spaceInfo.id || c.collapsedFrom === spaceInfo.id)} providerName={railDot(spaceInfo) ? pinfo(spaceInfo.provider)?.displayName ?? spaceInfo.provider : undefined} onClose={() => setSpaceInfo(undefined)} onOpen={(c) => openChat(c.id)} />}
      {renamingSpace && <RenameModal title="Rename community" chat={renamingSpace} onClose={() => setRenamingSpace(undefined)} onSave={(n) => saveAlias(renamingSpace, n).then(() => setRenamingSpace(undefined))} />}
      {moving && <MoveModal chat={moving} spaces={railSpaces} onClose={() => setMoving(undefined)} onMove={(f) => moveChat(moving, f)} onNew={() => setFolderEdit({ thenMove: moving })} />}
      {folderEdit && <FolderModal folder={folderEdit.folder} onClose={() => setFolderEdit(undefined)} onSave={saveFolder} />}
      {dialog === "archived" && <ArchivedSpacesModal spaces={archivedSpaces} onClose={() => setDialog(undefined)} onOpen={(s) => pick(s.id)} onRestore={(s) => setFlag(s.id, { archived: false })} />}
      {renaming && <RenameModal chat={renaming} onClose={() => setRenaming(undefined)} onSave={(n) => saveAlias(renaming, n)} />}
      {addingMembers && <AddMembersModal chat={addingMembers} onClose={() => setAddingMembers(undefined)} onAdd={async (h) => { await core.call("addMembers", { chatId: addingMembers.id, handles: h }); setAddingMembers(undefined); await refresh(); }} />}
      {renamingNet && <RenameModal network chat={renamingNet} onClose={() => setRenamingNet(undefined)} onSave={async (n) => { const c = renamingNet; setRenamingNet(undefined); if (n) await act("renameChat", { chatId: c.id, name: n }); }} />}
      {merging && <MergeModal source={merging} chats={listChats} providers={providers} accounts={accounts} onClose={() => setMerging(undefined)} onMerge={doMerge} />}
      {switcher && <QuickSwitcher chats={listChats} onSearchAll={(q) => { setSwitcher(false); setGsearch((g) => ({ q, n: (g?.n ?? 0) + 1 })); setNavOpen(true); }} onClose={() => setSwitcher(false)} onPick={(c) => { setSwitcher(false); openChat(c.id); }} />}
      {lightbox && <Lightbox url={lightbox} onClose={() => setLightbox(undefined)} />}
    </div>
  );
}

function useMemoRef<T>(v: T) { const r = useRef(v); r.current = v; return r; }

type DropZone = "before" | "mid" | "after";
function Pill(p: { id?: string; draggable?: boolean; drop?: boolean; setOver?: (id?: string) => void; onDropChat?: (chatIds: string) => void; onDropSpace?: (spaceId: string, zone: DropZone) => void; expanded?: boolean;
  onContext?: (e: { clientX: number; clientY: number }) => void; active?: boolean; title: string; badge?: number; badgeDot?: boolean; dot?: string; cls?: string; onClick: () => void; children: React.ReactNode }) {
  const [zone, setZone] = useState<DropZone>();
  const lp = useLongPress((x, y) => p.onContext?.({ clientX: x, clientY: y })); // touch: long press = context menu
  const accepts = (e: React.DragEvent) => (p.onDropChat && e.dataTransfer.types.includes(CHAT_DRAG)) || (p.onDropSpace && e.dataTransfer.types.includes(SPACE_DRAG));
  // dropping an icon on the middle of another one groups them; on its top / bottom quarter it reorders
  const zoneOf = (e: React.DragEvent): DropZone => { const r = e.currentTarget.getBoundingClientRect(), f = (e.clientY - r.top) / (r.height || 1); return f < 0.25 ? "before" : f > 0.75 ? "after" : "mid"; };
  return (
    <div className={"pillwrap" + (p.drop ? " dropping" : "") + (zone ? " zone-" + zone : "")} data-space={p.id} onContextMenu={p.onContext ? (e) => { e.preventDefault(); p.onContext!(e); } : undefined}
      onClickCapture={(e) => { if (lp.swallow()) { e.stopPropagation(); e.preventDefault(); } }} {...(p.onContext ? { onTouchStart: lp.onTouchStart, onTouchMove: lp.onTouchMove, onTouchEnd: lp.onTouchEnd, onTouchCancel: lp.onTouchCancel } : {})}
      draggable={p.draggable && !isCoarse()} onDragStart={p.draggable ? (e) => { e.stopPropagation(); e.dataTransfer.setData(SPACE_DRAG, p.id!); e.dataTransfer.effectAllowed = "move"; } : undefined}
      onDragOver={p.id ? (e) => { if (accepts(e)) { e.preventDefault(); e.stopPropagation(); p.setOver?.(e.dataTransfer.types.includes(CHAT_DRAG) ? p.id : undefined); setZone(e.dataTransfer.types.includes(SPACE_DRAG) ? zoneOf(e) : undefined); } } : undefined}
      onDragLeave={p.id ? () => { p.setOver?.(undefined); setZone(undefined); } : undefined}
      onDrop={p.id ? (e) => { p.setOver?.(undefined); setZone(undefined); const c = e.dataTransfer.getData(CHAT_DRAG), sp = e.dataTransfer.getData(SPACE_DRAG);
        if (c && p.onDropChat) { e.preventDefault(); e.stopPropagation(); p.onDropChat(c); } else if (sp && p.onDropSpace) { e.preventDefault(); e.stopPropagation(); p.onDropSpace(sp, zoneOf(e)); } } : undefined}>
      <button className={`pill ${p.cls ?? ""}${p.active ? " active" : ""}`} title={p.title} aria-label={p.title} aria-expanded={p.expanded} onClick={p.onClick}>{p.children}</button>
      {!!p.badge ? <b className="pbadge">{p.badge > 99 ? "99+" : p.badge}</b> : p.badgeDot ? <i className="pbadge dotb" aria-label="New messages" /> : null}
      {p.dot && <span className="pdot"><ProviderIcon provider={p.dot} size={17} /></span>}
    </div>
  );
}

/** Shown when the backend can't be reached at the first attempt (not running, wrong address, or it wants an access token). */
function ConnectScreen({ message }: { message: string }) {
  const [tok, setTok] = useState("");
  return (
    <div className="connect"><div className="connectcard">
      <h2>Can't connect to UniChat</h2>
      <p className="hint">{message}</p>
      <p className="hint">Check that the backend is running. If it was started with an access token (<code>UNIMSG_TOKEN</code>), enter it here; it is remembered in this browser.</p>
      <form onSubmit={(e) => { e.preventDefault(); setToken(tok.trim()); location.reload(); }}>
        <label>Access token<input type="password" autoComplete="current-password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="optional" /></label>
        <button className="primary">Connect</button>
      </form>
      <button className="secondary wide" onClick={() => location.reload()}>Retry</button>
    </div></div>
  );
}

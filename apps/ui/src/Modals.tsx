import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EmojiPicker as FullEmojiPicker } from "./EmojiPicker";
import { Suspense, lazy } from "react";
const QRCodeSVG = lazy(() => import("qrcode.react").then((m) => ({ default: m.QRCodeSVG }))); // the QR encoder only loads when a login QR is shown
import { AlertTriangle, Check, Folder, FolderPlus, MessageCircle, RotateCcw, GitMerge, BarChart3, Hash, ImageIcon, Info, Link2, MapPin, Plus, Search, Trash2, Users, X } from "./icons";
import { Avatar, ProviderIcon, SpaceIcon, core, presenceText, squareImage } from "./util";
import type { PrivacySetting } from "../../../packages/core/src/provider";
const PersonVerify = lazy(() => import("./VerifyDialog").then((m) => ({ default: m.PersonVerify }))); // identity verification (own chunk)
import { capsOf } from "./types";
import type { Account, Chat, Contact, Location, Space, LoginPrompt, ProviderInfo, SharedContact } from "./types";

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modalbg" onMouseDown={onClose}>
      <div className={"modal" + (wide ? " wide" : "")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="mhead"><h3>{title}</h3><button className="icon" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

export function Lightbox({ url, name, video, onClose }: { url: string; name?: string; video?: boolean; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      {video ? <video className="lbvideo" src={url} controls autoPlay playsInline aria-label={name ?? "video"} onClick={(e) => e.stopPropagation()} /> : <img src={url} alt={name ?? ""} onClick={(e) => e.stopPropagation()} />}
      <a className="primary dl" href={url} download={name ?? (video ? "video" : "image")} onClick={(e) => e.stopPropagation()}>Download</a>
    </div>
  );
}

export function LocationModal({ onSend, onClose }: { onSend: (l: Location) => void; onClose: () => void }) {
  const [lat, setLat] = useState(""); const [lng, setLng] = useState(""); const [name, setName] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const here = () => {
    if (!navigator.geolocation) return setErr("Geolocation is not available here");
    setBusy(true); setErr("");
    navigator.geolocation.getCurrentPosition(
      (p) => { setLat(p.coords.latitude.toFixed(6)); setLng(p.coords.longitude.toFixed(6)); setBusy(false); },
      (e) => { setErr(e.message || "Could not get your location"); setBusy(false); }, { enableHighAccuracy: true, timeout: 10000 });
  };
  const ok = !isNaN(+lat) && !isNaN(+lng) && lat !== "" && lng !== "" && Math.abs(+lat) <= 90 && Math.abs(+lng) <= 180;
  return (
    <Modal title="Share location" onClose={onClose}>
      <button className="secondary" onClick={here} disabled={busy}><MapPin size={16} /> {busy ? "Locating…" : "Use my current location"}</button>
      {err && <p className="hint err">{err}</p>}
      <div className="row2"><label>Latitude<input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="47.4212" /></label>
        <label>Longitude<input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="10.9853" /></label></div>
      <label>Label (optional)<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Meeting point" /></label>
      <button className="primary" disabled={!ok} onClick={() => onSend({ lat: +lat, lng: +lng, name: name || undefined })}>Send location</button>
    </Modal>
  );
}

export function ContactModal({ known, onSend, onClose }: { known: Contact[]; onSend: (c: SharedContact[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set()); const [name, setName] = useState(""); const [phone, setPhone] = useState("");
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const out = (): SharedContact[] => [
    ...known.filter((k) => sel.has(k.id)).map((k) => ({ name: k.name, handle: k.handle, phones: k.handle?.startsWith("+") ? [k.handle] : undefined })),
    ...(name ? [{ name, phones: phone ? [phone] : undefined }] : []),
  ];
  return (
    <Modal title="Share contact" onClose={onClose}>
      <ul className="pick">{known.map((k) => (
        <li key={k.id}><label><input type="checkbox" checked={sel.has(k.id)} onChange={() => toggle(k.id)} /><Avatar name={k.name} size={28} /> {k.name}<small>{k.handle}</small></label></li>))}</ul>
      <p className="hint">Or enter a new contact:</p>
      <div className="row2"><label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label><label>Phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+49…" /></label></div>
      <button className="primary" disabled={!out().length} onClick={() => onSend(out())}>Send {out().length || ""} contact{out().length === 1 ? "" : "s"}</button>
    </Modal>
  );
}

export function ForwardModal({ chats, onPick, onClose }: { chats: Chat[]; onPick: (c: Chat) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  return (
    <Modal title="Forward to…" onClose={onClose}>
      <input autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="pick tall">{chats.filter((c) => c.provider !== "mesh" && c.name.toLowerCase().includes(q.toLowerCase())).map((c) => (
        <li key={c.id}><button className="rowbtn" onClick={() => onPick(c)}><Avatar name={c.name} url={c.avatarUrl} of={{ kind: "chat", id: c.id }} size={28} provider={c.provider} /> {c.name}</button></li>))}</ul>
    </Modal>
  );
}

export function NewChatModal({ providers, accounts, chats, onDone, onClose }: { providers: ProviderInfo[]; accounts: Account[]; chats: Chat[]; onDone: (chat: Chat) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"dm" | "group">("dm");
  const caps = (a: Account) => capsOf(a, providers);
  const usable = accounts.filter((a) => a.state === "connected" && (tab === "dm" ? caps(a)?.startChat : caps(a)?.createGroup));
  const [acc, setAcc] = useState(""); const [handle, setHandle] = useState(""); const [name, setName] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set()); const [q, setQ] = useState("");
  const accountId = usable.find((a) => a.id === acc)?.id ?? usable[0]?.id;

  const people = chats.filter((c) => c.kind === "dm" && c.provider !== "mesh" && c.name.toLowerCase().includes(q.toLowerCase()));
  const pickedChats = chats.filter((c) => picked.has(c.id));
  const accountsPicked = new Set(pickedChats.map((c) => c.accountId));
  const mesh = accountsPicked.size > 1; // people from different platforms/accounts => a mesh group, automatically
  const platforms = [...new Set(pickedChats.map((c) => providers.find((p) => p.name === c.provider)?.displayName ?? c.provider))];
  const nativeAccount = accountsPicked.size === 1 ? [...accountsPicked][0] : accountId;
  const toggle = (id: string) => { const n = new Set(picked); n.has(id) ? n.delete(id) : n.add(id); setPicked(n); };

  const go = async () => {
    setBusy(true); setErr("");
    try {
      if (tab === "dm") {
        const chat = await core.call("startChat", { accountId, handle: handle.trim() });
        if (name.trim()) await core.call("setAlias", { chatId: chat.id, name: name.trim() }); // save under the name you gave
        return onDone(chat);
      }
      if (mesh) {
        const g = await core.call("meshCreate", { name: name.trim(), members: pickedChats.map((c) => ({ name: c.name, chatId: c.id })) });
        return onDone({ ...g, kind: "group", provider: "mesh" } as Chat);
      }
      // single platform: a real group on that network. Native member ids -> handles via members().
      const handles: string[] = [];
      for (const c of pickedChats) {
        const m: Contact[] = await core.call("members", { chatId: c.id });
        const h = m[0]?.handle; if (!h) throw new Error(`Couldn't find an address for ${c.name}`);
        handles.push(h);
      }
      handles.push(...handle.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
      onDone(await core.call("createGroup", { accountId: nativeAccount, name: name.trim(), handles }));
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  const canGo = !busy && (tab === "dm" ? !!accountId && !!handle.trim() : !!name.trim() && (mesh ? pickedChats.length > 1 : (picked.size + handle.split(/[,\n]/).filter((s) => s.trim()).length) > 0 && !!nativeAccount && !!caps(accounts.find((a) => a.id === nativeAccount)!)?.createGroup));
  return (
    <Modal title="New chat" onClose={onClose}>
      <div className="tabs"><button className={tab === "dm" ? "on" : ""} onClick={() => setTab("dm")}>Direct message</button><button className={tab === "group" ? "on" : ""} onClick={() => setTab("group")}>New group</button></div>
      {tab === "dm" && (!usable.length ? <>
        <p className="hint">No connected account can start chats yet.</p>
        {accounts.map((a) => <p key={a.id} className="hint">{a.label}: {a.state !== "connected" ? `not connected (${a.state})` : `${providers.find((p) => p.name === a.provider)?.displayName ?? a.provider} doesn't support starting chats from UniChat yet`}</p>)}</> : <>
        <label>Account<select value={accountId} onChange={(e) => setAcc(e.target.value)}>{usable.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.provider})</option>)}</select></label>
        <label>Contact name (optional)<input value={name} onChange={(e) => setName(e.target.value)} placeholder="How you want to see them" /></label>
        <label>Phone number or user id<input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={usable.find((a) => a.id === accountId)?.provider === "matrix" ? "@user:server.org" : "+49 151 1234567"} /></label></>)}
      {tab === "group" && <>
        <label>Group name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>People{picked.size ? ` (${picked.size} selected)` : ""}<input placeholder="Search your contacts" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <ul className="pick tall">{people.map((c) => (
          <li key={c.id}><label><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /><Avatar name={c.name} url={c.avatarUrl} of={{ kind: "chat", id: c.id }} size={28} provider={c.provider} /> {c.name}
            <small>{providers.find((p) => p.name === c.provider)?.displayName ?? c.provider}</small></label></li>))}
          {!people.length && <li className="hint pad">No matching contacts</li>}</ul>
        {mesh
          ? <div className="disclaimer"><Info size={16} /><span><b>Mesh group</b>: your people are on different platforms ({platforms.join(", ")}), so UniChat links them into one group. Messages are relayed through your accounts: members see them as coming from you, with the sender's name in the text, and only while UniChat is running. Members are not told unless you tell them.</span></div>
          : <label>Add others by number or user id (optional)<input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="+49 151 1234567, @user:server.org" /></label>}
        {!mesh && usable.length > 1 && !picked.size && <label>Create on<select value={accountId} onChange={(e) => setAcc(e.target.value)}>{usable.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.provider})</option>)}</select></label>}
        {!mesh && !usable.length && !picked.size && <p className="hint">No connected account can create groups on its own network; pick people from different platforms to make a mesh group.</p>}</>}
      {err && <p className="hint err">{err}</p>}
      <button className="primary" disabled={!canGo} onClick={go}>{tab === "dm" ? "Start chat" : mesh ? "Create mesh group" : "Create group"}</button>
    </Modal>
  );
}

export function AddAccount({ providers, onAdd, onClose }: { providers: ProviderInfo[]; onAdd: (p: string) => void; onClose: () => void }) {
  return (
    <Modal title="Add account" onClose={onClose}>
      <div className="grid">{providers.filter((p) => !p.deprecated).map((p) => (
        <button key={p.name} className="card" onClick={() => onAdd(p.name)}><ProviderIcon provider={p.name} size={36} />{p.displayName}</button>))}</div>
    </Modal>
  );
}

export function LoginModal({ prompt, onCancel }: { prompt: LoginPrompt; onCancel: () => void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries((prompt.kind === "form" ? prompt.fields : []).filter((f) => f.type === "select").map((f) => [f.name, f.value ?? f.options?.[0]?.value ?? ""]))); const [busy, setBusy] = useState(false); const [localErr, setLocalErr] = useState("");
  const form = prompt.kind === "form" ? prompt : undefined;
  // a required checkbox must be ticked, other required fields filled: the form is never submitted otherwise
  const missing = form?.fields.find((f) => f.required && (f.type === "checkbox" ? vals[f.name] !== "true" : !(vals[f.name] ?? "").trim()));
  return (
    <Modal title={form ? (form.warning ? "Sign in" : form.title) : "Link device"} onClose={onCancel}>
      {form?.warning && <LoginWarningBox w={form.warning} />}
      {form?.warning && <p className="hint loginlead">{form.title}</p>}
      {prompt.kind === "qr" && <><div className="qr"><Suspense fallback={<span className="spinner" aria-label="Loading QR code" />}><QRCodeSVG value={prompt.payload} size={220} marginSize={2} /></Suspense></div><p className="hint center">{prompt.hint ?? "Scan with the phone app"}</p><p className="hint center">Waiting for you to scan…</p></>}
      {prompt.kind === "link" && <><p className="hint">{prompt.hint}</p><a href={prompt.payload} target="_blank" rel="noreferrer">{prompt.payload}</a></>}
      {prompt.kind === "form" && (
        <form onSubmit={async (e) => { e.preventDefault(); if (missing) { setLocalErr(missing.type === "checkbox" ? `Please tick “${missing.label}” to continue.` : `Please fill in “${missing.label}”.`); return; } setLocalErr(""); setBusy(true); try { await core.call("submitLogin", { accountId: prompt.accountId, promptId: prompt.promptId, values: vals }); } catch (err: any) { setLocalErr(String(err?.message ?? err)); } finally { setBusy(false); } }}>
          {(localErr || prompt.error) && <div className="error" role="alert">{localErr || prompt.error}</div>}
          {prompt.fields.map((f) => f.type === "checkbox"
            ? (<label key={f.name} className="loginchk"><input type="checkbox" name={f.name} checked={vals[f.name] === "true"} onChange={(e) => { setLocalErr(""); setVals({ ...vals, [f.name]: e.target.checked ? "true" : "false" }); }} /><span>{f.label}{f.required && <b className="req" aria-hidden> *</b>}</span></label>)
            : f.type === "select"
              ? (<label key={f.name}>{f.label}<select name={f.name} value={vals[f.name] ?? ""} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>{(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>)
              : f.type === "file"
              ? (<label key={f.name}>{f.label}<input name={f.name} type="file" onChange={async (e) => { const fl = e.target.files?.[0]; if (!fl) return; if (fl.size > 64e6) { setLocalErr("That file is too large."); return; } setLocalErr(""); const t = await fl.text(); setVals((v) => ({ ...v, [f.name]: t })); }} />{vals[f.name] && <small className="sub">File loaded ({Math.round(vals[f.name].length / 1024)} KB)</small>}</label>)
              : (<div key={f.name} className="fieldwrap"><label>{f.label}<input name={f.name} type={f.type === "password" ? "password" : "text"} placeholder={f.placeholder} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} /></label>
                  {f.help?.map((h, i) => <details key={i} className="fieldhelp"><summary>{h.title}</summary><ol>{h.steps.map((st, j) => <li key={j}>{st}</li>)}</ol>{h.link && <a href={h.link.href} target="_blank" rel="noreferrer noopener">{h.link.label}</a>}</details>)}</div>))}
          <button className="primary" disabled={busy || !!missing} title={missing ? "Complete the required fields first" : undefined}>{busy ? "Working…" : "Continue"}</button>
        </form>)}
    </Modal>
  );
}

/** Prominent notice above a login form (consent / risk warnings). */
function LoginWarningBox({ w }: { w: { text: string; severity: "info" | "warning" | "danger" } }) {
  const Icon = w.severity === "info" ? Info : AlertTriangle;
  return <div className={"loginwarn " + w.severity} role="alert"><Icon size={22} /><p>{w.text}</p></div>;
}

export function RenameModal({ chat, onSave, onClose, network, title }: { chat: Chat; onSave: (name: string | null) => void; onClose: () => void; network?: boolean; title?: string }) {
  const [name, setName] = useState(chat.name);
  const orig = chat.originalName ?? chat.name;
  return (
    <Modal title={title ?? (network ? "Rename for everyone" : chat.kind === "dm" ? "Rename contact" : "Rename chat")} onClose={onClose}>
      <p className="hint">{network ? "Everyone in the group will see the new name." : <>Only you see this name. {chat.provider !== "mesh" && <>Provider name: <b>{orig}</b></>}</>}</p>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave(network ? name.trim() : name.trim() === orig ? null : name.trim()); }}>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} /></label>
        <button className="primary" disabled={!name.trim()}>Save</button>
      </form>
      {!network && chat.originalName && <button className="secondary reset" onClick={() => onSave(null)}>Reset to “{chat.originalName}”</button>}
    </Modal>
  );
}

/**
 * "Merge with…": pick other 1:1 chats of the same person (other accounts / apps) to show as ONE chat with one timeline.
 * Purely local to UniChat. Likely matches (same name, phone number or handle) are listed first.
 */
export function MergeModal({ source, chats, providers, accounts, onMerge, onClose }: { source: Chat; chats: Chat[]; providers: ProviderInfo[]; accounts: Account[]; onMerge: (ids: string[], name?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState(""); const [picked, setPicked] = useState<string[]>([]); const [name, setName] = useState("");
  const [why, setWhy] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; core.call("mergeSuggestions", { chatId: source.id }).then((r: { chatId: string; reason: string }[]) => live && setWhy(Object.fromEntries((r ?? []).map((x) => [x.chatId, x.reason]))), () => {}); return () => { live = false; }; }, [source.id]);
  const prov = (c: Chat) => providers.find((x) => x.name === c.provider)?.displayName ?? c.provider;
  const accOf = (c: Chat) => accounts.find((a) => a.id === c.accountId)?.label ?? "";
  const others = chats.filter((c) => c.kind === "dm" && c.provider !== "mesh" && c.id !== source.id);
  const rank = (c: Chat) => (why[c.id] === "same phone number" ? 0 : why[c.id] === "same handle" ? 1 : why[c.id] ? 2 : 3);
  const shown = others.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()) || prov(c).toLowerCase().includes(q.toLowerCase())).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const row = (c: Chat) => (
    <li key={c.id}><label className={"mergerow" + (picked.includes(c.id) ? " on" : "")}>
      <input type="checkbox" checked={picked.includes(c.id)} onChange={() => toggle(c.id)} aria-label={`Merge with ${c.name} on ${prov(c)}`} />
      <Avatar name={c.name} url={c.avatarUrl} of={{ kind: "chat", id: c.id }} size={30} />
      <span className="mrtxt"><b>{c.name}</b><small>{c.mergeMembers ? "Already merged chat" : `${prov(c)}${accOf(c) ? " · " + accOf(c) : ""}`}</small></span>
      {why[c.id] && <span className="whychip">{why[c.id]}</span>}
      {!c.mergeMembers && <ProviderIcon provider={c.provider} size={20} />}
    </label></li>);
  const likely = shown.filter((c) => why[c.id]), rest = shown.filter((c) => !why[c.id]);
  return (
    <Modal title={source.mergeMembers ? `Merge more into “${source.name}”` : `Merge “${source.name}” with…`} onClose={onClose}>
      <p className="hint">Show the same person's chats from different accounts or apps as <b>one chat</b> with one timeline. This only changes how UniChat shows them: nothing is sent, and no message is copied or deleted. You can unmerge at any time.</p>
      <input autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="pick tall mergelist">
        {!!likely.length && <li className="mergehead">Likely the same person</li>}{likely.map(row)}
        {!!likely.length && !!rest.length && <li className="mergehead">Other chats</li>}{rest.map(row)}
        {!shown.length && <li className="hint pad">No other 1:1 chats to merge with{q ? " matching your search" : ""}. Groups and channels can't be merged.</li>}</ul>
      {!source.mergeMembers && picked.length > 0 && <label>Name of the merged chat <span className="hint">(optional, default: “{source.name}”)</span><input value={name} placeholder={source.name} onChange={(e) => setName(e.target.value)} /></label>}
      <button className="primary" disabled={!picked.length || busy} onClick={() => { setBusy(true); onMerge([source.id, ...picked], name.trim() || undefined); }}><GitMerge size={15} className="inl" /> {picked.length ? `Merge ${picked.length + 1} chats` : "Pick chats to merge"}</button>
    </Modal>
  );
}

/** Ctrl/Cmd+K: jump to any chat by name. */
export function QuickSwitcher({ chats, onPick, onClose, onSearchAll }: { chats: Chat[]; onPick: (c: Chat) => void; onClose: () => void; onSearchAll?: (q: string) => void }) {
  const [q, setQ] = useState(""); const [i, setI] = useState(0);
  const list = chats.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  const all = !!onSearchAll && !!q.trim(); // last row: search the text of every message instead
  const rows = list.length + (all ? 1 : 0);
  return (
    <div className="modalbg top" onMouseDown={onClose}>
      <div className="modal switcher" onMouseDown={(e) => e.stopPropagation()}>
        <div className="swin"><Search size={16} /><input autoFocus placeholder="Jump to a chat…" value={q}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(x + 1, rows - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
            if (e.key === "Enter" && list[i]) onPick(list[i]);
            else if (e.key === "Enter" && all && i === list.length) onSearchAll!(q.trim());
            if (e.key === "Escape") onClose();
          }} /></div>
        <ul className="pick">{list.map((c, n) => (
          <li key={c.id}><button className={"rowbtn" + (n === i ? " sel" : "")} onMouseEnter={() => setI(n)} onClick={() => onPick(c)}>
            <Avatar name={c.name} url={c.avatarUrl} of={{ kind: "chat", id: c.id }} size={28} provider={c.provider} /> {c.name}<small className="where">{c.provider}</small></button></li>))}
          {all && <li><button className={"rowbtn" + (i === list.length ? " sel" : "")} data-searchall onMouseEnter={() => setI(list.length)} onClick={() => onSearchAll!(q.trim())}><Search size={16} /> Search all messages for “{q.trim()}”</button></li>}
          {!list.length && !all && <li className="hint pad">No matching chats</li>}</ul>
      </div>
    </div>
  );
}

export function AddMembersModal({ chat, onAdd, onClose }: { chat: Chat; onAdd: (handles: string[]) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const handles = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return (
    <Modal title={`Add people to ${chat.name}`} onClose={onClose}>
      <label>Phone numbers or user ids (one per line or comma separated)<textarea rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={chat.provider === "matrix" ? "@alice:matrix.org" : "+49 151 1234567"} /></label>
      {err && <p className="hint err">{err}</p>}
      <button className="primary" disabled={!handles.length || busy} onClick={async () => { setBusy(true); setErr(""); try { await onAdd(handles); } catch (e: any) { setErr(e.message); setBusy(false); } }}>Add {handles.length || ""}</button>
    </Modal>
  );
}

/** The rail's "+": like Discord's, it creates/joins a community, or adds an account. */
export function AddMenuModal({ providers, accounts, onPick, onClose }: { providers: ProviderInfo[]; accounts: Account[]; onPick: (what: "createspace" | "joinspace" | "add") => void; onClose: () => void }) {
  const can = (k: "createSpace" | "joinSpace") => accounts.some((a) => a.state === "connected" && capsOf(a, providers)?.[k]);
  const Item = ({ icon, title, hint, ok, what }: { icon: React.ReactNode; title: string; hint: string; ok: boolean; what: "createspace" | "joinspace" | "add" }) => (
    <button className="menuitem" disabled={!ok} onClick={() => onPick(what)}>{icon}<span><b>{title}</b><small>{ok ? hint : "None of your connected accounts support this"}</small></span></button>);
  return (
    <Modal title="Add" onClose={onClose}>
      <Item icon={<Users size={22} />} title="Create a community" hint="Start a new community (WhatsApp, Matrix space)" ok={can("createSpace")} what="createspace" />
      <Item icon={<Link2 size={22} />} title="Join a community" hint="Use an invite link or address" ok={can("joinSpace")} what="joinspace" />
      <Item icon={<Plus size={22} />} title="Add an account" hint="Link WhatsApp, Signal, Matrix…" ok what="add" />
    </Modal>
  );
}

export function CommunityModal({ mode, providers, accounts, onDone, onClose }: { mode: "create" | "join"; providers: ProviderInfo[]; accounts: Account[]; onDone: (s: { id: string }) => void; onClose: () => void }) {
  const key = mode === "create" ? "createSpace" : "joinSpace";
  const usable = accounts.filter((a) => a.state === "connected" && capsOf(a, providers)?.[key]);
  const [acc, setAcc] = useState(""); const [name, setName] = useState(""); const [desc, setDesc] = useState(""); const [invite, setInvite] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const accountId = usable.find((a) => a.id === acc)?.id ?? usable[0]?.id;
  const provider = accounts.find((a) => a.id === accountId)?.provider;
  const go = async () => {
    setBusy(true); setErr("");
    try { onDone(await core.call(mode === "create" ? "createSpace" : "joinSpace", mode === "create" ? { accountId, name: name.trim(), description: desc.trim() || undefined } : { accountId, invite: invite.trim() })); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title={mode === "create" ? "Create a community" : "Join a community"} onClose={onClose}>
      <label>Account<select value={accountId} onChange={(e) => setAcc(e.target.value)}>{usable.map((a) => <option key={a.id} value={a.id}>{a.label} ({a.provider})</option>)}</select></label>
      {mode === "create" ? <>
        <label>Community name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Description (optional)<input value={desc} onChange={(e) => setDesc(e.target.value)} /></label></>
        : <label>Invite link or address<input autoFocus value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={provider === "matrix" ? "#space:matrix.org or a matrix.to link" : "https://chat.whatsapp.com/…"} /></label>}
      {err && <p className="hint err">{err}</p>}
      <button className="primary" disabled={busy || !accountId || !(mode === "create" ? name.trim() : invite.trim())} onClick={go}>{mode === "create" ? "Create community" : "Join community"}</button>
    </Modal>
  );
}

export function ConfirmModal({ title, body, confirmLabel, danger, onConfirm, onClose }: { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirmbody">{body}</div>
      <div className="btnrow"><button className="secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? "danger solid" : "primary inline"} style={danger ? undefined : { marginTop: 0 }} autoFocus onClick={() => { onClose(); onConfirm(); }}>{confirmLabel}</button></div>
    </Modal>
  );
}

/** Community details: who it belongs to and its channels. */
export function SpaceInfoModal({ space, channels, providerName, onOpen, onClose }: { space: Space; channels: Chat[]; /** undefined: the community holds chats from several messengers (no single original messenger to show) */ providerName?: string; onOpen: (c: Chat) => void; onClose: () => void }) {
  return (
    <Modal title="Community" onClose={onClose}>
      <div className="spacehero"><Avatar name={space.name} url={space.iconUrl} of={{ kind: "space", id: space.id }} size={72} zoom provider={space.provider} />
        <h2>{space.name}</h2>{space.originalName && <div className="hint">{providerName ?? "Original"} name: {space.originalName}</div>}
        <div className="tags">{providerName ? <span className="tag brand"><ProviderIcon provider={space.provider} size={14} /> {providerName}</span> : !space.local && <span className="tag">Mixed messengers</span>}{space.muted && <span className="tag">Muted</span>}{space.archived && <span className="tag">Archived</span>}</div></div>
      <h4 className="subhead">Channels · {channels.length}</h4>
      <ul className="pick tall">{channels.map((c) => (
        <li key={c.id}><button className="rowbtn" onClick={() => { onClose(); onOpen(c); }}><Hash size={16} /> {c.name}{!!c.unread && <b className="unread">{c.unread}</b>}</button></li>))}
        {!channels.length && <li className="hint pad">No channels yet</li>}</ul>
    </Modal>
  );
}

/** Archived communities live behind one button so the rail stays short. */
export function ArchivedSpacesModal({ spaces, onOpen, onRestore, onClose }: { spaces: Space[]; onOpen: (s: Space) => void; onRestore: (s: Space) => void; onClose: () => void }) {
  return (
    <Modal title="Archived communities" onClose={onClose}>
      {!spaces.length && <p className="hint">Nothing archived.</p>}
      <ul className="pick tall">{spaces.map((s) => (
        <li key={s.id} className="arow"><button className="rowbtn" onClick={() => { onClose(); onOpen(s); }}><SpaceIcon space={s} size={32} /> {s.name}</button>
          <button className="secondary" onClick={() => onRestore(s)}>Unarchive</button></li>))}</ul>
    </Modal>
  );
}

export function PollModal({ onSend, onClose }: { onSend: (p: { question: string; options: string[]; multiple: boolean }) => void; onClose: () => void }) {
  const [q, setQ] = useState(""); const [opts, setOpts] = useState(["", ""]); const [multiple, setMultiple] = useState(false);
  const clean = opts.map((o) => o.trim()).filter(Boolean);
  const set = (i: number, v: string) => setOpts((o) => o.map((x, k) => (k === i ? v : x)));
  return (
    <Modal title="Create a poll" onClose={onClose}>
      <label>Question<input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="What should we do on Saturday?" /></label>
      <label>Options</label>
      {opts.map((o, i) => (
        <div key={i} className="optrow"><input value={o} onChange={(e) => set(i, e.target.value)} placeholder={`Option ${i + 1}`} />
          {opts.length > 2 && <button className="icon" title="Remove option" onClick={() => setOpts((x) => x.filter((_, k) => k !== i))}><Trash2 size={15} /></button>}</div>))}
      {opts.length < 12 && <button className="secondary" onClick={() => setOpts((o) => [...o, ""])}><Plus size={14} /> Add option</button>}
      <label className="check"><input type="checkbox" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} /> Allow several answers</label>
      <button className="primary" disabled={!q.trim() || clean.length < 2 || new Set(clean).size !== clean.length} onClick={() => onSend({ question: q.trim(), options: clean, multiple })}><BarChart3 size={15} style={{ verticalAlign: -2 }} /> Send poll</button>
      {new Set(clean).size !== clean.length && <p className="hint err">Options must be different from each other.</p>}
    </Modal>
  );
}

/** Context menu at a screen position; closes on outside click, Escape, scroll, resize or blur. */
export function PopMenu({ x, y, title, onClose, children }: { x: number; y: number; title?: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => { const r = ref.current!.getBoundingClientRect(); setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) }); }, [x, y]);
  useEffect(() => {
    const close = () => onClose(); const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // no scroll listener: this menu is anchored to the fixed rail, a chat scrolling underneath must not dismiss it
    addEventListener("mousedown", close); addEventListener("resize", close); addEventListener("blur", close); addEventListener("keydown", key);
    return () => { removeEventListener("mousedown", close); removeEventListener("resize", close); removeEventListener("blur", close); removeEventListener("keydown", key); };
  }, []);
  return (
    <div ref={ref} className="railmenu" style={{ left: pos.left, top: pos.top }} role="menu" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()} onClick={onClose}>
      {title && <div className="hd">{title}</div>}{children}
    </div>
  );
}

/** A person (e.g. a group member): their details, and a way to open or start a chat with them. */
export function PersonModal({ chat, senderId, name, existingDm, canStartChat, providerName, onOpenChat, onClose, onNamed }: {
  chat: Chat; senderId: string; name: string; existingDm?: Chat; canStartChat: boolean; providerName: string;
  onOpenChat: (chatId: string) => void; onClose: () => void; onNamed?: () => void;
}) {
  const aliasKey = `${chat.accountId}:${senderId}`;
  const [nick, setNick] = useState(""); const [nickBusy, setNickBusy] = useState(false); const [nickDone, setNickDone] = useState("");
  const saveNick = async (v: string | null) => {
    setNickBusy(true); setNickDone("");
    try { await core.call("setAlias", { chatId: aliasKey, name: v }); setNickDone(v ? "Saved. This name now shows wherever this person appears." : "Removed."); if (v === null) setNick(""); onNamed?.(); }
    catch (e: any) { setNickDone(e?.message ?? "Could not save."); } finally { setNickBusy(false); }
  };
  const [contact, setContact] = useState<Contact>(); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  useEffect(() => { core.call("members", { chatId: chat.id }).then((m: Contact[]) => setContact((m ?? []).find((x) => x.id === senderId)), () => {}); }, [chat.id, senderId]);
  const shown = contact?.name || name || senderId;
  const handle = contact?.handle ?? (senderId.includes("@") && !senderId.includes(":") ? "+" + senderId.split("@")[0].replace(/\D/g, "") : senderId);
  const message = async () => {
    setBusy(true); setErr("");
    try { const c = await core.call("startChat", { accountId: chat.accountId, handle }); onClose(); onOpenChat(c.id); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Modal title="Contact" onClose={onClose}>
      <div className="spacehero"><Avatar name={shown} url={contact?.avatarUrl} of={{ kind: "contact", id: `${chat.accountId}:${senderId}` }} size={88} zoom online={contact?.online} />
        <h2>{shown}</h2>{handle && <div className="hint">{handle}</div>}{contact && presenceText(contact) && <div className="hint presence" data-presence={contact.online ? "online" : "seen"}>{presenceText(contact)}</div>}
        <div className="tags"><span className="tag brand"><ProviderIcon provider={chat.provider} size={14} /> {providerName}</span><span className="tag">Member of {chat.name}</span></div></div>
      {err && <p className="hint err">{err}</p>}
      {chat.provider === "matrix" && <Suspense fallback={null}><PersonVerify accountId={chat.accountId} userId={senderId} name={shown} /></Suspense>}
      <form className="nickform" onSubmit={(e) => { e.preventDefault(); if (nick.trim()) void saveNick(nick.trim()); }}>
        <label>Your own name for this person<input value={nick} onChange={(e) => setNick(e.target.value)} placeholder={shown} maxLength={80} /></label>
        <div className="nickbtns"><button className="secondary" disabled={nickBusy || !nick.trim()}>Save name</button><button type="button" className="secondary" disabled={nickBusy} onClick={() => void saveNick(null)}>Remove my name</button></div>
        {nickDone && <p className="hint">{nickDone}</p>}
      </form>
      {existingDm
        ? <button className="primary" onClick={() => { onClose(); onOpenChat(existingDm.id); }}>Open chat</button>
        : canStartChat ? <button className="primary" disabled={busy} onClick={message}>Send message</button> : <p className="hint">Starting chats isn't available for this account.</p>}
    </Modal>
  );
}

interface ProfileData { displayName?: string; about?: string; handle?: string; avatar: { dataBase64: string; mime: string } | null }
/** Own profile + privacy of one account. Only fields the provider says it can change are editable. */
export function ProfileModal({ account, provider, onClose }: { account: Account; provider: ProviderInfo; onClose: () => void }) {
  const caps = capsOf(account, [provider]) ?? provider.capabilities;
  const [loading, setLoading] = useState(true); const [err, setErr] = useState(""); const [saved, setSaved] = useState(false); const [busy, setBusy] = useState(false);
  const [orig, setOrig] = useState<ProfileData>(); const [name, setName] = useState(""); const [about, setAbout] = useState("");
  const [pic, setPic] = useState<string | null | undefined>(undefined); // undefined = unchanged, null = removed, string = new data URL
  const [newPic, setNewPic] = useState<{ dataBase64: string; mime: string }>();
  const [privacy, setPrivacy] = useState<PrivacySetting[]>([]);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    (async () => {
      try {
        if (caps.profile) { const p: ProfileData = await core.call("getProfile", { accountId: account.id }); setOrig(p); setName(p.displayName ?? ""); setAbout(p.about ?? ""); }
        if (caps.privacy) setPrivacy(await core.call("getPrivacy", { accountId: account.id }));
      } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
    })();
  }, [account.id]);
  const f = caps.profile ?? {};
  const current = pic === null ? null : typeof pic === "string" ? pic : orig?.avatar ? `data:${orig.avatar.mime};base64,${orig.avatar.dataBase64}` : null;
  const dirty = !!orig && ((f.displayName && name !== (orig.displayName ?? "")) || (f.about && about !== (orig.about ?? "")) || pic !== undefined);
  const save = async () => {
    setBusy(true); setErr(""); setSaved(false);
    try {
      const patch: Record<string, unknown> = { accountId: account.id };
      if (f.displayName && name !== (orig?.displayName ?? "")) patch.displayName = name.trim();
      if (f.about && about !== (orig?.about ?? "")) patch.about = about.trim();
      if (pic === null) patch.avatar = null; else if (newPic) patch.avatar = newPic;
      const p: ProfileData = await core.call("updateProfile", patch);
      setOrig(p); setName(p.displayName ?? ""); setAbout(p.about ?? ""); setPic(undefined); setNewPic(undefined); setSaved(true);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const choose = async (fl?: File) => {
    if (!fl) return; setErr("");
    try { const r = await squareImage(fl); setNewPic({ dataBase64: r.dataBase64, mime: r.mime }); setPic(r.dataUrl); setSaved(false); } catch (e: any) { setErr(e.message || "Couldn't use that image"); }
  };
  const setP = async (id: string, value: string) => {
    setErr("");
    try { setPrivacy(await core.call("setPrivacy", { accountId: account.id, id, value })); } catch (e: any) { setErr(e.message); setPrivacy(await core.call("getPrivacy", { accountId: account.id }).catch(() => privacy)); }
  };
  return (
    <Modal title={`${provider.displayName} · profile & privacy`} onClose={onClose} wide>
      {loading ? <p className="hint">Loading…</p> : <>
        {caps.profile && <section className="prof">
          <div className="profavatar">
            <Avatar name={name || account.label} url={current ?? undefined} size={96} zoom />
            {f.avatar && <div className="profbtns">
              <button className="secondary" onClick={() => file.current?.click()}>Change picture</button>
              {current && <button className="secondary" onClick={() => { setPic(null); setNewPic(undefined); setSaved(false); }}>Remove</button>}
              <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} /></div>}
            {!f.avatar && <small className="hint">This messenger doesn't let apps change the picture.</small>}
          </div>
          {orig?.handle && <div className="hint">{orig.handle}</div>}
          {f.displayName && <label>Name<input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} /></label>}
          {f.about && <label>About<input value={about} onChange={(e) => { setAbout(e.target.value); setSaved(false); }} placeholder="Hey there! I am using…" /></label>}
          <button className="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Saving…" : "Save profile"}</button>
          {saved && <p className="hint ok">Saved.</p>}
        </section>}
        {caps.privacy && <section className="privsec">
          <h4 className="subhead">Privacy</h4>
          {privacy.map((s) => (
            <label key={s.id} className="privrow"><span><b>{s.label}</b>{s.description && <small>{s.description}</small>}</span>
              <select value={s.value} onChange={(e) => setP(s.id, e.target.value)}>{s.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>))}
          {!privacy.length && <p className="hint">No privacy settings are available.</p>}
        </section>}
        {!caps.profile && !caps.privacy && <p className="hint">This messenger has no profile or privacy settings that UniChat can change yet.</p>}
        {err && <p className="hint err">{err}</p>}
      </>}
    </Modal>
  );
}

const toLocalInput = (iso?: string) => { if (!iso) return ""; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
/** Create or edit an event (the provider decides whether it can). Times are entered in your local time zone. */
export function EventModal({ initial, onSave, onClose }: {
  initial?: { name: string; description?: string; start?: string; end?: string; place?: string };
  onSave: (v: { name: string; description?: string; start: string; end?: string; place?: string }) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? ""); const [desc, setDesc] = useState(initial?.description ?? "");
  const [start, setStart] = useState(toLocalInput(initial?.start) || toLocalInput(new Date(Date.now() + 86_400_000).toISOString()));
  const [end, setEnd] = useState(toLocalInput(initial?.end)); const [place, setPlace] = useState(initial?.place ?? "");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const bad = !!end && new Date(end) <= new Date(start);
  return (
    <Modal title={initial ? "Edit event" : "Create an event"} onClose={onClose}>
      <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="row2"><label>Starts<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>Ends (optional)<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label></div>
      <label>Place (optional)<input value={place} onChange={(e) => setPlace(e.target.value)} /></label>
      <label>Description (optional)<textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
      {bad && <p className="hint err">The end must be after the start.</p>}{err && <p className="hint err">{err}</p>}
      <button className="primary" disabled={!name.trim() || !start || bad || busy} onClick={async () => {
        setBusy(true); setErr("");
        try { await onSave({ name: name.trim(), description: desc.trim() || undefined, start: new Date(start).toISOString(), end: end ? new Date(end).toISOString() : undefined, place: place.trim() || undefined }); onClose(); }
        catch (e: any) { setErr(e.message); setBusy(false); }
      }}>{initial ? "Save changes" : "Create event"}</button>
    </Modal>
  );
}

/** Pick a time to send the message you've typed. */
export function ScheduleModal({ preview, onSchedule, onClose }: { preview: string; onSchedule: (at: number) => Promise<void>; onClose: () => void }) {
  const toInput = (t: number) => { const d = new Date(t); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
  const [when, setWhen] = useState(toInput(Date.now() + 3600_000)); const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const at = new Date(when).getTime(); const bad = !when || at < Date.now() + 30_000;
  return (
    <Modal title="Schedule send" onClose={onClose}>
      <p className="hint">“{preview.length > 120 ? preview.slice(0, 120) + "…" : preview}”</p>
      <label>Send at<input type="datetime-local" value={when} min={toInput(Date.now() + 60_000)} onChange={(e) => setWhen(e.target.value)} /></label>
      <p className="hint">It is sent only while UniChat is running at that time.</p>
      {bad && <p className="hint err">Pick a time at least a minute from now.</p>}{err && <p className="hint err">{err}</p>}
      <button className="primary" disabled={bad || busy} onClick={async () => { setBusy(true); setErr(""); try { await onSchedule(at); onClose(); } catch (e: any) { setErr(e.message); setBusy(false); } }}>Schedule</button>
    </Modal>
  );
}

/** 24 preset colours (the first nine are the original set), plus a free colour picker in ColourPicker. */
export const FOLDER_COLORS = ["#5865f2", "#3b82f6", "#23a559", "#e0a030", "#e67e22", "#eb459e", "#9b59b6", "#16a085", "#80848e",
  "#ef4444", "#f97316", "#eab308", "#84cc16", "#10b981", "#06b6d4", "#0ea5e9", "#6366f1", "#a855f7", "#d946ef", "#f43f5e", "#78716c", "#334155", "#0f766e"];
/** Swatches + a custom colour (native colour picker). `allowNone` adds a "no colour" choice. */
export function ColourPicker({ value, onChange, allowNone, autoFocusValue }: { value: string | null | undefined; onChange: (c: string | null) => void; allowNone?: boolean; autoFocusValue?: boolean }) {
  const custom = !!value && !FOLDER_COLORS.includes(value);
  return (
    <div className="swatches" role="radiogroup" aria-label="Colour">
      {allowNone && <button type="button" role="radio" aria-checked={!value} aria-label="No colour" title="No colour" className={"swatch ico" + (!value ? " on" : "")} onClick={() => onChange(null)}>–</button>}
      {FOLDER_COLORS.map((c) => <button type="button" key={c} role="radio" aria-checked={c === value} aria-label={`Colour ${c}`} autoFocus={autoFocusValue && c === (value ?? FOLDER_COLORS[0])} className={"swatch" + (c === value ? " on" : "")} style={{ background: c }} onClick={() => onChange(c)} />)}
      <label className={"swatch custom" + (custom ? " on" : "")} title="Pick any colour" aria-label="Custom colour" style={custom ? { background: value! } : undefined}>
        {!custom && <span aria-hidden>+</span>}<input type="color" value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#5865f2"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>);
}
export const FOLDER_ICONS = ["", "⭐", "💼", "🏠", "👪", "🎮", "📚", "✈️", "🎵", "❤️", "⛰️", "🍕"];
/** Create or edit a local folder (name, colour, icon). Folders exist only in UniChat; nothing is sent to any network. */
export function FolderModal({ folder, onSave, onClose }: { folder?: Space; onSave: (v: { name: string; color: string; icon: string }) => void; onClose: () => void }) {
  const [name, setName] = useState(folder?.name ?? "");
  const [color, setColor] = useState(folder?.color ?? FOLDER_COLORS[0]);
  const [icon, setIcon] = useState(folder?.icon ?? "");
  const [allEmoji, setAllEmoji] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null); const [picErr, setPicErr] = useState("");
  return (
    <Modal title={folder ? "Edit folder" : "New folder"} onClose={onClose}>
      <p className="hint">Folders only exist in UniChat. Move any chat into one, from any account or network.</p>
      <div className="folderprev"><SpaceIcon size={56} space={{ id: "folder:preview", accountId: "", provider: "folder", name: name || "Folder", local: true, color, icon }} /></div>
      <form onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSave({ name: name.trim(), color, icon }); }}>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Work" /></label>
        <label>Colour</label>
        <ColourPicker value={color} onChange={(c) => setColor(c ?? FOLDER_COLORS[0]!)} />
        <label>Icon</label>
        <div className="iconupload">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (!f) return; try { setPicErr(""); const r = await squareImage(f, 128); setIcon(r.dataUrl); } catch (x: any) { setPicErr(x?.message || "Not a usable image."); } }} />
          <button type="button" className="secondary" onClick={() => fileRef.current?.click()}><ImageIcon size={14} /> Upload your own icon…</button>
          {icon.startsWith("data:image/") && <button type="button" className="secondary" onClick={() => setIcon("")}><Trash2 size={14} /> Remove picture</button>}
          {picErr && <span className="hint err">{picErr}</span>}
        </div>
        <div className="swatches" role="radiogroup" aria-label="Icon">{FOLDER_ICONS.map((i) => <button type="button" key={i || "glyph"} role="radio" aria-checked={i === icon} aria-label={i ? `Icon ${i}` : "Folder glyph"} className={"swatch ico" + (i === icon ? " on" : "")} onClick={() => setIcon(i)}>{i || <Folder size={16} />}</button>)}
          {icon && !FOLDER_ICONS.includes(icon) && !icon.startsWith("data:image/") && <button type="button" role="radio" aria-checked className="swatch ico on" title="Your emoji" aria-label={`Icon ${icon}`}><span className="fe">{icon}</span></button>}
          <button type="button" className="secondary" id="allemoji" onClick={() => setAllEmoji((v) => !v)}>{allEmoji ? "Hide emoji list" : "All emojis…"}</button>
        </div>
        {allEmoji && <div id="fullemoji" className="fullemoji"><FullEmojiPicker onClose={() => setAllEmoji(false)} onPick={(e) => { setIcon(e); setAllEmoji(false); }} /></div>}
        <button className="primary" disabled={!name.trim()}>{folder ? "Save" : "Create folder"}</button>
      </form>
    </Modal>
  );
}
/** "Move to folder…": Personal, every folder and community, and a new folder. Moving is local only. */
export function MoveModal({ chat, spaces, onMove, onNew, onClose, count, groupOnly }: { chat: Chat; spaces: Space[]; onMove: (folderId: string | null) => void; onNew: () => void; onClose: () => void; /** several selected chats move together */ count?: number; /** a rail group was the drop target: only its members are offered */ groupOnly?: boolean }) {
  const here = chat.spaceId ?? "personal";
  const orig = chat.networkSpaceId ? spaces.find((s) => s.id === chat.networkSpaceId)?.name ?? "its community" : "Personal";
  return (
    <Modal title={count && count > 1 ? `Move ${count} chats` : `Move “${chat.name}”`} onClose={onClose}>
      <p className="hint">Only changes where this chat is listed in UniChat. Nothing changes on the network and no messages move.</p>
      <ul className="pick tall movelist">
        {!groupOnly && <li><button className={"rowbtn" + (here === "personal" ? " sel" : "")} data-target="personal" onClick={() => onMove("personal")}><span className="foldericon sm" style={{ background: "var(--accent)" }}><MessageCircle size={14} color="#fff" /></span> Personal{here === "personal" && <Check size={14} className="where" />}</button></li>}
        {spaces.map((s) => (
          <li key={s.id}><button className={"rowbtn" + (here === s.id ? " sel" : "")} data-target={s.id} onClick={() => onMove(s.id)}><SpaceIcon space={s} size={28} />
            <span className="mname">{s.name}</span>{!s.local && <ProviderIcon provider={s.provider} size={14} />}{s.local && <small className="where">folder</small>}{here === s.id && <Check size={14} className="where" />}</button></li>))}
      </ul>
      {!groupOnly && <button className="secondary wide" onClick={onNew}><FolderPlus size={15} /> New folder…</button>}
      {!groupOnly && chat.folderId && <button className="secondary reset" onClick={() => onMove(null)}><RotateCcw size={15} /> Reset to original place ({orig})</button>}
    </Modal>
  );
}

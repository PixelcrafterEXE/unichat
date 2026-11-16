// In-memory stand-in for the sync RPCs so Settings > Sync devices can be tested without a backend.
// Test hooks (window): __mockSyncJoinRequest() makes "Pixel phone" ask to join this device (approval + digits),
// __mockSyncBlockOut(true) makes this device unable to reach the other one (the other one can still reach this one: "show a code here instead"),
// __mockSyncOffer() makes the other device offer a Signal account as proxy, __mockSyncDrop() takes the paired device offline.
type Emit = (ev: string, d: unknown) => void;
export const mockSyncHandles = (m: string) => /^sync(Status|StartPairing|StopPairing|Join|JoinNearby|Browse|ConfirmJoin|CancelJoin|ApproveJoin|Devices|Revoke|DismissRemoved|SetAccountMode|Pause|Resume|Now|Leave|Credentials|ConfirmCredentials|RenameDevice|SetListen|SetAddresses|SetAdvertise|SetRelays|SetDht|SetMediaPolicy|SetMetered|SetProxyShare|UseProxy|StopProxy|RelaySet|RelayAsk|MoveStart|MoveRespond|MoveCancel|MoveEstimate|SendHistory)$/.test(m);
const SAS = "482 913";
const S = { enabled: false, paused: false, revoked: false, deviceId: "dev-self", deviceName: "My laptop", pairing: undefined as any, approval: undefined as any, joining: undefined as any, devices: [] as any[],
  listen: { enabled: false, scope: "lan", address: "", interfaces: [{ name: "eth0", address: "192.168.1.20" }, { name: "tailscale0", address: "100.64.0.7" }] } as any, relays: [] as string[], dht: { enabled: true, bootstrap: [] as string[], state: "ready", reason: undefined as string | undefined } as any, advertise: [] as any[],
  media: { policy: { mode: "off", maxFileMB: 25, maxTotalMB: 2048 }, metered: false, wanted: 3, fetchedBytes: 0, active: null as any },
  proxy: { offers: [] as any[], using: [] as any[], shared: [] as string[], asks: [] as any[], decisions: [] as any[] },
  accounts: [{ id: "wa-1", provider: "whatsapp", label: "WhatsApp", mode: "archive-only", canShareCredentials: false, canShareProxy: true, canMove: true, proxyShared: false }, { id: "mm-1", provider: "mattermost", label: "Work Mattermost", mode: "archive-only", canShareCredentials: true, canShareProxy: true, proxyShared: false, canMove: true },
    { id: "ig-1", provider: "instagram", label: "Instagram", mode: "none", canShareCredentials: false, canShareProxy: false, moveWhy: "Signed out here (history only)" }] as any[],
  removedNotice: undefined as any, unlinking: undefined as any, moves: [] as any[], pendingCredentials: [] as any[], discovered: [] as any[], discovery: { available: true } };
let emitRef: Emit = () => {};
let dhtUnavailable = false; // test hook: this platform cannot load the DHT
let blockOut = false; // this device cannot dial out to the other one
const snap = () => ({ ...S, listening: S.listen.enabled || !!S.pairing, port: 43210, binds: S.listen.enabled || S.pairing ? ["192.168.1.20:43210"] : [], dialOnly: S.enabled && !S.listen.enabled && !S.pairing, entities: 1234, pending: 0, groupId: S.enabled ? "g1" : undefined });
const changed = () => emitRef("sync-devices", snap());
/** this device forgets the group (the archive stays) */
const wipe = (notice?: any) => { S.enabled = false; S.devices = []; S.revoked = false; S.pairing = undefined; S.approval = undefined; S.joining = undefined; S.listen.enabled = false; S.unlinking = undefined; S.removedNotice = notice; S.proxy = { offers: [], using: [], shared: [], asks: [], decisions: [] }; changed(); return {}; };
/** group of two: the other device is told to unlink first; offline = the instruction waits (shown as "unlinking", delivered by __mockSyncPeerOnline) */
const unlink = (d: any, reason: string) => { if (d.online) { wipe(); return { pending: false, deviceName: d.name }; } S.unlinking = { peer: d.id, name: d.name, since: new Date().toISOString(), reason, online: false }; changed(); return { pending: true, deviceName: d.name }; };
const other = (id: string, name: string) => ({ id, name, online: true, via: "192.168.1.31:43210", viaKind: "direct", lastAddr: "192.168.1.31", addrs: [{ kind: "tcp", host: "192.168.1.31", port: 43210, src: "learned", good: new Date().toISOString() }], progress: { state: "idle", pending: 0, lastSync: new Date().toISOString() } });
if (typeof window !== "undefined") {
  Object.assign(window, {
    __mockSyncJoinRequest: (nearby = false) => { S.approval = { direction: "incoming", deviceName: "Pixel phone", sas: SAS, since: Date.now(), expiresAt: Date.now() + 120_000, nearby: !!nearby }; changed(); },
    /** a device that shows "Add a device" appears (or disappears) in the nearby list */
    __mockSyncNearby: (on = true) => { S.discovered = on ? [{ instance: "unichat-x", name: "Desktop", host: "192.168.1.31", port: 45045, nearby: true }] : []; changed(); },
    __mockSyncDhtUnavailable: (b = true) => { dhtUnavailable = !!b; },
    __mockSyncBlockOut: (b: boolean) => { blockOut = !!b; },
    /** the other device (which was shown a code here) connects to this device and asks to be joined, or, with `joining`, this device joins its group */
    __mockSyncIncomingJoining: () => { S.joining = { state: "confirm", sas: SAS, hostName: "Desktop", direction: "incoming" }; changed(); },
    __mockSyncOffer: () => { S.proxy.offers = [{ deviceId: "dev-a", deviceName: "Desktop", accountId: "signal-1", provider: "signal", label: "Signal (+49…)", using: false }]; if (!S.accounts.some((a) => a.id === "signal-1")) S.accounts.push({ id: "signal-1", provider: "signal", label: "Signal (+49…)", mode: "archive-only", canShareCredentials: false, canShareProxy: false, moveWhy: "Used through Desktop", proxyShared: false }); changed(); },
    /** this device is removed from the group by another device (or the other device of a group of two unlinks): notice + unlinked */
    __mockSyncRemoved: (by = "Desktop", reason = "removed") => { wipe({ by, at: new Date().toISOString(), reason }); },
    /** the offline device we wait for (pending unlink) comes online and unlinks: so do we */
    __mockSyncPeerOnline: () => { if (S.unlinking) wipe(); },
    /** a removed (offline) device came back, was told and confirmed */
    __mockSyncRemovalAcked: (name?: string) => { for (const d of S.devices) if (d.revoked && (!name || d.name === name)) d.removalPending = false; changed(); },
    __mockSyncDrop: () => { const d = S.devices.find((x) => !x.self); if (d) { d.online = false; d.progress = { ...d.progress, state: "offline" }; } for (const u of S.proxy.using) u.online = false; for (const a of S.accounts) if (a.proxyVia) { a.proxyVia.online = false; a.proxyVia.note = "home device unreachable"; } changed(); },
    /** a paired device asks to send as an account of this device (the one-time question) */
    __mockRelayPrompt: (device = "Pixel phone", acct = "mm-1") => { const a = S.accounts.find((x) => x.id === acct); S.proxy.asks = [{ deviceId: S.devices.find((d) => d.name === device)?.id ?? "dev-b", deviceName: device, accountId: acct, label: a?.label ?? acct, since: Date.now() }]; changed(); },
    __mockSyncSnapshot: () => { const d = S.devices.find((x) => !x.self); if (d) d.progress = { state: "syncing", pending: 0, phase: "snapshot", snapDone: 4_000_000, snapTotal: 10_000_000, snapDir: "in" }; changed(); },
  });
}
// ---- device-to-device move (mock of packages/sync/src/move.ts). Hooks: __mockSyncAddDevice(name, online), __mockMoveMode("ok"|"deny"|"drop"), __mockMoveHold(bool),
// __mockMoveIncoming(label) = another device asks to move an account HERE, __mockMoveRemoteCancel(), __mockMoveOffline(bool)
const MV = { histFail: false, fail: new Set<string>(), mode: "ok" as "ok" | "deny" | "drop", hold: false, n: 0, dead: new Set<string>() };
const mvPatch = (tid: string, patch: any) => { const m = S.moves.find((x) => x.tid === tid); if (m) Object.assign(m, patch); changed(); return m; };
const histOf = (media: boolean) => ({ m: 88000, f: media ? 9300 : 0, b: media ? 540 * 1048576 : 40 * 1048576 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function mvTransfer(tid: string, kbTotal: number) {
  const m0 = () => S.moves.find((x) => x.tid === tid)!, login = m0().kind !== "history", hist = m0().hist, base = login ? 3_400_000 : 0;
  mvPatch(tid, { phase: "sending", stage: "login", done: 0 });
  for (let i = 1; login && i <= 5; i++) {
    await sleep(110); while (MV.hold && !MV.dead.has(tid)) await sleep(40);
    if (MV.dead.has(tid)) return false;
    if (MV.mode === "drop" && i === 3) { mvPatch(tid, { phase: "failed", error: "The connection to the other device was lost. Nothing changed." }); return false; }
    mvPatch(tid, { phase: "sending", done: Math.round((kbTotal * 1024 * i) / 5) });
  }
  for (let i = 1; hist && i <= 5; i++) {
    await sleep(110); while (MV.hold && !MV.dead.has(tid)) await sleep(40);
    if (MV.dead.has(tid)) return false;
    if (MV.histFail && i === 3) { mvPatch(tid, { phase: "failed", histFailed: true, error: "The chat history could not be transferred: the connection was lost. Nothing was moved." }); return false; }
    mvPatch(tid, { phase: "sending", stage: "history", done: base + Math.round((hist.b * i) / 5), histDone: { m: Math.round((hist.m * i) / 5), f: Math.round((hist.f * i) / 5) } });
  }
  if (login) { mvPatch(tid, { phase: "finishing" }); await sleep(160); }
  return !MV.dead.has(tid);
}
if (typeof window !== "undefined") Object.assign(window, {
  __mockSyncAddDevice: (name = "Pixel phone", online = true) => { S.enabled = true; if (!S.devices.some((d) => d.self)) S.devices.unshift({ id: "dev-self", name: S.deviceName, self: true, online: true }); S.devices.push({ ...other("dev-" + name.replace(/\W+/g, "-").toLowerCase(), name), online }); changed(); },
  __mockSyncSharedFrom: (id: string, name = "Desktop") => { const a = S.accounts.find((x) => x.id === id); if (a) { a.sharedFrom = name; a.canShareCredentials = false; a.canShareProxy = false; } changed(); },
  __mockMoveHistFail: (b: boolean) => { MV.histFail = !!b; }, __mockMoveFail: (id: string) => { MV.fail.add(id); }, __mockMoveMode: (m: "ok" | "deny" | "drop") => { MV.mode = m; }, __mockMoveHold: (b: boolean) => { MV.hold = !!b; },
  __mockMoveOffline: (b: boolean) => { for (const d of S.devices) if (!d.self) d.online = !b; changed(); },
  __mockMoveRemoteCancel: () => { const m = S.moves.find((x) => ["waiting", "sending", "confirm"].includes(x.phase)); if (m) { for (const x of S.moves) if (m.batch ? x.batch?.id === m.batch.id : x.tid === m.tid) if (x.phase !== "done" && x.phase !== "failed") { MV.dead.add(x.tid); mvPatch(x.tid, { phase: "failed", error: "The other device cancelled." }); } } },
  __mockMoveIncoming: (label = "Signal (+49…)", n = 1, withHist = false) => {
    const items = Array.from({ length: n }, (_, i) => ({ acct: "signal-" + (9 + i), provider: i % 2 ? "whatsapp" : "signal", label: n === 1 ? label : i === 0 ? label : i % 2 ? "WhatsApp " + i : "Signal " + i })), bid = "b" + ++MV.n; let first = "";
    items.forEach((it, i) => { const tid = "in" + ++MV.n; first ||= tid; S.moves.push({ tid, role: "in", acct: it.acct, provider: it.provider, label: it.label, peer: "dev-b", peerName: "Pixel phone", from: "Pixel phone", to: S.deviceName, state: "asking", phase: i ? "queued" : "confirm", done: 0, total: 3_400_000, at: Date.now() - i, ...(withHist ? { history: { media: true, removeAfter: false }, hist: histOf(true) } : {}), ...(n > 1 ? { batch: { id: bid, n, i, items } } : {}) }); });
    changed(); return first;
  },
});
const relayLog: { method: string; params: any }[] = []; (globalThis as any).__mockRelayLog = relayLog;
const syncLog: { method: string; params: any }[] = []; (globalThis as any).__mockSyncLog = syncLog;
export async function mockSyncCall(method: string, p: any, emit: Emit): Promise<any> {
  emitRef = emit; if (/^(syncMove|syncSendHistory)/.test(method)) syncLog.push({ method, params: JSON.parse(JSON.stringify(p ?? {})) });
  switch (method) {
    case "syncStatus": return snap();
    case "syncDevices": return S.devices;
    case "syncBrowse": return { available: true };
    case "syncStartPairing": {
      S.joining = undefined; S.enabled = true; if (!S.devices.length) S.devices = [{ id: "dev-self", name: p.deviceName || S.deviceName, self: true, online: true }]; S.deviceName = p.deviceName || S.deviceName;
      const code = "bako-lemi-zuta-nosu"; S.pairing = { code, expiresAt: Date.now() + 300_000, failures: 0, maxFailures: 20, hosts: ["192.168.1.20"], port: 45045, link: `unichat-sync://pair?h=192.168.1.20&p=45045&c=${code.replace(/-/g, "")}&k=abc` };
      if (p.keepListening) S.listen.enabled = true;
      return S.pairing;
    }
    case "syncStopPairing": S.pairing = undefined; return {};
    case "syncApproveJoin": {
      if (!S.approval) throw new Error("No device is waiting for approval.");
      if (p.accept === false) { S.approval = undefined; changed(); return {}; }
      S.approval.hostOk = true; changed(); // the other person still has to confirm on their device
      setTimeout(() => { S.devices.push({ ...other("dev-b", S.approval?.deviceName ?? "Pixel phone"), progress: { state: "syncing", pending: 120, lastSync: undefined } }); S.pairing = undefined; S.approval = undefined; changed(); setTimeout(() => { const d = S.devices[S.devices.length - 1]; d.progress = { state: "idle", pending: 0, lastSync: new Date().toISOString() }; emit("sync-progress", {}); }, 700); }, 300);
      return {};
    }
    case "syncJoinNearby": {
      await new Promise((r) => setTimeout(r, 100));
      if (blockOut) { const error = "Couldn't reach that device. Make sure both are on the same Wi-Fi and it still shows \"Add a device\"."; S.joining = { state: "failed", reason: "unreachable", error }; throw new Error(error); }
      S.joining = { state: "confirm", sas: SAS, hostName: "Desktop", direction: "outgoing", nearby: true }; return { sas: SAS, hostName: "Desktop", role: "joiner" };
    }
    case "syncJoin": {
      if (p.link) { const m = /[?&]c=([a-z]+)/.exec(p.link); p = { ...p, code: m ? m[1] : "" }; }
      if (!p.code?.trim()) throw new Error("Enter the pairing code shown on the other device.");
      await new Promise((r) => setTimeout(r, 150)); // "looking for the other device"
      if (blockOut) { const error = "Couldn't reach a device showing that code. If the other device blocks incoming connections, show a code on this device instead and type it there."; S.joining = { state: "failed", reason: "unreachable", error }; throw new Error(error); }
      if (p.code?.replace(/-/g, "") !== "bakolemizutanosu") { const error = "The pairing code was not accepted (wrong code, expired, or too many attempts)."; S.joining = { state: "failed", reason: "code", error }; throw new Error(error); }
      S.joining = { state: "confirm", sas: SAS, hostName: "Desktop", direction: "outgoing" }; return { sas: SAS, hostName: "Desktop", role: "joiner", via: "192.168.1.20:45045" };
    }
    case "syncCancelJoin": S.joining = undefined; return {};
    case "syncConfirmJoin": {
      if (p.accept === false) { S.joining = undefined; return {}; }
      S.joining = { state: "waiting", sas: SAS, hostName: "Desktop" }; changed();
      setTimeout(() => {
        S.joining = undefined; S.pairing = undefined; S.enabled = true; if (p.keepListening) S.listen.enabled = true;
        S.devices = [{ id: "dev-self", name: S.deviceName, self: true, online: true }, { ...other("dev-a", "Desktop"), progress: { state: "syncing", pending: 0, phase: "snapshot", snapDone: 2_000_000, snapTotal: 8_000_000, snapDir: "in" } }]; changed();
        setTimeout(() => { S.devices[1].progress = { state: "idle", pending: 0, lastSync: new Date().toISOString() }; emit("sync-progress", {}); }, 600);
      }, 300);
      return { deviceId: "dev-self" };
    }
    case "syncRevoke": { // mock of service.ts: three or more devices = tombstone for everybody; only two = both unlink (now, or when the other one is online)
      const d = S.devices.find((x) => x.id === p.deviceId); if (!d) return {};
      if (S.devices.filter((x) => !x.revoked).length <= 2) return unlink(d, "remove");
      d.revoked = new Date().toISOString(); d.revokedBy = S.deviceName; d.removalPending = !d.online; changed(); return {}; }
    case "syncDismissRemoved": S.removedNotice = undefined; changed(); return {};
    case "syncSetAccountMode": { const a = S.accounts.find((x) => x.id === p.accountId); if (!a) throw new Error("Unknown account."); if (p.mode === "credentials" && a.sharedFrom) throw new Error(`This account comes from ${a.sharedFrom}; share it from there.`); if (p.mode === "credentials" && !a.canShareCredentials) throw new Error("This messenger's sessions cannot be copied to other devices."); a.mode = p.mode; return {}; }
    case "syncSetListen": {
      if (p.enabled && p.scope === "address" && !S.listen.interfaces.some((i: any) => i.address === p.address)) throw new Error(`This computer has no network interface with the address ${p.address || "(none)"}.`);
      S.listen = { ...S.listen, enabled: !!p.enabled, scope: p.scope ?? S.listen.scope, address: p.address ?? S.listen.address }; return { ...S.listen };
    }
    case "syncSetAddresses": { const d = S.devices.find((x) => x.id === p.deviceId); if (!d) throw new Error("Unknown device."); d.addrs = [...(d.addrs ?? []).filter((a: any) => a.src !== "manual"), ...(p.addrs ?? []).map((a: any) => ({ ...a, src: "manual" }))]; return {}; }
    case "syncSetAdvertise": S.advertise = p.addrs ?? []; return {};
    case "syncSetDht": {
      for (const b of p.bootstrap ?? []) if (!/^.+:\d{1,5}$/.test(b)) throw new Error(`"${b}" is not a bootstrap node. Write it as host:port, for example dht.example.org:49737.`);
      S.dht = { ...S.dht, ...(p.enabled === undefined ? {} : { enabled: !!p.enabled }), ...(p.bootstrap === undefined ? {} : { bootstrap: p.bootstrap }) };
      S.dht.state = !S.dht.enabled ? "off" : dhtUnavailable ? "unavailable" : "ready"; S.dht.reason = S.dht.state === "unavailable" ? "not available on this platform: the native add-on could not be loaded" : undefined; changed(); return { ...S.dht }; }
    case "syncSetRelays": { for (const u of p.urls ?? []) if (!/^wss?:\/\//.test(u)) throw new Error(`"${u}" is not a relay address (it looks like wss://relay.example.org/relay).`); S.relays = p.urls ?? []; return {}; }
    case "syncSetMediaPolicy": S.media.policy = { ...S.media.policy, ...p }; return S.media.policy;
    case "syncSetMetered": S.media.metered = !!p.metered; return {};
    case "syncSetProxyShare": { const a = S.accounts.find((x) => x.id === p.accountId); if (!a) throw new Error("Unknown account."); if (p.enabled && a.sharedFrom) throw new Error(`This account comes from ${a.sharedFrom}; share it from there.`); a.proxyShared = !!p.enabled; S.proxy.shared = S.accounts.filter((x) => x.proxyShared).map((x) => x.id); return {}; }
    case "syncUseProxy": {
      const o = S.proxy.offers.find((x) => x.accountId === p.accountId && x.deviceId === p.deviceId); if (!o) throw new Error("That device does not offer this account (it may be offline, or sharing was switched off).");
      o.using = true; S.proxy.using.push({ accountId: o.accountId, home: o.deviceId, homeName: o.deviceName, online: true });
      const a = S.accounts.find((x) => x.id === p.accountId); if (a) a.proxyVia = { deviceId: o.deviceId, deviceName: o.deviceName, online: true }; return {};
    }
    case "syncRelaySet": {
      const a = S.accounts.find((x) => x.id === p.accountId), d = S.devices.find((x) => x.id === p.deviceId && !x.self); if (!a || !d) throw new Error("Unknown device.");
      S.proxy.asks = S.proxy.asks.filter((x: any) => !(x.deviceId === p.deviceId && x.accountId === p.accountId));
      S.proxy.decisions = S.proxy.decisions.filter((x: any) => !(x.deviceId === p.deviceId && x.accountId === p.accountId));
      if (p.allow === true || p.allow === false) S.proxy.decisions.push({ deviceId: d.id, deviceName: d.name, accountId: a.id, label: a.label, allowed: !!p.allow });
      relayLog.push({ method, params: JSON.parse(JSON.stringify(p)) }); changed(); return {};
    }
    case "syncRelayAsk": relayLog.push({ method, params: JSON.parse(JSON.stringify(p)) }); return { state: "pending" };
    case "syncStopProxy": { S.proxy.using = S.proxy.using.filter((u: any) => u.accountId !== p.accountId); for (const o of S.proxy.offers) if (o.accountId === p.accountId) o.using = false; const a = S.accounts.find((x) => x.id === p.accountId); if (a) delete a.proxyVia; return {}; }
    case "syncMoveStart": {
      const ids: string[] = p.accountIds ?? [p.accountId], d = S.devices.find((x) => x.id === p.deviceId && !x.self);
      if (p.confirmed !== true) throw new Error("Confirm the move first.");
      for (const id of ids) if (!S.accounts.find((x) => x.id === id)?.canMove) throw new Error("This account is not signed in on this device, so there is nothing to move.");
      if (!d) throw new Error("That device is not one of your paired devices."); if (!d.online) throw new Error("That device is not online right now.");
      const bid = "b" + ++MV.n, items = ids.map((id) => { const a = S.accounts.find((x) => x.id === id)!; return { acct: a.id, provider: a.provider, label: a.label }; }), tids: string[] = [];
      items.forEach((it, i) => { const tid = "out" + ++MV.n; tids.push(tid); S.moves.push({ tid, role: "out", acct: it.acct, provider: it.provider, label: it.label, peer: d.id, peerName: d.name, from: S.deviceName, to: d.name, state: "asking", phase: i ? "queued" : "waiting", done: 0, total: 3_400_000 + (p.includeHistory === false ? 0 : histOf(p.includeMedia !== false).b), at: Date.now() - i, ...(p.includeHistory === false ? {} : { history: { media: p.includeMedia !== false, removeAfter: p.removeHistoryAfter === true }, hist: histOf(p.includeMedia !== false) }), ...(ids.length > 1 ? { batch: { id: bid, n: ids.length, i, items } } : {}) }); });
      changed();
      void (async () => {
        for (let i = 0; i < tids.length; i++) {
          const tid = tids[i], a = S.accounts.find((x) => x.id === ids[i])!, m = S.moves.find((x) => x.tid === tid)!;
          if (MV.dead.has(tid) || m.phase === "failed") { if (m.phase !== "failed") mvPatch(tid, { phase: "failed", error: "Cancelled." }); continue; }
          mvPatch(tid, { phase: "waiting" }); await sleep(260); if (MV.dead.has(tid)) continue;
          if (MV.mode === "deny") { for (const t of tids.slice(i)) mvPatch(t, { phase: "failed", error: "The other device said no." }); return; }
          if (MV.fail.has(a.id)) { mvPatch(tid, { phase: "failed", error: "The other device could not start this account." }); continue; }
          if (!(await mvTransfer(tid, 3320))) { if (S.moves.find((x) => x.tid === tid)?.error?.startsWith("Cancelled")) { for (const t of tids.slice(i + 1)) mvPatch(t, { phase: "failed", error: "Cancelled." }); return; } if (MV.mode === "drop") { for (const t of tids.slice(i + 1)) mvPatch(t, { phase: "failed", error: "The connection to the other device was lost. Nothing changed." }); return; } continue; }
          a.canMove = false; a.moveWhy = "Signed out here (history only)"; a.mode = "none"; mvPatch(tid, { phase: "done" });
        }
      })();
      return { transferId: tids[0], transferIds: tids };
    }
    case "syncMoveEstimate": { const ids: string[] = p.accountIds ?? [p.accountId], h = histOf(p.includeMedia !== false); return { accounts: ids.map((id) => ({ id, label: id, messages: h.m, files: h.f, bytes: h.b })), messages: h.m * ids.length, files: h.f * ids.length, bytes: h.b * ids.length }; }
    case "syncSendHistory": {
      const a = S.accounts.find((x) => x.id === p.accountId), d = S.devices.find((x) => x.id === p.deviceId && !x.self); if (!a || !d?.online) throw new Error("That device is not online right now.");
      const tid = "out" + ++MV.n, h = histOf(p.includeMedia !== false); S.moves.push({ tid, role: "out", kind: "history", acct: a.id, provider: a.provider, label: a.label, peer: d.id, peerName: d.name, from: S.deviceName, to: d.name, state: "asking", phase: "waiting", done: 0, total: h.b, at: Date.now(), history: { media: true, removeAfter: false }, hist: h }); changed();
      void (async () => { await sleep(260); if (MV.dead.has(tid)) return; if (MV.mode === "deny") { mvPatch(tid, { phase: "failed", error: "The other device said no." }); return; } if (await mvTransfer(tid, 0)) mvPatch(tid, { phase: "done" }); })();
      return { transferId: tid };
    }
    case "syncMoveRespond": {
      const m = S.moves.find((x) => x.tid === p.transferId && x.role === "in" && x.phase === "confirm"); if (!m) throw new Error("There is nothing to confirm.");
      const rows = m.batch ? S.moves.filter((x) => x.batch?.id === m.batch.id) : [m];
      if (p.accept !== true) { for (const r of rows) mvPatch(r.tid, { phase: "failed", error: "You said no." }); return {}; }
      const allowed = (r: any) => !p.accountIds || p.accountIds.includes(r.acct);
      void (async () => {
        for (const r of rows) {
          if (!allowed(r)) { mvPatch(r.tid, { phase: "failed", error: "You chose not to receive this one." }); continue; }
          mvPatch(r.tid, { phase: "sending" });
          if (!(await mvTransfer(r.tid, 3320))) { if (MV.dead.has(r.tid)) { for (const q of rows) if (!["done", "failed"].includes(S.moves.find((x) => x.tid === q.tid)!.phase)) mvPatch(q.tid, { phase: "failed", error: "Cancelled." }); return; } continue; }
          if (!S.accounts.some((x) => x.id === r.acct)) S.accounts.push({ id: r.acct, provider: r.provider, label: r.label, mode: "archive-only", canMove: true }); mvPatch(r.tid, { phase: "done" });
        }
      })();
      return {};
    }
    case "syncMoveCancel": {
      const m = S.moves.find((x) => x.tid === p.transferId); if (!m) throw new Error("Unknown move.");
      if (m.phase === "finishing") throw new Error("It is too late to cancel: the other device is taking over. Wait a moment.");
      if (m.phase !== "done" && m.phase !== "failed") { MV.dead.add(m.tid); mvPatch(m.tid, { phase: "failed", error: "Cancelled." }); if (m.batch && m.role === "out") for (const x of S.moves) if (x.batch?.id === m.batch.id && x.phase === "queued") { MV.dead.add(x.tid); mvPatch(x.tid, { phase: "failed", error: "Cancelled." }); } } return {};
    }
    case "syncPause": S.paused = true; return {};
    case "syncResume": S.paused = false; return {};
    case "syncNow": return {};
    case "syncLeave": { const live = S.devices.filter((x) => !x.self && !x.revoked); if (!p?.force && S.enabled && live.length === 1) return unlink(live[0], "leave"); wipe(); return {}; }
    case "syncCredentials": return S.pendingCredentials;
    case "syncConfirmCredentials": S.pendingCredentials = S.pendingCredentials.filter((c) => c.accountId !== p.accountId); return {};
    case "syncRenameDevice": { S.deviceName = p.name; const me = S.devices.find((d) => d.self); if (me) me.name = p.name; return {}; }
  }
}

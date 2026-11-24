// "Remote account": an account whose real connection (Signal, WhatsApp, ...) lives on ANOTHER of the user's devices (the HOME device).
// This device never holds the session: every Connector call is forwarded through a RemoteLink (packages/sync supplies one that rides the
// encrypted device-sync channel) to the home device's connector, and the home device's events come back as ordinary CoreEvents.
//
// Wire contract (all ids are NATIVE ids, exactly what a local connector would see; the home device adds/removes the account prefix):
//   request   op + JSON args  ->  JSON result          (see PROXY_OPS; anything else is refused by the home device)
//   event     {type, data}                              (message, message-update, receipt, typing, chats-changed, spaces-changed, account)
// Never crossing the link: session files, keys, login prompts (`login` events), logout, submitLogin. (Own profile and privacy settings do cross it: the home device applies them.)
import { randomBytes } from "node:crypto";
import type { Capabilities, Chat, Connector, Contact, CoreEvent, HistoryQuery, Message, OutgoingMessage, PersonAlias, PrivacySetting, Profile, ProfilePatch, Space } from "@unimsg/core";

/** Operations the home device will perform for a proxy account (an allow-list: unknown ops are rejected there). */
export const PROXY_OPS = [
  "info", "spaces", "chats", "history", "members", "attachment", "avatar", "send", "react", "edit", "delete", "setTyping", "markRead", "vote", "editEvent", "refreshChat", "openThread", "aliases", "privateChat",
  "acceptRequest", "declineRequest", "leaveChat", "addMembers", "removeMember", "renameChat", "blockChat", "setChatPicture", "setChatDescription", "setDisappearing",
  "startChat", "createGroup", "createSpace", "joinSpace", "leaveSpace", "sync",
  "getProfile", "updateProfile", "getPrivacy", "setPrivacy",
] as const;
/** Operations that change something on the account. Each carries a request id so the holder never executes a repeated request twice (see packages/sync proxy.ts). */
export const PROXY_WRITE_OPS = new Set<string>(["send", "react", "edit", "delete", "vote", "editEvent", "startChat", "createGroup", "createSpace", "joinSpace", "leaveSpace", "leaveChat", "addMembers", "removeMember", "renameChat", "blockChat", "setChatPicture", "setChatDescription", "setDisappearing", "acceptRequest", "declineRequest", "updateProfile", "setPrivacy"]);
export type ProxyOp = (typeof PROXY_OPS)[number];
export const isProxyOp = (s: unknown): s is ProxyOp => typeof s === "string" && (PROXY_OPS as readonly string[]).includes(s);

export class RemoteError extends Error { constructor(public code: "unreachable" | "refused" | "failed", message: string) { super(message); this.name = "RemoteError"; } }
export interface RemoteInfo { capabilities?: Capabilities; state: string; provider: string; label: string }
export interface RemoteLink {
  /** Forward an operation to the home device. Rejects with RemoteError("unreachable") when the home device is not connected right now. */
  call(op: ProxyOp, args: Record<string, unknown>, requestId?: string): Promise<any>;
  home(): { name: string; online: boolean };
  /** events of the home device for this account; returns an unsubscribe function */
  onEvent(l: (e: CoreEvent) => void): () => void;
  /** the home device connected / disconnected */
  onPresence(l: (online: boolean) => void): () => void;
}
const b64 = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(String(s ?? ""), "base64"));

export class RemoteConnector implements Connector {
  private caps?: Capabilities; private offs: (() => void)[] = []; private emit: (e: CoreEvent) => void = () => {}; private stopped = false;
  constructor(private link: RemoteLink, private accountId: string) {}
  get capabilities(): Capabilities { return this.caps as Capabilities; } // undefined until the home device told us: the Hub then shows the provider's own capabilities
  /** "Home device unreachable" text for the UI. */
  get homeNote() { const h = this.link.home(); return h.online ? undefined : `${h.name} is offline: this account is a read-only archive until it is back.`; }

  async start(emit: (e: CoreEvent) => void) {
    this.emit = emit; this.stopped = false;
    this.offs.push(this.link.onEvent((e) => { if (!this.stopped) this.forward(e); }), this.link.onPresence((on) => { if (!this.stopped) void this.presence(on); }));
    await this.presence(this.link.home().online);
  }
  private forward(e: CoreEvent) {
    if (e.type === "login" || e.type === "verification") return; // login prompts and verification dialogs of the home device are never shown here
    if (e.type === "account") { if (e.data.state === "connected") void this.refreshInfo(); else this.emit({ type: "account", data: { id: this.accountId, state: "disconnected", detail: `signed out or disconnected on ${this.link.home().name}` } }); return; }
    this.emit(e);
  }
  private async presence(on: boolean) {
    if (!on) { this.emit({ type: "account", data: { id: this.accountId, state: "disconnected", detail: `${this.link.home().name} is offline` } }); return; }
    await this.refreshInfo();
  }
  private async refreshInfo() {
    try {
      const i = (await this.link.call("info", {})) as RemoteInfo; if (i.capabilities) this.caps = i.capabilities;
      this.emit({ type: "account", data: { id: this.accountId, state: i.state === "connected" ? "connected" : "disconnected", ...(i.state === "connected" ? {} : { detail: "not connected on the home device" }) } });
      this.emit({ type: "chats-changed", data: {} }); this.emit({ type: "spaces-changed", data: {} });
    } catch (e) { this.emit({ type: "account", data: { id: this.accountId, state: "disconnected", detail: (e as Error).message } }); }
  }
  async stop() { this.stopped = true; for (const o of this.offs.splice(0)) o(); }
  async logout() { /* a proxy has no session of its own and must never log the real account out */ }
  async submitLogin() { throw new Error("This account is signed in on another device. Sign in there."); }

  private async c<T>(op: ProxyOp, args: Record<string, unknown> = {}, requestId?: string): Promise<T> {
    try { return (await this.link.call(op, args, PROXY_WRITE_OPS.has(op) ? requestId ?? randomBytes(16).toString("hex") : undefined)) as T; }
    catch (e) {
      if (e instanceof RemoteError && e.code === "unreachable") throw Object.assign(new Error(`${this.link.home().name} is offline, so you can't do that now: this account is read-only until it is back.`), { code: "unreachable" });
      throw e;
    }
  }
  spaces() { return this.c<Space[]>("spaces"); }
  chats() { return this.c<Chat[]>("chats"); }
  history(chatId: string, q: HistoryQuery) { return this.c<Message[]>("history", { chatId, limit: q.limit, beforeMessageId: q.beforeMessageId }); }
  members(chatId: string) { return this.c<Contact[]>("members", { chatId }); }
  async downloadAttachment(chatId: string, messageId: string, attachmentId: string) {
    const r = await this.c<{ dataBase64: string; mime: string; name?: string }>("attachment", { chatId, messageId, attachmentId });
    return { data: unb64(r.dataBase64), mime: r.mime, name: r.name };
  }
  send(chatId: string, msg: OutgoingMessage) {
    // the same clientId (a Retry, a scheduled message trying again) is the same request: the holder sends it once
    return this.c<Message>("send", { chatId, msg: { ...msg, clientId: undefined, attachments: msg.attachments?.map((a) => ({ ...a, data: undefined, dataBase64: b64(a.data) })) } }, msg.clientId);
  }
  react(chatId: string, messageId: string, emoji: string | null) { return this.c<void>("react", { chatId, messageId, emoji }); }
  edit(chatId: string, messageId: string, newText: string) { return this.c<void>("edit", { chatId, messageId, text: newText }); }
  delete(chatId: string, messageId: string) { return this.c<void>("delete", { chatId, messageId }); }
  setTyping(chatId: string, typing: boolean) { return this.c<void>("setTyping", { chatId, typing }); }
  markRead(chatId: string, upToMessageId: string) { return this.c<void>("markRead", { chatId, messageId: upToMessageId }); }
  vote(chatId: string, messageId: string, optionIds: string[]) { return this.c<void>("vote", { chatId, messageId, optionIds }); }
  editEvent(chatId: string, messageId: string, patch: object) { return this.c<void>("editEvent", { chatId, messageId, patch }); }
  openThread(threadId: string) { return this.c<Chat>("openThread", { chatId: threadId }); }
  threadOf(chatId: string, messageId: string) { return this.c<Chat>("openThread", { chatId, messageId }); }
  privateChatWith(senderId: string) { return this.c<Chat>("privateChat", { senderId }); }
  aliases(chatId: string) { return this.c<PersonAlias[]>("aliases", { chatId }); }
  async refreshChat(chatId: string) { const r = await this.c<{ message?: string } | string>("refreshChat", { chatId }); return typeof r === "string" ? r : r?.message ?? ""; }
  acceptRequest(chatId: string) { return this.c<void>("acceptRequest", { chatId }); }
  declineRequest(chatId: string) { return this.c<void>("declineRequest", { chatId }); }
  leaveChat(chatId: string) { return this.c<void>("leaveChat", { chatId }); }
  addMembers(chatId: string, handles: string[]) { return this.c<void>("addMembers", { chatId, handles }); }
  removeMember(chatId: string, memberId: string) { return this.c<void>("removeMember", { chatId, memberId }); }
  renameChat(chatId: string, name: string) { return this.c<void>("renameChat", { chatId, name }); }
  blockChat(chatId: string, blocked: boolean) { return this.c<void>("blockChat", { chatId, blocked }); }
  setDisappearing(chatId: string, seconds: number) { return this.c<void>("setDisappearing", { chatId, seconds }); }
  setChatDescription(chatId: string, text: string) { return this.c<void>("setChatDescription", { chatId, text }); }
  setChatPicture(chatId: string, image: { data: Uint8Array; mime: string } | null) { return this.c<void>("setChatPicture", { chatId, ...(image ? { dataBase64: b64(image.data), mime: image.mime } : {}) }); }
  startChat(handle: string) { return this.c<Chat>("startChat", { handle }); }
  createGroup(name: string, handles: string[]) { return this.c<Chat>("createGroup", { name, handles }); }
  createSpace(name: string, description?: string) { return this.c<Space>("createSpace", { name, description }); }
  joinSpace(invite: string) { return this.c<Space>("joinSpace", { invite }); }
  leaveSpace(spaceId: string) { return this.c<void>("leaveSpace", { spaceId }); }
  async sync() { await this.c<void>("sync"); }
  // own profile + privacy: applied by the home device (the account's real connector)
  private profileIn(r: { displayName?: string; about?: string; handle?: string; avatar?: { dataBase64: string; mime: string } | null }): Profile {
    return { displayName: r?.displayName, about: r?.about, handle: r?.handle, ...(r?.avatar ? { avatar: { data: unb64(r.avatar.dataBase64), mime: r.avatar.mime } } : {}) };
  }
  async getProfile() { return this.profileIn(await this.c("getProfile")); }
  async updateProfile(patch: ProfilePatch) {
    return this.profileIn(await this.c("updateProfile", { ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}), ...(patch.about !== undefined ? { about: patch.about } : {}),
      ...(patch.avatar === null ? { avatar: null } : patch.avatar ? { avatar: { dataBase64: b64(patch.avatar.data), mime: patch.avatar.mime } } : {}) }));
  }
  getPrivacy() { return this.c<PrivacySetting[]>("getPrivacy"); }
  setPrivacy(id: string, value: string) { return this.c<PrivacySetting[]>("setPrivacy", { id, value }); }
  async avatar(t: { kind: "chat" | "space" | "contact" | "emoji"; id: string }) {
    const r = await this.c<{ dataBase64: string; mime: string } | null>("avatar", t);
    return r ? { data: unb64(r.dataBase64), mime: r.mime } : undefined;
  }
}

// Mesh-Groups: a virtual group living only in the user's core. Members are 1:1
// chats on any platform; the user's own accounts relay every message to all
// other members. Chat ids are the hub's GLOBAL ids ("<account>:<native>").
// Relaying goes through an injected `enqueue` so each member delivery is a
// durable, retried job instead of fire-and-forget.
import { randomUUID } from "node:crypto";
import type { Message } from "./model.js";

export interface MeshMember { name: string; chatId: string }
export interface MeshGroup { id: string; name: string; members: MeshMember[] }

export class MeshRelay {
  private groups = new Map<string, MeshGroup>();
  private hist = new Map<string, Message[]>(); // TODO: persist messages
  private seen = new Set<string>();            // duplicate / loop guard

  constructor(
    private enqueueSend: (chatId: string, text: string) => void,
    private emit: (m: Message) => void,
    private persist: (g: MeshGroup) => void,
  ) {}

  static isMesh = (id: string) => id.startsWith("mesh:");

  load(groups: MeshGroup[]) { for (const g of groups) this.groups.set(g.id, g); }
  create(name: string, members: MeshMember[]): MeshGroup {
    const g = { id: `mesh:${randomUUID()}`, name, members };
    this.groups.set(g.id, g); this.persist(g);
    return g;
  }
  list() { return [...this.groups.values()]; }
  history(id: string) { return this.hist.get(id) ?? []; }

  /** Feed every provider message in here. */
  handleIncoming(m: Message) {
    if (m.fromMe) return; // my own (incl. relayed) sends never re-enter: loop guard
    const key = `${m.chatId}|${m.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    for (const g of this.groups.values()) {
      const from = g.members.find((x) => x.chatId === m.chatId);
      if (from) this.deliver(g, from.chatId, from.name, m.text, false);
    }
  }

  post(groupId: string, text: string) {
    const g = this.groups.get(groupId);
    if (!g) throw new Error(`unknown mesh group ${groupId}`);
    this.deliver(g, "", "me", text, true);
  }

  private deliver(g: MeshGroup, exceptChat: string, author: string, text: string, fromMe: boolean) {
    const msg: Message = { id: randomUUID(), chatId: g.id, sender: author, senderId: exceptChat,
      text, time: new Date().toISOString(), fromMe };
    this.hist.set(g.id, [...this.history(g.id), msg]);
    this.emit(msg);
    // Receivers only see MY account as sender, so attribute inside the text.
    const out = `[${g.name} · ${author}] ${text}`;
    for (const m of g.members) if (m.chatId !== exceptChat) this.enqueueSend(m.chatId, out);
  }
}

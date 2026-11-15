// Shared helpers for the real-homeserver suite. Everything talks to a throwaway Synapse on 127.0.0.1 (see synapse-lab.sh).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import factory from "../src/index.js";
import type { Connector, CoreEvent, LoginPrompt } from "@unimsg/core";

export const HS = process.env.LAB_HS ?? "http://127.0.0.1:8008";
export const DOMAIN = process.env.LAB_DOMAIN ?? "lab.test";
if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(HS)) throw new Error("refusing to run against a non-loopback homeserver: " + HS);
export const PASS = (u: string) => `${u}-lab-pass-1`;
export const uid = (u: string) => `@${u}:${DOMAIN}`;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until<T>(f: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 20000): Promise<T> {
  const t = Date.now(); let last: unknown;
  while (Date.now() - t < ms) {
    try { const v = await f(); if (v) return v as T; } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`timeout waiting for: ${what}${last ? " (last error: " + (last as Error).message + ")" : ""}`);
}

export class Actor {
  conn!: Connector;
  events: CoreEvent[] = [];
  dir!: string;
  prompt?: LoginPrompt;
  name: string; accountId: string;
  constructor(name: string, accountId = `lab-${name}`) { this.name = name; this.accountId = accountId; }
  get userId() { return uid(this.name); }
  /** The matrix-js-sdk client behind the connector, for protocol-level actions the Connector contract has no method for. */
  get sdk(): any { return (this.conn as any).client; }
  get state() { const a = this.events.filter((e) => e.type === "account"); return (a[a.length - 1]?.data as any)?.state as string | undefined; }
  async boot(dir?: string) {
    this.dir ??= dir ?? mkdtempSync(join(tmpdir(), `unimsg-lab-${this.name}-`));
    this.events = []; this.prompt = undefined;
    this.conn = factory.create({ accountId: this.accountId, dataDir: this.dir });
    await this.conn.start((e) => { this.events.push(e); if (e.type === "login") this.prompt = e.data; });
  }
  async login(password = PASS(this.name), username = this.name, hs = HS) {
    await this.boot();
    const p = await until(() => this.prompt, "login prompt");
    await this.conn.submitLogin(p.promptId, { homeserver: hs, username, password });
    await this.ready();
  }
  async ready() { await until(() => this.state === "connected", `${this.name} connected`); await until(() => this.sdk?.isInitialSyncComplete?.(), `${this.name} initial sync`); }
  async restart() { await this.conn.stop(); await this.boot(); await this.ready(); }
  of(type: string, pred: (d: any) => boolean = () => true, from = 0) { return this.events.slice(from).filter((e) => e.type === type && pred(e.data)).map((e) => e.data as any); }
  mark() { return this.events.length; }
  async stop() { try { await this.conn.stop(); } catch { /* */ } }
  cleanup() { try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* */ } }
  /** Wait until the SDK knows the room (after an invite/join). */
  async joinRaw(roomIdOrAlias: string) { const r = await this.sdk.joinRoom(roomIdOrAlias); await until(() => this.sdk.getRoom(r.roomId)?.getMyMembership() === "join", "joined"); return r.roomId as string; }
}

/** A tiny valid 1x1 PNG. */
export const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

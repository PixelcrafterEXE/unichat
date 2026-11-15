// Disappearing messages: timer labels, the chat-header badge, the per-message mark and the setting (only where the connector can change it).
import { useState } from "react";
import type { Capabilities, Chat } from "./types";
import { Timer } from "./icons";
import { core } from "./util";

/** Offered when a connector does not list its own (Capabilities.disappearingDurations). */
export const DEFAULT_TIMERS = [86400, 604800, 7776000];

/** 0 -> "Off", 86400 -> "24 hours", 604800 -> "7 days", 30 -> "30 seconds". */
export function timerLabel(s: number): string {
  if (!(s > 0)) return "Off";
  const u = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (s === 604800) return "7 days";
  if (s % 604800 === 0) return u(s / 604800, "week");
  if (s % 86400 === 0) return s === 86400 ? "24 hours" : u(s / 86400, "day");
  if (s % 3600 === 0) return u(s / 3600, "hour");
  if (s % 60 === 0) return u(s / 60, "minute");
  return u(s, "second");
}
/** Short form for badges: "24h", "7d", "5m". */
export function timerShort(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

/** Header badge: shown while the chat has a timer. */
export function DisappearBadge({ chat }: { chat: Chat }) {
  if (!chat.disappearing) return null;
  return <span className="dtbadge" data-disappearing={chat.disappearing} title={`Disappearing messages: ${timerLabel(chat.disappearing)}`}><Timer size={12} />{timerShort(chat.disappearing)}</span>;
}
/** Per-message mark (next to the time). */
export function ExpiryMark({ seconds }: { seconds?: number }) {
  if (!seconds || seconds <= 0) return null;
  return <Timer size={11} className="expmark" data-expires={seconds} aria-label={`Disappears after ${timerLabel(seconds)}`}><title>{`Disappears after ${timerLabel(seconds)}`}</title></Timer>;
}

/** Chat-info section: the choice when the connector can change the timer, otherwise just the current state. */
export function DisappearingSetting({ chat, caps }: { chat: Chat; caps?: Capabilities }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const cur = chat.disappearing ?? 0;
  const can = !!caps?.disappearing && !chat.readOnly && !chat.offline && chat.provider !== "mesh";
  if (!can && !cur) return null;
  const opts = [...new Set([0, ...(caps?.disappearingDurations ?? DEFAULT_TIMERS), cur])].sort((a, b) => a - b);
  const set = async (s: number) => {
    setBusy(true); setError(undefined);
    try { await core.call("setDisappearing", { chatId: chat.id, seconds: s }); } catch (e) { setError((e as Error).message || "Could not change the timer"); } finally { setBusy(false); }
  };
  return (
    <section className="dtsec"><h4>Disappearing messages</h4>
      {can
        ? <select aria-label="Disappearing messages timer" data-act="disappearing-select" value={cur} disabled={busy} onChange={(e) => void set(Number(e.target.value))}>{opts.map((s) => <option key={s} value={s}>{timerLabel(s)}</option>)}</select>
        : <p className="hint" data-act="disappearing-readonly">{timerLabel(cur)} (changed in the messenger itself)</p>}
      {error && <p className="hint" role="alert" data-act="disappearing-error">{error}</p>}
      <p className="hint">New messages disappear on the other side after this time. UniChat keeps its own archive copy.</p>
    </section>);
}

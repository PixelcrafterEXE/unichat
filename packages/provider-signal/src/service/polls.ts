// Polls on the wire (DataMessage.pollCreate / pollVote / pollTerminate, SignalService.proto):
//   create:    question, allowMultiple, options[]  (the poll is the message itself: id = <author>.<timestamp>)
//   vote:      targetAuthorAciBinary + targetSentTimestamp + optionIndexes[] + voteCount
//              (a voter's vote REPLACES their previous one; the higher voteCount wins; [] retracts)
//   terminate: targetSentTimestamp (only the creator may close)
// Option ids exposed to the UI are the option indexes as strings.
import type { Poll } from "@unimsg/core";
import type { SignalStore } from "../store/signalStore.js";
import type { PollRecord } from "../store/types.js";

const MAX_POLLS = 500;

export function registerPoll(store: SignalStore, msgId: string, c: { question?: string; allowMultiple?: boolean; options?: string[] }): PollRecord | undefined {
  const options = c.options ?? [];
  if (options.length < 2) return undefined;
  const existing = store.data.polls[msgId];
  if (existing) return existing;
  const rec: PollRecord = { question: c.question ?? "", options: [...options], multiple: !!c.allowMultiple, votes: {} };
  store.data.polls[msgId] = rec;
  const keys = Object.keys(store.data.polls);
  if (keys.length > MAX_POLLS) for (const k of keys.slice(0, keys.length - MAX_POLLS)) delete store.data.polls[k];
  store.touch();
  return rec;
}

/** Returns true if state changed. Unknown polls and stale votes are ignored. */
export function applyVote(store: SignalStore, msgId: string, voter: string, picks: number[], count: number): boolean {
  const p = store.data.polls[msgId];
  if (!p || p.closed) return false;
  const v = voter.toLowerCase();
  const prev = p.votes[v];
  if (prev && count <= prev.count) return false;
  const valid = [...new Set(picks)].filter((i) => Number.isInteger(i) && i >= 0 && i < p.options.length);
  p.votes[v] = { count, picks: p.multiple ? valid : valid.slice(0, 1) };
  store.touch();
  return true;
}

export function terminatePoll(store: SignalStore, msgId: string, by: string): boolean {
  const p = store.data.polls[msgId];
  const creator = msgId.slice(0, msgId.lastIndexOf("."));
  if (!p || p.closed || creator.toLowerCase() !== by.toLowerCase()) return false;
  p.closed = true; store.touch();
  return true;
}

export function pollView(store: SignalStore, msgId: string, ours: string): Poll | undefined {
  const p = store.data.polls[msgId];
  if (!p) return undefined;
  const me = ours.toLowerCase();
  const options = p.options.map((text, i) => ({
    id: String(i), text,
    voters: Object.entries(p.votes).filter(([, v]) => v.picks.includes(i)).map(([a]) => a),
  }));
  return {
    question: p.question, options, multiple: p.multiple, ...(p.closed ? { closed: true } : {}),
    mine: options.filter((o) => o.voters.includes(me)).map((o) => o.id),
  };
}

/** Runs tasks with the same key one after the other (different keys run in parallel). Used so that two sends to the same recipient never encrypt at the same time:
 * both would load the same Double Ratchet session state, produce the same message counter and overwrite each other's session update, and the recipient then
 * rejects one of the two as a duplicate ("sent" on our side, never delivered). */
export class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch(() => {}); this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

// Pairing links (unichat-sync://pair?...): from the Android intent (shim.js -> window event), from `?pair=<link>` on the web UI URL, or pasted into the code field.
export const SYNC_LINK = /^unichat-sync:\/\/pair\?[^\s]{1,1900}$/;
export const isSyncLink = (s: unknown): s is string => typeof s === "string" && SYNC_LINK.test(s.trim());
let pending: string | undefined;
export const offerSyncLink = (l: string) => { if (isSyncLink(l)) { pending = l.trim(); dispatchEvent(new Event("unichat-sync-link")); } };
export const hasSyncLink = () => !!pending;
export const takeSyncLink = () => { const l = pending; pending = undefined; return l; };
/** Called once at start: picks up a link the Android shell stored before the page was ready, and `?pair=`. */
export function initSyncLink(): boolean {
  const w = window as any, q = new URLSearchParams(location.search).get("pair");
  const l = q ?? w.__unimsgSyncLink; w.__unimsgSyncLink = undefined;
  if (isSyncLink(l)) { pending = l.trim(); return true; }
  return false;
}

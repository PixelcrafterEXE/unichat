// Wire protocol between the Android native side (Java NodeBridge) and the Node backend (nodejs-project/main.js).
// Transport: a Unix domain socket in the app's private files dir (mode 0600, app-UID only). Framing: NDJSON, one JSON
// object per line, UTF-8. JSON.stringify never emits a raw newline, so a line is always one frame.
//
//   native -> node   {"id":N,"method":"snapshot","params":{...}}      a Hub call (the UI's UnimsgNative.call, forwarded verbatim)
//                    ids < 0 are used by the native side for its own control calls ($foreground, $config, $ping, $network, $power, $flush, $shutdown)
//   node -> native   {"id":N,"result":...}  |  {"id":N,"error":"message"}
//                    {"event":"message","data":{...}}                 a Hub event (forwarded to the UI as is)
//                    {"ctl":"ready","protocol":1,"node":"v18...","sqlite":"sqljs"}   the backend is up (never forwarded to the UI)
//                    {"ctl":"notify","chatId","messageId","title","body","avatar"?}  show a local notification (only sent while the UI is in the background);
//                                                                      starred = a starred (prioritized) chat: posted on the "Starred chats" channel
//                                                                      avatar = optional base64 PNG/JPEG/WebP (<= ~64 KB) of the chat, shown as the large icon; never sent when notifyContent is "hidden"
//                    {"ctl":"notify-clear","chatIds":[...]}           take those chats' notifications down again: they have been read (in the app, by the
//                                                                      "Mark as read" action, or on another device). An empty list clears every message notification.
//                    {"ctl":"state","accounts":N,"sync":bool}          number of configured accounts and whether this device is in a sync group (sent after "ready" and whenever it changes);
//                                                                      the native side keeps it so the boot receiver knows whether to restart the service
//
// Control methods ($-prefixed, handled by the bridge itself, never reach the Hub):
//   $ping {}                       -> {pong:true,node,pid,uptime}
//   $foreground {value:boolean}    UI visible? Notifications are only requested while false.
//   $config {notifyContent?:"full"|"sender"|"hidden", keepAlive?:boolean}
//                                  notifyContent: what notifications reveal (default "full"). keepAlive: "keep running in background" (restart the
//                                  foreground service after boot / app update). The UI may send both; the NATIVE side persists them in SharedPreferences
//                                  (keepAlive is consumed there and never needs the backend) and forwards notifyContent. Returns {} (Node) /
//                                  {keepAlive,notifyContent} (native reply to the UI).
//   $reply {chatId,text}           notification direct reply: Hub "send" {chatId,text}. Result: {} or error.
//   $markRead {chatId,messageId}   notification "mark as read" action: Hub "markRead".
//   $network {interfaces:[{name,address,family?,netmask?}], metered?:boolean}
//                                  the native side reports every IP address of every connected network (ConnectivityManager LinkProperties) after each
//                                  connectivity change / resume; the backend uses it instead of os.networkInterfaces() (which may fail on Android), rebinds the
//                                  sync listener, re-announces addresses to peers and resets the dial back-off (hub call syncNetworkChanged).
//                                  metered = the active network does not have NET_CAPABILITY_NOT_METERED: no background update check, no avatar pre-warming.
//   $power {saver:boolean,low:boolean}
//                                  battery saver on / Android reported a low battery (PowerMonitor.java). Together with $network metered it decides
//                                  `setAvatarWarmPaused` (see warm-pause.ts). Both are re-sent whenever the native side reconnects to the backend.
//   $flush {}                      flush the sql.js database to disk (call when the app goes to the background)
//   $shutdown {}                   hub.shutdown(), flush, then exit(0)
//
// NATIVE-ONLY methods (answered by NodeBridge.java for requests coming from the UI; they never reach Node):
//   $restartBackend {}             UI watchdog ("Reconnecting..." did not recover): native pings the backend itself, and only if it does not answer
//                                  flushes the archive and restarts the whole app process (node::Start works once per process). Result {restarting:boolean}.
//   $requestBatteryExemption {}    user-triggered (call it from a settings button): opens the system "ignore battery optimizations" dialog
//                                  (ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) or the settings list as fallback.
//                                  Result {ignoring:boolean,launched:boolean}
//   $batteryExemptionState {}      -> {ignoring:boolean, keepAlive:boolean, notifyContent:string, sdk:number}
//   $notificationState {}          -> {granted:boolean, sdk:number}   (Android 13+ POST_NOTIFICATIONS)
//   $requestNotifications {}       user-triggered: system permission dialog, or the app's notification settings once Android stopped asking. Result {launched,granted}
//   $backupLocate {kind:"whatsapp"|"signal", pick?:boolean}
//                                  "Find the backup on this phone". Opens the system folder picker (Storage Access Framework) pointed at the usual backup
//                                  folder (WhatsApp: Android/media/com.whatsapp/WhatsApp, Signal: Signal) unless a folder was granted before and pick is false.
//                                  The grant is persisted (read only). Async result {cancelled:true} | {kind, folder, files:[{name,size,modified}] newest first,
//                                  hasMedia, media:[{name,bytes,files}]} (media = WhatsApp's top-level Media folders; Signal has none).
//   $backupCopy {kind, name, media?:string[]}
//                                  streams that backup file (+ the named Media folders) into <data>/.backup/saf/<kind>/ (WhatsApp keeps the layout
//                                  WhatsApp/Databases + WhatsApp/Media so the importer finds the media). Progress: event "backup-progress" {op:"saf-copy",stage,done,total}.
//                                  Result {path, name, bytes, mediaFiles, mediaPath?}; pass path / mediaPath to the importers (they are inside the backup path policy).
//   $backupCopyCancel {}           stops a running copy.   $backupDiscard {kind, forget?}  deletes the copies (and with forget the folder grant).
//   $config (from the UI)          see above; handled natively first, notifyContent is then forwarded to Node.
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024; // attachments travel base64 inside frames

export type NotifyContent = "full" | "sender" | "hidden";
export type Request = { id: number; method: string; params?: unknown };
export type Frame =
  | { id: number; result?: unknown; error?: string }
  | { event: string; data: unknown }
  | { ctl: "ready"; protocol: number; node: string; sqlite: string }
  | { ctl: "notify"; chatId: string; messageId: string; title: string; body: string; avatar?: string; starred?: boolean }
  | { ctl: "notify-clear"; chatIds: string[] }
  | { ctl: "state"; accounts: number; sync?: boolean };

/** Methods the native side answers itself for UI requests (kept in sync with NodeBridge.java). */
export const NATIVE_ONLY_METHODS = ["$requestBatteryExemption", "$batteryExemptionState", "$restartBackend", "$notificationState", "$requestNotifications", "$backupLocate", "$backupCopy", "$backupCopyCancel", "$backupDiscard"] as const;

export const encode = (f: Frame): string => JSON.stringify(f) + "\n";

/** Splits a byte stream into lines. Throws when a single frame grows past MAX_FRAME_BYTES. */
export class LineReader {
  private buf = "";
  constructor(private onLine: (line: string) => void) {}
  push(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
    if (this.buf.length > MAX_FRAME_BYTES) throw new Error("frame too large");
  }
}

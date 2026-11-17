package app.unimsg.android.node;

import app.unimsg.android.MainActivity;
import android.content.Context;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.PowerManager;
import android.provider.Settings;
import android.os.Looper;
import android.os.SystemClock;
import org.json.JSONArray;
import android.util.Log;

import androidx.webkit.JavaScriptReplyProxy;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Process-wide pipe between the WebView page and the Node backend. Speaks the NDJSON protocol documented in
 * apps/android/src/bridge-protocol.ts over the app-private Unix socket (reference implementation of the other side:
 * scripts/smoke-test.mjs, which is tested; this class is not).
 *
 *   page --postMessage(line)--> onUiMessage --> socket          (requests are forwarded verbatim, never parsed)
 *   socket --> readLoop --> ctl frames handled here / everything else --> page via the reply proxy
 */
public final class NodeBridge {
    private static final String TAG = "UnimsgBridge";
    private static final NodeBridge INSTANCE = new NodeBridge();
    public static NodeBridge get() { return INSTANCE; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Object writeLock = new Object();
    private final ConcurrentLinkedQueue<String> queued = new ConcurrentLinkedQueue<>(); // requests that arrived before the backend was up
    private final Set<Long> inflight = ConcurrentHashMap.newKeySet();                  // UI request ids awaiting a response
    /** Result callback of a native-initiated control call (ids < 0). */
    public interface Callback { void done(boolean ok, String error); }
    private final Map<Long, Callback> callbacks = new ConcurrentHashMap<>();
    private final AtomicLong controlIds = new AtomicLong(0);

    private volatile Context app;
    private volatile String socketPath;
    private volatile LocalSocket socket;
    private volatile OutputStream out;
    private volatile JavaScriptReplyProxy ui;
    private volatile boolean uiForeground = false, started = false;
    private volatile String notifyContent = "full"; // "full" | "sender" | "hidden"
    private volatile NativePrefs prefs;

    private NodeBridge() {}

    /** Called once by NodeRuntime after it decided the socket path. Starts the connect/read loop. */
    synchronized void start(Context appContext, String sockPath) {
        if (started) return;
        started = true; app = appContext.getApplicationContext(); socketPath = sockPath;
        prefs = new NativePrefs(app); notifyContent = prefs.notifyContent();
        Thread t = new Thread(this::connectLoop, "unimsg-bridge"); t.setDaemon(true); t.start();
        lastOkAt = SystemClock.elapsedRealtime();
        main.postDelayed(this::watchdog, WATCHDOG_MS);
    }

    // ---- watchdog: the backend (Node thread) can hang or the socket can be dead while the process lives -------------------------------
    private static final long WATCHDOG_MS = 15_000, DEAD_AFTER_MS = 150_000;
    private volatile long lastOkAt;           // last time the backend answered a ping or was connected and well
    private int pingMisses = 0; private volatile boolean pinging = false;
    private void watchdog() {
        try {
            if (out == null) {
                // never connected / disconnected for too long: Node died without taking the process with it, or never came up
                if (SystemClock.elapsedRealtime() - lastOkAt > DEAD_AFTER_MS && app != null) { lastOkAt = SystemClock.elapsedRealtime(); NodeRuntime.restartProcess(app, "backend socket down for " + DEAD_AFTER_MS / 1000 + " s"); }
            } else if (!pinging && app != null) {
                pinging = true;
                boolean sent = callControl(app, "$ping", "{}", (ok, err) -> {
                    pinging = false;
                    if (ok) { pingMisses = 0; lastOkAt = SystemClock.elapsedRealtime(); }
                    else if (++pingMisses >= 4 && app != null) { pingMisses = 0; NodeRuntime.restartProcess(app, "backend does not answer pings"); }
                });
                if (!sent) pinging = false;
            }
        } catch (Exception e) { Log.w(TAG, "watchdog", e); }
        main.postDelayed(this::watchdog, WATCHDOG_MS);
    }

    /** $flush, then run `then` on the main thread when Node confirmed it or after maxMs (the backend may be the thing that is stuck). */
    public void flushAndThen(final long maxMs, final Runnable then) {
        final boolean[] done = { false };
        final Runnable once = () -> { if (!done[0]) { done[0] = true; then.run(); } };
        Context c = app;
        if (c == null || !callControl(c, "$flush", "{}", (ok, err) -> main.post(once))) { main.post(once); return; }
        main.postDelayed(once, maxMs);
    }

    // ---- network addresses for the sync listener (see NetworkMonitor) and the power state (PowerMonitor) ------------------------------
    private volatile String lastNetwork = "[]";
    private volatile boolean lastMetered = false;
    private volatile String lastPower; // null until PowerMonitor read the battery state
    /** Every IP address of every connected network, as a JSON array [{name,address,family,netmask}], plus whether the active network is metered. Sent to Node now and again on every (re)connect. */
    public void sendNetwork(JSONArray list, boolean metered) { lastNetwork = list.toString(); lastMetered = metered; sendControl("$network", networkParams()); }
    private String networkParams() { return "{\"interfaces\":" + lastNetwork + ",\"metered\":" + lastMetered + "}"; }
    /** Battery saver / low battery, so the backend can stop work that is only nice to have (avatar pre-warming). */
    public void sendPower(boolean saver, boolean low) { lastPower = "{\"saver\":" + saver + ",\"low\":" + low + "}"; sendControl("$power", lastPower); }

    public boolean uiAttached() { return ui != null; }

    // ---- page -> backend ------------------------------------------------------------------------------------------------
    public void onUiMessage(String line, JavaScriptReplyProxy reply) {
        ui = reply; // the newest page instance wins (a reload creates a new proxy)
        if (pendingSyncLink != null) main.postDelayed(this::deliverSyncLink, 1500); // a link that arrived before the page: the UI is mounted by now
        if (line == null || !line.startsWith("{\"id\":")) return; // {"hello":1}
        long id = parseId(line);
        if (line.contains("\"method\":\"$") && handleNativeFromUi(id, line)) return;
        if (id > 0) inflight.add(id);
        if (!write(line)) {
            if (queued.size() < 2000) queued.add(line); else failToUi(id, "The backend is not running yet");
        }
    }

    /** UI requests for $-methods the native side answers itself ($config is handled here AND forwarded to Node). Returns true if fully handled. */
    private boolean handleNativeFromUi(long id, String line) {
        Context c = app;
        try {
            JSONObject req = new JSONObject(line);
            String m = req.getString("method");
            JSONObject p = req.optJSONObject("params");
            if (p == null) p = new JSONObject();
            if (c == null) return false;
            NativePrefs np = prefs != null ? prefs : new NativePrefs(c);
            switch (m) {
                case "$config": {
                    if (p.has("keepAlive")) np.setKeepAlive(p.getBoolean("keepAlive"));
                    String nc = p.optString("notifyContent", "");
                    if (nc.equals("full") || nc.equals("sender") || nc.equals("hidden")) setNotifyContent(nc);
                    replyToUi(id, new JSONObject().put("keepAlive", np.keepAlive()).put("notifyContent", notifyContent));
                    return true;
                }
                case "$ping":
                    if (out == null) { failToUi(id, "The backend is not connected"); return true; } // do not queue pings: they would pile up while the backend is down
                    return false;
                case "$restartBackend": {
                    // the UI's heartbeat gave up. Ping from here (the UI's ping may have failed for UI-side reasons); only a backend that really does not answer is restarted.
                    final long rid = id; final Context cc = c;
                    boolean sent = callControl(c, "$ping", "{}", (ok, err) -> {
                        try { replyToUi(rid, new JSONObject().put("restarting", !ok)); } catch (Exception ignored) { }
                        if (!ok) NodeRuntime.restartProcess(cc, "UI watchdog: backend does not answer");
                    });
                    if (!sent) { try { replyToUi(id, new JSONObject().put("restarting", true)); } catch (Exception ignored) { } NodeRuntime.restartProcess(c, "UI watchdog: no backend connection"); }
                    return true;
                }
                case "$requestBatteryExemption":
                    replyToUi(id, requestBatteryExemption(c));
                    return true;
                case "$apkInstallState":
                    replyToUi(id, new JSONObject().put("canInstall", canInstallPackages(c)).put("sdk", Build.VERSION.SDK_INT));
                    return true;
                case "$installApk": // must follow a user tap ("Update"): the UI passes the path of the verified file from the updater
                    replyToUi(id, installApk(c, p.optString("path", "")));
                    return true;
                case "$notificationState":
                    replyToUi(id, new JSONObject().put("granted", MainActivity.notificationsGranted(c)).put("sdk", Build.VERSION.SDK_INT));
                    return true;
                case "$requestNotifications": // user tap in Settings > Notifications
                    replyToUi(id, new JSONObject().put("launched", MainActivity.requestNotifications()).put("granted", MainActivity.notificationsGranted(c)));
                    return true;
                case "$backupLocate": { // {kind:"whatsapp"|"signal", pick?:boolean}: system folder picker (or the folder granted earlier) -> backup files + Media folders
                    final String kind = p.optString("kind"); final boolean pick = p.optBoolean("pick", false);
                    if (!SafImport.validKind(kind)) { failToUi(id, "unknown backup kind"); return true; }
                    final android.net.Uri saved = SafImport.savedTree(c, kind);
                    final long rid = id; final Context cc = c;
                    final SafImport.Out out = new SafImport.Out() {
                        public void ok(JSONObject r) { replyToUi(rid, r); }
                        public void fail(String m) { failToUi(rid, m); }
                    };
                    if (saved != null && !pick) { SafImport.get().locate(c, kind, saved, out); return true; }
                    boolean shown = MainActivity.pickTree(saved != null ? saved : SafImport.hint(kind), uri -> {
                        if (uri == null) { try { replyToUi(rid, new JSONObject().put("cancelled", true)); } catch (Exception ignored) { } return; }
                        SafImport.remember(cc, kind, uri); SafImport.get().locate(cc, kind, uri, out);
                    });
                    if (!shown) failToUi(id, "UniChat must be on screen to choose a folder.");
                    return true;
                }
                case "$backupCopy": { // {kind, name, media?:[folder names]}: stream into the managed import folder; progress as event backup-progress {op:"saf-copy"}
                    final String kind = p.optString("kind"); final android.net.Uri tree = SafImport.validKind(kind) ? SafImport.savedTree(c, kind) : null;
                    if (tree == null) { failToUi(id, "No folder has been chosen yet."); return true; }
                    java.util.List<String> media = new java.util.ArrayList<>();
                    JSONArray ma = p.optJSONArray("media"); if (ma != null) for (int i = 0; i < ma.length(); i++) media.add(ma.getString(i));
                    final long rid = id;
                    SafImport.get().copy(c, kind, tree, p.optString("name"), media, new SafImport.Out() {
                        public void ok(JSONObject r) { replyToUi(rid, r); }
                        public void fail(String m) { failToUi(rid, m); }
                    }, d -> pushToUi("{\"event\":\"backup-progress\",\"data\":" + d + "}"));
                    return true;
                }
                case "$backupCopyCancel": SafImport.get().cancel(); replyToUi(id, new JSONObject().put("ok", true)); return true;
                case "$backupDiscard": { // {kind, forget?:boolean}: delete the copies (and optionally the folder grant)
                    String kind = p.optString("kind");
                    if (SafImport.validKind(kind)) { SafImport.discard(c, kind); if (p.optBoolean("forget", false)) SafImport.forget(c, kind); }
                    replyToUi(id, new JSONObject().put("ok", true));
                    return true;
                }
                case "$batteryExemptionState":
                    replyToUi(id, new JSONObject().put("ignoring", isIgnoringBatteryOptimizations(c)).put("keepAlive", np.keepAlive())
                        .put("notifyContent", notifyContent).put("sdk", Build.VERSION.SDK_INT));
                    return true;
                default: return false; // $ping, $reply, ... go to Node
            }
        } catch (Exception e) {
            Log.w(TAG, "native control call failed", e);
            failToUi(id, "native call failed: " + e.getMessage());
            return true;
        }
    }

    private static boolean canInstallPackages(Context c) {
        return Build.VERSION.SDK_INT < 26 || c.getPackageManager().canRequestPackageInstalls();
    }

    /**
     * Hands a downloaded update to the system package installer. Only files the updater wrote (<filesDir>/unimsg-data/updates/*.apk, SHA-256
     * already verified by the backend) are accepted; the system itself refuses an APK not signed with this app's key.
     * Without the "install unknown apps" permission the settings page for this app opens instead and {needsPermission:true} is returned.
     */
    private static JSONObject installApk(Context c, String path) throws Exception {
        java.io.File dir = new java.io.File(new java.io.File(c.getFilesDir(), "unimsg-data"), "updates").getCanonicalFile();
        java.io.File f = new java.io.File(path).getCanonicalFile();
        if (!f.getPath().startsWith(dir.getPath() + java.io.File.separator) || !f.getName().endsWith(".apk") || !f.isFile())
            return new JSONObject().put("started", false).put("error", "This is not a downloaded update file.");
        if (!canInstallPackages(c)) {
            c.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            return new JSONObject().put("started", false).put("needsPermission", true);
        }
        Uri uri = androidx.core.content.FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f);
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(view);
        return new JSONObject().put("started", true);
    }

    private static boolean isIgnoringBatteryOptimizations(Context c) {
        PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
    }

    /** Must be triggered by a user tap in the UI. Direct system dialog first; the generic settings list if the OEM lacks it. */
    private static JSONObject requestBatteryExemption(Context c) throws Exception {
        boolean already = isIgnoringBatteryOptimizations(c), launched = false;
        if (!already) {
            Intent direct = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { c.startActivity(direct); launched = true; }
            catch (Exception e) {
                try { c.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); launched = true; }
                catch (Exception e2) { Log.w(TAG, "no battery settings screen", e2); }
            }
        }
        return new JSONObject().put("ignoring", already).put("launched", launched);
    }

    private void replyToUi(long id, JSONObject result) { pushToUi("{\"id\":" + id + ",\"result\":" + result + "}"); }

    /** Native-initiated Hub/control call (notification actions). Returns false if the backend socket is not connected. cb may be null. */
    public boolean callControl(Context ctx, String method, String paramsJson, final Callback cb) {
        long id = -controlIds.incrementAndGet();
        if (cb != null) callbacks.put(id, cb);
        if (!write("{\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}")) { callbacks.remove(id); return false; }
        if (cb != null) main.postDelayed(() -> { Callback x = callbacks.remove(id); if (x != null) x.done(false, "timeout"); }, 9000);
        return true;
    }

    /** Persist the sql.js database now (app pause, onTrimMemory, task removed). */
    public void flush() { sendControl("$flush", "{}"); }

    private static long parseId(String line) {
        int i = 6, j = i;
        if (j < line.length() && line.charAt(j) == '-') j++; // ids of the native side's own control calls are negative: without this every reply parsed as -1, no callback fired, and the watchdog restarted a healthy backend after 4 "missed" pings
        while (j < line.length() && Character.isDigit(line.charAt(j))) j++;
        try { return Long.parseLong(line.substring(i, j)); } catch (NumberFormatException e) { return -1; }
    }

    // ---- activity lifecycle -----------------------------------------------------------------------------------------------
    public void setUiForeground(boolean fg) {
        uiForeground = fg;
        sendControl("$foreground", "{\"value\":" + fg + "}");
        if (!fg) sendControl("$flush", "{}"); // persist the sql.js database whenever the user leaves the app
    }

    public void setNotifyContent(String mode) { notifyContent = mode; if (prefs != null) prefs.setNotifyContent(mode); sendControl("$config", "{\"notifyContent\":" + JSONObject.quote(mode) + "}"); }

    private volatile String pendingSyncLink;
    /** Pairing link from an intent. Only the expected shape is forwarded; it is kept until a page is attached (cold start) and delivered once. */
    public void openSyncLink(String url) {
        if (url == null || url.length() > 2000 || !url.startsWith("unichat-sync://pair?")) return;
        pendingSyncLink = url; deliverSyncLink();
    }
    private void deliverSyncLink() {
        String u = pendingSyncLink;
        if (u == null || ui == null) return;
        pendingSyncLink = null;
        pushToUi("{\"ctl\":\"sync-link\",\"url\":" + JSONObject.quote(u) + "}");
    }

    public void openChat(String chatId) { pushToUi("{\"ctl\":\"open-chat\",\"chatId\":" + JSONObject.quote(chatId) + "}"); }

    private void sendControl(String method, String paramsJson) {
        long id = -controlIds.incrementAndGet();
        write("{\"id\":" + id + ",\"method\":\"" + method + "\",\"params\":" + paramsJson + "}");
    }

    // ---- socket -------------------------------------------------------------------------------------------------------------
    private boolean write(String line) {
        OutputStream o = out;
        if (o == null) return false;
        try {
            synchronized (writeLock) { o.write((line + "\n").getBytes(StandardCharsets.UTF_8)); o.flush(); }
            return true;
        } catch (IOException e) { return false; }
    }

    private void connectLoop() {
        long delay = 100;
        while (true) {
            try {
                LocalSocket s = new LocalSocket();
                s.connect(new LocalSocketAddress(socketPath, LocalSocketAddress.Namespace.FILESYSTEM));
                socket = s; out = s.getOutputStream();
                delay = 100;
                readLoop(s);
            } catch (IOException e) {
                // node not listening yet (startup takes a second or two) or it died: retry
            }
            onDisconnected();
            try { Thread.sleep(delay); } catch (InterruptedException ie) { return; }
            delay = Math.min(delay * 2, 5000);
        }
    }

    private void readLoop(LocalSocket s) throws IOException {
        BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8), 1 << 16);
        String line;
        while ((line = r.readLine()) != null) {
            if (line.startsWith("{\"ctl\":")) { handleCtl(line); continue; }
            if (line.startsWith("{\"id\":")) {
                long id = parseId(line);
                if (id < 0) {               // answer to one of our own control calls
                    Callback cb = callbacks.remove(id);
                    if (cb != null) { try { JSONObject rr = new JSONObject(line); cb.done(!rr.has("error"), rr.optString("error", null)); } catch (Exception e) { cb.done(false, "bad reply"); } }
                    continue;
                }
                inflight.remove(id);
            }
            pushToUi(line);
        }
    }

    private void handleCtl(String line) {
        try {
            JSONObject o = new JSONObject(line);
            switch (o.getString("ctl")) {
                case "ready":
                    Log.i(TAG, "backend ready: node " + o.optString("node") + ", sqlite " + o.optString("sqlite"));
                    sendControl("$foreground", "{\"value\":" + uiForeground + "}");
                    sendControl("$config", "{\"notifyContent\":" + JSONObject.quote(notifyContent) + "}");
                    sendControl("$network", networkParams());
                    if (lastPower != null) sendControl("$power", lastPower); // a restarted backend starts unpaused: tell it again
                    lastOkAt = SystemClock.elapsedRealtime(); pingMisses = 0;
                    String q; while ((q = queued.poll()) != null) write(q);
                    pushToUi("{\"event\":\"core-connection\",\"data\":{\"state\":\"up\"}}");
                    break;
                case "notify":
                    if (!uiForeground && app != null)
                        Notifier.showMessage(app, o.optString("chatId"), o.optString("messageId"), o.optString("title"), o.optString("body"), notifyContent, o.optString("avatar", null));
                    break;
                case "state":
                    if (prefs != null) { prefs.setAccountCount(o.optInt("accounts", 0)); prefs.setSyncGroup(o.optBoolean("sync", false)); }
                    if (app != null) NodeService.refreshNotification(app);
                    break;
                default: break;
            }
        } catch (Exception e) { Log.w(TAG, "bad ctl frame"); }
    }

    private void onDisconnected() {
        boolean wasConnected = out != null;
        out = null; socket = null; pinging = false;
        if (wasConnected) lastOkAt = SystemClock.elapsedRealtime(); // the "down" clock starts now
        for (Long id : inflight) failToUi(id, "Connection to the backend was lost");
        for (Long id : callbacks.keySet()) { Callback x = callbacks.remove(id); if (x != null) x.done(false, "connection lost"); }
        inflight.clear();
        if (wasConnected) pushToUi("{\"event\":\"core-connection\",\"data\":{\"state\":\"down\"}}");
    }

    private void failToUi(long id, String message) {
        pushToUi("{\"id\":" + id + ",\"error\":" + JSONObject.quote(message) + "}");
    }

    private void pushToUi(final String line) {
        final JavaScriptReplyProxy p = ui;
        if (p == null) return;
        main.post(() -> { try { p.postMessage(line); } catch (Exception e) { Log.w(TAG, "page is gone"); } });
    }
}

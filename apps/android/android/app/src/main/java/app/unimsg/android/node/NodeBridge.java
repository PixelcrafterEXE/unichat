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
                case "$share": // {text?, file?:{name,mime,dataBase64}}: hand a message to Android's share sheet (issue #82)
                    replyToUi(id, share(c, p));
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
     * Where the backend's updater writes the verified APK, relative to filesDir. The Hub nests its own data directory one
     * level deeper than UNIMSG_DATA (startBackend does `new Hub(join(dataDir, "accounts"), ...)`, packages/host/src/index.ts)
     * and the updater uses the Hub's directory, so the file lands in unimsg-data/accounts/updates - NOT in unimsg-data/updates.
     * Must stay in sync with the `unimsg_updates` entry of res/xml/file_paths.xml, or FileProvider refuses to share the file.
     */
    private static final String UPDATES_DIR = "unimsg-data/accounts/updates";

    /**
     * Hands a downloaded update to the system package installer. Only files the updater wrote (UPDATES_DIR/*.apk, SHA-256
     * already verified by the backend) are accepted. Without the "install unknown apps" permission the settings page for this
     * app opens instead and {needsPermission:true} is returned.
     * Every refusal comes back as {started:false, error:"<sentence>"}: the UI shows it. Nothing here may end without an answer -
     * a dialog that just closes is what issue #91 was about.
     */
    private static JSONObject installApk(Context c, String path) throws Exception {
        java.io.File dir, f;
        try { dir = new java.io.File(c.getFilesDir(), UPDATES_DIR).getCanonicalFile(); f = new java.io.File(path).getCanonicalFile(); }
        catch (IOException e) { Log.w(TAG, "cannot resolve " + path, e); return fail("The downloaded update file cannot be read. Download it again."); }
        if (!f.getPath().startsWith(dir.getPath() + java.io.File.separator) || !f.getName().endsWith(".apk") || !f.isFile()) {
            Log.w(TAG, "refusing to install " + f.getPath() + ": not an APK below " + dir.getPath());
            return fail("The downloaded update is not where the app expects it, so it was not installed. Please report this.");
        }
        if (!canInstallPackages(c)) {
            try { c.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + c.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
            catch (Exception e) { Log.w(TAG, "no unknown-sources settings screen", e); return fail("Android does not allow UniChat to install apps, and this phone has no screen to change that. Install the downloaded file with a file manager."); }
            return new JSONObject().put("started", false).put("needsPermission", true);
        }
        String conflict = signingConflict(c, f);
        if (conflict != null) return fail(conflict);
        Uri uri;
        try { uri = androidx.core.content.FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f); }
        catch (IllegalArgumentException e) { // the folder is not in file_paths.xml: nothing can be shared with the installer
            Log.w(TAG, "FileProvider has no root for " + f.getPath(), e);
            return fail("This build cannot pass the update to the installer. Please report this.");
        }
        Intent view = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        // From the activity while it is on screen: an activity start from an application context is dropped SILENTLY once the
        // app counts as backgrounded (Android 10+), which looks exactly like "the dialog closed and nothing happened".
        android.app.Activity a = MainActivity.onScreen();
        try { if (a != null) a.startActivity(view); else c.startActivity(view); }
        catch (Exception e) {
            Log.w(TAG, "no activity for the install intent", e);
            return fail("This phone has nothing that can install app files: " + e.getClass().getSimpleName() + ".");
        }
        return new JSONObject().put("started", true);
    }

    /** Cache folder the share sheet reads from. Covered by the cache-path root of res/xml/file_paths.xml. */
    private static final String SHARE_DIR = "share";
    private static final int MAX_SHARE_BYTES = 64 * 1024 * 1024;

    /**
     * Android's share sheet for one message (issue #82): its text, or an attachment the UI has already downloaded.
     * The bytes are written into the cache and handed over as a content:// URI, because another app cannot read our files.
     */
    private static JSONObject share(Context c, JSONObject p) throws Exception {
        final String text = p.optString("text", "");
        final JSONObject file = p.optJSONObject("file");
        Intent send = new Intent(Intent.ACTION_SEND);
        if (file != null) {
            byte[] bytes;
            try { bytes = android.util.Base64.decode(file.optString("dataBase64", ""), android.util.Base64.DEFAULT); }
            catch (IllegalArgumentException e) { Log.w(TAG, "share: undecodable attachment", e); return fail("This attachment could not be read, so it was not shared."); }
            if (bytes.length == 0) return fail("This attachment is empty, so there is nothing to share.");
            if (bytes.length > MAX_SHARE_BYTES) return fail("This file is too large to share from UniChat (the limit is 64 MB).");
            java.io.File dir = new java.io.File(c.getCacheDir(), SHARE_DIR);
            sweepShared(dir);
            if (!dir.isDirectory() && !dir.mkdirs()) return fail("UniChat cannot prepare the file for sharing on this phone.");
            java.io.File f = new java.io.File(dir, shareName(file.optString("name", "")));
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(f)) { out.write(bytes); }
            Uri uri;
            try { uri = androidx.core.content.FileProvider.getUriForFile(c, c.getPackageName() + ".fileprovider", f); }
            catch (IllegalArgumentException e) { Log.w(TAG, "FileProvider has no root for " + f.getPath(), e); return fail("This build cannot share files. Please report this."); }
            send.setType(mimeOf(file.optString("mime", ""))).putExtra(Intent.EXTRA_STREAM, uri);
            if (!text.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, text);
        } else {
            if (text.isEmpty()) return fail("There is nothing to share in this message.");
            send.setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        }
        Intent chooser = Intent.createChooser(send, null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        // Like the installer handoff: started from the activity, because a background activity start is dropped silently.
        android.app.Activity a = MainActivity.onScreen();
        try { if (a != null) a.startActivity(chooser); else c.startActivity(chooser); }
        catch (Exception e) { Log.w(TAG, "no activity for the share intent", e); return fail("This phone has nothing to share with: " + e.getClass().getSimpleName() + "."); }
        return new JSONObject().put("started", true);
    }

    /** A file name another app will see: no path, no surprises, never empty. */
    private static String shareName(String raw) {
        String n = raw.replace('\\', '/');
        n = n.substring(n.lastIndexOf('/') + 1).replaceAll("[^A-Za-z0-9._-]", "_");
        while (n.startsWith(".")) n = n.substring(1);
        if (n.isEmpty()) n = "attachment";
        return n.length() > 80 ? n.substring(n.length() - 80) : n;
    }
    private static String mimeOf(String raw) {
        String m = raw.split(";")[0].trim();
        return m.matches("[\\w.+-]+/[\\w.+-]+") ? m : "application/octet-stream";
    }
    /** The receiving app reads the file after this call returns, so shared copies are cleared on the NEXT share, not now. */
    private static void sweepShared(java.io.File dir) {
        java.io.File[] old = dir.listFiles();
        if (old == null) return;
        long cutoff = System.currentTimeMillis() - 10 * 60_000L;
        for (java.io.File f : old) if (f.isFile() && f.lastModified() < cutoff && !f.delete()) Log.w(TAG, "could not clear " + f.getName());
    }

    private static JSONObject fail(String message) throws Exception { return new JSONObject().put("started", false).put("error", message); }

    /**
     * The sentence to show when this APK cannot replace the installed app, or null when it can (or when we cannot tell).
     * Android refuses an update signed with another key ("a package with the same id already exists") and reports nothing back
     * to the app that handed it over, so the mismatch is detected here (issue #92: a CI APK over a local `pnpm run debug` build).
     * A check that itself fails must never block an install, so every problem means "cannot tell".
     */
    private static String signingConflict(Context c, java.io.File apk) {
        try {
            android.content.pm.PackageManager pm = c.getPackageManager();
            int flag = Build.VERSION.SDK_INT >= 28 ? android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES : android.content.pm.PackageManager.GET_SIGNATURES;
            android.content.pm.PackageInfo now = pm.getPackageInfo(c.getPackageName(), flag);
            android.content.pm.PackageInfo next = pm.getPackageArchiveInfo(apk.getPath(), flag);
            if (next == null || !c.getPackageName().equals(next.packageName)) return null;
            Set<String> mine = certHashes(now), theirs = certHashes(next);
            if (mine.isEmpty() || theirs.isEmpty() || !java.util.Collections.disjoint(mine, theirs)) return null;
            Log.w(TAG, "update signed with another key: installed " + mine + ", update " + theirs);
            return "This update was signed with a different key than the installed app, so Android refuses it. Only a fresh install works, and uninstalling UniChat first would delete the app's data on this phone.";
        } catch (Exception e) { Log.w(TAG, "signing check skipped", e); return null; }
    }

    /** SHA-256 of every signing certificate. For the installed app that is the whole history, so a rotated key still matches. */
    private static Set<String> certHashes(android.content.pm.PackageInfo pi) throws Exception {
        Set<String> out = new java.util.HashSet<>();
        android.content.pm.Signature[] sigs = pi.signatures;
        if (Build.VERSION.SDK_INT >= 28 && pi.signingInfo != null)
            sigs = pi.signingInfo.hasMultipleSigners() ? pi.signingInfo.getApkContentsSigners() : pi.signingInfo.getSigningCertificateHistory();
        if (sigs == null) return out;
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
        for (android.content.pm.Signature s : sigs) {
            if (s == null) continue;
            StringBuilder b = new StringBuilder();
            for (byte x : md.digest(s.toByteArray())) b.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
            out.add(b.toString());
        }
        return out;
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
                        Notifier.showMessage(app, o.optString("chatId"), o.optString("messageId"), o.optString("title"), o.optString("body"), notifyContent, o.optString("avatar", null), o.optBoolean("starred", false));
                    break;
                case "notify-clear": {
                    // The chats were read (here, through the notification action, or on another device): their notifications go away.
                    if (app == null) break;
                    JSONArray ids = o.optJSONArray("chatIds");
                    if (ids == null || ids.length() == 0) { Notifier.clearMessages(app); break; }
                    for (int i = 0; i < ids.length(); i++) Notifier.clearChat(app, ids.optString(i));
                    break;
                }
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

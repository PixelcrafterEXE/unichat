package app.unimsg.android.node;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Process;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Starts the Node.js runtime (nodejs-mobile, libnode.so) inside this process.
 *
 * nodejs-mobile can start Node ONCE per process: node::Start cannot be called again after it returns. So if Node ever
 * exits we terminate the process; NodeService is START_STICKY and the system recreates it in a fresh process. Repeated
 * exits are counted so that the service waits longer and longer before trying again (see restartDelayMs).
 */
public final class NodeRuntime {
    private static final String TAG = "UnimsgNode";
    private static boolean started = false;

    static { System.loadLibrary("c++_shared"); System.loadLibrary("node"); System.loadLibrary("unimsg-node");
        // libsignal add-on (Signal provider): present only when built with scripts/build-libsignal-android.sh. Loaded here so the later process.dlopen("libsignal_client_node.so") in Node finds it by soname
        // (the APK keeps native libs uncompressed inside the APK, there is no nativeLibraryDir file to open by path).
        try { System.loadLibrary("signal_client_node"); } catch (UnsatisfiedLinkError e) { Log.i(TAG, "no libsignal add-on in this build: Signal unavailable"); }
        // HyperDHT add-ons ("Reach my devices from anywhere"): present only when built with scripts/build-hyperdht-android.sh; node's process.dlopen("libudx_native.so") then finds them by soname.
        // Missing or unloadable = the feature says "not available on this platform", nothing else changes.
        for (String lib : new String[] { "udx_native", "sodium_native" }) {
            try { System.loadLibrary(lib); } catch (UnsatisfiedLinkError e) { Log.i(TAG, "no " + lib + " add-on in this build: HyperDHT unavailable"); }
        } }

    /** Runs node::Start(argc, argv) on the calling thread; returns when Node exits. stdout/stderr go to logcat (tag UnimsgNode). */
    private static native int nativeStart(String[] argv);

    public static synchronized void ensureStarted(Context ctx) throws Exception {
        if (started) return;
        started = true;
        final Context app = ctx.getApplicationContext();
        final File files = app.getFilesDir();
        final File project = new File(files, "nodejs-project");
        extractIfChanged(app.getAssets(), project);

        final String data = new File(files, "unimsg-data").getAbsolutePath();
        final String sock = new File(files, "bridge.sock").getAbsolutePath(); // sun_path is limited to 107 bytes: keep the name short
        Os.setenv("UNIMSG_DATA", data, true);
        Os.setenv("UNIMSG_SOCKET", sock, true);
        Os.setenv("UNIMSG_DEVICE_NAME", android.os.Build.MANUFACTURER.substring(0, 1).toUpperCase() + android.os.Build.MANUFACTURER.substring(1) + " " + android.os.Build.MODEL, true); // hostname() is "localhost" on Android
        Os.setenv("UNIMSG_DB_KEY", DataKey.hexKey(app), true);            // sealed by the Android Keystore, see DataKey
        Os.setenv("UNIMSG_SQLITE", "auto", true);
        Os.setenv("HOME", files.getAbsolutePath(), true);
        Os.setenv("TMPDIR", app.getCacheDir().getAbsolutePath(), true);
        Os.setenv("UNIMSG_PLATFORM", "android", true);

        NodeBridge.get().start(app, sock);
        Thread t = new Thread(null, () -> {
            int rc = nativeStart(new String[]{"node", new File(project, "main.js").getAbsolutePath()});
            Log.e(TAG, "node exited with code " + rc + "; restarting the process");
            noteExit(app); // before the kill: the backoff below has to survive this process
            Process.killProcess(Process.myPid());
        }, "unimsg-node", 8L * 1024 * 1024);
        t.start();
    }

    // ---- crash-loop backoff ------------------------------------------------------------------------------------------
    // Node exiting kills the process and START_STICKY starts the service again, so a bundle that cannot run (parse error,
    // unreadable archive, missing add-on) would restart as fast as the runtime can fail and empty the battery in minutes.
    // The exits are counted in SharedPreferences because nothing in this process outlives them.
    private static final long EXIT_WINDOW_MS = 600_000, EXIT_FIRST_WAIT_MS = 5_000, EXIT_MAX_WAIT_MS = 300_000;
    private static final int EXIT_GIVE_UP = 6;

    private static void noteExit(Context app) {
        NativePrefs p = new NativePrefs(app);
        StringBuilder b = new StringBuilder();
        for (long at : recentExits(p)) b.append(at).append(',');
        p.setNodeExits(b.append(System.currentTimeMillis()).toString());
    }

    /** The exits of the last EXIT_WINDOW_MS, oldest first. */
    private static java.util.List<Long> recentExits(NativePrefs p) {
        java.util.List<Long> out = new java.util.ArrayList<>();
        long now = System.currentTimeMillis();
        for (String t : p.nodeExits().split(",")) {
            if (t.isEmpty()) continue;
            // at > now: the clock jumped backwards (time zone, NTP); such an entry would never expire, so drop it
            try { long at = Long.parseLong(t); if (at <= now && now - at < EXIT_WINDOW_MS) out.add(at); } catch (NumberFormatException ignored) { }
        }
        return out;
    }

    /**
     * How long NodeService should wait before starting Node again: 0 after a clean run, otherwise 5 s doubling with every
     * exit in the last 10 minutes up to 5 min (minus the time the restart itself took), and -1 = give up after 6 exits.
     * Giving up stops the service and leaves the user a notification; opening the app clears the count (forgetExits).
     */
    public static long restartDelayMs(Context ctx) {
        java.util.List<Long> exits = recentExits(new NativePrefs(ctx.getApplicationContext())); // read only: noteExit prunes, so the list cannot grow
        int n = exits.size();
        if (n == 0) return 0;
        if (n >= EXIT_GIVE_UP) return -1;
        long waited = System.currentTimeMillis() - exits.get(n - 1);
        return Math.max(Math.min(EXIT_FIRST_WAIT_MS << (n - 1), EXIT_MAX_WAIT_MS) - waited, 0);
    }

    /** The user opened the app: that IS the retry, so the backoff starts over (and a service that gave up starts again). */
    public static void forgetExits(Context ctx) { new NativePrefs(ctx.getApplicationContext()).setNodeExits(""); }

    /**
     * Restarts the whole app process: node::Start cannot run twice in one process, so the only clean restart of the backend is a new process.
     * The archive is flushed first ($flush, sql.js writes tmp + fsync + rename, see sqljs-persist.ts) and we wait briefly for the answer. Then the process is killed;
     * NodeService is START_STICKY (the system recreates it, allowed for a foreground service), and an alarm re-starts it as a second path.
     * Rate limited: at most 3 restarts per 10 minutes, so a backend that cannot start never causes a restart loop.
     */
    public static void restartProcess(final Context ctx, final String why) {
        final Context app = ctx.getApplicationContext();
        NativePrefs prefs = new NativePrefs(app);
        long now = System.currentTimeMillis(); StringBuilder keep = new StringBuilder(); int n = 0;
        for (String t : prefs.restarts().split(",")) { if (t.isEmpty()) continue; try { if (now - Long.parseLong(t) < 600_000) { keep.append(t).append(','); n++; } } catch (NumberFormatException ignored) { } }
        if (n >= 3) { Log.e(TAG, "not restarting (" + why + "): 3 restarts in 10 minutes already"); return; }
        prefs.setRestarts(keep.toString() + now);
        Log.w(TAG, "restarting the app process: " + why);
        NodeBridge.get().flushAndThen(2000, () -> {
            try {
                android.app.AlarmManager am = (android.app.AlarmManager) app.getSystemService(Context.ALARM_SERVICE);
                android.app.PendingIntent pi = android.app.PendingIntent.getForegroundService(app, 77, new android.content.Intent(app, NodeService.class).putExtra(NodeService.EXTRA_RESTART, true), android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                if (am != null) am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 1500, pi);
            } catch (Exception e) { Log.w(TAG, "restart alarm refused: " + e); }
            Process.killProcess(Process.myPid());
        });
    }

    /** Copies assets/nodejs-project to filesDir when its bundle-id.txt differs from the extracted one (new app version). */
    private static void extractIfChanged(AssetManager am, File dest) throws Exception {
        String want = readAsset(am, "nodejs-project/bundle-id.txt").trim();
        File idFile = new File(dest, "bundle-id.txt");
        if (idFile.exists() && new String(Files.readAllBytes(idFile.toPath()), StandardCharsets.UTF_8).trim().equals(want)) return;
        deleteRecursive(dest);
        copyAssetDir(am, "nodejs-project", dest);
        Log.i(TAG, "extracted nodejs-project " + want);
    }

    private static void copyAssetDir(AssetManager am, String path, File dest) throws Exception {
        String[] kids = am.list(path);
        if (kids != null && kids.length > 0) {
            dest.mkdirs();
            for (String k : kids) copyAssetDir(am, path + "/" + k, new File(dest, k));
        } else {
            dest.getParentFile().mkdirs();
            try (InputStream in = am.open(path); FileOutputStream out = new FileOutputStream(dest)) {
                byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) out.write(b, 0, n);
            }
        }
    }

    private static String readAsset(AssetManager am, String p) throws Exception {
        try (InputStream in = am.open(p)) { return new String(in.readAllBytes(), StandardCharsets.UTF_8); }
    }

    private static void deleteRecursive(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        f.delete();
    }
}

package app.unimsg.android.node;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import app.unimsg.android.BuildConfig;

/**
 * Foreground service that keeps the app process, and with it the Node runtime and the messenger sockets, alive while the UI is
 * closed. The runtime is started here, not in the activity, so that a START_STICKY restart after the system killed the process brings
 * the backend back without any UI. That pair (NodeRuntime kills the process when Node exits, START_STICKY brings it back) is a
 * restart loop when Node cannot run at all, so the start is delayed by NodeRuntime.restartDelayMs and finally given up on.
 *
 * Service type (see README "Foreground service type"): `specialUse` by default, `remoteMessaging` with -Punimsg.fgsType=remoteMessaging.
 * Both exist from API 34 and neither has the Android 15 time limit that dataSync has. Below API 34 the type argument does not exist
 * for these values, so we call the two-argument startForeground (the system then uses the manifest type, ignored before 34).
 */
public class NodeService extends Service {
    private static final String TAG = "UnimsgService";
    public static final String EXTRA_FROM_BOOT = "fromBoot", EXTRA_RESTART = "restartAfterTimeout";
    private final Handler main = new Handler(Looper.getMainLooper());
    private NetworkMonitor network;
    private PowerMonitor power;
    private android.net.wifi.WifiManager.MulticastLock multicast;
    private android.net.wifi.WifiManager.WifiLock wifi; // keeps the Wi-Fi radio out of power save so the PC can reach the sync listener while the screen is off
    /** Starting the Node runtime; a field so that a start delayed by the crash backoff can be cancelled in onDestroy. */
    private final Runnable startRuntime = () -> {
        try {
            NodeRuntime.ensureStarted(this);
        } catch (Throwable e) { // includes UnsatisfiedLinkError (missing/ABI-mismatched native libs), which is an Error
            Log.e(TAG, "backend failed to start", e);
            getSystemService(NotificationManager.class).notify(Notifier.SERVICE_ID, Notifier.serviceNotification(this, "Backend failed to start (see logcat: UnimsgService)"));
        }
    };

    static int fgsType() {
        if (Build.VERSION.SDK_INT < 34) return 0;
        return "remoteMessaging".equals(BuildConfig.FGS_TYPE) ? ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING : ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notifier.createChannels(this);
        Notification n = Notifier.serviceNotification(this, statusText(this));
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(Notifier.SERVICE_ID, n, fgsType());
            else startForeground(Notifier.SERVICE_ID, n);
        } catch (Exception e) { // ForegroundServiceStartNotAllowedException when (re)started from the background on Android 12+, missing permission, ...
            Log.e(TAG, "cannot enter the foreground", e);
            Notifier.showReconnectNeeded(this, "Android did not allow UniChat to stay connected in the background. Tap to open it.");
            stopSelf(); return START_NOT_STICKY;
        }
        long wait = NodeRuntime.restartDelayMs(this);
        if (wait < 0) { // Node died again and again: stop the restart loop instead of emptying the battery with it
            Log.e(TAG, "backend crash loop: not starting Node again");
            Notifier.showReconnectNeeded(this, "UniChat's backend stopped several times in a row, so it is not being restarted automatically any more. Tap to open the app and try again.");
            stopSelf(); return START_NOT_STICKY;
        }
        if (wait == 0) startRuntime.run();
        else { Log.w(TAG, "backend start delayed by " + wait + " ms (recent crashes)"); main.postDelayed(startRuntime, wait); }
        if (network == null) { network = new NetworkMonitor(this); network.start(); }
        if (power == null) { power = new PowerMonitor(this); power.start(); }
        updateMulticast();
        return START_STICKY;
    }

    /** What the permanent notification says: why the service runs. */
    static String statusText(Context c) {
        NativePrefs p = new NativePrefs(c); int n = p.accountCount();
        if (n > 0 && p.syncGroup()) return "Keeping " + n + (n == 1 ? " account" : " accounts") + " connected and your devices in sync";
        if (n > 0) return "Keeping " + n + (n == 1 ? " account" : " accounts") + " connected so messages arrive";
        if (p.syncGroup()) return "Keeping your devices in sync (reachable on your Wi-Fi and through the internet)";
        return "Connected to your messengers";
    }

    /** Called by the bridge when the backend reports accounts / sync state: update the notification text and what the service holds (multicast lock). */
    static void refreshNotification(Context c) {
        try { c.getSystemService(NotificationManager.class).notify(Notifier.SERVICE_ID, Notifier.serviceNotification(c, statusText(c))); } catch (Exception ignored) { }
        if (instance != null) instance.main.post(instance::updateMulticast);
    }
    private static volatile NodeService instance;

    /** Android drops incoming multicast (mDNS queries from the other devices) unless a lock is held; the activity's lock ends when the UI closes, so the service holds one while sync is on. */
    private void updateMulticast() {
        try {
            boolean want = new NativePrefs(this).syncGroup();
            if (want && multicast == null) {
                android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wm != null) {
                    multicast = wm.createMulticastLock("unichat-sync-svc"); multicast.setReferenceCounted(false); multicast.acquire();
                    wifi = wm.createWifiLock(android.os.Build.VERSION.SDK_INT >= 29 ? android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY : android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "unichat-sync-wifi");
                    wifi.setReferenceCounted(false); wifi.acquire();
                }
            } else if (!want && multicast != null) {
                multicast.release(); multicast = null;
                if (wifi != null) { if (wifi.isHeld()) wifi.release(); wifi = null; }
            }
        } catch (Exception e) { Log.w(TAG, "multicast lock: " + e.getMessage()); }
    }

    @Override public void onCreate() { super.onCreate(); instance = this; }

    @Override public void onDestroy() {
        if (network != null) network.stop();
        if (power != null) power.stop();
        main.removeCallbacks(startRuntime);
        try { if (multicast != null && multicast.isHeld()) multicast.release(); } catch (Exception ignored) { }
        try { if (wifi != null && wifi.isHeld()) wifi.release(); } catch (Exception ignored) { }
        instance = null; super.onDestroy();
    }

    /**
     * Called by Android 15+ when a time-limited foreground service type (dataSync, mediaProcessing) used up its budget. Our types are
     * not limited, but the OS may change that, so we handle it: we MUST stop within a few seconds or the app crashes (ANR-style). We stop,
     * tell the user why with a notification (tap = open the app = restart), and make one delayed best-effort restart attempt, which the OS
     * rejects while the budget is exhausted; that rejection is caught in onStartCommand's path and leaves only the notification.
     */
    @Override
    public void onTimeout(int startId, int fgsType) {
        Log.w(TAG, "foreground service time budget exhausted (type " + fgsType + ")");
        Notifier.showReconnectNeeded(this, "Android limits how long an app may keep a background connection. UniChat paused it; open the app to reconnect. Messages arrive again once it runs.");
        stopSelf(startId);
        final android.content.Context app = getApplicationContext();
        main.postDelayed(() -> {
            try { ContextCompat.startForegroundService(app, new Intent(app, NodeService.class).putExtra(EXTRA_RESTART, true)); }
            catch (Exception e) { Log.w(TAG, "automatic restart refused: " + e); }
        }, 2000);
    }

    @Override public void onTimeout(int startId) { onTimeout(startId, 0); }

    @Override public void onTrimMemory(int level) { super.onTrimMemory(level); if (level >= TRIM_MEMORY_RUNNING_LOW) NodeBridge.get().flush(); }

    @Override public void onLowMemory() { super.onLowMemory(); NodeBridge.get().flush(); }

    @Override public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent); NodeBridge.get().flush();
        // swiping the app away must not end the backend: the service is not stopped with the task (manifest stopWithTask=false); some OEMs kill it anyway, so ask to be started again shortly
        NativePrefs p = new NativePrefs(this);
        if (p.keepAlive() && p.hasWork()) {
            try {
                android.app.AlarmManager am = (android.app.AlarmManager) getSystemService(ALARM_SERVICE);
                android.app.PendingIntent pi = android.app.PendingIntent.getForegroundService(this, 78, new Intent(this, NodeService.class).putExtra(EXTRA_RESTART, true), android.app.PendingIntent.FLAG_IMMUTABLE | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
                if (am != null) am.set(android.app.AlarmManager.RTC, System.currentTimeMillis() + 2000, pi);
            } catch (Exception e) { Log.w(TAG, "restart after task removal not scheduled: " + e); }
        }
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}

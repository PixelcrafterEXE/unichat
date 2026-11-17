package app.unimsg.android;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import app.unimsg.android.node.NodeBridge;
import app.unimsg.android.node.NodeService;

import com.getcapacitor.BridgeActivity;

/**
 * Hosts the Capacitor WebView that renders apps/ui. The backend does not live here: NodeService starts it (nodejs-mobile) and
 * NodeBridge connects it to the page through UnimsgPlugin. This activity only (1) starts the service, (2) asks for the
 * notification permission once, (3) reports foreground/background to the backend so it knows when to raise notifications,
 * (4) handles the back button and notification taps.
 *
 * Camera / microphone for the WebView: Capacitor's BridgeWebChromeClient already answers getUserMedia requests by asking for
 * the matching runtime permission (RECORD_AUDIO / CAMERA, declared in the manifest) and implements the file chooser for
 * &lt;input type=file&gt;. No custom WebChromeClient is needed.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "UnimsgMain";
    private static final String EXTRA_CHAT = "chatId";
    private static final int REQ_NOTIFICATIONS = 4711;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** Storage Access Framework folder picker for "Find the backup on this phone" (see node/SafImport). Registered here: the launcher must exist before the activity starts. */
    private java.util.function.Consumer<android.net.Uri> treeResult;
    private final androidx.activity.result.ActivityResultLauncher<android.net.Uri> treePicker =
        registerForActivityResult(new androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree(), uri -> {
            java.util.function.Consumer<android.net.Uri> cb = treeResult; treeResult = null; if (cb != null) cb.accept(uri); // uri == null: cancelled
        });
    // Android drops incoming multicast packets unless an app holds this lock: without it mDNS ("Sync devices" > nearby devices) finds nothing.
    private WifiManager.MulticastLock multicastLock;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UnimsgPlugin.class); // before super.onCreate: its load() installs the bridge before the first page load
        super.onCreate(savedInstanceState);

        current = new java.lang.ref.WeakReference<>(this);
        askNotificationPermissionOnce();
        ContextCompat.startForegroundService(this, new Intent(this, NodeService.class)); // allowed: we are in the foreground

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { onBack(); }
        });

        // If the first page load happened before the shim was installed (should not, see UnimsgPlugin) the UI would silently
        // fall back to its WebSocket transport. Detect "no hello after 5 s" and reload once.
        main.postDelayed(() -> { if (!NodeBridge.get().uiAttached()) { Log.w(TAG, "shim not attached, reloading WebView"); getBridge().getWebView().reload(); } }, 5000);

        openChatFrom(getIntent());
        syncLinkFrom(getIntent());
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); openChatFrom(intent); syncLinkFrom(intent); }

    @Override public void onStart() {
        super.onStart(); NodeBridge.get().setUiForeground(true); acquireMulticast();
        main.postDelayed(this::askBatteryExemptionOnce, 4000); // after the first state report of the backend (accounts / sync group)
    }

    /**
     * Once, and only when there is something to keep connected (an account or a sync group): explain why, then open the system's "ignore battery optimisations" dialog.
     * Without the exemption Doze delays timers and drops network access of a background app after a while: the sync listener and the messenger sockets go quiet.
     * Declining is final (never asked again); the same switch stays in Settings > Keep running in the background.
     */
    private void askBatteryExemptionOnce() {
        try {
            if (isFinishing() || isDestroyed()) return;
            app.unimsg.android.node.NativePrefs prefs = new app.unimsg.android.node.NativePrefs(this);
            if (prefs.askedBattery() || !prefs.hasWork()) return;
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) { prefs.setAskedBattery(true); return; }
            prefs.setAskedBattery(true);
            new android.app.AlertDialog.Builder(this)
                .setTitle("Stay connected in the background?")
                .setMessage("To receive messages and keep your devices in sync while UniChat is closed, Android must not put it to sleep. On the next screen choose \"Allow\". You can change this later in Settings > Keep running in the background.")
                .setPositiveButton("Continue", (d, w) -> {
                    try { startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, android.net.Uri.parse("package:" + getPackageName()))); }
                    catch (Exception e) { try { startActivity(new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception e2) { Log.w(TAG, "no battery settings screen"); } }
                })
                .setNegativeButton("Not now", null).show();
        } catch (Exception e) { Log.w(TAG, "battery dialog: " + e); }
    }

    private void acquireMulticast() {
        try {
            if (multicastLock == null) {
                WifiManager wifi = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wifi == null) return;
                multicastLock = wifi.createMulticastLock("unichat-sync");
                multicastLock.setReferenceCounted(false);
            }
            if (!multicastLock.isHeld()) multicastLock.acquire();
        } catch (Exception e) { Log.w(TAG, "multicast lock not available: " + e.getMessage()); }
    }

    private void releaseMulticast() {
        try { if (multicastLock != null && multicastLock.isHeld()) multicastLock.release(); } catch (Exception ignored) { }
    }

    @Override public void onTrimMemory(int level) { super.onTrimMemory(level); if (level >= TRIM_MEMORY_UI_HIDDEN) NodeBridge.get().flush(); }

    @Override public void onStop() { super.onStop(); NodeBridge.get().setUiForeground(false); releaseMulticast(); }

    /** The UI may call event.preventDefault() on a cancelable "unimsg-back" window event to handle back itself (close a dialog, ...). */
    private void onBack() {
        final WebView wv = getBridge().getWebView();
        wv.evaluateJavascript("(function(){try{return window.dispatchEvent(new CustomEvent('unimsg-back',{cancelable:true}))}catch(e){return true}})()", v -> {
            if (!"true".equals(v)) return;            // the UI consumed it
            if (wv.canGoBack()) wv.goBack();
            else moveTaskToBack(true);                // keep the backend running; do not finish the activity
        });
    }

    private void openChatFrom(Intent i) {
        if (i == null) return;
        String chat = i.getStringExtra(EXTRA_CHAT);
        if (chat != null) { NodeBridge.get().openChat(chat); i.removeExtra(EXTRA_CHAT); }
    }

    /** unichat-sync://pair?... (QR code scanned with the system camera, tapped in a browser): hand it to the UI, which opens Sync devices and starts joining. */
    private void syncLinkFrom(Intent i) {
        if (i == null || !Intent.ACTION_VIEW.equals(i.getAction())) return;
        android.net.Uri u = i.getData();
        if (u == null || !"unichat-sync".equals(u.getScheme()) || !"pair".equals(u.getHost())) return;
        NodeBridge.get().openSyncLink(u.toString());
        i.setData(null); // handled once (not again after a rotation / recreate)
    }

    public static Intent openChatIntent(android.content.Context c, String chatId) {
        return new Intent(c, MainActivity.class).putExtra(EXTRA_CHAT, chatId).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    private static java.lang.ref.WeakReference<MainActivity> current;
    /** The activity while it is alive, else null (only the service runs). Callers that start an activity need it: a start from an application context is dropped silently in the background. */
    public static android.app.Activity onScreen() {
        MainActivity a = current == null ? null : current.get();
        return a == null || a.isFinishing() || a.isDestroyed() ? null : a;
    }
    public static boolean notificationsGranted(android.content.Context c) {
        return Build.VERSION.SDK_INT < 33 || c.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }
    /** From a button in Settings > Notifications: the system dialog if Android still shows it, otherwise this app's notification settings (Android stops showing the dialog after a denial). */
    public static boolean requestNotifications() {
        MainActivity a = current == null ? null : current.get();
        if (a == null || notificationsGranted(a)) return false;
        a.runOnUiThread(() -> {
            SharedPreferences p = a.getSharedPreferences("unimsg", MODE_PRIVATE);
            boolean denied = p.getBoolean("askedNotifications", false);
            if (Build.VERSION.SDK_INT >= 33 && (!denied || ActivityCompat.shouldShowRequestPermissionRationale(a, Manifest.permission.POST_NOTIFICATIONS))) {
                p.edit().putBoolean("askedNotifications", true).apply();
                ActivityCompat.requestPermissions(a, new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
            } else {
                try { a.startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, a.getPackageName())); }
                catch (Exception e) { Log.w("UniChat", "no notification settings screen", e); }
            }
        });
        return true;
    }

    /** Opens the system folder picker at `initial` (a hint only). `result` gets the chosen folder, or null when the user backed out. False if no activity is on screen. */
    public static boolean pickTree(android.net.Uri initial, java.util.function.Consumer<android.net.Uri> result) {
        MainActivity a = current == null ? null : current.get();
        if (a == null || a.isFinishing() || a.isDestroyed()) return false;
        a.runOnUiThread(() -> {
            try { a.treeResult = result; a.treePicker.launch(initial); }
            catch (Exception e) { a.treeResult = null; Log.w(TAG, "no folder picker: " + e); result.accept(null); }
        });
        return true;
    }

    private void askNotificationPermissionOnce() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences p = getSharedPreferences("unimsg", MODE_PRIVATE);
        if (p.getBoolean("askedNotifications", false)) return; // do not nag; the user can enable it in system settings
        p.edit().putBoolean("askedNotifications", true).apply();
        ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATIONS);
    }
}

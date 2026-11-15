package app.unimsg.android.node;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * Restarts the foreground service after a reboot or an app update, but only if the user enabled "keep running in background"
 * ($config {keepAlive:true}) and the backend last reported at least one account.
 *
 * Android 15 forbids starting foreground services of these types from a BOOT_COMPLETED receiver: dataSync, camera, mediaPlayback,
 * phoneCall, mediaProjection, microphone (ForegroundServiceStartNotAllowedException). We use specialUse / remoteMessaging, which are
 * not on that list, so the normal path works. Because OEM builds and later releases can tighten this, any failure is caught and the
 * user gets a notification ("Tap to reconnect") that opens the app, which can always start the service. Direct-boot
 * (LOCKED_BOOT_COMPLETED) is deliberately not handled: the archive key and data are credential-protected storage.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "UnimsgBoot";

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent == null ? null : intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        NativePrefs prefs = new NativePrefs(ctx);
        if (!prefs.keepAlive() || !prefs.hasWork()) { Log.i(TAG, "not restarting (keepAlive=" + prefs.keepAlive() + ", accounts=" + prefs.accountCount() + ", syncGroup=" + prefs.syncGroup() + ")"); return; }
        try {
            ContextCompat.startForegroundService(ctx, new Intent(ctx, NodeService.class).putExtra(NodeService.EXTRA_FROM_BOOT, true));
        } catch (Exception e) { // ForegroundServiceStartNotAllowedException / BackgroundServiceStartNotAllowedException
            Log.w(TAG, "cannot start the service from " + a, e);
            Notifier.showReconnectNeeded(ctx, "UniChat could not reconnect in the background after the restart. Tap to open it.");
        }
    }
}

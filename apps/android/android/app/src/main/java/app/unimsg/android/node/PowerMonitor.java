package app.unimsg.android.node;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.content.ContextCompat;

/**
 * Tells the backend when the phone is in battery saver or low on battery, so it can drop work that is only nice to have:
 * the Hub pauses its avatar pre-warming ($power control call -> setAvatarWarmPaused, see apps/android/src/warm-pause.ts).
 * Android broadcasts both changes, so nothing is polled: the state is read once from the sticky battery broadcast and
 * then follows ACTION_BATTERY_LOW / _OKAY and ACTION_POWER_SAVE_MODE_CHANGED. Registered by NodeService while it runs.
 */
final class PowerMonitor extends BroadcastReceiver {
    private static final String TAG = "UnimsgPower";
    private final Context app;
    private final PowerManager pm;
    private boolean registered = false, low = false;

    PowerMonitor(Context c) { app = c.getApplicationContext(); pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE); }

    void start() {
        if (registered) return;
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_BATTERY_LOW); f.addAction(Intent.ACTION_BATTERY_OKAY); f.addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED);
        try { ContextCompat.registerReceiver(app, this, f, ContextCompat.RECEIVER_NOT_EXPORTED); registered = true; }
        catch (Exception e) { Log.w(TAG, "cannot watch the battery: " + e); return; }
        low = lowNow();
        push();
    }

    void stop() { if (!registered) return; try { app.unregisterReceiver(this); } catch (Exception ignored) { } registered = false; }

    @Override public void onReceive(Context c, Intent i) {
        String a = i.getAction();
        if (Intent.ACTION_BATTERY_LOW.equals(a)) low = true;
        else if (Intent.ACTION_BATTERY_OKAY.equals(a)) low = false;
        push(); // a power-save change carries no extras: isPowerSaveMode() is the state
    }

    private void push() { NodeBridge.get().sendPower(pm != null && pm.isPowerSaveMode(), low); }

    /**
     * ACTION_BATTERY_LOW only fires at the moment the battery becomes low, so the state when the service starts comes from
     * the sticky battery broadcast (registering with a null receiver reads it without keeping a receiver). Android does not
     * expose its own threshold; 15 % while not charging is what AOSP uses.
     */
    private boolean lowNow() {
        try {
            Intent b = ContextCompat.registerReceiver(app, null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED);
            if (b == null) return false;
            int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            if (status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL) return false;
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            return level >= 0 && scale > 0 && level * 100 / scale <= 15;
        } catch (Exception e) { Log.w(TAG, "battery state unknown: " + e); return false; }
    }
}

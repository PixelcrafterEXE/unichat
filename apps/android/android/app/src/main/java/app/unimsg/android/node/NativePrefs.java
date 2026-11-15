package app.unimsg.android.node;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Tiny SharedPreferences flag store shared by the bridge, the boot receiver and the service. File "unimsg" (the same one MainActivity
 * uses for askedNotifications). Plain device-protected-NOT storage: it only holds booleans/counters, never message data.
 *   keepAlive      user opted in to "keep running in background": restart the service after boot / app update. Default false.
 *   accountCount   reported by the backend ({"ctl":"state"}); the boot receiver does nothing when there is nothing to keep connected.
 *   notifyContent  full | sender | hidden (survives restarts so a service restarted without UI still honours the privacy mode)
 */
public final class NativePrefs {
    private final SharedPreferences p;
    public NativePrefs(Context c) { p = c.getApplicationContext().getSharedPreferences("unimsg", Context.MODE_PRIVATE); }

    public boolean keepAlive() { return p.getBoolean("keepAlive", true); }
    public void setKeepAlive(boolean v) { p.edit().putBoolean("keepAlive", v).apply(); }
    /** this device belongs to a sync group (reported by the backend): a reason to keep the service alive even without accounts */
    public boolean syncGroup() { return p.getBoolean("syncGroup", false); }
    public void setSyncGroup(boolean v) { p.edit().putBoolean("syncGroup", v).apply(); }
    public boolean askedBattery() { return p.getBoolean("askedBattery", false); }
    public void setAskedBattery(boolean v) { p.edit().putBoolean("askedBattery", v).apply(); }
    /** something worth keeping connected exists (accounts or a sync group) */
    public boolean hasWork() { return accountCount() > 0 || syncGroup(); }
    /** timestamps (ms) of the last watchdog restarts: a restart loop must stop after a few tries */
    public String restarts() { return p.getString("restarts", ""); }
    public void setRestarts(String v) { p.edit().putString("restarts", v).apply(); }
    public int accountCount() { return p.getInt("accountCount", 0); }
    public void setAccountCount(int n) { p.edit().putInt("accountCount", n).apply(); }
    public String notifyContent() {
        String v = p.getString("notifyContent", "full");
        return "sender".equals(v) || "hidden".equals(v) ? v : "full";
    }
    public void setNotifyContent(String v) { p.edit().putString("notifyContent", v).apply(); }
}

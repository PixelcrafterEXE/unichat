package app.unimsg.android.node;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.Inet4Address;
import java.net.InetAddress;

/**
 * Tells the backend which IP addresses this phone has, every time the connectivity changes (Wi-Fi switched, mobile data, VPN, resume from Doze).
 * Why: (1) os.networkInterfaces() inside nodejs-mobile can fail on newer Android versions, (2) the sync listener, the mDNS announcement and the addresses sent
 * to the other devices must follow the network at once, and Android tells us exactly when. The backend answers by rebinding its listener, re-announcing the
 * addresses over every live session / the DHT, and clearing the dial back-off ($network control call, see apps/android/src/bridge-protocol.ts).
 * The same call carries whether the active network is metered, which stops background update checks and avatar pre-warming.
 * Debounced (a Wi-Fi switch fires several callbacks); registered by NodeService for as long as it runs.
 */
final class NetworkMonitor extends ConnectivityManager.NetworkCallback {
    private static final String TAG = "UnimsgNet";
    private final Context app; private final ConnectivityManager cm; private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable push = this::pushNow; private boolean registered = false;

    NetworkMonitor(Context c) { app = c.getApplicationContext(); cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE); }

    void start() {
        if (registered || cm == null) return;
        try {
            cm.registerNetworkCallback(new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), this, main);
            registered = true; pushSoon();
        } catch (Exception e) { Log.w(TAG, "cannot watch the network: " + e); }
    }
    void stop() { if (!registered) return; try { cm.unregisterNetworkCallback(this); } catch (Exception ignored) { } registered = false; main.removeCallbacks(push); }

    private void pushSoon() { main.removeCallbacks(push); main.postDelayed(push, 700); }
    @Override public void onAvailable(Network n) { pushSoon(); }
    @Override public void onLost(Network n) { pushSoon(); }
    @Override public void onLinkPropertiesChanged(Network n, LinkProperties lp) { pushSoon(); }
    @Override public void onCapabilitiesChanged(Network n, NetworkCapabilities nc) { pushSoon(); }

    /** All addresses of all networks that are not mobile-only loopback; VPN networks are included (the backend decides what is private / advertisable). */
    private void pushNow() {
        JSONArray list = new JSONArray();
        try {
            for (Network n : cm.getAllNetworks()) {
                LinkProperties lp = cm.getLinkProperties(n); if (lp == null) continue;
                String name = lp.getInterfaceName() == null ? "net" : lp.getInterfaceName();
                for (LinkAddress la : lp.getLinkAddresses()) {
                    InetAddress a = la.getAddress();
                    if (a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isAnyLocalAddress()) continue;
                    boolean v4 = a instanceof Inet4Address; String host = a.getHostAddress(); if (host == null) continue; host = host.replaceAll("%.*$", "");
                    JSONObject o = new JSONObject().put("name", name).put("address", host).put("family", v4 ? 4 : 6);
                    if (v4) { int p = la.getPrefixLength(); long mask = p == 0 ? 0 : (0xffffffffL << (32 - p)) & 0xffffffffL; o.put("netmask", ((mask >> 24) & 255) + "." + ((mask >> 16) & 255) + "." + ((mask >> 8) & 255) + "." + (mask & 255)); }
                    list.put(o);
                }
            }
        } catch (Exception e) { Log.w(TAG, "reading the network failed: " + e); return; }
        NodeBridge.get().sendNetwork(list, metered());
    }

    /**
     * Is what the phone currently uses paid for by the megabyte? Android answers this with the absence of
     * NET_CAPABILITY_NOT_METERED (mobile data, a tethered hotspot, a Wi-Fi the user marked as metered).
     * No network at all counts as not metered: nothing can be spent, and the backend must not stay paused when it comes back.
     */
    private boolean metered() {
        try {
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities nc = cm.getNetworkCapabilities(n);
            if (nc == null) return cm.isActiveNetworkMetered();
            return !nc.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        } catch (Exception e) { Log.w(TAG, "metered state unknown: " + e); return false; }
    }
}

package app.unimsg.android;

import android.util.Log;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;

import app.unimsg.android.node.NodeBridge;

/**
 * Not a plugin the UI calls (it has no @PluginMethod). Capacitor loads plugins before it loads the first page, which makes
 * load() the right moment to install, for the page origin https://localhost ONLY:
 *   1. assets/unimsg/shim.js as a document-start script  -> defines window.UnimsgNative (what apps/ui/src/api.ts looks for)
 *   2. a WebMessageListener named __UnimsgHost            -> the origin-restricted pipe the shim uses to reach NodeBridge
 * A JavascriptInterface would be reachable from every frame that ever loads in the WebView; the listener is not.
 */
@CapacitorPlugin(name = "UnimsgBridge")
public class UnimsgPlugin extends Plugin {
    private static final String TAG = "UnimsgPlugin";
    private static final Set<String> ORIGINS = Collections.singleton("https://localhost"); // capacitor.config.ts: androidScheme https

    @Override
    public void load() {
        WebView wv = getBridge().getWebView();
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Log.e(TAG, "This Android System WebView is too old (needs WebMessageListener + document-start scripts, WebView 86+). The UI cannot reach the backend.");
            return;
        }
        try {
            String shim = readAsset("unimsg/shim.js");
            WebViewCompat.addDocumentStartJavaScript(wv, shim, ORIGINS);
            WebViewCompat.addWebMessageListener(wv, "__UnimsgHost", ORIGINS,
                (WebView view, WebMessageCompat message, android.net.Uri sourceOrigin, boolean isMainFrame, JavaScriptReplyProxy reply) -> {
                    if (!isMainFrame || message.getType() != WebMessageCompat.TYPE_STRING) return;
                    NodeBridge.get().onUiMessage(message.getData(), reply);
                });
        } catch (Exception e) {
            Log.e(TAG, "could not install the bridge", e);
        }
    }

    private String readAsset(String name) throws java.io.IOException {
        try (InputStream in = getContext().getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] b = new byte[8192]; int n;
            while ((n = in.read(b)) > 0) out.write(b, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }
}

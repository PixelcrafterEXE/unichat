import type { CapacitorConfig } from "@capacitor/cli";

// The WebView serves the UI build (apps/ui/dist) from https://localhost inside the app. No remote URL, no cleartext.
// The backend is NOT reached over the network: the shim injected by MainActivity defines window.UnimsgNative,
// which makes apps/ui/src/api.ts pick its "Android bridge" transport.
const config: CapacitorConfig = {
  appId: "app.unimsg.android",
  appName: "UniChat",
  webDir: "../ui/dist",
  android: {
    path: "android",
    allowMixedContent: false,
    webContentsDebuggingEnabled: false, // flip to true locally for chrome://inspect
  },
  server: { androidScheme: "https", cleartext: false },
};
export default config;

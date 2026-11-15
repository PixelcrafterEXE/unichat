// Replaces `node-gyp-build` for @signalapp/libsignal-client inside the Android bundle: loads the cross-compiled add-on that the
// app packages as jniLibs/<abi>/libsignal_client_node.so (NodeRuntime.java System.loadLibrary()s it first, so the soname is already
// mapped in the process; process.dlopen then returns the already-loaded handle and registers the N-API module).
// UNIMSG_LIBSIGNAL_NODE may name an explicit .node/.so file (tests).
// If the add-on cannot be loaded the backend must still start (other providers!): return a module whose every native function throws
// the actionable error, except the two start-up hooks that Native.js calls while loading.
const path = require("node:path");
module.exports = function load() {
  const tries = [process.env.UNIMSG_LIBSIGNAL_NODE, "libsignal_client_node.so"].filter(Boolean);
  let last;
  for (const f of tries) { const m = { exports: {} }; try { process.dlopen(m, f); return m.exports; } catch (e) { last = e; } }
  const msg = "Signal is not available: the libsignal native add-on could not be loaded (" + tries.map((t) => path.basename(t)).join(", ") + "): " + (last && last.message)
    + ". Build it with apps/android/scripts/build-libsignal-android.sh and rebuild the app.";
  console.warn("[unimsg] " + msg);
  const fail = () => { throw new Error(msg); };
  return new Proxy({}, { get: (_, k) => (k === "registerErrors" || k === "initLogger" ? () => {} : fail) });
};

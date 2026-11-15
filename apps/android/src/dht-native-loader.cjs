// Replaces `binding.js` of the two native add-ons that HyperDHT needs (udx-native, sodium-native) inside the Android bundle.
// Their binding.js is `require("require-addon")(".", __filename)`, which looks for prebuilds/<platform>-<arch>/<name>.node NEXT TO the package: impossible in a one-file bundle,
// and on nodejs-mobile `process.platform` is "android" with a libnode.so that only exports N-API to libraries that list it in DT_NEEDED (see scripts/build-hyperdht-android.sh).
// Order: UNIMSG_DHT_NATIVE_DIR/<name>.node (tests, desktop) -> <bundle dir>/prebuilds/<platform>-<arch>/<name>.node (smoke test on a host) -> the jniLibs soname lib<name>.so
// (NodeRuntime.java System.loadLibrary()s these before node starts; process.dlopen then returns the already mapped library).
// A failure throws an actionable error; dht.ts turns it into "not available on this platform" and the rest of the app is unaffected (the module is only loaded when the user turns the DHT on).
const path = require("node:path");
module.exports = function load(name) {
  const so = "lib" + name.replace(/-/g, "_") + ".so", file = name + ".node";
  const tries = [];
  if (process.env.UNIMSG_DHT_NATIVE_DIR) tries.push(path.join(process.env.UNIMSG_DHT_NATIVE_DIR, file));
  try { tries.push(path.join(path.dirname(__filename), "prebuilds", process.platform + "-" + process.arch, file)); } catch { /* no __filename */ }
  tries.push(so);
  let last;
  for (const f of tries) { const m = { exports: {} }; try { process.dlopen(m, f); return m.exports; } catch (e) { last = e; } }
  throw new Error("the native add-on " + name + " could not be loaded (" + tries.map((t) => path.basename(t)).join(", ") + "): " + (last && last.message) + ". Build it with apps/android/scripts/build-hyperdht-android.sh and rebuild the app.");
};

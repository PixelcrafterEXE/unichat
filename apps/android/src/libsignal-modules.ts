// @ts-nocheck  (the libsignal types live in packages/provider-signal's node_modules; this file is resolved by the bundle script only)
// The Signal backup import (packages/core/src/signalimport/secure.ts) loads libsignal modules through a computed import(), which a bundle
// cannot follow. Register the real modules on globalThis instead. With the stub (no Android add-on) the stub module stands in and the import
// reports "not available" as before.
import * as mb from "@signalapp/libsignal-client/dist/MessageBackup.js";
import * as addr from "@signalapp/libsignal-client/dist/Address.js";
import * as zk from "@signalapp/libsignal-client/dist/zkgroup/index.js";
import * as ak from "@signalapp/libsignal-client/dist/AccountKeys.js";
globalThis.__unimsgLibsignalModules = { "MessageBackup.js": mb, "Address.js": addr, "zkgroup/index.js": zk, "AccountKeys.js": ak };

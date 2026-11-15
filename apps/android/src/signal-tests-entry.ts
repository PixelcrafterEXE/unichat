import "./libsignal-modules.ts";
import "./probe-env.ts";
// Bundled by `build-backend-bundle.mjs --signal-tests`: registers packages/provider-signal's offline node:test suites so they can run
// inside nodejs-mobile (emulator). Pure libsignal crypto + fakes; no network.
import "../../../packages/provider-signal/src/test/offline.test.ts";
import "../../../packages/provider-signal/src/test/sealed.test.ts";
import "../../../packages/provider-signal/src/test/groups.test.ts";
import "../../../packages/provider-signal/src/test/groupSend.test.ts";
import "../../../packages/provider-signal/src/test/groupModify.test.ts";
import "../../../packages/provider-signal/src/test/attachmentSend.test.ts";
import "../../../packages/provider-signal/src/test/mentions.test.ts";
import "../../../packages/provider-signal/src/test/peerProfiles.test.ts";
import "../../../packages/provider-signal/src/test/storageSync.test.ts";
import "../../../packages/provider-signal/src/test/linkPreview.test.ts";
// on-device Signal backup import (packages/core/src/signalimport): synthetic fixtures only
import "../../../packages/core/src/signalimport/signalimport.test.ts";
import "../../../packages/core/src/signalimport/signalimport.hub.test.ts";

// Injected by the native side at document start into the Capacitor WebView (origin https://localhost only).
// Defines window.UnimsgNative, which apps/ui/src/api.ts detects to select its "Android bridge" transport:
//     call(method: string, paramsJson: string): Promise<string /* JSON of the result */>
//     window.__unimsgEvent(json)   <- defined by api.ts; we call it for every backend event
// Transport underneath: __UnimsgHost, a WebMessageListener object (androidx.webkit) that exists only for the allowed
// origin. postMessage(line) goes to Java verbatim (one NDJSON request line); Java replies / pushes events through onmessage.
(function () {
  "use strict";
  var host = window.__UnimsgHost;
  if (!host || window.UnimsgNative) return;
  var seq = 0, pending = {};

  host.onmessage = function (ev) {
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.event !== undefined) {
      if (typeof window.__unimsgEvent === "function") window.__unimsgEvent(JSON.stringify({ event: m.event, data: m.data }));
      return;
    }
    if (m.ctl === "open-chat") { // notification tap: UI may listen for this DOM event to open the chat
      try { window.dispatchEvent(new CustomEvent("unimsg-open-chat", { detail: { chatId: m.chatId } })); } catch (e) { /* ignore */ }
      return;
    }
    if (m.ctl === "sync-link") { // unichat-sync://pair?... opened from the camera / a browser: the UI opens Sync devices and starts joining
      try { window.__unimsgSyncLink = m.url; window.dispatchEvent(new CustomEvent("unimsg-sync-link", { detail: { url: m.url } })); } catch (e) { /* ignore */ }
      return;
    }
    var p = pending[m.id];
    if (!p) return;
    delete pending[m.id];
    if (m.error !== undefined) p.rej(new Error(m.error));
    else p.res(JSON.stringify(m.result === undefined ? null : m.result));
  };

  window.UnimsgNative = {
    platform: "android",
    call: function (method, paramsJson) {
      return new Promise(function (res, rej) {
        var id = ++seq;
        pending[id] = { res: res, rej: rej };
        host.postMessage('{"id":' + id + ',"method":' + JSON.stringify(String(method)) + ',"params":' + (paramsJson || "{}") + "}");
      });
    },
  };
  host.postMessage('{"hello":1}'); // lets Java learn the reply proxy for this page so it can push events
})();

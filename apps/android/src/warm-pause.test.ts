import test from "node:test";
import assert from "node:assert/strict";
import { WarmPause } from "./warm-pause.js";

test("pauses on any restrictive signal, resumes only when all are gone", () => {
  const w = new WarmPause();
  assert.equal(w.update({ metered: false }), undefined, "nothing to tell the Hub: it starts unpaused");
  assert.equal(w.update({ metered: true }), true);
  assert.equal(w.update({ metered: true }), undefined, "repeated after a bridge reconnect: no second call");
  assert.equal(w.update({ saver: true }), undefined, "already paused");
  assert.equal(w.update({ metered: false }), undefined, "still on battery saver");
  assert.equal(w.update({ saver: false, low: true }), undefined, "still low on battery");
  assert.equal(w.update({ low: false }), false, "back on Wi-Fi with a charged battery");
  assert.equal(w.update({ low: false }), undefined);
});

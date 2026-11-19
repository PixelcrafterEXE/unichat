import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFileLog } from "./log.js";

const fakeConsole = () => { const seen: string[] = []; const c = { log: (...a: any[]) => seen.push("log " + a.join(" ")), info: (...a: any[]) => seen.push("info " + a.join(" ")), warn: (...a: any[]) => seen.push("warn " + a.join(" ")), error: (...a: any[]) => seen.push("error " + a.join(" ")) }; return { c: c as unknown as Console, seen }; };

test("file log: writes what the console writes, keeps printing it, and survives bad arguments", () => {
  const dir = mkdtempSync(join(tmpdir(), "unimsg-log-"));
  try {
    const { c, seen } = fakeConsole();
    const file = startFileLog(dir, c);
    assert.equal(file, join(dir, "logs", "desktop.log"));
    c.log("[unimsg] hello");
    c.warn("[sync] pairing failed:", { reason: "code" });
    const circular: any = {}; circular.self = circular;
    c.error(new Error("boom"), circular);
    const text = readFileSync(file, "utf8");
    assert.match(text, /LOG \[unimsg\] hello/);
    assert.match(text, /WARN \[sync\] pairing failed: \{"reason":"code"\}/);
    assert.match(text, /ERROR Error: boom/, "an Error keeps its stack");
    assert.equal(text.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l)).length, 3, "three entries (an Error's stack spans lines of its own)");
    assert.match(text, /^\d{4}-\d{2}-\d{2}T/, "every line is timestamped");
    assert.equal(seen.length, 3, "the console still prints everything itself");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("file log: rotates once at the size limit and never throws when the directory is unusable", () => {
  const dir = mkdtempSync(join(tmpdir(), "unimsg-log-"));
  try {
    const { c } = fakeConsole();
    const file = startFileLog(dir, c);
    writeFileSync(file, "x".repeat(3 << 20)); // over the 2 MB limit
    c.log("after the limit");
    assert.ok(statSync(file + ".1").size > (2 << 20), "the old file is kept as .1");
    assert.match(readFileSync(file, "utf8"), /after the limit/);
    assert.ok(statSync(file).size < 200, "the new file starts empty");
  } finally { rmSync(dir, { recursive: true, force: true }); }

  const blocked = mkdtempSync(join(tmpdir(), "unimsg-log-"));
  try {
    writeFileSync(join(blocked, "logs"), "not a directory"); // mkdir will fail
    const { c, seen } = fakeConsole();
    startFileLog(blocked, c);
    c.log("still works");
    assert.equal(seen.length, 1, "logging keeps working when the file cannot be written");
  } finally { rmSync(blocked, { recursive: true, force: true }); }
});

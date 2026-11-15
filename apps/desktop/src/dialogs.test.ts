import assert from "node:assert/strict";
import { test } from "node:test";
import { createDialogs } from "./dialogs.js";

function make(save?: string, open?: string) {
  const calls: any[] = [], shown: string[] = [];
  const d = createDialogs({
    dialog: {
      showSaveDialog: async (o) => { calls.push(o); return save ? { canceled: false, filePath: save } : { canceled: true }; },
      showOpenDialog: async (o) => { calls.push(o); return open ? { canceled: false, filePaths: [open] } : { canceled: true, filePaths: [] }; },
    },
    shell: { showItemInFolder: (p) => shown.push(p) }, home: () => "/home/x",
  });
  return { d, calls, shown };
}

test("save dialog: renderer cannot pick options, name is sanitised, path is granted once chosen", async () => {
  const { d, calls, shown } = make("/tmp/out.unimsg-backup");
  assert.throws(() => d.guardCall("exportData", { targetPath: "/tmp/out.unimsg-backup" }), /file dialog/);
  const r = await d.showSaveDialog({ suggestedName: "../../etc/passwd" } as any);
  assert.deepEqual(r, { canceled: false, path: "/tmp/out.unimsg-backup" });
  assert.equal(calls[0].defaultPath, "/home/x/passwd.unimsg-backup");
  d.guardCall("exportData", { targetPath: "/tmp/out.unimsg-backup" });
  assert.throws(() => d.guardCall("exportData", { targetPath: "/etc/shadow" }), /file dialog/);
  assert.deepEqual(d.revealInFolder("/etc/shadow"), { ok: false });
  assert.deepEqual(d.revealInFolder("/tmp/out.unimsg-backup"), { ok: true });
  assert.deepEqual(shown, ["/tmp/out.unimsg-backup"]);
});
test("open dialog grants import paths only; cancel grants nothing", async () => {
  const { d } = make(undefined, undefined);
  assert.deepEqual(await d.showOpenDialog(), { canceled: true });
  assert.throws(() => d.guardCall("importData", { path: "/etc/passwd" }), /file dialog/);
  const m = make(undefined, "/home/x/a.unimsg-backup");
  await m.d.showOpenDialog();
  m.d.guardCall("importInspect", { path: "/home/x/a.unimsg-backup", passphrase: "x" });
  m.d.guardCall("importData", { path: "/home/x/a.unimsg-backup" });
  assert.throws(() => m.d.guardCall("importData", { path: "/home/x/b" }), /file dialog/);
  m.d.guardCall("importData", { uploadId: "abc" }); // managed upload tickets are fine
  m.d.guardCall("exportData", {}); // default managed folder
  m.d.guardCall("getChats", {});
  assert.throws(() => m.d.guardCall("exportData", { deliver: "download" }), /Downloads/);
});
test("grants expire", async () => {
  let t = 0; const d = createDialogs({ dialog: { showSaveDialog: async () => ({ canceled: false, filePath: "/a" }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { showItemInFolder() {} }, home: () => "/", now: () => t });
  await d.showSaveDialog(); d.guardCall("exportData", { targetPath: "/a" });
  t = 2 * 3600_000; assert.throws(() => d.guardCall("exportData", { targetPath: "/a" }));
});

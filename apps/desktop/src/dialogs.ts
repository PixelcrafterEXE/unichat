// Native file dialogs for backup / migration, and the guard that keeps the renderer from naming arbitrary files.
//
// The backend runs with BackupPolicy {paths:"any"}: it will read/write whatever path it is given. That is only safe because the
// path always comes from a native dialog. This module enforces it: the renderer asks for a dialog (it cannot choose the options),
// main remembers the path the USER picked, and `guardCall` lets exportData / importInspect / importData through only with a
// path that was granted. The renderer never receives file contents; it only learns the chosen path.
import { basename, join } from "node:path";

export interface DialogApi {
  showSaveDialog(opts: { title: string; defaultPath: string; filters: { name: string; extensions: string[] }[]; properties?: string[] }): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(opts: { title: string; filters: { name: string; extensions: string[] }[]; properties: string[] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}
export interface ShellApi { showItemInFolder(p: string): void }

const EXT = ".unimsg-backup";
const TTL = 60 * 60_000;
const FILTERS = [{ name: "UniChat backup", extensions: ["unimsg-backup"] }, { name: "All files", extensions: ["*"] }];

export function createDialogs(deps: { dialog: DialogApi; shell: ShellApi; home: () => string; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const saves = new Map<string, number>(), opens = new Map<string, number>(); // path -> expiry
  const live = (m: Map<string, number>, p: unknown) => typeof p === "string" && (m.get(p) ?? 0) > now();
  const safeName = (n: unknown) => { const s = basename(String(n ?? "")).replace(/[^\w. -]/g, "_").slice(0, 120); return s || `unimsg${EXT}`; };

  return {
    /** Ask where to save a backup. Resolves to {path} or {canceled:true}. */
    async showSaveDialog(req: { suggestedName?: string } = {}): Promise<{ canceled: boolean; path?: string }> {
      let name = safeName(req?.suggestedName); if (!name.endsWith(EXT)) name += EXT;
      const r = await deps.dialog.showSaveDialog({ title: "Save UniChat backup", defaultPath: join(deps.home(), name), filters: FILTERS, properties: ["createDirectory", "showOverwriteConfirmation"] });
      if (r.canceled || !r.filePath) return { canceled: true };
      saves.set(r.filePath, now() + TTL);
      return { canceled: false, path: r.filePath };
    },
    /** Ask for a backup file to import. */
    async showOpenDialog(): Promise<{ canceled: boolean; path?: string }> {
      const r = await deps.dialog.showOpenDialog({ title: "Choose a UniChat backup", filters: FILTERS, properties: ["openFile"] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      opens.set(r.filePaths[0], now() + TTL);
      return { canceled: false, path: r.filePaths[0] };
    },
    /** Show a file the user saved in the file manager. Only paths from the save dialog are accepted. */
    revealInFolder(path: unknown): { ok: boolean } {
      if (!live(saves, path)) return { ok: false };
      deps.shell.showItemInFolder(path as string); return { ok: true };
    },
    /** Throws if a backup RPC names a file the user did not pick. Everything else passes. */
    guardCall(method: string, params: any): void {
      if (method === "exportData") {
        if (params?.deliver === "download") throw new Error("Downloads are not used on the desktop app.");
        if (params?.targetPath !== undefined && !live(saves, params.targetPath)) throw new Error("Choose where to save the backup in the file dialog first.");
      } else if (method === "importInspect" || method === "importData") {
        if (params?.uploadId) return;
        if (params?.path !== undefined && !live(opens, params.path)) throw new Error("Choose the backup file in the file dialog first.");
      } else if (method === "backupUploadStart" || method === "backupUploadChunk" || method === "backupUploadEnd" || method === "backupDownloadChunk") {
        // chunked RPCs only touch the managed folder (tickets), never an arbitrary path: allowed
      }
    },
  };
}
export type Dialogs = ReturnType<typeof createDialogs>;

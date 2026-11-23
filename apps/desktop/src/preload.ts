import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("unimsg", {
  call: (method: string, params: object) => ipcRenderer.invoke("core:call", method, params),
  // Native file dialogs (main process validates; the renderer only learns the path the user picked).
  showSaveDialog: (req?: { suggestedName?: string }) => ipcRenderer.invoke("dialog:save", req ?? {}),
  showOpenDialog: () => ipcRenderer.invoke("dialog:open"),
  revealInFolder: (path: string) => ipcRenderer.invoke("dialog:reveal", path),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  // Desktop-only shell settings (close to tray, start at login); both calls answer with the full settings.
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch: { keepRunningInBackground?: boolean; startAtLogin?: boolean }) => ipcRenderer.invoke("settings:set", patch),
  onEvent: (cb: (e: { event: string; data: unknown }) => void) => {
    const h = (_: unknown, e: any) => cb(e);
    ipcRenderer.on("core:event", h);
    return () => ipcRenderer.off("core:event", h);
  },
});

import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("unimsg", {
  call: (method: string, params: object) => ipcRenderer.invoke("core:call", method, params),
  // Native file dialogs (main process validates; the renderer only learns the path the user picked).
  showSaveDialog: (req?: { suggestedName?: string }) => ipcRenderer.invoke("dialog:save", req ?? {}),
  showOpenDialog: () => ipcRenderer.invoke("dialog:open"),
  revealInFolder: (path: string) => ipcRenderer.invoke("dialog:reveal", path),
  onEvent: (cb: (e: { event: string; data: unknown }) => void) => {
    const h = (_: unknown, e: any) => cb(e);
    ipcRenderer.on("core:event", h);
    return () => ipcRenderer.off("core:event", h);
  },
});

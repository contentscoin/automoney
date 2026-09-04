import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("automoney", {
  getStatus: () => ipcRenderer.invoke("agent:status"),
  pair: (code: string) => ipcRenderer.invoke("agent:pair", code),
  openDashboard: () => ipcRenderer.invoke("app:openDashboard"),
  setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("agent:setConfig", patch),
  onStatus: (cb: (s: unknown) => void) => {
    ipcRenderer.on("agent:status", (_e, s) => cb(s));
  },
});

import { contextBridge, ipcRenderer } from "electron";
import type { DeskdoBridge } from "../ipc";

const on = (channel: string) => (cb: () => void) => {
  const listener = () => cb();
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

const bridge: DeskdoBridge = {
  store: {
    load: () => ipcRenderer.invoke("store:load"),
    saveItems: (items, cursor) => ipcRenderer.invoke("store:saveItems", items, cursor),
    saveOutbox: (ops) => ipcRenderer.invoke("store:saveOutbox", ops),
    clear: () => ipcRenderer.invoke("store:clear"),
  },
  auth: {
    login: (serverUrl, email, password) => ipcRenderer.invoke("auth:login", serverUrl, email, password),
    logout: () => ipcRenderer.invoke("auth:logout"),
    getToken: () => ipcRenderer.invoke("auth:getToken"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    setOpenAtLogin: (on) => ipcRenderer.invoke("settings:setOpenAtLogin", on),
  },
  win: {
    resizeTo: (w, h) => ipcRenderer.send("win:resizeTo", w, h),
    hide: () => ipcRenderer.send("win:hide"),
  },
  on: { openSettings: on("open-settings"), resume: on("resume") },
};

contextBridge.exposeInMainWorld("deskdo", bridge);

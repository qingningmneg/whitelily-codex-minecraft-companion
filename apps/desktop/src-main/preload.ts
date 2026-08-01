import { contextBridge, ipcRenderer } from "electron";
import { createPreloadTransport, createWhiteLilyApi } from "../src/desktopApi.js";

contextBridge.exposeInMainWorld(
  "whiteLily",
  createWhiteLilyApi(createPreloadTransport(ipcRenderer)),
);

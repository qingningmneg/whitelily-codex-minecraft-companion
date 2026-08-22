import { ipcRenderer } from "electron";

const AVATAR_PREVIEW_PORT_CHANNEL = "whitelily:avatar-preview:port";

ipcRenderer.on(AVATAR_PREVIEW_PORT_CHANNEL, (event) => {
  const port = event.ports[0];
  if (port === undefined) return;
  window.postMessage({ kind: "whitelily-avatar-preview-port" }, "*", [port]);
});

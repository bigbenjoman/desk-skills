// What a page in Desk's window can ask of the main process: the per-load token for the X-Desk-Load
// header (answered only to the desk-ui server's own pages), and a retry from the unreachable card.
// CommonJS, because a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  loadToken: () => ipcRenderer.invoke('desk:load-token'),
  retryNow: () => ipcRenderer.invoke('desk:retry'),
});

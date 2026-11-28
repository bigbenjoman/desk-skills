// Everything a page in Desk's window can ask of the main process, and nothing else: the Dock badge, a
// notification, a GitHub or Jira link in the browser, deep links into the app, and the unreachable
// card's Try now. The main process checks who is asking. No Electron object reaches the page.
// CommonJS, because a sandboxed preload cannot be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  badge: (count) => ipcRenderer.invoke('desk:badge', count),
  notify: (note) => ipcRenderer.invoke('desk:notify', { title: note?.title, body: note?.body }),
  openExternal: (url) => ipcRenderer.invoke('desk:open-external', url),
  onDeepLink: (fn) => {
    if (typeof fn === 'function') ipcRenderer.on('desk:deep-link', (_e, route) => fn(route));
  },
  startServer: () => ipcRenderer.invoke('desk:start-server'),
  // Settings · App's theme and density, kept in the app's own preferences file.
  prefs: () => ipcRenderer.invoke('desk:prefs-get'),
  setPref: (key, value) => ipcRenderer.invoke('desk:prefs-set', { [key]: value }),
});

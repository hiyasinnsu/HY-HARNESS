// The renderer is an untrusted web page: expose only the small native bridge.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('hyDesktop', {
  isDesktop: true,
  platform: process.platform,
  chooseWorkspace: (preferred) => ipcRenderer.invoke('workspace:choose', preferred),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  recentWorkspaces: () => ipcRenderer.invoke('workspace:recent'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  notify: (title, body) => ipcRenderer.invoke('app:notify', title, body),
  applyUpdate: () => ipcRenderer.invoke('update:apply'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  residentState: () => ipcRenderer.invoke('resident:get'),
  setResident: (next) => ipcRenderer.invoke('resident:set', next),
  phoneChanged: () => ipcRenderer.invoke('phone:changed'),
  pickPluginFile: () => ipcRenderer.invoke('plugins:pick'),
  versions: () => ipcRenderer.invoke('app:versions'),
  onMenu: (callback) => {
    const listener = (_event, action) => callback(action)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  },
})

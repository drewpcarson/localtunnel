const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("lanTunnel", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  updateSharedKey: (sharedKey) =>
    ipcRenderer.invoke("config:updateSharedKey", sharedKey),
  sendText: (payload) => ipcRenderer.invoke("transfer:sendText", payload),
  sendFile: (payload) => ipcRenderer.invoke("transfer:sendFile", payload),
  sendDirectory: (payload) => ipcRenderer.invoke("transfer:sendDirectory", payload),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listItems: () => ipcRenderer.invoke("items:list"),
  dismissItem: (itemId) => ipcRenderer.invoke("items:dismiss", itemId),
  saveFile: (itemId) => ipcRenderer.invoke("items:saveFile", itemId),
  startFileDrag: (itemId) => ipcRenderer.send("items:startDrag", itemId),
  getDragFilePath: (itemId) => ipcRenderer.invoke("items:getDragFilePath", itemId),
  openAppFolder: () => ipcRenderer.invoke("app:openAppFolder"),
  openExternalUrl: (url) => ipcRenderer.invoke("app:openExternalUrl", url),
  checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate"),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  listPeers: () => ipcRenderer.invoke("peers:list"),
  requestPairing: (payload) => ipcRenderer.invoke("pairing:request", payload),
  respondPairing: (payload) => ipcRenderer.invoke("pairing:respond", payload),
  onIncomingItem: (handler) => {
    const listener = (_event, item) => handler(item);
    ipcRenderer.on("incoming:item", listener);
    return () => ipcRenderer.removeListener("incoming:item", listener);
  },
  onPeersUpdated: (handler) => {
    const listener = (_event, peers) => handler(peers);
    ipcRenderer.on("peers:updated", listener);
    return () => ipcRenderer.removeListener("peers:updated", listener);
  },
  onPairingIncomingRequest: (handler) => {
    const listener = (_event, request) => handler(request);
    ipcRenderer.on("pairing:incomingRequest", listener);
    return () => ipcRenderer.removeListener("pairing:incomingRequest", listener);
  },
  onPairingStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("pairing:status", listener);
    return () => ipcRenderer.removeListener("pairing:status", listener);
  },
  onPaired: (handler) => {
    const listener = (_event, pairing) => handler(pairing);
    ipcRenderer.on("pairing:paired", listener);
    return () => ipcRenderer.removeListener("pairing:paired", listener);
  },
  onPairingCleared: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("pairing:cleared", listener);
    return () => ipcRenderer.removeListener("pairing:cleared", listener);
  },
  onRecoveryStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("app:recoveryStatus", listener);
    return () => ipcRenderer.removeListener("app:recoveryStatus", listener);
  },
  onUpdateStatus: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("app:updateStatus", listener);
    return () => ipcRenderer.removeListener("app:updateStatus", listener);
  },
  onTransferProgress: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("transfer:progress", listener);
    return () => ipcRenderer.removeListener("transfer:progress", listener);
  },
});

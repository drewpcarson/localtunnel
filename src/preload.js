const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lanTunnel", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  updateSharedKey: (sharedKey) =>
    ipcRenderer.invoke("config:updateSharedKey", sharedKey),
  sendText: (payload) => ipcRenderer.invoke("transfer:sendText", payload),
  sendFile: (payload) => ipcRenderer.invoke("transfer:sendFile", payload),
  listItems: () => ipcRenderer.invoke("items:list"),
  saveFile: (itemId) => ipcRenderer.invoke("items:saveFile", itemId),
  writeClipboard: (text) => ipcRenderer.invoke("clipboard:writeText", text),
  onIncomingItem: (handler) => {
    const listener = (_event, item) => handler(item);
    ipcRenderer.on("incoming:item", listener);
    return () => ipcRenderer.removeListener("incoming:item", listener);
  },
});

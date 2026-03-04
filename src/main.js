const path = require("node:path");
const fs = require("node:fs/promises");
const { app, BrowserWindow, ipcMain, dialog, clipboard } = require("electron");
const { encryptBuffer, keyFingerprint } = require("./crypto");
const { startServer } = require("./server");
const { startDiscovery } = require("./discovery");
const { getReceivedItem, listReceivedItems } = require("./store");

const PORT = 43827;
const state = {
  sharedKey: "",
};

let mainWindow;
let localUrls = [];
let discoveryHandle;
let discoveredPeers = [];

function normalizePeerUrl(input) {
  if (!input || typeof input !== "string") {
    throw new Error("Peer URL is required.");
  }

  const candidate = input.trim();
  const withProtocol = /^https?:\/\//i.test(candidate)
    ? candidate
    : `http://${candidate}`;
  return withProtocol.replace(/\/+$/, "");
}

async function sendEncryptedJson(url, endpoint, body, sharedKey) {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keyFingerprint(sharedKey)}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      message = data.error || message;
    } catch (_error) {
      // No-op: fallback to status code text.
    }
    throw new Error(message);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 420,
    minWidth: 420,
    minHeight: 420,
    maxWidth: 420,
    maxHeight: 420,
    resizable: false,
    title: "LAN Paste Tunnel",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  const { localUrls: serverUrls } = startServer({
    port: PORT,
    getSharedKey: () => state.sharedKey,
    onIncomingItem: (item) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("incoming:item", {
          id: item.id,
          type: item.type,
          createdAt: item.createdAt,
          fileName: item.fileName,
          mimeType: item.mimeType,
          size: item.size,
          textPreview: item.type === "text" ? item.text : "",
        });
      }
    },
  });

  localUrls = serverUrls;

  discoveryHandle = startDiscovery({
    endpointProvider: () =>
      localUrls.find((url) => !url.includes("localhost")) || localUrls[0],
    onPeersChange: (peers) => {
      discoveredPeers = peers;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("peers:updated", peers);
      }
    },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (discoveryHandle) {
    discoveryHandle.stop();
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("config:updateSharedKey", (_event, sharedKey) => {
  state.sharedKey = String(sharedKey || "").trim();
  return {
    ok: true,
  };
});

ipcMain.handle("app:info", () => {
  return {
    port: PORT,
    localUrls,
    peers: discoveredPeers,
  };
});

ipcMain.handle("transfer:sendText", async (_event, { peerUrl, text }) => {
  const sharedKey = state.sharedKey;
  if (!sharedKey || sharedKey.length < 8) {
    throw new Error("Set a shared key with at least 8 characters.");
  }

  const url = normalizePeerUrl(peerUrl);
  const payload = encryptBuffer(Buffer.from(text, "utf8"), sharedKey);
  await sendEncryptedJson(url, "/api/receive-text", { payload }, sharedKey);
  return { ok: true };
});

ipcMain.handle("transfer:sendFile", async (_event, { peerUrl, file }) => {
  const sharedKey = state.sharedKey;
  if (!sharedKey || sharedKey.length < 8) {
    throw new Error("Set a shared key with at least 8 characters.");
  }

  if (!file?.name || !file?.bytes) {
    throw new Error("Invalid file.");
  }

  const url = normalizePeerUrl(peerUrl);
  const bytes = Buffer.from(file.bytes);
  const payload = encryptBuffer(bytes, sharedKey);
  await sendEncryptedJson(
    url,
    "/api/receive-file",
    {
      payload,
      fileName: file.name,
      mimeType: file.mimeType || "application/octet-stream",
    },
    sharedKey
  );
  return { ok: true };
});

ipcMain.handle("items:list", () => {
  return listReceivedItems();
});

ipcMain.handle("items:saveFile", async (_event, itemId) => {
  const item = getReceivedItem(itemId);
  if (!item || item.type !== "file") {
    throw new Error("File not found.");
  }

  const result = await dialog.showSaveDialog({
    defaultPath: item.fileName,
  });
  if (result.canceled || !result.filePath) {
    return { saved: false };
  }

  await fs.writeFile(result.filePath, item.bytes);
  return { saved: true, path: result.filePath };
});

ipcMain.handle("clipboard:writeText", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return { ok: true };
});

ipcMain.handle("peers:list", () => {
  if (discoveryHandle) {
    discoveredPeers = discoveryHandle.getPeers();
  }
  return discoveredPeers;
});

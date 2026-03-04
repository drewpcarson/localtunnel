const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  clipboard,
  nativeImage,
  safeStorage,
} = require("electron");
const { encryptBuffer, keyFingerprint } = require("./crypto");
const { startServer } = require("./server");
const { startDiscovery } = require("./discovery");
const { getReceivedItem, listReceivedItems } = require("./store");

const PORT = 43827;
const PAIR_TIMEOUT_MS = 30000;
const state = {
  sharedKey: "",
  activePeerUrl: "",
  activePeerName: "",
  deviceName: os.hostname(),
};

let mainWindow;
let localUrls = [];
let discoveryHandle;
let discoveredPeers = [];
const outgoingPairRequests = new Map();
const incomingPairRequests = new Map();
const dragExportDir = path.join(os.tmpdir(), "lan-paste-tunnel");
let pairingStatePath = "";

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
    if (message === "Set a shared key first.") {
      throw new Error("Peer is not paired. Re-pair both portals.");
    }
    throw new Error(message);
  }
}

async function sendJson(url, endpoint, body) {
  const response = await fetch(`${url}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function persistPairingState() {
  if (!pairingStatePath) {
    return;
  }

  if (!state.activePeerUrl || !state.sharedKey) {
    if (fsSync.existsSync(pairingStatePath)) {
      fsSync.unlinkSync(pairingStatePath);
    }
    return;
  }

  const payload = JSON.stringify({
    activePeerUrl: state.activePeerUrl,
    activePeerName: state.activePeerName,
    sharedKey: state.sharedKey,
    updatedAt: Date.now(),
  });

  let fileData;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(payload);
    fileData = JSON.stringify({
      encrypted: true,
      data: encrypted.toString("base64"),
    });
  } else {
    fileData = JSON.stringify({
      encrypted: false,
      data: Buffer.from(payload, "utf8").toString("base64"),
    });
  }

  fsSync.writeFileSync(pairingStatePath, fileData, "utf8");
}

function restorePairingState() {
  if (!pairingStatePath || !fsSync.existsSync(pairingStatePath)) {
    return;
  }

  try {
    const raw = fsSync.readFileSync(pairingStatePath, "utf8");
    const parsed = JSON.parse(raw);
    const blob = Buffer.from(String(parsed.data || ""), "base64");
    if (!blob.length) {
      return;
    }

    let payload = "";
    if (parsed.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) {
        return;
      }
      payload = safeStorage.decryptString(blob);
    } else {
      payload = blob.toString("utf8");
    }

    const restored = JSON.parse(payload);
    if (!restored.activePeerUrl || !restored.sharedKey) {
      return;
    }

    state.activePeerUrl = normalizePeerUrl(restored.activePeerUrl);
    state.activePeerName = String(restored.activePeerName || "Peer");
    state.sharedKey = String(restored.sharedKey || "");
  } catch (_error) {
    // Ignore invalid persisted state and continue unpaired.
  }
}

function setActivePairingSession({ peerUrl, peerName, sharedKey }) {
  state.activePeerUrl = normalizePeerUrl(peerUrl);
  state.activePeerName = String(peerName || "Peer");
  state.sharedKey = String(sharedKey || "");
  persistPairingState();
  notifyRenderer("pairing:paired", {
    peerUrl: state.activePeerUrl,
    peerName: state.activePeerName,
  });
}

function clearPairingSession(reason) {
  state.sharedKey = "";
  state.activePeerUrl = "";
  state.activePeerName = "";
  persistPairingState();
  notifyRenderer("pairing:cleared", {
    reason: reason || "Pairing cleared.",
  });
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
  pairingStatePath = path.join(app.getPath("userData"), "pairing-state.json");
  restorePairingState();

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
    onPairRequest: ({ requestId, fromName, fromEndpoint, proposedKey }) => {
      incomingPairRequests.set(requestId, {
        requestId,
        fromName,
        fromEndpoint,
        proposedKey,
        createdAt: Date.now(),
      });
      notifyRenderer("pairing:incomingRequest", {
        requestId,
        fromName,
        fromEndpoint,
      });
    },
    onPairConfirm: ({ requestId, accepted }) => {
      const pending = outgoingPairRequests.get(requestId);
      if (!pending) {
        return;
      }
      outgoingPairRequests.delete(requestId);
      if (!accepted) {
        notifyRenderer("pairing:status", {
          type: "rejected",
          message: `${pending.peerName} declined pairing.`,
        });
        return;
      }
      setActivePairingSession({
        peerUrl: pending.peerEndpoint,
        peerName: pending.peerName,
        sharedKey: pending.sharedKey,
      });
      notifyRenderer("pairing:status", {
        type: "paired",
        message: `Paired with ${pending.peerName}.`,
      });
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
    activePeerUrl: state.activePeerUrl,
    activePeerName: state.activePeerName,
  };
});

ipcMain.handle("transfer:sendText", async (_event, { peerUrl, text }) => {
  const sharedKey = state.sharedKey;
  if (!sharedKey || sharedKey.length < 8) {
    throw new Error("Pair with a nearby device first.");
  }

  const url = normalizePeerUrl(peerUrl || state.activePeerUrl);
  const payload = encryptBuffer(Buffer.from(text, "utf8"), sharedKey);
  try {
    await sendEncryptedJson(url, "/api/receive-text", { payload }, sharedKey);
  } catch (error) {
    if (error.message === "Peer is not paired. Re-pair both portals.") {
      clearPairingSession(error.message);
    }
    throw error;
  }
  return { ok: true };
});

ipcMain.handle("transfer:sendFile", async (_event, { peerUrl, file }) => {
  const sharedKey = state.sharedKey;
  if (!sharedKey || sharedKey.length < 8) {
    throw new Error("Pair with a nearby device first.");
  }

  if (!file?.name || !file?.bytes) {
    throw new Error("Invalid file.");
  }

  const url = normalizePeerUrl(peerUrl || state.activePeerUrl);
  const bytes = Buffer.from(file.bytes);
  const payload = encryptBuffer(bytes, sharedKey);
  try {
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
  } catch (error) {
    if (error.message === "Peer is not paired. Re-pair both portals.") {
      clearPairingSession(error.message);
    }
    throw error;
  }
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

ipcMain.on("items:startDrag", (event, itemId) => {
  try {
    const item = getReceivedItem(itemId);
    if (!item || item.type !== "file") {
      return;
    }

    if (!fsSync.existsSync(dragExportDir)) {
      fsSync.mkdirSync(dragExportDir, { recursive: true });
    }

    const safeName = path.basename(item.fileName || `file-${item.id}`);
    const targetPath = path.join(dragExportDir, `${item.id}-${safeName}`);
    fsSync.writeFileSync(targetPath, item.bytes);

    let icon = nativeImage.createEmpty();
    if (item.mimeType?.startsWith("image/")) {
      try {
        icon = nativeImage.createFromBuffer(item.bytes);
      } catch (_error) {
        icon = nativeImage.createEmpty();
      }
    }

    event.sender.startDrag({
      file: targetPath,
      icon,
    });
  } catch (_error) {
    // Ignore drag export failures silently to keep UI responsive.
  }
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

ipcMain.handle("pairing:request", async (_event, { peerEndpoint, peerName }) => {
  const normalizedPeerEndpoint = normalizePeerUrl(peerEndpoint);
  const localEndpoint =
    localUrls.find((url) => !url.includes("localhost")) || localUrls[0];
  if (!localEndpoint) {
    throw new Error("Local endpoint unavailable.");
  }

  const requestId = crypto.randomUUID();
  const sharedKey = crypto.randomBytes(32).toString("base64url");
  outgoingPairRequests.set(requestId, {
    requestId,
    peerEndpoint: normalizedPeerEndpoint,
    peerName: String(peerName || "Peer"),
    sharedKey,
    createdAt: Date.now(),
  });

  setTimeout(() => {
    if (outgoingPairRequests.has(requestId)) {
      outgoingPairRequests.delete(requestId);
      notifyRenderer("pairing:status", {
        type: "timeout",
        message: "Pairing request timed out.",
      });
    }
  }, PAIR_TIMEOUT_MS);

  await sendJson(normalizedPeerEndpoint, "/api/pair-request", {
    requestId,
    fromName: state.deviceName,
    fromEndpoint: localEndpoint,
    proposedKey: sharedKey,
  });
  notifyRenderer("pairing:status", {
    type: "pending",
    message: `Pairing request sent to ${peerName || "peer"}...`,
  });
  return { ok: true };
});

ipcMain.handle("pairing:respond", async (_event, { requestId, accept }) => {
  const pending = incomingPairRequests.get(requestId);
  if (!pending) {
    throw new Error("Pairing request no longer available.");
  }
  incomingPairRequests.delete(requestId);

  if (accept) {
    setActivePairingSession({
      peerUrl: pending.fromEndpoint,
      peerName: pending.fromName,
      sharedKey: pending.proposedKey,
    });
  }

  await sendJson(normalizePeerUrl(pending.fromEndpoint), "/api/pair-confirm", {
    requestId,
    accepted: Boolean(accept),
  });

  notifyRenderer("pairing:status", {
    type: accept ? "paired" : "rejected",
    message: accept
      ? `Paired with ${pending.fromName}.`
      : `Declined pairing from ${pending.fromName}.`,
  });

  return { ok: true };
});

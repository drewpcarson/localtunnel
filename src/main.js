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
const DRAG_DEBUG_TAG = "[LT-DRAGDBG]";
const RECOVERY_FILE = "recovery-state.json";
const RECOVERY_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECOVERY_RESTARTS = 3;
let recoveryStatePath = "";

function logDragDebug(message, context = {}) {
  const stamp = new Date().toISOString();
  console.log(`${DRAG_DEBUG_TAG} ${stamp} ${message}`, context);
}

function readRecoveryState() {
  try {
    if (!recoveryStatePath || !fsSync.existsSync(recoveryStatePath)) {
      return { starts: [] };
    }
    const raw = fsSync.readFileSync(recoveryStatePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.starts)) {
      return { starts: [] };
    }
    return { starts: parsed.starts.filter((n) => Number.isFinite(n)) };
  } catch (_error) {
    return { starts: [] };
  }
}

function writeRecoveryState(stateData) {
  if (!recoveryStatePath) {
    return;
  }
  fsSync.writeFileSync(recoveryStatePath, JSON.stringify(stateData), "utf8");
}

function shouldAttemptRecovery(reason) {
  const now = Date.now();
  const stateData = readRecoveryState();
  const recent = stateData.starts.filter((ts) => now - ts <= RECOVERY_WINDOW_MS);
  const allowed = recent.length < MAX_RECOVERY_RESTARTS;
  logDragDebug("recovery.check", {
    reason,
    recentRestartCount: recent.length,
    maxRestarts: MAX_RECOVERY_RESTARTS,
    windowMs: RECOVERY_WINDOW_MS,
    allowed,
  });
  if (!allowed) {
    return false;
  }
  recent.push(now);
  writeRecoveryState({ starts: recent });
  return true;
}

function resetRecoveryWindowIfStable() {
  const stateData = readRecoveryState();
  const now = Date.now();
  const recent = stateData.starts.filter((ts) => now - ts <= RECOVERY_WINDOW_MS);
  if (recent.length === 0) {
    return;
  }
  writeRecoveryState({ starts: recent });
}

function tryRelaunch(reason, details = {}) {
  if (!shouldAttemptRecovery(reason)) {
    logDragDebug("recovery.blocked", {
      reason,
      ...details,
    });
    notifyRenderer("app:recoveryStatus", {
      severity: "error",
      message: "Automatic recovery disabled after repeated crashes.",
      reason,
      details,
    });
    return;
  }

  logDragDebug("recovery.relaunching", {
    reason,
    ...details,
  });
  try {
    app.relaunch();
    app.exit(0);
  } catch (error) {
    logDragDebug("recovery.relaunch-error", {
      reason,
      error: error?.message || String(error),
    });
  }
}

function sanitizeFileName(name, fallback) {
  const base = String(name || "").trim() || fallback;
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 160);
  return cleaned || fallback;
}

function buildDragIconFromItem(item) {
  if (item.mimeType?.startsWith("image/")) {
    try {
      const imageIcon = nativeImage.createFromBuffer(item.bytes);
      if (!imageIcon.isEmpty()) {
        const resized = imageIcon.resize({ width: 64, height: 64 });
        logDragDebug("icon.from-image.success", {
          itemId: item.id,
          sourceBytes: item.bytes.length,
          resizedSize: resized.getSize(),
        });
        return resized;
      }
      logDragDebug("icon.from-image.empty", {
        itemId: item.id,
        sourceBytes: item.bytes.length,
      });
    } catch (_error) {
      logDragDebug("icon.from-image.error", {
        itemId: item.id,
        error: _error?.message || String(_error),
      });
    }
  }

  // Windows Explorer drag can crash with an empty icon; always provide a valid one.
  const fallback = nativeImage.createFromDataURL(
    "data:image/png;base64,"
      + "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAQAAAAAYLlVAAAAm0lEQVR4Ae3PAQ0AAAgDINc/9K3h"
      + "HBQAAAB8YgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBA"
      + "gAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAAB"
      + "AgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAvwF8QAB2SGINwAAAABJRU5ErkJggg=="
  );
  logDragDebug("icon.fallback.generated", {
    itemId: item.id,
    size: fallback.getSize(),
    isEmpty: fallback.isEmpty(),
  });
  return fallback;
}

function exportDragFile(item) {
  if (!item || item.type !== "file") {
    throw new Error("Invalid file drag item.");
  }

  if (!fsSync.existsSync(dragExportDir)) {
    fsSync.mkdirSync(dragExportDir, { recursive: true });
    logDragDebug("drag.export-dir.created", { dragExportDir });
  }

  const safeName = sanitizeFileName(
    path.basename(item.fileName || ""),
    `file-${item.id}`
  );
  const targetPath = path.join(dragExportDir, `${item.id}-${safeName}`);
  fsSync.writeFileSync(targetPath, item.bytes);
  logDragDebug("drag.temp-file.written", {
    itemId: item.id,
    targetPath,
    writtenBytes: item.bytes.length,
    exists: fsSync.existsSync(targetPath),
  });

  return targetPath;
}

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
  recoveryStatePath = path.join(app.getPath("userData"), RECOVERY_FILE);
  resetRecoveryWindowIfStable();
  logDragDebug("app.ready", { platform: process.platform });
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
  logDragDebug("window.created", {
    width: 420,
    height: 420,
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    logDragDebug("render-process-gone", {
      reason: details?.reason,
      exitCode: details?.exitCode,
      webContentsId: webContents?.id,
    });
    if (details?.reason === "crashed" || details?.reason === "oom") {
      tryRelaunch("render-process-gone", {
        reason: details?.reason,
        exitCode: details?.exitCode,
      });
    }
  });

  app.on("child-process-gone", (_event, details) => {
    logDragDebug("child-process-gone", {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName,
    });
    if (details?.reason === "crashed" || details?.reason === "oom") {
      tryRelaunch("child-process-gone", {
        reason: details?.reason,
        type: details?.type,
        exitCode: details?.exitCode,
      });
    }
  });
});

process.on("uncaughtException", (error) => {
  logDragDebug("process.uncaughtException", {
    error: error?.message || String(error),
    stack: error?.stack,
  });
  tryRelaunch("uncaughtException", {
    error: error?.message || String(error),
  });
});

process.on("unhandledRejection", (reason) => {
  logDragDebug("process.unhandledRejection", {
    reason: reason?.message || String(reason),
    stack: reason?.stack,
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
    logDragDebug("drag.ipc.received", { itemId });
    const item = getReceivedItem(itemId);
    if (!item || item.type !== "file") {
      logDragDebug("drag.item.invalid", { itemId, itemType: item?.type });
      return;
    }
    logDragDebug("drag.item.loaded", {
      itemId: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      size: item.bytes?.length,
    });

    if (process.platform === "win32") {
      // Windows uses DownloadURL path from renderer to avoid native startDrag crash.
      const targetPath = exportDragFile(item);
      logDragDebug("drag.startDrag.skipped-windows", {
        itemId: item.id,
        targetPath,
      });
      return;
    }
    const targetPath = exportDragFile(item);

    const icon = buildDragIconFromItem(item);
    logDragDebug("drag.startDrag.before", {
      itemId: item.id,
      targetPath,
      iconEmpty: icon.isEmpty(),
      iconSize: icon.getSize(),
      platform: process.platform,
    });

    event.sender.startDrag({
      file: targetPath,
      icon,
    });
    logDragDebug("drag.startDrag.after", {
      itemId: item.id,
      targetPath,
    });
  } catch (_error) {
    logDragDebug("drag.error", {
      itemId,
      error: _error?.message || String(_error),
      stack: _error?.stack,
    });
  }
});

ipcMain.handle("items:getDragFilePath", async (_event, itemId) => {
  try {
    const item = getReceivedItem(itemId);
    if (!item || item.type !== "file") {
      throw new Error("File not found.");
    }
    const targetPath = exportDragFile(item);
    logDragDebug("drag.get-path.success", {
      itemId: item.id,
      targetPath,
    });
    return {
      ok: true,
      path: targetPath,
      fileName: item.fileName,
      mimeType: item.mimeType || "application/octet-stream",
    };
  } catch (error) {
    logDragDebug("drag.get-path.error", {
      itemId,
      error: error?.message || String(error),
    });
    throw error;
  }
});

ipcMain.on("debug:log", (_event, payload) => {
  logDragDebug("renderer", payload || {});
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

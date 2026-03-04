const toggleSetupBtn = document.getElementById("toggleSetupBtn");
const openAppFolderBtn = document.getElementById("openAppFolderBtn");
const setupPanel = document.getElementById("setupContent");
const peerList = document.getElementById("peerList");
const dropZone = document.getElementById("dropZone");
const orbitLayer = document.getElementById("orbitLayer");
const statusEl = document.getElementById("status");
const pairRequestModal = document.getElementById("pairRequestModal");
const pairRequestText = document.getElementById("pairRequestText");
const pairAcceptBtn = document.getElementById("pairAcceptBtn");
const pairDeclineBtn = document.getElementById("pairDeclineBtn");
const checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
const appVersionLabel = document.getElementById("appVersionLabel");
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");

let peers = [];
let receivedItems = [];
let currentPairRequest = null;
let activePeerUrl = "";
const dragPathCache = new Map();
const isWindows = navigator.platform.toLowerCase().includes("win");
let lastTextDragAt = 0;
const ARTIFACT_LIFETIME_MS = 30000;
let artifactTicker = null;
let updateReadyToInstall = false;
let updatesEnabled = false;
let activeLocalDragItemId = null;
let localDragDroppedInPortal = false;
const TUNNELED_NAME_MAX_CHARS = 24;

function debugLog() {}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9fba" : "#9cbad6";
}

function truncateStatusName(name, maxChars = TUNNELED_NAME_MAX_CHARS) {
  const value = String(name || "").trim();
  if (!value) {
    return "untitled";
  }
  if (value.length <= maxChars) {
    return value;
  }

  const extensionMatch = value.match(/(\.[^./\\\s]{1,10})$/);
  const extension = extensionMatch ? extensionMatch[1] : "";
  const base = extension ? value.slice(0, -extension.length) : value;
  const reserved = extension ? extension.length + 3 : 3;
  const baseLimit = Math.max(6, maxChars - reserved);
  return `${base.slice(0, baseLimit)}...${extension}`;
}

function hashValue(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647;
  }
  return Math.abs(hash);
}

function isItemAlive(item) {
  return Date.now() - item.createdAt < ARTIFACT_LIFETIME_MS;
}

async function dismissItemFromUi(itemId) {
  receivedItems = receivedItems.filter((item) => item.id !== itemId);
  dragPathCache.delete(itemId);
  renderOrbitArtifacts();
  debugLog("artifact.dismiss.ui", { itemId });
  try {
    await window.lanTunnel.dismissItem(itemId);
    debugLog("artifact.dismiss.sync.success", { itemId });
  } catch (_error) {
    debugLog("artifact.dismiss.sync.error", {
      itemId,
      error: _error?.message || String(_error),
    });
  }
}

function artifactVarsFor(item, index) {
  const hash = hashValue(`${item.id}:${index}`);
  const x = 18 + (hash % 64);
  const y = 18 + ((hash >> 6) % 64);
  const dx = (hash % 18) - 9;
  const dy = ((hash >> 4) % 18) - 9;
  const dur = 16 + (hash % 18);
  const delay = -((hash % 6000) / 1000);
  return {
    x,
    y,
    dx,
    dy,
    dur,
    delay,
  };
}

async function refreshReceivedArtifacts() {
  debugLog("artifacts.refresh.start");
  receivedItems = (await window.lanTunnel.listItems()).filter(isItemAlive);
  debugLog("artifacts.refresh.loaded", { count: receivedItems.length });
  for (const item of receivedItems) {
    if (item.type === "file" || item.type === "text") {
      void ensureDragPath(item.id);
    }
  }
  renderOrbitArtifacts();
}

async function ensureDragPath(itemId) {
  if (dragPathCache.has(itemId)) {
    debugLog("drag.path.cache.hit", { itemId }, 400);
    return dragPathCache.get(itemId);
  }
  try {
    debugLog("drag.path.fetch.start", { itemId });
    const result = await window.lanTunnel.getDragFilePath(itemId);
    dragPathCache.set(itemId, result);
    debugLog("drag.path.fetch.success", {
      itemId,
      path: result?.path,
      mimeType: result?.mimeType,
    });
    return result;
  } catch (error) {
    debugLog("drag.path.fetch.error", {
      itemId,
      error: error?.message || String(error),
    });
    return null;
  }
}

function filePathToFileUrl(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  return encodeURI(`file:///${normalized.replace(/^\/+/, "")}`);
}

function attachDownloadData(event, item) {
  const cached = dragPathCache.get(item.id);
  if (!cached?.path) {
    debugLog("artifact.drag.download.no-cached-path", {
      itemId: item.id,
      fileName: item.fileName,
    });
    event.preventDefault();
    void ensureDragPath(item.id);
    setStatus("Preparing artifact for drag. Try again.", true);
    return false;
  }

  const fileUrl = filePathToFileUrl(cached.path);
  const mimeType = cached.mimeType || item.mimeType || "application/octet-stream";
  const fileName = cached.fileName || item.fileName || "artifact.bin";
  event.dataTransfer.setData("DownloadURL", `${mimeType}:${fileName}:${fileUrl}`);
  event.dataTransfer.setData("text/uri-list", fileUrl);
  event.dataTransfer.setData("text/plain", cached.path);
  debugLog("artifact.drag.download.payload-set", {
    itemId: item.id,
    fileUrl,
    fileName,
    mimeType,
  });
  return true;
}

function markWindowDropAllowed(event, stopPropagation = false) {
  event.preventDefault();
  if (stopPropagation) {
    event.stopPropagation();
  }
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  dropZone.classList.add("drag-over");
}

function appendPinwheelMask(target, elapsedMs) {
  const mask = document.createElement("div");
  mask.className = "artifact-progress-mask";
  mask.style.animationDelay = `-${elapsedMs}ms`;
  target.appendChild(mask);
}

function renderOrbitArtifacts() {
  receivedItems = receivedItems.filter(isItemAlive);
  const visible = receivedItems.slice(0, 14);
  debugLog("artifacts.render", {
    total: receivedItems.length,
    visible: visible.length,
  }, 3000);

  const existingIds = new Set(visible.map(item => item.id));
  for (const child of Array.from(orbitLayer.children)) {
    if (!existingIds.has(child.dataset.itemId)) {
      child.remove();
    }
  }

  for (const [index, item] of visible.entries()) {
    let orbitItem = orbitLayer.querySelector(`[data-item-id="${item.id}"]`);
    if (orbitItem) {
      continue;
    }

    orbitItem = document.createElement("div");
    orbitItem.className = "orbit-item";
    orbitItem.dataset.itemId = item.id;
    const vars = artifactVarsFor(item, index);
    orbitItem.style.setProperty("--x", `${vars.x}%`);
    orbitItem.style.setProperty("--y", `${vars.y}%`);
    orbitItem.style.setProperty("--dx", `${vars.dx}px`);
    orbitItem.style.setProperty("--dy", `${vars.dy}px`);
    orbitItem.style.setProperty("--dur", `${vars.dur}s`);
    orbitItem.style.setProperty("--delay", `${vars.delay}s`);

    const shell = document.createElement("div");
    shell.className = "artifact-shell";
    orbitItem.appendChild(shell);

    const elapsedMs = Math.max(0, Date.now() - item.createdAt);

    if (item.type === "text") {
      const doc = document.createElement("button");
      doc.className = "artifact text";
      doc.title = "Copy text to clipboard";
      doc.draggable = true;
      doc.innerHTML = '<img src="./icon-text-doc.svg" alt="Text document" width="42" height="52" draggable="false" />';
      doc.addEventListener("dragstart", (event) => {
        activeLocalDragItemId = item.id;
        localDragDroppedInPortal = false;
        event.dataTransfer.effectAllowed = "copy";
        lastTextDragAt = Date.now();
        debugLog("artifact.text.dragstart", {
          itemId: item.id,
          platform: isWindows ? "win" : "non-win",
          textLength: (item.text || item.textPreview || "").length,
        });
        const payloadSet = attachDownloadData(event, item);
        if (!payloadSet) {
          debugLog("artifact.text.dragstart.download-payload-missing", { itemId: item.id });
        }
      });
      doc.addEventListener("dragend", (event) => {
        const droppedInsidePortal = activeLocalDragItemId === item.id && localDragDroppedInPortal;
        if (activeLocalDragItemId === item.id) {
          activeLocalDragItemId = null;
          localDragDroppedInPortal = false;
        }
        if (droppedInsidePortal) {
          return;
        }
        debugLog("artifact.text.dragend", {
          itemId: item.id,
          dropEffect: event.dataTransfer?.dropEffect || "unknown",
        });
        if (event.dataTransfer?.dropEffect && event.dataTransfer.dropEffect !== "none") {
          void dismissItemFromUi(item.id);
        }
      });
      doc.addEventListener("click", async () => {
        if (Date.now() - lastTextDragAt < 250) {
          return;
        }
        await window.lanTunnel.writeClipboard(item.text || item.textPreview || "");
        setStatus("Text artifact copied.");
      });
      appendPinwheelMask(doc, elapsedMs);
      shell.appendChild(doc);
    } else if (item.isImage && item.previewDataUrl) {
      const wrap = document.createElement("div");
      wrap.className = "artifact image";
      wrap.draggable = true;
      wrap.title = `${item.fileName} - drag out to desktop`;
      const img = document.createElement("img");
      img.src = item.previewDataUrl;
      img.alt = item.fileName || "received image";
      wrap.appendChild(img);
      wrap.addEventListener("dragstart", (event) => {
        activeLocalDragItemId = item.id;
        localDragDroppedInPortal = false;
        event.dataTransfer.effectAllowed = "copy";
        debugLog("artifact.image.dragstart", {
          itemId: item.id,
          platform: isWindows ? "win" : "non-win",
          fileName: item.fileName,
        });
        if (isWindows) {
          attachDownloadData(event, item);
        } else {
          debugLog("artifact.image.dragstart.invoke-startFileDrag", { itemId: item.id });
          window.lanTunnel.startFileDrag(item.id);
        }
      });
      wrap.addEventListener("dragend", (event) => {
        const droppedInsidePortal = activeLocalDragItemId === item.id && localDragDroppedInPortal;
        if (activeLocalDragItemId === item.id) {
          activeLocalDragItemId = null;
          localDragDroppedInPortal = false;
        }
        if (droppedInsidePortal) {
          return;
        }
        debugLog("artifact.image.dragend", {
          itemId: item.id,
          dropEffect: event.dataTransfer?.dropEffect || "unknown",
        });
        if (event.dataTransfer?.dropEffect && event.dataTransfer.dropEffect !== "none") {
          void dismissItemFromUi(item.id);
        }
      });
      appendPinwheelMask(wrap, elapsedMs);
      shell.appendChild(wrap);
    } else {
      const name = item.fileName || "FILE";
      const isZip = name.toLowerCase().endsWith(".zip") || item.mimeType === "application/zip";
      
      const generic = document.createElement("div");
      generic.className = isZip ? "artifact file-zip" : "artifact file-generic";
      generic.draggable = true;
      generic.title = `${name} - drag out to desktop`;
      
      if (isZip) {
        generic.innerHTML = '<img src="./icon-zip-doc.svg" alt="Zip archive" width="42" height="52" draggable="false" />';
      } else {
        const ext = name.includes(".") ? name.split(".").pop().toUpperCase().slice(0, 5) : "FILE";
        generic.textContent = ext;
      }
      
      generic.addEventListener("dragstart", (event) => {
        activeLocalDragItemId = item.id;
        localDragDroppedInPortal = false;
        event.dataTransfer.effectAllowed = "copy";
        debugLog("artifact.file.dragstart", {
          itemId: item.id,
          platform: isWindows ? "win" : "non-win",
          fileName: item.fileName,
        });
        if (isWindows) {
          attachDownloadData(event, item);
        } else {
          debugLog("artifact.file.dragstart.invoke-startFileDrag", { itemId: item.id });
          window.lanTunnel.startFileDrag(item.id);
        }
      });
      generic.addEventListener("dragend", (event) => {
        const droppedInsidePortal = activeLocalDragItemId === item.id && localDragDroppedInPortal;
        if (activeLocalDragItemId === item.id) {
          activeLocalDragItemId = null;
          localDragDroppedInPortal = false;
        }
        if (droppedInsidePortal) {
          return;
        }
        debugLog("artifact.file.dragend", {
          itemId: item.id,
          dropEffect: event.dataTransfer?.dropEffect || "unknown",
        });
        if (event.dataTransfer?.dropEffect && event.dataTransfer.dropEffect !== "none") {
          void dismissItemFromUi(item.id);
        }
      });
      appendPinwheelMask(generic, elapsedMs);
      shell.appendChild(generic);
    }

    orbitLayer.appendChild(orbitItem);
  }
}

function renderPeers() {
  peerList.innerHTML = "";
  if (!peers.length) {
    const li = document.createElement("li");
    li.className = "peer-item";
    li.innerHTML = '<div class="peer-main"><div class="peer-endpoint">No nearby devices yet.</div></div>';
    peerList.appendChild(li);
    return;
  }

  for (const peer of peers) {
    const li = document.createElement("li");
    li.className = "peer-item";
    
    const isActive = activePeerUrl && peer.endpoint === activePeerUrl;
    if (isActive) {
      li.classList.add("active-peer");
    }

    const main = document.createElement("div");
    main.className = "peer-main";
    const name = document.createElement("div");
    name.className = "peer-name";
    name.textContent = peer.name;
    const endpoint = document.createElement("div");
    endpoint.className = "peer-endpoint";
    endpoint.textContent = peer.endpoint;
    main.appendChild(name);
    main.appendChild(endpoint);
    li.appendChild(main);

    if (isActive) {
      const checkIcon = document.createElement("div");
      checkIcon.className = "mini-btn icon-only-btn paired-badge";
      checkIcon.title = "Actively paired";
      checkIcon.innerHTML = '<img src="./icon-check.svg" alt="Paired" width="14" height="14" />';
      li.appendChild(checkIcon);
    } else {
      const pairBtn = document.createElement("button");
      pairBtn.className = "mini-btn icon-only-btn";
      pairBtn.title = "Pair";
      pairBtn.innerHTML = '<img src="./icon-pair.svg" alt="Pair" width="12" height="12" />';
      pairBtn.addEventListener("click", async () => {
        try {
          await window.lanTunnel.requestPairing({
            peerEndpoint: peer.endpoint,
            peerName: peer.name,
          });
          setStatus(`Request sent to ${peer.name}...`);
          renderPeers();
        } catch (error) {
          setStatus(error.message || "Unable to send pairing request.", true);
        }
      });
      li.appendChild(pairBtn);
    }
    
    peerList.appendChild(li);
  }
}

async function sendText(text) {
  try {
    if (!text.trim()) {
      return;
    }
    await window.lanTunnel.sendText({ text });
    setStatus("Text tunneled.");
  } catch (error) {
    setStatus(error.message || "Failed to send text.", true);
  }
}

async function sendFile(file) {
  try {
    debugLog("transfer.send-file.start", {
      name: file?.name,
      type: file?.type,
      size: file?.size,
    });
    const bytes = new Uint8Array(await file.arrayBuffer());
    await window.lanTunnel.sendFile({
      file: {
        name: file.name,
        mimeType: file.type,
        bytes,
      },
    });
    setStatus(`File tunneled: ${truncateStatusName(file.name)}`);
    debugLog("transfer.send-file.success", {
      name: file?.name,
      bytes: bytes.length,
    });
  } catch (error) {
    debugLog("transfer.send-file.error", {
      error: error?.message || String(error),
    });
    setStatus(error.message || "Failed to send file.", true);
  }
}

function getDroppedDirectoryPayload(dataTransfer) {
  if (!dataTransfer?.items?.length) {
    return null;
  }

  for (const item of dataTransfer.items) {
    if (item.kind !== "file") {
      continue;
    }
    const entry = typeof item.webkitGetAsEntry === "function"
      ? item.webkitGetAsEntry()
      : null;
    if (!entry?.isDirectory) {
      continue;
    }

    const droppedFile = typeof item.getAsFile === "function"
      ? item.getAsFile()
      : null;
    const droppedPath = window.lanTunnel.getPathForFile
      ? window.lanTunnel.getPathForFile(droppedFile)
      : droppedFile?.path;
    if (typeof droppedPath !== "string" || !droppedPath) {
      continue;
    }

    return {
      directoryPath: droppedPath,
      directoryName: entry.name || droppedFile.name || "",
    };
  }

  return null;
}

async function sendDirectory({ directoryPath, directoryName }) {
  try {
    debugLog("transfer.send-directory.start", {
      directoryName,
      directoryPath,
    });
    const result = await window.lanTunnel.sendDirectory({
      directoryPath,
      directoryName,
    });
    progressContainer.classList.add("hidden");
    progressBar.style.width = "0%";
    const tunneledName = result?.fileName || `${directoryName || "folder"}.zip`;
    const fileCount = typeof result?.fileCount === "number" ? result.fileCount : null;
    if (fileCount !== null) {
      setStatus(`Folder tunneled: ${truncateStatusName(tunneledName)} (${fileCount} files)`);
    } else {
      setStatus(`Folder tunneled: ${truncateStatusName(tunneledName)}`);
    }
    debugLog("transfer.send-directory.success", {
      directoryName,
      fileName: result?.fileName,
      fileCount: result?.fileCount,
    });
  } catch (error) {
    progressContainer.classList.add("hidden");
    progressBar.style.width = "0%";
    debugLog("transfer.send-directory.error", {
      directoryName,
      error: error?.message || String(error),
    });
    setStatus(error.message || "Failed to send folder.", true);
  }
}

toggleSetupBtn.addEventListener("click", () => {
  setupPanel.classList.toggle("hidden");
});

document.addEventListener("pointerdown", (event) => {
  if (setupPanel.classList.contains("hidden")) {
    return;
  }

  const target = event.target;
  if (setupPanel.contains(target) || toggleSetupBtn.contains(target)) {
    return;
  }

  setupPanel.classList.add("hidden");
});

openAppFolderBtn.addEventListener("click", async () => {
  try {
    const result = await window.lanTunnel.openAppFolder();
    setStatus("Opened app folder.");
    debugLog("app-folder.opened", { path: result?.path });
  } catch (error) {
    setStatus("Unable to open app folder.", true);
    debugLog("app-folder.open-error", {
      error: error?.message || String(error),
    });
  }
});

checkUpdatesBtn.addEventListener("click", async () => {
  try {
    if (!updatesEnabled) {
      setStatus("Updates are available in packaged app builds.");
      return;
    }

    if (updateReadyToInstall) {
      setStatus("Installing update and restarting...");
      await window.lanTunnel.installUpdate();
      return;
    }

    setStatus("Checking for updates...");
    const result = await window.lanTunnel.checkForUpdates();
    if (result?.message) {
      setStatus(result.message, result.ok === false);
    }
  } catch (error) {
    setStatus(error.message || "Unable to update right now.", true);
  }
});

window.addEventListener("paste", async (event) => {
  const targetTag = (event.target?.tagName || "").toLowerCase();
  if (targetTag === "input" || targetTag === "textarea") {
    return;
  }

  event.preventDefault();
  const file = event.clipboardData?.files?.[0];
  if (file) {
    await sendFile(file);
    return;
  }

  const text = event.clipboardData?.getData("text/plain") || "";
  if (text) {
    await sendText(text);
  }
});

window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) {
    dropZone.classList.remove("drag-over");
  }
});

async function handleInboundDrop(dataTransfer) {
  if (activeLocalDragItemId) {
    localDragDroppedInPortal = true;
    return;
  }
  if (!dataTransfer) {
    return;
  }
  const droppedDirectory = getDroppedDirectoryPayload(dataTransfer);
  if (droppedDirectory) {
    await sendDirectory(droppedDirectory);
    return;
  }

  const file = dataTransfer.files?.[0];
  if (file) {
    await sendFile(file);
    return;
  }

  const text = dataTransfer.getData("text/plain") || "";
  if (text) {
    await sendText(text);
  }
}

function installGlobalDropTargets() {
  const allow = (event) => {
    markWindowDropAllowed(event, true);
  };

  const drop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("drag-over");
    await handleInboundDrop(event.dataTransfer);
  };

  window.addEventListener("dragenter", (event) => allow(event), true);
  window.addEventListener("dragover", (event) => allow(event), true);
  window.addEventListener("drop", (event) => {
    void drop(event);
  }, true);

  document.addEventListener("dragenter", (event) => allow(event), true);
  document.addEventListener("dragover", (event) => allow(event), true);
  document.addEventListener("drop", (event) => {
    void drop(event);
  }, true);

  document.documentElement.ondragenter = (event) => allow(event);
  document.documentElement.ondragover = (event) => allow(event);
  document.documentElement.ondrop = (event) => {
    void drop(event);
  };

  if (document.body) {
    document.body.ondragenter = (event) => allow(event);
    document.body.ondragover = (event) => allow(event);
    document.body.ondrop = (event) => {
      void drop(event);
    };
  }
}

window.lanTunnel.onIncomingItem(async () => {
  debugLog("incoming.item.event");
  await refreshReceivedArtifacts();
  setStatus("Artifact arrived.");
});

window.lanTunnel.onPeersUpdated((nextPeers) => {
  peers = nextPeers || [];
  renderPeers();
});

window.lanTunnel.onPairingIncomingRequest((request) => {
  currentPairRequest = request;
  pairRequestText.textContent = `${request.fromName} wants to pair with this portal.`;
  pairRequestModal.classList.remove("hidden");
  setStatus("Incoming pairing request.");
});

window.lanTunnel.onPairingStatus((status) => {
  if (status?.message) {
    setStatus(status.message, status.type === "rejected" || status.type === "timeout");
  }
});

window.lanTunnel.onPaired(({ peerUrl, peerName }) => {
  if (peerUrl) {
    activePeerUrl = peerUrl;
  }
  renderPeers();
  debugLog("pairing.paired", { peerName, peerUrl });
  setStatus(`Paired with ${peerName || "peer"}`);
});

window.lanTunnel.onPairingCleared(({ reason }) => {
  activePeerUrl = "";
  renderPeers();
  debugLog("pairing.cleared", { reason });
  setStatus(reason || "Pairing cleared.", true);
});

window.lanTunnel.onRecoveryStatus((payload) => {
  if (payload?.message) {
    setStatus(payload.message, payload.severity === "error");
  }
});

window.lanTunnel.onUpdateStatus((payload) => {
  if (!payload) {
    return;
  }
  if (payload.stage === "downloaded") {
    updateReadyToInstall = true;
    checkUpdatesBtn.textContent = "Restart to Update";
  } else if (payload.stage === "not-available" || payload.stage === "error") {
    updateReadyToInstall = false;
    checkUpdatesBtn.textContent = "Update";
  }

  if (payload.message) {
    setStatus(payload.message, Boolean(payload.isError) || payload.stage === "error");
  }
});

if (window.lanTunnel.onTransferProgress) {
  window.lanTunnel.onTransferProgress((payload) => {
    if (payload.type === "zip") {
      const percent = Math.round(payload.percent || 0);
      if (percent < 100) {
        progressContainer.classList.remove("hidden");
        progressBar.style.width = `${percent}%`;
        setStatus(`Compressing folder... ${percent}%`);
      } else {
        progressContainer.classList.add("hidden");
        progressBar.style.width = "0%";
      }
    }
  });
}

pairAcceptBtn.addEventListener("click", async () => {
  if (!currentPairRequest) {
    return;
  }
  try {
    await window.lanTunnel.respondPairing({
      requestId: currentPairRequest.requestId,
      accept: true,
    });
    activePeerUrl = currentPairRequest.fromEndpoint;
    renderPeers();
    setStatus(`Paired with ${currentPairRequest.fromName}`);
  } catch (error) {
    setStatus(error.message || "Unable to accept pairing.", true);
  } finally {
    currentPairRequest = null;
    pairRequestModal.classList.add("hidden");
  }
});

pairDeclineBtn.addEventListener("click", async () => {
  if (!currentPairRequest) {
    return;
  }
  try {
    await window.lanTunnel.respondPairing({
      requestId: currentPairRequest.requestId,
      accept: false,
    });
  } catch (error) {
    setStatus(error.message || "Unable to decline pairing.", true);
  } finally {
    currentPairRequest = null;
    pairRequestModal.classList.add("hidden");
  }
});

async function init() {
  installGlobalDropTargets();
  debugLog("init.start", { platform: navigator.platform });
  const appInfo = await window.lanTunnel.appInfo();
  peers = appInfo.peers || [];
  activePeerUrl = appInfo.activePeerUrl || "";
  appVersionLabel.textContent = `v${appInfo.appVersion || "unknown"}`;
  const windowsIntegrityLevel = String(appInfo.windowsIntegrityLevel || "");
  updatesEnabled = Boolean(appInfo.updatesEnabled);

  setupPanel.classList.add("hidden");
  pairRequestModal.classList.add("hidden");
  renderPeers();

  await refreshReceivedArtifacts();
  if (artifactTicker) {
    clearInterval(artifactTicker);
  }
  artifactTicker = setInterval(() => {
    renderOrbitArtifacts();
  }, 500);
  peers = await window.lanTunnel.listPeers();
  renderPeers();
  checkUpdatesBtn.disabled = !updatesEnabled;
  checkUpdatesBtn.title = updatesEnabled
    ? "Check for updates"
    : "Available in packaged builds";
  if (isWindows && (windowsIntegrityLevel === "high" || windowsIntegrityLevel === "system")) {
    setStatus("Run portal without Administrator privileges to allow drag-in.", true);
  } else {
    setStatus("Ready for paste, drop, and drift.");
  }
  debugLog("init.ready", {
    peerCount: peers.length,
    activePeerUrl: activePeerUrl || "",
  });
}

init();

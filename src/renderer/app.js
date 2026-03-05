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
const portalParticlesCanvas = document.getElementById("portalParticles");

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

function showTransferProgress(percent, label) {
  if (!progressContainer || !progressBar) {
    return;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  progressContainer.classList.remove("hidden");
  progressBar.style.width = `${clamped}%`;
  if (label) {
    setStatus(`${label} ${clamped}%`);
  }
}

function hideTransferProgress() {
  if (!progressContainer || !progressBar) {
    return;
  }
  progressContainer.classList.add("hidden");
  progressBar.style.width = "0%";
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

function truncateArtifactLabel(name, maxChars = 12) {
  const value = String(name || "").trim();
  if (!value) {
    return "artifact";
  }
  if (value.length <= maxChars) {
    return value;
  }
  const extensionMatch = value.match(/(\.[^./\\\s]{1,10})$/);
  const extension = extensionMatch ? extensionMatch[1] : "";
  const base = extension ? value.slice(0, -extension.length) : value;
  const reserved = extension ? extension.length + 3 : 3;
  const baseLimit = Math.max(4, maxChars - reserved);
  return `${base.slice(0, baseLimit)}...${extension}`;
}

function extractOpenableLink(input) {
  const raw = String(input || "").trim();
  if (!raw || /\s/.test(raw)) {
    return "";
  }

  let candidate = raw;
  if (/^www\./i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) {
    const looksLikeHost = /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(candidate);
    if (!looksLikeHost) {
      return "";
    }
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return parsed.toString();
    }
  } catch (_error) {
    // Ignore invalid URLs and treat as plain text.
  }

  return "";
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

function initPortalParticles() {
  if (!portalParticlesCanvas) {
    return;
  }
  const ctx = portalParticlesCanvas.getContext("2d", { alpha: true });
  if (!ctx) {
    return;
  }

  const particles = [];
  let width = 0;
  let height = 0;
  let rafId = 0;
  const PARTICLE_COUNT = 48;
  const WARMUP_MS = 5000;

  const seedParticle = () => ({
      x: Math.random(),
      y: 0.92 + Math.random() * 0.1,
      vx: (Math.random() - 0.5) * 0.00005,
      vy: -(0.000025 + Math.random() * 0.000055),
      r: 0.7 + Math.random() * 1.8,
      hue: 190 + Math.random() * 90,
      alpha: 0.18 + Math.random() * 0.32,
      twinkle: Math.random() * Math.PI * 2,
  });

  const respawnParticle = (particle) => {
    const replacement = seedParticle();
    particle.x = replacement.x;
    particle.y = replacement.y;
    particle.vx = replacement.vx;
    particle.vy = replacement.vy;
    particle.r = replacement.r;
    particle.hue = replacement.hue;
    particle.alpha = replacement.alpha;
    particle.twinkle = replacement.twinkle;
  };

  const advanceParticle = (particle, elapsedMs) => {
    const steps = Math.max(1, Math.floor(elapsedMs / 16.67));
    const stepMs = elapsedMs / steps;
    for (let i = 0; i < steps; i += 1) {
      const driftScale = stepMs / 16.67;
      particle.x += particle.vx * driftScale * 60;
      particle.y += particle.vy * driftScale * 60;
      particle.twinkle += 0.02 * driftScale;
      if (particle.x < -0.08) particle.x = 1.08;
      if (particle.x > 1.08) particle.x = -0.08;
      if (particle.y < -0.08) {
        respawnParticle(particle);
      }
    }
  };

  const resetCanvasSize = () => {
    const rect = portalParticlesCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    portalParticlesCanvas.width = Math.round(width * dpr);
    portalParticlesCanvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const particle = seedParticle();
    // Start as if animation has been running for a while to avoid an initial burst from the bottom.
    advanceParticle(particle, Math.random() * WARMUP_MS);
    particles.push(particle);
  }
  resetCanvasSize();
  window.addEventListener("resize", resetCanvasSize);

  let lastTs = 0;
  const tick = (ts) => {
    if (!lastTs) {
      lastTs = ts;
    }
    const dt = Math.min(33, ts - lastTs);
    lastTs = ts;
    const driftScale = dt / 16.67;

    ctx.clearRect(0, 0, width, height);
    for (const p of particles) {
      p.x += p.vx * driftScale * 60;
      p.y += p.vy * driftScale * 60;
      p.twinkle += 0.02 * driftScale;

      if (p.x < -0.08) p.x = 1.08;
      if (p.x > 1.08) p.x = -0.08;
      if (p.y < -0.08) {
        respawnParticle(p);
      }

      const px = p.x * width;
      const py = p.y * height;
      const flicker = 0.78 + Math.sin(p.twinkle) * 0.22;
      ctx.fillStyle = `hsla(${p.hue}, 95%, 78%, ${p.alpha * flicker})`;
      ctx.beginPath();
      ctx.arc(px, py, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    rafId = window.requestAnimationFrame(tick);
  };

  rafId = window.requestAnimationFrame(tick);
  window.addEventListener("beforeunload", () => {
    if (rafId) {
      window.cancelAnimationFrame(rafId);
    }
    window.removeEventListener("resize", resetCanvasSize);
  });
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
    const labelName = item.type === "text" ? "text-note.txt" : (item.fileName || "artifact");

    const elapsedMs = Math.max(0, Date.now() - item.createdAt);

    if (item.type === "text") {
      const textPayload = item.text || item.textPreview || "";
      const openableLink = extractOpenableLink(textPayload);
      const doc = document.createElement("button");
      doc.className = "artifact text";
      doc.title = openableLink ? "Open link" : "Copy text to clipboard";
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
        if (isWindows) {
          const payloadSet = attachDownloadData(event, item);
          if (!payloadSet) {
            debugLog("artifact.text.dragstart.download-payload-missing", { itemId: item.id });
          }
        } else {
          const payloadSet = attachDownloadData(event, item);
          if (!payloadSet) {
            event.preventDefault();
            window.lanTunnel.startFileDrag(item.id);
          }
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
        if (openableLink && window.lanTunnel.openExternal) {
          try {
            await window.lanTunnel.openExternal(openableLink);
            setStatus("Opened link.");
          } catch (error) {
            setStatus(error.message || "Unable to open link.", true);
          }
          return;
        }
        await window.lanTunnel.writeClipboard(textPayload);
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
          const payloadSet = attachDownloadData(event, item);
          if (!payloadSet) {
            event.preventDefault();
            window.lanTunnel.startFileDrag(item.id);
          }
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
      const isExe = name.toLowerCase().endsWith(".exe") || item.mimeType === "application/x-msdownload";
      
      const generic = document.createElement("div");
      if (isZip) {
        generic.className = "artifact file-zip";
      } else if (isExe) {
        generic.className = "artifact file-exe";
      } else {
        generic.className = "artifact file-generic";
      }
      
      generic.draggable = true;
      generic.title = `${name} - drag out to desktop`;
      
      if (isZip) {
        generic.innerHTML = '<img src="./icon-zip-doc.svg" alt="Zip archive" width="42" height="52" draggable="false" />';
      } else if (isExe) {
        generic.innerHTML = '<img src="./icon-exe-doc.svg" alt="Executable" width="42" height="52" draggable="false" />';
      } else {
        generic.innerHTML = '<img src="./icon-file-doc.svg" alt="File document" width="42" height="52" draggable="false" />';
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
          const payloadSet = attachDownloadData(event, item);
          if (!payloadSet) {
            event.preventDefault();
            window.lanTunnel.startFileDrag(item.id);
          }
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

    const label = document.createElement("div");
    label.className = "artifact-label";
    label.textContent = truncateArtifactLabel(labelName);
    label.title = labelName;
    orbitItem.appendChild(label);

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
    hideTransferProgress();
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
    hideTransferProgress();
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
    if (!payload) {
      return;
    }
    if (payload.kind === "error" || payload.kind === "done") {
      hideTransferProgress();
      return;
    }
    if (payload.kind === "compress" || payload.kind === "send") {
      showTransferProgress(payload.percent, payload.label || "Processing...");
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
  initPortalParticles();
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

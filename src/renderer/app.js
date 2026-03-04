const peerUrlInput = document.getElementById("peerUrl");
const toggleSetupBtn = document.getElementById("toggleSetupBtn");
const copyEndpointBtn = document.getElementById("copyEndpointBtn");
const setupPanel = document.getElementById("setupContent");
const pairStatusEl = document.getElementById("pairStatus");
const localUrlList = document.getElementById("localUrlList");
const peerList = document.getElementById("peerList");
const dropZone = document.getElementById("dropZone");
const orbitLayer = document.getElementById("orbitLayer");
const statusEl = document.getElementById("status");
const pairRequestModal = document.getElementById("pairRequestModal");
const pairRequestText = document.getElementById("pairRequestText");
const pairAcceptBtn = document.getElementById("pairAcceptBtn");
const pairDeclineBtn = document.getElementById("pairDeclineBtn");

let endpoints = [];
let peers = [];
let receivedItems = [];
let currentPairRequest = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9fba" : "#9cbad6";
}

function setPairStatus(message) {
  pairStatusEl.textContent = message;
}

function hashValue(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) % 2147483647;
  }
  return Math.abs(hash);
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
  receivedItems = await window.lanTunnel.listItems();
  renderOrbitArtifacts();
}

function renderOrbitArtifacts() {
  orbitLayer.innerHTML = "";
  const visible = receivedItems.slice(0, 14);

  for (const [index, item] of visible.entries()) {
    const orbitItem = document.createElement("div");
    orbitItem.className = "orbit-item";
    const vars = artifactVarsFor(item, index);
    orbitItem.style.setProperty("--x", `${vars.x}%`);
    orbitItem.style.setProperty("--y", `${vars.y}%`);
    orbitItem.style.setProperty("--dx", `${vars.dx}px`);
    orbitItem.style.setProperty("--dy", `${vars.dy}px`);
    orbitItem.style.setProperty("--dur", `${vars.dur}s`);
    orbitItem.style.setProperty("--delay", `${vars.delay}s`);

    if (item.type === "text") {
      const doc = document.createElement("button");
      doc.className = "artifact text";
      doc.title = "Copy text to clipboard";
      doc.innerHTML = `
        <svg viewBox="0 0 64 78" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="8" y="6" width="48" height="66" rx="8" fill="#f8fbff" stroke="#89c6ff" stroke-width="2"/>
          <polyline points="44,6 56,18 44,18" fill="#d7ecff" stroke="#89c6ff" stroke-width="2"/>
          <line x1="17" y1="28" x2="47" y2="28" stroke="#6ca5db" stroke-width="3" stroke-linecap="round"/>
          <line x1="17" y1="37" x2="47" y2="37" stroke="#6ca5db" stroke-width="3" stroke-linecap="round"/>
          <line x1="17" y1="46" x2="39" y2="46" stroke="#6ca5db" stroke-width="3" stroke-linecap="round"/>
          <circle cx="48" cy="58" r="8" fill="#7bd0ff"/>
          <text x="48" y="61.5" text-anchor="middle" font-size="8" fill="#04304d" font-weight="700">TXT</text>
        </svg>
      `;
      doc.addEventListener("click", async () => {
        await window.lanTunnel.writeClipboard(item.text || item.textPreview || "");
        setStatus("Text artifact copied.");
      });
      orbitItem.appendChild(doc);
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
        event.dataTransfer.effectAllowed = "copy";
        window.lanTunnel.startFileDrag(item.id);
      });
      orbitItem.appendChild(wrap);
    } else {
      const generic = document.createElement("div");
      generic.className = "artifact file-generic";
      generic.draggable = true;
      const name = item.fileName || "FILE";
      const ext = name.includes(".") ? name.split(".").pop().toUpperCase().slice(0, 5) : "FILE";
      generic.textContent = ext;
      generic.title = `${name} - drag out to desktop`;
      generic.addEventListener("dragstart", (event) => {
        event.dataTransfer.effectAllowed = "copy";
        window.lanTunnel.startFileDrag(item.id);
      });
      orbitItem.appendChild(generic);
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

    const pairBtn = document.createElement("button");
    pairBtn.className = "mini-btn";
    pairBtn.textContent = "Pair";
    pairBtn.addEventListener("click", async () => {
      try {
        await window.lanTunnel.requestPairing({
          peerEndpoint: peer.endpoint,
          peerName: peer.name,
        });
        peerUrlInput.value = peer.endpoint;
        setStatus(`Request sent to ${peer.name}...`);
      } catch (error) {
        setStatus(error.message || "Unable to send pairing request.", true);
      }
    });
    li.appendChild(pairBtn);
    peerList.appendChild(li);
  }
}

async function sendText(text) {
  try {
    if (!text.trim()) {
      return;
    }
    await window.lanTunnel.sendText({ peerUrl: peerUrlInput.value, text });
    setStatus("Text tunneled.");
  } catch (error) {
    setStatus(error.message || "Failed to send text.", true);
  }
}

async function sendFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await window.lanTunnel.sendFile({
      peerUrl: peerUrlInput.value,
      file: {
        name: file.name,
        mimeType: file.type,
        bytes,
      },
    });
    setStatus(`File tunneled: ${file.name}`);
  } catch (error) {
    setStatus(error.message || "Failed to send file.", true);
  }
}

toggleSetupBtn.addEventListener("click", () => {
  setupPanel.classList.toggle("hidden");
});

copyEndpointBtn.addEventListener("click", async () => {
  const preferred = endpoints.find((url) => !url.includes("localhost")) || endpoints[0];
  if (!preferred) {
    setStatus("No endpoint available.", true);
    return;
  }
  await window.lanTunnel.writeClipboard(preferred);
  setStatus("Endpoint copied.");
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

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

window.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) {
    dropZone.classList.remove("drag-over");
  }
});

dropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  dropZone.classList.remove("drag-over");

  const file = event.dataTransfer?.files?.[0];
  if (file) {
    await sendFile(file);
    return;
  }

  const text = event.dataTransfer?.getData("text/plain") || "";
  if (text) {
    await sendText(text);
  }
});

window.lanTunnel.onIncomingItem(async () => {
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
    peerUrlInput.value = peerUrl;
  }
  setPairStatus(`Paired with ${peerName || "peer"}`);
});

pairAcceptBtn.addEventListener("click", async () => {
  if (!currentPairRequest) {
    return;
  }
  try {
    await window.lanTunnel.respondPairing({
      requestId: currentPairRequest.requestId,
      accept: true,
    });
    peerUrlInput.value = currentPairRequest.fromEndpoint;
    setPairStatus(`Paired with ${currentPairRequest.fromName}`);
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
  const appInfo = await window.lanTunnel.appInfo();
  endpoints = appInfo.localUrls;
  peers = appInfo.peers || [];
  if (appInfo.activePeerUrl) {
    peerUrlInput.value = appInfo.activePeerUrl;
    setPairStatus(`Paired with ${appInfo.activePeerName || "peer"}`);
  } else {
    setPairStatus("Not paired");
  }

  setupPanel.classList.add("hidden");
  pairRequestModal.classList.add("hidden");
  renderPeers();
  localUrlList.innerHTML = "";
  for (const url of endpoints) {
    const li = document.createElement("li");
    li.className = "url-item";
    const code = document.createElement("code");
    code.textContent = url;
    li.appendChild(code);
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "mini-btn";
    copyBtn.addEventListener("click", async () => {
      await window.lanTunnel.writeClipboard(url);
      setStatus(`Copied ${url}`);
    });
    li.appendChild(copyBtn);
    localUrlList.appendChild(li);
  }

  await refreshReceivedArtifacts();
  peers = await window.lanTunnel.listPeers();
  renderPeers();
  setStatus("Ready for paste, drop, and drift.");
}

init();

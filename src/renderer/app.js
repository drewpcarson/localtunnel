const peerUrlInput = document.getElementById("peerUrl");
const toggleSetupBtn = document.getElementById("toggleSetupBtn");
const toggleReceivedBtn = document.getElementById("toggleReceivedBtn");
const copyEndpointBtn = document.getElementById("copyEndpointBtn");
const setupPanel = document.getElementById("setupContent");
const receivedPanel = document.getElementById("receivedPanel");
const pairStatusEl = document.getElementById("pairStatus");
const localUrlList = document.getElementById("localUrlList");
const peerList = document.getElementById("peerList");
const dropZone = document.getElementById("dropZone");
const statusEl = document.getElementById("status");
const receivedList = document.getElementById("receivedList");
const pairRequestModal = document.getElementById("pairRequestModal");
const pairRequestText = document.getElementById("pairRequestText");
const pairAcceptBtn = document.getElementById("pairAcceptBtn");
const pairDeclineBtn = document.getElementById("pairDeclineBtn");
let endpoints = [];
let peers = [];
let currentPairRequest = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9fba" : "#9cbad6";
}

function setPairStatus(message) {
  pairStatusEl.textContent = message;
}

function formatBytes(size) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
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

async function renderReceivedItems() {
  const items = await window.lanTunnel.listItems();
  receivedList.innerHTML = "";

  if (!items.length) {
    const li = document.createElement("li");
    li.className = "received-item";
    li.textContent = "No incoming data yet.";
    receivedList.appendChild(li);
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "received-item";

    const header = document.createElement("div");
    header.className = "meta";
    header.textContent = new Date(item.createdAt).toLocaleString();
    li.appendChild(header);

    if (item.type === "text") {
      const text = document.createElement("p");
      text.textContent = item.textPreview;
      li.appendChild(text);

      const copyTextBtn = document.createElement("button");
      copyTextBtn.textContent = "Copy Text";
      copyTextBtn.addEventListener("click", async () => {
        await window.lanTunnel.writeClipboard(item.textPreview);
        setStatus("Received text copied.");
      });
      li.appendChild(copyTextBtn);
    } else {
      const details = document.createElement("p");
      details.textContent = `${item.fileName} (${formatBytes(item.size)})`;
      li.appendChild(details);

      const button = document.createElement("button");
      button.textContent = "Save File";
      button.addEventListener("click", async () => {
        try {
          const result = await window.lanTunnel.saveFile(item.id);
          if (result.saved) {
            setStatus(`Saved ${item.fileName}`);
          }
        } catch (error) {
          setStatus(error.message || "Unable to save file.", true);
        }
      });
      li.appendChild(button);
    }

    receivedList.appendChild(li);
  }
}

async function sendText(text) {
  try {
    if (!text.trim()) {
      setStatus("No text content found.", true);
      return;
    }

    await window.lanTunnel.sendText({ peerUrl: peerUrlInput.value, text });

    setStatus("Text sent.");
  } catch (error) {
    setStatus(error.message || "Failed to send text.", true);
  }
}

async function sendFile(selected) {
  try {
    const bytes = new Uint8Array(await selected.arrayBuffer());
    await window.lanTunnel.sendFile({
      peerUrl: peerUrlInput.value,
      file: {
        name: selected.name,
        mimeType: selected.type,
        bytes,
      },
    });
    setStatus(`File sent: ${selected.name}`);
  } catch (error) {
    setStatus(error.message || "Failed to send file.", true);
  }
}

toggleSetupBtn.addEventListener("click", () => {
  setupPanel.classList.toggle("hidden");
  receivedPanel.classList.add("hidden");
});

toggleReceivedBtn.addEventListener("click", async () => {
  receivedPanel.classList.toggle("hidden");
  setupPanel.classList.add("hidden");
  await renderReceivedItems();
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
  } else {
    setStatus("Dropped content is empty.", true);
  }
});

window.lanTunnel.onIncomingItem(() => {
  renderReceivedItems();
  setStatus("Incoming item received.");
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
  receivedPanel.classList.add("hidden");
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

  await renderReceivedItems();
  peers = await window.lanTunnel.listPeers();
  renderPeers();
  setStatus("Ready for paste or drop.");
}

init();

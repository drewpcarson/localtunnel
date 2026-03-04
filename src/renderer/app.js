const sharedKeyInput = document.getElementById("sharedKey");
const peerUrlInput = document.getElementById("peerUrl");
const toggleSetupBtn = document.getElementById("toggleSetupBtn");
const toggleReceivedBtn = document.getElementById("toggleReceivedBtn");
const copyEndpointBtn = document.getElementById("copyEndpointBtn");
const setupPanel = document.getElementById("setupContent");
const receivedPanel = document.getElementById("receivedPanel");
const localUrlList = document.getElementById("localUrlList");
const dropZone = document.getElementById("dropZone");
const statusEl = document.getElementById("status");
const receivedList = document.getElementById("receivedList");
let endpoints = [];

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9fba" : "#9cbad6";
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

    await window.lanTunnel.sendText({
      peerUrl: peerUrlInput.value,
      text,
    });

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

sharedKeyInput.addEventListener("input", async () => {
  await window.lanTunnel.updateSharedKey(sharedKeyInput.value);
});

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

async function init() {
  const appInfo = await window.lanTunnel.appInfo();
  endpoints = appInfo.localUrls;
  setupPanel.classList.add("hidden");
  receivedPanel.classList.add("hidden");
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
  setStatus("Ready for paste or drop.");
}

init();

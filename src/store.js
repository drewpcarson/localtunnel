const receivedItems = [];
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const WEB_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/avif",
]);

function toImagePreviewDataUrl(item) {
  if (
    item.type !== "file"
    || !item.mimeType?.startsWith("image/")
    || !item.bytes
    || item.size > MAX_PREVIEW_BYTES
  ) {
    return "";
  }

  const mimeType = String(item.mimeType || "").toLowerCase();
  if (WEB_NATIVE_IMAGE_MIME_TYPES.has(mimeType)) {
    return `data:${mimeType};base64,${item.bytes.toString("base64")}`;
  }

  // Fallback for formats the renderer may not decode directly (for example HEIC/HEIF):
  // ask Electron to decode and re-encode as PNG data URL when possible.
  try {
    const { nativeImage } = require("electron");
    const image = nativeImage.createFromBuffer(item.bytes);
    if (!image.isEmpty()) {
      return image.toDataURL();
    }
  } catch (_error) {
    // Ignore decode failures and leave preview empty.
  }

  return "";
}

function addReceivedItem(item) {
  receivedItems.unshift(item);
}

function listReceivedItems() {
  return receivedItems.map((item) => ({
    id: item.id,
    type: item.type,
    createdAt: item.createdAt,
    fileName: item.fileName,
    mimeType: item.mimeType,
    size: item.size,
    text: item.type === "text" ? item.text : "",
    textPreview: item.type === "text" ? item.text.slice(0, 120) : "",
    isImage: item.type === "file" ? item.mimeType?.startsWith("image/") : false,
    previewDataUrl: toImagePreviewDataUrl(item),
  }));
}

function getReceivedItem(id) {
  return receivedItems.find((item) => item.id === id);
}

function removeReceivedItem(id) {
  const idx = receivedItems.findIndex((item) => item.id === id);
  if (idx < 0) {
    return false;
  }
  receivedItems.splice(idx, 1);
  return true;
}

module.exports = {
  addReceivedItem,
  getReceivedItem,
  listReceivedItems,
  removeReceivedItem,
};

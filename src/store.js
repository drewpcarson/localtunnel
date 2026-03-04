const receivedItems = [];

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
    previewDataUrl:
      item.type === "file" &&
      item.mimeType?.startsWith("image/") &&
      item.size <= 8 * 1024 * 1024
        ? `data:${item.mimeType};base64,${item.bytes.toString("base64")}`
        : "",
  }));
}

function getReceivedItem(id) {
  return receivedItems.find((item) => item.id === id);
}

module.exports = {
  addReceivedItem,
  getReceivedItem,
  listReceivedItems,
};

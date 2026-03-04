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
    textPreview: item.type === "text" ? item.text.slice(0, 2000) : "",
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

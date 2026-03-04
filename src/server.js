const os = require("node:os");
const crypto = require("node:crypto");
const express = require("express");
const cors = require("cors");
const { decryptBuffer, keyFingerprint } = require("./crypto");
const { addReceivedItem, getReceivedItem, listReceivedItems } = require("./store");

function getLanAddresses(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const iface of Object.values(interfaces)) {
    if (!iface) {
      continue;
    }

    for (const details of iface) {
      if (details.family !== "IPv4" || details.internal) {
        continue;
      }

      urls.push(`http://${details.address}:${port}`);
    }
  }

  return urls;
}

function startServer({
  port,
  getSharedKey,
  onIncomingItem,
  onPairRequest,
  onPairConfirm,
}) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "200mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (req.method === "GET") {
      return next();
    }
    if (req.path === "/api/pair-request" || req.path === "/api/pair-confirm") {
      return next();
    }

    const sharedKey = getSharedKey();
    if (!sharedKey || sharedKey.length < 8) {
      return res.status(401).json({ error: "Set a shared key first." });
    }

    const auth = req.headers.authorization || "";
    const expected = `Bearer ${keyFingerprint(sharedKey)}`;
    if (auth !== expected) {
      return res.status(401).json({ error: "Invalid authorization." });
    }

    return next();
  });

  app.post("/api/receive-text", (req, res) => {
    try {
      const sharedKey = getSharedKey();
      const payload = req.body?.payload;
      if (!payload) {
        return res.status(400).json({ error: "Missing payload." });
      }

      const decrypted = decryptBuffer(payload, sharedKey).toString("utf8");
      const item = {
        id: crypto.randomUUID(),
        type: "text",
        text: decrypted,
        createdAt: Date.now(),
      };
      addReceivedItem(item);
      onIncomingItem(item);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: "Unable to decrypt message." });
    }
  });

  app.post("/api/receive-file", (req, res) => {
    try {
      const sharedKey = getSharedKey();
      const payload = req.body?.payload;
      const fileName = req.body?.fileName;
      const mimeType = req.body?.mimeType || "application/octet-stream";
      if (!payload || !fileName) {
        return res.status(400).json({ error: "Missing file payload." });
      }

      const fileBytes = decryptBuffer(payload, sharedKey);
      const item = {
        id: crypto.randomUUID(),
        type: "file",
        fileName,
        mimeType,
        size: fileBytes.length,
        bytes: fileBytes,
        createdAt: Date.now(),
      };
      addReceivedItem(item);
      onIncomingItem(item);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(400).json({ error: "Unable to decrypt file." });
    }
  });

  app.get("/api/items", (_req, res) => {
    res.json({ items: listReceivedItems() });
  });

  app.post("/api/pair-request", (req, res) => {
    const requestId = String(req.body?.requestId || "");
    const fromName = String(req.body?.fromName || "Unknown device");
    const fromEndpoint = String(req.body?.fromEndpoint || "");
    const proposedKey = String(req.body?.proposedKey || "");
    if (!requestId || !fromEndpoint || proposedKey.length < 16) {
      return res.status(400).json({ error: "Invalid pairing request." });
    }
    if (onPairRequest) {
      onPairRequest({
        requestId,
        fromName,
        fromEndpoint,
        proposedKey,
      });
    }
    return res.json({ ok: true });
  });

  app.post("/api/pair-confirm", (req, res) => {
    const requestId = String(req.body?.requestId || "");
    const accepted = Boolean(req.body?.accepted);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid pairing confirmation." });
    }
    if (onPairConfirm) {
      onPairConfirm({
        requestId,
        accepted,
      });
    }
    return res.json({ ok: true });
  });

  app.get("/api/download/:id", (req, res) => {
    const item = getReceivedItem(req.params.id);
    if (!item || item.type !== "file") {
      return res.status(404).json({ error: "File not found." });
    }

    res.setHeader("Content-Type", item.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(item.fileName)}"`
    );
    res.send(item.bytes);
    return undefined;
  });

  const server = app.listen(port, "0.0.0.0");

  return {
    server,
    localUrls: [`http://localhost:${port}`, ...getLanAddresses(port)],
  };
}

module.exports = {
  startServer,
};

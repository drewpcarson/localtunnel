const os = require("node:os");
const dgram = require("node:dgram");
const crypto = require("node:crypto");

const DISCOVERY_PORT = 43828;
const BROADCAST_ADDRESS = "255.255.255.255";
const BROADCAST_MS = 2000;
const STALE_AFTER_MS = 7000;

function startDiscovery({ endpointProvider, onPeersChange }) {
  const selfId = crypto.randomUUID();
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const peers = new Map();
  let intervalId;

  function emitPeers() {
    const now = Date.now();
    for (const [id, peer] of peers.entries()) {
      if (now - peer.lastSeenAt > STALE_AFTER_MS) {
        peers.delete(id);
      }
    }
    onPeersChange(
      Array.from(peers.values()).map((peer) => ({
        id: peer.id,
        name: peer.name,
        endpoint: peer.endpoint,
        lastSeenAt: peer.lastSeenAt,
      }))
    );
  }

  function broadcastPresence() {
    const endpoint = endpointProvider();
    if (!endpoint) {
      return;
    }

    const payload = Buffer.from(
      JSON.stringify({
        t: "lan-paste-presence",
        id: selfId,
        name: os.hostname(),
        endpoint,
      }),
      "utf8"
    );

    socket.send(payload, DISCOVERY_PORT, BROADCAST_ADDRESS);
  }

  socket.on("message", (buffer) => {
    try {
      const message = JSON.parse(buffer.toString("utf8"));
      if (message?.t !== "lan-paste-presence" || !message?.id || !message?.endpoint) {
        return;
      }
      if (message.id === selfId) {
        return;
      }

      peers.set(message.id, {
        id: message.id,
        name: String(message.name || "Unknown device"),
        endpoint: String(message.endpoint),
        lastSeenAt: Date.now(),
      });
      emitPeers();
    } catch (_error) {
      // Ignore malformed discovery packets.
    }
  });

  socket.bind(DISCOVERY_PORT, "0.0.0.0", () => {
    socket.setBroadcast(true);
    broadcastPresence();
    intervalId = setInterval(() => {
      broadcastPresence();
      emitPeers();
    }, BROADCAST_MS);
  });

  return {
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
      }
      socket.close();
    },
    getPeers() {
      emitPeers();
      return Array.from(peers.values()).map((peer) => ({
        id: peer.id,
        name: peer.name,
        endpoint: peer.endpoint,
        lastSeenAt: peer.lastSeenAt,
      }));
    },
  };
}

module.exports = {
  startDiscovery,
};

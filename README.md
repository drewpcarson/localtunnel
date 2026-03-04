# LAN Paste Tunnel

Minimal desktop app for secure text and file transfer between two machines on the same WiFi.

## Why this design

- Cross-platform desktop shell via Electron (macOS + Windows).
- Local HTTP service on each machine for direct LAN exchange.
- Payload encryption with AES-256-GCM and PBKDF2 key derivation.
- Shared-key authorization to reject unauthenticated requests.
- Simple UI: shared key, peer address, text paste target, file send, and received list.

## Run locally

```bash
npm install
npm start
```

## Usage

1. Launch app on both machines.
2. Set the same shared key on both machines (minimum 8 chars).
3. Copy one machine's local endpoint (for example `http://192.168.1.23:43827`) into the other machine's peer address.
4. Paste text or choose a file and send.
5. Receive on the other machine and save files from the received list.

## Notes

- Traffic stays on your local network unless you explicitly route it differently.
- Large files are serialized in memory; optimize with chunked transport if you expect very large payloads.

# Federated SPV Relay Mesh — Handbook

**A five-layer SPV bridge for the Bitcoin SV network.**

Built for [Indelible](https://indelible.one). Open to anyone building on Bitcoin.

---

## What This Is

This is a federation of lightweight Bitcoin nodes that cooperate to broadcast, look up, and verify transactions — without storing the full blockchain.

Each node (called a "bridge") connects directly to Bitcoin full nodes over the native P2P protocol, maintains its own copy of all block headers (~80MB), and broadcasts transactions the way Satoshi designed it: `inv` → `getdata` → `tx` ([Bitcoin whitepaper, Section 5](https://bitcoin.org/bitcoin.pdf)).

What makes this different from a single SPV node is the federation. Bridges discover each other, health-check each other, and share transactions with each other. If one bridge has a transaction that another doesn't, the mesh fills the gap. If a bridge goes down, the others keep serving. When it comes back, it catches up — exactly as Nakamoto specified:

> *"Nodes can leave and rejoin the network at will, accepting the longest proof-of-work chain as proof of what happened while they were gone."*

**The more bridges that run, the stronger the network gets.** Every new bridge adds another P2P connection to the Bitcoin network, another copy of the header chain, another relay path for transactions. The mesh is self-healing — bridges that crash recover automatically, and the federation absorbs the disruption without any client knowing.

This is the infrastructure layer that makes BSV usable for applications that need reliable, low-latency access to the blockchain without running a full node.

---

## Architecture

Five layers, each in its own module:

| Layer | File | What It Does |
|-------|------|-------------|
| **L1: P2P** | `p2p.js` | Speaks native Bitcoin protocol (v70016) over TCP to full nodes on port 8333 |
| **L2: SPV Client** | `spv-client.js` | Manages peers, broadcasts txs, fetches txs via `getdata`, handles `notfound` |
| **L3: Header Sync** | `header-sync.js` | Downloads and stores all block headers in LevelDB, dual-indexed by height and hash |
| **L4: API** | `server-spv.js` | REST + WebSocket API on port 8080, rate limiting, CORS, caching |
| **L5: Mesh** | `bridge-mesh.js` | Bridge-to-bridge federation — health checks, on-demand tx forwarding, loop prevention |

The supervision layer (crash resilience, self-healing) spans all modules. See the [whitepaper, Section 8](https://indelible.one/federated-spv-relay-mesh.pdf) for the full technical description.

**Reference papers:**
- [Federated SPV Relay Mesh](https://indelible.one/federated-spv-relay-mesh.pdf) — zcooL, February 2026
- [Bitcoin: A Peer-to-Peer Electronic Cash System](https://bitcoin.org/bitcoin.pdf) — Satoshi Nakamoto, 2008
- [Overlay Network Architecture for Bitcoin Scaling](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6277825) — Craig S. Wright, 2025

---

## Quick Start (Single Bridge)

### Requirements

- Ubuntu 22.04+ or Debian 12+
- Node.js 18+ (`node -v`)
- 1GB RAM minimum (4GB recommended for high-throughput)

### Install

```bash
# Clone the repo
git clone https://github.com/zcoolz/federated-spv-bridge.git
cd federated-spv-bridge

# Install dependencies (only 3: level, ws, ssh2)
npm install

# Start it
node server-spv.js
```

### What Happens on First Boot

1. LevelDB opens (creates `./data/` directory)
2. Header sync begins — downloads all 938,000+ BSV block headers from P2P peers
3. P2P connections establish to 3+ Bitcoin full nodes
4. HTTP/WS server starts on port 8080
5. Health endpoint goes live at `http://localhost:8080/health`

**First sync takes 15-30 minutes** on a 1GB VPS. After that, catching up is instant.

If you're on a 1GB box:
```bash
NODE_OPTIONS='--max-old-space-size=768' node server-spv.js
```

### Verify It Works

```bash
curl http://localhost:8080/health
```

You should see:
```json
{
  "status": "ok",
  "mode": "spv-first",
  "headerHeight": 938093,
  "connectedPeers": 3,
  "uptime": 120
}
```

---

## Running a Fleet (Multiple Bridges)

The real power is in the mesh. One bridge is useful. Five bridges are resilient.

### Adding a Bridge to the Mesh

Every bridge needs to know about the others. Set the `MESH_PEERS` environment variable to a comma-separated list of peer bridge URLs — **excluding itself**.

**Example: 3-bridge fleet**

Bridge A (Chicago):
```bash
export MESH_PEERS='http://BRIDGE_B_IP:8080,http://BRIDGE_C_IP:8080'
node server-spv.js
```

Bridge B (Dallas):
```bash
export MESH_PEERS='http://BRIDGE_A_IP:8080,http://BRIDGE_C_IP:8080'
node server-spv.js
```

Bridge C (Atlanta):
```bash
export MESH_PEERS='http://BRIDGE_A_IP:8080,http://BRIDGE_B_IP:8080'
node server-spv.js
```

### Loop Prevention

When Bridge A asks Bridge B for a transaction, it appends `?nomesh=1` to the request. Bridge B will search its own local data and P2P peers, but **will not** forward the request to other bridges. This prevents infinite loops. One hop maximum.

### Health Monitoring

Every bridge pings its mesh peers every 30 seconds. Check mesh status:

```bash
curl http://localhost:8080/api/mesh/status
```

Response:
```json
{
  "peers": [
    { "url": "http://BRIDGE_B:8080", "healthy": true, "latency": 12 },
    { "url": "http://BRIDGE_C:8080", "healthy": true, "latency": 35 }
  ],
  "healthyCount": 2,
  "totalCount": 2
}
```

### start-mesh.sh (Production)

For production, use a startup script:

```bash
#!/bin/bash
pkill -f server-spv.js 2>/dev/null
sleep 1
cd /opt/spv-bridge
export MESH_PEERS='http://PEER1:8080,http://PEER2:8080,http://PEER3:8080'
export NODE_OPTIONS='--max-old-space-size=768'  # Use 3072 for 4GB boxes
nohup node server-spv.js > /var/log/spv-bridge.log 2>&1 &
echo "Bridge started (PID $!)"
```

---

## Configuration

All configuration is via environment variables. No config files needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP/WebSocket listen port |
| `MESH_PEERS` | *(empty)* | Comma-separated peer bridge URLs (mesh disabled if empty) |
| `SPV_API_KEY` | *(required)* | API key for authenticated server-to-server calls |
| `BRIDGE_SECRET` | *(empty)* | Shared secret for bridge-to-backend validation |
| `INDELIBLE_BACKEND` | `https://indelible.one` | Backend URL for relay key validation |
| `NODE_OPTIONS` | *(none)* | Set `--max-old-space-size=768` for 1GB boxes |

---

## API Reference

### REST Endpoints

#### Health Check
```
GET /health
```
Returns bridge status: header height, peer count, cache size, uptime, WoC fallback counts.

#### Get Transaction (JSON)
```
GET /api/tx/:txid
```
Lookup chain: Cache → Pending → P2P getdata → Mesh peers → 404

#### Get Transaction (Raw Hex)
```
GET /api/tx/:txid/hex
```
Same lookup chain, returns raw transaction hex as plain text.

#### Broadcast Transaction
```
POST /api/broadcast
Content-Type: application/json

{ "rawTx": "0100000001..." }
```
Broadcasts via P2P `inv`/`getdata`/`tx` protocol to all connected full nodes. Returns `{ "txid": "...", "broadcast": true }`.

#### Address Balance
```
GET /api/address/:address/balance
```
Currently uses WhatsOnChain fallback (tracked for elimination).

#### Address UTXOs
```
GET /api/address/:address/unspent
```
Returns unspent transaction outputs for an address.

#### Address History
```
GET /api/address/:address/history
```
Returns transaction history. Uses SPV data for watched addresses, WoC fallback for others.

#### WoC Fallback Monitor
```
GET /api/woc-fallbacks
```
Shows every time the bridge fell back to WhatsOnChain instead of using SPV. **Goal: zero.**

#### Mesh Status
```
GET /api/mesh/status
```
Shows all mesh peers with health, latency, and failure counts.

### WebSocket API

Connect to `ws://BRIDGE_IP:8080` and send JSON messages:

```json
{ "method": "broadcast", "params": { "rawTx": "0100..." }, "id": 1 }
```

**Available methods:**

| Method | Params | Description |
|--------|--------|-------------|
| `ping` | *(none)* | Health check, returns `{ pong: true }` |
| `getStatus` | *(none)* | Bridge status (header height, peers, etc.) |
| `getTx` | `{ txid }` | Get transaction by ID |
| `getTxHex` | `{ txid }` | Get raw transaction hex |
| `broadcast` | `{ rawTx }` | Broadcast a signed transaction |
| `getBalance` | `{ address }` | Get address balance |
| `getUtxos` | `{ address }` | Get unspent outputs |
| `getHistory` | `{ address }` | Get transaction history |
| `watchAddress` | `{ address }` | Subscribe to real-time tx notifications |
| `unwatchAddress` | `{ address }` | Unsubscribe from notifications |
| `getHeaderByHeight` | `{ height }` | Get block header at height |
| `getHeaderByHash` | `{ hash }` | Get block header by hash |
| `verifyTx` | `{ txid }` | Verify tx inclusion in a block (Merkle proof) |

**Real-time events** (pushed to WebSocket clients):

| Event | When |
|-------|------|
| `tx` | A watched address receives a transaction |
| `tx:confirmed` | A pending transaction is confirmed in a block |
| `newblock` | A new block is detected |

---

## Security

### Rate Limiting
- 100 requests/minute per IP (no API key)
- Unlimited with valid `X-API-Key` header

### CORS
- Whitelisted origins only (configurable in `server-spv.js`)
- Requests from unknown origins are silently blocked

### API Key Authentication
- Server-to-server calls require `X-API-Key` header
- API key holders bypass rate limits and get permissive CORS

### What NOT to Do

**NEVER send a `filterload` message to a BSV full node.** `NODE_BLOOM` is disabled by default. Sending a bloom filter results in an immediate Misbehaving score of 100 and a 24-hour ban from that peer. This bridge does not use bloom filters — all transaction lookups use direct `getdata MSG_TX` requests.

---

## Troubleshooting

### "Database is not open"
LevelDB is corrupted. Delete and re-sync:
```bash
rm -rf ./data
node server-spv.js  # Will re-sync headers from scratch
```

### Headers stuck / not syncing
Header sync uses live P2P peers. If you see "Failed to connect to any peers" in the log, check your network. The bridge discovers peers via [WhatsOnChain's peer API](https://api.whatsonchain.com/v1/bsv/main/peer/info) first, then falls back to DNS seeds.

### OOM crash on 1GB box
```bash
NODE_OPTIONS='--max-old-space-size=768' node server-spv.js
```
Without this, Node.js tries to use more RAM than available during initial header sync.

### Peer bans (Misbehaving 100)
If your bridge got banned by full nodes, it's likely from an old version that used bloom filters. Update to the latest code. Bans expire after 24 hours.

### Mesh not connecting
1. Check `MESH_PEERS` env var — no trailing slashes, correct ports
2. Verify peers are running: `curl http://PEER_IP:8080/health`
3. Check mesh status: `curl http://localhost:8080/api/mesh/status`

### Double-reject crashes
If you see `[FATAL] Unhandled rejection (caught)` in logs, the safety net is working — the process didn't crash. But it means a promise double-reject happened. Check for timeout + close handlers calling `reject()` on the same promise. See [whitepaper Section 8.2](https://indelible.one/federated-spv-relay-mesh.pdf) for the full explanation.

---

## How It Connects to Bitcoin

The bridge speaks the native Bitcoin P2P protocol:

1. **Handshake:** Opens TCP to port 8333 → sends `version` (protocol 70016, services=0, user agent `/Bitcoin SV:1.1.0/`) → receives `verack` → sends `protoconf` (max payload 2MB)
2. **Header sync:** Sends `getheaders` with block locator → receives up to 2,000 headers per batch → stores in LevelDB
3. **Broadcast:** Sends `inv` (announces tx) → peers request via `getdata` → bridge sends `tx`
4. **Fetch:** Sends `getdata` with `MSG_TX` → peer sends `tx` or `notfound`
5. **Keepalive:** Responds to `ping` with `pong`, ignores `authch` (mining auth)

This is Bitcoin as described in the original whitepaper. No APIs, no middlemen, no bloom filters. Direct peer-to-peer.

---

## File Reference

| File | Lines | Purpose |
|------|-------|---------|
| `server-spv.js` | 1,261 | Main server — HTTP/WS API, caching, mesh setup, rate limiting |
| `spv-client.js` | 806 | SPV client — peer management, tx broadcast/lookup, address watching |
| `p2p.js` | 723 | Bitcoin P2P protocol — TCP connections, wire encoding, message parsing |
| `header-sync.js` | 513 | Block header sync — downloads all headers, LevelDB dual-index storage |
| `bridge-mesh.js` | 188 | Bridge mesh — health checks, on-demand tx forwarding, loop prevention |
| `package.json` | 21 | Dependencies: `level`, `ws`, `ssh2` |
| `setup-vps.sh` | 375 | Automated VPS provisioning script |
| `start-mesh.sh` | *(create per server)* | Startup script with MESH_PEERS config |

---

## Contributing

This software is production-hardened — it runs 24/7 across 5 bridges serving the Indelible platform. But there's plenty of room to improve it:

### Things That Need Building

1. **Process supervision** — `systemd` unit file for auto-restart on crash. Right now a crashed bridge stays dead until an operator restarts it manually. Nakamoto said nodes should "rejoin at will" — we should make that automatic.

2. **Degraded health reporting** — When a bridge restarts, it reports healthy immediately, even while headers are still syncing. A `/health` response should include a `degraded: true` flag until the bridge is fully caught up.

3. **UTXO indexing** — The bridge currently falls back to WhatsOnChain for balance and UTXO queries. Building a local UTXO index would eliminate this dependency entirely.

4. **Merkle proof storage** — Store Merkle proofs for all transactions, enabling full SPV verification without any third-party API.

5. **DHT routing** — Replace the static `MESH_PEERS` list with Pastry DHT routing (as described in [Wright's overlay network paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6277825)) to scale beyond fully-connected peers.

6. **Reputation scoring** — The mesh already tracks peer latency and failures. Formalise this into a score that influences routing priority.

### How to Contribute

1. Fork the repo
2. Run a bridge locally (`node server-spv.js`)
3. Make your changes
4. Test with `curl http://localhost:8080/health`
5. Submit a PR

Every bridge you run makes the network stronger. Every bug you fix makes it more resilient. Every feature you add makes Bitcoin more accessible.

---

## Why This Matters

Bitcoin was designed to be used. Not held. Not speculated on. Used.

> *"What is needed is an electronic payment system based on cryptographic proof instead of trust."* — Satoshi Nakamoto, 2008

This bridge is infrastructure for builders. If you're building an application that stores data on BSV, broadcasts transactions, or verifies payments — this is the relay layer that makes it reliable.

The more people who run bridges, the more resilient the mesh becomes. The more resilient the mesh, the more applications can depend on it. The more applications depend on it, the more transactions flow through the network. The more transactions flow, the more miners earn in fees. The more miners earn, the more secure the chain becomes.

That's the virtuous cycle. Every bridge you spin up strengthens it.

---

*Built for [Indelible](https://indelible.one) — permanent memory, secured by proof of work.*

*Whitepaper: [Federated SPV Relay Mesh](https://indelible.one/federated-spv-relay-mesh.pdf)*

#!/bin/bash
# BSV SPV Bridge - VPS Setup Script
# Run this on a fresh Ubuntu 22.04 VPS
# Usage: curl -sL https://raw.githubusercontent.com/YOUR_REPO/setup-vps.sh | bash

set -e

echo "=========================================="
echo "  BSV SPV Bridge - Automated Setup"
echo "=========================================="

# Update system
echo "[1/8] Updating system packages..."
apt update && apt upgrade -y

# Install Node.js 20
echo "[2/8] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Install build essentials (needed for some npm packages)
echo "[3/8] Installing build tools..."
apt install -y build-essential git

# Create app directory
echo "[4/8] Creating application directory..."
mkdir -p /opt/spv-bridge
cd /opt/spv-bridge

# Create package.json
echo "[5/8] Setting up Node.js project..."
cat > package.json << 'PACKAGE_EOF'
{
  "name": "bsv-spv-bridge",
  "version": "1.0.0",
  "description": "SPV WebSocket bridge for BSV applications",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "ws": "^8.16.0",
    "level": "^8.0.1",
    "express": "^4.18.2"
  }
}
PACKAGE_EOF

# Install dependencies
npm install

# Create the SPV bridge server
echo "[6/8] Creating SPV bridge server..."
cat > server.js << 'SERVER_EOF'
/**
 * BSV SPV Bridge Server
 *
 * Provides WebSocket API for BSV blockchain operations.
 * Phase 1: Proxy to WhatsOnChain with caching
 * Phase 2: Direct P2P connection (future)
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const { Level } = require('level');

// Configuration
const PORT = process.env.PORT || 8080;
const WOC_API = 'https://api.whatsonchain.com/v1/bsv/main';
const CACHE_TTL = 30000; // 30 seconds for UTXO/balance cache

// Initialize LevelDB for caching
const db = new Level('./cache-db', { valueEncoding: 'json' });

// In-memory cache for hot data
const memCache = new Map();

// Rate limiting per IP
const rateLimits = new Map();
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW = 60000; // 1 minute

// HTTP server for health checks
const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            connections: wss.clients.size,
            cacheSize: memCache.size
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

console.log(`[SPV Bridge] Starting on port ${PORT}...`);

// Fetch from WhatsOnChain with caching
async function fetchWoC(endpoint, cacheKey, ttl = CACHE_TTL) {
    // Check memory cache first
    const cached = memCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < ttl) {
        return cached.data;
    }

    // Fetch from API
    return new Promise((resolve, reject) => {
        https.get(`${WOC_API}${endpoint}`, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    // Handle both JSON and text responses
                    let parsed;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        parsed = data; // Raw hex or text
                    }

                    // Cache the result
                    memCache.set(cacheKey, { data: parsed, timestamp: Date.now() });

                    // Cleanup old cache entries periodically
                    if (memCache.size > 10000) {
                        const now = Date.now();
                        for (const [key, value] of memCache) {
                            if (now - value.timestamp > ttl * 10) {
                                memCache.delete(key);
                            }
                        }
                    }

                    resolve(parsed);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

// POST to WhatsOnChain (for broadcasting)
async function postWoC(endpoint, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${WOC_API}${endpoint}`);
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    resolve(data);
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// Check rate limit
function checkRateLimit(ip) {
    const now = Date.now();
    const record = rateLimits.get(ip) || { count: 0, windowStart: now };

    if (now - record.windowStart > RATE_WINDOW) {
        record.count = 1;
        record.windowStart = now;
    } else {
        record.count++;
    }

    rateLimits.set(ip, record);
    return record.count <= RATE_LIMIT;
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    console.log(`[SPV Bridge] New connection from ${ip}`);

    ws.on('message', async (message) => {
        try {
            // Rate limiting
            if (!checkRateLimit(ip)) {
                ws.send(JSON.stringify({ error: 'Rate limit exceeded', code: 429 }));
                return;
            }

            const request = JSON.parse(message);
            const { method, id } = request;
            let result;

            switch (method) {
                case 'getBalance': {
                    const { address } = request;
                    if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                        throw new Error('Invalid address');
                    }
                    result = await fetchWoC(`/address/${address}/balance`, `bal:${address}`);
                    break;
                }

                case 'getUtxos': {
                    const { address } = request;
                    if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                        throw new Error('Invalid address');
                    }
                    result = await fetchWoC(`/address/${address}/unspent`, `utxo:${address}`);
                    break;
                }

                case 'getHistory': {
                    const { address } = request;
                    if (!address || !/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) {
                        throw new Error('Invalid address');
                    }
                    result = await fetchWoC(`/address/${address}/history`, `hist:${address}`, 60000);
                    break;
                }

                case 'getTx': {
                    const { txid } = request;
                    if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
                        throw new Error('Invalid txid');
                    }
                    result = await fetchWoC(`/tx/${txid}`, `tx:${txid}`, 300000); // 5 min cache for confirmed tx
                    break;
                }

                case 'getTxHex': {
                    const { txid } = request;
                    if (!txid || !/^[a-fA-F0-9]{64}$/.test(txid)) {
                        throw new Error('Invalid txid');
                    }
                    result = await fetchWoC(`/tx/${txid}/hex`, `txhex:${txid}`, 300000);
                    break;
                }

                case 'broadcast': {
                    const { rawTx } = request;
                    if (!rawTx || !/^[a-fA-F0-9]+$/.test(rawTx)) {
                        throw new Error('Invalid raw transaction');
                    }
                    result = await postWoC('/tx/raw', JSON.stringify({ txhex: rawTx }));

                    // Invalidate UTXO cache for involved addresses (will refresh on next query)
                    // In a full implementation, we'd parse the tx and clear specific caches
                    break;
                }

                case 'ping': {
                    result = { pong: true, timestamp: Date.now() };
                    break;
                }

                default:
                    throw new Error(`Unknown method: ${method}`);
            }

            ws.send(JSON.stringify({ id, result }));

        } catch (error) {
            console.error(`[SPV Bridge] Error:`, error.message);
            ws.send(JSON.stringify({
                id: JSON.parse(message).id,
                error: error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log(`[SPV Bridge] Connection closed from ${ip}`);
    });

    // Send welcome message
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'BSV SPV Bridge v1.0',
        timestamp: Date.now()
    }));
});

// Start server
httpServer.listen(PORT, () => {
    console.log(`[SPV Bridge] WebSocket server running on port ${PORT}`);
    console.log(`[SPV Bridge] Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[SPV Bridge] Shutting down...');
    wss.close();
    httpServer.close();
    db.close();
    process.exit(0);
});
SERVER_EOF

# Create systemd service
echo "[7/8] Creating systemd service..."
cat > /etc/systemd/system/spv-bridge.service << 'SERVICE_EOF'
[Unit]
Description=BSV SPV Bridge Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/spv-bridge
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
SERVICE_EOF

# Enable and start service
systemctl daemon-reload
systemctl enable spv-bridge
systemctl start spv-bridge

# Configure firewall
echo "[8/8] Configuring firewall..."
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (for Let's Encrypt)
ufw allow 443/tcp   # HTTPS
ufw allow 8080/tcp  # WebSocket (temporary, will use nginx proxy)
ufw --force enable

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "SPV Bridge is running on port 8080"
echo ""
echo "Test it with:"
echo "  curl http://localhost:8080/health"
echo ""
echo "Check logs with:"
echo "  journalctl -u spv-bridge -f"
echo ""
echo "Next steps:"
echo "  1. Point your domain to this IP"
echo "  2. Run: apt install certbot nginx"
echo "  3. Configure nginx as reverse proxy with SSL"
echo ""
echo "Your IP address:"
curl -s ifconfig.me
echo ""

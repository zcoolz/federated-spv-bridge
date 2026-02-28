/**
 * SPV Bridge WebSocket Server (Hybrid Mode)
 *
 * Combines:
 * - True SPV for broadcasts (direct P2P to miners)
 * - True SPV for verification (merkle proofs against local headers)
 * - WhatsOnChain proxy with caching for reads (fast, no rate limits)
 *
 * API Methods:
 * SPV (P2P):
 * - broadcast: Broadcast tx directly to miners
 * - verifyTx: Verify tx with merkle proof
 * - getHeaderByHeight/Hash: Get block headers
 * - watchAddress: Watch for new transactions
 *
 * Cached Proxy (WhatsOnChain):
 * - getBalance: Get address balance (30s cache)
 * - getUtxos: Get unspent outputs (30s cache)
 * - getHistory: Get tx history (60s cache)
 * - getTx: Get transaction details (5min cache)
 * - getTxHex: Get raw tx hex (5min cache)
 */

const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { SPVClient } = require('./spv-client');

const PORT = process.env.PORT || 8080;
const WOC_API = 'https://api.whatsonchain.com/v1/bsv/main';

// ============ SECURITY CONFIG ============
// API key for server-to-server calls (Railway → SPV)
const API_KEY = process.env.SPV_API_KEY || 'spv_sk_7f3d9a2b1c8e4f6d5a0b3c2e1f4d8a9b';

// Allowed origins for CORS (browser requests)
const ALLOWED_ORIGINS = [
    'https://bsvbook.club',
    'https://www.bsvbook.club',
    'https://bsv-book-club-production.up.railway.app',
    'https://chainofthought.news',
    'https://www.chainofthought.news',
    'https://bsvbible.club',
    'https://www.bsvbible.club',
    'https://indelible.one',
    'https://www.indelible.one',
    'https://paperhands.fun',
    'https://www.paperhands.fun',
    'http://localhost:3000',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8080'
];

// ============ RATE LIMITING ============
const rateLimits = new Map(); // IP -> { count, resetTime }
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW = 60 * 1000; // 1 minute

function checkRateLimit(ip, hasApiKey) {
    // API key bypasses rate limit
    if (hasApiKey) return { allowed: true };

    const now = Date.now();
    let record = rateLimits.get(ip);

    if (!record || now > record.resetTime) {
        record = { count: 1, resetTime: now + RATE_WINDOW };
        rateLimits.set(ip, record);
        return { allowed: true, remaining: RATE_LIMIT - 1 };
    }

    record.count++;
    if (record.count > RATE_LIMIT) {
        return { allowed: false, remaining: 0, retryAfter: Math.ceil((record.resetTime - now) / 1000) };
    }

    return { allowed: true, remaining: RATE_LIMIT - record.count };
}

// Clean up old rate limit entries every minute
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of rateLimits) {
        if (now > record.resetTime) rateLimits.delete(ip);
    }
}, 60 * 1000);

// Check if origin is allowed
function isOriginAllowed(origin) {
    if (!origin) return false;
    return ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.startsWith(allowed));
}

// Get client IP from request
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           'unknown';
}

// ============ CACHING LAYER ============
const cache = new Map();
const CACHE_TTL = {
    balance: 30 * 1000,      // 30 seconds
    utxos: 30 * 1000,        // 30 seconds
    history: 60 * 1000,      // 60 seconds
    tx: 5 * 60 * 1000,       // 5 minutes (confirmed txs don't change)
    txHex: 5 * 60 * 1000     // 5 minutes
};

function getCached(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
        cache.delete(key);
        return null;
    }
    return entry.data;
}

function setCache(key, data, ttl) {
    cache.set(key, { data, expires: Date.now() + ttl });
}

// Clean expired cache entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of cache) {
        if (now > entry.expires) cache.delete(key);
    }
}, 5 * 60 * 1000);

// ============ TX PARSING HELPERS ============
// No storage needed - we parse sender addresses directly from blockchain data

// Helper: Convert hash160 to BSV address
function hash160ToAddress(hash160Hex) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    // Add version byte (0x00 for mainnet P2PKH)
    const versionedPayload = Buffer.concat([Buffer.from([0x00]), Buffer.from(hash160Hex, 'hex')]);

    // Double SHA256 for checksum
    const hash1 = crypto.createHash('sha256').update(versionedPayload).digest();
    const hash2 = crypto.createHash('sha256').update(hash1).digest();
    const checksum = hash2.slice(0, 4);

    // Combine and base58 encode
    const fullPayload = Buffer.concat([versionedPayload, checksum]);

    // Base58 encode
    let num = BigInt('0x' + fullPayload.toString('hex'));
    let encoded = '';
    while (num > 0n) {
        encoded = ALPHABET[Number(num % 58n)] + encoded;
        num = num / 58n;
    }

    // Add leading 1s for leading zeros
    for (let i = 0; i < fullPayload.length && fullPayload[i] === 0; i++) {
        encoded = '1' + encoded;
    }

    return encoded;
}

// Helper: Extract address from P2PKH output script
function extractAddressFromScript(scriptHex) {
    // P2PKH: 76a914{20-byte-hash160}88ac
    if (scriptHex.length === 50 && scriptHex.startsWith('76a914') && scriptHex.endsWith('88ac')) {
        const hash160 = scriptHex.slice(6, 46);
        return hash160ToAddress(hash160);
    }
    return null;
}

// Helper: Extract sender address from input scriptSig (pubkey -> address)
function extractSenderFromInput(scriptSigHex) {
    // In a signed P2PKH input, format is: <sig> <pubkey>
    // Pubkey is last 33 bytes (compressed) or 65 bytes (uncompressed)
    // We need to hash the pubkey to get the address

    if (!scriptSigHex || scriptSigHex.length < 70) return null;

    try {
        const script = Buffer.from(scriptSigHex, 'hex');
        let offset = 0;

        // Skip signature (first push)
        const sigLen = script[offset];
        offset += 1 + sigLen;

        // Get pubkey (second push)
        if (offset >= script.length) return null;
        const pubkeyLen = script[offset];
        offset += 1;

        if (pubkeyLen !== 33 && pubkeyLen !== 65) return null;
        if (offset + pubkeyLen > script.length) return null;

        const pubkey = script.slice(offset, offset + pubkeyLen);

        // Hash pubkey: SHA256 then RIPEMD160
        const sha256Hash = crypto.createHash('sha256').update(pubkey).digest();
        const hash160 = crypto.createHash('ripemd160').update(sha256Hash).digest().toString('hex');

        return hash160ToAddress(hash160);
    } catch (e) {
        return null;
    }
}


// ============ WHATSONCHAIN PROXY ============
async function wocFetch(endpoint) {
    return new Promise((resolve, reject) => {
        const url = `${WOC_API}${endpoint}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        // Try JSON parse, fall back to text
                        resolve(data.startsWith('{') || data.startsWith('[') ? JSON.parse(data) : data);
                    } catch (e) {
                        resolve(data);
                    }
                } else {
                    reject(new Error(`WoC API error ${res.statusCode}: ${data}`));
                }
            });
        }).on('error', reject);
    });
}

async function getBalance(address) {
    const cacheKey = `balance:${address}`;
    let result = getCached(cacheKey);
    if (result) return result;

    result = await wocFetch(`/address/${address}/balance`);
    setCache(cacheKey, result, CACHE_TTL.balance);
    return result;
}

async function getUtxos(address) {
    const cacheKey = `utxos:${address}`;
    let result = getCached(cacheKey);
    if (result) return result;

    result = await wocFetch(`/address/${address}/unspent`);
    setCache(cacheKey, result, CACHE_TTL.utxos);
    return result;
}

async function getHistory(address) {
    const cacheKey = `history:${address}`;
    let result = getCached(cacheKey);
    if (result) return result;

    result = await wocFetch(`/address/${address}/history`);
    setCache(cacheKey, result, CACHE_TTL.history);
    return result;
}

async function getTx(txid) {
    const cacheKey = `tx:${txid}`;
    let result = getCached(cacheKey);
    if (result) return result;

    result = await wocFetch(`/tx/${txid}`);
    setCache(cacheKey, result, CACHE_TTL.tx);
    return result;
}

async function getTxHex(txid) {
    const cacheKey = `txHex:${txid}`;
    let result = getCached(cacheKey);
    if (result) return result;

    result = await wocFetch(`/tx/${txid}/hex`);
    setCache(cacheKey, result, CACHE_TTL.txHex);
    return result;
}

// Enhanced getTx that parses raw tx to include sender addresses (from blockchain)
async function getTxEnhanced(txid) {
    const cacheKey = `txEnhanced:${txid}`;
    let result = getCached(cacheKey);
    if (result) return result;

    // Fetch both tx details and raw hex from WoC (fallback)
    const [txData, rawHex] = await Promise.all([
        wocFetch(`/tx/${txid}`),
        wocFetch(`/tx/${txid}/hex`)
    ]);

    console.log(`[getTxEnhanced] txid=${txid}, hasRawHex=${!!rawHex}, rawHexLen=${rawHex?.length}, vinCount=${txData?.vin?.length}`);

    // Parse raw tx to extract sender addresses from scriptSig
    if (rawHex && txData && txData.vin) {
        try {
            const inputs = parseInputsFromRawTx(rawHex);
            console.log(`[getTxEnhanced] Parsed ${inputs.length} inputs`);
            for (let i = 0; i < txData.vin.length && i < inputs.length; i++) {
                const senderAddr = extractSenderFromInput(inputs[i].script);
                console.log(`[getTxEnhanced] Input ${i}: script=${inputs[i].script?.slice(0,40)}..., sender=${senderAddr}`);
                if (senderAddr) {
                    if (!txData.vin[i].e) txData.vin[i].e = {};
                    txData.vin[i].e.a = senderAddr;
                }
            }
        } catch (e) {
            console.error('[getTxEnhanced] Failed to parse inputs:', e.message);
        }
    }

    result = txData;
    setCache(cacheKey, result, CACHE_TTL.tx);
    return result;
}

// Parse just the inputs from raw tx hex
function parseInputsFromRawTx(rawHex) {
    const buf = Buffer.from(rawHex, 'hex');
    let offset = 4; // Skip version

    // Input count (varint)
    let inCount = buf[offset];
    offset += 1;
    if (inCount === 0xfd) { inCount = buf.readUInt16LE(offset); offset += 2; }
    else if (inCount === 0xfe) { inCount = buf.readUInt32LE(offset); offset += 4; }

    const inputs = [];
    for (let i = 0; i < inCount; i++) {
        offset += 32; // prevTxid
        offset += 4;  // prevVout

        let scriptLen = buf[offset];
        offset += 1;
        if (scriptLen === 0xfd) { scriptLen = buf.readUInt16LE(offset); offset += 2; }
        else if (scriptLen === 0xfe) { scriptLen = buf.readUInt32LE(offset); offset += 4; }

        const script = buf.slice(offset, offset + scriptLen).toString('hex');
        offset += scriptLen;
        offset += 4; // sequence

        inputs.push({ script });
    }

    return inputs;
}

// Format SPV tx data to match WoC format with sender addresses
function formatTxWithSenders(decoded, txid, txData) {
    const result = {
        txid,
        blockheight: txData.blockHeight,
        blockhash: txData.blockHash,
        time: txData.time || Math.floor(Date.now() / 1000),
        vin: decoded.inputs.map((inp, i) => ({
            txid: inp.prevTxid,
            vout: inp.prevVout,
            scriptSig: { hex: inp.script },
            sequence: inp.sequence,
            e: { a: extractSenderFromInput(inp.script) }
        })),
        vout: decoded.outputs.map((out, i) => ({
            value: out.satoshis / 100000000,
            n: i,
            scriptPubKey: {
                hex: out.script,
                addresses: [extractAddressFromScript(out.script)].filter(Boolean)
            }
        }))
    };
    return result;
}

// Create HTTP server for health checks and REST API
const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const origin = req.headers.origin;
    const clientIP = getClientIP(req);
    const apiKey = req.headers['x-api-key'];
    const hasValidApiKey = apiKey === API_KEY;

    // CORS - only allow whitelisted origins (or valid API key)
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (hasValidApiKey) {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    // If origin not allowed and no API key, no CORS header = browser blocks it

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Rate limiting (skip for health check)
    if (pathname !== '/health') {
        const rateCheck = checkRateLimit(clientIP, hasValidApiKey);
        if (!rateCheck.allowed) {
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': rateCheck.retryAfter
            });
            res.end(JSON.stringify({
                error: 'Rate limit exceeded',
                retryAfter: rateCheck.retryAfter
            }));
            return;
        }
        if (rateCheck.remaining !== undefined) {
            res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
        }
    }

    // Health check
    if (pathname === '/health') {
        const status = spv ? spv.getStatus() : { initialized: false };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            mode: 'hybrid-spv',
            ...status,
            cacheSize: cache.size,
            uptime: process.uptime()
        }));
        return;
    }

    // REST API: /api/address/:address/balance
    const balanceMatch = pathname.match(/^\/api\/address\/([^/]+)\/balance$/);
    if (balanceMatch) {
        try {
            const result = await getBalance(balanceMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // REST API: /api/address/:address/unspent
    const utxoMatch = pathname.match(/^\/api\/address\/([^/]+)\/unspent$/);
    if (utxoMatch) {
        try {
            const result = await getUtxos(utxoMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // REST API: /api/address/:address/history
    const historyMatch = pathname.match(/^\/api\/address\/([^/]+)\/history$/);
    if (historyMatch) {
        try {
            const result = await getHistory(historyMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }


    // REST API: /api/tx/:txid
    const txMatch = pathname.match(/^\/api\/tx\/([a-f0-9]+)$/);
    if (txMatch) {
        try {
            const result = await getTx(txMatch[1]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // REST API: /api/tx/:txid/hex
    const txHexMatch = pathname.match(/^\/api\/tx\/([a-f0-9]+)\/hex$/);
    if (txHexMatch) {
        try {
            const result = await getTxHex(txHexMatch[1]);
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(result);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // 404 for unknown routes
    res.writeHead(404);
    res.end('Not found');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

// SPV Client instance
let spv = null;

// Track connected clients and their watched addresses
const clients = new Map(); // ws -> { id, watchedAddresses: Set }

// Generate client ID
let clientIdCounter = 0;
function generateClientId() {
    return `client_${++clientIdCounter}`;
}

// Send JSON message to client
function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Broadcast to all clients watching a specific address
function broadcastToWatchers(address, message) {
    for (const [ws, client] of clients) {
        if (client.watchedAddresses.has(address) || client.watchedAddresses.has('*')) {
            send(ws, message);
        }
    }
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = generateClientId();
    const clientIp = req.socket.remoteAddress;

    clients.set(ws, {
        id: clientId,
        ip: clientIp,
        watchedAddresses: new Set(),
        connectedAt: Date.now()
    });

    console.log(`[WS] Client ${clientId} connected from ${clientIp}`);

    // Send welcome message with status
    send(ws, {
        type: 'connected',
        clientId,
        status: spv ? spv.getStatus() : { initialized: false }
    });

    // Handle messages
    ws.on('message', async (data) => {
        let message;
        try {
            message = JSON.parse(data);
        } catch (e) {
            send(ws, { type: 'error', error: 'Invalid JSON' });
            return;
        }

        const { method, params, id } = message;

        try {
            const result = await handleMethod(ws, method, params || {});
            send(ws, { type: 'result', id, method, result });
        } catch (err) {
            send(ws, { type: 'error', id, method, error: err.message });
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        const client = clients.get(ws);
        console.log(`[WS] Client ${client?.id} disconnected`);
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error(`[WS] Client error:`, err.message);
    });
});

// Handle API methods
async function handleMethod(ws, method, params) {
    // Cached proxy methods work even if SPV not fully initialized
    const proxyMethods = ['getBalance', 'getUtxos', 'getHistory', 'getTx', 'getTxHex'];

    if (!spv || !spv.initialized) {
        if (!proxyMethods.includes(method) && method !== 'getStatus' && method !== 'ping') {
            throw new Error('SPV client not initialized');
        }
    }

    switch (method) {
        // ============ CACHED PROXY METHODS (WhatsOnChain) ============
        case 'getBalance': {
            const { address } = params;
            if (!address) throw new Error('Address required');
            return await getBalance(address);
        }

        case 'getUtxos': {
            const { address } = params;
            if (!address) throw new Error('Address required');
            return await getUtxos(address);
        }

        case 'getHistory': {
            const { address } = params;
            if (!address) throw new Error('Address required');

            // If SPV is watching this address, use P2P data (blockchain direct)
            if (spv && spv.initialized && spv.watchedAddresses.has(address)) {
                const txs = await spv.getTransactionsForAddress(address);
                // Format to match WoC format
                return txs.map(tx => ({
                    tx_hash: tx.txid,
                    height: tx.blockHeight || 0
                }));
            }

            // Fallback to WoC
            return await getHistory(address);
        }

        case 'getTx': {
            const { txid } = params;
            if (!txid) throw new Error('Txid required');

            // Try to get from SPV first (if we have it from watching)
            if (spv && spv.initialized) {
                try {
                    const txData = await spv.txDb.get(`tx:${txid}`);
                    if (txData && txData.raw) {
                        // Parse raw tx to get full details with sender addresses
                        const decoded = spv.decodeTx(txData.raw);
                        return formatTxWithSenders(decoded, txid, txData);
                    }
                } catch (e) {
                    // Not in SPV storage, fall through to WoC
                }
            }

            // Fallback to WoC + enhance with sender parsing
            return await getTxEnhanced(txid);
        }

        case 'getTxHex': {
            const { txid } = params;
            if (!txid) throw new Error('Txid required');
            return await getTxHex(txid);
        }

        // ============ SPV METHODS (P2P) ============
        case 'ping':
            return { pong: true, timestamp: Date.now() };

        case 'getStatus':
            return spv ? spv.getStatus() : { initialized: false };

        case 'watchAddress': {
            const { address } = params;
            if (!address) throw new Error('Address required');

            // Add to client's watched list
            const client = clients.get(ws);
            client.watchedAddresses.add(address);

            // Add to SPV client
            await spv.watchAddress(address);

            return { watching: true, address };
        }

        case 'unwatchAddress': {
            const { address } = params;
            if (!address) throw new Error('Address required');

            const client = clients.get(ws);
            client.watchedAddresses.delete(address);

            // Note: We don't remove from SPV if other clients are watching
            // This would require reference counting

            return { watching: false, address };
        }

        case 'broadcast': {
            const { rawTx, fromAddress } = params;
            if (!rawTx) throw new Error('Raw transaction hex required');

            const txid = await spv.broadcastTx(rawTx);

            // Parse tx to extract recipient info for tracking
            try {
                const decoded = spv.decodeTx(rawTx);
                const toAddresses = [];
                const amounts = [];

                // Get sender from first input if not provided
                let sender = fromAddress;
                if (!sender && decoded.inputs.length > 0) {
                    sender = extractSenderFromInput(decoded.inputs[0].script);
                }

                // Extract recipients from outputs (skip change back to sender)
                for (const out of decoded.outputs) {
                    const addr = extractAddressFromScript(out.script);
                    if (addr && addr !== sender) {
                        toAddresses.push(addr);
                        amounts.push(out.satoshis);
                    }
                }

                // Log for debugging
                if (sender && toAddresses.length > 0) {
                    console.log(`[Broadcast] ${sender} -> ${toAddresses.join(', ')} (${amounts.join(', ')} sats) txid: ${txid}`);
                }
            } catch (e) {
                console.error('[TX Log] Failed to parse tx for logging:', e.message);
            }

            return { txid, broadcast: true };
        }

        case 'getHeaderByHeight': {
            const { height } = params;
            if (height === undefined) throw new Error('Height required');

            const header = await spv.headerSync.getHeaderByHeight(height);
            if (!header) throw new Error('Header not found');

            return header;
        }

        case 'getHeaderByHash': {
            const { hash } = params;
            if (!hash) throw new Error('Hash required');

            const header = await spv.headerSync.getHeaderByHash(hash);
            if (!header) throw new Error('Header not found');

            return header;
        }

        case 'getTransactions': {
            const { address } = params;
            if (!address) throw new Error('Address required');

            const txs = await spv.getTransactionsForAddress(address);
            return { address, transactions: txs };
        }

        case 'verifyTx': {
            // Verify a tx is in a block using stored merkle proof
            const { txid } = params;
            if (!txid) throw new Error('Txid required');

            try {
                const txData = await spv.txDb.get(`tx:${txid}`);
                const confirmations = spv.headerSync.syncedHeight - txData.blockHeight + 1;

                return {
                    verified: true,
                    txid,
                    blockHash: txData.blockHash,
                    blockHeight: txData.blockHeight,
                    confirmations,
                    hasMerkleProof: !!txData.merkleProof
                };
            } catch (e) {
                // Check pending
                if (spv.pendingTxs.has(txid)) {
                    return {
                        verified: false,
                        txid,
                        status: 'pending',
                        confirmations: 0
                    };
                }
                throw new Error('Transaction not found');
            }
        }

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

// Set up SPV event forwarding
function setupSPVEvents() {
    // Forward new transactions to watchers
    spv.on('tx', (tx) => {
        // Decode and check addresses
        const decoded = spv.decodeTx(tx.raw);

        // Notify all watching clients
        for (const [ws, client] of clients) {
            // Check if any watched address is involved
            for (const addr of client.watchedAddresses) {
                if (spv.txInvolvesAddress(decoded, addr)) {
                    send(ws, {
                        type: 'tx',
                        txid: tx.txid,
                        raw: tx.raw,
                        confirmed: false,
                        address: addr
                    });
                    break;
                }
            }
        }
    });

    // Forward confirmed transactions
    spv.on('tx:confirmed', (data) => {
        // Broadcast to all clients (they can filter by txid)
        for (const [ws] of clients) {
            send(ws, {
                type: 'tx:confirmed',
                ...data
            });
        }
    });

    // Forward new blocks
    spv.on('newblock', (blocks) => {
        for (const [ws] of clients) {
            send(ws, {
                type: 'newblock',
                blocks,
                height: spv.headerSync.syncedHeight
            });
        }
    });
}

// Main startup
async function main() {
    console.log('='.repeat(50));
    console.log('  BSV SPV Bridge - Full SPV Mode');
    console.log('  No WhatsOnChain Required');
    console.log('='.repeat(50));

    // Initialize SPV client
    console.log('\n[Server] Initializing SPV client...');
    spv = new SPVClient();

    try {
        await spv.init();

        const headerHeight = spv.headerSync.syncedHeight;
        console.log(`[Server] Header height: ${headerHeight}`);

        // Start HTTP/WebSocket server first (so it's available even if P2P fails)
        httpServer.listen(PORT, '0.0.0.0', () => {
            console.log(`\n[Server] Listening on port ${PORT}`);
            console.log(`[Server] Health check: http://localhost:${PORT}/health`);
            console.log(`[Server] WebSocket: ws://localhost:${PORT}`);
        });

        // Try to connect to P2P network in background
        connectWithRetry();

    } catch (err) {
        console.error('[Server] Failed to start:', err);
        process.exit(1);
    }
}

// Connect to P2P with retry logic
async function connectWithRetry(maxRetries = 5, delayMs = 10000) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`\n[Server] Connecting to P2P network (attempt ${attempt}/${maxRetries})...`);

            // If headers not synced, sync them
            if (spv.headerSync.syncedHeight === 0) {
                console.log('[Server] Syncing headers (first run)...');
                await spv.headerSync.sync();
            }

            // Connect to peers
            await spv.connect();

            // Set up event forwarding
            setupSPVEvents();

            // Rebuild bloom filter if we have watched addresses
            if (spv.watchedAddresses.size > 0) {
                spv.rebuildBloomFilter();
                for (const peer of spv.peers.filter(p => p.connected)) {
                    peer.p2p.filterload(spv.bloomFilter);
                }
            }

            console.log('[Server] P2P network connected!');
            return;

        } catch (err) {
            console.log(`[Server] P2P connection failed: ${err.message}`);

            if (attempt < maxRetries) {
                console.log(`[Server] Retrying in ${delayMs/1000} seconds...`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }

    console.log('[Server] WARNING: Could not connect to P2P network.');
    console.log('[Server] Server is running but real-time updates will not work.');
    console.log('[Server] Header verification and stored data are still available.');
}

// Handle shutdown
process.on('SIGINT', async () => {
    console.log('\n[Server] Shutting down...');
    if (spv) {
        await spv.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n[Server] Received SIGTERM, shutting down...');
    if (spv) {
        await spv.stop();
    }
    process.exit(0);
});

main();

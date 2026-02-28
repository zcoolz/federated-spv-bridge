/**
 * BSV P2P Protocol Handler
 *
 * Connects directly to BSV network nodes and speaks the Bitcoin protocol.
 * This is the real deal - no APIs, just TCP sockets and binary messages.
 */

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

// BSV Mainnet magic bytes
const MAGIC = Buffer.from([0xe3, 0xe1, 0xf3, 0xe8]);

// Protocol version (70015 is common for BSV)
const PROTOCOL_VERSION = 70015;

// Services we offer (NODE_NONE - we're just an SPV client)
const SERVICES = BigInt(0);

// User agent
const USER_AGENT = '/BSV-SPV-Bridge:0.1.0/';

// BSV DNS seeds for finding peers
const DNS_SEEDS = [
    'seed.bitcoinsv.io',
    'seed.cascharia.com',
    'seed.satoshisvision.network'
];

// Known reliable BSV nodes (fallback)
const KNOWN_NODES = [
    { host: '95.217.121.174', port: 8333 },  // Example BSV node
    { host: '159.69.191.137', port: 8333 },
];

class BSVP2P extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.connected = false;
        this.handshakeComplete = false;
        this.buffer = Buffer.alloc(0);
        this.peerVersion = null;
        this.peerServices = null;
        this.peerUserAgent = null;
        this.bestHeight = 0;
    }

    /**
     * Connect to a BSV peer
     */
    async connect(host, port = 8333) {
        return new Promise((resolve, reject) => {
            console.log(`[P2P] Connecting to ${host}:${port}...`);

            this.socket = net.createConnection({ host, port }, () => {
                console.log(`[P2P] TCP connected to ${host}:${port}`);
                this.connected = true;

                // Send version message to initiate handshake
                this.sendVersion();
            });

            this.socket.on('data', (data) => this.handleData(data));

            this.socket.on('error', (err) => {
                console.error(`[P2P] Socket error:`, err.message);
                this.connected = false;
                reject(err);
            });

            this.socket.on('close', () => {
                console.log('[P2P] Connection closed');
                this.connected = false;
                this.handshakeComplete = false;
                this.emit('disconnect');
            });

            // Resolve when handshake is complete
            this.once('handshake', () => resolve());

            // Timeout after 10 seconds
            setTimeout(() => {
                if (!this.handshakeComplete) {
                    reject(new Error('Handshake timeout'));
                    this.disconnect();
                }
            }, 10000);
        });
    }

    /**
     * Disconnect from peer
     */
    disconnect() {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.connected = false;
        this.handshakeComplete = false;
    }

    /**
     * Handle incoming data - accumulate and parse messages
     */
    handleData(data) {
        // Accumulate data in buffer
        this.buffer = Buffer.concat([this.buffer, data]);

        // Try to parse complete messages
        while (this.buffer.length >= 24) {
            // Check for magic bytes
            if (!this.buffer.slice(0, 4).equals(MAGIC)) {
                // Scan for magic bytes
                const magicIndex = this.buffer.indexOf(MAGIC);
                if (magicIndex === -1) {
                    this.buffer = Buffer.alloc(0);
                    return;
                }
                this.buffer = this.buffer.slice(magicIndex);
                continue;
            }

            // Parse header
            const command = this.buffer.slice(4, 16).toString('ascii').replace(/\0/g, '');
            const payloadLength = this.buffer.readUInt32LE(16);
            const checksum = this.buffer.slice(20, 24);

            // Check if we have the full message
            if (this.buffer.length < 24 + payloadLength) {
                return; // Wait for more data
            }

            // Extract payload
            const payload = this.buffer.slice(24, 24 + payloadLength);

            // Verify checksum
            const hash = doubleSha256(payload);
            if (!hash.slice(0, 4).equals(checksum)) {
                console.error(`[P2P] Checksum mismatch for ${command}`);
                this.buffer = this.buffer.slice(24 + payloadLength);
                continue;
            }

            // Remove processed message from buffer
            this.buffer = this.buffer.slice(24 + payloadLength);

            // Handle the message
            this.handleMessage(command, payload);
        }
    }

    /**
     * Handle a parsed message
     */
    handleMessage(command, payload) {
        // console.log(`[P2P] Received: ${command} (${payload.length} bytes)`);

        switch (command) {
            case 'version':
                this.handleVersion(payload);
                break;
            case 'verack':
                this.handleVerack();
                break;
            case 'ping':
                this.handlePing(payload);
                break;
            case 'pong':
                this.emit('pong');
                break;
            case 'headers':
                this.handleHeaders(payload);
                break;
            case 'inv':
                this.handleInv(payload);
                break;
            case 'tx':
                this.handleTx(payload);
                break;
            case 'merkleblock':
                this.handleMerkleBlock(payload);
                break;
            case 'reject':
                this.handleReject(payload);
                break;
            case 'addr':
                // Ignore address announcements for now
                break;
            case 'sendheaders':
                // Peer wants headers announcements - we'll send them
                break;
            case 'sendcmpct':
                // Compact blocks - ignore for SPV
                break;
            case 'feefilter':
                // Fee filter - ignore for SPV
                break;
            default:
                console.log(`[P2P] Unhandled message: ${command}`);
        }
    }

    /**
     * Handle version message from peer
     */
    handleVersion(payload) {
        let offset = 0;

        this.peerVersion = payload.readInt32LE(offset); offset += 4;
        this.peerServices = payload.readBigUInt64LE(offset); offset += 8;
        const timestamp = payload.readBigInt64LE(offset); offset += 8;

        // Skip addr_recv (26 bytes) and addr_from (26 bytes)
        offset += 26 + 26;

        // Skip nonce (8 bytes)
        offset += 8;

        // Read user agent
        const uaLength = readVarInt(payload, offset);
        offset += uaLength.size;
        this.peerUserAgent = payload.slice(offset, offset + uaLength.value).toString('utf8');
        offset += uaLength.value;

        // Read start height
        this.bestHeight = payload.readInt32LE(offset);

        console.log(`[P2P] Peer version: ${this.peerVersion}, height: ${this.bestHeight}, ua: ${this.peerUserAgent}`);

        // Send verack to acknowledge
        this.sendMessage('verack', Buffer.alloc(0));
    }

    /**
     * Handle verack message - handshake complete!
     */
    handleVerack() {
        console.log('[P2P] Handshake complete!');
        this.handshakeComplete = true;
        this.emit('handshake');
    }

    /**
     * Handle ping - respond with pong
     */
    handlePing(payload) {
        this.sendMessage('pong', payload);
    }

    /**
     * Handle headers message
     */
    handleHeaders(payload) {
        const headers = [];
        let offset = 0;

        const count = readVarInt(payload, offset);
        offset += count.size;

        console.log(`[P2P] Received ${count.value} headers`);

        for (let i = 0; i < count.value; i++) {
            // IMPORTANT: Copy header bytes before any operations that mutate
            // (slice returns a view, reverse mutates in place!)
            const headerBytes = Buffer.from(payload.slice(offset, offset + 80));

            const header = {
                version: headerBytes.readInt32LE(0),
                prevBlock: Buffer.from(headerBytes.slice(4, 36)).reverse().toString('hex'),
                merkleRoot: Buffer.from(headerBytes.slice(36, 68)).reverse().toString('hex'),
                timestamp: headerBytes.readUInt32LE(68),
                bits: headerBytes.readUInt32LE(72),
                nonce: headerBytes.readUInt32LE(76),
                hash: doubleSha256(headerBytes).reverse().toString('hex')
            };
            headers.push(header);
            offset += 80;

            // Skip tx count (always 0 in headers message)
            const txCount = readVarInt(payload, offset);
            offset += txCount.size;
        }

        this.emit('headers', headers);
    }

    /**
     * Handle inv (inventory) message
     */
    handleInv(payload) {
        let offset = 0;
        const count = readVarInt(payload, offset);
        offset += count.size;

        const inventory = [];
        for (let i = 0; i < count.value; i++) {
            const type = payload.readUInt32LE(offset);
            const hash = payload.slice(offset + 4, offset + 36).reverse().toString('hex');
            inventory.push({ type, hash });
            offset += 36;
        }

        this.emit('inv', inventory);
    }

    /**
     * Handle tx message
     */
    handleTx(payload) {
        const txid = doubleSha256(payload).reverse().toString('hex');
        this.emit('tx', { txid, raw: payload.toString('hex') });
    }

    /**
     * Handle merkleblock message
     */
    handleMerkleBlock(payload) {
        let offset = 0;

        const header = {
            version: payload.readInt32LE(offset),
            prevBlock: payload.slice(offset + 4, offset + 36).reverse().toString('hex'),
            merkleRoot: payload.slice(offset + 36, offset + 68).reverse().toString('hex'),
            timestamp: payload.readUInt32LE(offset + 68),
            bits: payload.readUInt32LE(offset + 72),
            nonce: payload.readUInt32LE(offset + 76),
            hash: doubleSha256(payload.slice(offset, offset + 80)).reverse().toString('hex')
        };
        offset += 80;

        const totalTxs = payload.readUInt32LE(offset);
        offset += 4;

        const hashCount = readVarInt(payload, offset);
        offset += hashCount.size;

        const hashes = [];
        for (let i = 0; i < hashCount.value; i++) {
            hashes.push(payload.slice(offset, offset + 32).reverse().toString('hex'));
            offset += 32;
        }

        const flagBytes = readVarInt(payload, offset);
        offset += flagBytes.size;
        const flags = payload.slice(offset, offset + flagBytes.value);

        this.emit('merkleblock', { header, totalTxs, hashes, flags });
    }

    /**
     * Handle reject message
     */
    handleReject(payload) {
        let offset = 0;
        const msgLength = readVarInt(payload, offset);
        offset += msgLength.size;
        const message = payload.slice(offset, offset + msgLength.value).toString('ascii');
        offset += msgLength.value;
        const code = payload.readUInt8(offset);
        offset += 1;
        const reasonLength = readVarInt(payload, offset);
        offset += reasonLength.size;
        const reason = payload.slice(offset, offset + reasonLength.value).toString('utf8');

        console.error(`[P2P] Reject: ${message} (code ${code}): ${reason}`);
        this.emit('reject', { message, code, reason });
    }

    /**
     * Send version message
     */
    sendVersion() {
        const payload = Buffer.alloc(86 + USER_AGENT.length);
        let offset = 0;

        // Protocol version
        payload.writeInt32LE(PROTOCOL_VERSION, offset); offset += 4;

        // Services (NODE_NONE for SPV)
        payload.writeBigUInt64LE(SERVICES, offset); offset += 8;

        // Timestamp
        payload.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), offset); offset += 8;

        // addr_recv (26 bytes - services + ip + port)
        payload.writeBigUInt64LE(BigInt(1), offset); offset += 8; // Services
        // IPv4-mapped IPv6 address (::ffff:127.0.0.1)
        payload.fill(0, offset, offset + 10); offset += 10;
        payload.writeUInt16BE(0xffff, offset); offset += 2;
        payload.writeUInt8(127, offset); offset += 1;
        payload.writeUInt8(0, offset); offset += 1;
        payload.writeUInt8(0, offset); offset += 1;
        payload.writeUInt8(1, offset); offset += 1;
        payload.writeUInt16BE(8333, offset); offset += 2;

        // addr_from (26 bytes)
        payload.writeBigUInt64LE(SERVICES, offset); offset += 8;
        payload.fill(0, offset, offset + 10); offset += 10;
        payload.writeUInt16BE(0xffff, offset); offset += 2;
        payload.writeUInt8(127, offset); offset += 1;
        payload.writeUInt8(0, offset); offset += 1;
        payload.writeUInt8(0, offset); offset += 1;
        payload.writeUInt8(1, offset); offset += 1;
        payload.writeUInt16BE(8333, offset); offset += 2;

        // Nonce (random)
        crypto.randomFillSync(payload, offset, 8); offset += 8;

        // User agent
        payload.writeUInt8(USER_AGENT.length, offset); offset += 1;
        payload.write(USER_AGENT, offset); offset += USER_AGENT.length;

        // Start height (0 - we don't have any blocks yet)
        payload.writeInt32LE(0, offset); offset += 4;

        // Relay (false for SPV - we use bloom filters)
        payload.writeUInt8(0, offset); offset += 1;

        this.sendMessage('version', payload.slice(0, offset));
    }

    /**
     * Request headers starting from a hash
     * @param {string[]} locatorHashes - Block hashes (newest first)
     */
    getHeaders(locatorHashes = []) {
        // Calculate buffer size
        const hashCount = locatorHashes.length || 1;
        const payload = Buffer.alloc(4 + 9 + hashCount * 32 + 32);
        let offset = 0;

        // Protocol version
        payload.writeUInt32LE(PROTOCOL_VERSION, offset); offset += 4;

        // Hash count (varint)
        offset += writeVarInt(payload, offset, hashCount);

        // Locator hashes
        if (locatorHashes.length === 0) {
            // Start from genesis - use all zeros
            Buffer.alloc(32, 0).copy(payload, offset); offset += 32;
        } else {
            for (const hash of locatorHashes) {
                Buffer.from(hash, 'hex').reverse().copy(payload, offset);
                offset += 32;
            }
        }

        // Stop hash (32 zeros = give me up to 2000 headers)
        Buffer.alloc(32, 0).copy(payload, offset); offset += 32;

        this.sendMessage('getheaders', payload.slice(0, offset));
    }

    /**
     * Request specific data (tx, block, etc)
     */
    getData(inventory) {
        const payload = Buffer.alloc(9 + inventory.length * 36);
        let offset = 0;

        // Write varint count
        offset += writeVarInt(payload, offset, inventory.length);

        for (const item of inventory) {
            payload.writeUInt32LE(item.type, offset); offset += 4;
            Buffer.from(item.hash, 'hex').reverse().copy(payload, offset); offset += 32;
        }

        this.sendMessage('getdata', payload.slice(0, offset));
    }

    /**
     * Broadcast a transaction
     */
    broadcastTx(rawTxHex) {
        const txBuffer = Buffer.from(rawTxHex, 'hex');
        this.sendMessage('tx', txBuffer);
        const txid = doubleSha256(txBuffer).reverse().toString('hex');
        console.log(`[P2P] Broadcast tx: ${txid}`);
        return txid;
    }

    /**
     * Load a bloom filter (BIP37)
     * After loading, peer will send merkleblock + tx messages for matching txs
     * @param {BloomFilter} bloomFilter - The bloom filter to load
     */
    filterload(bloomFilter) {
        const payload = bloomFilter.serialize();
        this.sendMessage('filterload', payload);
        console.log(`[P2P] Loaded bloom filter (${bloomFilter.vData.length} bytes)`);
    }

    /**
     * Add data to the loaded bloom filter
     * @param {Buffer} data - Data to add
     */
    filteradd(data) {
        if (typeof data === 'string') {
            data = Buffer.from(data, 'hex');
        }
        const payload = Buffer.alloc(9 + data.length);
        let offset = 0;
        offset += writeVarInt(payload, offset, data.length);
        data.copy(payload, offset);
        this.sendMessage('filteradd', payload.slice(0, offset + data.length));
    }

    /**
     * Clear the bloom filter
     */
    filterclear() {
        this.sendMessage('filterclear', Buffer.alloc(0));
        console.log('[P2P] Cleared bloom filter');
    }

    /**
     * Request mempool contents (will send inv for matching txs if filter loaded)
     */
    mempool() {
        this.sendMessage('mempool', Buffer.alloc(0));
        console.log('[P2P] Requested mempool');
    }

    /**
     * Request a merkleblock for a specific block
     * @param {string} blockHash - Block hash to request
     */
    getMerkleBlock(blockHash) {
        this.getData([{
            type: 3, // MSG_FILTERED_BLOCK
            hash: blockHash
        }]);
    }

    /**
     * Send a message to the peer
     */
    sendMessage(command, payload) {
        if (!this.socket || !this.connected) {
            throw new Error('Not connected');
        }

        // Build header
        const header = Buffer.alloc(24);

        // Magic
        MAGIC.copy(header, 0);

        // Command (12 bytes, null-padded)
        header.fill(0, 4, 16);
        header.write(command, 4, 'ascii');

        // Payload length
        header.writeUInt32LE(payload.length, 16);

        // Checksum (first 4 bytes of double SHA256)
        const checksum = doubleSha256(payload).slice(0, 4);
        checksum.copy(header, 20);

        // Send header + payload
        this.socket.write(Buffer.concat([header, payload]));
    }
}

/**
 * Double SHA256 hash
 */
function doubleSha256(data) {
    return crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(data).digest()
    ).digest();
}

/**
 * Read a variable-length integer
 */
function readVarInt(buffer, offset) {
    const first = buffer.readUInt8(offset);
    if (first < 0xfd) {
        return { value: first, size: 1 };
    } else if (first === 0xfd) {
        return { value: buffer.readUInt16LE(offset + 1), size: 3 };
    } else if (first === 0xfe) {
        return { value: buffer.readUInt32LE(offset + 1), size: 5 };
    } else {
        return { value: Number(buffer.readBigUInt64LE(offset + 1)), size: 9 };
    }
}

/**
 * Write a variable-length integer
 */
function writeVarInt(buffer, offset, value) {
    if (value < 0xfd) {
        buffer.writeUInt8(value, offset);
        return 1;
    } else if (value <= 0xffff) {
        buffer.writeUInt8(0xfd, offset);
        buffer.writeUInt16LE(value, offset + 1);
        return 3;
    } else if (value <= 0xffffffff) {
        buffer.writeUInt8(0xfe, offset);
        buffer.writeUInt32LE(value, offset + 1);
        return 5;
    } else {
        buffer.writeUInt8(0xff, offset);
        buffer.writeBigUInt64LE(BigInt(value), offset + 1);
        return 9;
    }
}

module.exports = { BSVP2P, KNOWN_NODES, DNS_SEEDS };

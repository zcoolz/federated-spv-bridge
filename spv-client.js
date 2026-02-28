/**
 * Full SPV Client
 *
 * True Simplified Payment Verification - no third-party APIs.
 * Connects directly to BSV network, maintains header chain,
 * watches addresses via bloom filters, verifies merkle proofs.
 *
 * This is what Satoshi described in Section 8 of the whitepaper.
 */

const { BSVP2P } = require('./p2p');
const { BloomFilter, BLOOM_UPDATE_ALL } = require('./bloom');
const { HeaderSync } = require('./header-sync');
const { Level } = require('level');
const dns = require('dns').promises;
const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');

// Inventory types
const MSG_TX = 1;
const MSG_BLOCK = 2;
const MSG_FILTERED_BLOCK = 3;

class SPVClient extends EventEmitter {
    constructor(options = {}) {
        super();

        this.dataDir = options.dataDir || path.join(__dirname, 'data');
        this.headerSync = new HeaderSync(path.join(this.dataDir, 'headers'));

        // P2P connections (we'll maintain multiple for reliability)
        this.peers = [];
        this.maxPeers = options.maxPeers || 3;

        // Watched addresses and their transactions
        this.watchedAddresses = new Set();
        this.bloomFilter = null;

        // Transaction store
        this.txDb = null;
        this.pendingTxs = new Map(); // txid -> { raw, firstSeen, confirmations }

        // State
        this.initialized = false;
        this.syncing = false;
    }

    /**
     * Initialize the SPV client
     */
    async init() {
        console.log('[SPV] Initializing...');

        // Initialize header sync
        await this.headerSync.init();

        // Open transaction database
        const fs = require('fs');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.txDb = new Level(path.join(this.dataDir, 'transactions'), { valueEncoding: 'json' });

        // Load watched addresses from storage
        try {
            const addresses = await this.txDb.get('_watched_addresses');
            for (const addr of addresses) {
                this.watchedAddresses.add(addr);
            }
            console.log(`[SPV] Loaded ${this.watchedAddresses.size} watched addresses`);
        } catch (e) {
            // No addresses yet
        }

        this.initialized = true;
        console.log('[SPV] Initialized');
    }

    /**
     * Find BSV peers via DNS
     */
    async findPeers() {
        const peers = [];

        try {
            const addresses = await dns.resolve4('seed.bitcoinsv.io');
            for (const addr of addresses.slice(0, 10)) {
                peers.push({ host: addr, port: 8333 });
            }
        } catch (e) {
            console.log('[SPV] DNS lookup failed, using fallback peers');
        }

        // Fallback peers
        if (peers.length === 0) {
            peers.push(
                { host: '51.222.249.3', port: 8333 },
                { host: '95.217.121.174', port: 8333 }
            );
        }

        return peers;
    }

    /**
     * Connect to the P2P network
     */
    async connect() {
        console.log('[SPV] Connecting to BSV network...');

        const availablePeers = await this.findPeers();

        // Connect to multiple peers for reliability
        const connectPromises = [];
        for (let i = 0; i < Math.min(this.maxPeers, availablePeers.length); i++) {
            connectPromises.push(this.connectToPeer(availablePeers[i]));
        }

        const results = await Promise.allSettled(connectPromises);
        const connected = results.filter(r => r.status === 'fulfilled').length;

        if (connected === 0) {
            throw new Error('Failed to connect to any peers');
        }

        console.log(`[SPV] Connected to ${connected}/${this.maxPeers} peers`);
        return connected;
    }

    /**
     * Connect to a single peer
     */
    async connectToPeer(peerInfo) {
        const p2p = new BSVP2P();

        try {
            await p2p.connect(peerInfo.host, peerInfo.port);

            // Set up event handlers
            this.setupPeerHandlers(p2p, peerInfo);

            this.peers.push({ p2p, ...peerInfo, connected: true });

            // Load bloom filter if we have watched addresses
            if (this.bloomFilter) {
                p2p.filterload(this.bloomFilter);
            }

            return p2p;
        } catch (e) {
            console.log(`[SPV] Failed to connect to ${peerInfo.host}: ${e.message}`);
            throw e;
        }
    }

    /**
     * Set up event handlers for a peer
     */
    setupPeerHandlers(p2p, peerInfo) {
        // Handle new transactions
        p2p.on('tx', (tx) => {
            this.handleTransaction(tx);
        });

        // Handle merkle blocks (proofs)
        p2p.on('merkleblock', (block) => {
            this.handleMerkleBlock(block);
        });

        // Handle inventory announcements
        p2p.on('inv', (inventory) => {
            this.handleInventory(p2p, inventory);
        });

        // Handle disconnection
        p2p.on('disconnect', () => {
            console.log(`[SPV] Peer ${peerInfo.host} disconnected`);
            const idx = this.peers.findIndex(p => p.host === peerInfo.host);
            if (idx !== -1) {
                this.peers[idx].connected = false;
            }
            // Could reconnect here
        });
    }

    /**
     * Handle incoming transaction
     */
    async handleTransaction(tx) {
        console.log(`[SPV] Received tx: ${tx.txid}`);

        // Store in pending (unconfirmed) transactions
        this.pendingTxs.set(tx.txid, {
            raw: tx.raw,
            firstSeen: Date.now(),
            confirmations: 0
        });

        // Emit event for listeners
        this.emit('tx', {
            txid: tx.txid,
            raw: tx.raw,
            confirmed: false
        });

        // Parse and check if it involves our addresses
        const decoded = this.decodeTx(tx.raw);
        this.emit('tx:decoded', decoded);
    }

    /**
     * Handle merkle block (proof that tx is in block)
     */
    async handleMerkleBlock(block) {
        console.log(`[SPV] Received merkleblock for block ${block.header.hash}`);

        // Verify the block header is in our chain
        const storedHeader = await this.headerSync.getHeaderByHash(block.header.hash);
        if (!storedHeader) {
            console.error(`[SPV] Block ${block.header.hash} not in our header chain!`);
            return;
        }

        // Verify merkle proof
        const verified = this.verifyMerkleProof(block);
        if (!verified.valid) {
            console.error(`[SPV] Merkle proof verification failed!`);
            return;
        }

        // Get block height
        const height = await this.headerSync.db.get(`height:${block.header.hash}`);
        const confirmations = this.headerSync.syncedHeight - height + 1;

        // Update any pending transactions that are in this block
        for (const txid of verified.matchedTxids) {
            if (this.pendingTxs.has(txid)) {
                const txData = this.pendingTxs.get(txid);

                // Move to confirmed storage
                await this.txDb.put(`tx:${txid}`, {
                    raw: txData.raw,
                    blockHash: block.header.hash,
                    blockHeight: height,
                    merkleProof: {
                        hashes: block.hashes,
                        flags: block.flags.toString('hex'),
                        totalTxs: block.totalTxs
                    },
                    firstSeen: txData.firstSeen,
                    confirmedAt: Date.now()
                });

                this.pendingTxs.delete(txid);

                console.log(`[SPV] Tx ${txid} confirmed in block ${height} (${confirmations} confirmations)`);

                this.emit('tx:confirmed', {
                    txid,
                    blockHash: block.header.hash,
                    blockHeight: height,
                    confirmations
                });
            }
        }
    }

    /**
     * Verify a merkle proof from a merkleblock message
     */
    verifyMerkleProof(block) {
        const { hashes, flags, totalTxs, header } = block;

        // Convert flags buffer to bit array
        const bits = [];
        for (const byte of flags) {
            for (let i = 0; i < 8; i++) {
                bits.push((byte >> i) & 1);
            }
        }

        let hashIndex = 0;
        let bitIndex = 0;
        const matchedTxids = [];

        // Calculate tree height
        let height = 0;
        while ((1 << height) < totalTxs) height++;

        // Recursive function to traverse and verify the tree
        const traverse = (depth, pos) => {
            if (bitIndex >= bits.length) return null;

            const parentOfMatch = bits[bitIndex++];

            if (depth === height || !parentOfMatch) {
                // Leaf node or subtree without matches
                if (hashIndex >= hashes.length) return null;
                const hash = hashes[hashIndex++];

                if (depth === height && parentOfMatch) {
                    // This is a matched transaction
                    matchedTxids.push(hash);
                }
                return hash;
            }

            // Internal node - recurse
            const left = traverse(depth + 1, pos * 2);
            let right;

            if (pos * 2 + 1 < (totalTxs + (1 << depth) - 1) >> depth) {
                right = traverse(depth + 1, pos * 2 + 1);
            } else {
                right = left; // Duplicate left if no right child
            }

            if (!left || !right) return null;

            // Hash the children together
            return this.hashPair(left, right);
        };

        const calculatedRoot = traverse(0, 0);

        // Verify against the block header's merkle root
        const valid = calculatedRoot === header.merkleRoot;

        return {
            valid,
            matchedTxids,
            calculatedRoot,
            expectedRoot: header.merkleRoot
        };
    }

    /**
     * Hash two merkle tree nodes together
     */
    hashPair(left, right) {
        const leftBuf = Buffer.from(left, 'hex').reverse();
        const rightBuf = Buffer.from(right, 'hex').reverse();
        const combined = Buffer.concat([leftBuf, rightBuf]);
        return crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(combined).digest()
        ).digest().reverse().toString('hex');
    }

    /**
     * Handle inventory announcements
     */
    handleInventory(p2p, inventory) {
        const txInv = inventory.filter(i => i.type === MSG_TX);
        const blockInv = inventory.filter(i => i.type === MSG_BLOCK);

        if (txInv.length > 0) {
            // Request the transaction data
            p2p.getData(txInv);
        }

        if (blockInv.length > 0) {
            // New block! Request as merkleblock if we have a filter
            if (this.bloomFilter) {
                for (const block of blockInv) {
                    p2p.getMerkleBlock(block.hash);
                }
            }

            // Also update our header chain
            this.emit('newblock', blockInv.map(b => b.hash));
        }
    }

    /**
     * Watch an address for transactions
     */
    async watchAddress(address) {
        if (this.watchedAddresses.has(address)) {
            return; // Already watching
        }

        this.watchedAddresses.add(address);
        console.log(`[SPV] Now watching address: ${address}`);

        // Rebuild bloom filter
        this.rebuildBloomFilter();

        // Save to storage
        await this.txDb.put('_watched_addresses', Array.from(this.watchedAddresses));

        // Load filter on all connected peers
        for (const peer of this.peers.filter(p => p.connected)) {
            peer.p2p.filterload(this.bloomFilter);
            // Request mempool to catch any unconfirmed txs
            peer.p2p.mempool();
        }
    }

    /**
     * Stop watching an address
     */
    async unwatchAddress(address) {
        this.watchedAddresses.delete(address);
        this.rebuildBloomFilter();
        await this.txDb.put('_watched_addresses', Array.from(this.watchedAddresses));
    }

    /**
     * Rebuild the bloom filter with all watched addresses
     */
    rebuildBloomFilter() {
        if (this.watchedAddresses.size === 0) {
            this.bloomFilter = null;
            return;
        }

        // Create filter with some room for growth
        this.bloomFilter = new BloomFilter(
            this.watchedAddresses.size * 2,
            0.0001, // 0.01% false positive rate
            Math.floor(Math.random() * 0xFFFFFFFF),
            BLOOM_UPDATE_ALL
        );

        // Add all addresses
        for (const address of this.watchedAddresses) {
            this.bloomFilter.addAddress(address);
        }
    }

    /**
     * Broadcast a transaction to the network
     */
    async broadcastTx(rawTxHex) {
        if (this.peers.filter(p => p.connected).length === 0) {
            throw new Error('Not connected to any peers');
        }

        // Calculate txid
        const txBuffer = Buffer.from(rawTxHex, 'hex');
        const txid = crypto.createHash('sha256').update(
            crypto.createHash('sha256').update(txBuffer).digest()
        ).digest().reverse().toString('hex');

        // Broadcast to all connected peers
        let broadcastCount = 0;
        for (const peer of this.peers.filter(p => p.connected)) {
            try {
                peer.p2p.broadcastTx(rawTxHex);
                broadcastCount++;
            } catch (e) {
                console.error(`[SPV] Failed to broadcast to ${peer.host}: ${e.message}`);
            }
        }

        if (broadcastCount === 0) {
            throw new Error('Failed to broadcast to any peers');
        }

        // Store as pending
        this.pendingTxs.set(txid, {
            raw: rawTxHex,
            firstSeen: Date.now(),
            confirmations: 0
        });

        console.log(`[SPV] Broadcast tx ${txid} to ${broadcastCount} peers`);

        return txid;
    }

    /**
     * Get balance for a watched address (requires UTXOs from merkle proofs)
     * Note: This is more complex in pure SPV - we'd need to track UTXOs from merkle proofs
     */
    async getBalance(address) {
        // In a full implementation, we'd track UTXOs from confirmed txs
        // For now, return what we have from confirmed transactions
        const txs = await this.getTransactionsForAddress(address);
        // This would require proper UTXO tracking
        return { confirmed: 0, unconfirmed: 0, txCount: txs.length };
    }

    /**
     * Get transactions for an address
     */
    async getTransactionsForAddress(address) {
        const txs = [];

        // Get from confirmed storage
        for await (const [key, value] of this.txDb.iterator()) {
            if (key.startsWith('tx:')) {
                // Check if tx involves this address
                const decoded = this.decodeTx(value.raw);
                if (this.txInvolvesAddress(decoded, address)) {
                    txs.push({
                        txid: key.slice(3),
                        ...value,
                        decoded
                    });
                }
            }
        }

        // Add pending transactions
        for (const [txid, data] of this.pendingTxs) {
            const decoded = this.decodeTx(data.raw);
            if (this.txInvolvesAddress(decoded, address)) {
                txs.push({
                    txid,
                    ...data,
                    decoded,
                    confirmed: false
                });
            }
        }

        return txs;
    }

    /**
     * Basic transaction decoder
     */
    decodeTx(rawHex) {
        const buf = Buffer.from(rawHex, 'hex');
        let offset = 0;

        const version = buf.readInt32LE(offset);
        offset += 4;

        // Input count
        const { value: inCount, size: inCountSize } = readVarInt(buf, offset);
        offset += inCountSize;

        const inputs = [];
        for (let i = 0; i < inCount; i++) {
            const prevTxid = buf.slice(offset, offset + 32).reverse().toString('hex');
            offset += 32;
            const prevVout = buf.readUInt32LE(offset);
            offset += 4;
            const { value: scriptLen, size: scriptLenSize } = readVarInt(buf, offset);
            offset += scriptLenSize;
            const script = buf.slice(offset, offset + scriptLen).toString('hex');
            offset += scriptLen;
            const sequence = buf.readUInt32LE(offset);
            offset += 4;
            inputs.push({ prevTxid, prevVout, script, sequence });
        }

        // Output count
        const { value: outCount, size: outCountSize } = readVarInt(buf, offset);
        offset += outCountSize;

        const outputs = [];
        for (let i = 0; i < outCount; i++) {
            const satoshis = Number(buf.readBigUInt64LE(offset));
            offset += 8;
            const { value: scriptLen, size: scriptLenSize } = readVarInt(buf, offset);
            offset += scriptLenSize;
            const script = buf.slice(offset, offset + scriptLen).toString('hex');
            offset += scriptLen;
            outputs.push({ satoshis, script, vout: i });
        }

        const locktime = buf.readUInt32LE(offset);

        return { version, inputs, outputs, locktime };
    }

    /**
     * Check if a transaction involves an address
     */
    txInvolvesAddress(decoded, address) {
        const hash160 = this.addressToHash160(address);
        if (!hash160) return false;

        // Check outputs for P2PKH
        for (const out of decoded.outputs) {
            if (out.script.includes(hash160)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Convert address to hash160
     */
    addressToHash160(address) {
        try {
            const decoded = this.base58Decode(address);
            if (decoded.length !== 25) return null;
            return decoded.slice(1, 21).toString('hex');
        } catch {
            return null;
        }
    }

    /**
     * Base58 decode
     */
    base58Decode(str) {
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        const ALPHABET_MAP = {};
        for (let i = 0; i < ALPHABET.length; i++) {
            ALPHABET_MAP[ALPHABET[i]] = i;
        }

        let bytes = [0];
        for (const char of str) {
            const value = ALPHABET_MAP[char];
            if (value === undefined) throw new Error('Invalid base58');

            let carry = value;
            for (let j = 0; j < bytes.length; j++) {
                carry += bytes[j] * 58;
                bytes[j] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }

        for (const char of str) {
            if (char !== '1') break;
            bytes.push(0);
        }

        return Buffer.from(bytes.reverse());
    }

    /**
     * Sync headers and connect to network
     */
    async start() {
        if (!this.initialized) {
            await this.init();
        }

        // Sync headers first
        console.log('[SPV] Syncing headers...');
        await this.headerSync.sync();

        // Connect to peers
        await this.connect();

        console.log('[SPV] Client started and ready');
        this.emit('ready');
    }

    /**
     * Clean shutdown
     */
    async stop() {
        console.log('[SPV] Shutting down...');

        // Disconnect all peers
        for (const peer of this.peers) {
            if (peer.connected) {
                peer.p2p.disconnect();
            }
        }

        // Close databases
        await this.headerSync.close();
        if (this.txDb) {
            await this.txDb.close();
        }

        console.log('[SPV] Stopped');
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            initialized: this.initialized,
            headerHeight: this.headerSync.syncedHeight,
            connectedPeers: this.peers.filter(p => p.connected).length,
            watchedAddresses: this.watchedAddresses.size,
            pendingTxs: this.pendingTxs.size
        };
    }
}

// Helper function
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

module.exports = { SPVClient };

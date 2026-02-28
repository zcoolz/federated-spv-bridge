/**
 * BSV Header Sync
 *
 * Downloads and stores all BSV block headers using P2P protocol.
 * Headers are stored in LevelDB for fast lookup and verification.
 *
 * Usage: node header-sync.js
 */

const { BSVP2P } = require('./p2p');
const { Level } = require('level');
const dns = require('dns').promises;
const path = require('path');

// Database paths
const HEADERS_DB_PATH = path.join(__dirname, 'data', 'headers');

// BSV Genesis block hash
const GENESIS_HASH = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';

class HeaderSync {
    constructor(dbPath = HEADERS_DB_PATH) {
        this.dbPath = dbPath;
        this.db = null;
        this.p2p = null;
        this.syncedHeight = 0;
        this.tipHash = null;
        this.syncing = false;
        this.headersByHash = new Map(); // In-memory index for fast access
    }

    /**
     * Initialize the header database
     */
    async init() {
        console.log('[HeaderSync] Initializing database...');

        // Create data directory if needed
        const fs = require('fs');
        const dataDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }

        this.db = new Level(this.dbPath, { valueEncoding: 'json' });

        // Load current sync state
        try {
            const state = await this.db.get('_sync_state');
            this.syncedHeight = state.height;
            this.tipHash = state.tipHash;
            console.log(`[HeaderSync] Resuming from height ${this.syncedHeight}`);
        } catch (e) {
            if (e.code === 'LEVEL_NOT_FOUND') {
                console.log('[HeaderSync] Starting fresh sync');
                this.syncedHeight = 0;
                this.tipHash = null;
            } else {
                throw e;
            }
        }
    }


    /**
     * Connect to the P2P network
     */
    async connect() {
        this.p2p = new BSVP2P();

        // Try multiple peers until one works
        const peers = await this.findPeers();

        for (const peer of peers) {
            try {
                console.log(`[HeaderSync] Connecting to ${peer.host}:${peer.port}...`);
                await this.p2p.connect(peer.host, peer.port);
                console.log(`[HeaderSync] Connected! Network height: ${this.p2p.bestHeight}`);
                return this.p2p.bestHeight;
            } catch (e) {
                console.log(`[HeaderSync] Failed to connect to ${peer.host}: ${e.message}`);
                continue;
            }
        }

        throw new Error('Failed to connect to any peers');
    }

    /**
     * Find multiple BSV peers
     */
    async findPeers() {
        const peers = [];

        try {
            const addresses = await dns.resolve4('seed.bitcoinsv.io');
            for (const addr of addresses.slice(0, 5)) {
                peers.push({ host: addr, port: 8333 });
            }
        } catch (e) {
            console.log('[HeaderSync] DNS lookup failed');
        }

        // Add fallback peers
        peers.push(
            { host: '51.222.249.3', port: 8333 },
            { host: '95.217.121.174', port: 8333 }
        );

        return peers;
    }

    /**
     * Build block locator hashes for getheaders
     * Returns hashes of blocks at exponentially decreasing intervals
     */
    async getLocatorHashes() {
        if (this.syncedHeight === 0) {
            return []; // Start from genesis
        }

        const hashes = [];
        let step = 1;
        let height = this.syncedHeight;

        while (height > 0) {
            try {
                const header = await this.db.get(`header:${height}`);
                hashes.push(header.hash);
            } catch (e) {
                // Skip if not found
            }

            if (hashes.length >= 10) {
                step *= 2;
            }
            height -= step;
        }

        // Always include genesis
        hashes.push(GENESIS_HASH);

        return hashes;
    }

    /**
     * Store a batch of headers
     */
    async storeHeaders(headers) {
        const batch = this.db.batch();
        let height = this.syncedHeight;

        for (const header of headers) {
            height++;

            // Store header by height
            batch.put(`header:${height}`, {
                hash: header.hash,
                prevBlock: header.prevBlock,
                merkleRoot: header.merkleRoot,
                timestamp: header.timestamp,
                bits: header.bits,
                nonce: header.nonce,
                version: header.version
            });

            // Store height by hash (for lookups)
            batch.put(`height:${header.hash}`, height);

            // Update in-memory index
            this.headersByHash.set(header.hash, { ...header, height });
        }

        // Update sync state
        this.syncedHeight = height;
        this.tipHash = headers[headers.length - 1].hash;

        batch.put('_sync_state', {
            height: this.syncedHeight,
            tipHash: this.tipHash,
            updatedAt: Date.now()
        });

        await batch.write();
    }

    /**
     * Sync all headers from the network
     */
    async sync() {
        if (this.syncing) {
            console.log('[HeaderSync] Already syncing');
            return;
        }

        this.syncing = true;
        const networkHeight = await this.connect();

        console.log(`[HeaderSync] Starting sync: ${this.syncedHeight} -> ${networkHeight}`);
        console.log(`[HeaderSync] Headers to download: ${networkHeight - this.syncedHeight}`);

        let lastProgressReport = Date.now();
        const startTime = Date.now();
        const startHeight = this.syncedHeight;

        // Set up header handler - collects headers and resolves when we get a batch
        const headerPromise = () => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Header request timeout'));
            }, 30000);

            this.p2p.once('headers', async (headers) => {
                clearTimeout(timeout);
                resolve(headers);
            });
        });

        try {
            while (this.syncedHeight < networkHeight) {
                // Build locator from our current tip
                const locators = this.tipHash ? [this.tipHash] : [];

                // Set up promise BEFORE sending request
                const promise = headerPromise();

                // Request headers starting from our tip
                this.p2p.getHeaders(locators);

                // Wait for response
                const headers = await promise;

                if (headers.length === 0) {
                    console.log('[HeaderSync] No more headers received');
                    break;
                }

                // First batch: tipHash is null, just store everything
                // Subsequent batches: first header's prevBlock should match our tip
                if (!this.tipHash) {
                    // First batch - store all
                    await this.storeHeaders(headers);
                } else if (headers[0].prevBlock === this.tipHash) {
                    // Headers connect properly - store all
                    await this.storeHeaders(headers);
                } else {
                    // Headers don't connect - check if first header IS our tip (duplicate)
                    // The getheaders response includes the locator block itself
                    if (headers[0].hash === this.tipHash && headers.length > 1) {
                        // Skip the first header (it's our tip) and store the rest
                        await this.storeHeaders(headers.slice(1));
                    } else {
                        // Try to find connection point
                        let connectingIndex = -1;
                        for (let i = 0; i < headers.length; i++) {
                            if (headers[i].prevBlock === this.tipHash) {
                                connectingIndex = i;
                                break;
                            }
                        }

                        if (connectingIndex !== -1) {
                            await this.storeHeaders(headers.slice(connectingIndex));
                        } else {
                            console.log(`[HeaderSync] Chain gap - our tip: ${this.tipHash.slice(0, 16)}...`);
                            console.log(`[HeaderSync] First header prevBlock: ${headers[0].prevBlock.slice(0, 16)}...`);
                            console.log(`[HeaderSync] First header hash: ${headers[0].hash.slice(0, 16)}...`);
                            await new Promise(r => setTimeout(r, 1000));
                            continue;
                        }
                    }
                }

                // Progress report every 5 seconds
                const now = Date.now();
                if (now - lastProgressReport > 5000) {
                    const elapsed = (now - startTime) / 1000;
                    const headersSynced = this.syncedHeight - startHeight;
                    const headersPerSecond = headersSynced / elapsed;
                    const remaining = networkHeight - this.syncedHeight;
                    const eta = remaining / headersPerSecond;

                    console.log(`[HeaderSync] Progress: ${this.syncedHeight}/${networkHeight} ` +
                        `(${((this.syncedHeight / networkHeight) * 100).toFixed(2)}%) ` +
                        `- ${headersPerSecond.toFixed(0)} headers/sec ` +
                        `- ETA: ${formatTime(eta)}`);

                    lastProgressReport = now;
                }

                // Small delay to avoid overwhelming the peer
                await new Promise(r => setTimeout(r, 100));
            }

            const elapsed = (Date.now() - startTime) / 1000;
            console.log(`[HeaderSync] Sync complete!`);
            console.log(`[HeaderSync] Final height: ${this.syncedHeight}`);
            console.log(`[HeaderSync] Time elapsed: ${formatTime(elapsed)}`);

        } catch (err) {
            console.error('[HeaderSync] Sync error:', err.message);
            throw err;
        } finally {
            this.syncing = false;
        }
    }

    /**
     * Get header by height
     */
    async getHeaderByHeight(height) {
        try {
            return await this.db.get(`header:${height}`);
        } catch (e) {
            return null;
        }
    }

    /**
     * Get header by hash
     */
    async getHeaderByHash(hash) {
        try {
            const height = await this.db.get(`height:${hash}`);
            return await this.getHeaderByHeight(height);
        } catch (e) {
            return null;
        }
    }

    /**
     * Get current sync status
     */
    getStatus() {
        return {
            height: this.syncedHeight,
            tipHash: this.tipHash,
            syncing: this.syncing,
            networkHeight: this.p2p?.bestHeight || 0
        };
    }

    /**
     * Verify a merkle proof
     * @param {string} txHash - Transaction hash to verify
     * @param {string[]} merkleProof - Array of hashes in the merkle path
     * @param {number} txIndex - Index of the transaction in the block
     * @param {string} blockHash - Block hash to verify against
     */
    async verifyMerkleProof(txHash, merkleProof, txIndex, blockHash) {
        const header = await this.getHeaderByHash(blockHash);
        if (!header) {
            throw new Error(`Block ${blockHash} not found in header chain`);
        }

        // Calculate merkle root from proof
        let hash = Buffer.from(txHash, 'hex').reverse();
        let index = txIndex;

        for (const proofHash of merkleProof) {
            const sibling = Buffer.from(proofHash, 'hex').reverse();

            // Determine order based on index
            const combined = (index % 2 === 0)
                ? Buffer.concat([hash, sibling])
                : Buffer.concat([sibling, hash]);

            hash = doubleSha256(combined);
            index = Math.floor(index / 2);
        }

        const calculatedRoot = hash.reverse().toString('hex');

        if (calculatedRoot !== header.merkleRoot) {
            throw new Error('Merkle proof verification failed');
        }

        return {
            verified: true,
            blockHash: header.hash,
            blockHeight: await this.db.get(`height:${header.hash}`),
            blockTimestamp: header.timestamp
        };
    }

    /**
     * Close the database
     */
    async close() {
        if (this.p2p) {
            this.p2p.disconnect();
        }
        if (this.db) {
            await this.db.close();
        }
    }
}

// Helper functions
function doubleSha256(data) {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(
        crypto.createHash('sha256').update(data).digest()
    ).digest();
}

function formatTime(seconds) {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
    return `${(seconds / 3600).toFixed(1)}h`;
}

// Run sync if called directly
if (require.main === module) {
    const sync = new HeaderSync();

    process.on('SIGINT', async () => {
        console.log('\n[HeaderSync] Shutting down...');
        await sync.close();
        process.exit(0);
    });

    sync.init()
        .then(() => sync.sync())
        .then(() => {
            console.log('[HeaderSync] Done!');
            return sync.close();
        })
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[HeaderSync] Fatal error:', err);
            process.exit(1);
        });
}

module.exports = { HeaderSync };

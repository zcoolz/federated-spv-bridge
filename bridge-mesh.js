/**
 * Bridge Mesh — bridge-to-bridge peering layer
 *
 * Each SPV bridge maintains awareness of other bridges in the network.
 * If a local lookup fails (cache miss, not in DB, P2P returned nothing),
 * the mesh asks peer bridges before returning null to the client.
 *
 * Loop prevention: outbound mesh requests append ?nomesh=1 so the
 * receiving bridge skips its own mesh step (no infinite forwarding).
 */

const http = require('http');
const https = require('https');

class BridgeMesh {
    constructor(opts = {}) {
        this.peers = (opts.peers || []).map(url => ({
            url: url.replace(/\/$/, ''),
            healthy: false,
            lastCheck: 0,
            latency: Infinity,
            failures: 0
        }));

        this.pingInterval = opts.pingInterval || 30000; // 30s
        this.requestTimeout = opts.requestTimeout || 5000; // 5s
        this.apiKey = opts.apiKey || null;
        this._timer = null;
    }

    start() {
        if (this.peers.length === 0) {
            console.log('[Mesh] No peers configured, mesh disabled');
            return;
        }
        console.log(`[Mesh] Starting with ${this.peers.length} peers`);
        this.pingAll();
        this._timer = setInterval(() => this.pingAll(), this.pingInterval);
    }

    stop() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    }

    async pingAll() {
        await Promise.allSettled(this.peers.map(p => this._pingPeer(p)));
        const healthy = this.peers.filter(p => p.healthy).length;
        console.log(`[Mesh] Health: ${healthy}/${this.peers.length} peers up`);
    }

    async _pingPeer(peer) {
        const start = Date.now();
        try {
            const data = await this._fetch(`${peer.url}/health`);
            peer.latency = Date.now() - start;
            peer.healthy = !!(data && data.status === 'ok');
            peer.lastCheck = Date.now();
            peer.failures = peer.healthy ? 0 : peer.failures + 1;
        } catch (e) {
            peer.healthy = false;
            peer.lastCheck = Date.now();
            peer.latency = Infinity;
            peer.failures++;
        }
    }

    /**
     * Ask all healthy peers for JSON data at `path`.
     * Appends ?nomesh=1 to prevent loops.
     * Returns first valid response or null.
     */
    async askPeers(path) {
        const healthy = this.peers.filter(p => p.healthy);
        if (healthy.length === 0) return null;

        healthy.sort((a, b) => a.latency - b.latency);

        const sep = path.includes('?') ? '&' : '?';
        const meshPath = `${path}${sep}nomesh=1`;

        const results = await Promise.allSettled(
            healthy.map(peer =>
                this._fetch(`${peer.url}${meshPath}`)
                    .then(data => (data && !data.error) ? data : null)
                    .catch(() => null)
            )
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value !== null) return r.value;
        }
        return null;
    }

    /**
     * Ask all healthy peers for raw text at `path` (e.g. tx hex).
     * Appends ?nomesh=1 to prevent loops.
     */
    async askPeersRaw(path) {
        const healthy = this.peers.filter(p => p.healthy);
        if (healthy.length === 0) return null;

        healthy.sort((a, b) => a.latency - b.latency);

        const sep = path.includes('?') ? '&' : '?';
        const meshPath = `${path}${sep}nomesh=1`;

        const results = await Promise.allSettled(
            healthy.map(peer =>
                this._fetchRaw(`${peer.url}${meshPath}`).catch(() => null)
            )
        );

        for (const r of results) {
            if (r.status === 'fulfilled' && r.value) return r.value;
        }
        return null;
    }

    getStatus() {
        return {
            peers: this.peers.map(p => ({
                url: p.url,
                healthy: p.healthy,
                latency: p.latency === Infinity ? null : p.latency,
                failures: p.failures,
                lastCheck: p.lastCheck ? new Date(p.lastCheck).toISOString() : null
            })),
            healthyCount: this.peers.filter(p => p.healthy).length,
            totalCount: this.peers.length
        };
    }

    // --- internal helpers ---

    _fetch(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
            const mod = url.startsWith('https') ? https : http;
            const headers = {};
            if (this.apiKey) headers['X-API-Key'] = this.apiKey;

            const req = mod.get(url, { headers, timeout: this.requestTimeout }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try { done(resolve, JSON.parse(data)); } catch (e) { done(resolve, data); }
                    } else {
                        done(reject, new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });
            req.on('error', (err) => done(reject, err));
            req.on('timeout', () => { req.destroy(); done(reject, new Error('timeout')); });
        });
    }

    _fetchRaw(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
            const mod = url.startsWith('https') ? https : http;
            const headers = {};
            if (this.apiKey) headers['X-API-Key'] = this.apiKey;

            const req = mod.get(url, { headers, timeout: this.requestTimeout }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200 && data.length > 0) {
                        done(resolve, data);
                    } else {
                        done(reject, new Error(`HTTP ${res.statusCode}`));
                    }
                });
            });
            req.on('error', (err) => done(reject, err));
            req.on('timeout', () => { req.destroy(); done(reject, new Error('timeout')); });
        });
    }
}

module.exports = { BridgeMesh };

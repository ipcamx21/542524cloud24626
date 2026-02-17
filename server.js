const express = require('express');
const https = require('https');
const http = require('http');
const { parse, URL } = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "VpsManagerStrongKey";

// Cache Auth (60s)
const authCache = new Map();
function validateUser(authUrl, username, password) {
    return new Promise((resolve) => {
        const cacheKey = `${username}:${password}`;
        const cached = authCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) return resolve(cached.valid);
        try {
            const targetUrl = new URL(authUrl);
            targetUrl.searchParams.set('username', username);
            targetUrl.searchParams.set('password', password);
            const lib = targetUrl.protocol === 'https:' ? https : http;
            const req = lib.request(targetUrl.toString(), { method: 'GET', timeout: 5000 }, (res) => {
                const isValid = res.statusCode === 200;
                if (isValid) authCache.set(cacheKey, { valid: true, expires: Date.now() + 60000 });
                resolve(isValid);
            });
            req.on('error', () => resolve(false));
            req.end();
        } catch (e) { resolve(false); }
    });
}

// Broadcaster Blindado
const activeBroadcasts = new Map();
class SecureBroadcaster extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.clients = new Set();
        this.headers = null;
        this.statusCode = null;
        this.upstreamReq = null;
        this.connect(this.url);
    }
    connect(currentUrl, redirects = 0) {
        if (redirects > 5) { this.destroy(); return; }
        const targetUrl = parse(currentUrl);
        const lib = targetUrl.protocol === 'https:' ? https : http;
        this.upstreamReq = lib.request(currentUrl, {
            method: 'GET',
            headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*' }
        }, (res) => {
            if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
                this.upstreamReq.destroy();
                this.connect(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
                return;
            }
            this.headers = res.headers;
            this.statusCode = res.statusCode;
            this.emit('ready');
            res.on('data', (chunk) => {
                this.clients.forEach(c => { try { if(!c.writableEnded) c.write(chunk); } catch(e){} });
            });
            res.on('end', () => this.destroy());
            res.on('error', () => this.destroy());
        });
        this.upstreamReq.on('error', () => this.destroy());
        this.upstreamReq.end();
    }
    addClient(res) {
        this.clients.add(res);
        if (this.headers) this.initClient(res);
        else this.once('ready', () => this.initClient(res));
        res.on('close', () => this.removeClient(res));
    }
    removeClient(res) {
        this.clients.delete(res);
        if (!res.writableEnded) res.end();
        if (this.clients.size === 0) this.destroy();
    }
    initClient(res) {
        if (res.headersSent) return;
        if (this.headers['content-type']) res.setHeader('Content-Type', this.headers['content-type']);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(this.statusCode || 200);
    }
    destroy() {
        activeBroadcasts.delete(this.url);
        if (this.upstreamReq) this.upstreamReq.destroy();
        this.clients.forEach(c => !c.writableEnded && c.end());
        this.clients.clear();
    }
}

// ROTA GENÉRICA QUE PEGA /api/stream.m3u8, /api/stream.ts, etc.
app.get('/api*', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { payload, expires, token, auth, mode } = req.query;

    if (!payload || !expires || !token) return res.status(403).send("E1");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("E2");

    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("E3");

    let decodedString;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let output = '';
        for (let i = 0; i < decoded.length; i++) output += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        decodedString = output;
    } catch (e) { return res.status(500).send("E4"); }

    const parts = decodedString.split('|');
    const streamUrl = parts[0];
    const username = parts[1];
    const password = parts[2];

    if (auth && username && password) {
        const isValid = await validateUser(auth, username, password);
        if (!isValid) return res.status(403).send("Bloqueado");
    }

    // ==========================================
    // DETECÇÃO POR CAMINHO FALSO (URL PATH)
    // ==========================================
    const path = req.path;
    const isM3U8 = path.endsWith('.m3u8');
    const isTS = path.endsWith('.ts');

    // Se a URL termina em .m3u8 e não é modo raw -> Manda Playlist
    if (isM3U8 && mode !== 'raw') {
        // Troca .m3u8 por .ts na URL
        const tsPath = path.replace('.m3u8', '.ts');
        const selfUrl = `${req.protocol}://${req.get('host')}${tsPath}?${new URLSearchParams({...req.query, mode: 'raw'}).toString()}`;
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Content-Disposition', 'inline; filename="stream.m3u8"');
        return res.send(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:60\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:60.0,\n${selfUrl}`);
    }

    // ==========================================
    // STREAMING REAL (TS/VOD)
    // ==========================================
    const isVOD = streamUrl.match(/\.(mp4|mkv|avi|mov)$/i);
    const hasRange = req.headers.range;

    if (hasRange || isVOD) {
        proxyDirect(streamUrl, req, res);
    } else {
        if (activeBroadcasts.has(streamUrl)) {
            activeBroadcasts.get(streamUrl).addClient(res);
        } else {
            const broadcaster = new SecureBroadcaster(streamUrl);
            activeBroadcasts.set(streamUrl, broadcaster);
            broadcaster.addClient(res);
            broadcaster.once('error', () => !res.headersSent && proxyDirect(streamUrl, req, res));
        }
    }
});

function proxyDirect(url, clientReq, clientRes, redirects = 0) {
    if (redirects > 5) return clientRes.status(502).send("Loop");
    const targetUrl = parse(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;
    const proxyReq = lib.request(url, {
        method: 'GET',
        headers: { 'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', 'Accept': '*/*', ...(clientReq.headers.range && { 'Range': clientReq.headers.range }) }
    }, (proxyRes) => {
        if ([301, 302, 303, 307].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            return proxyDirect(new URL(proxyRes.headers.location, url).toString(), clientReq, clientRes, redirects + 1);
        }
        if (proxyRes.headers['content-type']) clientRes.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) clientRes.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) clientRes.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) clientRes.setHeader('Content-Range', proxyRes.headers['content-range']);
        clientRes.writeHead(proxyRes.statusCode);
        proxyRes.pipe(clientRes);
    });
    proxyReq.on('error', () => !clientRes.headersSent && clientRes.status(502).send("Err"));
    proxyReq.end();
}

app.get('*', (req, res) => res.status(404).send(`<html><head><title>404 Not Found</title></head><body bgcolor="white"><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

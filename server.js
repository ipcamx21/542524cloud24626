const express = require('express');
const https = require('https');
const http = require('http');
const { parse, URL } = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "VpsManagerStrongKey";

// Cache de Autenticação (Para não sobrecarregar seu painel)
// User+Pass -> { valid: true, expires: timestamp }
const authCache = new Map();

// Função para validar usuário no seu Painel
function validateUser(authUrl, username, password) {
    return new Promise((resolve) => {
        const cacheKey = `${username}:${password}`;
        const cached = authCache.get(cacheKey);
        
        // Se validou nos últimos 60 segundos, libera direto (Cache)
        if (cached && cached.expires > Date.now()) {
            return resolve(cached.valid);
        }

        console.log(`[Auth] Verificando usuário: ${username}`);
        
        // Chama seu script PHP para validar
        const targetUrl = new URL(authUrl);
        targetUrl.searchParams.set('username', username);
        targetUrl.searchParams.set('password', password); // O PHP deve aceitar hash ou raw

        const lib = targetUrl.protocol === 'https:' ? https : http;
        
        const req = lib.request(targetUrl.toString(), { method: 'GET', timeout: 5000 }, (res) => {
            if (res.statusCode === 200) {
                // Sucesso! Guarda no cache por 60s
                authCache.set(cacheKey, { valid: true, expires: Date.now() + 60000 });
                resolve(true);
            } else {
                console.log(`[Auth] Falha: ${res.statusCode}`);
                resolve(false);
            }
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => req.destroy());
        req.end();
    });
}

// ==========================================
// BROADCASTER (Mantido igual, mas agora protegido)
// ==========================================
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
        if (redirects > 5) { this.emit('error', new Error('Loop')); this.destroy(); return; }
        
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

// ==========================================
// ROTA PRINCIPAL (COM AUTENTICAÇÃO)
// ==========================================
app.get('/api', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { payload, expires, token, auth } = req.query;
    if (!payload || !expires || !token) return res.status(403).send("E1");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("E2");

    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("E3");

    // Descriptografar
    let decodedString;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let output = '';
        for (let i = 0; i < decoded.length; i++) output += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        decodedString = output;
    } catch (e) { return res.status(500).send("E4"); }

    const parts = decodedString.split('|');
    const streamUrl = parts[0];
    const username = parts[1]; // Agora estamos lendo o user/pass do payload
    const password = parts[2];

    // ==========================================
    // VALIDAÇÃO NO PAINEL (NOVA SEGURANÇA)
    // ==========================================
    if (auth && username && password) {
        const isValid = await validateUser(auth, username, password);
        if (!isValid) {
            return res.status(403).send("Conta Bloqueada ou Expirada");
        }
    } else {
        // Se não tiver authUrl (versões antigas), bloqueia ou libera?
        // Melhor bloquear para forçar segurança.
        // return res.status(403).send("Autenticacao Obrigatoria");
    }

    // Se passou, libera o vídeo (Lógica Híbrida)
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

// Proxy Direto (Fallback)
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

const express = require('express');
const https = require('https');
const http = require('http');
const { parse, URL } = require('url');
const crypto = require('crypto');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "VpsManagerStrongKey";

// ==========================================
// MODO SMART: DEDUPLICAÇÃO DE CONEXÃO
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
        if (redirects > 5) {
            this.emit('error', new Error('Muitos Redirects na Origem'));
            this.destroy();
            return;
        }

        console.log(`[CDN] Conectando Origem: ${currentUrl}`);
        const targetUrl = parse(currentUrl);
        const lib = targetUrl.protocol === 'https:' ? https : http;

        this.upstreamReq = lib.request(currentUrl, {
            method: 'GET',
            headers: {
                'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
                'Accept': '*/*'
            }
        }, (res) => {
            // SE A ORIGEM MANDAR REDIRECT, NÓS SEGUIMOS (O CLIENTE NÃO VÊ!)
            if ([301, 302, 303, 307].includes(res.statusCode) && res.headers.location) {
                console.log(`[CDN] Seguindo Redirect Interno...`);
                const nextUrl = new URL(res.headers.location, currentUrl).toString();
                this.upstreamReq.destroy(); // Fecha a antiga
                this.connect(nextUrl, redirects + 1); // Abre a nova
                return;
            }

            this.headers = res.headers;
            this.statusCode = res.statusCode;
            this.emit('ready', { headers: this.headers, statusCode: this.statusCode });

            res.on('data', (chunk) => {
                for (const client of this.clients) {
                    try {
                        if (!client.writableEnded && !client.destroyed) client.write(chunk);
                    } catch (e) { this.removeClient(client); }
                }
            });

            res.on('end', () => this.destroy());
            res.on('error', () => this.destroy());
        });

        this.upstreamReq.on('error', (err) => {
            console.error(`[CDN] Erro Origem: ${err.message}`);
            this.destroy();
        });

        this.upstreamReq.end();
    }

    addClient(res) {
        this.clients.add(res);
        if (this.headers) this.initClient(res);
        else this.once('ready', () => this.initClient(res));
        
        res.on('close', () => this.removeClient(res));
        res.on('error', () => this.removeClient(res));
    }

    removeClient(res) {
        if (this.clients.has(res)) {
            this.clients.delete(res);
            if (!res.writableEnded) res.end();
        }
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
        if (this.upstreamReq) {
            this.upstreamReq.destroy();
            this.upstreamReq = null;
        }
        this.clients.forEach(c => !c.writableEnded && c.end());
        this.clients.clear();
    }
}

// ==========================================
// ROTA PRINCIPAL
// ==========================================
app.get('/api', (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // Validação Token
    const { payload, expires, token, auth } = req.query;
    if (!payload || !expires || !token) return res.status(403).send("Erro");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("Exp");
    
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("Inv");

    // Decrypt URL
    let streamUrl;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let output = '';
        for (let i = 0; i < decoded.length; i++) output += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        streamUrl = output.split('|')[0];
    } catch (e) { return res.status(500).send("Err Dec"); }

    if (!streamUrl) return res.status(400).send("Err URL");

    // DECISÃO: MODO DIRETO (VOD/Range) ou MODO SMART (Live)
    // Em ambos os casos, a conexão é feita PELO SERVIDOR (Proxy). O cliente NUNCA conecta direto.
    const isVOD = streamUrl.match(/\.(mp4|mkv|avi|mov)$/i);
    const hasRange = req.headers.range;

    if (hasRange || isVOD) {
        // Modo Proxy Direto (Sem Deduplicação, mas COM Proteção de Origem)
        proxyDirect(streamUrl, req, res);
    } else {
        // Modo Smart (Com Deduplicação e Proteção de Origem)
        if (activeBroadcasts.has(streamUrl)) {
            activeBroadcasts.get(streamUrl).addClient(res);
        } else {
            const broadcaster = new SecureBroadcaster(streamUrl);
            activeBroadcasts.set(streamUrl, broadcaster);
            broadcaster.addClient(res);
            
            // Fallback SEGURO (Se falhar, usa Proxy Direto, nunca Redirect)
            broadcaster.once('error', () => {
                if (!res.headersSent) proxyDirect(streamUrl, req, res);
            });
        }
    }
});

// PROXY DIRETO (SEM REDIRECT PARA O CLIENTE)
function proxyDirect(url, clientReq, clientRes, redirects = 0) {
    if (redirects > 5) return clientRes.status(502).send("Loop");

    const targetUrl = parse(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
            'Accept': '*/*',
            ...(clientReq.headers.range && { 'Range': clientReq.headers.range })
        }
    }, (proxyRes) => {
        // SEGUIR REDIRECT INTERNAMENTE
        if ([301, 302, 303, 307].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const nextUrl = new URL(proxyRes.headers.location, url).toString();
            return proxyDirect(nextUrl, clientReq, clientRes, redirects + 1);
        }

        // Repassar conteúdo
        if (proxyRes.headers['content-type']) clientRes.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) clientRes.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) clientRes.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) clientRes.setHeader('Content-Range', proxyRes.headers['content-range']);
        
        clientRes.writeHead(proxyRes.statusCode);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', () => !clientRes.headersSent && clientRes.status(502).send("Err Proxy"));
    proxyReq.end();
}

app.get('*', (req, res) => res.status(404).send(`<html><head><title>404 Not Found</title></head><body bgcolor="white"><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
// SISTEMA DE BROADCAST (DEDUPLICAÇÃO BLINDADA)
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
        this.retryCount = 0;
        
        this.connect();
    }

    connect() {
        console.log(`[CDN] Iniciando Nova Transmissão: ${this.url}`);
        const targetUrl = parse(this.url);
        const lib = targetUrl.protocol === 'https:' ? https : http;

        this.upstreamReq = lib.request(this.url, {
            method: 'GET',
            headers: {
                'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
                'Accept': '*/*'
            }
        }, (res) => {
            // Se for Redirect, aborta o modo Smart (deixa o cliente tentar direto)
            if ([301, 302, 303, 307].includes(res.statusCode)) {
                this.emit('error', new Error('Redirect'));
                this.destroy();
                return;
            }

            this.headers = res.headers;
            this.statusCode = res.statusCode;

            // Avisa quem estava esperando
            this.emit('ready', { headers: this.headers, statusCode: this.statusCode });

            res.on('data', (chunk) => {
                // Distribui para todos os clientes conectados
                for (const client of this.clients) {
                    try {
                        // Se o cliente já fechou ou está cheio, ignora para não travar os outros
                        if (!client.writableEnded && !client.destroyed) {
                            client.write(chunk);
                        }
                    } catch (e) {
                        console.error("[CDN] Erro ao enviar para cliente:", e.message);
                        this.removeClient(client);
                    }
                }
            });

            res.on('end', () => this.destroy());
            res.on('error', (e) => {
                console.error("[CDN] Erro na Origem (Res):", e.message);
                this.destroy();
            });
        });

        this.upstreamReq.on('error', (err) => {
            console.error(`[CDN] Erro na Conexão Origem: ${err.message}`);
            this.destroy();
        });

        this.upstreamReq.end();
    }

    addClient(res) {
        this.clients.add(res);
        
        // Se já temos headers, envia agora
        if (this.headers) {
            this.initClient(res);
        } else {
            // Se não, espera ficar pronto
            this.once('ready', () => this.initClient(res));
        }

        // Limpeza automática se o cliente sair
        res.on('close', () => this.removeClient(res));
        res.on('error', () => this.removeClient(res));
    }

    removeClient(res) {
        if (this.clients.has(res)) {
            this.clients.delete(res);
            if (!res.writableEnded) res.end();
        }
        
        // Se zero clientes, fecha a conexão com a origem para economizar
        if (this.clients.size === 0) {
            console.log(`[CDN] Zero espectadores. Encerrando transmissão: ${this.url}`);
            this.destroy();
        }
    }

    initClient(res) {
        if (res.headersSent) return;
        
        // Copia headers essenciais da origem
        if (this.headers['content-type']) res.setHeader('Content-Type', this.headers['content-type']);
        
        // CORS e Configurações de Stream
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Connection', 'keep-alive');
        
        res.writeHead(this.statusCode || 200);
    }

    destroy() {
        activeBroadcasts.delete(this.url);
        if (this.upstreamReq) {
            this.upstreamReq.destroy();
            this.upstreamReq = null;
        }
        // Encerra todos os clientes suavemente
        this.clients.forEach(client => {
            if (!client.writableEnded) client.end();
        });
        this.clients.clear();
    }
}

// ==========================================
// ROTA PRINCIPAL
// ==========================================
app.get('/api', (req, res) => {
    // 1. Configurações de CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { payload, expires, token, auth } = req.query;

    // 2. Validações
    if (!payload || !expires || !token) return res.status(403).send("Erro: Parametros ausentes");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("Erro: Token expirado");

    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("Erro: Assinatura invalida");

    // 3. Descriptografar URL
    let streamUrl;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let output = '';
        for (let i = 0; i < decoded.length; i++) {
            output += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        streamUrl = output.split('|')[0];
    } catch (e) {
        return res.status(500).send("Erro: Falha na descriptografia");
    }

    if (!streamUrl) return res.status(400).send("Erro: URL invalida");

    // ==========================================
    // LÓGICA DE DECISÃO: CACHE vs DIRETO
    // ==========================================
    
    // Regra: Se pedir RANGE (pedaço) ou for VOD (arquivo fechado), VAI DIRETO.
    // Isso evita travar filmes ou trocas rápidas.
    const isVOD = streamUrl.match(/\.(mp4|mkv|avi|mov)$/i);
    const hasRange = req.headers.range;

    if (hasRange || isVOD) {
        // MODO DIRETO (1 Cliente = 1 Conexão)
        proxyDirect(streamUrl, req, res);
    } else {
        // MODO CACHE/DEDUPLICAÇÃO (1000 Clientes = 1 Conexão)
        if (activeBroadcasts.has(streamUrl)) {
            // Já existe? Entra na sala!
            const broadcaster = activeBroadcasts.get(streamUrl);
            broadcaster.addClient(res);
        } else {
            // Não existe? Cria a sala!
            const broadcaster = new SecureBroadcaster(streamUrl);
            activeBroadcasts.set(streamUrl, broadcaster);
            broadcaster.addClient(res);

            // Se der erro ao criar, tenta o modo direto como fallback
            broadcaster.once('error', () => {
                if (!res.headersSent) proxyDirect(streamUrl, req, res);
            });
        }
    }
});

function proxyDirect(url, clientReq, clientRes, redirects = 0) {
    if (redirects > 5) return clientRes.status(502).send("Loop Redirect");

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

    proxyReq.on('error', (err) => {
        if (!clientRes.headersSent) clientRes.status(502).send("Erro Proxy Direto");
    });

    proxyReq.end();
}

app.get('*', (req, res) => {
    res.status(404).send(`<html><head><title>404 Not Found</title></head><body bgcolor="white"><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

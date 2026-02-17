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
// SMART RESTREAM ENGINE (HÍBRIDO)
// ==========================================
// Armazena apenas transmissões contínuas (Live TV)
const activeStreams = new Map();

class StreamBroadcaster extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.clients = new Set();
        this.headers = null;
        this.statusCode = null;
        this.upstreamReq = null;
        this.started = false;
        
        this.connect();
    }

    connect() {
        console.log(`[Smart Restream] Iniciando Conexão Mestre: ${this.url}`);
        const targetUrl = parse(this.url);
        const lib = targetUrl.protocol === 'https:' ? https : http;

        this.upstreamReq = lib.request(this.url, {
            method: 'GET',
            headers: {
                'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
                'Accept': '*/*'
            }
        }, (res) => {
            // Se for redirecionamento, não podemos deduplicar facilmente aqui.
            // O ideal seria seguir, mas para simplificar, vamos destruir e deixar o cliente tentar direto.
            if ([301, 302, 303, 307].includes(res.statusCode)) {
                console.log(`[Smart Restream] Redirect detectado. Abortando modo Smart.`);
                this.emit('error', new Error('Redirect'));
                this.destroy();
                return;
            }

            this.headers = res.headers;
            this.statusCode = res.statusCode;
            this.started = true;

            // Enviar headers para quem já estava esperando
            this.clients.forEach(resClient => this.initClient(resClient));

            res.on('data', (chunk) => {
                // Transmitir para todos os clientes conectados
                for (const client of this.clients) {
                    client.write(chunk);
                }
            });

            res.on('end', () => this.destroy());
            res.on('error', () => this.destroy());
        });

        this.upstreamReq.on('error', (err) => {
            console.error(`[Smart Restream] Erro na Origem: ${err.message}`);
            this.destroy();
        });

        this.upstreamReq.end();
    }

    addClient(res) {
        this.clients.add(res);
        if (this.started) {
            this.initClient(res);
        }
        
        // Se o cliente desconectar, removemos da lista
        res.on('close', () => {
            this.clients.delete(res);
            // Se não tiver mais ninguém assistindo, fecha a conexão com a origem
            if (this.clients.size === 0) {
                console.log(`[Smart Restream] Zero clientes. Fechando Mestre.`);
                this.destroy();
            }
        });
    }

    initClient(res) {
        if (res.headersSent) return;
        
        // Repassar headers importantes
        if (this.headers['content-type']) res.setHeader('Content-Type', this.headers['content-type']);
        
        // Não enviar Content-Length em stream compartilhado (pois é contínuo)
        res.setHeader('Transfer-Encoding', 'chunked'); 
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        res.writeHead(this.statusCode || 200);
    }

    destroy() {
        activeStreams.delete(this.url);
        if (this.upstreamReq) {
            this.upstreamReq.destroy();
            this.upstreamReq = null;
        }
        this.clients.forEach(client => client.end());
        this.clients.clear();
        this.removeAllListeners();
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
    // DECISÃO INTELIGENTE: PROXY DIRETO OU SMART?
    // ==========================================
    
    // Se o player pediu um "Range" (Pedaço do vídeo) ou é VOD (.mp4/.mkv), 
    // NÃO podemos deduplicar. Tem que ser Proxy Direto (Estável).
    const isVOD = streamUrl.match(/\.(mp4|mkv|avi|mov)$/i);
    const hasRange = req.headers.range;

    if (hasRange || isVOD) {
        // MODO 1: PROXY DIRETO (Estável para VOD/Troca de Canal)
        // console.log(`[Mode: Direct] Cliente pediu Range ou é VOD: ${streamUrl}`);
        proxyRequest(streamUrl, req, res);
    } else {
        // MODO 2: SMART RESTREAM (Economia para Live TV)
        // console.log(`[Mode: Smart] Cliente em Live TV: ${streamUrl}`);
        
        if (activeStreams.has(streamUrl)) {
            // Pega carona na transmissão existente!
            const broadcaster = activeStreams.get(streamUrl);
            broadcaster.addClient(res);
        } else {
            // Cria nova transmissão mestre
            const broadcaster = new StreamBroadcaster(streamUrl);
            activeStreams.set(streamUrl, broadcaster);
            broadcaster.addClient(res);
            
            // Fallback: Se der erro no Smart, tenta Direct
            broadcaster.on('error', () => {
                if (!res.headersSent) proxyRequest(streamUrl, req, res);
            });
        }
    }
});

// Função de Proxy Direto (Fallback e VOD)
function proxyRequest(url, clientReq, clientRes, redirects = 0) {
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
            return proxyRequest(new URL(proxyRes.headers.location, url).toString(), clientReq, clientRes, redirects + 1);
        }

        if (proxyRes.headers['content-type']) clientRes.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) clientRes.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) clientRes.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) clientRes.setHeader('Content-Range', proxyRes.headers['content-range']);
        
        clientRes.writeHead(proxyRes.statusCode);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        if (!clientRes.headersSent) clientRes.status(502).send("Erro Proxy");
    });

    proxyReq.end();
}

app.get('*', (req, res) => {
    res.status(404).send(`<html><head><title>404 Not Found</title></head><body bgcolor="white"><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>`);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

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
// SMART RESTREAM ENGINE (Deduplicação)
// ==========================================
// Armazena conexões ativas: URL -> { req, res, headers, statusCode, emitter, clients }
const activeStreams = new Map();

class StreamHandler extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.headers = null;
        this.statusCode = null;
        this.ready = false;
        this.upstreamReq = null;
        this.lastActivity = Date.now();
        
        this.start();
    }

    start() {
        const targetUrl = parse(this.url);
        const lib = targetUrl.protocol === 'https:' ? https : http;

        console.log(`[Smart Restream] Iniciando conexão com Origem: ${this.url}`);

        this.upstreamReq = lib.request(this.url, {
            method: 'GET',
            headers: {
                'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
                'Accept': '*/*'
            }
        }, (res) => {
            this.headers = res.headers;
            this.statusCode = res.statusCode;
            this.ready = true;

            // Avisa todos os clientes que os headers chegaram
            this.emit('headers', { headers: this.headers, statusCode: this.statusCode });

            res.on('data', (chunk) => {
                this.lastActivity = Date.now();
                this.emit('data', chunk);
            });

            res.on('end', () => {
                this.emit('end');
                this.destroy();
            });

            res.on('error', (err) => {
                this.emit('error', err);
                this.destroy();
            });
        });

        this.upstreamReq.on('error', (err) => {
            console.error(`[Smart Restream] Erro na Origem: ${err.message}`);
            this.emit('error', err);
            this.destroy();
        });

        this.upstreamReq.end();
    }

    destroy() {
        if (activeStreams.has(this.url)) {
            activeStreams.delete(this.url);
            console.log(`[Smart Restream] Fechando conexão com Origem: ${this.url}`);
        }
        if (this.upstreamReq) {
            this.upstreamReq.destroy();
        }
        this.removeAllListeners();
    }
}

// ==========================================
// ROTAS DO SERVIDOR
// ==========================================

// 1. Rota de Proxy com Smart Restream
app.get('/api', (req, res) => {
    const { payload, expires, token, auth } = req.query;

    // Validações Básicas
    if (!payload || !expires || !token) return res.status(403).send("Erro: Parametros ausentes");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("Erro: Token expirado");

    // Validar Assinatura HMAC
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("Erro: Assinatura invalida");

    // Descriptografar URL
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

    // LÓGICA DE DEDUPLICAÇÃO
    let handler;

    if (activeStreams.has(streamUrl)) {
        // Se já existe, pega carona!
        handler = activeStreams.get(streamUrl);
        console.log(`[Smart Restream] Cliente conectado a stream existente (Cache Hit)`);
    } else {
        // Se não existe, cria nova conexão
        handler = new StreamHandler(streamUrl);
        activeStreams.set(streamUrl, handler);
    }

    // Função para enviar headers para o cliente
    const sendHeaders = (data) => {
        if (res.headersSent) return;
        
        // Copiar headers importantes
        const keys = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
        keys.forEach(k => {
            if (data.headers[k]) res.setHeader(k, data.headers[k]);
        });
        // Forçar CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        
        res.writeHead(data.statusCode || 200);
    };

    // Se a stream já começou e tem headers, envia agora
    if (handler.ready && handler.headers) {
        sendHeaders({ headers: handler.headers, statusCode: handler.statusCode });
    } else {
        // Se não, espera o evento 'headers'
        handler.once('headers', sendHeaders);
    }

    // Conectar eventos de dados
    const dataListener = (chunk) => res.write(chunk);
    const endListener = () => res.end();
    const errorListener = () => res.end();

    handler.on('data', dataListener);
    handler.on('end', endListener);
    handler.on('error', errorListener);

    // Quando o cliente desconectar
    req.on('close', () => {
        handler.removeListener('data', dataListener);
        handler.removeListener('end', endListener);
        handler.removeListener('error', errorListener);
        handler.removeListener('headers', sendHeaders);
        
        // Se não tiver mais ninguém ouvindo essa stream, fecha a conexão com a origem
        if (handler.listenerCount('data') === 0) {
            handler.destroy();
        }
    });
});

// 2. Rota Raiz (Disfarce Nginx 404)
app.get('*', (req, res) => {
    res.status(404).send(`<html>
<head><title>404 Not Found</title></head>
<body bgcolor="white">
<center><h1>404 Not Found</h1></center>
<hr><center>nginx</center>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

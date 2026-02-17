const express = require('express');
const https = require('https');
const http = require('http');
const { parse, URL } = require('url');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = "VpsManagerStrongKey";

// ==========================================
// MODO ESTÁVEL (DIRECT PROXY)
// ==========================================

app.get('/api', async (req, res) => {
    // 1. Configurações de CORS (Essencial para Players)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Validação de Segurança
    const { payload, expires, token, auth } = req.query;

    if (!payload || !expires || !token) return res.status(403).send("Erro: Parametros ausentes");
    if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("Erro: Token expirado");

    // Validar Assinatura
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    if (token !== hmac.digest('hex')) return res.status(403).send("Erro: Assinatura invalida");

    // 3. Descriptografar URL Real
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

    // 4. Iniciar Proxy (Modo Pipe - Mais Rápido e Estável)
    proxyRequest(streamUrl, req, res);
});

// Função Auxiliar para Proxy e Redirects
function proxyRequest(url, clientReq, clientRes, redirects = 0) {
    if (redirects > 5) return clientRes.status(502).send("Erro: Loop de redirecionamento");

    const targetUrl = parse(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', // Disfarce
            'Accept': '*/*',
            // Repassa o Range para permitir "pular" o vídeo
            ...(clientReq.headers.range && { 'Range': clientReq.headers.range })
        }
    }, (proxyRes) => {
        // Seguir Redirects (301, 302) automaticamente
        if ([301, 302, 303, 307].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const nextUrl = new URL(proxyRes.headers.location, url).toString();
            return proxyRequest(nextUrl, clientReq, clientRes, redirects + 1);
        }

        // Repassar Headers Importantes
        if (proxyRes.headers['content-type']) clientRes.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) clientRes.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) clientRes.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) clientRes.setHeader('Content-Range', proxyRes.headers['content-range']);
        
        // Enviar Status e Dados
        clientRes.writeHead(proxyRes.statusCode);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        console.error('Erro Proxy:', err.message);
        if (!clientRes.headersSent) clientRes.status(502).send("Erro no Proxy");
    });

    proxyReq.end();
}

// Rota Raiz (Disfarce Nginx 404)
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

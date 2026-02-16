const https = require('https');
const http = require('http');
const { parse, URL } = require('url');
const crypto = require('crypto');

// Mantenha esta chave IGUAL à do seu painel PHP
const SECRET_KEY = "VpsManagerStrongKey";

module.exports = async (req, res) => {
    // 1. Configurações de CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. Ler Parâmetros
    const { payload, expires, token, auth } = parse(req.url, true).query;

    if (!payload || !expires || !token) {
        return res.status(403).send("Erro: Parametros ausentes");
    }

    if (Date.now() / 1000 > parseInt(expires)) {
        return res.status(403).send("Erro: Token expirado");
    }

    // 3. Validar Assinatura
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    const expectedToken = hmac.digest('hex');

    if (token !== expectedToken) {
        return res.status(403).send("Erro: Assinatura invalida");
    }

    // 4. Descriptografar URL
    let decodedString = '';
    try {
        const decodedBuffer = Buffer.from(payload, 'base64').toString('binary');
        for (let i = 0; i < decodedBuffer.length; i++) {
            decodedString += String.fromCharCode(decodedBuffer.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
    } catch (e) {
        return res.status(500).send("Erro: Falha na descriptografia");
    }

    const parts = decodedString.split('|');
    const streamUrl = parts[0];

    // 5. Iniciar Proxy com Proteção contra Redirects
    fetchStream(streamUrl, req, res);
};

// Função recursiva para seguir redirecionamentos (HTTP -> HTTPS)
function fetchStream(url, originalReq, clientRes, redirects = 0) {
    if (redirects > 5) {
        return clientRes.status(502).send("Erro: Muitos redirecionamentos na origem");
    }

    const targetUrl = parse(url);
    const lib = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(url, {
        method: 'GET',
        headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
            'Accept': '*/*',
            // Repassa o Range para permitir pular o vídeo
            ...(originalReq.headers.range && { 'Range': originalReq.headers.range })
        }
    }, (proxyRes) => {
        // Se a origem mandar redirecionar (301, 302), o Vercel segue, não o cliente!
        if ([301, 302, 303, 307].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            const nextUrl = new URL(proxyRes.headers.location, url).toString();
            console.log(`Seguindo redirect para: ${nextUrl}`);
            return fetchStream(nextUrl, originalReq, clientRes, redirects + 1);
        }

        // Se for vídeo real, repassa para o cliente
        if (proxyRes.headers['content-type']) clientRes.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) clientRes.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) clientRes.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) clientRes.setHeader('Content-Range', proxyRes.headers['content-range']);
        
        clientRes.writeHead(proxyRes.statusCode);
        proxyRes.pipe(clientRes);
    });

    proxyReq.on('error', (err) => {
        console.error('Erro Proxy:', err);
        if (!clientRes.headersSent) {
            clientRes.status(502).send("Erro no Proxy: " + err.message);
        }
    });

    proxyReq.end();
}

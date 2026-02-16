const https = require('https');
const http = require('http');
const { parse } = require('url');
const crypto = require('crypto');

// Mantenha esta chave IGUAL à do seu painel PHP (live.php)
const SECRET_KEY = "VpsManagerStrongKey";

module.exports = async (req, res) => {
    // 1. Configurações de CORS (Permitir Players Web/TV)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');

    // Responder rápido a pre-flight requests
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // 2. Ler Parâmetros da URL
    const { payload, expires, token, auth } = parse(req.url, true).query;

    if (!payload || !expires || !token) {
        return res.status(403).send("Erro: Parametros ausentes");
    }

    // 3. Verificar Expiração (Token vale por 12h)
    if (Date.now() / 1000 > parseInt(expires)) {
        return res.status(403).send("Erro: Token expirado");
    }

    // 4. Validar Assinatura de Segurança (HMAC)
    // O PHP gera: hash_hmac('sha256', $payload . $expires . $authUrl, $key);
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (auth || ''));
    const expectedToken = hmac.digest('hex');

    if (token !== expectedToken) {
        return res.status(403).send("Erro: Assinatura invalida");
    }

    // 5. Descriptografar a URL Real (XOR)
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
    const streamUrl = parts[0]; // URL Original do Vídeo

    if (!streamUrl) {
        return res.status(400).send("Erro: URL de video invalida");
    }

    // 6. FAZER O PROXY REAL (Streaming)
    // Ao invés de redirecionar (res.redirect), nós baixamos e repassamos o vídeo.
    
    const targetUrl = parse(streamUrl);
    const lib = targetUrl.protocol === 'https:' ? https : http;

    const proxyReq = lib.request(streamUrl, {
        method: 'GET',
        headers: {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18', // Disfarça como VLC para evitar bloqueios na origem
            'Accept': '*/*',
            // Repassar Range se o player pedir (para pular o vídeo)
            ...(req.headers.range && { 'Range': req.headers.range })
        }
    }, (proxyRes) => {
        // Repassar headers importantes da origem para o player
        if (proxyRes.headers['content-type']) res.setHeader('Content-Type', proxyRes.headers['content-type']);
        if (proxyRes.headers['content-length']) res.setHeader('Content-Length', proxyRes.headers['content-length']);
        if (proxyRes.headers['accept-ranges']) res.setHeader('Accept-Ranges', proxyRes.headers['accept-ranges']);
        if (proxyRes.headers['content-range']) res.setHeader('Content-Range', proxyRes.headers['content-range']);
        
        // Enviar status correto (200 ou 206 Partial Content)
        res.writeHead(proxyRes.statusCode);

        // PIPE: Conecta a torneira da origem direto no copo do cliente
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error('Erro no Proxy:', err);
        if (!res.headersSent) {
            res.status(502).send("Erro ao conectar na origem: " + err.message);
        }
    });

    proxyReq.end();
};

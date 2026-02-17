const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const SECRET_KEY = "VpsManagerStrongKey";
const PORT = process.env.PORT || 80;

const server = http.createServer((req, res) => {
    // 1. Validar Parâmetros Básicos
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        res.writeHead(400);
        res.end("Bad URL");
        return;
    }

    const payload = reqUrl.searchParams.get("payload");

    // Ignorar requisições sem payload (robôs/scanners)
    if (!payload) {
        // --- ADIÇÃO: Página Inicial com Status ---
        if (reqUrl.pathname === '/' || reqUrl.pathname === '/api' || reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end("Proxy is Running!");
            return;
        }
        // ----------------------------------------

        res.writeHead(404);
        res.end();
        return;
    }

    // 2. Decodificar Payload
    let targetUrl;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        targetUrl = result.split('|')[0];
    } catch (e) {
        res.writeHead(400);
        res.end("Bad Payload");
        return;
    }

    if (!targetUrl || !targetUrl.startsWith('http')) {
        res.writeHead(400);
        res.end("Invalid URL");
        return;
    }

    // 3. Proxy Puro (Pipe Direto)
    const target = new URL(targetUrl);
    const lib = target.protocol === 'https:' ? https : http;

    console.log(`[PROXY] ${targetUrl}`);

    const proxyReq = lib.request(targetUrl, {
        method: req.method,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
        },
        rejectUnauthorized: false
    }, (proxyRes) => {
        // Copiar status e headers importantes de forma SEGURA
        const headers = {
            'Access-Control-Allow-Origin': '*'
        };
        
        // CORREÇÃO CRÍTICA: Só define Content-Type se ele existir na resposta original
        // Isso evita o erro ERR_HTTP_INVALID_HEADER_VALUE que derrubava a máquina
        if (proxyRes.headers['content-type']) {
            headers['Content-Type'] = proxyRes.headers['content-type'];
        }

        res.writeHead(proxyRes.statusCode, headers);
        
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
        console.error(`[ERROR] ${err.message}`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
    });

    req.pipe(proxyReq);
});

server.listen(PORT, () => console.log(`Proxy Simple running on ${PORT}`));

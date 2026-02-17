const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const SECRET_KEY = "VpsManagerStrongKey"; // Mesma chave do PHP
const PORT = process.env.PORT || 8000;

const server = http.createServer((req, res) => {
    // 1. Validar e Decodificar a URL de Destino
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        res.writeHead(400);
        res.end("Bad URL");
        return;
    }

    const payload = reqUrl.searchParams.get("payload");

    if (!payload) {
        // Health Check / Root Page
        if (reqUrl.pathname === '/' || reqUrl.pathname === '/api' || reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end("Proxy is Running!");
            return;
        }

        // Resposta 404 discreta para scanners
        res.writeHead(404);
        res.end();
        return;
    }

    let targetUrl;
    try {
        // Decodifica Base64
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        // Decodifica XOR
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        // Pega a URL antes do pipe (se houver metadados extras)
        targetUrl = result.split('|')[0];
    } catch (e) {
        console.error("Erro na decodificação:", e.message);
        res.writeHead(400);
        res.end("Bad Payload");
        return;
    }

    if (!targetUrl || !targetUrl.startsWith('http')) {
        res.writeHead(400);
        res.end("Invalid Target URL");
        return;
    }

    // 2. Configurar o Proxy (Direct Pipe - Sem Cache/Deduplicação)
    const target = new URL(targetUrl);
    const lib = target.protocol === 'https:' ? https : http;

    // Headers para a origem (imita um player real)
    const options = {
        method: req.method,
        headers: {
            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        rejectUnauthorized: false // Importante para fontes com SSL inválido
    };

    const proxyReq = lib.request(targetUrl, options, (proxyRes) => {
        // Repassar Status Code
        // Ajustar Headers para CORS e Streaming
        const headers = {
            ...proxyRes.headers,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        };

        // Remove headers problemáticos de encoding que podem quebrar o player
        delete headers['content-length']; // Deixa o chunked transfer encoding cuidar disso
        
        res.writeHead(proxyRes.statusCode, headers);

        // Pipe direto: Origem -> Cliente (Máxima eficiência, menor latência)
        proxyRes.pipe(res);
    });

    // Tratamento de Erros
    proxyReq.on('error', (err) => {
        console.error(`Erro no Proxy para ${targetUrl}:`, err.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end("Bad Gateway");
        }
    });

    req.on('error', (err) => {
        console.error(`Erro na Requisição do Cliente:`, err.message);
        proxyReq.destroy();
    });

    // Timeout de conexão
    proxyReq.setTimeout(30000, () => {
        console.error(`Timeout na conexão com origem: ${targetUrl}`);
        proxyReq.destroy();
    });

    // Pipe do corpo da requisição (se houver, ex: POST)
    req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
    console.log(`Direct Proxy Server running on port ${PORT}`);
});

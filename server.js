const http = require('http');
const https = require('https');
const crypto = require('crypto');

// --- CONFIGURATION ---
const SECRET_KEY = "VpsManagerStrongKey"; // Mantenha igual ao config do PHP
const HTTP_PORT = process.env.PORT || 8000; // Render usa process.env.PORT

// --- HTTP SERVER ---
const server = http.createServer((req, res) => {
    // 1. CORS for Web Players
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Range, User-Agent, Authorization',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }

    // Parse URL
    // Fix para Render/Express: confiar no host header ou usar base relativa
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host;
    const fullUrl = `${protocol}://${host}${req.url}`;
    const url = new URL(fullUrl);
    
    const payload = url.searchParams.get("payload");
    const expires = url.searchParams.get("expires");
    const token = url.searchParams.get("token");
    const authUrl = url.searchParams.get("auth");

    // Health Check simples
    if (req.url === '/' || req.url === '/health') {
        res.writeHead(200);
        res.end('Proxy Online');
        return;
    }

    if (!payload || !expires || !token) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Missing parameters" }));
        return;
    }

    // 2. Validate Token
    if (Date.now() / 1000 > parseInt(expires)) {
        res.writeHead(403);
        res.end("Token Expired");
        return;
    }

    // Validate Signature
    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (authUrl || ""));
    const expectedToken = hmac.digest('hex');

    if (token !== expectedToken) {
        res.writeHead(403);
        res.end("Invalid Token Signature");
        return;
    }

    // 3. Decode Payload (XOR + Base64)
    let targetUrl, username, password;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        const parts = result.split('|');
        targetUrl = parts[0];
        username = parts[1];
        password = parts[2];
    } catch (e) {
        res.writeHead(400);
        res.end("Invalid Payload");
        return;
    }

    if (!targetUrl || !targetUrl.startsWith("http")) {
        res.writeHead(400);
        res.end("Invalid Target URL");
        return;
    }

    // --- HEARTBEAT / AUTH CHECK ---
    // Opcional: Chamar o authUrl para avisar que a conexão iniciou ou validar
    // No modelo atual, o live.php já validou. O proxy apenas transmite.
    
    // 4. Proxy Request
    const target = new URL(targetUrl);
    const options = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: {
            ...req.headers,
            'Host': target.host,
            // Forçar User-Agent padrão de player para evitar bloqueios na origem
            'User-Agent': 'XCIPTV (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36'
        }
    };
    
    // Limpar headers problemáticos
    delete options.headers['host'];
    delete options.headers['connection']; 

    const proxyReq = (target.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
        // Forward Headers e Status
        const headers = { ...proxyRes.headers };
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Content-Type';
        
        // Remove security headers que quebram players web
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
        console.error("Proxy Error:", e.message);
        if (!res.headersSent) {
            res.writeHead(502);
            res.end("Proxy Connection Error");
        }
    });

    // --- CORREÇÃO CRÍTICA: DETECTAR DESCONEXÃO DO CLIENTE ---
    req.on('close', () => {
        // Se o cliente (Roku/App) fechar a conexão, destruir a conexão com a origem IMEDIATAMENTE
        if (proxyReq) {
            proxyReq.destroy();
        }
    });

    // Pipe Request Body (caso seja POST, etc)
    req.pipe(proxyReq);
});

server.listen(HTTP_PORT, () => {
    console.log(`Proxy Server running on port ${HTTP_PORT}`);
});

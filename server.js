const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const path = require('path');

// --- CONFIGURATION ---
const SECRET_KEY = "VpsManagerStrongKey"; // Must match PHP
const HTTP_PORT = process.env.PORT || 8000; // Proxy Port
const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'vps_user',
    password: process.env.DB_PASSWORD || 'StrongPass123!',
    database: process.env.DB_NAME || 'vps_manager',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// --- DATABASE POOL ---
const pool = mysql.createPool(DB_CONFIG);

// --- HELPER: UPDATE CONNECTION STATUS ---
async function killConnection(username, clientIp, userAgent) {
    try {
        // Implementation kept for future use
    } catch (e) {
        console.error("DB Error:", e);
    }
}

// --- PROXY REQUEST HELPER ---
function proxyRequest(target, req, res, ua) {
    const options = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: {
            ...req.headers,
            'Host': target.host,
            'User-Agent': ua,
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        rejectUnauthorized: false, 
        family: 4 
    };
    
    delete options.headers['host'];
    delete options.headers['connection'];

    const proxyReq = (target.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
        const headers = { ...proxyRes.headers };
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Content-Type';
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
        if (!res.headersSent) {
            console.error(`[PROXY ERROR] Target: ${target.href} | Error: ${e.message}`);
            res.writeHead(502);
            res.end(`Proxy Connection Error: ${e.message}`);
        }
    });

    req.on('close', () => {
        if (proxyReq) {
            proxyReq.destroy();
        }
    });

    req.pipe(proxyReq);
}

// --- REQUEST HANDLER ---
const requestHandler = async (req, res) => {
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

    const url = new URL(req.url, `http://${req.headers.host}`);

    // --- SERVE STATIC FILES (index.html / 404.html) ---
    if (url.pathname === '/' || url.pathname === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(403); // Default to Forbidden if index missing
                res.end("403 Forbidden");
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
        return;
    }

    if (url.pathname === '/404.html') {
        fs.readFile(path.join(__dirname, '404.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end("404 Not Found");
                return;
            }
            res.writeHead(404, {'Content-Type': 'text/html'});
            res.end(data);
        });
        return;
    }

    const payload = url.searchParams.get("payload");
    const expires = url.searchParams.get("expires");
    const token = url.searchParams.get("token");
    const authUrl = url.searchParams.get("auth");

    if (!payload || !expires || !token) {
        // Se faltar parametros, mostra a pagina "Forbidden" (index.html) como disfarce
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Missing parameters" }));
                return;
            }
            res.writeHead(403, {'Content-Type': 'text/html'});
            res.end(data);
        });
        return;
    }

    // 2. Validate Token
    if (Date.now() / 1000 > parseInt(expires)) {
        res.writeHead(403);
        res.end("Token Expired");
        return;
    }

    const hmac = crypto.createHmac('sha256', SECRET_KEY);
    hmac.update(payload + expires + (authUrl || ""));
    const expectedToken = hmac.digest('hex');

    if (token !== expectedToken) {
        res.writeHead(403);
        res.end("Invalid Token Signature");
        return;
    }

    // 3. Decode Payload
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

    if (!targetUrl.startsWith("http")) {
        res.writeHead(400);
        res.end("Invalid Target URL");
        return;
    }

    // 4. Proxy Request
    const target = new URL(targetUrl);
    
    // --- CAMUFLAGEM USER-AGENT ---
    const spoofedUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

    // --- LÓGICA DE EXTRAÇÃO M3U8 (NODE.JS) ---
    const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes(".m3u");
    
    console.log(`[PROXY] Nova Requisição: ${targetUrl} | M3U8 Detectado: ${isM3U8}`);

    if (isM3U8) {
        console.log(`[PROXY] Iniciando extração de M3U8 para: ${targetUrl}`);
        const m3uOptions = {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: 'GET',
            headers: {
                'Host': target.host,
                'User-Agent': spoofedUA,
                'Accept': '*/*'
            },
            rejectUnauthorized: false,
            family: 4
        };

        const m3uReq = (target.protocol === 'https:' ? https : http).request(m3uOptions, (m3uRes) => {
            let data = '';
            m3uRes.on('data', (chunk) => data += chunk);
            m3uRes.on('end', () => {
                console.log(`[PROXY] M3U8 Baixado. Status: ${m3uRes.statusCode}. Tamanho: ${data.length}`);
                if (data.includes("#EXTM3U")) {
                    const lines = data.split('\n');
                    let tsUrl = "";
                    for (let line of lines) {
                        line = line.trim();
                        if (line && !line.startsWith("#")) {
                            tsUrl = line;
                            break;
                        }
                    }

                    if (tsUrl) {
                        console.log(`[PROXY] TS Extraído com sucesso: ${tsUrl}`);
                        if (!tsUrl.startsWith("http")) {
                            const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                            try {
                                tsUrl = new URL(tsUrl, base).href;
                            } catch (e) {
                                if (tsUrl.startsWith('/')) {
                                    tsUrl = target.origin + tsUrl;
                                } else {
                                    tsUrl = base + tsUrl;
                                }
                            }
                        }
                        
                        const tsTarget = new URL(tsUrl);
                        proxyRequest(tsTarget, req, res, spoofedUA);
                        return;
                    } else {
                        console.log(`[PROXY] Nenhuma linha válida encontrada no M3U8`);
                    }
                } else {
                    console.log(`[PROXY] Conteúdo não parece ser M3U8 válido (sem #EXTM3U)`);
                }
                proxyRequest(target, req, res, spoofedUA);
            });
        });
        
        m3uReq.on('error', (e) => {
            console.error(`[PROXY] Erro ao baixar M3U8: ${e.message}`);
            proxyRequest(target, req, res, spoofedUA);
        });
        
        m3uReq.end();
        return;
    }

    proxyRequest(target, req, res, spoofedUA);
};

// --- START SERVER ---
if (require.main === module) {
    const server = http.createServer(requestHandler);
    server.listen(HTTP_PORT, () => {
        console.log(`Proxy Server running on port ${HTTP_PORT}`);
    });
}

module.exports = requestHandler;

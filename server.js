const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

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

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
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
    const payload = url.searchParams.get("payload");
    const expires = url.searchParams.get("expires");
    const token = url.searchParams.get("token");
    const authUrl = url.searchParams.get("auth");

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
    // Se a URL original for M3U8 ou o payload indicar isso, tentamos extrair o TS primeiro.
    // Isso é crucial para players como IBO Player que pedem .ts mas a fonte é .m3u8
    const isM3U8 = targetUrl.includes(".m3u8") || targetUrl.includes(".m3u");
    
    console.log(`[PROXY] Nova Requisição: ${targetUrl} | M3U8 Detectado: ${isM3U8}`);

    if (isM3U8) {
        console.log(`[PROXY] Iniciando extração de M3U8 para: ${targetUrl}`);
        // Tenta baixar o m3u8 primeiro para extrair o TS
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
                        // Resolver URL relativa
                        if (!tsUrl.startsWith("http")) {
                            const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
                            try {
                                tsUrl = new URL(tsUrl, base).href;
                            } catch (e) {
                                // Fallback manual se URL falhar
                                if (tsUrl.startsWith('/')) {
                                    tsUrl = target.origin + tsUrl;
                                } else {
                                    tsUrl = base + tsUrl;
                                }
                            }
                        }
                        
                        // Agora fazemos o proxy do TS REAL
                        const tsTarget = new URL(tsUrl);
                        proxyRequest(tsTarget, req, res, spoofedUA);
                        return;
                    } else {
                        console.log(`[PROXY] Nenhuma linha válida encontrada no M3U8`);
                    }
                } else {
                    console.log(`[PROXY] Conteúdo não parece ser M3U8 válido (sem #EXTM3U)`);
                }
                // Se falhar na extração, faz proxy da URL original
                proxyRequest(target, req, res, spoofedUA);
            });
        });
        
        m3uReq.on('error', (e) => {
            console.error(`[PROXY] Erro ao baixar M3U8: ${e.message}`);
            // Se der erro ao baixar m3u8, tenta proxy direto
            proxyRequest(target, req, res, spoofedUA);
        });
        
        m3uReq.end();
        return;
    }

    // Se não for M3U8, proxy direto
    proxyRequest(target, req, res, spoofedUA);
});

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
        // Forward Status
        const headers = { ...proxyRes.headers };
        headers['Access-Control-Allow-Origin'] = '*';
        headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Content-Type';
        delete headers['content-security-policy'];
        delete headers['x-frame-options'];

        // Se for M3U8 forçado para TS, ajusta content-type
        // Mas como já extraímos o TS antes (se for o caso), o content-type deve vir certo da origem
        
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

    // --- CRITICAL: HANDLE CLIENT DISCONNECT ---
    req.on('close', () => {
        if (proxyReq) {
            proxyReq.destroy(); // Kill upstream connection immediately
        }
    });

    // Pipe Request Body (for POSTs)
    req.pipe(proxyReq);
}

server.listen(HTTP_PORT, () => {
    console.log(`Proxy Server running on port ${HTTP_PORT}`);
});

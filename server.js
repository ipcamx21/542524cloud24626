const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

// --- CONFIGURATION ---
const SECRET_KEY = "VpsManagerStrongKey";
const HTTP_PORT = process.env.PORT || 8000;
const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'vps_user',
    password: process.env.DB_PASSWORD || 'StrongPass123!',
    database: process.env.DB_NAME || 'vps_manager',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

// --- HTTP SERVER ---
const server = http.createServer(async (req, res) => {
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

    let targetUrl;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        const parts = result.split('|');
        targetUrl = parts[0];
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

    const target = new URL(targetUrl);
    
    // --- CAMUFLAGEM VLC ---
    const spoofedUA = 'VLC/3.0.18 LibVLC/3.0.18';

    const options = {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers: {
            ...req.headers,
            'Host': target.host,
            'User-Agent': spoofedUA // FINGE SER VLC
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
            console.error(`[PROXY ERROR] Target: ${targetUrl} | Error: ${e.message}`);
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
});

server.listen(HTTP_PORT, () => {
    console.log(`Proxy Server running on port ${HTTP_PORT}`);
});

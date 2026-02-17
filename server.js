const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 8880;
const PANEL_URL = process.env.PANEL_URL || 'http://playagr.sbs';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });

console.log(`Proxy ligado na porta ${PORT}`);
console.log(`Painel de backend: ${PANEL_URL}`);

http.createServer((req, res) => {
    try {
        if (!req.url || req.url === '/' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('Proxy Online');
            return;
        }

        const backendUrl = new URL(req.url, PANEL_URL);
        const lib = backendUrl.protocol === 'https:' ? https : http;
        const agent = backendUrl.protocol === 'https:' ? httpsAgent : httpAgent;

        const headers = {
            ...req.headers,
            host: backendUrl.host,
            'x-from-proxy': '1'
        };

        console.log(`[PROXY] ${req.method} ${backendUrl.toString()}`);

        const proxyReq = lib.request(backendUrl, {
            method: req.method,
            headers,
            agent,
            timeout: 60000
        }, (proxyRes) => {
            const respHeaders = { ...proxyRes.headers, 'Access-Control-Allow-Origin': '*' };
            res.writeHead(proxyRes.statusCode || 502, respHeaders);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error(`[PROXY ERRO] ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end('Bad Gateway');
            }
        });

        proxyReq.on('timeout', () => {
            console.error(`[TIMEOUT] Painel lento: ${backendUrl.toString()}`);
            proxyReq.destroy();
        });

        req.on('close', () => {
            if (!proxyReq.destroyed) proxyReq.destroy();
        });

        req.pipe(proxyReq);
    } catch (e) {
        console.error(`[CRITICAL] ${e.message}`);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Error');
        }
    }
}).listen(PORT, () => {
    console.log(`Servidor pronto na porta ${PORT}`);
});

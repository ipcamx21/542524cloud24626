const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 8880;
const PANEL_BASE = process.env.PANEL_BASE || 'https://playagr.sbs';

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

http.createServer((req, res) => {
    try {
        const base = `http://${req.headers.host || 'localhost'}`;
        const url = new URL(req.url || '/', base);

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400'
            });
            res.end();
            return;
        }

        if (url.pathname === '/' || url.pathname === '/health') {
            sendJson(res, 200, { status: 'online' });
            return;
        }

        const match = url.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/([^\.]+)\.(ts|m3u8|mp4|mkv)$/i);
        if (!match) {
            sendJson(res, 404, { error: 'not_found' });
            return;
        }

        const upstreamUrl = new URL(url.pathname + url.search, PANEL_BASE);
        const lib = upstreamUrl.protocol === 'https:' ? https : http;

        const headers = {};
        if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
        else headers['User-Agent'] = 'Mozilla/5.0';
        headers['Accept'] = '*/*';
        if (req.headers['range']) headers['Range'] = req.headers['range'];
        headers['Host'] = upstreamUrl.host;

        const upstreamReq = lib.request(upstreamUrl, {
            method: 'GET',
            headers,
            timeout: 60000
        }, upstreamRes => {
            const respHeaders = Object.assign({}, upstreamRes.headers);
            respHeaders['Access-Control-Allow-Origin'] = '*';
            res.writeHead(upstreamRes.statusCode || 502, respHeaders);
            upstreamRes.pipe(res);
        });

        upstreamReq.on('error', err => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Proxy Error');
            }
        });

        upstreamReq.on('timeout', () => {
            upstreamReq.destroy();
        });

        req.on('close', () => {
            if (!upstreamReq.destroyed) upstreamReq.destroy();
        });

        upstreamReq.end();
    } catch (e) {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Error');
        }
    }
}).listen(PORT, () => {
    console.log(`Proxy listening on ${PORT}`);
});

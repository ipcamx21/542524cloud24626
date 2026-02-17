const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 8880;
const SECRET = process.env.PROXY_TOKEN_SECRET || 'w5p_proxy_secret_2026';

function quickGet(urlStr) {
    try {
        const u = new URL(urlStr);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u, { method: 'GET', timeout: 1500 }, (r) => {
            r.on('data', () => {});
            r.on('end', () => {});
        });
        req.on('error', () => {});
        req.on('timeout', () => { req.destroy(); });
        req.end();
    } catch (_) {}
}

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

function base64urlEncode(buf) {
    return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function decodeToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const payloadB64 = parts[0];
    const sigB64 = parts[1];
    let expected;
    try {
        const hmac = crypto.createHmac('sha256', SECRET);
        hmac.update(payloadB64);
        expected = base64urlEncode(hmac.digest());
    } catch (e) {
        return null;
    }
    const a = Buffer.from(sigB64);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    let json;
    try {
        const buf = base64urlDecode(payloadB64);
        json = JSON.parse(buf.toString('utf8'));
    } catch (e) {
        return null;
    }
    if (!json || typeof json.u !== 'string') return null;
    if (json.exp && typeof json.exp === 'number') {
        const now = Math.floor(Date.now() / 1000);
        if (now > json.exp) return null;
    }
    return json;
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

        if (url.pathname === '/health') {
            sendJson(res, 200, { status: 'online' });
            return;
        }

        const liveMatch = url.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/([^/.]+)\.(ts|m3u8)$/i);
        if (!liveMatch) {
            sendJson(res, 400, { error: 'invalid_path' });
            return;
        }

        const token = url.searchParams.get('token');
        const decoded = decodeToken(token);
        if (!decoded) {
            sendJson(res, 400, { error: 'invalid_token' });
            return;
        }

        const target = decoded.u;
        const cid = decoded.cid ? parseInt(decoded.cid, 10) : 0;
        const authUrl = typeof decoded.auth === 'string' ? decoded.auth : null;
        const username = liveMatch[1];
        const password = liveMatch[2];

        let upstreamUrl;
        try {
            upstreamUrl = new URL(target);
        } catch (e) {
            sendJson(res, 400, { error: 'bad_upstream_url' });
            return;
        }

        const lib = upstreamUrl.protocol === 'https:' ? https : http;

        let hbInterval = null;
        if (cid > 0 && authUrl) {
            const updateUrl = `${authUrl}?action=update&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
            quickGet(updateUrl);
            hbInterval = setInterval(() => quickGet(updateUrl), 20000);
        }

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
            upstreamRes.on('close', () => {
                if (cid > 0 && authUrl) {
                    const delUrl = `${authUrl}?action=delete&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
                    quickGet(delUrl);
                }
            });
        });

        upstreamReq.on('error', () => {
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
            if (cid > 0 && authUrl) {
                const delUrl = `${authUrl}?action=delete&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
                quickGet(delUrl);
                if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
            }
        });

        res.on('close', () => {
            if (cid > 0 && authUrl) {
                const delUrl = `${authUrl}?action=delete&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
                quickGet(delUrl);
                if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
            }
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

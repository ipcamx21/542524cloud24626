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
            // drain and ignore
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

const streamPool = new Map();

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

        let hbInterval = null;
        if (cid > 0 && authUrl) {
            const updateUrl = `${authUrl}?action=update&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
            quickGet(updateUrl);
            hbInterval = setInterval(() => quickGet(updateUrl), 20000);
        }

        const key = upstreamUrl.toString();

        let stream = streamPool.get(key);
        if (!stream) {
            stream = {
                url: upstreamUrl,
                statusCode: null,
                headers: null,
                clients: new Set(),
                upstreamReq: null,
                ended: false
            };
            streamPool.set(key, stream);

            function startRequest(currentUrl, redirectCount) {
                const lib = currentUrl.protocol === 'https:' ? https : http;
                const headers = {};
                if (req.headers['user-agent']) headers['User-Agent'] = req.headers['user-agent'];
                else headers['User-Agent'] = 'Mozilla/5.0';
                headers['Accept'] = '*/*';
                headers['Host'] = currentUrl.host;

                stream.upstreamReq = lib.request(currentUrl, {
                    method: 'GET',
                    headers,
                    timeout: 60000
                }, upstreamRes => {
                    const statusCode = upstreamRes.statusCode || 0;
                    if (statusCode >= 300 && statusCode < 400 && upstreamRes.headers.location && redirectCount < 5) {
                        let nextUrl;
                        try {
                            nextUrl = new URL(upstreamRes.headers.location, currentUrl);
                        } catch (e) {
                            stream.clients.forEach(c => {
                                if (!c.res.headersSent) c.res.writeHead(502, { 'Content-Type': 'text/plain' });
                                c.res.end('Bad redirect');
                            });
                            streamPool.delete(key);
                            return;
                        }
                        upstreamRes.resume();
                        startRequest(nextUrl, redirectCount + 1);
                        return;
                    }

                    stream.statusCode = statusCode || 502;
                    stream.headers = Object.assign({}, upstreamRes.headers, {
                        'Access-Control-Allow-Origin': '*'
                    });

                    stream.clients.forEach(c => {
                        if (!c.headersSent) {
                            c.res.writeHead(stream.statusCode, stream.headers);
                            c.headersSent = true;
                        }
                    });

                    upstreamRes.on('data', chunk => {
                        stream.clients.forEach(c => {
                            if (!c.closed) {
                                try {
                                    c.res.write(chunk);
                                } catch (_) {
                                    c.closed = true;
                                    c.res.end();
                                }
                            }
                        });
                    });

                    upstreamRes.on('end', () => {
                        stream.ended = true;
                        stream.clients.forEach(c => {
                            if (!c.closed) {
                                c.res.end();
                                c.closed = true;
                            }
                        });
                        streamPool.delete(key);
                    });

                    upstreamRes.on('error', () => {
                        stream.clients.forEach(c => {
                            if (!c.closed) {
                                if (!c.res.headersSent) {
                                    c.res.writeHead(502, { 'Content-Type': 'text/plain' });
                                }
                                c.res.end('Proxy Error');
                                c.closed = true;
                            }
                        });
                        streamPool.delete(key);
                    });
                });

                stream.upstreamReq.on('error', () => {
                    stream.clients.forEach(c => {
                        if (!c.closed) {
                            if (!c.res.headersSent) {
                                c.res.writeHead(502, { 'Content-Type': 'text/plain' });
                            }
                            c.res.end('Proxy Error');
                            c.closed = true;
                        }
                    });
                    streamPool.delete(key);
                });

                stream.upstreamReq.on('timeout', () => {
                    stream.upstreamReq.destroy();
                });

                stream.upstreamReq.end();
            }

        startRequest(upstreamUrl, 0);
        }

        const client = { res, headersSent: false, closed: false };
        stream.clients.add(client);

        if (stream.headers && !client.headersSent) {
            res.writeHead(stream.statusCode, stream.headers);
            client.headersSent = true;
        }

        function detachClient() {
            if (client.closed) return;
            client.closed = true;
            try { res.end(); } catch (_) {}
            stream.clients.delete(client);
            if (stream.clients.size === 0) {
                if (stream.upstreamReq && !stream.upstreamReq.destroyed) {
                    stream.upstreamReq.destroy();
                }
                streamPool.delete(key);
            }
        }

        req.on('close', () => {
            detachClient();
            if (cid > 0 && authUrl) {
                const delUrl = `${authUrl}?action=delete&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
                quickGet(delUrl);
                if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
            }
        });

        res.on('close', () => {
            detachClient();
            if (cid > 0 && authUrl) {
                const delUrl = `${authUrl}?action=delete&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&cid=${cid}`;
                quickGet(delUrl);
                if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
            }
        });
    } catch (e) {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Error');
        }
    }
}).listen(PORT, () => {
    console.log(`Proxy listening on ${PORT}`);
});

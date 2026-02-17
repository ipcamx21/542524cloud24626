const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const SECRET_KEY = "VpsManagerStrongKey";
const PORT = process.env.PORT || 8880;

const server = http.createServer(async (req, res) => {
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
        if (reqUrl.pathname === '/' || reqUrl.pathname === '/api' || reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end("Proxy is Running!");
            return;
        }
        res.writeHead(404);
        res.end();
        return;
    }

    let targetUrl, username, password;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        const parts = result.split('|');
        targetUrl = parts[0];
        username = parts[1] || "";
        password = parts[2] || "";
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

    const expires = reqUrl.searchParams.get("expires");
    if (expires) {
        if (Date.now() / 1000 > parseInt(expires)) {
            res.writeHead(403);
            res.end("Link Expired");
            return;
        }
    }

    const authUrlStr = reqUrl.searchParams.get("auth");
    let connectionId = 0;

    if (authUrlStr && username && password) {
        try {
            const authTarget = new URL(authUrlStr);
            authTarget.searchParams.set("username", username);
            authTarget.searchParams.set("password", password);
            authTarget.searchParams.set("action", "check");

            if (authTarget.searchParams.has('cid')) {
                connectionId = authTarget.searchParams.get('cid');
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const authRes = await fetch(authTarget.toString(), {
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (authRes.status !== 200) {
                res.writeHead(403);
                res.end("Access Denied");
                return;
            }

            if (connectionId > 0) {
                const heartbeatInterval = setInterval(() => {
                    const hbUrl = new URL(authUrlStr);
                    hbUrl.searchParams.set("username", username);
                    hbUrl.searchParams.set("password", password);
                    hbUrl.searchParams.set("action", "update");
                    fetch(hbUrl.toString()).catch(() => {});
                }, 30000);

                res.on('close', () => {
                    clearInterval(heartbeatInterval);
                    const delUrl = new URL(authUrlStr);
                    delUrl.searchParams.set("username", username);
                    delUrl.searchParams.set("password", password);
                    delUrl.searchParams.set("action", "delete");
                    fetch(delUrl.toString()).catch(() => {});
                });
            }

        } catch (e) {
            res.writeHead(502);
            res.end("Auth Server Unavailable");
            return;
        }
    }

    async function streamM3u8AsTs(playlistUrl) {
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*'
        });
        let stopped = false;
        res.on('close', () => { stopped = true; });
        const seen = new Set();
        const base = new URL(playlistUrl);
        while (!stopped) {
            let text = "";
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const r = await fetch(playlistUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                text = await r.text();
            } catch {
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            const lines = text.split(/\r?\n/);
            const segs = [];
            for (const ln of lines) {
                const line = ln.trim();
                if (!line || (line[0] === '#')) continue;
                segs.push(line);
            }
            for (const s of segs) {
                if (stopped) break;
                if (seen.has(s)) continue;
                seen.add(s);
                const u = new URL(s, base);
                await new Promise((resolve) => {
                    const lib = u.protocol === 'https:' ? https : http;
                    const segmentReq = lib.get(u.toString(), {
                        headers: {
                            'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Accept': '*/*'
                        },
                        rejectUnauthorized: false
                    }, (segmentRes) => {
                        segmentRes.on('error', () => resolve());
                        segmentRes.pipe(res, { end: false });
                        segmentRes.on('end', () => resolve());
                    });
                    segmentReq.on('error', () => resolve());
                    segmentReq.setTimeout(120000, () => { try { segmentReq.destroy(); } catch {} resolve(); });
                });
            }
            await new Promise(r => setTimeout(r, 1500));
        }
    }

    const forceFormat = reqUrl.searchParams.get("force_format");
    const reqIsM3u8 = reqUrl.pathname.includes('.m3u8');
    const reqIsTs = reqUrl.pathname.includes('.ts') || reqUrl.pathname.includes('/mpegts') || (reqUrl.searchParams.get('ext') === 'ts');

    if ((forceFormat === 'ts' || (!forceFormat && reqIsTs)) && (targetUrl.includes('.m3u8'))) {
        await streamM3u8AsTs(targetUrl);
        return;
    }

    if ((forceFormat === 'm3u8' || (!forceFormat && reqIsM3u8)) && (!targetUrl.includes('.m3u8'))) {
        const selfUrl = new URL(req.url, `http://${req.headers.host}`);
        selfUrl.searchParams.set("force_format", "ts");
        if (selfUrl.pathname.endsWith('.m3u8')) {
            selfUrl.pathname = selfUrl.pathname.slice(0, -5) + 'ts';
        }
        const playlist = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:6",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXTINF:6,",
            selfUrl.toString()
        ].join("\n");
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(playlist);
        return;
    }

    function doProxyRequest(currentUrl, redirectCount = 0) {
        if (redirectCount > 5) {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end("Too Many Redirects");
            }
            return;
        }

        const target = new URL(currentUrl);
        const lib = target.protocol === 'https:' ? https : http;

        const proxyReq = lib.request(currentUrl, {
            method: req.method,
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            rejectUnauthorized: false
        }, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                proxyRes.resume();
                doProxyRequest(proxyRes.headers.location, redirectCount + 1);
                return;
            }

            const headers = { 'Access-Control-Allow-Origin': '*' };

            if (proxyRes.headers['content-type']) {
                headers['Content-Type'] = proxyRes.headers['content-type'];
            }

            if (currentUrl.includes('.m3u8') || targetUrl.includes('.m3u8')) {
                headers['Content-Type'] = 'application/vnd.apple.mpegurl';
            } else if (currentUrl.includes('.ts') || targetUrl.includes('.ts') || currentUrl.includes('/mpegts') || targetUrl.includes('/mpegts')) {
                headers['Content-Type'] = 'video/mp2t';
            }

            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.writeHead(502);
                res.end("Bad Gateway: " + err.message);
            }
        });

        proxyReq.setTimeout(120000, () => {
            proxyReq.destroy();
        });

        req.pipe(proxyReq);
    }

    doProxyRequest(targetUrl);
});

server.listen(PORT, () => console.log(`Proxy (Auth+Heartbeat+IBOFix) running on ${PORT}`));

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 200, keepAliveMsecs: 15000 });

const SECRET_KEY = "VpsManagerStrongKey";
// Usa a porta do ambiente (Koyeb) OU 80 se não tiver nenhuma definida
const PORT = process.env.PORT || 8880;

const server = http.createServer(async (req, res) => {
    // 1. Validar Parâmetros Básicos
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        console.error(`[ERROR] URL Inválida: ${req.url}`);
        res.writeHead(400);
        res.end("Bad URL");
        return;
    }

    if (req.socket) {
        try { req.socket.setNoDelay(true); } catch {}
        try { req.socket.setKeepAlive(true, 15000); } catch {}
    }

    const payload = reqUrl.searchParams.get("payload");

    // Ignorar requisições sem payload (robôs/scanners)
    if (!payload) {
        // --- ADIÇÃO: Página Inicial com Status ---
        if (reqUrl.pathname === '/' || reqUrl.pathname === '/api' || reqUrl.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end("Proxy is Running!");
            return;
        }
        // ----------------------------------------

        res.writeHead(404);
        res.end();
        return;
    }

    // 2. Decodificar Payload
    let targetUrl, username, password;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        
        // Formato esperado: URL|USERNAME|PASSWORD
        const parts = result.split('|');
        targetUrl = parts[0];
        username = parts[1] || "";
        password = parts[2] || "";
        
    } catch (e) {
        console.error(`[ERROR] Falha ao decodificar payload: ${e.message}`);
        res.writeHead(400);
        res.end("Bad Payload");
        return;
    }

    if (!targetUrl || !targetUrl.startsWith('http')) {
        console.error(`[ERROR] URL de destino inválida: ${targetUrl}`);
        res.writeHead(400);
        res.end("Invalid URL");
        return;
    }

    // --- SEGURANÇA E AUTENTICAÇÃO ---

    // A. Verificar Expiração (se fornecida)
    const expires = reqUrl.searchParams.get("expires");
    if (expires) {
        if (Date.now() / 1000 > parseInt(expires)) {
            console.log(`[EXPIRED] Link expirado para user: ${username}`);
            res.writeHead(403);
            res.end("Link Expired");
            return;
        }
    }

    // B. Autenticação Remota (Check User/Pass no Painel)
    const authUrlStr = reqUrl.searchParams.get("auth");
    let connectionId = 0;
    let didStream = false;
    let terminate = false;
    let abortCurrentStream = () => {};

    if (authUrlStr && username && password) {
        try {
            const authTarget = new URL(authUrlStr);
            authTarget.searchParams.set("username", username);
            authTarget.searchParams.set("password", password);
            authTarget.searchParams.set("action", "check"); // Check inicial
            
            // Tenta extrair o CID da URL original
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
                console.log(`[AUTH FAIL] User: ${username} | Status: ${authRes.status}`);
                res.writeHead(403);
                res.end("Access Denied");
                return;
            }

            // --- HEARTBEAT & AUTO-DISCONNECT ---
            // Se autenticou com sucesso, inicia o loop de "estou vivo"
            if (connectionId > 0) {
                const heartbeatInterval = setInterval(() => {
                    const hbUrl = new URL(authUrlStr);
                    hbUrl.searchParams.set("username", username);
                    hbUrl.searchParams.set("password", password);
                    hbUrl.searchParams.set("action", "update");
                    hbUrl.searchParams.set("cid", connectionId);
                    (async () => {
                        try {
                            const r = await fetch(hbUrl.toString());
                            if (!r.ok) {
                                terminate = true;
                                try { abortCurrentStream(); } catch {}
                                try { res.end(); } catch {}
                            }
                        } catch {}
                    })();
                }, 5000);

                // Quando o cliente fecha a conexão (Troca de canal ou desliga TV)
                res.on('close', () => {
                    clearInterval(heartbeatInterval);
                    if (didStream) {
                        console.log(`[DISCONNECT] Cliente saiu. Removendo conexão ${connectionId}...`);
                        const delUrl = new URL(authUrlStr);
                        delUrl.searchParams.set("username", username);
                        delUrl.searchParams.set("password", password);
                        delUrl.searchParams.set("action", "delete"); // DELETA DO PAINEL
                        delUrl.searchParams.set("cid", connectionId);
                        fetch(delUrl.toString()).catch(() => {});
                    } else {
                        // Evita remover conexão se apenas a playlist m3u8 foi entregue
                        console.log(`[DISCONNECT] Encerrado sem fluxo contínuo. Skip delete para conexão ${connectionId}.`);
                    }
                });
            }

        } catch (e) {
            console.error(`[AUTH ERROR] Falha ao contatar servidor de auth: ${e.message}`);
            res.writeHead(502);
            res.end("Auth Server Unavailable");
            return;
        }
    }

    // --------------------------------

    // 3. Proxy Puro (COM FOLLOW REDIRECTS)
    
    async function streamM3u8AsTs(playlistUrl) {
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*'
        });
        let stopped = false;
        res.on('close', () => { stopped = true; });
        abortCurrentStream = () => { stopped = true; try { res.end(); } catch {} };
        const seen = new Set();
        const base = new URL(playlistUrl);
        let targetDur = 6;
        while (!stopped && !terminate) {
            // Kill check on each loop for fast termination
            try {
                if (authUrlStr && connectionId > 0) {
                    const kUrl = new URL(authUrlStr);
                    kUrl.searchParams.set("username", username);
                    kUrl.searchParams.set("password", password);
                    kUrl.searchParams.set("action", "update");
                    kUrl.searchParams.set("cid", connectionId);
                    const kr = await fetch(kUrl.toString());
                    if (!kr.ok) {
                        terminate = true;
                        break;
                    }
                }
            } catch {}
            let text = "";
            try {
                const controller = new AbortController();
                const pu = new URL(playlistUrl);
                pu.searchParams.set('_', String(Date.now()));
                const timeoutMs = Math.max(5000, targetDur * 1500);
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                const r = await fetch(pu.toString(), {
                    signal: controller.signal,
                    headers: {
                        'Accept': 'application/vnd.apple.mpegurl,*/*',
                        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0'
                    }
                });
                clearTimeout(timeoutId);
                text = await r.text();
            } catch {
                await new Promise(r => setTimeout(r, Math.max(500, targetDur * 500)));
                continue;
            }
            const lines = text.split(/\r?\n/);
            const segs = [];
            for (const ln of lines) {
                const line = ln.trim();
                if (!line) continue;
                if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                    const val = parseFloat(line.split(':')[1]);
                    if (Number.isFinite(val) && val > 0) targetDur = val;
                    continue;
                }
                if (line[0] === '#') continue;
                segs.push(line);
            }
            let i = 0;
            let prefetchBuffer = null;
            let prefetchedUrl = null;
            let prefetchInFlight = null;
            const MAX_PREFETCH_BYTES = 8 * 1024 * 1024;
            while (i < segs.length) {
                if (stopped) break;
                const s = segs[i];
                if (seen.has(s)) { i++; continue; }
                const u = new URL(s, base);
                let attempts = 0;
                let redirected = false;
                let segUrlStr = u.toString();
                let refreshNow = false;
                // Start prefetch of next segment if available and not already in flight
                const nextIdx = i + 1;
                if (nextIdx < segs.length && !prefetchInFlight && !seen.has(segs[nextIdx])) {
                    const nextUrl = new URL(segs[nextIdx], base).toString();
                    prefetchedUrl = nextUrl;
                    prefetchInFlight = new Promise((resolvePrefetch) => {
                        const libP = nextUrl.startsWith('https:') ? https : http;
                        let bufs = [];
                        let total = 0;
                        const reqP = libP.request(nextUrl, {
                            method: 'GET',
                            headers: {
                                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0',
                                'Accept': 'video/mp2t,*/*',
                                'Connection': 'keep-alive',
                                'Referer': playlistUrl,
                                'Origin': base.origin,
                                'Range': 'bytes=0-'
                            },
                            rejectUnauthorized: false,
                            agent: (nextUrl.startsWith('https:') ? httpsAgent : httpAgent)
                        }, (resP) => {
                            if (resP.statusCode >= 300 && resP.statusCode < 400 && resP.headers.location) {
                                resP.resume();
                                resolvePrefetch(false);
                                return;
                            }
                            resP.on('data', (chunk) => {
                                total += chunk.length;
                                if (total <= MAX_PREFETCH_BYTES) bufs.push(chunk);
                            });
                            resP.on('end', () => {
                                prefetchBuffer = (total > 0 && total <= MAX_PREFETCH_BYTES) ? Buffer.concat(bufs) : null;
                                resolvePrefetch(prefetchBuffer !== null);
                            });
                            resP.on('error', () => resolvePrefetch(false));
                        });
                        reqP.on('error', () => resolvePrefetch(false));
                        reqP.setTimeout(Math.max(30000, targetDur * 4000), () => { try { reqP.destroy(); } catch {} resolvePrefetch(false); });
                        reqP.end();
                    }).finally(() => { prefetchInFlight = null; });
                }
                do {
                    redirected = false;
                    await new Promise((resolve) => {
                        const lib = u.protocol === 'https:' ? https : http;
                        const segmentReq = lib.request(segUrlStr, {
                            method: 'GET',
                            headers: {
                                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                                'Accept': 'video/mp2t,*/*',
                                'Connection': 'keep-alive',
                                'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
                                'Referer': playlistUrl,
                                'Origin': base.origin,
                                'Range': 'bytes=0-'
                            },
                            rejectUnauthorized: false,
                            agent: (u.protocol === 'https:' ? httpsAgent : httpAgent)
                        }, (segmentRes) => {
                            if (segmentRes.statusCode === 401 || segmentRes.statusCode === 403) {
                                segmentRes.resume();
                                refreshNow = true;
                                resolve();
                                return;
                            }
                            if (segmentRes.statusCode >= 300 && segmentRes.statusCode < 400 && segmentRes.headers.location) {
                                const nextUrl = new URL(segmentRes.headers.location, u);
                                segUrlStr = nextUrl.toString();
                                redirected = true;
                                segmentRes.resume();
                                resolve();
                                return;
                            }
                            segmentRes.on('error', () => resolve());
                            didStream = true;
                            segmentRes.pipe(res, { end: false });
                            segmentRes.on('end', () => resolve());
                        });
                        segmentReq.on('error', () => resolve());
                        segmentReq.setTimeout(Math.max(30000, targetDur * 4000), () => { try { segmentReq.destroy(); } catch {} resolve(); });
                        segmentReq.end();
                    });
                    if (terminate || stopped || refreshNow) break;
                    attempts++;
                } while (redirected && attempts < 5);
                if (refreshNow) break;
                // If we have a prefetched buffer for next segment, write it immediately and skip ahead
                if (prefetchBuffer && prefetchedUrl) {
                    res.write(prefetchBuffer);
                    didStream = true;
                    seen.add(segs[nextIdx]);
                    prefetchBuffer = null;
                    prefetchedUrl = null;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            await new Promise(r => setTimeout(r, Math.max(500, targetDur * 500)));
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
        let count = parseInt(reqUrl.searchParams.get('segments') || '8');
        if (!Number.isFinite(count) || count < 3) count = 8;
        if (count > 20) count = 20;
        const lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:6",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-INDEPENDENT-SEGMENTS"
        ];
        for (let i = 0; i < count; i++) {
            const segUrl = new URL(selfUrl.toString());
            segUrl.searchParams.set("seg", String(i));
            segUrl.searchParams.set("_", String(Date.now()));
            lines.push("#EXTINF:6,");
            lines.push(segUrl.toString());
        }
        const playlist = lines.join("\n");
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(playlist);
        return;
    }
    
    function doProxyRequest(currentUrl, redirectCount = 0) {
        if (redirectCount > 5) {
            console.error(`[ERROR] Muitos redirecionamentos para: ${targetUrl}`);
            if (!res.headersSent) {
                res.writeHead(502);
                res.end("Too Many Redirects");
            }
            return;
        }

        const target = new URL(currentUrl);
        const lib = target.protocol === 'https:' ? https : http;

        console.log(`[PROXY] Stream: ${currentUrl} (User: ${username})`);

        const proxyReq = lib.request(currentUrl, {
            method: req.method,
            headers: {
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            rejectUnauthorized: false,
            agent: (target.protocol === 'https:' ? httpsAgent : httpAgent)
        }, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                console.log(`[REDIRECT] Seguindo para: ${proxyRes.headers.location}`);
                proxyRes.resume();
                doProxyRequest(proxyRes.headers.location, redirectCount + 1);
                return;
            }

            const headers = {
                'Access-Control-Allow-Origin': '*'
            };
            
            // IBO PLAYER COMPATIBILITY FIX
            // Força o Content-Type correto baseado na URL ou no que veio da origem
            if (proxyRes.headers['content-type']) {
                headers['Content-Type'] = proxyRes.headers['content-type'];
            }

            // Se a URL termina em .m3u8, força tipo HLS (alguns players exigem)
            if (currentUrl.includes('.m3u8') || targetUrl.includes('.m3u8')) {
                headers['Content-Type'] = 'application/vnd.apple.mpegurl';
            }
            // Se termina em .ts ou usa caminho /mpegts, força MPEG-TS
            else if (currentUrl.includes('.ts') || targetUrl.includes('.ts') || currentUrl.includes('/mpegts') || targetUrl.includes('/mpegts')) {
                headers['Content-Type'] = 'video/mp2t';
            }
            
            didStream = true;
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });

        abortCurrentStream = () => { try { proxyReq.destroy(); } catch {}; try { res.end(); } catch {} };

        proxyReq.on('error', (err) => {
            console.error(`[ERROR] Erro na conexão com origem ${currentUrl}: ${err.message}`);
            if (!res.headersSent) {
                 res.writeHead(502);
                 res.end("Bad Gateway: " + err.message);
            }
        });

        proxyReq.setTimeout(120000, () => {
            console.error(`[TIMEOUT] Origem demorou muito para responder: ${currentUrl}`);
            proxyReq.destroy();
        });

        req.pipe(proxyReq);
    }

    doProxyRequest(targetUrl);
});

server.listen(PORT, () => console.log(`Proxy (Auth+Heartbeat+IBOFix) running on ${PORT}`));

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');

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
                    // Envia 'update' a cada 30s
                    const hbUrl = new URL(authUrlStr);
                    hbUrl.searchParams.set("username", username);
                    hbUrl.searchParams.set("password", password);
                    hbUrl.searchParams.set("action", "update");
                    
                    fetch(hbUrl.toString()).catch(() => {}); // Fire and forget
                }, 30000);

                // Quando o cliente fecha a conexão (Troca de canal ou desliga TV)
                res.on('close', () => {
                    clearInterval(heartbeatInterval);
                    console.log(`[DISCONNECT] Cliente saiu. Removendo conexão ${connectionId}...`);
                    
                    const delUrl = new URL(authUrlStr);
                    delUrl.searchParams.set("username", username);
                    delUrl.searchParams.set("password", password);
                    delUrl.searchParams.set("action", "delete"); // DELETA DO PAINEL
                    
                    fetch(delUrl.toString()).catch(() => {});
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
                'Accept': '*/*'
            },
            rejectUnauthorized: false
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
            // Se termina em .ts, força MPEG-TS
            else if (currentUrl.includes('.ts') || targetUrl.includes('.ts')) {
                headers['Content-Type'] = 'video/mp2t';
            }
            
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            console.error(`[ERROR] Erro na conexão com origem ${currentUrl}: ${err.message}`);
            if (!res.headersSent) {
                 res.writeHead(502);
                 res.end("Bad Gateway: " + err.message);
            }
        });

        proxyReq.setTimeout(30000, () => {
            console.error(`[TIMEOUT] Origem demorou muito para responder: ${currentUrl}`);
            proxyReq.destroy();
        });

        req.pipe(proxyReq);
    }

    doProxyRequest(targetUrl);
});

server.listen(PORT, () => console.log(`Proxy (Auth+Heartbeat+IBOFix) running on ${PORT}`));

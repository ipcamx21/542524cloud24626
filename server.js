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
    const authUrl = reqUrl.searchParams.get("auth");
    if (authUrl && username && password) {
        try {
            const authTarget = new URL(authUrl);
            authTarget.searchParams.set("username", username);
            authTarget.searchParams.set("password", password);
            
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
        } catch (e) {
            console.error(`[AUTH ERROR] Falha ao contatar servidor de auth: ${e.message}`);
            res.writeHead(502);
            res.end("Auth Server Unavailable");
            return;
        }
    }

    // --------------------------------

    // 3. Proxy Puro (COM FOLLOW REDIRECTS)
    
    // Função auxiliar para fazer o request seguindo redirects
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

        console.log(`[PROXY] Tentando stream (Redirect ${redirectCount}): ${currentUrl}`);

        const proxyReq = lib.request(currentUrl, {
            method: req.method,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            },
            rejectUnauthorized: false
        }, (proxyRes) => {
            // Se for redirecionamento (301, 302, 307), seguir a nova URL
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                console.log(`[REDIRECT] Seguindo para: ${proxyRes.headers.location}`);
                
                // Consumir dados da resposta antiga para não vazar memória
                proxyRes.resume();
                
                // Chamar recursivamente para a nova URL
                doProxyRequest(proxyRes.headers.location, redirectCount + 1);
                return;
            }

            // Se não for redirect, é o conteúdo real (Stream)
            // Copiar status e headers importantes de forma SEGURA
            const headers = {
                'Access-Control-Allow-Origin': '*'
            };
            
            if (proxyRes.headers['content-type']) {
                headers['Content-Type'] = proxyRes.headers['content-type'];
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

    // Iniciar o processo
    doProxyRequest(targetUrl);
});

server.listen(PORT, () => console.log(`Proxy Authenticated + FollowRedirects running on ${PORT}`));

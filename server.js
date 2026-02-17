const http = require('http');
const https = require('https');
const url = require('url');

// --- CONFIGURAÇÃO ---
const PORT = process.env.PORT || 8880;
const ORIGIN_BASE = process.env.ORIGIN_BASE || "http://cdn474326.govods.online"; 

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });

console.log(`Iniciando Proxy Leve na porta ${PORT}`);
console.log(`Origem Base: ${ORIGIN_BASE}`);

http.createServer(async (req, res) => {
    try {
        // Validação básica de URL
        if (!req.url) {
            res.writeHead(400);
            res.end();
            return;
        }

        // Health Check
        if (req.url === '/' || req.url === '/health') {
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('Proxy Online');
            return;
        }

        // Regex para capturar: /tipo/usuario/senha/id.ext
        const regex = /^\/(live|movie|series)\/([^\/]+)\/([^\/]+)\/([^\.]+)\.(ts|m3u8|mp4|mkv|avi)$/i;
        const urlParts = req.url.split('?');
        const pathOnly = urlParts[0];
        const match = pathOnly.match(regex);

        if (!match) {
            console.log(`[404] Rota invalida: ${req.url}`);
            res.writeHead(404);
            res.end('404 Not Found');
            return;
        }

        // Verifica ORIGIN_BASE
        let origin = ORIGIN_BASE;
        const qParams = new URL(req.url, `http://localhost`).searchParams;
        
        // Se ORIGIN_BASE não estiver configurada ou for o placeholder, tenta pegar via ?up=
        if (!origin || origin.includes("SEU_DNS_AQUI")) {
            origin = qParams.get('up');
            if (!origin) {
                res.writeHead(500);
                res.end('ERRO: Configure ORIGIN_BASE no servidor ou passe ?up=http://origem');
                return;
            }
        }
        
        // Limpa barra final e garante http://
        origin = origin.replace(/\/$/, '');
        if (!origin.startsWith('http')) origin = 'http://' + origin;

        // Monta URL de destino
        const [, type, user, pass, id, ext] = match;
        const targetUrl = `${origin}/${type}/${user}/${pass}/${id}.${ext}`;
        
        // Heartbeat Opcional (executa em background)
        const authUrl = qParams.get('auth');
        if (authUrl) {
            performHeartbeat(authUrl, user, pass);
        }

        // Inicia Proxy
        const targetObj = new url.URL(targetUrl);
        const lib = targetObj.protocol === 'https:' ? https : http;
        const agent = targetObj.protocol === 'https:' ? httpsAgent : httpAgent;

        console.log(`[STREAM] ${user} -> ${id}.${ext}`);

        const proxyReq = lib.request(targetUrl, {
            method: 'GET',
            headers: {
                'User-Agent': req.headers['user-agent'] || 'VpsManagerProxy',
                'Accept': '*/*',
                'Connection': 'keep-alive',
                'X-Forwarded-For': req.headers['x-forwarded-for'] || req.socket.remoteAddress
            },
            agent: agent,
            timeout: 60000
        }, (proxyRes) => {
            // Seguir Redirects (302/301)
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                res.writeHead(proxyRes.statusCode, { 'Location': proxyRes.headers.location });
                res.end();
                return;
            }

            const headers = { ...proxyRes.headers };
            headers['Access-Control-Allow-Origin'] = '*';
            
            res.writeHead(proxyRes.statusCode, headers);
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
            console.error(`[TIMEOUT] Origem lenta: ${targetUrl}`);
            proxyReq.destroy();
        });

        req.on('close', () => {
            if (!proxyReq.destroyed) proxyReq.destroy();
        });

    } catch (error) {
        console.error(`[CRITICAL] ${error.message}`);
        if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
        }
    }
}).listen(PORT, () => {
    console.log(`Servidor pronto na porta ${PORT}`);
});

function performHeartbeat(authUrl, user, pass) {
    try {
        const u = new URL(authUrl);
        u.searchParams.set('username', user);
        u.searchParams.set('password', pass);
        u.searchParams.set('action', 'check');
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u.toString(), { method: 'GET', timeout: 5000 }, (res) => { res.resume(); });
        req.on('error', () => {});
        req.end();
    } catch (e) {}
}

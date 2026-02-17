const http = require('http');
const https = require('https');
const url = require('url');

// --- CONFIGURAÇÃO ---
const PORT = process.env.PORT || 8880;
// URL da Origem (DNS do Painel/Iptv). Ex: http://painel.com:80
// Configure nas variáveis de ambiente (Koyeb/Render) ou edite aqui:
const ORIGIN_BASE = process.env.ORIGIN_BASE || "http://SEU_DNS_AQUI"; 

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 500, keepAliveMsecs: 30000 });

console.log(` Iniciando Proxy Leve na porta ${PORT}`);
console.log(` Origem Base: ${ORIGIN_BASE}`);

http.createServer(async (req, res) => {
    try {
        // 1. Validar e Parsear URL
        // Aceita: /live/user/pass/id.ext ou /movie/... ou /series/...
        // Regex captura: (tipo)/(usuario)/(senha)/(id).(extensão)
        const regex = /^\/(live|movie|series)\/([^\/]+)\/([^\/]+)\/([^\.]+)\.(ts|m3u8|mp4|mkv|avi)$/i;
        const match = req.url.split('?')[0].match(regex); // Ignora query string no match

        if (!match) {
            if (req.url === '/' || req.url === '/health') {
                res.writeHead(200, {'Content-Type': 'text/plain'});
                res.end('Proxy Online');
                return;
            }
            console.log(`[404] Rota desconhecida: ${req.url}`);
            res.writeHead(404);
            res.end('404 Not Found - Formato: /live/user/pass/id.ts');
            return;
        }

        // Verifica se ORIGIN_BASE está configurada
        if (!ORIGIN_BASE || ORIGIN_BASE.includes("SEU_DNS_AQUI")) {
            // Tenta pegar da query string ?up=... se não tiver na ENV
            const q = new URL(req.url, `http://localhost`).searchParams;
            if (!q.get('up')) {
                res.writeHead(500);
                res.end('ERRO: Variavel ORIGIN_BASE nao configurada no servidor!');
                return;
            }
        }

        // 2. Montar URL de Destino
        const [, type, user, pass, id, ext] = match;
        const qParams = new URL(req.url, `http://localhost`).searchParams;
        
        // Base da origem (da ENV ou da query ?up=)
        let origin = (qParams.get('up') || ORIGIN_BASE).replace(/\/$/, '');
        if (!origin.startsWith('http')) origin = 'http://' + origin;

        const targetUrl = `${origin}/${type}/${user}/${pass}/${id}.${ext}`;
        
        // 3. Heartbeat / Auth (Opcional - mantém Onlines ativo no painel)
        // O painel envia ?auth=http://painel/worker_auth.php
        const authUrl = qParams.get('auth');
        if (authUrl) {
            // Executa em background sem travar o stream
            performHeartbeat(authUrl, user, pass).catch(e => console.error('Heartbeat fail:', e.message));
        }

        // 4. Proxy Request (Stream)
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
            timeout: 60000 // 60s timeout de leitura
        }, (proxyRes) => {
            // Lidar com Redirecionamentos (302) da origem
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                res.writeHead(proxyRes.statusCode, { 'Location': proxyRes.headers.location });
                res.end();
                return;
            }

            // Headers de resposta
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

// Função auxiliar para notificar o painel que o usuário está online
async function performHeartbeat(authUrl, user, pass) {
    // Apenas um "fire and forget" simples
    try {
        const u = new URL(authUrl);
        u.searchParams.set('username', user);
        u.searchParams.set('password', pass);
        u.searchParams.set('action', 'check');
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request(u.toString(), { method: 'GET', timeout: 5000 }, (res) => {
            // Ignora resposta, só quer bater no endpoint
            res.resume(); 
        });
        req.on('error', () => {});
        req.end();
    } catch (e) {}
}

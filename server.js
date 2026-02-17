const http = require('http');
const https = require('https');
const crypto = require('crypto');
const url = require('url');
const EventEmitter = require('events');

const SECRET_KEY = "VpsManagerStrongKey";
const PORT = process.env.PORT || 8000;

// --- DEDUPLICAÇÃO INTELIGENTE (Smart Restream) ---
// Armazena streams ativos: { "url_do_canal": { response: ResponseObj, clients: [res1, res2], lastActivity: timestamp } }
const activeStreams = new Map();

const server = http.createServer((req, res) => {
    // 1. Validar Parâmetros Básicos
    let reqUrl;
    try {
        reqUrl = new URL(req.url, `http://${req.headers.host}`);
    } catch (e) {
        res.writeHead(400);
        res.end("Bad URL");
        return;
    }
    
    const payload = reqUrl.searchParams.get("payload");
    
    // Ignorar requisições sem payload (robôs/scanners)
    if (!payload) {
        res.writeHead(404);
        res.end();
        return;
    }

    // 2. Decodificar Payload
    let targetUrl;
    try {
        const decoded = Buffer.from(payload, 'base64').toString('binary');
        let result = "";
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
        }
        targetUrl = result.split('|')[0];
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

    // --- LÓGICA DE DEDUPLICAÇÃO ---
    // Se já existe uma conexão ativa para esse canal, reuse-a!
    if (activeStreams.has(targetUrl)) {
        console.log(`[CACHE HIT] Reutilizando stream para: ${targetUrl}`);
        const stream = activeStreams.get(targetUrl);
        
        // Adiciona o novo cliente à lista
        stream.clients.push(res);
        
        // Envia cabeçalhos imediatamente (se já disponíveis)
        if (stream.headers) {
            res.writeHead(stream.statusCode || 200, stream.headers);
        }

        // Lidar com desconexão do cliente
        req.on('close', () => {
            const index = stream.clients.indexOf(res);
            if (index > -1) {
                stream.clients.splice(index, 1);
            }
            console.log(`[CLIENT DISCONNECT] Cliente saiu de ${targetUrl}. Restantes: ${stream.clients.length}`);
            
            // Se não houver mais clientes, fecha a conexão com a origem
            if (stream.clients.length === 0) {
                console.log(`[STREAM STOP] Sem clientes para ${targetUrl}. Fechando origem.`);
                if (stream.request) stream.request.destroy();
                activeStreams.delete(targetUrl);
            }
        });
        
        return;
    }

    // --- NOVA CONEXÃO COM A ORIGEM ---
    console.log(`[PROXY NEW] Abrindo nova conexão para: ${targetUrl}`);
    
    const target = new URL(targetUrl);
    const lib = target.protocol === 'https:' ? https : http;

    const streamData = {
        clients: [res],
        headers: null,
        statusCode: 200,
        request: null
    };
    
    activeStreams.set(targetUrl, streamData);

    const proxyReq = lib.request(targetUrl, {
        method: req.method,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
        },
        rejectUnauthorized: false
    }, (proxyRes) => {
        // Salva headers e status para novos clientes
        const headers = {
            'Access-Control-Allow-Origin': '*'
        };
        if (proxyRes.headers['content-type']) {
            headers['Content-Type'] = proxyRes.headers['content-type'];
        }
        
        streamData.headers = headers;
        streamData.statusCode = proxyRes.statusCode;

        // Envia headers para todos os clientes atuais (neste caso, apenas o primeiro)
        streamData.clients.forEach(client => {
            if (!client.headersSent) {
                client.writeHead(proxyRes.statusCode, headers);
            }
        });
        
        // Quando chegam dados, espalha para todos os clientes (BROADCAST)
        proxyRes.on('data', (chunk) => {
            streamData.clients.forEach(client => {
                try {
                    client.write(chunk);
                } catch (e) {
                    // Ignora erros de escrita (cliente caiu)
                }
            });
        });

        proxyRes.on('end', () => {
            console.log(`[STREAM END] Fim da transmissão para: ${targetUrl}`);
            streamData.clients.forEach(client => client.end());
            activeStreams.delete(targetUrl);
        });
    });

    proxyReq.on('error', (err) => {
        console.error(`[ERROR] ${err.message}`);
        streamData.clients.forEach(client => {
            if (!client.headersSent) client.writeHead(502);
            client.end();
        });
        activeStreams.delete(targetUrl);
    });

    streamData.request = proxyReq;

    // Lidar com desconexão do PRIMEIRO cliente (criador da conexão)
    req.on('close', () => {
        const index = streamData.clients.indexOf(res);
        if (index > -1) {
            streamData.clients.splice(index, 1);
        }
        console.log(`[CLIENT DISCONNECT] Cliente (criador) saiu de ${targetUrl}. Restantes: ${streamData.clients.length}`);
        
        if (streamData.clients.length === 0) {
            console.log(`[STREAM STOP] Sem clientes para ${targetUrl}. Fechando origem.`);
            proxyReq.destroy();
            activeStreams.delete(targetUrl);
        }
    });

    req.pipe(proxyReq);
});

server.listen(PORT, () => console.log(`Proxy Smart Restream running on ${PORT}`));

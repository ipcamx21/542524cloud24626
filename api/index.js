const https = require('https');
const http = require('http');
const { parse } = require('url');
const crypto = require('crypto');

// IMPORTANTE: Mantenha esta chave igual à do seu painel PHP
const SECRET_KEY = "VpsManagerStrongKey"; 

module.exports = async (req, res) => {
  // Configurações de CORS para aceitar qualquer origem
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent, Authorization');

  // Responde rápido se for apenas uma verificação de CORS
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Pega os parâmetros da URL
  const { query } = parse(req.url, true);
  const { payload, expires, token, auth } = query;

  // Se não tiver payload, mostra mensagem de status
  if (!payload) {
    return res.json({ status: "Online" });
  }

  // === VALIDAÇÃO DE SEGURANÇA ===
  if (!expires || !token) return res.status(403).send("Acesso Negado: Token ausente");
  
  // Verifica se o link expirou
  if (Date.now() / 1000 > parseInt(expires)) return res.status(403).send("Acesso Negado: Link expirado");

  // Verifica a Assinatura Digital (HMAC)
  const dataToSign = payload + expires + (auth || "");
  const hmac = crypto.createHmac('sha256', SECRET_KEY);
  hmac.update(dataToSign);
  const expectedToken = hmac.digest('hex');

  // Se a assinatura não bater, alguém tentou alterar o link
  if (token !== expectedToken) return res.status(403).send("Acesso Negado: Assinatura Inválida");

  // === DESCRIPTOGRAFIA ===
  let targetUrl, username, password;
  try {
    // Decodifica Base64
    const decoded = Buffer.from(payload, 'base64').toString('binary');
    let result = "";
    // Descriptografa XOR
    for (let i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(decoded.charCodeAt(i) ^ SECRET_KEY.charCodeAt(i % SECRET_KEY.length));
    }
    
    // Separa URL|USUARIO|SENHA
    const parts = result.split('|');
    targetUrl = parts[0];
    if (parts.length >= 3) { username = parts[1]; password = parts[2]; }
  } catch (e) {
    return res.status(400).send("Payload Inválido");
  }

  if (!targetUrl.startsWith('http')) return res.status(400).send("URL de destino inválida");

  // === VALIDAÇÃO REMOTA (CALL HOME) ===
  // Opcional: Chama seu painel para ver se o usuário ainda está ativo
  if (auth && username && password) {
      try {
          const authUrl = `${auth}?u=${encodeURIComponent(username)}&p=${encodeURIComponent(password)}`;
          // Faz a requisição sem esperar muito (timeout curto para não travar o vídeo)
          const authReq = (authUrl.startsWith('https') ? https : http).get(authUrl, (authRes) => {
              // Se o painel retornar erro (ex: usuário bloqueado), poderíamos bloquear aqui.
              // Por performance em serverless free, vamos apenas registrar.
          });
          authReq.on('error', () => {}); // Ignora erros de conexão com auth
          authReq.end();
      } catch (e) {}
  }

  // === PROXY DO VÍDEO ===
  const target = new URL(targetUrl);
  const lib = target.protocol === 'https:' ? https : http;
  
  const options = {
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
          // User-Agent que engana o servidor de origem
          'User-Agent': 'XCIPTV (Linux; Android 10; SM-G960F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.181 Mobile Safari/537.36',
          'Host': target.host
      }
  };

  // Repassar Range (Importante para player poder pular o vídeo)
  if (req.headers.range) {
      options.headers['Range'] = req.headers.range;
  }

  // Inicia o proxy
  const proxyReq = lib.request(options, (proxyRes) => {
      // Repassa os headers da origem para o cliente
      const headers = { ...proxyRes.headers };
      // Remove headers de segurança que podem quebrar o player
      delete headers['content-security-policy'];
      delete headers['x-frame-options'];
      headers['Access-Control-Allow-Origin'] = '*';
      
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
      console.error(e);
      res.status(502).send("Erro ao conectar na origem");
  });

  proxyReq.end();
};

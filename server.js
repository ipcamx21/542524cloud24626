const express = require('express');
const app = express();
const proxyHandler = require('./api/index');

const PORT = process.env.PORT || 3000;

// Rota principal do Proxy (Continua funcionando)
app.get('/api', proxyHandler);

// Rota Raiz e Qualquer outra página - Disfarce 404 Nginx
app.get('*', (req, res) => {
    res.status(404).send(`<html>
<head><title>404 Not Found</title></head>
<body bgcolor="white">
<center><h1>404 Not Found</h1></center>
<hr><center>nginx</center>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

const express = require('express');
const app = express();
const proxyHandler = require('./api/index');

const PORT = process.env.PORT || 3000;

// Rota principal do Proxy
app.get('/api', proxyHandler);

// Rota para checar se está online
app.get('/', (req, res) => {
    res.send('Proxy Online - Koyeb/Render');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

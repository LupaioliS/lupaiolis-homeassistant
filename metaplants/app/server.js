const express = require('express');
const app = express();
const port = 3000;

app.get('/', (req, res) => {
    // Recuperiamo il prefisso dinamico di Ingress (es. /api/hassio_ingress/token/)
    const ingressPath = req.headers['x-ingress-path'] || '';
    
    res.send(`
        <html>
            <head>
                <style>body { font-family: sans-serif; text-align: center; padding: 50px; }</style>
            </head>
            <body>
                <h1>Node.js Add-on Funzionante!</h1>
                <p>Percorso Ingress attuale: <code>${ingressPath}</code></p>
                <!-- Nota come usiamo il prefisso per i link -->
                <a href="${ingressPath}/test">Vai alla pagina di test</a>
            </body>
        </html>
    `);
});

app.get('/test', (req, res) => {
    res.send('Funziona anche la navigazione interna!');
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Add-on in ascolto su porta ${port}`);
});
const express = require('express');
const path = require('path');
const app = express();

// Middleware para ler JSON (webhook da Wati)
app.use(express.json());

// Serve os arquivos estáticos (CSS, imagens, JS do front-end)
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// ROTAS DAS PÁGINAS (FRONT-END)
// ---------------------------------------------------------

// Raiz: Redireciona para o login
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Tela de Login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Painel Admin
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Painel do Colaborador
app.get('/colaborador', (req, res) => {
    res.sendFile(path.join(__dirname, 'colaborador.html'));
});

// ---------------------------------------------------------
// ROTAS DO WEBHOOK (WATI / META)
// ---------------------------------------------------------

// Verificação do Webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'seu_token_de_verificacao_aqui';

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK VERIFICADO');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Recebimento de Eventos
app.post('/webhook', (req, res) => {
    console.log('\n--- NOVO EVENTO RECEBIDO ---');
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

// ---------------------------------------------------------
// INICIALIZAÇÃO
// ---------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
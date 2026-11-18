const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// Rota Principal: Entrega o Painel Admin
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// NOVA ROTA: Entrega o Painel do Colaborador
app.get('/colaborador', (req, res) => {
    res.sendFile(path.join(__dirname, 'colaborador.html'));
});

// ROTA GET: Usada para testes de verificação do webhook
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'seu_token_de_verificacao_aqui';

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ROTA POST: Recebe as mensagens e eventos enviados pela Wati
app.post('/webhook', (req, res) => {
    console.log('\n--- NOVO EVENTO RECEBIDO ---');
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
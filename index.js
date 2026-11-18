const express = require('express');
const path = require('path');
const app = express();

// Middleware para ler JSON (para o webhook da Wati)
app.use(express.json());

// AVISO MÁGICO: Isso serve os seus arquivos HTML, CSS e JS para o navegador
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// Rota principal: Entrega o Painel Admin quando acessar o site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota GET: Usada para testes de verificação do webhook (opcional)
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

// Rota POST: Recebe as mensagens e eventos enviados pela Wati
app.post('/webhook', (req, res) => {
    console.log('\n--- NOVO EVENTO RECEBIDO ---');
    console.log(JSON.stringify(req.body, null, 2));
    
    // Obrigatório responder 200 OK rápido para a Wati não achar que deu erro
    res.sendStatus(200);
});

// Inicia o servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Painel Admin disponível na raiz do site`);
});
const express = require('express');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'seu_token_de_verificacao_aqui';

// ROTA GET: Teste local (a Wati não usa, mas mantemos para debug)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFICADO (Teste Local)');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ROTA POST: Recebe os eventos da Wati
app.post('/webhook', (req, res) => {
  console.log('\n--- NOVO EVENTO RECEBIDO ---');
  console.log(JSON.stringify(req.body, null, 2));

  // Resposta 200 obrigatória e rápida para a Wati não reenviar
  res.sendStatus(200);
});

// AQUI ESTÁ A MUDANÇA PARA O RENDER:
// Escuta em 0.0.0.0 (todas as interfaces) e na porta que o Render definir
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
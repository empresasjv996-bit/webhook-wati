const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname)); // Permite exibir o HTML e CSS

const PORT = process.env.PORT || 3000;

// Exibe o seu layout quando acessar o link
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Rota para a Wati (Webhook)
app.post('/webhook', (req, res) => {
  console.log('\n--- NOVO EVENTO RECEBIDO ---');
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
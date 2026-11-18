const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_123!@#';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO E PROTEÇÃO
// ---------------------------------------------------------
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    let role = null;
    if (email === 'admin@qgcteam.com' && senha === '123456') role = 'admin';
    else if (email === 'colaborador@qgcteam.com' && senha === '123456') role = 'colaborador';
    else if (email === 'vendedor@qgcteam.com' && senha === '123456') role = 'colaborador'; 

    if (role) {
        const token = jwt.sign({ email, role }, JWT_SECRET, { expiresIn: '8h' });
        res.cookie('qgc_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        return res.json({ success: true, role });
    } else {
        return res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('qgc_token');
    res.redirect('/login');
});

function verificarToken(rolePermitida) {
    return (req, res, next) => {
        const token = req.cookies.qgc_token;
        if (!token) return res.redirect('/login');
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return res.redirect('/login');
            if (rolePermitida) {
                const permitido = Array.isArray(rolePermitida) ? rolePermitida.includes(decoded.role) : decoded.role === rolePermitida;
                if (!permitido) return res.status(403).send('Acesso negado.');
            }
            next();
        });
    };
}

// ---------------------------------------------------------
// ROTAS PROTEGIDAS
// ---------------------------------------------------------
app.get('/', (req, res) => res.redirect('/login'));
app.get('/admin', verificarToken('admin'), (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/colaborador', verificarToken(['colaborador', 'admin']), (req, res) => res.sendFile(path.join(__dirname, 'colaborador.html')));

// ---------------------------------------------------------
// API DO BANCO DE DADOS
// ---------------------------------------------------------

// Rota para o colaborador atualizar o status de um cliente
app.post('/api/status', async (req, res) => {
    const { telefone, status } = req.body;
    try {
        await pool.query('UPDATE clientes SET status = $1 WHERE telefone = $2', [status, telefone]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

// Rota para o Admin buscar os totais
app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT status, COUNT(*) as total FROM clientes GROUP BY status');
        const counts = { vendido: 0, pensando: 0, 'nao-quis': 0 };
        result.rows.forEach(row => { if (counts[row.status] !== undefined) counts[row.status] = parseInt(row.total); });
        res.json(counts);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar dados' });
    }
});

// Rota para o colaborador buscar a lista de clientes no banco
app.get('/api/clientes', async (req, res) => {
    try {
        const result = await pool.query('SELECT nome, telefone, mensagem, status FROM clientes ORDER BY criado_em DESC LIMIT 20');
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar lista de clientes' });
    }
});

// ---------------------------------------------------------
// WEBHOOK DA WATI (CORRIGIDO COM BASE NO SEU LOG)
// ---------------------------------------------------------
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === (process.env.VERIFY_TOKEN || 'seu_token_de_verificacao_aqui')) {
        res.status(200).send(challenge);
    } else res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
    console.log('\n--- NOVO EVENTO RECEBIDO DA WATI ---');
    
    try {
        const body = req.body;
        
        // O log mostra que a Wati envia "eventType": "message" e o texto em "text"
        if (body.eventType === 'message' && body.text) {
            const telefone = body.waId || 'desconhecido';
            const nome = body.senderName || 'Cliente Novo';
            const mensagem = body.text;

            console.log(`Salvando no banco -> Nome: ${nome}, Telefone: ${telefone}, Msg: ${mensagem}`);

            // Salva no banco (se o telefone já existir, só atualiza a mensagem)
            await pool.query(`
                INSERT INTO clientes (nome, telefone, mensagem, status) 
                VALUES ($1, $2, $3, 'pensando') 
                ON CONFLICT (telefone) DO UPDATE SET mensagem = $3, nome = $1
            `, [nome, telefone, mensagem]);
        } else {
            console.log('Evento ignorado (não é uma mensagem de texto).');
        }

        res.sendStatus(200);
    } catch (error) {
        console.error('Erro ao processar webhook:', error);
        res.sendStatus(500);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
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

// Configurações da Wati (vêm do Environment do Render)
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_NUMERO = process.env.WATI_NUMERO; // seu número conectado, ex: 5513999999999
const WATI_HOST = 'https://live-mt-server.wati.io';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------
// AUTENTICAÇÃO
// ---------------------------------------------------------
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    let role = null;
    let nome = null;

    if (email === 'admin@qgcteam.com' && senha === '123456') { role = 'admin'; nome = 'Admin Master'; }
    else if (email === 'colaborador@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Claudio'; }
    else if (email === 'vendedor@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Vendedor Jv'; }

    if (role) {
        const token = jwt.sign({ email, role, nome }, JWT_SECRET, { expiresIn: '8h' });
        res.cookie('qgc_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        return res.json({ success: true, role, nome });
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
            req.user = decoded;
            if (rolePermitida) {
                const permitido = Array.isArray(rolePermitida) ? rolePermitida.includes(decoded.role) : decoded.role === rolePermitida;
                if (!permitido) return res.status(403).send('Acesso negado.');
            }
            next();
        });
    };
}

app.get('/api/me', verificarToken(), (req, res) => {
    res.json({ nome: req.user.nome, role: req.user.role });
});

// ---------------------------------------------------------
// ROTAS PROTEGIDAS (PÁGINAS)
// ---------------------------------------------------------
app.get('/', (req, res) => res.redirect('/login'));
app.get('/admin', verificarToken('admin'), (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/colaborador', verificarToken(['colaborador', 'admin']), (req, res) => res.sendFile(path.join(__dirname, 'colaborador.html')));

// ---------------------------------------------------------
// API DO BANCO DE DADOS
// ---------------------------------------------------------
app.post('/api/status', async (req, res) => {
    const { telefone, status } = req.body;
    try {
        await pool.query('UPDATE clientes SET status = $1 WHERE telefone = $2', [status, telefone]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT status, COUNT(*) as total FROM clientes GROUP BY status');
        const counts = { vendido: 0, pensando: 0, 'nao-quis': 0, finalizado: 0 };
        result.rows.forEach(row => { if (counts[row.status] !== undefined) counts[row.status] = parseInt(row.total); });
        res.json(counts);
    } catch (error) { res.status(500).json({ error: 'Erro' }); }
});

app.get('/api/clientes', async (req, res) => {
    try {
        const result = await pool.query("SELECT nome, telefone, mensagem, status FROM clientes WHERE status != 'finalizado' ORDER BY criado_em DESC LIMIT 20");
        res.json(result.rows);
    } catch (error) { res.status(500).json({ error: 'Erro' }); }
});

// ENVIO REAL DE MENSAGEM VIA API DA WATI
app.post('/api/enviar-mensagem', async (req, res) => {
    const { telefone, mensagem } = req.body;

    if (!WATI_TOKEN || !WATI_NUMERO) {
        console.error('WATI_TOKEN ou WATI_NUMERO não configurados no Render!');
        return res.status(500).json({ success: false, message: 'API da Wati não configurada no servidor.' });
    }

    try {
        const url = `${WATI_HOST}/${WATI_NUMERO}/api/v1/sendSessionMessage/${telefone}?messageText=${encodeURIComponent(mensagem)}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WATI_TOKEN}` }
        });

        const data = await response.json();
        console.log('Resposta da Wati:', JSON.stringify(data));

        if (response.ok && (data.result === true || data.success === true)) {
            await pool.query('UPDATE clientes SET mensagem = $1 WHERE telefone = $2', [`Você: ${mensagem}`, telefone]);
            return res.json({ success: true });
        } else {
            console.error('Wati recusou o envio:', data.message || data);
            return res.status(502).json({ success: false, message: data.message || 'Wati recusou o envio.' });
        }
    } catch (error) {
        console.error('Erro ao chamar a API da Wati:', error.message);
        res.status(500).json({ success: false, message: 'Erro de conexão com a Wati.' });
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { telefone } = req.body;
    try {
        await pool.query("UPDATE clientes SET status = 'finalizado' WHERE telefone = $1", [telefone]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ---------------------------------------------------------
// WEBHOOK DA WATI
// ---------------------------------------------------------
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (body.eventType === 'message' && body.text) {
            const telefone = body.waId || 'desconhecido';
            const nome = body.senderName || 'Cliente Novo';
            const mensagem = body.text;

            // CORREÇÃO: se o cliente voltar a falar, o status volta para 'pensando' (reabre o atendimento)
            await pool.query(`
                INSERT INTO clientes (nome, telefone, mensagem, status) 
                VALUES ($1, $2, $3, 'pensando') 
                ON CONFLICT (telefone) DO UPDATE 
                SET mensagem = $3, nome = $1, criado_em = NOW(), status = 'pensando'
            `, [nome, telefone, mensagem]);

            console.log(`Mensagem salva -> ${nome} (${telefone}): ${mensagem}`);
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('Erro no webhook:', error);
        res.sendStatus(500);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
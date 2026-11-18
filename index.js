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
// ROTAS DO BANCO DE DADOS (API)
// ---------------------------------------------------------

// SALVAR: O colaborador envia o status
app.post('/api/status', async (req, res) => {
    const { nome, status } = req.body;
    try {
        // Aqui adicionamos um telefone falso para o banco não dar erro de constraint
        await pool.query(`
            INSERT INTO clientes (nome, telefone, status) 
            VALUES ($1, '11999999999', $2) 
            ON CONFLICT (telefone) DO UPDATE SET status = $2
        `, [nome, status]);
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao salvar:', error.message);
        res.status(500).json({ success: false });
    }
});

// LER: O Admin busca os totais do banco
app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT status, COUNT(*) as total 
            FROM clientes 
            GROUP BY status
        `);
        
        // Transforma a resposta em um objeto fácil de ler
        const counts = { vendido: 0, pensando: 0, 'nao-quis': 0 };
        result.rows.forEach(row => {
            if (counts[row.status] !== undefined) {
                counts[row.status] = parseInt(row.total);
            }
        });
        
        res.json(counts);
    } catch (error) {
        console.error('Erro ao ler:', error.message);
        res.status(500).json({ error: 'Erro ao buscar dados' });
    }
});

// ---------------------------------------------------------
// WEBHOOK
// ---------------------------------------------------------
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === (process.env.VERIFY_TOKEN || 'seu_token_de_verificacao_aqui')) {
        res.status(200).send(challenge);
    } else res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
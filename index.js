const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const app = express();

// Middlewares
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_123!@#';

// CONEXÃO COM O BANCO DE DADOS
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ---------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// ---------------------------------------------------------
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;
    let role = null;

    // --- NOVOS ACESSOS AQUI ---
    if (email === 'admin@qgcteam.com' && senha === '123456') {
        role = 'admin';
    } else if (email === 'colaborador@qgcteam.com' && senha === '123456') {
        role = 'colaborador';
    } else if (email === 'vendedor@qgcteam.com' && senha === '123456') { // NOVO ACESSO
        role = 'colaborador'; 
    }

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

// ---------------------------------------------------------
// MIDDLEWARE DE PROTEÇÃO
// ---------------------------------------------------------
function verificarToken(rolePermitida) {
    return (req, res, next) => {
        const token = req.cookies.qgc_token;
        if (!token) return res.redirect('/login');
        
        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return res.redirect('/login');
            
            // Se for array (como ['colaborador', 'admin']), verifica se a role está incluída
            if (rolePermitida) {
                const permitido = Array.isArray(rolePermitida) 
                    ? rolePermitida.includes(decoded.role) 
                    : decoded.role === rolePermitida;
                    
                if (!permitido) {
                    return res.status(403).send('Acesso negado: Você não tem permissão para acessar esta área.');
                }
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
// ROTAS DA API (BANCO DE DADOS)
// ---------------------------------------------------------
app.post('/api/status', async (req, res) => {
    const { nome, status } = req.body;
    try {
        await pool.query(`
            INSERT INTO clientes (nome, status) 
            VALUES ($1, $2) 
            ON CONFLICT (telefone) DO UPDATE SET status = $2
        `, [nome, status]);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        const result = await pool.query('SELECT status, COUNT(*) FROM clientes GROUP BY status');
        res.json(result.rows);
    } catch (error) {
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
    console.log('\n--- NOVO EVENTO RECEBIDO ---');
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const app = express();

// Middlewares
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
// Em produção, use uma string longa e aleatória aqui (ou variável de ambiente)
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_123!@#'; 

// ---------------------------------------------------------
// ROTAS DE AUTENTICAÇÃO
// ---------------------------------------------------------

// Tela de Login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// Rota que recebe os dados do formulário de login
app.post('/api/login', (req, res) => {
    const { email, senha } = req.body;

    // SIMULAÇÃO DE BANCO DE DADOS (No futuro, você buscará no PostgreSQL)
    let role = null;
    if (email === 'admin@qgcteam.com' && senha === '123456') role = 'admin';
    else if (email === 'colaborador@qgcteam.com' && senha === '123456') role = 'colaborador';

    if (role) {
        // Cria o Token válido por 8 horas
        const token = jwt.sign({ email, role }, JWT_SECRET, { expiresIn: '8h' });
        
        // Salva o token no Cookie do navegador (mais seguro que localStorage)
        res.cookie('qgc_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        
        return res.json({ success: true, role: role });
    } else {
        return res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });
    }
});

// Rota para deslogar (limpar o cookie)
app.post('/api/logout', (req, res) => {
    res.clearCookie('qgc_token');
    res.redirect('/login');
});

// ---------------------------------------------------------
// MIDDLEWARE DE PROTEÇÃO DE ROTAS
// ---------------------------------------------------------
// Essa função verifica se o usuário tem o token e se ele tem a permissão certa
function verificarToken(rolePermitida) {
    return (req, res, next) => {
        const token = req.cookies.qgc_token;
        
        if (!token) {
            return res.redirect('/login'); // Sem token, volta pro login
        }

        jwt.verify(token, JWT_SECRET, (err, decoded) => {
            if (err) return res.redirect('/login'); // Token inválido ou expirado
            
            // Se a rota exige Admin e o usuário é Colaborador, bloqueia
            if (rolePermitida && decoded.role !== rolePermitida) {
                return res.status(403).send('Acesso negado: Você não tem permissão para acessar esta área.');
            }
            next();
        });
    };
}

// ---------------------------------------------------------
// ROTAS PROTEGIDAS (SÓ ENTRAM SE ESTIVER LOGADO)
// ---------------------------------------------------------

app.get('/', (req, res) => res.redirect('/login'));

// Só quem tem token de 'admin' pode acessar
app.get('/admin', verificarToken('admin'), (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Só quem tem token de 'colaborador' (ou admin) pode acessar
app.get('/colaborador', verificarToken(['colaborador', 'admin']), (req, res) => {
    res.sendFile(path.join(__dirname, 'colaborador.html'));
});

// ---------------------------------------------------------
// ROTAS DO WEBHOOK
// ---------------------------------------------------------
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

app.post('/webhook', (req, res) => {
    console.log('\n--- NOVO EVENTO RECEBIDO ---');
    console.log(JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
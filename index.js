/* =========================================================
   QGC TEAM - Servidor Express
   ---------------------------------------------------------
   Rotas: login (JWT em cookie), painel admin, colaborador,
   clientes, ficha, mensagens, listas, webhook da Wati e
   tempo real via SSE.
   ========================================================= */

const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const banco = require('./db');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

/* ---------------------------------------------------------
   PROTEÇÃO DAS ROTAS DE API
   Tudo em /api exige sessão válida, exceto login/logout/health.
   Responde 401 em JSON (o painel trata como sessão expirada).
   --------------------------------------------------------- */
const ROTAS_API_ABERTAS = new Set(['/login', '/logout', '/health']);

app.use('/api', (req, res, next) => {
    if (ROTAS_API_ABERTAS.has(req.path)) return next();

    const token = req.cookies && req.cookies.qgc_token;
    if (!token) {
        return res.status(401).json({ success: false, message: 'Sessão expirada. Faça login novamente.' });
    }

    jwt.verify(token, JWT_SECRET, (erro, decodificado) => {
        if (erro) {
            return res.status(401).json({ success: false, message: 'Sessão expirada. Faça login novamente.' });
        }
        req.user = decodificado;
        next();
    });
});

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// SEGURANÇA / CONFIGURAÇÃO (Environment do Render)
// ---------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_super_segura_123!@#';
const JWT_SECRET_PROPRIO = Boolean(process.env.JWT_SECRET);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // opcional: ?token=... no webhook

// Configurações da Wati (vêm do Environment do Render)
const WATI_TOKEN = process.env.WATI_TOKEN;
const WATI_NUMERO = process.env.WATI_NUMERO;             // número conectado, ex: 5513999999999
const WATI_TENANT = process.env.WATI_TENANT || WATI_NUMERO; // id da URL da API (normalmente = número)
const WATI_HOST = (process.env.WATI_HOST || 'https://live-mt-server.wati.io').replace(/\/+$/, '');

function watiBase() {
    return `${WATI_HOST}/${WATI_TENANT || ''}`.replace(/\/+$/, '');
}

function mascarar(valor) {
    if (!valor) return '';
    const texto = String(valor);
    if (texto.length <= 8) return '••••';
    return texto.substring(0, 4) + '••••' + texto.substring(texto.length - 4);
}

function watiConfigurada() {
    return Boolean(WATI_TOKEN && WATI_TENANT);
}

// ---------------------------------------------------------
// TEMPO REAL (SSE) - avisa o painel sempre que algo muda
// ---------------------------------------------------------
const sseClientes = new Set();

function emitirEvento(tipo, dados) {
    const payload = `event: ${tipo}\ndata: ${JSON.stringify(dados)}\n\n`;
    sseClientes.forEach((res) => {
        try { res.write(payload); } catch (erro) { sseClientes.delete(res); }
    });
}

app.get('/api/eventos', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('event: conectado\ndata: {"ok":true}\n\n');

    sseClientes.add(res);
    const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (erro) { /* conexao fechada */ }
    }, 25000);

    req.on('close', () => {
        clearInterval(ping);
        sseClientes.delete(res);
    });
});

// ---------------------------------------------------------
// ESTRUTURA DO BANCO (cria o que falta, sem apagar nada)
// ---------------------------------------------------------
banco.prepararBanco()
    .then(() => {
        if (banco.modoDemo) {
            console.log('');
            console.log('==================================================');
            console.log(' MODO DEMO LOCAL - banco em memória');
            console.log(' Dados de exemplo já carregados.');
            console.log(' Painel: http://localhost:' + PORT + '/login');
            console.log(' admin@qgcteam.com / 123456');
            console.log(' colaborador@qgcteam.com / 123456');
            console.log('==================================================');
            console.log('');
        }
    })
    .catch((erro) => console.error('Erro ao preparar o banco:', erro.message));

// ---------------------------------------------------------
// AUTENTICAÇÃO
// ---------------------------------------------------------
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/api/login', (req, res) => {
    const { email, senha } = req.body || {};
    let role = null;
    let nome = null;

    if (email === 'admin@qgcteam.com' && senha === '123456') { role = 'admin'; nome = 'Admin Master'; }
    else if (email === 'colaborador@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Claudio'; }
    else if (email === 'vendedor@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Vendedor Jv'; }

    if (role) {
        const token = jwt.sign({ email, role, nome }, JWT_SECRET, { expiresIn: '8h' });
        res.cookie('qgc_token', token, { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 });
        return res.json({ success: true, role, nome });
    }

    return res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });
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

// Diagnóstico rápido (útil para saber se está em modo demo)
app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        modoDemo: banco.modoDemo,
        configurado: {
            wati: watiConfigurada(),
            jwtSecretProprio: JWT_SECRET_PROPRIO,
            webhookSecret: Boolean(WEBHOOK_SECRET)
        },
        wati: {
            host: WATI_HOST,
            tenant: WATI_TENANT || null,
            numero: WATI_NUMERO || null,
            token: mascarar(WATI_TOKEN)
        }
    });
});

// ---------------------------------------------------------
// CANAIS (WhatsApp conectado)
// ---------------------------------------------------------
async function testarWati() {
    if (banco.modoDemo) {
        return { ok: true, demo: true, httpStatus: null, message: 'Modo demo: envio simulado, sem chamar a Wati.' };
    }
    if (!watiConfigurada()) {
        return { ok: false, message: 'WATI_TOKEN e/ou WATI_NUMERO não configurados no Environment do Render.' };
    }

    const url = `${watiBase()}/api/v1/getContacts?pageSize=1`;
    const inicio = Date.now();
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 20000);

    try {
        const resposta = await fetch(url, {
            headers: { Authorization: `Bearer ${WATI_TOKEN}` },
            signal: controle.signal
        });
        const texto = await resposta.text();
        const tempoMs = Date.now() - inicio;

        let dados = null;
        try { dados = texto ? JSON.parse(texto) : null; } catch (erro) { dados = null; }

        if (resposta.ok) {
            return {
                ok: true,
                httpStatus: resposta.status,
                tempoMs,
                message: 'Conexão com a Wati OK.',
                amostra: Array.isArray(dados && dados.contact_list) ? dados.contact_list.length : null
            };
        }

        const detalhe = (dados && (dados.message || dados.error)) || texto.substring(0, 200);
        return { ok: false, httpStatus: resposta.status, tempoMs, message: `Wati respondeu ${resposta.status}: ${detalhe}` };
    } catch (erro) {
        const tempoMs = Date.now() - inicio;
        const motivo = erro.name === 'AbortError' ? 'tempo esgotado (20s)' : erro.message;
        return { ok: false, tempoMs, message: `Falha ao conectar na Wati: ${motivo}` };
    } finally {
        clearTimeout(limite);
    }
}

app.get('/api/canais', (req, res) => {
    res.json([
        {
            id: 'wati',
            nome: 'WhatsApp (Wati)',
            provedor: 'wati',
            host: WATI_HOST,
            tenant: WATI_TENANT || null,
            numero: WATI_NUMERO || null,
            token: mascarar(WATI_TOKEN),
            ativo: watiConfigurada(),
            modoDemo: banco.modoDemo,
            status: banco.modoDemo ? 'demo' : (watiConfigurada() ? 'configurado' : 'pendente')
        }
    ]);
});

app.post('/api/canais/testar', async (req, res) => {
    try {
        const resultado = await testarWati();
        res.status(resultado.ok ? 200 : 502).json(resultado);
    } catch (erro) {
        console.error('Erro ao testar canal:', erro.message);
        res.status(500).json({ ok: false, message: 'Erro inesperado ao testar o canal.' });
    }
});


// ---------------------------------------------------------
// API DO BANCO DE DADOS
// ---------------------------------------------------------
app.post('/api/status', async (req, res) => {
    const { telefone, status } = req.body || {};

    if (!telefone || !status) {
        return res.status(400).json({ success: false, message: 'Informe telefone e status.' });
    }

    try {
        await banco.atualizarStatus(telefone, status);
        emitirEvento('status', { telefone, status });
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao atualizar status:', error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/status', async (req, res) => {
    try {
        res.json(await banco.contarPorStatus());
    } catch (error) {
        console.error('Erro ao contar status:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

app.get('/api/clientes', async (req, res) => {
    const busca = String(req.query.busca || '').trim();
    const status = String(req.query.status || 'ativos');
    const limite = Math.min(parseInt(req.query.limite, 10) || 50, 200);

    try {
        const clientes = await banco.listarClientes({ status, busca, limite });
        res.json(clientes);
    } catch (error) {
        console.error('Erro em /api/clientes:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// RESUMO DO PAINEL (cards + desempenho da equipe)
app.get('/api/dashboard', async (req, res) => {
    try {
        res.json(await banco.resumoDashboard());
    } catch (error) {
        console.error('Erro no dashboard:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// FICHA DO CLIENTE
app.get('/api/clientes/:telefone/ficha', async (req, res) => {
    try {
        const ficha = await banco.obterFicha(req.params.telefone);
        if (!ficha) return res.status(404).json({ error: 'Cliente não encontrado' });
        res.json(ficha);
    } catch (error) {
        console.error('Erro na ficha:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

app.post('/api/clientes/:telefone/ficha', async (req, res) => {
    const telefone = req.params.telefone;
    const { cnpj, socio, cpf, responsavel, outros_socios } = req.body || {};

    try {
        const salvou = await banco.salvarFicha(telefone, {
            cnpj,
            socio,
            cpf,
            responsavel,
            outros_socios: Array.isArray(outros_socios) ? outros_socios : []
        });

        if (!salvou) return res.status(404).json({ success: false, message: 'Cliente não encontrado.' });

        emitirEvento('ficha', { telefone });
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao salvar ficha:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao salvar a ficha.' });
    }
});

// HISTÓRICO DE MENSAGENS DA CONVERSA
app.get('/api/clientes/:telefone/mensagens', async (req, res) => {
    try {
        res.json(await banco.listarMensagens(req.params.telefone));
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// LISTAS (importação de .txt / colagem de contatos)
app.get('/api/listas', async (req, res) => {
    try {
        res.json(await banco.listarListas());
    } catch (error) {
        console.error('Erro ao listar listas:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

app.post('/api/listas', async (req, res) => {
    const { nome, contatos } = req.body || {};

    if (!nome || !String(nome).trim()) {
        return res.status(400).json({ success: false, message: 'Informe um nome para a lista.' });
    }
    if (!Array.isArray(contatos) || !contatos.length) {
        return res.status(400).json({ success: false, message: 'Nenhum contato encontrado.' });
    }

    const vistos = new Set();
    const limpos = [];

    contatos.forEach((item) => {
        const telefone = String((item && item.telefone) || '').replace(/\D/g, '');
        if (!telefone || vistos.has(telefone)) return;
        vistos.add(telefone);
        limpos.push({ telefone, nome: (item && item.nome) || '' });
    });

    if (!limpos.length) {
        return res.status(400).json({ success: false, message: 'Nenhum telefone válido (use DDD + número).' });
    }

    const nomeLimpo = String(nome).trim();

    try {
        const lista = await banco.criarLista(nomeLimpo, limpos);
        emitirEvento('lista', { id: lista.id, nome: nomeLimpo, total: lista.total });
        res.json({ success: true, id: lista.id, total: lista.total });
    } catch (error) {
        console.error('Erro ao salvar lista:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao salvar a lista.' });
    }
});

app.delete('/api/listas/:id', async (req, res) => {
    try {
        await banco.excluirLista(req.params.id);
        emitirEvento('lista', { id: req.params.id, removida: true });
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao excluir lista:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao excluir a lista.' });
    }
});


// ENVIO DE MENSAGEM
// - Modo demo local: simula o envio e grava no banco em memória.
// - Produção: chama a API da Wati.
app.post('/api/enviar-mensagem', async (req, res) => {
    const { telefone, mensagem } = req.body || {};

    if (!telefone || !mensagem || !String(mensagem).trim()) {
        return res.status(400).json({ success: false, message: 'Informe o contato e a mensagem.' });
    }

    // ----- MODO DEMO (sem Wati) -----
    if (banco.modoDemo) {
        try {
            await banco.atualizarUltimaMensagem(telefone, `Você: ${mensagem}`);
            await banco.registrarMensagem(telefone, 'enviada', mensagem);
            emitirEvento('mensagem', { telefone, direcao: 'enviada', texto: mensagem });
            console.log(`[DEMO] Mensagem simulada -> ${telefone}: ${mensagem}`);
            return res.json({ success: true, demo: true });
        } catch (error) {
            console.error('Erro no envio simulado:', error.message);
            return res.status(500).json({ success: false, message: 'Erro ao simular o envio.' });
        }
    }

    // ----- PRODUÇÃO (Wati) -----
    if (!watiConfigurada()) {
        console.error('WATI_TOKEN ou WATI_NUMERO não configurados no Render!');
        return res.status(500).json({ success: false, message: 'API da Wati não configurada no servidor.' });
    }

    try {
        const url = `${watiBase()}/api/v1/sendSessionMessage/${telefone}?messageText=${encodeURIComponent(mensagem)}`;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WATI_TOKEN}` }
        });

        const responseText = await response.text();

        console.log('WATI HTTP STATUS:', response.status);
        console.log('WATI RESPONSE:', responseText);

        let data = {};
        try {
            data = responseText ? JSON.parse(responseText) : {};
        } catch {
            data = { message: responseText || 'Resposta vazia da Wati' };
        }

        if (response.ok && (data.result === true || data.success === true)) {
            await banco.atualizarUltimaMensagem(telefone, `Você: ${mensagem}`);
            await banco.registrarMensagem(telefone, 'enviada', mensagem);
            emitirEvento('mensagem', { telefone, direcao: 'enviada', texto: mensagem });
            return res.json({ success: true });
        }

        console.error('Wati recusou o envio:', data.message || data);
        return res.status(502).json({ success: false, message: data.message || 'Wati recusou o envio.' });
    } catch (error) {
        console.error('Erro ao chamar a API da Wati:', error.message);
        return res.status(500).json({ success: false, message: 'Erro de conexão com a Wati.' });
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { telefone } = req.body || {};

    if (!telefone) return res.status(400).json({ success: false, message: 'Informe o telefone.' });

    try {
        await banco.finalizarAtendimento(telefone);
        emitirEvento('status', { telefone, status: 'finalizado' });
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao finalizar:', error.message);
        res.status(500).json({ success: false });
    }
});

// ---------------------------------------------------------
// WEBHOOK DA WATI
// ---------------------------------------------------------
app.post('/webhook', async (req, res) => {
    try {
        // Se WEBHOOK_SECRET estiver configurado, exige ?token=... (ou header x-webhook-secret)
        if (WEBHOOK_SECRET) {
            const recebido = req.query.token || req.get('x-webhook-secret') || '';
            if (recebido !== WEBHOOK_SECRET) {
                console.warn('Webhook recusado: segredo inválido.');
                return res.sendStatus(401);
            }
        }

        const body = req.body || {};

        if (body.eventType === 'message' && body.text) {
            const telefone = body.waId || 'desconhecido';
            const nome = body.senderName || 'Cliente Novo';
            const mensagem = body.text;

            // Se o cliente voltar a falar, o status volta para 'pensando' (reabre o atendimento)
            await banco.registrarRecebida({ nome, telefone, mensagem });
            await banco.registrarMensagem(telefone, 'recebida', mensagem);

            console.log(`Mensagem salva -> ${nome} (${telefone}): ${mensagem}`);
            emitirEvento('mensagem', { telefone, direcao: 'recebida', texto: mensagem, nome });
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


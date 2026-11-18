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
const { gerarHash, verificarSenha } = require('./senha');

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

app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body || {};
    const emailLimpo = String(email || '').trim();

    if (!emailLimpo || !senha) {
        return res.status(401).json({ success: false, message: 'E-mail ou senha incorretos.' });
    }

    let usuario = null;
    try {
        usuario = await banco.buscarUsuarioPorEmail(emailLimpo);
    } catch (erro) {
        console.error('Erro ao buscar usuário:', erro.message);
    }

    let role = null;
    let nome = null;

    if (usuario && usuario.ativo !== false && verificarSenha(senha, usuario.senha_hash)) {
        role = usuario.role;
        nome = usuario.nome;
    } else if (!usuario) {
        // Contas de emergência: mantêm o acesso mesmo se a tabela usuarios estiver vazia.
        if (emailLimpo === 'admin@qgcteam.com' && senha === '123456') { role = 'admin'; nome = 'Admin Master'; }
        else if (emailLimpo === 'colaborador@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Claudio'; }
        else if (emailLimpo === 'vendedor@qgcteam.com' && senha === '123456') { role = 'colaborador'; nome = 'Vendedor Jv'; }
    }

    if (!role) {
        await banco.registrarAuditoria(emailLimpo, 'login falhou', 'senha incorreta ou usuário desativado');
        const desativado = usuario && usuario.ativo === false;
        return res.status(401).json({
            success: false,
            message: desativado ? 'Usuário desativado. Fale com o administrador.' : 'E-mail ou senha incorretos.'
        });
    }

    const token = jwt.sign({ email: emailLimpo, role, nome }, JWT_SECRET, { expiresIn: '8h' });
    res.cookie('qgc_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 });
    await banco.registrarAuditoria(nome, 'login', emailLimpo);
    return res.json({ success: true, role, nome });
});

app.post('/api/logout', async (req, res) => {
    if (req.user && req.user.nome) await banco.registrarAuditoria(req.user.nome, 'logout', req.user.email);
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

/* Bloqueia rotas restritas ao administrador (usa req.user do guard de /api) */
function exigirAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ success: false, message: 'Sessão expirada. Faça login novamente.' });
    }
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Apenas administradores podem fazer isso.' });
    }
    next();
}

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
        await banco.registrarAuditoria(req.user && req.user.nome, 'status alterado', `${telefone} -> ${status}`);
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
        await banco.registrarAuditoria(req.user && req.user.nome, 'lista importada', `${nomeLimpo} (${lista.total} contatos)`);
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
// - Modo demo local: simula o envio.
// - Produção: chama a API da Wati.
// Usado também pelo worker das campanhas.
async function enviarViaWati(telefone, texto) {
    if (banco.modoDemo) return { ok: true, demo: true };

    if (!watiConfigurada()) {
        console.error('WATI_TOKEN ou WATI_NUMERO não configurados no Render!');
        return { ok: false, message: 'API da Wati não configurada no servidor.' };
    }

    try {
        const url = `${watiBase()}/api/v1/sendSessionMessage/${telefone}?messageText=${encodeURIComponent(texto)}`;
        const resposta = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${WATI_TOKEN}` }
        });

        const corpo = await resposta.text();
        let dados = {};
        try { dados = corpo ? JSON.parse(corpo) : {}; } catch (erro) { dados = { message: corpo }; }

        if (resposta.ok && (dados.result === true || dados.success === true)) return { ok: true };

        console.error('Wati recusou o envio:', resposta.status, corpo);
        return { ok: false, message: dados.message || `Wati recusou o envio (HTTP ${resposta.status}).` };
    } catch (erro) {
        console.error('Erro ao chamar a API da Wati:', erro.message);
        return { ok: false, message: 'Erro de conexão com a Wati.' };
    }
}

app.post('/api/enviar-mensagem', async (req, res) => {
    const { telefone, mensagem } = req.body || {};

    if (!telefone || !mensagem || !String(mensagem).trim()) {
        return res.status(400).json({ success: false, message: 'Informe o contato e a mensagem.' });
    }

    const texto = String(mensagem).trim();
    const ator = req.user && req.user.nome;
    const resultado = await enviarViaWati(telefone, texto);

    if (!resultado.ok) {
        await banco.registrarAuditoria(ator, 'envio falhou', `${telefone}: ${resultado.message}`);
        const naoConfigurada = String(resultado.message || '').includes('não configurada');
        return res.status(naoConfigurada ? 500 : 502).json({ success: false, message: resultado.message });
    }

    try {
        await banco.atualizarUltimaMensagem(telefone, `Você: ${texto}`);
        await banco.registrarMensagem(telefone, 'enviada', texto);
        emitirEvento('mensagem', { telefone, direcao: 'enviada', texto });
        await banco.registrarAuditoria(ator, 'mensagem enviada', telefone);
    } catch (erro) {
        console.error('Erro ao salvar a mensagem enviada:', erro.message);
        return res.json({ success: true, demo: !!resultado.demo, aviso: 'Enviada, mas o histórico não foi salvo.' });
    }

    if (resultado.demo) console.log(`[DEMO] Mensagem simulada -> ${telefone}: ${texto}`);
    return res.json({ success: true, demo: !!resultado.demo });
});

app.post('/api/finalizar', async (req, res) => {
    const { telefone } = req.body || {};

    if (!telefone) return res.status(400).json({ success: false, message: 'Informe o telefone.' });

    try {
        await banco.finalizarAtendimento(telefone);
        emitirEvento('status', { telefone, status: 'finalizado' });
        await banco.registrarAuditoria(req.user && req.user.nome, 'atendimento finalizado', telefone);
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao finalizar:', error.message);
        res.status(500).json({ success: false });
    }
});

// ---------------------------------------------------------
// USUÁRIOS (somente administrador)
// ---------------------------------------------------------
app.get('/api/usuarios', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.listarUsuarios());
    } catch (erro) {
        console.error('Erro ao listar usuários:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao listar usuários.' });
    }
});

app.post('/api/usuarios', exigirAdmin, async (req, res) => {
    const { email, nome, senha, role } = req.body || {};
    const emailLimpo = String(email || '').trim().toLowerCase();
    const nomeLimpo = String(nome || '').trim();
    const senhaLimpa = String(senha || '');
    const papel = role === 'admin' ? 'admin' : 'colaborador';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLimpo)) {
        return res.status(400).json({ success: false, message: 'Informe um e-mail válido.' });
    }
    if (!nomeLimpo) {
        return res.status(400).json({ success: false, message: 'Informe o nome do usuário.' });
    }
    if (senhaLimpa.length < 6) {
        return res.status(400).json({ success: false, message: 'A senha precisa ter pelo menos 6 caracteres.' });
    }

    try {
        const existente = await banco.buscarUsuarioPorEmail(emailLimpo);
        if (existente) {
            return res.status(409).json({ success: false, message: 'Já existe um usuário com este e-mail.' });
        }

        const criado = await banco.criarUsuario({
            email: emailLimpo,
            nome: nomeLimpo,
            senhaHash: gerarHash(senhaLimpa),
            role: papel
        });

        await banco.registrarAuditoria(req.user && req.user.nome, 'usuário criado', `${emailLimpo} (${papel})`);
        res.json({ success: true, usuario: criado });
    } catch (erro) {
        console.error('Erro ao criar usuário:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao criar o usuário.' });
    }
});

app.patch('/api/usuarios/:id', exigirAdmin, async (req, res) => {
    const { nome, role, ativo, senha } = req.body || {};
    const id = req.params.id;

    if (senha !== undefined && String(senha).length < 6) {
        return res.status(400).json({ success: false, message: 'A senha precisa ter pelo menos 6 caracteres.' });
    }

    try {
        const alvo = (await banco.listarUsuarios()).find((u) => String(u.id) === String(id));
        if (!alvo) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        // o admin não pode se desativar / se rebaixar (evita perder o acesso ao painel)
        const ehProprio = req.user && String(alvo.email).toLowerCase() === String(req.user.email || '').toLowerCase();
        if (ehProprio && ativo === false) {
            return res.status(400).json({ success: false, message: 'Você não pode desativar o próprio usuário.' });
        }
        if (ehProprio && role && role !== 'admin') {
            return res.status(400).json({ success: false, message: 'Você não pode remover o seu próprio acesso de admin.' });
        }

        const alterou = await banco.atualizarUsuario(id, {
            nome: nome !== undefined ? String(nome).trim() : undefined,
            role: role === 'admin' ? 'admin' : (role === 'colaborador' ? 'colaborador' : undefined),
            ativo: ativo === undefined ? undefined : !!ativo,
            senhaHash: senha ? gerarHash(String(senha)) : undefined
        });

        if (!alterou) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        await banco.registrarAuditoria(req.user && req.user.nome, 'usuário atualizado', `id ${id}`);
        res.json({ success: true });
    } catch (erro) {
        console.error('Erro ao atualizar usuário:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao atualizar o usuário.' });
    }
});

app.delete('/api/usuarios/:id', exigirAdmin, async (req, res) => {
    try {
        const alvo = (await banco.listarUsuarios()).find((u) => String(u.id) === String(req.params.id));
        if (alvo && req.user && String(alvo.email).toLowerCase() === String(req.user.email).toLowerCase()) {
            return res.status(400).json({ success: false, message: 'Você não pode excluir o próprio usuário.' });
        }

        const removeu = await banco.excluirUsuario(req.params.id);
        if (!removeu) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        await banco.registrarAuditoria(req.user && req.user.nome, 'usuário excluído', alvo ? alvo.email : `id ${req.params.id}`);
        res.json({ success: true });
    } catch (erro) {
        console.error('Erro ao excluir usuário:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao excluir o usuário.' });
    }
});

// ---------------------------------------------------------
// LOGS (histórico de mensagens) E AUDITORIA (ações do painel)
// ---------------------------------------------------------
app.get('/api/logs', async (req, res) => {
    const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);
    const direcao = String(req.query.direcao || '');

    try {
        res.json(await banco.listarLogs({ limite, direcao }));
    } catch (erro) {
        console.error('Erro ao listar logs:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao carregar os logs.' });
    }
});

app.get('/api/auditoria', exigirAdmin, async (req, res) => {
    const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);

    try {
        res.json(await banco.listarAuditoria(limite));
    } catch (erro) {
        console.error('Erro ao listar auditoria:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao carregar a auditoria.' });
    }
});

// ---------------------------------------------------------
// CAMPANHAS (fila de envio com intervalo entre mensagens)
// ---------------------------------------------------------
let processandoCampanhas = false;

async function processarCampanhas() {
    if (processandoCampanhas) return;
    processandoCampanhas = true;

    try {
        for (let i = 0; i < 5; i++) {
            const item = await banco.proximoEnvioPendente();
            if (!item) break;
            if (!(await banco.reservarEnvio(item.envio_id))) continue;

            // Personalização: {{nome}} vira o nome do contato vindo da lista
            const nomeContato = String(item.nome || '').trim();
            const textoFinal = String(item.mensagem || '')
                .replace(/\{\{\s*nome\s*\}\}/gi, nomeContato)
                .replace(/ {2,}/g, ' ')
                .trim();

            const resultado = await enviarViaWati(item.telefone, textoFinal);
            await banco.concluirEnvio(item.envio_id, item.campanha_id, resultado.ok, resultado.message);

            if (resultado.ok) {
                await banco.registrarMensagem(item.telefone, 'enviada', textoFinal);
                await banco.atualizarUltimaMensagem(item.telefone, `Você: ${textoFinal}`);
                emitirEvento('mensagem', { telefone: item.telefone, direcao: 'enviada', texto: textoFinal });
            } else {
                console.warn(`Campanha ${item.campanha} -> ${item.telefone}: ${resultado.message}`);
            }

            emitirEvento('campanha', {
                id: item.campanha_id,
                telefone: item.telefone,
                ok: resultado.ok,
                erro: resultado.message || null
            });
        }
    } catch (erro) {
        console.error('Erro no worker de campanhas:', erro.message);
    } finally {
        processandoCampanhas = false;
    }
}

setInterval(processarCampanhas, 4000).unref();

app.get('/api/campanhas', async (req, res) => {
    try {
        res.json(await banco.listarCampanhas());
    } catch (erro) {
        console.error('Erro ao listar campanhas:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao listar campanhas.' });
    }
});

app.post('/api/campanhas', exigirAdmin, async (req, res) => {
    const { nome, listaId, mensagem, intervalo } = req.body || {};

    if (!nome || !String(nome).trim()) {
        return res.status(400).json({ success: false, message: 'Informe um nome para a campanha.' });
    }
    if (!mensagem || !String(mensagem).trim()) {
        return res.status(400).json({ success: false, message: 'Escreva a mensagem da campanha.' });
    }
    if (!listaId) {
        return res.status(400).json({ success: false, message: 'Escolha a lista de contatos.' });
    }

    try {
        const contatos = await banco.obterContatosLista(listaId);
        if (!contatos.length) {
            return res.status(400).json({ success: false, message: 'A lista escolhida está vazia.' });
        }

        // 3 segundos no mínimo (proteção contra bloqueio do WhatsApp), 2 minutos no máximo
        const intervaloMs = Math.min(Math.max(parseInt(intervalo, 10) || 8000, 3000), 120000);

        const campanha = await banco.criarCampanha({
            nome: String(nome).trim(),
            listaId: parseInt(listaId, 10) || null,
            mensagem: String(mensagem).trim(),
            intervaloMs,
            contatos
        });

        emitirEvento('campanha', { id: campanha.id, criada: true, total: campanha.total });
        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'campanha criada',
            `${campanha.id} - ${String(nome).trim()} (${campanha.total} contatos, ${intervaloMs} ms)`
        );

        res.json({ success: true, id: campanha.id, total: campanha.total, intervaloMs });
    } catch (erro) {
        console.error('Erro ao criar campanha:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao criar a campanha.' });
    }
});

app.post('/api/campanhas/:id/:acao', exigirAdmin, async (req, res) => {
    const mapa = { pausar: 'pausada', retomar: 'ativa', cancelar: 'cancelada' };
    const novoStatus = mapa[req.params.acao];

    if (!novoStatus) {
        return res.status(400).json({ success: false, message: 'Ação inválida.' });
    }

    try {
        const alterou = await banco.atualizarStatusCampanha(req.params.id, novoStatus);
        if (!alterou) {
            return res.status(404).json({ success: false, message: 'Campanha não encontrada.' });
        }

        emitirEvento('campanha', { id: req.params.id, status: novoStatus });
        await banco.registrarAuditoria(req.user && req.user.nome, 'campanha ' + req.params.acao, String(req.params.id));
        res.json({ success: true, status: novoStatus });
    } catch (erro) {
        console.error('Erro ao alterar campanha:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao alterar a campanha.' });
    }
});

app.delete('/api/campanhas/:id', exigirAdmin, async (req, res) => {
    try {
        const removeu = await banco.excluirCampanha(req.params.id);
        if (!removeu) {
            return res.status(404).json({ success: false, message: 'Campanha não encontrada.' });
        }

        emitirEvento('campanha', { id: req.params.id, removida: true });
        await banco.registrarAuditoria(req.user && req.user.nome, 'campanha excluída', String(req.params.id));
        res.json({ success: true });
    } catch (erro) {
        console.error('Erro ao excluir campanha:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao excluir a campanha.' });
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


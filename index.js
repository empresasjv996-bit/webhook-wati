/* =========================================================
   QGC TEAM by JV - Servidor Express
   ---------------------------------------------------------
   Rotas: login (JWT em cookie), painel admin, colaborador,
   clientes, ficha, mensagens, listas, webhook da Wati e
   tempo real via SSE.
   ========================================================= */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const banco = require('./db');
const { gerarHash, verificarSenha } = require('./senha');
const { analisarListaTelefones } = require('./telefone');
const { validarCnpj, formatarCnpj, normalizarEmpresa } = require('./cnpj');
const extrator = require('./extrator');
const criarRotasSpyhub = require('./routes/contatos-spyhub');

const app = express();
/* 3 MB: o dump/CSV do SpyHub chega inteiro por texto no corpo do POST
   (o limite padrão de 100 kB cortava listas a partir de ~120 registros). */
app.use(express.json({ limit: '3mb' }));
app.use(cookieParser());

/* ---------------------------------------------------------
   ARQUIVOS ESTÁTICOS (lista branca)
   Antes era express.static(__dirname), então /index.js, /db.js,
   /package.json e as pastas listas/, downloads/ e backups/ saíam
   pela web sem login. Agora só o front do painel é público.
   --------------------------------------------------------- */
const ARQUIVOS_PUBLICOS = new Set([
    'index.html',
    'app.js',
    'style.css',
    'login.html',
    'login.css',
    'colaborador.html',
    'colaborador.css',
    'colaborador.js',
    'lista-suja.js',
    'logo-qgc.png.jpeg',
    'favicon.ico'
]);

const estaticoPublico = express.static(__dirname, {
    index: 'index.html',
    dotfiles: 'deny',
    fallthrough: true
});

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const caminho = String(req.path || '/').replace(/^\/+/, '');

    // "/" continua entregando o index.html; qualquer outro caminho precisa
    // estar na lista branca (subpastas e código do servidor caem no 404).
    if (caminho && !ARQUIVOS_PUBLICOS.has(caminho)) return next();

    return estaticoPublico(req, res, next);
});

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

/* ---------------------------------------------------------
   QUEM ESTÁ ONLINE AGORA (painel do admin)
   O painel manda um sinal a cada 30s enquanto a aba está
   visível; sem sinal por 90s o usuário aparece como offline.
   O controle fica na memória do processo (o painel roda em
   uma instância só no Render).
   --------------------------------------------------------- */
const PRESENCA_JANELA_MS = 90 * 1000;
const presencas = new Map();

function chavePresenca(usuario) {
    const email = typeof usuario === 'string' ? usuario : (usuario && usuario.email);
    return String(email || '').trim().toLowerCase();
}

function marcarPresenca(usuario) {
    const chave = chavePresenca(usuario);
    if (!chave) return null;

    const agora = Date.now();
    const atual = presencas.get(chave) || {};
    const registro = {
        email: chave,
        nome: (usuario && usuario.nome) || atual.nome || chave,
        role: (usuario && usuario.role) || atual.role || 'colaborador',
        desde: atual.desde || agora,
        ultimoSinal: agora,
        ausente: false
    };

    presencas.set(chave, registro);
    return registro;
}

/* A aba foi escondida ou o usuário saiu: fica offline na hora, mas guarda
   quando foi visto pela última vez (o admin mostra "visto há X min"). */
function marcarAusente(usuario) {
    const chave = chavePresenca(usuario);
    const atual = presencas.get(chave);
    if (!chave || !atual) return null;

    const registro = Object.assign({}, atual, { ausente: true, ultimoSinal: Date.now() });
    presencas.set(chave, registro);
    return registro;
}

/* Online = deu sinal (login, heartbeat) nos últimos 90s e não avisou que saiu. */
function presencaDoUsuario(usuario) {
    const registro = presencas.get(chavePresenca(usuario));
    if (!registro) return { online: false, desde: null, ultimoSinal: null };

    return {
        online: !registro.ausente && (Date.now() - registro.ultimoSinal <= PRESENCA_JANELA_MS),
        desde: new Date(registro.desde).toISOString(),
        ultimoSinal: new Date(registro.ultimoSinal).toISOString()
    };
}

/* Lê a sessão do cookie mesmo em rotas abertas (ex.: /api/logout). */
function usuarioDoCookie(req) {
    const token = req.cookies && req.cookies.qgc_token;
    if (!token) return null;

    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (erro) {
        return null;
    }
}

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------
// SEGURANÇA / CONFIGURAÇÃO (Environment do Render)
// ---------------------------------------------------------
const JWT_SECRET_ENV = process.env.JWT_SECRET || '';
const JWT_SECRET_PROPRIO = Boolean(JWT_SECRET_ENV);

// Preenchidos no boot (iniciarServidor): env > segredo persistido no banco > temporário.
let JWT_SECRET = JWT_SECRET_ENV;
let jwtSegredoOrigem = JWT_SECRET_PROPRIO ? 'env' : 'pendente';

const WEBHOOK_SECRET_ENV = process.env.WEBHOOK_SECRET || '';

// Estado do webhook (carregado no boot): o segredo pode vir do Render (env) ou
// ser gerado e guardado no banco, com um interruptor para exigir o token.
let webhookSecretBanco = '';
let webhookSecretAtivo = false;
let webhookSecretOrigem = WEBHOOK_SECRET_ENV ? 'env' : 'desativado';

function segredoWebhookEsperado() {
    if (WEBHOOK_SECRET_ENV) return WEBHOOK_SECRET_ENV;
    return webhookSecretAtivo ? webhookSecretBanco : '';
}

/* Compara em tempo constante para não vazar o segredo por diferença de tempo. */
function segredoConfere(recebido, esperado) {
    const a = Buffer.from(String(recebido || ''));
    const b = Buffer.from(String(esperado || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function gerarSegredoJwt() {
    return crypto.randomBytes(48).toString('hex');
}

function gerarSegredoWebhook() {
    return crypto.randomBytes(24).toString('hex');
}

/* O segredo do JWT precisa ser o mesmo em todos os reinícios, senão todo mundo
   é deslogado. Preferência: JWT_SECRET do Render (fica fora do banco) e, se ele
   não existir, um segredo aleatório guardado na tabela configuracoes. */
async function carregarSegredoJwt() {
    if (JWT_SECRET_PROPRIO) return { valor: JWT_SECRET_ENV, origem: 'env' };

    try {
        const salvo = await banco.obterOuCriarConfiguracao('jwt_secret', gerarSegredoJwt);
        if (salvo) return { valor: salvo, origem: 'banco' };
    } catch (erro) {
        console.warn('JWT: não foi possível ler/gravar o segredo no banco:', erro.message);
    }

    return { valor: gerarSegredoJwt(), origem: 'temporario' };
}

/* Gera (uma vez) o segredo do webhook e lê o interruptor de exigência.
   A URL com ?token=... é montada no painel (Canais → Webhook seguro). */
async function carregarSegredoWebhook() {
    if (WEBHOOK_SECRET_ENV) return { secret: WEBHOOK_SECRET_ENV, ativo: true, origem: 'env' };

    try {
        const secret = await banco.obterOuCriarConfiguracao('webhook_secret', gerarSegredoWebhook);
        const flag = await banco.obterConfiguracao('webhook_secret_ativo');
        const ativo = flag === '1';
        return { secret, ativo, origem: ativo ? 'banco' : 'desativado' };
    } catch (erro) {
        console.warn('WEBHOOK: não foi possível ler/gravar o segredo no banco:', erro.message);
        return { secret: '', ativo: false, origem: 'desativado' };
    }
}

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

/* Nome de atributo aceito pela Wati: minúsculo, sem acento e com "_"
   (ex.: "Razão Social" -> "razao_social"). */
function normalizarAtributo(nome) {
    return String(nome || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 40);
}

/* Só mantém atributos com nome e valor; ignora chaves vazias. */
function limparAtributos(atributos) {
    const saida = {};

    Object.keys(atributos || {}).forEach((chave) => {
        const nome = normalizarAtributo(chave);
        const valor = String(atributos[chave] == null ? '' : atributos[chave]).trim();
        if (!nome || !valor) return;
        saida[nome] = valor.substring(0, 500);
    });

    return saida;
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

app.get('/api/eventos', exigirAdmin, (req, res) => {
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
// ESTRUTURA DO BANCO E SEGREDO DO JWT
// Roda em iniciarServidor() (fim do arquivo), antes de abrir a porta.
// ---------------------------------------------------------

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
    marcarPresenca({ email: emailLimpo, role, nome });
    await banco.registrarAuditoria(nome, 'login', emailLimpo);
    return res.json({ success: true, role, nome });
});

app.post('/api/logout', async (req, res) => {
    /* /api/logout é rota aberta (o guard não preenche req.user), então a
       sessão é lida direto do cookie para marcar o usuário como offline. */
    const sessao = req.user || usuarioDoCookie(req);

    if (sessao) {
        marcarAusente(sessao);
        try { await banco.registrarAuditoria(sessao.nome, 'logout', sessao.email); } catch (erro) { /* auditoria é opcional */ }
    }

    res.clearCookie('qgc_token');
    res.redirect('/login');
});

/* Sinal de presença do painel (colaborador e admin). O front chama a cada
   30s enquanto a aba está visível; { ativo: false } marca como offline. */
app.post('/api/presenca', (req, res) => {
    if (!req.user) {
        return res.status(401).json({ success: false, online: false, message: 'Sessão expirada. Faça login novamente.' });
    }

    if (req.body && req.body.ativo === false) {
        marcarAusente(req.user);
        return res.json({ success: true, online: false, janela: PRESENCA_JANELA_MS });
    }

    const registro = marcarPresenca(req.user);
    return res.json({
        success: true,
        online: true,
        nome: registro.nome,
        desde: new Date(registro.desde).toISOString(),
        janela: PRESENCA_JANELA_MS
    });
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

/* ---------------------------------------------------------
   ISOLAMENTO DOS COLABORADORES
   Cada lead pertence ao vendedor_email gravado na campanha.
   O admin acessa tudo; o colaborador somente os leads dele.
   --------------------------------------------------------- */
function ehAdmin(req) {
    return Boolean(req.user && req.user.role === 'admin');
}

async function verificarDonoDoCliente(req, telefone) {
    if (ehAdmin(req)) return { ok: true, admin: true, dono: null };

    if (!req.user || !telefone) return { ok: false, motivo: 'sem_sessao' };

    const dono = await banco.obterDonoCliente(telefone);
    if (!dono) return { ok: false, motivo: 'nao_encontrado' };

    const emailDono = String(dono.vendedor_email || '').trim().toLowerCase();
    const emailUsuario = String(req.user.email || '').trim().toLowerCase();

    if (!emailDono || !emailUsuario || emailDono !== emailUsuario) {
        return { ok: false, motivo: 'sem_permissao', dono };
    }

    return { ok: true, admin: false, dono };
}

function responderAcessoNegado(res, verificacao) {
    if (verificacao.motivo === 'nao_encontrado') {
        return res.status(404).json({ success: false, message: 'Cliente não encontrado.' });
    }
    return res.status(403).json({
        success: false,
        message: 'Este contato não está na sua carteira. Fale com o administrador.'
    });
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
        uptimeSegundos: Math.round(process.uptime()),
        configurado: {
            wati: watiConfigurada(),
            jwtSecretProprio: JWT_SECRET_PROPRIO,
            jwtSecretOrigem: jwtSegredoOrigem,
            webhookSecret: Boolean(segredoWebhookEsperado()),
            webhookSecretOrigem,
            webhookSecretDisponivel: Boolean(WEBHOOK_SECRET_ENV || webhookSecretBanco)
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

/* ---------------------------------------------------------
   CONTATOS NA WATI (importação de listas)
   Grava o contato já com os atributos mapeados no painel. A Wati cria o
   atributo na conta no primeiro uso, então ele passa a aparecer também na
   importação de CSV dentro da Wati.
   --------------------------------------------------------- */
async function watiRequisicao(url, metodo, corpo) {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 20000);

    try {
        const resposta = await fetch(url, {
            method: metodo,
            headers: {
                Authorization: `Bearer ${WATI_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: corpo ? JSON.stringify(corpo) : undefined,
            signal: controle.signal
        });

        const texto = await resposta.text();
        let dados = null;
        try { dados = texto ? JSON.parse(texto) : null; } catch (erro) { dados = null; }

        return { ok: resposta.ok, status: resposta.status, dados, texto };
    } catch (erro) {
        const motivo = erro.name === 'AbortError' ? 'tempo esgotado (20s)' : erro.message;
        return { ok: false, status: 0, dados: null, texto: motivo };
    } finally {
        clearTimeout(limite);
    }
}

/* A Wati devolve o motivo de várias formas: texto simples, lista ou objeto
   aninhado com o erro da Cloud API da Meta:
   { result: false, message: { error: { code: 131047, message: '...' } } }
   Aqui tudo vira uma frase curta — o painel nunca deve mostrar "[object Object]". */
function achatarErroWati(valor, nivel) {
    const profundidade = nivel || 0;

    if (valor === null || valor === undefined) return '';
    if (typeof valor === 'string') return valor.trim();
    if (typeof valor === 'number' || typeof valor === 'boolean') return String(valor);
    if (profundidade > 4) return '';

    if (Array.isArray(valor)) {
        return valor
            .map((item) => achatarErroWati(item, profundidade + 1))
            .filter(Boolean)
            .join(' | ');
    }

    if (typeof valor === 'object') {
        const codigo = valor.code || valor.statusCode || valor.status;

        const detalhe = achatarErroWati(valor.message, profundidade + 1)
            || achatarErroWati(valor.error, profundidade + 1)
            || achatarErroWati(valor.info, profundidade + 1)
            || achatarErroWati(valor.title, profundidade + 1)
            || achatarErroWati(valor.description, profundidade + 1)
            || achatarErroWati(valor.detail, profundidade + 1);

        if (codigo && detalhe) return `código ${codigo}: ${detalhe}`;
        if (detalhe) return detalhe;

        if (codigo) {
            /* A Wati às vezes devolve só o código — o painel mostrava "código 1"
               e ninguém sabia o que fazer. Aqui a resposta crua vai junto (a não
               ser que ela seja só o próprio código, tipo {"code":1}). */
            let bruto = '';
            try { bruto = JSON.stringify(valor) || ''; } catch (erro) { bruto = ''; }

            const semCodigo = bruto.replace(/[\s{}"'\[\],:]|code|codigo|error/gi, '');
            const soCodigo = !semCodigo || semCodigo === String(codigo);

            return soCodigo ? `código ${codigo}` : `código ${codigo} (resposta da Wati: ${bruto.substring(0, 240)})`;
        }

        try {
            return JSON.stringify(valor).substring(0, 300);
        } catch (erro) {
            return '';
        }
    }

    return String(valor);
}

/* A Meta só aceita texto livre até 24h depois da última mensagem do cliente.
   Fora disso a Wati recusa com 131047 / 470 ("Re-engagement message") ou com
   "Ticket has been expired" (o ticket de atendimento venceu) — o caso típico
   dos contatos que só receberam a campanha e nunca responderam. */
function erroJanelaFechada(motivo) {
    const texto = String(motivo || '').toLowerCase();

    return texto.includes('131047')
        || texto.includes('re-engagement')
        || texto.includes('reengagement')
        || texto.includes('re engage')
        || texto.includes('24 hour')
        || texto.includes('24h')
        || texto.includes('janela de 24')
        || texto.includes('outside the allowed window')
        || texto.includes('message failed to send because more than 24 hours')
        || texto.includes('invalid conversation')
        || texto.includes('conversa inválida')
        || texto.includes('conversa invalida')
        || (texto.includes('ticket') && (texto.includes('expir') || texto.includes('vencid') || texto.includes('fechad')));
}

/* Importante (testado em produção): enviar um template NÃO reabre o texto livre.
   A Meta/Wati só libera texto livre quando o CLIENTE responde — o template serve
   para reengajar o contato, não para destravar a conversa. */
const ORIENTACAO_JANELA_FECHADA = 'A conversa deste cliente está sem ticket aberto: o WhatsApp só aceita texto livre até 24h '
    + 'depois da última mensagem dele. O template aprovado (barra "Ticket vencido?", acima do campo de mensagem) reengaja o '
    + 'cliente, mas o texto livre só volta quando ele responder — se o cliente já recebeu o template, aguarde a resposta.';

function descreverErroWati(resposta) {
    if (!resposta) return 'sem resposta';

    const dados = resposta.dados;
    let detalhe = achatarErroWati(dados && (dados.message || dados.error || dados.info));

    if (!detalhe && dados && Array.isArray(dados.errors) && dados.errors.length) {
        detalhe = achatarErroWati(dados.errors[0]);
    }

    if (detalhe) return `HTTP ${resposta.status}: ${detalhe.substring(0, 200)}`;
    if (resposta.status) return `HTTP ${resposta.status}`;

    return achatarErroWati(resposta.texto) || 'falha de conexão';
}

/* A Wati responde 200 com `message` = objeto da mensagem criada
   ({ whatsappMessageId, localMessageId, text, ... }) — às vezes SEM result:true.
   Nesse caso o envio já saiu; tratar como erro só fazia o atendente reenviar e
   duplicar a mensagem no WhatsApp do cliente. */
function mensagemCriadaNaWati(dados) {
    if (!dados || typeof dados !== 'object' || Array.isArray(dados)) return false;
    if (dados.result === true || dados.success === true) return true;

    const mensagem = dados.message;
    if (!mensagem || typeof mensagem !== 'object' || Array.isArray(mensagem)) return false;

    return !!(mensagem.whatsappMessageId || mensagem.localMessageId);
}

/* A Wati às vezes responde 200 com result:false — não dá para confiar só no HTTP. */
function watiSucesso(resposta) {
    if (!resposta || !resposta.ok) return false;

    const dados = resposta.dados;
    if (dados && typeof dados === 'object') {
        if (dados.result === true || dados.success === true) return true;
        if (mensagemCriadaNaWati(dados)) return true;
        if (dados.result === false || dados.success === false) return false;
        if (Array.isArray(dados.errors) && dados.errors.length) return false;
        if (Array.isArray(dados.contact_list) && dados.contact_list.some((item) => item && item.result === false)) return false;
    }

    return true;
}

async function salvarContatoNaWati({ telefone, nome, atributos }) {
    if (banco.modoDemo) return { ok: true, demo: true };

    if (!watiConfigurada()) {
        return { ok: false, message: 'WATI_TOKEN e/ou WATI_NUMERO não configurados no Environment do Render.' };
    }

    const numero = String(telefone || '').replace(/\D/g, '');
    if (!numero) return { ok: false, message: 'Telefone inválido.' };

    const params = Object.keys(atributos || {}).map((chave) => ({ name: chave, value: atributos[chave] }));
    const tentativas = [];

    // 1) API v3: contato novo já com os atributos
    let resposta = await watiRequisicao(`${WATI_HOST}/api/ext/v3/contacts`, 'POST', {
        whatsapp_number: numero,
        name: nome || undefined,
        custom_params: params
    });
    if (watiSucesso(resposta)) return { ok: true, via: 'v3-add' };
    tentativas.push(`v3-add ${descreverErroWati(resposta)}`);

    // 2) API v3: contato que já existe -> atualiza os atributos
    if (params.length) {
        resposta = await watiRequisicao(`${WATI_HOST}/api/ext/v3/contacts`, 'PUT', {
            contacts: [{ target: numero, customParams: params }]
        });
        if (watiSucesso(resposta)) return { ok: true, via: 'v3-atualizado' };
        tentativas.push(`v3-atualizado ${descreverErroWati(resposta)}`);
    }

    // 3) API v1 (contas que ainda não têm a v3 liberada)
    resposta = await watiRequisicao(`${watiBase()}/api/v1/addContact/${numero}`, 'POST', {
        name: nome || numero,
        customParams: params
    });
    if (watiSucesso(resposta)) return { ok: true, via: 'v1-add' };
    tentativas.push(`v1-add ${descreverErroWati(resposta)}`);

    const respostaAdd = resposta;

    if (params.length) {
        resposta = await watiRequisicao(`${watiBase()}/api/v1/updateContactAttributes/${numero}`, 'POST', {
            customParams: params
        });
        if (watiSucesso(resposta)) return { ok: true, via: 'v1-atributos' };
        tentativas.push(`v1-atributos ${descreverErroWati(resposta)}`);
    }

    // Contato já existia e não havia atributo novo para gravar.
    const textoAdd = `${(respostaAdd && respostaAdd.texto) || ''} ${JSON.stringify((respostaAdd && respostaAdd.dados) || {})}`.toLowerCase();
    if (/exist|already|duplicate|cadastrad/.test(textoAdd)) {
        return { ok: true, via: 'ja-existia' };
    }

    return { ok: false, message: `A Wati recusou (${tentativas.join(' | ')}).` };
}

/* A Wati responde HTTP 200 com result:false e a frase "Contact with phone
   number 5562... not found" quando o contato não existe na conta dela. Nesse
   caso o certo é criar o contato e repetir o envio uma vez. */
function contatoInexistenteNaWati(motivo) {
    const texto = String(motivo || '').toLowerCase();

    return texto.includes('contact with phone number')
        || texto.includes('contact not found')
        || texto.includes('contact does not exist')
        || texto.includes('contato não encontrado')
        || texto.includes('contato nao encontrado');
}

/* Garante o contato na Wati antes/depois de um envio: usa o nome da ficha
   quando existe e nunca derruba a requisição (só loga a falha). */
async function garantirContatoNaWati(telefone) {
    const numero = String(telefone || '').replace(/\D/g, '');
    if (!numero) return { ok: false, message: 'Telefone inválido.' };

    let nome = '';
    try {
        const ficha = await banco.obterFicha(numero);
        nome = String((ficha && (ficha.nome || ficha.socio)) || '').trim().substring(0, 120);
    } catch (erro) { /* segue sem nome */ }

    const resultado = await salvarContatoNaWati({ telefone: numero, nome });

    if (resultado.ok) console.log(`Contato ${numero} garantido na Wati (${resultado.via || 'ok'}).`);
    else console.warn(`Não foi possível criar o contato ${numero} na Wati: ${resultado.message}`);

    return resultado;
}

/* ---------------------------------------------------------
   TEMPLATES APROVADOS NA WATI
   ---------------------------------------------------------
   A Wati guarda o corpo com as variáveis ({{1}}, {{2}} ou {{nome}})
   e o envio precisa receber cada valor pelo NOME da variável.
   Lemos a lista de templates (v3 e, se a conta ainda não tiver a v3,
   a v1) e normalizamos tudo para o painel montar o formulário. */

const TEMPLATES_DEMO = [
    {
        nome: 'teste_painel',
        idioma: 'pt_BR',
        status: 'APPROVED',
        categoria: 'MARKETING',
        corpo: 'Olá {{1}}, temos uma novidade sobre {{2}}.',
        variaveis: ['1', '2'],
        aprovado: true
    },
    {
        nome: 'boas_vindas',
        idioma: 'pt_BR',
        status: 'APPROVED',
        categoria: 'UTILITY',
        corpo: 'Olá {{nome}}, seu cadastro foi recebido com sucesso.',
        variaveis: ['nome'],
        aprovado: true
    }
];

const CACHE_TEMPLATES_MS = 5 * 60 * 1000;
let cacheTemplates = { quando: 0, resultado: null };

/* Nomes das variáveis: tudo entre {{ }} nos textos + nomes extras
   (customParams da própria Wati, que cobrem cabeçalho/mídia). */
function extrairVariaveisTemplate(corpo, extras) {
    const nomes = [];

    function adicionar(nome) {
        const limpo = String(nome == null ? '' : nome).trim();
        if (!limpo || limpo.length > 40) return;
        if (!/^[A-Za-z0-9_. -]+$/.test(limpo)) return;
        if (!nomes.includes(limpo)) nomes.push(limpo);
    }

    String(corpo || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (achado, nome) => {
        adicionar(nome);
        return achado;
    });

    (Array.isArray(extras) ? extras : []).forEach(adicionar);

    return nomes;
}

function listaDeTemplates(dados) {
    if (Array.isArray(dados)) return dados;
    if (!dados || typeof dados !== 'object') return [];

    const campos = ['messageTemplates', 'templates', 'data', 'items', 'results', 'content'];

    for (const campo of campos) {
        const valor = dados[campo];
        if (Array.isArray(valor)) return valor;
        if (valor && typeof valor === 'object') {
            const interno = listaDeTemplates(valor);
            if (interno.length) return interno;
        }
    }

    return [];
}

/* Aceita o formato v1 (messageTemplates[].body + customParams) e o v3
   (body/header/footer/buttons + custom_params). O que o envio usa é o NOME
   de cada parâmetro, então é ele que precisa chegar ao painel. */
function normalizarTemplateWati(item) {
    if (!item || typeof item !== 'object') return null;

    const nome = String(valorAninhado(item, ['name', 'template_name', 'templateName', 'elementName']) || '').trim();
    if (!nome) return null;

    const status = String(valorAninhado(item, ['status', 'templateStatus', 'approvalStatus', 'state']) || '').trim();
    const categoria = String(valorAninhado(item, ['category', 'templateCategory']) || '').trim();

    // v3 devolve language_option { key, value, text }; v1 devolve a sigla direto.
    const opcaoIdioma = item.language_option || item.languageOption || (item.template && item.template.language_option);
    const idioma = String(
        valorAninhado(item, ['language', 'languageCode', 'language_code', 'lang'])
        || valorAninhado(opcaoIdioma, ['value', 'key', 'text'])
        || ''
    ).trim();

    let corpo = String(valorAninhado(item, ['body', 'bodyText', 'body_text', 'content', 'message']) || '').trim();

    if (!corpo) {
        const listas = [item.components, item.template && item.template.components, item.data && item.data.components]
            .filter(Array.isArray);

        for (const componentes of listas) {
            const bloco = componentes.find((componente) => {
                const tipo = String((componente && (componente.type || componente.Type || componente.componentType)) || '');
                return /body/i.test(tipo);
            });

            if (bloco) {
                corpo = String(valorAninhado(bloco, ['text', 'body', 'content', 'value']) || '').trim();
                if (corpo) break;
            }
        }
    }

    // Todo texto que pode trazer {{variavel}}: corpo, cabeçalho (texto/link de
    // mídia dinâmica), rodapé e URL de botão.
    const textos = [corpo];
    const cabecalho = item.header && typeof item.header === 'object' ? item.header : null;

    if (cabecalho) {
        textos.push(cabecalho.text, cabecalho.link, cabecalho.fileName, cabecalho.filename);
    }
    if (item.footer) textos.push(typeof item.footer === 'string' ? item.footer : item.footer.text);
    if (Array.isArray(item.buttons)) {
        item.buttons.forEach((botao) => {
            if (!botao || typeof botao !== 'object') return;
            textos.push(valorAninhado(botao, ['text', 'url', 'url_original']));
            textos.push(valorAninhado(botao.parameter, ['url', 'url_original', 'text']));
        });
    }

    // Nomes reais dos parâmetros (custom_params). A ordem é a mesma das
    // posições {{1}}, {{2}}... do texto.
    const nomesParametros = [];
    ['custom_params', 'customParams', 'params', 'parameters', 'templateParams', 'variables'].forEach((campo) => {
        const lista = item[campo];
        if (!Array.isArray(lista)) return;

        lista.forEach((parametro) => {
            if (parametro == null) return;

            const nomeParametro = typeof parametro === 'string'
                ? parametro
                : valorAninhado(parametro, ['name', 'paramName', 'param_name', 'key']);

            const limpo = String(nomeParametro == null ? '' : nomeParametro).trim();
            if (limpo && !nomesParametros.includes(limpo)) nomesParametros.push(limpo);
        });
    });

    const variaveis = nomesParametros.slice();

    function adicionarVariavel(valor) {
        const limpo = String(valor == null ? '' : valor).trim();
        if (!limpo || limpo.length > 40) return;
        if (!/^[A-Za-z0-9_. -]+$/.test(limpo)) return;
        if (!variaveis.includes(limpo)) variaveis.push(limpo);
    }

    // Mídia dinâmica no cabeçalho: header_param_mapping.param_name.
    const nomeCabecalho = String(
        valorAninhado(cabecalho && cabecalho.header_param_mapping, ['param_name', 'paramName', 'name']) || ''
    ).trim();
    if (nomeCabecalho) adicionarVariavel(nomeCabecalho);

    // Placeholders nomeados que não vieram nos custom_params ainda precisam ser
    // ligados no painel. Os numéricos já estão cobertos pelos nomes na mesma
    // ordem; só sobram posições além da quantidade de nomes (ex.: URL de botão).
    extrairVariaveisTemplate(textos.filter(Boolean).join('\n'), []).forEach((variavel) => {
        if (/^\d+$/.test(variavel)) {
            if (parseInt(variavel, 10) > nomesParametros.length) adicionarVariavel(variavel);
            return;
        }
        adicionarVariavel(variavel);
    });

    const statusMinusculo = status.toLowerCase();

    return {
        nome,
        idioma,
        status,
        categoria,
        corpo,
        variaveis,
        aprovado: !statusMinusculo || /approv|aprovad/.test(statusMinusculo) || statusMinusculo === 'active'
    };
}

const TAMANHO_PAGINA_TEMPLATES = 100;
const MAX_PAGINAS_TEMPLATES = 10;
const CACHE_TEMPLATES_FALHA_MS = 60 * 1000;

/* A Wati pagina a listagem. Lemos todas as páginas (com teto de segurança)
   para não perder templates aprovados antigos. */
async function paginarTemplatesWati(montarUrl) {
    const itens = [];
    let motivo = '';

    for (let pagina = 1; pagina <= MAX_PAGINAS_TEMPLATES; pagina++) {
        const resposta = await watiRequisicao(montarUrl(pagina), 'GET');

        if (!watiSucesso(resposta)) {
            motivo = descreverErroWati(resposta);
            break;
        }

        const lote = listaDeTemplates(resposta.dados);
        itens.push(...lote);

        if (lote.length < TAMANHO_PAGINA_TEMPLATES) break;

        const total = Number(valorAninhado(resposta.dados, ['total', 'count', 'totalCount'])) || 0;
        if (total && itens.length >= total) break;
    }

    return { itens, motivo };
}

async function buscarTemplatesWati() {
    const tentativas = [];

    const v3 = await paginarTemplatesWati(
        (pagina) => `${WATI_HOST}/api/ext/v3/messageTemplates?page_number=${pagina}&page_size=${TAMANHO_PAGINA_TEMPLATES}`
    );
    if (v3.itens.length) return { via: 'v3', itens: v3.itens };

    tentativas.push('v3 ' + (v3.motivo || 'sem templates'));

    // Contas que ainda não enxergam os templates na v3.
    const v1 = await paginarTemplatesWati(
        (pagina) => `${watiBase()}/api/v1/getMessageTemplates?pageSize=${TAMANHO_PAGINA_TEMPLATES}&pageNumber=${pagina}`
    );
    if (v1.itens.length) return { via: 'v1', itens: v1.itens };

    tentativas.push('v1 ' + (v1.motivo || 'sem templates'));

    return { via: '', itens: [], tentativas };
}

async function listarTemplatesWati(forcar) {
    if (banco.modoDemo) {
        return {
            ok: true,
            demo: true,
            via: 'demo',
            total: TEMPLATES_DEMO.length,
            aprovados: TEMPLATES_DEMO.filter((t) => t.aprovado).length,
            templates: TEMPLATES_DEMO.map((t) => Object.assign({}, t, { variaveis: t.variaveis.slice() }))
        };
    }

    if (!watiConfigurada()) {
        return {
            ok: false,
            templates: [],
            total: 0,
            aprovados: 0,
            aviso: 'WATI_TOKEN e/ou WATI_NUMERO não configurados no Environment do Render.'
        };
    }

    const idadeCache = Date.now() - cacheTemplates.quando;
    const validadeCache = cacheTemplates.resultado && cacheTemplates.resultado.ok
        ? CACHE_TEMPLATES_MS
        : CACHE_TEMPLATES_FALHA_MS;

    if (!forcar && cacheTemplates.resultado && idadeCache < validadeCache) {
        return cacheTemplates.resultado;
    }

    const busca = await buscarTemplatesWati();

    const vistos = new Set();
    const templates = [];

    busca.itens.forEach((item) => {
        const normalizado = normalizarTemplateWati(item);
        if (!normalizado) return;

        const chave = `${normalizado.nome}|${normalizado.idioma}`.toLowerCase();
        if (vistos.has(chave)) return;

        vistos.add(chave);
        templates.push(normalizado);
    });

    templates.sort((a, b) => {
        if (a.aprovado !== b.aprovado) return a.aprovado ? -1 : 1;
        return a.nome.localeCompare(b.nome) || String(a.idioma).localeCompare(String(b.idioma));
    });

    const aprovados = templates.filter((t) => t.aprovado).length;

    const resultado = templates.length
        ? { ok: true, via: busca.via, templates, total: templates.length, aprovados }
        : {
            ok: false,
            templates: [],
            total: 0,
            aprovados: 0,
            aviso: `Não foi possível listar os templates da Wati (${(busca.tentativas || []).join(' | ') || 'resposta vazia'}).`
        };

    cacheTemplates = { quando: Date.now(), resultado };
    return resultado;
}

/* Telefone de um item de "recipients" na resposta da v3 (a Wati não é
   consistente no nome do campo). */
function numeroDaRespostaWati(item) {
    if (!item || typeof item !== 'object') return '';

    const bruto = item.target ?? item.whatsapp_number ?? item.whatsappNumber
        ?? item.phone_number ?? item.phoneNumber ?? item.wa_id ?? item.waId
        ?? item.number ?? item.phone;

    return bruto == null ? '' : String(bruto).replace(/\D/g, '');
}

/* Avalia a resposta da v3: HTTP 200 pode vir com success:false e, mesmo com
   success:true, destinatários podem ter erro. Os erros por número ficam em
   porNumero para o envio em lote saber exatamente quem falhou. */
function avaliarEnvioTemplate(resposta) {
    const falha = (motivo, podeTentarV1) => ({
        aceito: false,
        motivo,
        podeTentarV1,
        semDestinatarios: false,
        porNumero: {}
    });

    if (!resposta) return falha('sem resposta', true);
    if (!resposta.ok) return falha(descreverErroWati(resposta), true);

    const dados = resposta.dados;
    if (!dados || typeof dados !== 'object') return falha('resposta sem JSON', true);

    if (dados.success === false || dados.result === false) {
        return falha(String(dados.error || dados.message || 'a Wati recusou o envio'), true);
    }

    const destinatarios = Array.isArray(dados.recipients) ? dados.recipients : [];
    const porNumero = {};
    const motivos = [];

    destinatarios.forEach((item) => {
        if (!item || !Array.isArray(item.errors) || !item.errors.length) return;

        const motivo = item.errors
            .map((erro) => (erro && (erro.message || erro.error)) || erro)
            .join('; ');
        const numero = numeroDaRespostaWati(item);

        if (numero) porNumero[numero] = motivo;
        motivos.push(motivo);
    });

    if (motivos.length) {
        return {
            aceito: false,
            motivo: motivos.join('; '),
            // A v3 respondeu de forma definitiva para estes destinatários;
            // repetir na v1 só serviria para duplicar a mensagem.
            podeTentarV1: false,
            semDestinatarios: false,
            porNumero
        };
    }

    return {
        aceito: true,
        motivo: '',
        podeTentarV1: false,
        semDestinatarios: destinatarios.length === 0,
        porNumero
    };
}

/* Campo sem conteúdo (null, texto em branco, objeto vazio). */
function campoSemValor(valor) {
    if (valor == null) return true;
    if (typeof valor === 'string') return !valor.trim();
    if (Array.isArray(valor)) return valor.length === 0;
    if (typeof valor === 'object') return Object.keys(valor).length === 0;
    return false;
}

/* A linha que fica na campanha herda o que só existia na linha repetida —
   é comum o nome estar em um registro e o telefone em outro do mesmo
   WhatsApp; sem isso o contato ficaria "sem nome" sem motivo. */
function completarCamposVazios(destino, origem) {
    if (!destino || !origem) return destino;

    Object.keys(origem).forEach((campo) => {
        if (campo === 'telefone') return;

        const valorOrigem = origem[campo];
        const valorDestino = destino[campo];

        if (valorOrigem == null) return;

        const ambosObjetos = valorDestino && valorOrigem
            && typeof valorDestino === 'object' && typeof valorOrigem === 'object'
            && !Array.isArray(valorDestino) && !Array.isArray(valorOrigem);

        if (ambosObjetos) {
            Object.keys(valorOrigem).forEach((chave) => {
                if (campoSemValor(valorDestino[chave]) && !campoSemValor(valorOrigem[chave])) {
                    valorDestino[chave] = valorOrigem[chave];
                }
            });
            return;
        }

        if (campoSemValor(valorDestino) && !campoSemValor(valorOrigem)) {
            destino[campo] = valorOrigem;
        }
    });

    return destino;
}

/* Uma campanha manda UMA mensagem por número. A mesma pessoa pode aparecer em
   várias linhas da lista (registros diferentes com o mesmo telefone) e cada
   linha viraria um envio — a pessoa recebia a campanha repetidas vezes.
   Mantém a primeira ocorrência (completada com o que houver nas repetidas) e
   devolve os repetidos para o painel avisar. */
function deduplicarContatosPorTelefone(contatos) {
    const porNumero = new Map();
    const unicos = [];
    const repetidos = [];

    (Array.isArray(contatos) ? contatos : []).forEach((contato) => {
        const numero = String((contato && contato.telefone) || '').replace(/\D/g, '');

        // Sem telefone não dá para comparar: segue para virar falha visível.
        if (!numero) {
            unicos.push(contato);
            return;
        }

        if (porNumero.has(numero)) {
            completarCamposVazios(porNumero.get(numero), contato);
            repetidos.push(contato);
            return;
        }

        // Cópia: a linha da campanha pode receber dados de outra linha e a
        // lista original (banco/demo) não deve ser alterada.
        const copia = Object.assign({}, contato);
        if (copia.atributos && typeof copia.atributos === 'object') copia.atributos = Object.assign({}, copia.atributos);
        if (copia.variaveis && typeof copia.variaveis === 'object') copia.variaveis = Object.assign({}, copia.variaveis);

        porNumero.set(numero, copia);
        unicos.push(copia);
    });

    return { unicos, repetidos };
}

/* Valores do template no formato que a v3 espera. */
function normalizarParametrosTemplate(parametros) {
    return (Array.isArray(parametros) ? parametros : []).map((item) => ({
        name: String((item && item.name) || ''),
        value: String((item && item.value) == null ? '' : item.value)
    })).filter((item) => item.name);
}

/* Nome do broadcast na Wati — é ele que dá nome à campanha no painel dela.
   Todos os contatos de uma campanha usam o mesmo rótulo. */
function rotuloBroadcastWati(campanha) {
    return String(campanha || 'campanha').replace(/[^\w-]+/g, '_').slice(0, 60) || 'campanha';
}

/* Um destinatário por contato, já com o local_message_id que a Wati devolve
   no webhook (permite casar o evento com o envio do painel). Número repetido
   fica uma vez só: a Wati manda a mensagem uma vez por destinatário da lista,
   então repetido dentro do lote viraria mensagem duplicada no WhatsApp. */
function montarDestinatariosTemplate(destinatarios, campanha) {
    const rotulo = rotuloBroadcastWati(campanha);
    const vistos = new Set();

    return (Array.isArray(destinatarios) ? destinatarios : [])
        .map((item) => {
            const numero = String((item && item.telefone) || '').replace(/\D/g, '');
            if (!numero || vistos.has(numero)) return null;

            vistos.add(numero);

            return {
                numero,
                localId: `campanha-${rotulo}-${(item && item.envioId) || numero}`.slice(0, 120),
                parametros: normalizarParametrosTemplate(item && item.parametros)
            };
        })
        .filter(Boolean);
}

/* Corpo da requisição da v3: TODOS os contatos vão numa lista só, porque a
   Wati cria uma campanha por requisição (um envio por contato viraria uma
   campanha de 1 destinatário para cada mensagem no painel dela). */
function corpoEnvioTemplateWati(templateNome, rotulo, fila) {
    return {
        template_name: String(templateNome || '').trim(),
        broadcast_name: rotulo,
        recipients: (Array.isArray(fila) ? fila : []).map((item) => ({
            target: item.numero,
            local_message_id: item.localId,
            custom_params: item.parametros
        }))
    };
}

/* Envio de template aprovado em LOTE: os valores já vêm resolvidos contato a
   contato e o lote inteiro sai numa requisição (uma campanha na Wati).
   Devolve { ok, via, resultados: [{ telefone, ok, message, aviso }], message }. */
async function enviarTemplateWatiLote({ templateNome, campanha, destinatarios }) {
    const rotulo = rotuloBroadcastWati(campanha);
    const fila = montarDestinatariosTemplate(destinatarios, campanha);

    if (!fila.length) {
        return { ok: false, via: '', resultados: [], message: 'Nenhum telefone válido para envio.' };
    }

    const falharTodos = (motivo) => ({
        ok: false,
        via: '',
        message: motivo,
        resultados: fila.map((item) => ({ telefone: item.numero, ok: false, message: motivo, aviso: '' }))
    });

    if (banco.modoDemo) {
        return {
            ok: true,
            via: 'demo',
            message: '',
            resultados: fila.map((item) => ({ telefone: item.numero, ok: true, message: '', aviso: '' }))
        };
    }

    if (!watiConfigurada()) return falharTodos('API da Wati não configurada no servidor.');

    const nomeTemplate = String(templateNome || '').trim();
    if (!nomeTemplate) return falharTodos('Campanha sem template definido.');

    const resultados = fila.map((item) => ({ telefone: item.numero, ok: false, message: 'Sem retorno da Wati.', aviso: '' }));
    const tentativas = [];

    // 1) v3 (recomendada pela Wati): o lote inteiro numa requisição
    const resposta = await watiRequisicao(
        `${WATI_HOST}/api/ext/v3/messageTemplates/send`,
        'POST',
        corpoEnvioTemplateWati(nomeTemplate, rotulo, fila)
    );

    const avaliacao = avaliarEnvioTemplate(resposta);

    if (avaliacao.aceito) {
        const aviso = avaliacao.semDestinatarios
            ? 'A Wati aceitou o envio, mas não devolveu o resultado destes destinatários. Confirme pelo webhook.'
            : '';

        resultados.forEach((item) => {
            item.ok = true;
            item.message = '';
            item.aviso = aviso;
        });

        return { ok: true, via: 'v3', message: '', resultados };
    }

    tentativas.push('v3: ' + avaliacao.motivo);

    if (avaliacao.podeTentarV1) {
        // 2) v1 (contas que ainda não enxergam os templates na v3). Só quando a
        // v3 falhou inteira — erro de destinatário na v3 não pode ser repetido.
        for (let i = 0; i < fila.length; i++) {
            const item = fila[i];

            const respostaV1 = await watiRequisicao(
                `${watiBase()}/api/v1/sendTemplateMessage?whatsappNumber=${encodeURIComponent(item.numero)}`,
                'POST',
                {
                    template_name: nomeTemplate,
                    broadcast_name: rotulo,
                    // A v1 recebe só os valores, na ordem das variáveis.
                    parameters: item.parametros.map((parametro) => parametro.value)
                }
            );

            if (watiSucesso(respostaV1)) {
                resultados[i].ok = true;
                resultados[i].message = '';
                resultados[i].aviso = 'Enviado pela v1: nesse caminho a Wati pode mostrar uma campanha por contato.';
            } else {
                resultados[i].ok = false;
                resultados[i].message = `A Wati recusou o template (v1: ${descreverErroWati(respostaV1)}).`;
            }

            // respiro curto entre as chamadas da v1 (uma por contato)
            if (i < fila.length - 1) await new Promise((resolve) => setTimeout(resolve, 120));
        }

        const aceitos = resultados.filter((item) => item.ok).length;

        return {
            ok: aceitos === resultados.length,
            via: 'v1',
            message: aceitos === resultados.length ? '' : `${resultados.length - aceitos} contato(s) recusado(s) pela v1.`,
            resultados
        };
    }

    // A v3 respondeu destinatário por destinatário: quem deu erro fica como
    // falha e o resto conta como enviado (repetir duplicaria a mensagem).
    const recusados = avaliacao.porNumero || {};
    const identificados = Object.keys(recusados).length > 0;

    resultados.forEach((item) => {
        const motivo = recusados[item.telefone];

        if (!identificados) {
            item.ok = false;
            item.message = `A Wati recusou o lote (${tentativas.join(' | ')}).`;
            return;
        }

        item.ok = !motivo;
        item.message = motivo ? `A Wati recusou este contato: ${motivo}` : '';
    });

    const falhas = resultados.filter((item) => !item.ok).length;

    return {
        ok: falhas === 0,
        via: 'v3',
        message: falhas ? `A Wati recusou ${falhas} contato(s) do lote.` : '',
        resultados
    };
}

/* Lista de templates aprovados para o formulário de campanhas.
   ?atualizar=1 ignora o cache de 5 minutos. */
app.get('/api/wati/templates', exigirAdmin, async (req, res) => {
    try {
        const resultado = await listarTemplatesWati(req.query.atualizar === '1');
        res.json(resultado);
    } catch (erro) {
        console.error('Erro ao listar templates da Wati:', erro.message);
        res.status(500).json({ ok: false, templates: [], aviso: 'Erro ao consultar os templates da Wati.' });
    }
});

app.get('/api/canais', exigirAdmin, (req, res) => {
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

app.post('/api/canais/testar', exigirAdmin, async (req, res) => {
    try {
        const resultado = await testarWati();
        res.status(resultado.ok ? 200 : 502).json(resultado);
    } catch (erro) {
        console.error('Erro ao testar canal:', erro.message);
        res.status(500).json({ ok: false, message: 'Erro inesperado ao testar o canal.' });
    }
});

/* Envia para a Wati os contatos de uma lista já mapeada no painel.
   O navegador manda em lotes de 20 para caber no tempo do Render. */
app.post('/api/wati/contatos', exigirAdmin, async (req, res) => {
    const { contatos } = req.body || {};

    if (!Array.isArray(contatos) || !contatos.length) {
        return res.status(400).json({ success: false, message: 'Nenhum contato para enviar.' });
    }
    if (contatos.length > 25) {
        return res.status(400).json({ success: false, message: 'Envie no máximo 25 contatos por vez.' });
    }

    const resultados = [];
    let enviados = 0;
    let falhas = 0;

    for (const item of contatos) {
        const telefone = String((item && item.telefone) || '').replace(/\D/g, '');

        if (telefone.length < 10) {
            falhas++;
            resultados.push({ telefone, ok: false, message: 'Telefone inválido.' });
            continue;
        }

        const resultado = await salvarContatoNaWati({
            telefone,
            nome: String((item && item.nome) || '').trim().substring(0, 120),
            atributos: limparAtributos(item && item.atributos)
        });

        if (resultado.ok) enviados++;
        else falhas++;

        resultados.push({ telefone, ok: resultado.ok, via: resultado.via || null, message: resultado.message || null });

        // respiro curto para não esbarrar no limite de requisições da Wati
        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    try {
        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'contatos enviados para a Wati',
            `${enviados} enviado(s), ${falhas} falha(s)`
        );
    } catch (erro) { /* auditoria não pode derrubar o envio */ }

    res.json({ success: falhas === 0, enviados, falhas, resultados });
});

// ---------------------------------------------------------
// WEBHOOK SEGURO (token na URL)
// O segredo é gerado e guardado no banco; o painel mostra a URL pronta para
// colar na Wati e só depois o token passa a ser exigido.
// ---------------------------------------------------------
function baseUrlPublica(req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('host') || '';
    return `${proto}://${host}`;
}

function estadoWebhook(req) {
    const viaAmbiente = Boolean(WEBHOOK_SECRET_ENV);

    return {
        ativo: Boolean(segredoWebhookEsperado()),
        origem: webhookSecretOrigem,
        viaAmbiente,
        temSegredo: Boolean(viaAmbiente || webhookSecretBanco),
        url: webhookSecretBanco ? `${baseUrlPublica(req)}/webhook?token=${webhookSecretBanco}` : null,
        aviso: viaAmbiente
            ? 'O segredo vem da variável WEBHOOK_SECRET do Render. Para trocar, altere lá e atualize a URL na Wati.'
            : 'Cole a URL na Wati e envie uma mensagem de teste: a exigência do token liga sozinha no primeiro recebimento válido.'
    };
}

/* Estado do webhook + última atividade recebida (mostra no painel se a Wati
   está realmente chamando a URL). */
async function estadoWebhookComAtividade(req) {
    const estado = estadoWebhook(req);

    try {
        estado.ultimoEvento = await banco.ultimoEventoWati();
        estado.eventosHoje = await banco.contarEventosWatiHoje();
    } catch (erro) {
        estado.ultimoEvento = null;
        estado.eventosHoje = 0;
    }

    return estado;
}

/* Filtros da tela "Atividade Wati" (agrupam os eventType da Wati). */
const FILTROS_EVENTOS_WATI = {
    mensagens: ['message'],
    campanhas: ['sent', 'delivered', 'read', 'failed', 'replied'],
    contatos: ['contact_created', 'contact_updated', 'tag_updated']
};

app.get('/api/wati/eventos', exigirAdmin, async (req, res) => {
    const limite = Math.min(parseInt(req.query.limite, 10) || 200, 500);
    const filtro = String(req.query.filtro || '');
    const tipos = FILTROS_EVENTOS_WATI[filtro] || null;

    try {
        res.json(await banco.listarEventosWati({ limite, tipos }));
    } catch (erro) {
        console.error('Erro ao listar eventos da Wati:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao carregar a atividade da Wati.' });
    }
});

/* Quando a Wati já chama a URL com o token, trancamos o webhook sem ninguém
   precisar clicar em nada. Antes disso, as chamadas sem token continuam aceitas
   para não perder mensagens durante a troca da URL. */
async function ativarWebhookAutomaticamente() {
    if (webhookSecretAtivo || WEBHOOK_SECRET_ENV) return;

    try {
        await banco.definirConfiguracao('webhook_secret_ativo', '1');
        webhookSecretAtivo = true;
        webhookSecretOrigem = 'banco';
        await banco.registrarAuditoria('sistema', 'webhook protegido', 'ativado automático no primeiro token válido');
        console.log('WEBHOOK: primeiro token válido recebido - exigência ativada automaticamente.');
    } catch (erro) {
        console.warn('WEBHOOK: não foi possível ativar a exigência automaticamente:', erro.message);
    }
}

app.get('/api/webhook', exigirAdmin, async (req, res) => {
    res.json(await estadoWebhookComAtividade(req));
});

app.post('/api/webhook/ativar', exigirAdmin, async (req, res) => {
    if (WEBHOOK_SECRET_ENV) {
        return res.status(400).json({
            success: false,
            message: 'O segredo vem do Environment do Render (WEBHOOK_SECRET). Ajuste por lá.'
        });
    }

    if (!webhookSecretBanco) {
        return res.status(400).json({ success: false, message: 'Segredo indisponível. Recarregue a tela de Canais.' });
    }

    const ativo = Boolean(req.body && req.body.ativo);

    try {
        await banco.definirConfiguracao('webhook_secret_ativo', ativo ? '1' : '0');
        webhookSecretAtivo = ativo;
        webhookSecretOrigem = ativo ? 'banco' : 'desativado';

        await banco.registrarAuditoria(
            req.user && req.user.nome,
            ativo ? 'webhook protegido' : 'webhook liberado',
            'token na URL'
        );

        console.log(ativo ? 'WEBHOOK: token agora é exigido.' : 'WEBHOOK: token voltou a ser opcional.');
        res.json(Object.assign({ success: true }, await estadoWebhookComAtividade(req)));
    } catch (erro) {
        console.error('Erro ao configurar o webhook:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao salvar a configuração do webhook.' });
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
        const acesso = await verificarDonoDoCliente(req, telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

        await banco.atualizarStatus(telefone, status);
        emitirEvento('status', { telefone, status });
        await banco.registrarAuditoria(req.user && req.user.nome, 'status alterado', `${telefone} -> ${status}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Erro ao atualizar status:', error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/status', exigirAdmin, async (req, res) => {
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
    const somenteMeus = req.query.meus === '1';

    // Colaborador: sempre restrito à própria carteira (ignora ?meus=).
    // Admin: vê tudo, mas pode filtrar por ?vendedor=email.
    const vendedorEmail = ehAdmin(req)
        ? (String(req.query.vendedor || '').trim() || null)
        : String(req.user.email || '').trim();

    try {
        const clientes = await banco.listarClientes({ status, busca, limite, vendedorEmail, somenteMeus });
        res.json(clientes);
    } catch (error) {
        console.error('Erro em /api/clientes:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// COLABORADORES COM CONVERSAS (filtro "Analisar conversas de" — somente admin)
app.get('/api/clientes/vendedores', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.listarVendedoresDosLeads());
    } catch (error) {
        console.error('Erro em /api/clientes/vendedores:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// RESUMO DO PAINEL (cards + desempenho da equipe)
app.get('/api/dashboard', exigirAdmin, async (req, res) => {
    try {
        const resumo = await banco.resumoDashboard();

        // Atividade recebida da Wati (webhook) aparece também no card do Início
        try {
            resumo.eventosWatiHoje = await banco.contarEventosWatiHoje();
        } catch (erro) {
            resumo.eventosWatiHoje = 0;
        }

        res.json(resumo);
    } catch (error) {
        console.error('Erro no dashboard:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// FICHA DO CLIENTE
app.get('/api/clientes/:telefone/ficha', async (req, res) => {
    try {
        const acesso = await verificarDonoDoCliente(req, req.params.telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

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
        const acesso = await verificarDonoDoCliente(req, telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

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
        const acesso = await verificarDonoDoCliente(req, req.params.telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

        res.json(await banco.listarMensagens(req.params.telefone));
    } catch (error) {
        console.error('Erro ao buscar mensagens:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

// LISTAS (importação de .txt / colagem de contatos)
app.get('/api/listas', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.listarListas());
    } catch (error) {
        console.error('Erro ao listar listas:', error.message);
        res.status(500).json({ error: 'Erro' });
    }
});

/* Atributos disponíveis na lista (para ligar cada variável do template
   a uma coluna importada, ex.: {{1}} -> atributo "1" ou "nome"). */
app.get('/api/listas/:id/atributos', exigirAdmin, async (req, res) => {
    try {
        const contatos = await banco.obterContatosLista(req.params.id);
        const contagem = new Map();
        const contagemVariaveis = new Map();
        let comNome = 0;

        contatos.forEach((contato) => {
            if (String((contato && contato.nome) || '').trim()) comNome += 1;

            const atributos = (contato && contato.atributos) || {};
            Object.keys(atributos).forEach((chave) => {
                if (!String(atributos[chave] == null ? '' : atributos[chave]).trim()) return;
                contagem.set(chave, (contagem.get(chave) || 0) + 1);
            });

            // Colunas {{1}}, {{2}}... importadas no formato "lista por variáveis".
            const variaveis = (contato && contato.variaveis) || {};
            Object.keys(variaveis).forEach((chave) => {
                if (!String(variaveis[chave] == null ? '' : variaveis[chave]).trim()) return;
                contagemVariaveis.set(chave, (contagemVariaveis.get(chave) || 0) + 1);
            });
        });

        const atributos = [];
        const adicionados = new Set();

        if (comNome) {
            atributos.push({ nome: 'nome', comValor: comNome, semValor: contatos.length - comNome, tipo: 'campo' });
            adicionados.add('nome');
        }

        atributos.push({ nome: 'telefone', comValor: contatos.length, semValor: 0, tipo: 'campo' });
        adicionados.add('telefone');

        // Variáveis primeiro: é o que a campanha usa por padrão.
        Array.from(contagemVariaveis.entries())
            .sort((a, b) => a[0].localeCompare(b[0], 'pt-BR', { numeric: true }) || b[1] - a[1])
            .forEach(([nome, comValor]) => {
                if (adicionados.has(nome)) return;
                adicionados.add(nome);
                atributos.push({ nome, comValor, semValor: contatos.length - comValor, tipo: 'variavel' });
            });

        Array.from(contagem.entries())
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .forEach(([nome, comValor]) => {
                if (adicionados.has(nome)) return;
                adicionados.add(nome);
                atributos.push({ nome, comValor, semValor: contatos.length - comValor, tipo: 'atributo' });
            });

        res.json({
            total: contatos.length,
            formato: contagemVariaveis.size ? 'variaveis' : 'atributos',
            atributos
        });
    } catch (error) {
        console.error('Erro ao listar atributos da lista:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao ler os atributos da lista.' });
    }
});

/* Telefones de uma lista: confere DDD/formato e completa o 9º dígito e o DDI.
   Body: { telefones: ["1198765432", ...], dddPadrao: "11" (opcional) }
   Não consulta serviço externo — validação de formato (ANATEL). */
app.post('/api/telefones/verificar', async (req, res) => {
    const { telefones, dddPadrao } = req.body || {};

    if (!Array.isArray(telefones) || !telefones.length) {
        return res.status(400).json({ success: false, message: 'Envie a lista de telefones.' });
    }
    if (telefones.length > 5000) {
        return res.status(400).json({ success: false, message: 'Máximo de 5000 telefones por vez.' });
    }

    const { resultados, resumo } = analisarListaTelefones(telefones, dddPadrao);
    res.json({ success: true, resumo, resultados });
});

/* ---------------------------------------------------------
   CONSULTA DE CNPJ (dados públicos da empresa)
   Fonte: BrasilAPI (fallback: Minha Receita) — gratuitas, sem
   login e sem token. A resposta traz só o que a Receita
   publica da EMPRESA: o CPF do sócio é descartado na
   normalização (cnpj.js). O painel guarda apenas o registro
   na auditoria, com o CNPJ consultado.
   --------------------------------------------------------- */
const CACHE_CNPJ = new Map();
const CACHE_CNPJ_TTL = 24 * 60 * 60 * 1000;

const FONTES_CNPJ = [
    { nome: 'BrasilAPI', url: (cnpj) => `https://brasilapi.com.br/api/cnpj/v1/${cnpj}` },
    { nome: 'Minha Receita', url: (cnpj) => `https://minhareceita.org/${cnpj}` }
];

/* Baixa o JSON da fonte pública. Devolve null no 404 (CNPJ fora da base). */
async function baixarJsonCnpj(url) {
    const controle = new AbortController();
    const limite = setTimeout(() => controle.abort(), 12000);

    try {
        const resposta = await fetch(url, {
            headers: { Accept: 'application/json', 'User-Agent': 'QGC-TEAM-painel' },
            signal: controle.signal
        });

        if (resposta.status === 404) return null;
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        return await resposta.json();
    } finally {
        clearTimeout(limite);
    }
}

/* Consulta com cache em memória de 24h (a base da Receita muda pouco). */
async function consultarCnpjPublico(cnpj) {
    const emCache = CACHE_CNPJ.get(cnpj);
    if (emCache && Date.now() - emCache.quando < CACHE_CNPJ_TTL) {
        return Object.assign({ fonte: emCache.fonte, cache: true }, emCache.empresa);
    }

    const falhas = [];

    for (const fonte of FONTES_CNPJ) {
        try {
            const dados = await baixarJsonCnpj(fonte.url(cnpj));
            if (!dados) return { status: 'nao_encontrado' };

            const empresa = normalizarEmpresa(dados);
            if (!empresa.razaoSocial) throw new Error('resposta sem razão social');

            CACHE_CNPJ.set(cnpj, { quando: Date.now(), fonte: fonte.nome, empresa });
            return Object.assign({ fonte: fonte.nome }, empresa);
        } catch (erro) {
            falhas.push(fonte.nome + ': ' + erro.message);
            console.error('Consulta de CNPJ falhou em ' + fonte.nome + ':', erro.message);
        }
    }

    throw new Error('Serviço público indisponível (' + falhas.join(' | ') + ').');
}

app.post('/api/cnpj/consultar', exigirAdmin, async (req, res) => {
    const corpo = req.body || {};
    const entradas = Array.isArray(corpo.cnpjs)
        ? corpo.cnpjs
        : String(corpo.cnpjs || corpo.cnpj || '').split(/[\s,;]+/);

    const pedidos = [];
    const vistos = new Set();

    entradas
        .map((item) => String(item == null ? '' : item).trim())
        .filter(Boolean)
        .forEach((item) => {
            const { cnpj } = validarCnpj(item);
            const chave = cnpj || item;
            if (vistos.has(chave)) return;

            vistos.add(chave);
            pedidos.push(item);
        });

    if (!pedidos.length) {
        return res.status(400).json({ success: false, message: 'Envie pelo menos um CNPJ.' });
    }
    if (pedidos.length > 20) {
        return res.status(400).json({ success: false, message: 'Máximo de 20 CNPJs por consulta.' });
    }

    const resultados = [];

    for (const bruto of pedidos) {
        const checagem = validarCnpj(bruto);

        if (!checagem.valido) {
            resultados.push({
                original: bruto,
                cnpj: checagem.cnpj,
                status: 'invalido',
                message: checagem.motivo
            });
            continue;
        }

        try {
            const empresa = await consultarCnpjPublico(checagem.cnpj);

            if (empresa.status === 'nao_encontrado') {
                resultados.push({
                    original: bruto,
                    cnpj: checagem.cnpj,
                    cnpjFormatado: formatarCnpj(checagem.cnpj),
                    status: 'nao_encontrado',
                    message: 'CNPJ não encontrado na base pública.'
                });
                continue;
            }

            resultados.push(Object.assign({ original: bruto, status: 'ok' }, empresa));
        } catch (erro) {
            resultados.push({
                original: bruto,
                cnpj: checagem.cnpj,
                cnpjFormatado: formatarCnpj(checagem.cnpj),
                status: 'erro',
                message: erro.message
            });
        }
    }

    const resumo = { total: resultados.length, ok: 0, comTelefone: 0, naoEncontrados: 0, invalidos: 0, erros: 0 };

    resultados.forEach((item) => {
        if (item.status === 'ok') {
            resumo.ok += 1;
            if (Array.isArray(item.telefones) && item.telefones.length) resumo.comTelefone += 1;
        } else if (item.status === 'nao_encontrado') {
            resumo.naoEncontrados += 1;
        } else if (item.status === 'invalido') {
            resumo.invalidos += 1;
        } else {
            resumo.erros += 1;
        }
    });

    const encontrados = resultados
        .filter((item) => item.status === 'ok')
        .map((item) => item.cnpjFormatado || formatarCnpj(item.cnpj));

    try {
        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'consulta cnpj',
            encontrados.length ? encontrados.join(', ') : pedidos.join(', ')
        );
    } catch (erro) {
        console.error('Erro ao registrar auditoria da consulta de CNPJ:', erro.message);
    }

    res.json({ success: true, resumo, resultados });
});

/* ---------------------------------------------------------
   CONSULTA DE CPF NO EXTRATOR (extratorgov.online)
   Body: { cpfs: ["52998224725", ...] } — até 50 por vez.
   A extração roda no painel do site (conta cliente1010) e
   pode levar de 1 a 5 minutos. A auditoria guarda só os CPFs.
   --------------------------------------------------------- */
app.post('/api/extrator/consultar', exigirAdmin, async (req, res) => {
    const corpo = req.body || {};
    const entradas = Array.isArray(corpo.cpfs)
        ? corpo.cpfs
        : String(corpo.cpfs || '').split(/[\s,;]+/);

    try {
        const resposta = await extrator.consultarCpfs(entradas);

        try {
            const encontrados = resposta.resultados
                .filter((item) => item.status === 'ok')
                .map((item) => item.cpf);

            await banco.registrarAuditoria(
                req.user && req.user.nome,
                'consulta extrator cpf',
                (encontrados.length ? encontrados.join(', ') : entradas.slice(0, 50).join(', ')) +
                ' (' + ((resposta.resumo && resposta.resumo.via) || 'extrator') + ')'
            );
        } catch (erro) {
            console.error('Erro ao registrar auditoria da consulta do extrator:', erro.message);
        }

        res.json(resposta);
    } catch (erro) {
        console.error('Consulta no extrator falhou:', erro.message);

        /* Servidor sem Chrome (ex.: Render): em vez de uma linha "sem retorno"
           por CPF, orienta o caminho que funciona — rodar o script local. */
        if (erro.codigo === 'sem-chrome') {
            return res.status(503).json({
                success: false,
                codigo: 'sem-chrome',
                message: 'O extrator automático roda só na máquina que tem o Chrome. '
                    + 'Baixe os CPFs, rode "node extrator.js testar cpfs.txt" no seu computador '
                    + 'e cole o resultado no passo 3 da tela Listas.'
            });
        }

        res.status(erro.codigo || 502).json({ success: false, message: erro.message });
    }
});

app.get('/api/extrator/status', exigirAdmin, (req, res) => {
    res.json(Object.assign({ success: true }, extrator.status()));
});

/* ---------------------------------------------------------
   VERIFICAÇÃO SPYHUB (CPF x 4 últimos dígitos do telefone)
   POST /api/spyhub/verificar  { texto } -> fila -> 202
   GET  /api/spyhub/jobs/:id  -> progresso + log + resultados
   --------------------------------------------------------- */
app.use('/api/spyhub', criarRotasSpyhub({
    exigirAdmin,
    registrarAuditoria: (usuario, acao, detalhe) => banco.registrarAuditoria(usuario, acao, detalhe)
}));

app.post('/api/listas', exigirAdmin, async (req, res) => {
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

        const atributos = limparAtributos(item && item.atributos);

        // Formato "lista por variáveis": { "1": "João", "2": "12.345..." }.
        // Fica separado dos atributos porque só a campanha usa esses valores.
        const variaveis = limparAtributos(item && item.variaveis);

        const contato = {
            telefone,
            nome: String((item && item.nome) || '').trim().substring(0, 120),
            atributos
        };

        if (Object.keys(variaveis).length) {
            contato.variaveis = variaveis;
            if (!contato.nome && variaveis.nome) contato.nome = variaveis.nome.substring(0, 120);
        }

        // essas colunas também existem na ficha do cliente
        ['cnpj', 'cpf', 'socio', 'responsavel'].forEach((campo) => {
            if (atributos[campo]) contato[campo] = atributos[campo];
        });

        limpos.push(contato);
    });

    if (!limpos.length) {
        return res.status(400).json({ success: false, message: 'Nenhum telefone válido (use DDD + número).' });
    }

    const nomeLimpo = String(nome).trim();

    try {
        const lista = await banco.criarLista(nomeLimpo, limpos);

        let resumo = { novos: 0, atualizados: 0 };
        try {
            resumo = await banco.salvarContatosImportados(limpos);
        } catch (erro) {
            console.error('Erro ao gravar os contatos importados:', erro.message);
        }

        emitirEvento('lista', { id: lista.id, nome: nomeLimpo, total: lista.total });
        emitirEvento('clientes', { importados: lista.total });
        await banco.registrarAuditoria(req.user && req.user.nome, 'lista importada', `${nomeLimpo} (${lista.total} contatos)`);

        res.json({
            success: true,
            id: lista.id,
            total: lista.total,
            novos: resumo.novos,
            atualizados: resumo.atualizados,
            contatos: limpos
        });
    } catch (error) {
        console.error('Erro ao salvar lista:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao salvar a lista.' });
    }
});

app.delete('/api/listas/:id', exigirAdmin, async (req, res) => {
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

    // A Wati espera o número com DDI/DDD, sem máscara e sem "+".
    const numero = String(telefone || '').replace(/\D/g, '') || String(telefone || '').trim();

    const url = `${watiBase()}/api/v1/sendSessionMessage/${encodeURIComponent(numero)}?messageText=${encodeURIComponent(texto)}`;

    /* Uma rodada de envio. Repete sozinha em 429/5xx (a Wati costuma responder
       assim quando uma campanha grande está disparando na mesma conta).
       Devolve { ok } ou { ok:false, status, motivo } ou { ok:false, conexao }. */
    const tentarEnvio = async () => {
        let resposta = null;
        let corpo = '';
        let dados = {};

        for (let tentativa = 1; tentativa <= 2; tentativa++) {
            try {
                resposta = await fetch(url, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${WATI_TOKEN}` }
                });
            } catch (erro) {
                console.error('Erro ao chamar a API da Wati:', erro.message);
                return { ok: false, conexao: true, message: 'Erro de conexão com a Wati.' };
            }

            corpo = await resposta.text();
            dados = {};
            try { dados = corpo ? JSON.parse(corpo) : {}; } catch (erro) { dados = { message: corpo }; }

            if (resposta.ok && mensagemCriadaNaWati(dados)) {
                /* A Wati criou a mensagem (tem whatsappMessageId), mas nem sempre
                   manda result:true. Loga o corpo cru para conferência. */
                if (dados.result !== true && dados.success !== true) {
                    console.warn(`Wati aceitou o envio para ${numero} sem result:true (HTTP ${resposta.status}):`, String(corpo).substring(0, 600));
                }

                return { ok: true };
            }

            if ((resposta.status === 429 || resposta.status >= 500) && tentativa === 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
            }

            break;
        }

        /* O motivo pode vir como texto ou como objeto aninhado da Cloud API.
           Sem achatar, o painel exibia "[object Object]" e ninguém descobria a causa. */
        const motivo = (achatarErroWati(dados && dados.message)
            || achatarErroWati(dados && dados.info)
            || achatarErroWati(dados && dados.error)
            || achatarErroWati(dados && dados.errors)
            || '').substring(0, 300) || `HTTP ${resposta.status}`;

        console.error(`Wati recusou o envio para ${numero} (HTTP ${resposta.status}):`, String(corpo).substring(0, 600));

        // Anexa o código no log para facilitar o suporte da Wati.
        const codigo = (dados && (dados.code || (dados.error && dados.error.code) || (dados.message && dados.message.error && dados.message.error.code))) || '';
        if (codigo && !motivo.includes(String(codigo))) {
            console.error(`Código de erro da Wati/Meta: ${codigo}`);
        }

        return { ok: false, status: resposta.status, motivo };
    };

    try {
        let resultado = await tentarEnvio();

        if (resultado.conexao) return { ok: false, message: resultado.message };

        /* Contato fora da conta da Wati: cria (com o nome da ficha) e repete o
           envio uma vez. Era o "Contact with phone number ... not found" que
           travava o chat mesmo com o número certo. */
        if (!resultado.ok && contatoInexistenteNaWati(resultado.motivo)) {
            const criacao = await garantirContatoNaWati(numero);

            if (criacao.ok) {
                await new Promise((resolve) => setTimeout(resolve, 400));
                resultado = await tentarEnvio();
                if (resultado.conexao) return { ok: false, message: resultado.message };
            } else {
                resultado.criacao = criacao;
            }
        }

        if (resultado.ok) return { ok: true };

        const fechada = erroJanelaFechada(resultado.motivo);
        // A Wati já termina o motivo com ponto final ("Ticket has been expired.").
        const motivoLimpo = String(resultado.motivo || '').replace(/[\s.;]+$/, '') || `HTTP ${resultado.status}`;

        const mensagem = (resultado.criacao && !resultado.criacao.ok)
            ? `A Wati não encontrou o contato ${numero} e não conseguiu criá-lo (${motivoLimpo}). Confira se o número tem WhatsApp.`
            : `A Wati recusou o envio (HTTP ${resultado.status}): ${motivoLimpo}.`;

        return { ok: false, message: mensagem + (fechada ? ` ${ORIENTACAO_JANELA_FECHADA}` : ''), janelaFechada: fechada };
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

    try {
        const acesso = await verificarDonoDoCliente(req, telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);
    } catch (erro) {
        console.error('Erro ao validar o dono do contato:', erro.message);
        return res.status(500).json({ success: false, message: 'Erro ao validar o contato.' });
    }

    const resultado = await enviarViaWati(telefone, texto);

    if (!resultado.ok) {
        await banco.registrarAuditoria(ator, 'envio falhou', `${telefone}: ${resultado.message}`);
        console.warn(`Envio para ${telefone} recusado: ${resultado.message}`);
        const naoConfigurada = String(resultado.message || '').includes('não configurada');
        return res.status(naoConfigurada ? 500 : 502).json({
            success: false,
            message: resultado.message,
            janelaFechada: !!resultado.janelaFechada
        });
    }

    try {
        await banco.atualizarUltimaMensagem(telefone, `Você: ${texto}`);
        await banco.registrarMensagem(telefone, 'enviada', texto, {
            autorEmail: req.user && req.user.email,
            autorNome: req.user && req.user.nome,
            origem: 'painel'
        });
        emitirEvento('mensagem', { telefone, direcao: 'enviada', texto });
        await banco.registrarAuditoria(ator, 'mensagem enviada', telefone);
    } catch (erro) {
        console.error('Erro ao salvar a mensagem enviada:', erro.message);
        return res.json({ success: true, demo: !!resultado.demo, aviso: 'Enviada, mas o histórico não foi salvo.' });
    }

    if (resultado.demo) console.log(`[DEMO] Mensagem simulada -> ${telefone}: ${texto}`);
    return res.json({ success: true, demo: !!resultado.demo });
});

/* ---------------------------------------------------------
   ENVIAR IMAGEM PELO CHAT (colaborador e admin)
   O navegador manda os bytes crus (Content-Type = tipo da
   imagem) e o servidor repassa à Wati em multipart
   (/api/v1/sendSessionFile). Não precisa hospedar a foto em
   lugar nenhum: a Wati guarda e entrega no WhatsApp.
   A foto também fica no banco (tabela midias) para aparecer
   no histórico da conversa.
   --------------------------------------------------------- */
const EXTENSAO_IMAGEM = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const TIPOS_IMAGEM = new Set(Object.keys(EXTENSAO_IMAGEM));
const LIMITE_IMAGEM_BYTES = 5 * 1024 * 1024;

async function enviarImagemViaWati(telefone, { dados, mimetype, nome, legenda }) {
    if (banco.modoDemo) return { ok: true, demo: true };

    if (!watiConfigurada()) {
        console.error('WATI_TOKEN ou WATI_NUMERO não configurados no Render!');
        return { ok: false, message: 'API da Wati não configurada no servidor.' };
    }

    const numero = String(telefone || '').replace(/\D/g, '') || String(telefone || '').trim();

    const parametros = new URLSearchParams();
    if (legenda) parametros.set('caption', String(legenda).substring(0, 1000));
    const consulta = parametros.toString();
    const url = `${watiBase()}/api/v1/sendSessionFile/${encodeURIComponent(numero)}${consulta ? '?' + consulta : ''}`;

    const nomeArquivo = nome || ('imagem' + (EXTENSAO_IMAGEM[mimetype] || '.jpg'));

    /* Mesma lógica do texto: repete em 429/5xx e confere o corpo da resposta. */
    const tentarEnvio = async () => {
        let resposta = null;
        let corpo = '';
        let recebido = {};

        for (let tentativa = 1; tentativa <= 2; tentativa++) {
            try {
                const formulario = new FormData();
                formulario.append('file', new Blob([dados], { type: mimetype }), nomeArquivo);

                resposta = await fetch(url, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${WATI_TOKEN}` },
                    body: formulario
                });
            } catch (erro) {
                console.error('Erro ao chamar a API da Wati (imagem):', erro.message);
                return { ok: false, conexao: true, message: 'Erro de conexão com a Wati.' };
            }

            corpo = await resposta.text();
            recebido = {};
            try { recebido = corpo ? JSON.parse(corpo) : {}; } catch (erro) { recebido = { message: corpo }; }

            const recusado = recebido.result === false || recebido.success === false;
            if (resposta.ok && !recusado) return { ok: true };

            if ((resposta.status === 429 || resposta.status >= 500) && tentativa === 1) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
            }

            break;
        }

        const motivo = (achatarErroWati(recebido && recebido.message)
            || achatarErroWati(recebido && recebido.info)
            || achatarErroWati(recebido && recebido.error)
            || achatarErroWati(recebido && recebido.errors)
            || '').substring(0, 300) || `HTTP ${resposta.status}`;

        console.error(`Wati recusou a imagem para ${numero} (HTTP ${resposta.status}):`, String(corpo).substring(0, 600));
        return { ok: false, status: resposta.status, motivo };
    };

    try {
        let resultado = await tentarEnvio();

        if (resultado.conexao) return { ok: false, message: resultado.message };

        // Contato fora da conta da Wati: cria e tenta mais uma vez.
        if (!resultado.ok && contatoInexistenteNaWati(resultado.motivo)) {
            const criacao = await garantirContatoNaWati(numero);

            if (criacao.ok) {
                await new Promise((resolve) => setTimeout(resolve, 400));
                resultado = await tentarEnvio();
                if (resultado.conexao) return { ok: false, message: resultado.message };
            } else {
                resultado.criacao = criacao;
            }
        }

        if (resultado.ok) return { ok: true };

        const fechada = erroJanelaFechada(resultado.motivo);
        const motivoLimpo = String(resultado.motivo || '').replace(/[\s.;]+$/, '') || `HTTP ${resultado.status}`;

        const mensagem = (resultado.criacao && !resultado.criacao.ok)
            ? `A Wati não encontrou o contato ${numero} e não conseguiu criá-lo (${motivoLimpo}). Confira se o número tem WhatsApp.`
            : `A Wati recusou o envio da imagem (HTTP ${resultado.status}): ${motivoLimpo}.`;

        return { ok: false, message: mensagem + (fechada ? ` ${ORIENTACAO_JANELA_FECHADA}` : ''), janelaFechada: fechada };
    } catch (erro) {
        console.error('Erro ao chamar a API da Wati (imagem):', erro.message);
        return { ok: false, message: 'Erro de conexão com a Wati.' };
    }
}

/* ---------------------------------------------------------
   ROTAS DA IMAGEM: envio pelo chat e leitura do histórico
   --------------------------------------------------------- */
/* Lê o corpo cru da imagem (sem base64: o arquivo vai como veio do navegador). */
const parserImagem = express.raw({
    type: Array.from(TIPOS_IMAGEM),
    limit: LIMITE_IMAGEM_BYTES
});

app.post('/api/enviar-imagem', (req, res, next) => {
    parserImagem(req, res, (erro) => {
        if (!erro) return next();

        const grande = erro && (erro.type === 'entity.too.large' || erro.status === 413);
        return res.status(grande ? 413 : 400).json({
            success: false,
            message: grande
                ? 'A imagem passa de 5 MB. Reduza a foto antes de enviar.'
                : 'Formato de imagem não aceito. Use JPG, PNG ou WEBP.'
        });
    });
}, async (req, res) => {
    const telefone = String((req.query && req.query.telefone) || '').trim();
    const legenda = String((req.query && req.query.legenda) || '').trim().substring(0, 1000);
    const mimetype = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const nomeArquivo = String((req.query && req.query.nome) || '').trim().substring(0, 120)
        || ('imagem' + (EXTENSAO_IMAGEM[mimetype] || '.jpg'));
    const dados = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!telefone) {
        return res.status(400).json({ success: false, message: 'Escolha a conversa antes de enviar a imagem.' });
    }
    if (!TIPOS_IMAGEM.has(mimetype)) {
        return res.status(415).json({ success: false, message: 'Formato de imagem não aceito. Use JPG, PNG ou WEBP.' });
    }
    if (!dados.length) {
        return res.status(400).json({ success: false, message: 'Selecione uma imagem para enviar.' });
    }

    const ator = req.user && req.user.nome;

    try {
        const acesso = await verificarDonoDoCliente(req, telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);
    } catch (erro) {
        console.error('Erro ao validar o dono do contato:', erro.message);
        return res.status(500).json({ success: false, message: 'Erro ao validar o contato.' });
    }

    const resultado = await enviarImagemViaWati(telefone, { dados, mimetype, nome: nomeArquivo, legenda });

    if (!resultado.ok) {
        await banco.registrarAuditoria(ator, 'envio de imagem falhou', `${telefone}: ${resultado.message}`);
        console.warn(`Imagem para ${telefone} recusada: ${resultado.message}`);

        const naoConfigurada = String(resultado.message || '').includes('não configurada');
        return res.status(naoConfigurada ? 500 : 502).json({
            success: false,
            message: resultado.message,
            janelaFechada: !!resultado.janelaFechada
        });
    }

    const texto = legenda || '📷 Imagem';
    let midiaId = null;

    try {
        midiaId = await banco.salvarMidia({ telefone, mimetype, nome: nomeArquivo, dados });
        await banco.atualizarUltimaMensagem(telefone, legenda ? `Você: 📷 ${legenda}` : 'Você: 📷 imagem');
        await banco.registrarMensagem(telefone, 'enviada', texto, {
            autorEmail: req.user && req.user.email,
            autorNome: req.user && req.user.nome,
            origem: 'painel',
            midiaId
        });
        emitirEvento('mensagem', { telefone, direcao: 'enviada', texto, midiaId });
        await banco.registrarAuditoria(ator, 'imagem enviada', telefone);
    } catch (erro) {
        console.error('Erro ao salvar a imagem enviada:', erro.message);
        return res.json({
            success: true,
            demo: !!resultado.demo,
            midiaId,
            aviso: 'Enviada, mas o histórico não foi salvo.'
        });
    }

    if (resultado.demo) console.log(`[DEMO] Imagem simulada -> ${telefone} (${mimetype}, ${dados.length} bytes)`);
    return res.json({ success: true, demo: !!resultado.demo, midiaId, texto });
});

/* Mostra a foto do histórico. Só quem enxerga a conversa (admin ou o
   colaborador dono do lead) consegue abrir a imagem. */
app.get('/api/midias/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, message: 'Imagem inválida.' });
    }

    try {
        const midia = await banco.lerMidia(id);
        if (!midia) return res.status(404).json({ success: false, message: 'Imagem não encontrada.' });

        const acesso = await verificarDonoDoCliente(req, midia.telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

        res.set({
            'Content-Type': midia.mimetype || 'application/octet-stream',
            'Cache-Control': 'private, max-age=86400',
            'Content-Disposition': 'inline'
        });
        return res.send(midia.dados);
    } catch (erro) {
        console.error('Erro ao abrir a imagem:', erro.message);
        return res.status(500).json({ success: false, message: 'Erro ao abrir a imagem.' });
    }
});

/* ---------------------------------------------------------
   REABRIR O TICKET COM TEMPLATE
   Depois de 24h sem mensagem do cliente a Wati recusa texto
   livre ("Ticket has been expired"). Um template aprovado
   abre o ticket de novo e a conversa volta ao normal.
   --------------------------------------------------------- */

/* Templates aprovados que o painel pode oferecer no chat. Vale para
   colaborador também: sem isso ele não tem como reabrir o atendimento. */
app.get('/api/templates-reabertura', async (req, res) => {
    try {
        const resultado = await listarTemplatesWati(false);

        const templates = (resultado.templates || [])
            .filter((template) => template.aprovado)
            .map((template) => ({
                nome: template.nome,
                idioma: template.idioma || '',
                corpo: template.corpo || '',
                variaveis: Array.isArray(template.variaveis) ? template.variaveis.slice() : []
            }));

        res.json({ ok: true, templates, aviso: resultado.aviso || '' });
    } catch (erro) {
        console.error('Erro ao listar templates de reabertura:', erro.message);
        res.status(500).json({ ok: false, templates: [], aviso: 'Erro ao consultar os templates da Wati.' });
    }
});

/* Envio de UM template para UM contato (reabertura do ticket pelo chat).
   Os valores chegam na ordem das variáveis do template. */
app.post('/api/enviar-template', async (req, res) => {
    const { telefone, template, parametros } = req.body || {};

    if (!telefone || !String(template || '').trim()) {
        return res.status(400).json({ success: false, message: 'Informe o contato e o template.' });
    }

    const ator = req.user && req.user.nome;
    const numero = String(telefone).replace(/\D/g, '');

    try {
        const acesso = await verificarDonoDoCliente(req, numero || telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);
    } catch (erro) {
        console.error('Erro ao validar o dono do contato (template):', erro.message);
        return res.status(500).json({ success: false, message: 'Erro ao validar o contato.' });
    }

    if (!banco.modoDemo && !watiConfigurada()) {
        return res.status(500).json({ success: false, message: 'API da Wati não configurada no servidor.' });
    }

    try {
        const resultado = await listarTemplatesWati(false);
        const nomeAlvo = String(template).trim().toLowerCase();

        const alvo = (resultado.templates || []).find((item) =>
            item.aprovado && item.nome.toLowerCase() === nomeAlvo
        );

        if (!alvo) {
            return res.status(400).json({
                success: false,
                message: `O template "${template}" não está aprovado na Wati. Atualize a lista de templates e tente de novo.`
            });
        }

        const nomes = Array.isArray(alvo.variaveis) ? alvo.variaveis : [];
        const valores = (Array.isArray(parametros) ? parametros : [])
            .map((valor) => String(valor == null ? '' : valor).trim());

        if (valores.length !== nomes.length) {
            return res.status(400).json({
                success: false,
                message: `O template ${alvo.nome} tem ${nomes.length} variável(is); foram enviados ${valores.length} valor(es).`
            });
        }

        // Mesmo formato do envio em campanha (custom_params por nome).
        const pares = nomes.map((nome, indice) => ({ name: nome, value: valores[indice] }));

        const pedido = {
            templateNome: alvo.nome,
            campanha: `reabertura_${numero || 'contato'}`,
            destinatarios: [{
                telefone: numero,
                parametros: pares,
                envioId: `reab-${Date.now()}`
            }]
        };

        let envio = await enviarTemplateWatiLote(pedido);
        const motivoInicial = envio.ok ? '' : String(
            (envio.resultados && envio.resultados[0] && envio.resultados[0].message) || envio.message || ''
        );

        /* Contato que ainda não existe na Wati: cria (com o nome da ficha) e
           repete o template uma vez — senão o painel só mostrava
           "Contact with phone number ... not found". */
        if (!envio.ok && contatoInexistenteNaWati(motivoInicial)) {
            const criacao = await garantirContatoNaWati(numero);

            if (criacao.ok) {
                await new Promise((resolve) => setTimeout(resolve, 400));
                envio = await enviarTemplateWatiLote(pedido);
            }
        }

        if (!envio.ok) {
            const detalheDoContato = envio.resultados && envio.resultados[0] && envio.resultados[0].message;
            const motivoBruto = detalheDoContato || envio.message || 'A Wati recusou o template.';
            // Pode vir objeto aninhado da Wati: o painel nunca deve mostrar "[object Object]".
            const motivo = achatarErroWati(motivoBruto) || 'A Wati recusou o template.';

            await banco.registrarAuditoria(ator, 'template recusado', `${numero}: ${motivo}`);
            console.warn(`Template ${alvo.nome} recusado para ${numero}: ${motivo}`);

            return res.status(502).json({ success: false, message: motivo });
        }

        const texto = renderizarMensagemTemplate(alvo.corpo, pares, alvo.variaveis).trim()
            || `[Template ${alvo.nome} enviado]`;

        try {
            await banco.atualizarUltimaMensagem(numero, `Você: ${texto}`);
            await banco.registrarMensagem(numero, 'enviada', texto, {
                autorEmail: req.user && req.user.email,
                autorNome: req.user && req.user.nome,
                origem: 'template'
            });
            emitirEvento('mensagem', { telefone: numero, direcao: 'enviada', texto });
            await banco.registrarAuditoria(ator, 'template enviado', `${numero}: ${alvo.nome}`);
        } catch (erro) {
            console.error('Erro ao salvar o template enviado:', erro.message);
            return res.json({
                success: true,
                template: alvo.nome,
                texto,
                aviso: 'Template enviado, mas o histórico não foi salvo.'
            });
        }

        return res.json({ success: true, template: alvo.nome, texto });
    } catch (erro) {
        console.error('Erro ao enviar o template de reabertura:', erro.message);
        return res.status(500).json({ success: false, message: 'Erro ao enviar o template pela Wati.' });
    }
});

app.post('/api/finalizar', async (req, res) => {
    const { telefone } = req.body || {};

    if (!telefone) return res.status(400).json({ success: false, message: 'Informe o telefone.' });

    try {
        const acesso = await verificarDonoDoCliente(req, telefone);
        if (!acesso.ok) return responderAcessoNegado(res, acesso);

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
        const usuarios = await banco.listarUsuarios();
        /* online/desde/ultimoSinal vêm da memória (quem está com o painel aberto). */
        res.json(usuarios.map((usuario) => Object.assign({}, usuario, presencaDoUsuario(usuario))));
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
app.get('/api/logs', exigirAdmin, async (req, res) => {
    const limite = Math.min(parseInt(req.query.limite, 10) || 100, 500);
    const direcao = String(req.query.direcao || '');

    try {
        res.json(await banco.listarLogs({ limite, direcao }));
    } catch (erro) {
        console.error('Erro ao listar logs:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao carregar os logs.' });
    }
});

// ---------------------------------------------------------
// CONVERSAS: BACKUP E LIMPEZA (somente administrador)
// ---------------------------------------------------------
app.get('/api/conversas/exportar', exigirAdmin, async (req, res) => {
    try {
        const backup = await banco.exportarConversas();
        const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="conversas-${carimbo}.json"`);
        res.send(JSON.stringify(backup, null, 2));
    } catch (erro) {
        console.error('Erro ao exportar conversas:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao gerar o backup das conversas.' });
    }
});

app.get('/api/conversas/status', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.contarConversas());
    } catch (erro) {
        console.error('Erro ao contar conversas:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao contar as conversas.' });
    }
});

app.post('/api/conversas/limpar', exigirAdmin, async (req, res) => {
    const corpo = req.body || {};
    if (String(corpo.confirmar || '').toUpperCase() !== 'LIMPAR') {
        return res.status(400).json({ success: false, message: 'Confirmação inválida.' });
    }

    const incluirEventosWati = corpo.incluirEventosWati !== false;

    try {
        const resultado = await banco.limparConversas({ incluirEventosWati });

        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'conversas limpas',
            `${resultado.mensagensRemovidas} mensagem(ns), ${resultado.clientesAtualizados} prévia(s)`
                + (incluirEventosWati ? `, ${resultado.eventosRemovidos} evento(s) da Wati` : '')
        );

        emitirEvento('conversas', resultado);
        emitirEvento('status', { limpeza: true });

        res.json(Object.assign({ success: true }, resultado));
    } catch (erro) {
        console.error('Erro ao limpar conversas:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao limpar as conversas.' });
    }
});

// ---------------------------------------------------------
// RESET DOS DADOS DE TESTE (clientes + conversas + listas)
// ---------------------------------------------------------
app.get('/api/dados/status', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.contarDados());
    } catch (erro) {
        console.error('Erro ao contar dados:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao contar os dados.' });
    }
});

app.post('/api/dados/limpar', exigirAdmin, async (req, res) => {
    const corpo = req.body || {};
    if (String(corpo.confirmar || '').toUpperCase() !== 'LIMPAR TUDO') {
        return res.status(400).json({ success: false, message: 'Confirmação inválida. Digite LIMPAR TUDO.' });
    }

    const incluirEventosWati = corpo.incluirEventosWati !== false;

    try {
        const resultado = await banco.limparDados({ incluirEventosWati });

        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'dados de teste limpos',
            `${resultado.clientesRemovidos} cliente(s), ${resultado.mensagensRemovidas} mensagem(ns), `
                + `${resultado.listasRemovidas} lista(s)`
                + (incluirEventosWati ? `, ${resultado.eventosRemovidos} evento(s) da Wati` : '')
        );

        emitirEvento('conversas', resultado);
        emitirEvento('clientes', { limpeza: true });
        emitirEvento('lista', { limpeza: true });
        emitirEvento('status', { limpeza: true });

        res.json(Object.assign({ success: true }, resultado));
    } catch (erro) {
        console.error('Erro ao limpar dados:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao limpar os dados.' });
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
// CAMPANHAS (fila de envio com intervalo entre lotes)
// ---------------------------------------------------------
let processandoCampanhas = false;

/* Quantos contatos de template vão juntos numa requisição da Wati. A Wati
   cria UMA campanha por requisição, então o lote inteiro sai de uma vez (é
   isso que evita o painel dela mostrar "campanha" de 1 contato por mensagem).
   Ajuste com a variável WATI_LOTE_TEMPLATE no Render, se precisar. */
const LOTE_TEMPLATE = Math.min(Math.max(parseInt(process.env.WATI_LOTE_TEMPLATE, 10) || 200, 1), 500);

/* Motivo gravado quando a lista repete o mesmo WhatsApp: a campanha manda uma
   mensagem por número, o restante fica registrado como não enviado. */
const DUPLICADO_CAMPANHA = 'Telefone repetido na campanha: enviado uma única vez por número.';

/* Efeitos colaterais de um envio aceito: direciona o lead ao vendedor da
   campanha, grava a mensagem no histórico e avisa o painel em tempo real. */
async function registrarEnvioBemSucedido(item, textoFinal) {
    // Direciona o lead ANTES de gravar a mensagem: assim o colaborador já
    // enxerga a conversa quando o painel receber o evento em tempo real.
    if (item.vendedor_email) {
        try {
            await banco.atribuirVendedor({
                telefone: item.telefone,
                nomeContato: item.nome,
                vendedorEmail: item.vendedor_email,
                vendedorNome: item.vendedor_nome
            });
            emitirEvento('clientes', {
                telefone: item.telefone,
                vendedor: item.vendedor_nome || item.vendedor_email
            });
        } catch (erro) {
            console.error('Erro ao direcionar o lead:', erro.message);
        }
    }

    await banco.registrarMensagem(item.telefone, 'enviada', textoFinal, {
        autorEmail: item.criado_por_email || item.vendedor_email || null,
        autorNome: item.criado_por_nome || item.vendedor_nome || null,
        campanhaId: item.campanha_id,
        origem: 'campanha'
    });
    await banco.atualizarUltimaMensagem(item.telefone, `Você: ${textoFinal}`);

    emitirEvento('mensagem', { telefone: item.telefone, direcao: 'enviada', texto: textoFinal });
}

async function processarCampanhas() {
    if (processandoCampanhas) return;
    processandoCampanhas = true;

    try {
        for (let i = 0; i < 5; i++) {
            const item = await banco.proximoEnvioPendente();
            if (!item) break;

            if (item.canal === 'template') {
                // Um lote por vez: todos os pendentes desta campanha saem numa
                // requisição só (uma campanha no painel da Wati).
                //
                // Antes do lote, fecha os pendentes que repetem um número já
                // enviado nesta campanha (listas com a mesma pessoa em mais de
                // uma linha): sem isso a Wati manda a mensagem de novo.
                const repetidosJaEnviados = await banco.enviosDuplicadosCampanha(item.campanha_id);

                for (const repetido of repetidosJaEnviados) {
                    await banco.concluirEnvio(repetido.envio_id, repetido.campanha_id, false, DUPLICADO_CAMPANHA);
                    console.warn(`Campanha ${item.campanha} -> ${repetido.telefone}: ${DUPLICADO_CAMPANHA}`);

                    emitirEvento('campanha', {
                        id: repetido.campanha_id,
                        telefone: repetido.telefone,
                        ok: false,
                        erro: DUPLICADO_CAMPANHA
                    });
                }

                const pendentes = await banco.enviosPendentesCampanha(item.campanha_id, LOTE_TEMPLATE);
                const reservados = [];
                const repetidosNoLote = [];
                const noLote = new Set();

                for (const envio of pendentes) {
                    const numero = String(envio.telefone || '').replace(/\D/g, '');
                    const repetido = numero && noLote.has(numero);

                    if (repetido) {
                        repetidosNoLote.push(envio);
                        continue;
                    }

                    if (reservados.length >= LOTE_TEMPLATE) break;
                    if (!(await banco.reservarEnvio(envio.envio_id))) continue;

                    if (numero) noLote.add(numero);
                    reservados.push(envio);
                }

                // Repetido dentro do próprio lote também sai como falha: uma
                // mensagem por número, nunca duas.
                for (const repetido of repetidosNoLote) {
                    await banco.concluirEnvio(repetido.envio_id, repetido.campanha_id, false, DUPLICADO_CAMPANHA);
                    console.warn(`Campanha ${item.campanha} -> ${repetido.telefone}: ${DUPLICADO_CAMPANHA}`);

                    emitirEvento('campanha', {
                        id: repetido.campanha_id,
                        telefone: repetido.telefone,
                        ok: false,
                        erro: DUPLICADO_CAMPANHA
                    });
                }

                if (!reservados.length) continue;

                let lote;

                try {
                    lote = await enviarTemplateWatiLote({
                        templateNome: item.template_nome,
                        campanha: item.campanha,
                        destinatarios: reservados.map((reservado) => ({
                            telefone: reservado.telefone,
                            parametros: reservado.envio_parametros,
                            envioId: reservado.envio_id
                        }))
                    });
                } catch (erro) {
                    // Sem isso o lote reservado ficaria preso em "enviando" e a
                    // campanha nunca terminaria.
                    console.error('Erro no envio do lote da campanha:', erro.message);
                    lote = { ok: false, resultados: [], message: `Falha ao falar com a Wati: ${erro.message}` };
                }

                // Resultados são conferidos pelo telefone: contato sem número
                // válido é descartado do lote, o que desalinharia os índices.
                const porTelefone = new Map();
                (lote.resultados || []).forEach((resultado) => {
                    if (resultado && resultado.telefone) porTelefone.set(String(resultado.telefone), resultado);
                });

                for (const reservado of reservados) {
                    const numero = String(reservado.telefone || '').replace(/\D/g, '');
                    const resultado = porTelefone.get(numero)
                        || { ok: false, message: lote.message || 'Telefone inválido ou sem retorno da Wati.', aviso: '' };

                    const textoFinal = String(reservado.envio_mensagem || item.mensagem || '').trim();

                    if (resultado.ok && resultado.aviso) {
                        console.warn(`Campanha ${item.campanha} -> ${reservado.telefone}: ${resultado.aviso}`);
                    }

                    await banco.concluirEnvio(reservado.envio_id, reservado.campanha_id, resultado.ok, resultado.message);

                    if (resultado.ok) {
                        await registrarEnvioBemSucedido(reservado, textoFinal);
                    } else {
                        console.warn(`Campanha ${item.campanha} -> ${reservado.telefone}: ${resultado.message}`);
                    }

                    emitirEvento('campanha', {
                        id: reservado.campanha_id,
                        telefone: reservado.telefone,
                        ok: resultado.ok,
                        erro: resultado.message || null
                    });
                }

                continue;
            }

            // Texto livre (sessão de 24h): vai um por vez, com o intervalo da
            // campanha entre as mensagens.
            //
            // A lista pode repetir o mesmo WhatsApp em mais de uma linha; o
            // segundo registro do número não gera nova mensagem.
            const jaEnviadosNaCampanha = await banco.enviosDuplicadosCampanha(item.campanha_id);
            const repetido = jaEnviadosNaCampanha.find((dup) => String(dup.envio_id) === String(item.envio_id));

            if (repetido) {
                if (!(await banco.reservarEnvio(item.envio_id))) continue;

                await banco.concluirEnvio(item.envio_id, item.campanha_id, false, DUPLICADO_CAMPANHA);
                console.warn(`Campanha ${item.campanha} -> ${item.telefone}: ${DUPLICADO_CAMPANHA}`);

                emitirEvento('campanha', {
                    id: item.campanha_id,
                    telefone: item.telefone,
                    ok: false,
                    erro: DUPLICADO_CAMPANHA
                });

                continue;
            }

            if (!(await banco.reservarEnvio(item.envio_id))) continue;

            const nomeContato = String(item.nome || '').trim();
            const textoFinal = String(item.envio_mensagem || item.mensagem || '')
                .replace(/\{\{\s*nome\s*\}\}/gi, nomeContato)
                .replace(/ {2,}/g, ' ')
                .trim();

            const resultado = await enviarViaWati(item.telefone, textoFinal);

            if (resultado.ok && resultado.aviso) {
                console.warn(`Campanha ${item.campanha} -> ${item.telefone}: ${resultado.aviso}`);
            }

            await banco.concluirEnvio(item.envio_id, item.campanha_id, resultado.ok, resultado.message);

            if (resultado.ok) {
                await registrarEnvioBemSucedido(item, textoFinal);
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

app.get('/api/campanhas', exigirAdmin, async (req, res) => {
    try {
        res.json(await banco.listarCampanhas());
    } catch (erro) {
        console.error('Erro ao listar campanhas:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao listar campanhas.' });
    }
});

/* Valor de um atributo/campo do contato para preencher uma variável. */
function valorDoContato(contato, referencia) {
    const chave = normalizarAtributo(referencia);
    if (!chave) return '';

    if (chave === 'nome' || chave === 'name') {
        const nome = String((contato && contato.nome) || '').trim();
        if (nome) return nome;
    }
    if (chave === 'telefone' || chave === 'phone' || chave === 'numero') {
        const telefone = String((contato && contato.telefone) || '').trim();
        if (telefone) return telefone;
    }

    // Colunas {{1}}, {{2}}... importadas no formato "lista por variáveis".
    const variaveis = (contato && contato.variaveis) || {};
    if (variaveis[chave] != null && String(variaveis[chave]).trim()) return String(variaveis[chave]).trim();

    const variavelAchada = Object.keys(variaveis).find((nome) => normalizarAtributo(nome) === chave);
    if (variavelAchada && String(variaveis[variavelAchada] == null ? '' : variaveis[variavelAchada]).trim()) {
        return String(variaveis[variavelAchada]).trim();
    }

    const atributos = (contato && contato.atributos) || {};
    if (atributos[chave] != null && String(atributos[chave]).trim()) return String(atributos[chave]).trim();

    const achado = Object.keys(atributos).find((nome) => normalizarAtributo(nome) === chave);
    return achado ? String(atributos[achado] == null ? '' : atributos[achado]).trim() : '';
}

/* Prévia do que o contato vai receber (o texto em si vai na campanha,
   os valores vão em custom_params). Quando o corpo usa {{1}}, {{2}}...
   ligamos cada posição ao nome do parâmetro na mesma ordem. */
function renderizarMensagemTemplate(corpo, parametros, variaveis) {
    const lista = Array.isArray(parametros) ? parametros : [];
    const nomes = Array.isArray(variaveis) ? variaveis : [];
    const mapa = {};

    lista.forEach((item) => { mapa[item.name] = item.value; });

    return String(corpo || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (achado, bruto) => {
        const chave = String(bruto).trim();
        let nome = chave;

        if (/^\d+$/.test(chave)) {
            const indice = parseInt(chave, 10) - 1;
            if (nomes[indice]) nome = String(nomes[indice]);
            else if (lista[indice] && lista[indice].name) nome = lista[indice].name;
        }

        if (mapa[nome] === undefined) return achado;
        return mapa[nome] || `[${nome}]`;
    });
}

app.post('/api/campanhas', exigirAdmin, async (req, res) => {
    const {
        nome, listaId, mensagem, intervalo, vendedorEmail,
        canal, templateNome, templateIdioma, parametros
    } = req.body || {};

    const canalEscolhido = canal === 'template' ? 'template' : 'texto';
    const nomeCampanha = String(nome || '').trim();
    const textoMensagem = String(mensagem || '').trim();

    if (!nomeCampanha) {
        return res.status(400).json({ success: false, message: 'Informe um nome para a campanha.' });
    }
    if (canalEscolhido === 'texto' && !textoMensagem) {
        return res.status(400).json({ success: false, message: 'Escreva a mensagem da campanha.' });
    }
    if (canalEscolhido === 'template' && !String(templateNome || '').trim()) {
        return res.status(400).json({ success: false, message: 'Escolha o template aprovado da Wati.' });
    }
    if (!listaId) {
        return res.status(400).json({ success: false, message: 'Escolha a lista de contatos.' });
    }

    try {
        // Destino dos leads: valida o vendedor escolhido (opcional)
        let vendedor = null;
        const emailVendedor = String(vendedorEmail || '').trim().toLowerCase();

        if (emailVendedor) {
            vendedor = await banco.buscarUsuarioPorEmail(emailVendedor);
            if (!vendedor || vendedor.ativo === false) {
                return res.status(400).json({ success: false, message: 'Vendedor escolhido não encontrado ou desativado.' });
            }
        }

        const contatos = await banco.obterContatosLista(listaId);
        if (!contatos.length) {
            return res.status(400).json({ success: false, message: 'A lista escolhida está vazia.' });
        }

        // 3 segundos no mínimo (proteção contra bloqueio do WhatsApp), 2 minutos
        // no máximo; 5 segundos é o padrão. Nos templates o intervalo vale entre
        // lotes (o lote inteiro sai numa campanha só na Wati).
        const intervaloMs = Math.min(Math.max(parseInt(intervalo, 10) || 5000, 3000), 120000);

        // A lista pode trazer a mesma pessoa em mais de uma linha (mesmo
        // WhatsApp em registros diferentes). Cada linha viraria uma mensagem:
        // fica só a primeira de cada número — e ela herda os dados que só
        // existiam na outra linha. Isso vem antes de qualquer validação para
        // uma linha repetida nunca bloquear a campanha.
        const semRepetidos = deduplicarContatosPorTelefone(contatos);
        let contatosParaEnvio = semRepetidos.unicos;

        if (!contatosParaEnvio.length) {
            return res.status(400).json({
                success: false,
                message: 'A lista escolhida não tem nenhum telefone válido.'
            });
        }

        let mensagemCampanha = textoMensagem;
        let templateEscolhido = null;
        let templateParametros = [];
        let contatosSemDado = [];

        if (canalEscolhido === 'template') {
            const resultadoTemplates = await listarTemplatesWati(false);

            if (!resultadoTemplates.templates.length) {
                return res.status(400).json({
                    success: false,
                    message: resultadoTemplates.aviso || 'Nenhum template encontrado na Wati.'
                });
            }

            const nomeAlvo = String(templateNome).trim().toLowerCase();
            const idiomaAlvo = String(templateIdioma || '').trim().toLowerCase();

            templateEscolhido = resultadoTemplates.templates.find((t) =>
                t.nome.toLowerCase() === nomeAlvo && (!idiomaAlvo || String(t.idioma || '').toLowerCase() === idiomaAlvo)
            ) || resultadoTemplates.templates.find((t) => t.nome.toLowerCase() === nomeAlvo);

            if (!templateEscolhido) {
                return res.status(400).json({
                    success: false,
                    message: `O template "${templateNome}" não está entre os templates da Wati. Atualize a lista de templates.`
                });
            }

            if (!templateEscolhido.aprovado) {
                return res.status(400).json({
                    success: false,
                    message: `O template "${templateEscolhido.nome}" está com status ${templateEscolhido.status || 'desconhecido'} e não pode ser enviado.`
                });
            }

            // Cada variável precisa de uma origem: atributo da lista ou valor
            // fixo. "padrao" é o valor de reserva para quem não tem o dado
            // (ex.: lista sem nome -> "cliente"), evitando travar a campanha.
            const informados = {};
            (Array.isArray(parametros) ? parametros : []).forEach((item) => {
                const chave = String((item && item.nome) || '').trim();
                if (!chave) return;

                informados[chave] = {
                    origem: item.origem === 'fixo' ? 'fixo' : 'atributo',
                    valor: String(item.valor == null ? '' : item.valor).trim(),
                    padrao: String(item.padrao == null ? '' : item.padrao).trim()
                };
            });

            const semMapeamento = templateEscolhido.variaveis.filter((variavel) => {
                const mapa = informados[variavel];
                return !mapa || !mapa.valor;
            });

            if (semMapeamento.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Ligue cada variável do template: ' + semMapeamento.map((v) => '{{' + v + '}}').join(', ') + '.'
                });
            }

            const faltandoAtributo = new Map();
            const comTodosOsDados = [];

            contatosParaEnvio.forEach((contato) => {
                let completo = true;

                const valores = templateEscolhido.variaveis.map((variavel) => {
                    const mapa = informados[variavel];
                    let valor;

                    if (mapa.origem === 'fixo') {
                        valor = mapa.valor;
                    } else {
                        valor = valorDoContato(contato, mapa.valor);

                        if (!valor) {
                            // Valor de reserva resolve o contato incompleto sem
                            // segurar o resto da campanha.
                            if (mapa.padrao) {
                                valor = mapa.padrao;
                            } else {
                                completo = false;

                                const registro = faltandoAtributo.get(mapa.valor) || { total: 0, exemplos: [] };
                                registro.total += 1;
                                if (registro.exemplos.length < 5 && registro.exemplos.indexOf(contato.telefone) === -1) {
                                    registro.exemplos.push(contato.telefone);
                                }
                                faltandoAtributo.set(mapa.valor, registro);
                            }
                        }
                    }

                    return { name: variavel, value: valor };
                });

                if (!completo) return;

                comTodosOsDados.push(Object.assign({}, contato, {
                    parametros: valores,
                    mensagem: renderizarMensagemTemplate(templateEscolhido.corpo, valores, templateEscolhido.variaveis)
                }));
            });

            // Contato sem o dado fica de fora (nada de "Olá ," chegando no
            // WhatsApp) e o painel mostra quem precisa ser completado.
            contatosSemDado = Array.from(faltandoAtributo.entries()).map(([atributo, info]) => ({
                atributo,
                total: info.total,
                exemplos: info.exemplos
            }));

            if (!comTodosOsDados.length) {
                const detalhes = contatosSemDado.map((item) =>
                    `${item.total} contato(s) sem "${item.atributo}" (ex.: ${item.exemplos.join(', ')})`
                );

                return res.status(400).json({
                    success: false,
                    message: 'Nenhum contato da lista tem o que o template pede: ' + detalhes.join('; ')
                        + '. Complete a lista ou preencha o valor de reserva da variável (ex.: cliente).'
                });
            }

            contatosParaEnvio = comTodosOsDados;

            templateParametros = templateEscolhido.variaveis.map((variavel) => ({
                nome: variavel,
                origem: informados[variavel].origem,
                valor: informados[variavel].valor,
                padrao: informados[variavel].padrao
            }));

            mensagemCampanha = templateEscolhido.corpo || textoMensagem || ('Template ' + templateEscolhido.nome);
        }

        const campanha = await banco.criarCampanha({
            nome: nomeCampanha,
            listaId: parseInt(listaId, 10) || null,
            mensagem: mensagemCampanha,
            intervaloMs,
            contatos: contatosParaEnvio,
            vendedorEmail: vendedor ? vendedor.email : null,
            vendedorNome: vendedor ? vendedor.nome : null,
            canal: canalEscolhido,
            templateNome: templateEscolhido ? templateEscolhido.nome : null,
            templateIdioma: templateEscolhido ? templateEscolhido.idioma : null,
            templateParametros,
            criadoPorEmail: req.user && req.user.email,
            criadoPorNome: req.user && req.user.nome
        });

        emitirEvento('campanha', { id: campanha.id, criada: true, total: campanha.total });
        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'campanha criada',
            `${campanha.id} - ${nomeCampanha} (${campanha.total} contatos, ${intervaloMs} ms`
                + (templateEscolhido ? `, template ${templateEscolhido.nome}` : ', texto livre')
                + (semRepetidos.repetidos.length ? `, ${semRepetidos.repetidos.length} repetido(s) ignorado(s)` : '')
                + (contatosSemDado.length
                    ? `, ${contatosSemDado.map((item) => `${item.total} sem "${item.atributo}"`).join(', ')} fora da campanha`
                    : '')
                + ')'
                + (vendedor ? ` -> ${vendedor.nome} (${vendedor.email})` : ' -> sem direcionamento')
        );

        res.json({
            success: true,
            id: campanha.id,
            total: campanha.total,
            ignorados: semRepetidos.repetidos.length,
            semDado: contatosSemDado,
            semDadoTotal: contatosSemDado.reduce((soma, item) => soma + item.total, 0),
            intervaloMs,
            canal: canalEscolhido,
            loteTemplate: canalEscolhido === 'template' ? Math.min(campanha.total, LOTE_TEMPLATE) : 1,
            templateNome: templateEscolhido ? templateEscolhido.nome : null,
            vendedorEmail: vendedor ? vendedor.email : null,
            vendedorNome: vendedor ? vendedor.nome : null
        });
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

// Troca o vendedor que recebe os leads da campanha (vale para os envios seguintes)
app.patch('/api/campanhas/:id/direcionar', exigirAdmin, async (req, res) => {
    const emailVendedor = String((req.body && req.body.vendedorEmail) || '').trim().toLowerCase();

    try {
        let vendedor = null;

        if (emailVendedor) {
            vendedor = await banco.buscarUsuarioPorEmail(emailVendedor);
            if (!vendedor || vendedor.ativo === false) {
                return res.status(400).json({ success: false, message: 'Vendedor não encontrado ou desativado.' });
            }
        }

        const alterou = await banco.direcionarCampanha(
            req.params.id,
            vendedor ? vendedor.email : null,
            vendedor ? vendedor.nome : null
        );

        if (!alterou) {
            return res.status(404).json({ success: false, message: 'Campanha não encontrada.' });
        }

        emitirEvento('campanha', { id: req.params.id, vendedor: vendedor ? vendedor.nome : null });
        await banco.registrarAuditoria(
            req.user && req.user.nome,
            'campanha direcionada',
            `${req.params.id} -> ${vendedor ? `${vendedor.nome} (${vendedor.email})` : 'sem direcionamento'}`
        );

        res.json({
            success: true,
            vendedorEmail: vendedor ? vendedor.email : null,
            vendedorNome: vendedor ? vendedor.nome : null
        });
    } catch (erro) {
        console.error('Erro ao direcionar campanha:', erro.message);
        res.status(500).json({ success: false, message: 'Erro ao direcionar a campanha.' });
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
// Tudo o que a Wati manda é gravado em eventos_wati e aparece no painel
// (Atividade Wati). Mensagens também alimentam as conversas e contatos
// criados/atualizados na Wati entram na base de clientes.
// ---------------------------------------------------------

/* A Wati usa um formato por tipo de evento e às vezes aninha os dados.
   Em vez de exigir um formato fixo, procuramos as chaves conhecidas em
   qualquer nível do JSON. */
function valorAninhado(origem, chaves, profundidade) {
    const nivel = profundidade || 0;
    if (!origem || typeof origem !== 'object' || nivel > 4) return null;

    for (const chave of chaves) {
        const valor = origem[chave];
        if (valor === undefined || valor === null) continue;
        if (typeof valor === 'object') continue;
        const texto = String(valor).trim();
        if (texto) return texto;
    }

    for (const valor of Object.values(origem)) {
        if (valor && typeof valor === 'object') {
            const achado = valorAninhado(valor, chaves, nivel + 1);
            if (achado) return achado;
        }
    }

    return null;
}

/* Igual ao anterior, mas devolve objetos (ex.: atributos do contato).
   Listas no formato [{ name, value }] viram um mapa simples. */
function objetoAninhado(origem, chaves, profundidade) {
    const nivel = profundidade || 0;
    if (!origem || typeof origem !== 'object' || nivel > 4) return null;

    for (const chave of chaves) {
        const valor = origem[chave];
        if (!valor || typeof valor !== 'object') continue;

        if (!Array.isArray(valor)) return valor;

        if (valor.length && typeof valor[0] === 'object') {
            const mapa = {};
            valor.forEach((item) => {
                if (item && item.name !== undefined) mapa[item.name] = item.value;
            });
            if (Object.keys(mapa).length) return mapa;
        }
    }

    for (const valor of Object.values(origem)) {
        if (valor && typeof valor === 'object') {
            const achado = objetoAninhado(valor, chaves, nivel + 1);
            if (achado) return achado;
        }
    }

    return null;
}

/* waId chega como "5511999999999", "5511999999999@c.us" ou número puro. */
function telefoneDoEvento(valor) {
    if (!valor) return null;
    const digitos = String(valor).split('@')[0].replace(/\D/g, '');
    return digitos.length >= 8 ? digitos.substring(0, 20) : null;
}

function atributosDoEvento(payload) {
    const bruto = objetoAninhado(payload, ['customParams', 'custom_params', 'attributes', 'atributos']);
    return bruto ? limparAtributos(bruto) : {};
}

/* A Wati mudou os nomes dos eventos (v1 -> v2, ex.: templateMessageSent_v2).
   Agrupamos tudo nos mesmos tipos para o painel e os filtros continuarem
   simples. */
const APELIDOS_EVENTO_WATI = {
    sessionmessagesent: 'sent',
    sessionmessagesent_v2: 'sent',
    templatemessagesent: 'sent',
    templatemessagesent_v2: 'sent',
    sentmessagedelivered: 'delivered',
    sentmessagedelivered_v2: 'delivered',
    sentmessageread: 'read',
    sentmessageread_v2: 'read',
    sentmessagereplied: 'replied',
    sentmessagereplied_v2: 'replied',
    sessionmessagefailed: 'failed',
    templatemessagefailed: 'failed',
    newcontactmessagereceived: 'contact_created',
    newcontactmessagereceived_v2: 'contact_created'
};

function normalizarTipoEventoWati(tipo) {
    const chave = String(tipo || '').toLowerCase();
    return APELIDOS_EVENTO_WATI[chave] || chave;
}

function interpretarEventoWati(payload) {
    const tipo = normalizarTipoEventoWati(
        valorAninhado(payload, ['eventType', 'event_type']) ||
        valorAninhado(payload, ['type']) ||
        'desconhecido'
    ).substring(0, 60);

    const dono = valorAninhado(payload, ['owner']);
    const status = valorAninhado(payload, ['statusString', 'status', 'messageStatus']);

    let texto = valorAninhado(payload, ['text', 'body', 'caption', 'messageText']);

    /* Quando a Wati recusa uma mensagem, o motivo vem no payload
       (failureReason, reason, errors[0].message...). Guardamos em `texto`
       para a tela "Atividade Wati" mostrar por que a campanha falhou. */
    if (!texto && /fail|erro|error/i.test(String(status || ''))) {
        texto = achatarErroWati(valorAninhado(payload, ['failureReason', 'failedReason', 'reason', 'error', 'errors']))
            || achatarErroWati(valorAninhado(payload, ['message']));
    }

    // Alguns payloads mandam o texto como objeto; o historico precisa de string.
    if (texto && typeof texto === 'object') texto = achatarErroWati(texto);

    return {
        tipo,
        telefone: telefoneDoEvento(valorAninhado(payload, ['waId', 'wa_id', 'phoneNumber', 'phone_number', 'telefone'])),
        nome: valorAninhado(payload, ['senderName', 'sender_name', 'fullName', 'full_name', 'name']),
        campanha: valorAninhado(payload, ['campaignName', 'campaign_name', 'campaignTitle', 'broadcastName', 'templateName']),
        texto,
        status,
        whatsappMessageId: valorAninhado(payload, ['whatsappMessageId', 'whatsapp_message_id', 'messageId', 'message_id']),
        atributos: atributosDoEvento(payload),
        enviadaPeloNegocio: String(dono).toLowerCase() === 'true'
    };
}
async function processarEventoWati(payload) {
    const evento = interpretarEventoWati(payload);

    const registro = await banco.registrarEventoWati({
        tipo: evento.tipo,
        telefone: evento.telefone,
        nome: evento.nome,
        campanha: evento.campanha,
        texto: evento.texto,
        status: evento.status,
        whatsappMessageId: evento.whatsappMessageId,
        payload
    });

    const ehMensagem = evento.tipo === 'message';
    const ehContato = evento.tipo === 'contact_created' || evento.tipo === 'contact_updated';

    if (ehMensagem && evento.telefone) {
        if (evento.enviadaPeloNegocio) {
            // Enviada pela Wati (caixa de atendimento ou campanha): entra no
            // histórico, mas não muda o nome/status do cliente.
            await banco.registrarContatoWati({ telefone: evento.telefone });

            if (evento.texto) {
                await banco.registrarMensagem(evento.telefone, 'enviada', evento.texto, { origem: 'wati' });
                await banco.atualizarUltimaMensagem(evento.telefone, evento.texto);
            }

            emitirEvento('mensagem', {
                telefone: evento.telefone,
                direcao: 'enviada',
                texto: evento.texto || '',
                nome: evento.nome || null
            });
        } else {
            const nome = evento.nome || 'Cliente Novo';
            const mensagem = evento.texto || '(mídia recebida)';

            // Se o cliente voltar a falar, o status volta para 'pensando' (reabre o atendimento)
            await banco.registrarRecebida({ nome, telefone: evento.telefone, mensagem });
            await banco.registrarMensagem(evento.telefone, 'recebida', mensagem, { origem: 'wati' });

            emitirEvento('mensagem', { telefone: evento.telefone, direcao: 'recebida', texto: mensagem, nome });
        }
    } else if (ehContato && evento.telefone) {
        // Contato criado/importado dentro da Wati também aparece no painel.
        await banco.registrarContatoWati({
            telefone: evento.telefone,
            nome: evento.nome,
            atributos: evento.atributos
        });
        emitirEvento('clientes', { telefone: evento.telefone });
    }

    console.log(
        `WATI (${evento.tipo}) ${evento.telefone || 'sem telefone'}` +
        (evento.campanha ? ` | campanha: ${evento.campanha}` : '') +
        (evento.texto ? ` | ${String(evento.texto).substring(0, 80)}` : '')
    );

    emitirEvento('wati', {
        id: registro && registro.id,
        tipo: evento.tipo,
        telefone: evento.telefone,
        campanha: evento.campanha
    });

    return registro;
}

app.post('/webhook', async (req, res) => {
    // Exige ?token=... (ou header x-webhook-secret) quando o token está ativo.
    const esperado = segredoWebhookEsperado();
    const recebido = req.query.token || req.get('x-webhook-secret') || '';

    if (esperado) {
        if (!segredoConfere(recebido, esperado)) {
            console.warn('Webhook recusado: segredo inválido.');
            return res.sendStatus(401);
        }
    } else if (webhookSecretBanco && segredoConfere(recebido, webhookSecretBanco)) {
        // A Wati já está chamando a URL nova: protege o webhook automaticamente.
        await ativarWebhookAutomaticamente();
    }

    // Alguns envios da Wati chegam como lista de eventos.
    const bruto = req.body;
    const eventos = Array.isArray(bruto) ? bruto : [bruto];
    let recebidos = 0;

    for (const payload of eventos) {
        if (!payload || typeof payload !== 'object') continue;
        recebidos++;

        try {
            await processarEventoWati(payload);
        } catch (erro) {
            // Um evento com problema não pode derrubar os outros.
            console.error('Erro ao processar evento da Wati:', erro.message);
        }
    }

    // Responder 200 sempre: fora do 2xx a Wati reenvia o mesmo evento várias vezes.
    res.json({ success: true, recebidos });
});

// ---------------------------------------------------------
// INICIALIZAÇÃO (banco -> segredo do JWT -> porta)
// ---------------------------------------------------------
async function iniciarServidor() {
    try {
        await banco.prepararBanco();
    } catch (erro) {
        console.error('Erro ao preparar o banco:', erro.message);
    }

    const segredo = await carregarSegredoJwt();
    JWT_SECRET = segredo.valor;
    jwtSegredoOrigem = segredo.origem;

    if (segredo.origem === 'env') {
        console.log('JWT_SECRET: usando a variável de ambiente.');
    } else if (segredo.origem === 'banco') {
        console.warn('JWT_SECRET: variável de ambiente ausente - usando o segredo persistido no banco.');
        console.warn('           Recomendado: defina JWT_SECRET no Render para manter o segredo fora do banco.');
    } else {
        console.warn('JWT_SECRET: variável ausente e banco indisponível - segredo temporário (sessões caem ao reiniciar).');
    }

    if (WEBHOOK_SECRET_ENV) {
        console.log('WEBHOOK: exigindo o token definido em WEBHOOK_SECRET (Render).');
    } else {
        const webhook = await carregarSegredoWebhook();
        webhookSecretBanco = webhook.secret;
        webhookSecretAtivo = webhook.ativo;
        webhookSecretOrigem = webhook.origem;

        if (webhook.origem === 'banco') {
            console.log('WEBHOOK: exigindo o token gerado no painel (Canais → Webhook seguro).');
        } else if (webhook.secret) {
            console.warn('WEBHOOK: segredo pronto, mas ainda não exigido.');
            console.warn('         Copie a URL em Canais → Webhook seguro para a Wati e ative a exigência.');
        } else {
            console.warn('WEBHOOK: sem segredo disponível - /webhook aceita qualquer origem.');
        }
    }

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

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}

if (require.main === module) {
    iniciarServidor().catch((erro) => {
        console.error('Falha ao iniciar o servidor:', erro.message);
        process.exitCode = 1;
    });
}

/* Helpers puros expostos para testes dos formatos de template da Wati. */
module.exports = {
    extrairVariaveisTemplate,
    normalizarTemplateWati,
    renderizarMensagemTemplate,
    valorDoContato,
    normalizarParametrosTemplate,
    rotuloBroadcastWati,
    deduplicarContatosPorTelefone,
    montarDestinatariosTemplate,
    corpoEnvioTemplateWati,
    avaliarEnvioTemplate
};


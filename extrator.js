#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Integração extratorgov.online no painel
   ---------------------------------------------------------
   Pilota o site https://extratorgov.online/ via Chrome/CDP:

     1. mantém UM Chrome vivo com a sessão logada (cliente1010);
     2. recebe CPFs do painel (POST /api/extrator/consultar);
     3. processa UM CPF POR VEZ (o site expira a sessão segundos
        depois de cada extração e o download de lote não é
        capturável por automação — testado em 7 rodadas);
     4. lê o resultado inline do painel:
           ✓ [LIVE] NOME | Mask: (11) *****7672 | Revelado: 11999667672
        (die = CPF processado sem telefone, não cobra);
     5. devolve CPF -> nome/telefone(s) para o painel.

   Custo no site: R$ 0,20 por LIVE; die não desconta.

   Uso CLI (teste):
     node extrator.js testar listas/teste-cpfs.txt
     node extrator.js status
     node extrator.js fechar
   ========================================================= */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const mapear = require('./mapear-tela');

const URL_SITE = process.env.EXTRATOR_URL || 'https://extratorgov.online/';
const PORTA = Number(process.env.CDP_PORT_EXT || 9224);
const PERFIL = path.join(os.tmpdir(), 'qgc-painel-extrator');
const TEMPO_ESPERA_PADRAO = 240; // segundos acompanhando cada extração
const MAX_CPFS = 25;              // por consulta do painel (sequencial: ~1 min/CPF)

/* ---------- estado global (singleton de navegador) ---------- */

const estado = {
    processo: null,
    cdp: null,
    ocupado: false,
    progresso: null, // { atual, total, cpf } durante uma consulta
    iniciando: null
};

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

/* Caminhos procurados quando CHROME_PATH não está definido.
   A lista de teste (opcional) existe para os testes automatizados. */
function acharNavegador(candidatos) {
    const lista = Array.isArray(candidatos) ? candidatos : [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        /* Linux — o container do Render não tem nenhum destes */
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        /* macOS */
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];

    return lista.filter(Boolean).find((caminho) => {
        try {
            return fs.existsSync(caminho);
        } catch (erro) {
            return false;
        }
    }) || '';
}

/* Por que a consulta automática não roda agora:
     ''              -> navegador conectado, pode consultar
     'chrome-fechado'-> navegador existe na máquina, janela ainda não aberta
     'sem-chrome'    -> nenhum navegador na máquina (caso do servidor/Render) */
function motivoIndisponivel(navegador, conectado) {
    if (conectado) return '';
    return navegador ? 'chrome-fechado' : 'sem-chrome';
}

function erroSemChrome() {
    const erro = new Error(
        'Chrome/Edge não encontrado nesta máquina. A consulta automática só roda onde existe ' +
        'navegador (defina CHROME_PATH) — no servidor use o script local "node extrator.js testar cpfs.txt".'
    );
    erro.codigo = 'sem-chrome';
    return erro;
}

async function esperarDevtools(tentativas) {
    const total = tentativas || 60;

    for (let i = 0; i < total; i += 1) {
        try {
            const resposta = await fetch(`http://127.0.0.1:${PORTA}/json/version`);
            if (resposta.ok) return await resposta.json();
        } catch (erro) { /* ainda subindo */ }

        await esperar(250);
    }

    throw new Error('O Chrome não abriu a porta de depuração ' + PORTA + '.');
}

async function acharPagina() {
    for (let i = 0; i < 40; i += 1) {
        try {
            const alvos = await (await fetch(`http://127.0.0.1:${PORTA}/json/list`)).json();
            const pagina = alvos.find((alvo) => alvo.type === 'page' && alvo.webSocketDebuggerUrl);
            if (pagina) return pagina;
        } catch (erro) { /* tenta de novo */ }

        await esperar(250);
    }

    throw new Error('Nenhuma aba aberta para conectar.');
}

function conectarCdp(urlWebsocket) {
    return new Promise((resolver, rejeitar) => {
        const socket = new WebSocket(urlWebsocket);
        const pendentes = new Map();
        let sequencia = 0;

        socket.addEventListener('error', () => rejeitar(new Error('Falha ao conectar no DevTools do Chrome.')));

        socket.addEventListener('open', () => {
            resolver({
                enviar(metodo, parametros) {
                    const id = ++sequencia;
                    return new Promise((ok, falhou) => {
                        /* Sem timeout, um alvo que some deixa a requisição pendurada
                           para sempre e o painel trava. 45s é folga para reruns do
                           Streamlit. */
                        const vigia = setTimeout(() => {
                            if (!pendentes.delete(id)) return;
                            console.error('[extrator] CDP sem resposta em ' + metodo + ' (45s).');
                            falhou(new Error('O navegador não respondeu ao comando ' + metodo + ' (timeout 45s).'));
                        }, 45000);

                        pendentes.set(id, {
                            ok: (valor) => { clearTimeout(vigia); ok(valor); },
                            falhou: (erro) => { clearTimeout(vigia); falhou(erro); }
                        });

                        if (process.env.DEBUG_EXTRATOR) console.log('[extrator][cdp]', metodo, JSON.stringify(parametros || {}).slice(0, 140));
                        socket.send(JSON.stringify({ id, method: metodo, params: parametros || {} }));
                    });
                },
                fechar() {
                    try {
                        socket.close();
                    } catch (erro) { /* já fechado */ }
                }
            });
        });

        socket.addEventListener('message', (evento) => {
            let mensagem;
            try {
                mensagem = JSON.parse(evento.data);
            } catch (erro) {
                return;
            }

            const pendente = mensagem.id && pendentes.get(mensagem.id);
            if (!pendente) return;
            pendentes.delete(mensagem.id);
            if (mensagem.error) pendente.falhou(new Error(mensagem.error.message));
            else pendente.ok(mensagem.result);
        });
    });
}

/* Confere se a conexão CDP ainda responde (ping curto). */
async function cdpVivo(cdp) {
    try {
        await Promise.race([
            cdp.enviar('Runtime.evaluate', { expression: '1', returnByValue: true }),
            new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('ping timeout')), 5000))
        ]);
        return true;
    } catch (erro) {
        return false;
    }
}

/* Sobe o Chrome dedicado do painel (porta/perfil próprios, para não
   brigar com mapear-tela.js / consultar-extrator.js). */
async function abrir() {
    if (estado.cdp && await cdpVivo(estado.cdp)) return estado.cdp;

    estado.cdp = null;
    if (estado.iniciando) return estado.iniciando;

    estado.iniciando = (async () => {
        const navegador = acharNavegador();
        if (!navegador) throw erroSemChrome();

        fs.mkdirSync(PERFIL, { recursive: true });

        console.log('[extrator] abrindo Chrome dedicado (' + PERFIL + ')');

        estado.processo = spawn(navegador, [
            '--remote-debugging-port=' + PORTA,
            '--user-data-dir=' + PERFIL,
            '--no-first-run',
            '--no-default-browser-check',
            '--window-size=1400,1000',
            URL_SITE
        ], { stdio: 'ignore' });

        estado.processo.on('exit', () => {
            /* O exit pode ser de um spawn redundante (Chrome já aberto com o
               mesmo perfil entrega o comando e sai). Não zeramos estado.cdp
               aqui: o próximo abrir() valida a conexão com o ping. */
            console.log('[extrator] Chrome (spawn) saiu; conexão será validada no próximo uso.');
            estado.processo = null;
        });

        await esperarDevtools();
        const pagina = await acharPagina();
        const cdp = await conectarCdp(pagina.webSocketDebuggerUrl);

        await cdp.enviar('Page.enable');
        await cdp.enviar('DOM.enable');

        estado.cdp = cdp;
        return cdp;
    })().finally(() => {
        estado.iniciando = null;
    });

    return estado.iniciando;
}

/* Garante página no site + sessão logada (faz login se o form aparecer). */
async function garantirSessao() {
    const cdp = await abrir();

    await cdp.enviar('Page.navigate', { url: URL_SITE });
    await esperar(3500);

    const estadoPagina = await mapear.esperarFormulario(cdp, 30);

    if (estadoPagina === 'carregando') {
        throw new Error('O site não carregou a tempo. Tente de novo em instantes.');
    }

    if (estadoPagina === 'login') {
        console.log('[extrator] formulário de login na tela; autenticando...');
        const entrou = await mapear.fazerLogin(cdp);

        if (!entrou) {
            throw new Error('Login no extratorgov.online recusado. Confira EXTRATOR_USUARIO/EXTRATOR_SENHA no .env.');
        }

        console.log('[extrator] login concluído.');
        await esperar(2500);
        await mapear.esperarEstabilizar(cdp);
    } else {
        console.log('[extrator] sessão já autenticada.');
    }

    return cdp;
}

/* ---------- conversa com a página ---------- */

const LER_TEXTO = 'document.body ? document.body.innerText : ""';

async function textoPagina(cdp) {
    return String(await mapear.avaliar(cdp, LER_TEXTO) || '').replace(/[ \t]+/g, ' ').trim();
}

/* Clica no primeiro botão cujo texto casa com o padrão (regex, sem case). */
async function clicarPorTexto(cdp, padrao) {
    return mapear.avaliar(cdp, '(() => {' +
        ' const regex = new RegExp(' + JSON.stringify(padrao) + ', "i");' +
        ' const alvo = Array.from(document.querySelectorAll("button")).find((b) => regex.test((b.innerText || "").trim()));' +
        ' if (!alvo || alvo.disabled) return false;' +
        ' alvo.click();' +
        ' return true;' +
        '})()');
}

const SELETOR_UPLOAD = 'input[data-testid="stFileUploaderDropzoneInput"]';

async function acharNodeDoUpload(cdp) {
    const documento = await cdp.enviar('DOM.getDocument', { depth: 0 });
    const achado = await cdp.enviar('DOM.querySelector', {
        nodeId: documento.root.nodeId,
        selector: SELETOR_UPLOAD
    });

    return achado && achado.nodeId ? achado.nodeId : 0;
}

async function esperarUploader(cdp, tentativas) {
    const total = tentativas || 40;

    for (let i = 0; i < total; i += 1) {
        if (await acharNodeDoUpload(cdp)) return true;
        await esperar(500);
    }

    return false;
}

/* ---------- parse do resultado ---------- */

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

/* Telefone BR para o formato Wati: 55 + DDD + número. */
function normalizarTelefoneWati(valor) {
    let digitos = apenasDigitos(valor);

    if (!digitos) return null;
    if (digitos.length === 13 && digitos.startsWith('55')) digitos = digitos.slice(2);
    if (digitos.length === 12 && digitos.startsWith('55')) digitos = digitos.slice(2);

    if (digitos.length === 10 || digitos.length === 11) return '55' + digitos;

    return null;
}

function formatarTelefone(dddNumero) {
    const digitos = apenasDigitos(dddNumero);

    if (digitos.length === 11) {
        return '(' + digitos.slice(0, 2) + ') ' + digitos.slice(2, 7) + '-' + digitos.slice(7);
    }
    if (digitos.length === 10) {
        return '(' + digitos.slice(0, 2) + ') ' + digitos.slice(2, 6) + '-' + digitos.slice(6);
    }

    return dddNumero;
}

/* LIVE lines do painel: "✓ [LIVE] NOME | Mask: (11) *****7672 | Revelado: 11999667672" */
function extrairLivesDoPainel(texto) {
    const lives = [];
    const padrao = /✓\s*\[LIVE\]\s*(.+?)\s*\|\s*Mask:\s*[^|]*\|\s*Revelado:\s*(\d{10,11})/g;
    let achado;

    while ((achado = padrao.exec(texto || '')) !== null) {
        const nome = achado[1].trim();
        const wati = normalizarTelefoneWati(achado[2]);
        if (!wati) continue;

        const chave = nome + '|' + wati;

        if (!lives.some((live) => live.chave === chave)) {
            lives.push({
                chave,
                nome,
                telefones: [{ numero: wati.slice(2), formatado: formatarTelefone(wati.slice(2)), wati }]
            });
        }
    }

    return lives;
}

/* ---------- fluxo de UMA extração ---------- */

const TERMOS_SEM_CREDITO = /saldo insuficiente|sem cr[eé]dito|cr[eé]ditos? insuficientes?|compre cr[eé]ditos|recarregue a conta|adquira cr[eé]ditos?/i;
const TERMOS_FIM = /processamento conclu[ií]d|extra[çc][aã]o da lista foi finalizada|conclu[ií]d[ao] com sucesso|finalizad/i;

async function acompanharAteResultado(cdp, limiteSegundos) {
    const inicio = Date.now();

    while (Date.now() - inicio < limiteSegundos * 1000) {
        const texto = await textoPagina(cdp);

        if (TERMOS_SEM_CREDITO.test(texto)) {
            return { estado: 'sem-credito', mensagem: 'O painel acusou saldo insuficiente. Recarregue a conta do extrator.' };
        }

        if (TERMOS_FIM.test(texto)) {
            const lives = extrairLivesDoPainel(texto);
            console.log('[extrator] processamento concluído; lives no painel: ' + lives.length);

            return { estado: 'ok', lives, textoPainel: texto.slice(0, 4000) };
        }

        await esperar(2500);
    }

    return { estado: 'tempo-esgotado', mensagem: 'A extração não terminou no tempo esperado.' };
}

/* Roda uma extração de UM CPF no painel e devolve a linha de resultado. */
async function executarConsultaUnico(cpf) {
    const cdp = await garantirSessao();

    await mapear.esperarEstabilizar(cdp);
    await esperar(1000);

    if (!await esperarUploader(cdp, 40)) {
        console.log('[extrator] uploader não apareceu; tentando o modo LISTA MANUAL...');
        await clicarPorTexto(cdp, 'lista manual');
        await mapear.esperarEstabilizar(cdp);
    }

    if (!await esperarUploader(cdp, 20)) {
        throw new Error('O campo "Selecionar lista de CPFs" não apareceu. O site mudou de layout?');
    }

    const temporario = path.join(os.tmpdir(), 'qgc-painel-extrator-' + Date.now() + '.txt');
    fs.writeFileSync(temporario, cpf + '\n', 'utf8');

    try {
        const nodeId = await acharNodeDoUpload(cdp);
        await cdp.enviar('DOM.setFileInputFiles', { nodeId, files: [temporario] });
        await mapear.esperarEstabilizar(cdp);
        await esperar(2000);

        const texto = await textoPagina(cdp);

        if (!/cpfs?\s+carregad/i.test(texto)) {
            throw new Error('O painel não confirmou o carregamento da lista.');
        }

        if (!await clicarPorTexto(cdp, 'iniciar\\s+extra')) {
            throw new Error('Botão "INICIAR EXTRAÇÃO" não encontrado (ou desabilitado).');
        }

        console.log('[extrator] extração iniciada para ' + cpf);

        const resultado = await acompanharAteResultado(cdp, TEMPO_ESPERA_PADRAO);

        if (resultado.estado === 'sem-credito') {
            const erro = new Error(resultado.mensagem);
            erro.estado = 'sem-credito';
            throw erro;
        }

        if (resultado.estado !== 'ok') {
            const erro = new Error(resultado.mensagem || 'Falha na extração.');
            erro.estado = resultado.estado;
            throw erro;
        }

        const lives = resultado.lives || [];

        if (lives.length) {
            return {
                cpf,
                status: 'ok',
                nome: lives[0].nome,
                telefones: lives[0].telefones
            };
        }

        /* nenhuma live: se o painel mostrou o fim de verdade, é "die"
           (CPF processado sem telefone) — resposta válida, não erro. */
        if (/LIVES CAPTURADAS|DIES \/ PROCESSADOS/i.test(resultado.textoPainel || '')) {
            return {
                cpf,
                status: 'nao_encontrado',
                telefones: [],
                message: 'CPF processado pelo extrator sem telefone (die).'
            };
        }

        const erro = new Error('A captura perdeu a janela de resultado do site. Tente de novo.');
        erro.estado = 'janela';
        throw erro;
    } finally {
        try {
            fs.unlinkSync(temporario);
        } catch (erro) { /* já foi */ }
    }
}

/* Executa com UMA nova tentativa quando a falha é de infraestrutura
   (Chrome/CDP) ou de janela de resultado — nunca repete erro de saldo. */
async function executarConsultaUnicoComRetry(cpf) {
    try {
        return await executarConsultaUnico(cpf);
    } catch (erro) {
        if (erro.estado === 'sem-credito') throw erro;

        const infra = /DevTools|Chrome|navegador|CDP|45s|conectar|janela/i.test(erro.message || '');

        if (!infra) throw erro;

        console.log('[extrator] falha de infraestrutura (' + erro.message + '); reiniciando o navegador e tentando de novo.');
        fechar();
        await esperar(3000);

        return executarConsultaUnico(cpf);
    }
}

/* ---------- API usada pelo index.js ---------- */

async function consultarCpfs(entradas) {
    const cpfs = [];

    (entradas || []).forEach((entrada) => {
        const digitos = apenasDigitos(entrada);
        if (digitos.length === 11 && !cpfs.includes(digitos)) cpfs.push(digitos);
    });

    if (!cpfs.length) {
        const erro = new Error('Nenhum CPF válido (11 dígitos) na solicitação.');
        erro.codigo = 400;
        throw erro;
    }
    if (cpfs.length > MAX_CPFS) {
        const erro = new Error('Máximo de ' + MAX_CPFS + ' CPFs por consulta (recebi ' + cpfs.length + '). Cada CPF leva cerca de 1 minuto.');
        erro.codigo = 400;
        throw erro;
    }

    if (estado.ocupado) {
        const erro = new Error('Já existe uma consulta do extrator em andamento. Aguarde terminar.');
        erro.codigo = 409;
        throw erro;
    }

    /* Sem navegador na máquina (ex.: container do Render) a consulta não tem
       como rodar: melhor recusar de uma vez do que devolver "sem retorno"
       para cada CPF e parecer que o CPF é que falhou. */
    if (!acharNavegador()) throw erroSemChrome();

    estado.ocupado = true;
    estado.progresso = { atual: 0, total: cpfs.length, cpf: '' };

    console.log('[extrator] consulta de ' + cpfs.length + ' CPF(s), um por vez.');

    try {
        const resultados = [];

        for (let i = 0; i < cpfs.length; i += 1) {
            const cpf = cpfs[i];
            estado.progresso = { atual: i, total: cpfs.length, cpf };

            console.log('[extrator] [' + (i + 1) + '/' + cpfs.length + '] ' + cpf);

            try {
                /* watchdog por CPF: 6 min no máximo */
                const linha = await Promise.race([
                    executarConsultaUnicoComRetry(cpf),
                    new Promise((_, rejeitar) => {
                        setTimeout(() => rejeitar(new Error('Tempo limite por CPF (6 min) atingido. Tente de novo.')), 6 * 60 * 1000);
                    })
                ]);

                resultados.push(linha);
            } catch (erro) {
                if (erro.estado === 'sem-credito') throw erro; // para o lote inteiro

                console.error('[extrator] falhou para ' + cpf + ': ' + erro.message);
                resultados.push({
                    cpf,
                    status: 'erro',
                    telefones: [],
                    message: erro.message
                });
            }
        }

        estado.progresso = { atual: cpfs.length, total: cpfs.length, cpf: '' };

        const resumo = {
            total: resultados.length,
            comTelefone: resultados.filter((linha) => linha.status === 'ok').length,
            semRetorno: resultados.filter((linha) => linha.status !== 'ok').length,
            via: 'painel do site (LIVE por CPF)'
        };

        return { success: true, resumo, resultados };
    } finally {
        estado.ocupado = false;
        estado.progresso = null;
    }
}

function status() {
    const navegador = acharNavegador();
    const conectado = Boolean(estado.processo && estado.cdp);

    return {
        chrome: conectado,
        navegador: Boolean(navegador),
        motivo: motivoIndisponivel(navegador, conectado),
        ocupado: estado.ocupado,
        progresso: estado.progresso,
        porta: PORTA
    };
}

function fechar() {
    if (estado.processo && estado.processo.pid) {
        spawnSync('taskkill', ['/PID', String(estado.processo.pid), '/T', '/F'], { stdio: 'ignore' });
    }

    estado.processo = null;
    estado.cdp = null;
    estado.ocupado = false;
    estado.progresso = null;
}

/* ---------- CLI de teste ---------- */

async function principal() {
    const comando = process.argv[2];
    const caminho = process.argv[3];

    if (comando === 'status') {
        console.log(JSON.stringify(status(), null, 2));
        return;
    }

    if (comando === 'fechar') {
        fechar();
        console.log('Chrome do extrator fechado.');
        return;
    }

    if (comando === 'testar' && caminho) {
        const cpfs = fs.readFileSync(caminho, 'utf8')
            .split(/\r?\n/)
            .map((linha) => apenasDigitos(linha))
            .filter((digitos) => digitos.length === 11);

        console.log('CPFs para teste: ' + cpfs.length);
        console.time('consulta');

        try {
            const resposta = await consultarCpfs(cpfs);
            console.log(JSON.stringify(resposta, null, 2));
        } catch (erro) {
            console.error('Falhou (' + erro.codigo + '): ' + erro.message);
        }

        console.timeEnd('consulta');
        return;
    }

    console.log([
        'Integração extratorgov.online no painel (QGC TEAM by JV).',
        '',
        'Uso:',
        '  node extrator.js testar <lista-cpfs.txt>   roda as consultas de verdade e mostra o JSON',
        '  node extrator.js status                    estado do Chrome/sessão',
        '  node extrator.js fechar                    fecha o Chrome dedicado',
        '',
        'No painel, o endpoint é POST /api/extrator/consultar { cpfs: [...] } (um CPF por vez).'
    ].join('\n'));
}

module.exports = { consultarCpfs, status, fechar, acharNavegador, motivoIndisponivel };

if (require.main === module) {
    principal().catch((erro) => {
        console.error('Erro: ' + erro.message);
        process.exitCode = 1;
    });
}

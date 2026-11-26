'use strict';
/* E2E visual do painel SpyHub (modo demo):
   Chrome próprio (CDP 9230) -> login admin -> Contatos -> SpyHub ->
   cola CSV -> Executar Verificação -> log/tabela -> exportações.

   Pré-requisito: painel em modo demo na porta 3100 (banco em memória, sem
   Wati). No PowerShell:

     $env:MODO_DEMO='1'; $env:WATI_TOKEN=''; $env:WATI_NUMERO=''
     $env:PORT='3100'; $env:JWT_SECRET='e2e-local-demo-2026'; node index.js

   Em outro terminal:
     node e2e-painel-visual.js

   Custo: 1 consulta real no SpyHub (o job roda no servidor do painel).
   Screenshots em diagnostico/ (fora do git).
*/

process.env.EXTRATOR_HEADLESS = '1';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const navegador = require('./navegador');
const parser = require('./spyhub-parser');

const PROJ = __dirname;
const BASE = 'http://127.0.0.1:3100';
const PORTA = 9230;
const PERFIL = path.join(os.tmpdir(), 'qgc-e2e-painel');
const EVIDENCIA = path.join(PROJ, 'diagnostico');
const CSV = fs.readFileSync(path.join(PROJ, 'listas', 'spyhub-aprovado.csv'), 'utf8');
const REGISTRO = parser.parseEntrada(CSV).registros[0];
const LIMITE_JOB_MS = 180000;

if (!REGISTRO) {
    console.error('CSV de teste sem registro válido.');
    process.exit(1);
}

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

async function esperarDevtools() {
    for (let i = 0; i < 80; i += 1) {
        try {
            const resposta = await fetch('http://127.0.0.1:' + PORTA + '/json/version');
            if (resposta.ok) return true;
        } catch (falha) { /* subindo */ }
        await esperar(250);
    }
    throw new Error('Chrome do E2E não abriu a porta CDP ' + PORTA);
}

async function acharPagina() {
    for (let i = 0; i < 40; i += 1) {
        try {
            const alvos = await (await fetch('http://127.0.0.1:' + PORTA + '/json/list')).json();
            const pagina = alvos.find((alvo) => alvo.type === 'page' && alvo.webSocketDebuggerUrl);
            if (pagina) return pagina;
        } catch (falha) { /* tenta de novo */ }
        await esperar(250);
    }
    throw new Error('Nenhuma aba do E2E para conectar.');
}

function conectarCdp(urlWebsocket) {
    return new Promise((resolver, rejeitar) => {
        const socket = new WebSocket(urlWebsocket);
        const pendentes = new Map();
        let sequencia = 0;

        socket.addEventListener('error', () => rejeitar(new Error('Falha ao conectar no DevTools do E2E.')));

        socket.addEventListener('open', () => {
            resolver({
                enviar(metodo, parametros) {
                    const id = ++sequencia;

                    return new Promise((ok, falhou) => {
                        const vigia = setTimeout(() => {
                            if (pendentes.delete(id)) falhou(new Error('timeout CDP: ' + metodo));
                        }, 45000);

                        pendentes.set(id, {
                            ok: (valor) => { clearTimeout(vigia); ok(valor); },
                            falhou: (falha) => { clearTimeout(vigia); falhou(falha); }
                        });
                        socket.send(JSON.stringify({ id, method: metodo, params: parametros || {} }));
                    });
                },
                fechar() {
                    try { socket.close(); } catch (falha) { /* já fechado */ }
                }
            });
        });

        socket.addEventListener('message', (evento) => {
            let mensagem;
            try { mensagem = JSON.parse(evento.data); } catch (falha) { return; }
            const pendente = mensagem.id && pendentes.get(mensagem.id);
            if (!pendente) return;
            pendentes.delete(mensagem.id);
            if (mensagem.error) pendente.falhou(new Error(mensagem.error.message));
            else pendente.ok(mensagem.result);
        });
    });
}

async function avaliar(cdp, expressao, awaitPromise) {
    const resposta = await cdp.enviar('Runtime.evaluate', {
        expression: expressao,
        returnByValue: true,
        awaitPromise: Boolean(awaitPromise)
    });

    if (resposta.exceptionDetails) {
        throw new Error(resposta.exceptionDetails.text || 'erro ao avaliar na página');
    }

    return resposta.result ? resposta.result.value : undefined;
}

async function esperarPor(cdp, expressao, limiteMs, passo) {
    const inicio = Date.now();
    while (Date.now() - inicio < limiteMs) {
        try {
            if (await avaliar(cdp, expressao)) return true;
        } catch (falha) { /* página trocando */ }
        await esperar(passo || 300);
    }
    return false;
}

async function foto(cdp, nome, alvo) {
    if (alvo) {
        await avaliar(cdp, 'document.querySelector(' + JSON.stringify(alvo) + ').scrollIntoView({block:"start"})');
        await esperar(400);
    }

    const resultado = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
    const arquivo = path.join(EVIDENCIA, nome);
    fs.writeFileSync(arquivo, Buffer.from(resultado.data, 'base64'));
    console.log('Screenshot: ' + arquivo);
}

(async () => {
    const binario = navegador.acharNavegador();
    if (!binario) {
        console.error('Chrome/Edge não encontrado.');
        process.exit(1);
    }

    fs.mkdirSync(PERFIL, { recursive: true });
    fs.mkdirSync(EVIDENCIA, { recursive: true });

    const processo = spawn(binario, navegador.flagsNavegador({
        porta: PORTA,
        perfil: PERFIL,
        url: BASE + '/login'
    }), { stdio: 'ignore' });

    let cdp = null;
    let falhou = false;

    try {
        console.log('Chrome do E2E subindo (CDP ' + PORTA + ')...');
        await esperarDevtools();
        const pagina = await acharPagina();
        cdp = await conectarCdp(pagina.webSocketDebuggerUrl);
        await cdp.enviar('Page.enable');
        await cdp.enviar('Runtime.enable');
        await esperarPor(cdp, 'document.readyState === "complete"', 15000);

        /* 1. login */
        console.log('Tela de login: ' + await avaliar(cdp, 'document.title'));
        const envioLogin = await avaliar(cdp, `(() => {
            const email = document.getElementById('email');
            const senha = document.getElementById('senha');
            if (!email || !senha) return 'sem-formulario';
            email.value = 'admin@qgcteam.com';
            senha.value = '123456';
            document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
            return 'enviado';
        })()`);

        if (envioLogin !== 'enviado') throw new Error('Formulário de login não encontrado');

        const logado = await esperarPor(cdp,
            'location.pathname !== "/login" && Boolean(document.querySelector(\'[data-view="spyhub"]\'))', 20000, 400);
        if (!logado) throw new Error('Login não concluiu (continuou em ' + await avaliar(cdp, 'location.href') + ')');
        console.log('Login OK: ' + await avaliar(cdp, 'location.pathname'));

        /* 2. aba Contatos -> Verificação SpyHub */
        await avaliar(cdp, 'document.querySelector(\'[data-view="spyhub"]\').click()');
        const telaAberta = await esperarPor(cdp,
            '!document.getElementById("view-spyhub").classList.contains("oculto")', 8000, 250);
        if (!telaAberta) throw new Error('A tela Verificação SpyHub não abriu');

        await esperar(800); /* status() inicial preenche o aviso */
        const statusTela = await avaliar(cdp, 'document.getElementById("spyhub-status").textContent');
        console.log('Status na tela: ' + statusTela);

        /* 3. cola o CSV e executa pela tela */
        await avaliar(cdp, `(() => {
            const caixa = document.getElementById('spyhub-texto');
            caixa.value = ${JSON.stringify(CSV)};
            caixa.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);

        console.log('Disparando "Executar Verificação" (job no servidor do painel)...');
        await avaliar(cdp, 'executarVerificacaoSpyhub()', true);

        /* 4. acompanha log/progresso até concluir */
        const inicio = Date.now();
        let estado = null;
        let linhasVistas = 0;

        while (Date.now() - inicio < LIMITE_JOB_MS) {
            await esperar(1500);

            estado = await avaliar(cdp, `(() => {
                let job = null;
                try { job = (typeof spyhubJob === 'undefined') ? null : spyhubJob; } catch (falha) { job = null; }
                const progresso = document.getElementById('spyhub-progresso');
                const log = document.getElementById('spyhub-log');
                const tabela = document.getElementById('tabela-spyhub-aprovados');
                return {
                    status: job ? job.status : null,
                    feitos: job ? job.feitos : null,
                    total: job ? job.total : null,
                    aprovados: job ? (job.aprovados || []).length : null,
                    reprovados: job ? (job.reprovados || []).length : null,
                    erro: job ? job.erro : '',
                    progressoTexto: progresso ? progresso.textContent : '',
                    logTexto: log ? log.innerText : '',
                    tabelaTexto: tabela ? tabela.innerText : ''
                };
            })()`);

            const linhas = String(estado.logTexto || '').split('\n').filter(Boolean);
            linhas.slice(linhasVistas).forEach((linha) => console.log('  ' + linha));
            linhasVistas = linhas.length;

            if (estado.status && estado.status !== 'rodando') break;
            if (!estado.status && /conclu[ií]do/i.test(estado.progressoTexto)) break;
        }

        console.log('Estado final: ' + JSON.stringify({
            status: estado.status,
            feitos: estado.feitos,
            total: estado.total,
            aprovados: estado.aprovados,
            reprovados: estado.reprovados,
            progressoTexto: estado.progressoTexto,
            erro: estado.erro
        }));

        if (estado.status !== 'concluido') {
            throw new Error('job não concluiu pela tela (status ' + estado.status + ', erro ' + estado.erro + ')');
        }
        if (estado.aprovados !== 1 || estado.reprovados !== 0) {
            throw new Error('esperado 1 aprovado/0 reprovado, veio ' + estado.aprovados + '/' + estado.reprovados);
        }
        if (!String(estado.logTexto).includes('APROVADO')) throw new Error('log da tela sem linha APROVADO');
        if (!String(estado.tabelaTexto).includes(REGISTRO.cpfFormatado)) throw new Error('tabela sem o CPF aprovado');
        if (!String(estado.tabelaTexto).includes(REGISTRO.finais[0])) throw new Error('tabela sem o final esperado');

        /* 5. exportações pela rota, com o cookie da sessão da tela */
        const downloads = await avaliar(cdp, `(async () => {
            const id = encodeURIComponent(spyhubJob.id);
            const csv = await fetch('/api/spyhub/jobs/' + id + '/aprovados.csv');
            const bytes = new Uint8Array(await csv.arrayBuffer());
            const texto = new TextDecoder('utf-8').decode(bytes);
            const txt = await fetch('/api/spyhub/jobs/' + id + '/reprovados.txt');
            const txtTexto = await txt.text();
            return {
                csvStatus: csv.status,
                csvBom: bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF,
                csvLinhas: texto.trim().split(/\\r?\\n/).length,
                csvTemCpf: texto.indexOf(${JSON.stringify(REGISTRO.cpfFormatado)}) !== -1,
                txtStatus: txt.status,
                txtBytes: txtTexto.length
            };
        })()`, true);

        console.log('Exportações: ' + JSON.stringify(downloads));
        if (downloads.csvStatus !== 200 || !downloads.csvBom || !downloads.csvTemCpf) {
            throw new Error('CSV de aprovados inválido na exportação da tela');
        }
        if (downloads.txtStatus !== 200) throw new Error('TXT de reprovados não respondeu 200');

        /* 6. clica nos botões de exportar e confere o toast */
        await avaliar(cdp, '(() => { baixarSpyhubAprovados(); baixarSpyhubReprovados(); return true; })()');
        await esperar(2500);
        const toasts = await avaliar(cdp,
            '(() => { const c = document.getElementById("toast-container"); return c ? c.innerText : ""; })()');
        console.log('Toasts: ' + JSON.stringify(toasts));
        if (!String(toasts).includes('Exportação gerada')) throw new Error('botões de exportar não confirmaram');

        /* 7. evidências visuais */
        await foto(cdp, 'painel-spyhub-log.png', '#spyhub-resumo');
        await foto(cdp, 'painel-spyhub-tabela.png', '#tabela-spyhub-aprovados');

        console.log('E2E VISUAL OK: login -> Contatos -> SpyHub -> job -> tabela -> exportações.');
    } catch (falha) {
        falhou = true;
        console.error('E2E VISUAL FALHOU: ' + falha.message);
        try { await foto(cdp, 'painel-spyhub-erro.png', null); } catch (erro) { /* sem screenshot */ }
    } finally {
        try { if (cdp) cdp.fechar(); } catch (falha) { /* já fechado */ }
        navegador.encerrarProcesso(processo.pid);
        setTimeout(() => process.exit(falhou ? 1 : 0), 500);
    }
})();

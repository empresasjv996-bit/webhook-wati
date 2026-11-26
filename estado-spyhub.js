#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Estado do motor SpyHub
   ---------------------------------------------------------
   Lê os documentos do projeto (CONTINUAR.md / SPYHUB.md) e
   mostra, em um comando, onde o trabalho parou:

     node estado-spyhub.js            estado + próximos passos
     node estado-spyhub.js --diag     + sonda ao vivo no Chrome (CDP 9226)
     node estado-spyhub.js --ir       navega o Chrome para a busca e sonda
     node estado-spyhub.js --json     saída JSON (para colar em outro chat)

   Não altera nada: só lê arquivos, roda "node --check", consulta
   o git e (com --diag) conversa com o Chrome já aberto.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RAIZ = path.join(__dirname);
const DOC_PRINCIPAL = 'CONTINUAR.md';
const DOC_FUNCIONAL = 'SPYHUB.md';

const ARQUIVOS_MOTOR = [
    'spyhub.js',
    'spyhub-parser.js',
    path.join('routes', 'contatos-spyhub.js'),
    'test-spyhub-parser.js',
    'index.js',
    'app.js',
    'index.html',
    'style.css',
    '.env.exemplo'
];

const CODIGOS_PARA_CHECAR = [
    'spyhub.js',
    'spyhub-parser.js',
    path.join('routes', 'contatos-spyhub.js'),
    'test-spyhub-parser.js'
];

const VARIAVEIS_OBRIGATORIAS = ['SPYHUB_USUARIO', 'SPYHUB_SENHA'];
const ARTEFATOS = ['aprovados-spyhub.csv', 'reprovados-spyhub.txt'];

const PORTA_CDP = Number(process.env.CDP_PORT_SPYHUB || 9226);
const URL_BUSCA = process.env.SPYHUB_BUSCA_URL || 'https://app.spyhub.io/search/avancada';

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

const marcadores = {
    ok: '[ok]',
    falta: '[--]',
    erro: '[!!]'
};

function linha(rotulo, valor) {
    console.log('  ' + rotulo + ' ' + valor);
}

function lerArquivo(relativo) {
    const caminho = path.join(RAIZ, relativo);
    if (!fs.existsSync(caminho)) return null;
    return fs.readFileSync(caminho, 'utf8');
}

function lerEnv() {
    const texto = lerArquivo('.env');
    const valores = {};

    if (!texto) return valores;

    texto.split(/\r?\n/).forEach((linhaEnv) => {
        const achado = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linhaEnv);
        if (!achado) return;
        let valor = achado[2].trim();
        if (/^(".*"|'.*')$/.test(valor)) valor = valor.slice(1, -1);
        valores[achado[1]] = valor;
    });

    return valores;
}

function secoes(markdown) {
    return String(markdown || '')
        .split(/\r?\n/)
        .filter((linhaMd) => /^#{1,3}\s+/.test(linhaMd))
        .map((linhaMd) => linhaMd.replace(/^#{1,3}\s+/, '').trim());
}

function proximosPassos(markdown) {
    const linhas = String(markdown || '').split(/\r?\n/);
    const inicio = linhas.findIndex((linhaMd) => /^##\s+.*pr[oó]ximos passos/i.test(linhaMd));

    if (inicio === -1) return [];

    return linhas
        .slice(inicio + 1)
        .filter((linhaMd) => /^###\s+/.test(linhaMd))
        .map((linhaMd) => linhaMd.replace(/^###\s+/, '').trim());
}

function rodar(comando, argumentos) {
    const resultado = spawnSync(comando, argumentos, { cwd: RAIZ, encoding: 'utf8' });
    return {
        ok: resultado.status === 0,
        saida: String((resultado.stdout || '') + (resultado.stderr || '')).trim()
    };
}

function checarSintaxe(relativo) {
    const caminho = path.join(RAIZ, relativo);
    if (!fs.existsSync(caminho)) return { ok: false, motivo: 'arquivo ausente' };

    const resultado = rodar(process.execPath, ['--check', caminho]);
    return { ok: resultado.ok, motivo: resultado.ok ? '' : resultado.saida.split(/\r?\n/)[0] };
}

function medirArtefato(relativo) {
    const caminho = path.join(RAIZ, relativo);
    if (!fs.existsSync(caminho)) return null;

    const info = fs.statSync(caminho);
    const linhas = fs.readFileSync(caminho, 'utf8').split(/\r?\n/).filter((texto) => texto.trim()).length;

    return {
        bytes: info.size,
        linhas,
        atualizado: info.mtime.toISOString().slice(0, 16).replace('T', ' ')
    };
}

function resumoGit() {
    const branch = rodar('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = rodar('git', ['status', '--porcelain']);
    const ultimo = rodar('git', ['log', '-1', '--pretty=%h %s']);

    const linhasStatus = status.saida ? status.saida.split(/\r?\n/).filter(Boolean) : [];
    const alterados = linhasStatus.filter((item) => !item.startsWith('??')).length;
    const novos = linhasStatus.filter((item) => item.startsWith('??')).length;

    return {
        branch: branch.ok ? branch.saida : '?',
        alterados,
        novos,
        ultimo: ultimo.ok ? ultimo.saida : '?'
    };
}

const EXPRESSAO_SONDA = [
    '(() => {',
    ' const visivel = (el) => {',
    '   if (!el) return false;',
    '   const caixa = el.getBoundingClientRect();',
    '   return caixa.width > 0 && caixa.height > 0;',
    ' };',
    ' const detalhe = (el) => ({',
    '   seletor: el.id ? ("#" + el.id) : (el.getAttribute("name") ? ("[name=\\"" + el.getAttribute("name") + "\\"]") : el.tagName.toLowerCase()),',
    '   tipo: String(el.type || el.tagName).toLowerCase(),',
    '   placeholder: String(el.getAttribute("placeholder") || "").slice(0, 40),',
    '   maxlength: el.getAttribute("maxlength") || "",',
    '   dentroAbaCpf: Boolean(el.closest("#tab_cpf")),',
    '   tamanho: Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height)',
    ' });',
    ' const abas = Array.from(document.querySelectorAll(".nav-tab")).map((el) => ({',
    '   texto: String(el.innerText || "").trim().slice(0, 20),',
    '   ativa: /active/.test(String(el.className))',
    ' }));',
    ' const abaCpf = document.querySelector("#li_module_cpf a");',
    ' const campoCpf = document.querySelector(\'#tab_cpf input[name="cpf"]\');',
    ' const botoes = Array.from(document.querySelectorAll("button, input[type=submit], a"));',
    ' const botao = botoes.find((el) => visivel(el) && /consultar/i.test(String(el.innerText || el.value || "").trim()));',
    ' const inputs = Array.from(document.querySelectorAll("input, textarea, [contenteditable=true]"))',
    '   .filter(visivel).slice(0, 8).map(detalhe);',
    ' return {',
    '   url: location.href,',
    '   titulo: document.title,',
    '   pronto: document.readyState,',
    '   senhaVisivel: Boolean(document.querySelector(\'input[type="password"]\')),',
    '   abas,',
    '   temAbaCpf: Boolean(abaCpf),',
    '   abaCpfVisivel: visivel(abaCpf),',
    '   temPainelCpf: Boolean(document.querySelector("#tab_cpf")),',
    '   campoCpfVisivel: visivel(campoCpf),',
    '   botaoConsultar: botao ? String(botao.innerText || botao.value || "").trim().slice(0, 20) : "",',
    '   botaoVisivel: visivel(botao),',
    '   inputs,',
    '   texto: String(document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 220)',
    ' };',
    '})()'
].join('\n');

function abrirSocket(endereco) {
    return new Promise((ok, falhar) => {
        const socket = new WebSocket(endereco);

        socket.addEventListener('open', () => ok(socket));
        socket.addEventListener('error', () => falhar(new Error('falha ao abrir o WebSocket do DevTools')));
    });
}

async function sondaPagina(navegarPara) {
    let alvos;

    try {
        const resposta = await fetch('http://127.0.0.1:' + PORTA_CDP + '/json/list');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
        alvos = await resposta.json();
    } catch (falha) {
        return { conectado: false, motivo: 'Chrome do SpyHub não está na porta ' + PORTA_CDP + ' (abra com: node spyhub.js testar <arquivo>)' };
    }

    const pagina = Array.isArray(alvos) ? alvos.find((alvo) => alvo.type === 'page' && alvo.webSocketDebuggerUrl) : null;
    if (!pagina) return { conectado: false, motivo: 'Nenhuma aba de página disponível no Chrome' };

    if (typeof WebSocket === 'undefined') {
        return { conectado: false, motivo: 'Este Node não tem WebSocket global (use Node 22+)' };
    }

    let socket;
    try {
        socket = await abrirSocket(pagina.webSocketDebuggerUrl);
    } catch (falha) {
        return { conectado: false, motivo: falha.message };
    }

    try {
        if (navegarPara) {
            /* só com --ir: o motor faria a mesma navegação antes de cada CPF */
            socket.send(JSON.stringify({ id: 100, method: 'Page.navigate', params: { url: navegarPara } }));
            await esperar(3000);
        }

        const dados = await new Promise((ok, falhar) => {
            const limite = setTimeout(() => falhar(new Error('sem resposta do DevTools em 10s')), 10000);

            socket.addEventListener('message', (evento) => {
                const mensagem = JSON.parse(evento.data);
                if (mensagem.id !== 1) return;
                clearTimeout(limite);

                if (mensagem.error) falhar(new Error(mensagem.error.message));
                else if (mensagem.result && mensagem.result.exceptionDetails) falhar(new Error('erro na página'));
                else ok(mensagem.result && mensagem.result.result ? mensagem.result.result.value : null);
            });

            socket.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: EXPRESSAO_SONDA, returnByValue: true }
            }));
        });

        return Object.assign({ conectado: true }, dados || {});
    } catch (falha) {
        return { conectado: false, motivo: falha.message };
    } finally {
        try { socket.close(); } catch (falha) { /* já fechado */ }
    }
}

/* Traduz a sonda em uma frase acionável (o "porquê" do bloqueio). */
function diagnosticar(sonda) {
    if (!sonda.conectado) return sonda.motivo;
    if (sonda.senhaVisivel) return 'A sessão caiu (formulário de senha na tela). Faça login na janela do Chrome e rode de novo.';

    if (!/\/search\/(pessoa-fisica|avancada|tracker|cpf-top)/.test(String(sonda.url || ''))) {
        return 'A aba atual não é a busca de pessoa física (' + sonda.url + ').'
            + ' O motor navega sozinho antes de cada CPF; para inspecionar o formulário, rode'
            + ' "node spyhub.js testar <arquivo>" e repita o --diag durante a consulta.';
    }

    if (!sonda.temAbaCpf) return 'A tela de pessoa física ainda não montou (sem #li_module_cpf em ' + sonda.url + '). �? timing: esperar o seletor antes de marcar o campo.';
    if (!sonda.abaCpfVisivel) return 'A aba CPF existe mas não está visível (menu/aba recolhida). Conferir a classe do item da aba.';
    if (!sonda.campoCpfVisivel) return 'O campo #tab_cpf input[name="cpf"] só aparece com a aba CPF ativa (o motor clica em #li_module_cpf antes de digitar). Estado normal antes da consulta.';
    if (!sonda.botaoVisivel) return 'Campo do CPF visível, mas nenhum botão CONSULTAR visível no painel.';
    return 'DOM ok (aba, campo e botão visíveis): o problema está no timing de prepararBusca; ver Passo 1 do CONTINUAR.md.';
}

function coletarBase() {
    const base = {
        geradoEm: new Date().toISOString(),
        documentos: [],
        arquivos: [],
        sintaxe: [],
        ambiente: [],
        git: resumoGit(),
        artefatos: [],
        passos: []
    };

    [DOC_PRINCIPAL, DOC_FUNCIONAL].forEach((nome) => {
        const texto = lerArquivo(nome);

        base.documentos.push({
            arquivo: nome,
            existe: Boolean(texto),
            secoes: texto ? secoes(texto).length : 0
        });

        if (nome === DOC_PRINCIPAL && texto) base.passos = proximosPassos(texto);
    });

    ARQUIVOS_MOTOR.forEach((nome) => {
        base.arquivos.push({ arquivo: nome, existe: fs.existsSync(path.join(RAIZ, nome)) });
    });

    CODIGOS_PARA_CHECAR.forEach((nome) => {
        base.sintaxe.push(Object.assign({ arquivo: nome }, checarSintaxe(nome)));
    });

    const env = lerEnv();
    const exemplo = lerArquivo('.env.exemplo') || '';
    const documentadas = (exemplo.match(/^\s*(SPYHUB_[A-Z0-9_]+)/gm) || []).map((linhaEnv) => linhaEnv.trim());
    const exigidas = VARIAVEIS_OBRIGATORIAS.slice();

    documentadas.forEach((nome) => {
        if (exigidas.indexOf(nome) === -1) exigidas.push(nome);
    });

    exigidas.forEach((nome) => {
        const valor = process.env[nome] || env[nome] || '';

        base.ambiente.push({
            variavel: nome,
            definida: Boolean(valor),
            tamanho: String(valor).length,
            mascarada: /SENHA|TOKEN|SECRET/i.test(nome)
        });
    });

    ARTEFATOS.forEach((nome) => {
        const info = medirArtefato(nome);
        if (info) base.artefatos.push(Object.assign({ arquivo: nome }, info));
    });

    return base;
}

function imprimir(base, sonda) {
    console.log('=== QGC TEAM by JV - Motor SpyHub - estado ===');
    console.log('Pasta: ' + RAIZ);
    console.log('');

    console.log('Documentos');
    base.documentos.forEach((documento) => {
        const marca = documento.existe ? marcadores.ok : marcadores.falta;
        const detalhe = documento.existe ? documento.secoes + ' seção(ões)' : 'ausente';
        linha(marca, documento.arquivo + ' (' + detalhe + ')');
    });
    console.log('');

    console.log('Arquivos do motor');
    base.arquivos.forEach((arquivo) => {
        linha(arquivo.existe ? marcadores.ok : marcadores.falta, arquivo.arquivo);
    });
    console.log('');

    console.log('Sintaxe (node --check)');
    base.sintaxe.forEach((checagem) => {
        linha(checagem.ok ? marcadores.ok : marcadores.erro, checagem.arquivo + (checagem.ok ? '' : ' -> ' + checagem.motivo));
    });
    console.log('');

    console.log('Ambiente (.env / variáveis do processo)');
    base.ambiente.forEach((variavel) => {
        const detalhe = variavel.definida
            ? 'definida (' + (variavel.mascarada ? 'valor mascarado' : variavel.tamanho + ' chars') + ')'
            : 'AUSENTE (ver .env.exemplo)';
        linha(variavel.definida ? marcadores.ok : marcadores.falta, variavel.variavel + ' -> ' + detalhe);
    });
    console.log('');

    console.log('Git');
    linha(marcadores.ok, 'branch ' + base.git.branch + ' | alterados: ' + base.git.alterados + ' | novos: ' + base.git.novos);
    linha('   ', 'último commit: ' + base.git.ultimo);
    console.log('');

    console.log('�sltimas exportações geradas');
    if (!base.artefatos.length) linha(marcadores.falta, 'nenhuma (a última execução não chegou ao fim)');
    base.artefatos.forEach((artefato) => {
        linha(marcadores.ok, artefato.arquivo + ' (' + artefato.bytes + ' bytes, ' + artefato.linhas + ' linha(s), ' + artefato.atualizado + ')');
    });
    console.log('');

    if (sonda) {
        console.log('Sonda ao vivo (CDP ' + PORTA_CDP + ')');
        console.log(JSON.stringify(sonda, null, 2).split('\n').map((linhaSonda) => '  ' + linhaSonda).join('\n'));
        console.log('');
        console.log('Diagnóstico: ' + diagnosticar(sonda));
        console.log('');
    }

    console.log('Próximos passos (de ' + DOC_PRINCIPAL + ')');
    if (!base.passos.length) linha(marcadores.falta, 'seção "Próximos passos" não encontrada no documento');
    base.passos.forEach((passo, indice) => linha(String(indice + 1) + '.', passo));
    console.log('');

    console.log('Comandos úteis');
    linha('$', 'spyhub-cmd.bat <arquivo>             (atalho CMD: arrasta-e-solta, fixa o cwd)');
    linha('$', 'node estado-spyhub.js --diag          (estado + sonda no Chrome)');
    linha('$', 'node estado-spyhub.js --ir            (navega para a busca e sonda)');
    linha('$', 'node spyhub.js status                 (Chrome/sessão/credenciais)');
    linha('$', 'node spyhub.js testar <arquivo>       (verificação real, gera CSV/TXT)');
    linha('$', 'node spyhub.js analisar <arquivo>     (só o parser)');
    linha('$', 'node test-spyhub-parser.js            (testes do SpyHub)');
    linha('$', 'npm test                              (suíte completa)');
}

async function principal() {
    const argumentos = process.argv.slice(2);
    const querJson = argumentos.indexOf('--json') !== -1;
    const querDiag = argumentos.indexOf('--diag') !== -1;
    const querIr = argumentos.indexOf('--ir') !== -1;

    const base = coletarBase();
    let sonda = null;

    if (querDiag || querIr) sonda = await sondaPagina(querIr ? URL_BUSCA : null);

    if (querJson) {
        console.log(JSON.stringify(Object.assign({}, base, {
            sonda,
            diagnostico: sonda ? diagnosticar(sonda) : null
        }), null, 2));
        return;
    }

    imprimir(base, sonda);
}

principal().catch((falha) => {
    console.error('Erro ao montar o estado: ' + falha.message);
    process.exitCode = 1;
});



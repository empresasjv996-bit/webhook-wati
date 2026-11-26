#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Motor de Verificação SpyHub
   ---------------------------------------------------------
   Pilota https://app.spyhub.io via Chrome/CDP (mesmo esquema
   do extrator.js, sem puppeteer):

     1. abre UM Chrome dedicado (porta/perfil próprios) e faz
        login com SPYHUB_USUARIO / SPYHUB_SENHA;
     2. para cada registro do parser (CPF + 4 finais), entra no
        módulo de consulta (tracker -> cpf-top -> avancada),
        preenche o CPF e espera o resultado; cada módulo tem cota
        própria de 100 consultas: quando um estoura, o MESMO CPF é
        repetido no módulo seguinte (o selo X/100 da página é lido
        antes de cada consulta);
     3. varre o DOM procurando um telefone que termine nos 4
        dígitos pedidos (com ou sem máscara);
     4. ENCONTRADO -> aprovados; senão / erro -> reprovados com a
        ficha original intacta;
     5. devolve progresso (log) e resultados para o painel por
        polling em GET /api/spyhub/jobs/:id.

   Uso CLI (teste na máquina que tem Chrome):
     node spyhub.js testar listas/spyhub.txt
     node spyhub.js analisar listas/spyhub.txt   (só o parser)
     node spyhub.js status
     node spyhub.js fechar

   Credenciais NUNCA ficam no código: use o .env
   (SPYHUB_USUARIO / SPYHUB_SENHA).
   ========================================================= */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const navegador = require('./navegador');
const parser = require('./spyhub-parser');

const URL_BASE = String(process.env.SPYHUB_URL || 'https://app.spyhub.io').replace(/\/+$/, '');
const URL_LOGIN = process.env.SPYHUB_LOGIN_URL || (URL_BASE + '/login');

/* Módulos de consulta do SpyHub. Cada URL tem a PRÓPRIA cota (100 consultas):
   quando o selo chega a 100/100 (ou o site avisa do limite), o motor repete o
   mesmo CPF no módulo seguinte — a verificação não para nem reprova por isso. */
/* A ordem importa: o Tracker é o módulo que devolve o número certo (o
   /search/avancada fica por último, só como reserva de cota). */
const MODULOS_PADRAO = [
    {
        id: 'tracker',
        nome: 'Consulta Tracker',
        caminho: '/search/tracker',
        chaves: ['consulta tracker', 'tracker']
    },
    {
        id: 'cpf-top',
        nome: 'Consulta CPF TOP',
        caminho: '/search/cpf-top',
        chaves: ['consulta cpf top', 'cpf top', 'cpf-top']
    },
    {
        id: 'avancada',
        nome: 'Consulta P.Física',
        caminho: '/search/avancada',
        chaves: ['consulta p.fisica', 'consulta p fisica', 'p.fisica', 'p fisica', 'pessoa fisica']
    }
];

/* SPYHUB_MODULOS_URLS=https://.../search/tracker,https://.../search/cpf-top
   manda na ordem dada (o nome/chaves do selo seguem a URL); SPYHUB_BUSCA_URL
   (antigo) troca só a URL do 1º módulo. */
/* acha o módulo padrão pela URL (o último trecho do caminho), para manter o
   nome e as chaves do selo mesmo quando a ordem vem trocada no .env */
function moduloPorUrl(url) {
    const trecho = String(url || '').replace(/\/+$/, '').split('/').pop().toLowerCase();
    if (!trecho) return null;

    return MODULOS_PADRAO.find((modulo) => modulo.caminho === '/' + trecho)
        || MODULOS_PADRAO.find((modulo) => trecho.indexOf(modulo.id) >= 0)
        || null;
}

function montarModulos() {
    const lista = String(process.env.SPYHUB_MODULOS_URLS || '')
        .split(/[,;\s]+/)
        .map((url) => url.trim())
        .filter(Boolean);

    if (lista.length) {
        return lista.map((url, indice) => {
            const limpa = url.replace(/\/+$/, '');
            const padrao = moduloPorUrl(limpa) || MODULOS_PADRAO[indice] || {};

            return {
                id: padrao.id || ('modulo-' + (indice + 1)),
                nome: padrao.nome || ('Módulo ' + (indice + 1)),
                url: limpa,
                chaves: (padrao.chaves || [limpa.slice(limpa.lastIndexOf('/') + 1)]).slice()
            };
        });
    }

    const modulos = MODULOS_PADRAO.map((modulo) => ({
        id: modulo.id,
        nome: modulo.nome,
        url: URL_BASE + modulo.caminho,
        chaves: modulo.chaves.slice()
    }));

    if (process.env.SPYHUB_BUSCA_URL) {
        modulos[0] = Object.assign({}, modulos[0], {
            url: String(process.env.SPYHUB_BUSCA_URL).replace(/\/+$/, '')
        });
    }

    return modulos;
}

const MODULOS = montarModulos();

/* compatibilidade: quem já usava URL_BUSCA (erros/status) segue funcionando */
const URL_BUSCA = MODULOS[0].url;

const PORTA = Number(process.env.CDP_PORT_SPYHUB || 9226);
const PERFIL = path.join(os.tmpdir(), 'qgc-painel-spyhub');

/* cota de cada módulo (100 no SpyHub) e tempo para revalidar um módulo marcado
   como esgotado — se a cota renovar, ele volta sozinho para a fila */
const COTA_MODULO = Math.max(1, Number(process.env.SPYHUB_COTA_MODULO || 100));
const REVALIDAR_MS = Math.max(60000, Number(process.env.SPYHUB_REVALIDAR_MODULO_MS || 600000));

const PADRAO = {
    tentativas: Math.max(1, Number(process.env.SPYHUB_TENTATIVAS || 3)),
    intervalo: Math.max(0, Number(process.env.SPYHUB_INTERVALO_MS || 1200)),
    esperaResultado: Math.max(5000, Number(process.env.SPYHUB_ESPERA_RESULTADO || 25000)),
    esperaLogin: Math.max(10000, Number(process.env.SPYHUB_ESPERA_LOGIN || 40000)),
    limite: Math.max(1, Number(process.env.SPYHUB_MAX_REGISTROS || 500))
};

const MAX_LOG = 800;

const estado = {
    job: null,
    cdp: null,
    processo: null,
    iniciando: null,
    /* cota de cada módulo em memória (o número real vem do selo da página) */
    modulos: MODULOS.map((modulo) => ({
        id: modulo.id,
        nome: modulo.nome,
        url: modulo.url,
        chaves: modulo.chaves,
        esgotado: false,
        usadas: 0,
        total: COTA_MODULO,
        motivo: '',
        verificadoEm: 0
    }))
};

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

/* ---------- credenciais (.env, sem nunca passar pelo front) ---------- */

function lerEnv() {
    const valores = {};
    const arquivo = path.join(process.cwd(), '.env');

    if (!fs.existsSync(arquivo)) return valores;

    fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).forEach((linha) => {
        const achado = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
        if (!achado) return;

        let valor = achado[2].trim();
        const aspas = (valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"));
        if (aspas && valor.length >= 2) valor = valor.slice(1, -1);

        valores[achado[1]] = valor;
    });

    return valores;
}

function credenciais() {
    const arquivo = lerEnv();
    return {
        usuario: process.env.SPYHUB_USUARIO || arquivo.SPYHUB_USUARIO || '',
        senha: process.env.SPYHUB_SENHA || arquivo.SPYHUB_SENHA || ''
    };
}

function erro(mensagem, codigo) {
    const falha = new Error(mensagem);
    falha.codigo = codigo || 'spyhub';
    return falha;
}

/* ---------- módulos de consulta e cota (100 por URL) ---------- */

const COM_ACENTO = 'áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC';

/* Minúsculo e sem acento SEM mudar o tamanho do texto (os índices do selo
   continuam valendo para achar o X/100 que pertence a cada módulo). */
function semAcento(valor) {
    return String(valor == null ? '' : valor).replace(
        /[áàãâäéèêëíìîïóòõôöúùûüçÁÀÃÂÄÉÈÊËÍÌÎÏÓÒÕÔÖÚÙÛÜÇ]/g,
        (letra) => SEM_ACENTO.charAt(COM_ACENTO.indexOf(letra))
    );
}

/* Todos os selos "usadas/total" plausíveis do texto.
   total < 10 é descartado para não confundir com data (01/02). */
function quotasDoTexto(texto) {
    const bruto = String(texto || '');
    const regex = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/g;
    const achados = [];
    let achado;

    while ((achado = regex.exec(bruto)) !== null) {
        const usadas = Number(achado[1]);
        const total = Number(achado[2]);

        if (!(total >= 10 && total <= 1000)) continue;
        if (usadas > total) continue;

        achados.push({
            usadas,
            total,
            inicio: achado.index,
            fim: achado.index + achado[0].length
        });
    }

    return achados;
}

/* Posição do nome/chave do módulo no texto (sem acento, sem mudar tamanho). */
function acharAncora(texto, chaves) {
    const procurado = semAcento(texto).toLowerCase();
    let ancora = null;

    /* a 1ª chave encontrada vence: título completo antes dos apelidos curtos */
    (Array.isArray(chaves) ? chaves : [chaves]).forEach((chave) => {
        if (ancora) return;

        const alvo = semAcento(String(chave == null ? '' : chave)).toLowerCase().trim();
        if (alvo.length < 3) return;

        const posicao = procurado.indexOf(alvo);
        if (posicao >= 0) ancora = { inicio: posicao, fim: posicao + alvo.length };
    });

    return ancora;
}

/* Cota do módulo. A tela pode listar todos os módulos, cada um com o seu selo
   (cards: selo ao lado do nome); então fica com o selo mais perto do NOME do
   módulo — e, no empate, com o que vem antes do nome. Sem o nome na tela,
   devolve o maior selo (o mais perto de estourar). */
function quotaDoTexto(texto, chaves) {
    const achados = quotasDoTexto(texto);
    if (!achados.length) return null;
    if (achados.length === 1) return { usadas: achados[0].usadas, total: achados[0].total };

    const ancora = acharAncora(texto, chaves);
    let melhor = null;
    let escolhido = null;

    if (ancora) {
        achados.forEach((item) => {
            const antes = item.fim <= ancora.inicio;
            const depois = item.inicio >= ancora.fim;
            let distancia = 0;

            if (antes) distancia = ancora.inicio - item.fim;
            else if (depois) distancia = item.inicio - ancora.fim;

            /* x2 + 1: empate fica com o selo que vem antes do nome */
            const peso = (distancia * 2) + (antes ? 0 : 1);

            if (!melhor || peso < melhor) {
                melhor = peso;
                escolhido = item;
            }
        });
    } else {
        escolhido = achados.reduce((atual, item) => (item.usadas > atual.usadas ? item : atual));
    }

    return { usadas: escolhido.usadas, total: escolhido.total };
}

/* Aviso de cota estourada na própria página (antes de consultar): bem restrito,
   porque "limite de 100 consultas por dia" em texto de ajuda não é esgotamento. */
const RE_LIMITE_PAGINA = /limite de consultas (atingido|excedido|esgotado)|atingiu o limite|limite (di[aá]rio )?(atingido|esgotado|excedido)|consultas (esgotadas|indispon[ií]veis)|sem cr[eé]ditos?|saldo insuficiente|plano expirado/i;

/* Mesma ideia, mas no texto que a consulta acrescentou à tela (aí a menção ao
   limite é do site, não da ajuda). */
const RE_LIMITE_CONSULTA = /limite de consultas|limite di[aá]rio|limite atingido|atingiu o limite|sem cr[eé]dito|saldo insuficiente|plano expirado|consultas esgotadas|consultas indispon[ií]veis/i;

function textoIndicaLimite(texto) {
    return RE_LIMITE_PAGINA.test(String(texto || ''));
}

function moduloAtivo() {
    return estado.modulos.find((modulo) => !modulo.esgotado) || null;
}

/* Módulos na ordem de uso. Se todos estiverem marcados, devolve vazio — a não
   ser que já tenha passado tempo suficiente para revalidar (a cota renova). */
function modulosDisponiveis(agora) {
    const livres = estado.modulos.filter((modulo) => !modulo.esgotado);
    if (livres.length) return livres;

    const quando = Number(agora) || Date.now();
    const podeRevalidar = estado.modulos.every((modulo) => !modulo.verificadoEm
        || (quando - modulo.verificadoEm) >= REVALIDAR_MS);

    return podeRevalidar ? estado.modulos.slice() : [];
}

function esgotarModulo(modulo, motivo) {
    modulo.esgotado = true;
    modulo.verificadoEm = Date.now();
    modulo.motivo = String(motivo == null ? '' : motivo).slice(0, 200);
}

function liberarModulo(modulo, quota) {
    modulo.esgotado = false;
    modulo.motivo = '';
    modulo.verificadoEm = 0;

    if (quota) {
        modulo.usadas = quota.usadas;
        modulo.total = quota.total;
    }
}

/* Atualiza o selo do módulo com o texto da tela (antes ou depois de consultar). */
function atualizarCota(modulo, texto) {
    const quota = quotaDoTexto(texto, modulo.chaves);

    if (quota) {
        modulo.usadas = Math.max(modulo.usadas, quota.usadas);
        modulo.total = quota.total;

        if (quota.usadas >= quota.total) esgotarModulo(modulo, 'selo ' + quota.usadas + '/' + quota.total);
        return quota;
    }

    if (!modulo.esgotado) modulo.usadas = Math.min(modulo.total, modulo.usadas + 1);

    return null;
}

function descreverModulos() {
    const ativo = moduloAtivo();

    return estado.modulos.map((modulo) => ({
        id: modulo.id,
        nome: modulo.nome,
        url: modulo.url,
        esgotado: modulo.esgotado,
        usadas: modulo.usadas,
        total: modulo.total,
        motivo: modulo.motivo,
        ativo: Boolean(ativo && ativo.id === modulo.id)
    }));
}

/* ---------- Chrome dedicado + CDP ---------- */

async function esperarDevtools(tentativas) {
    const total = tentativas || 80;

    for (let i = 0; i < total; i += 1) {
        try {
            const resposta = await fetch('http://127.0.0.1:' + PORTA + '/json/version');
            if (resposta.ok) return await resposta.json();
        } catch (falha) { /* ainda subindo */ }

        await esperar(250);
    }

    throw erro('O Chrome não abriu a porta de depuração ' + PORTA + '.', 'sem-chrome');
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

    throw erro('Nenhuma aba aberta para conectar.', 'sem-chrome');
}

function conectarCdp(urlWebsocket) {
    return new Promise((resolver, rejeitar) => {
        const socket = new WebSocket(urlWebsocket);
        const pendentes = new Map();
        let sequencia = 0;

        socket.addEventListener('error', () => rejeitar(erro('Falha ao conectar no DevTools do Chrome.', 'sem-chrome')));

        socket.addEventListener('open', () => {
            resolver({
                enviar(metodo, parametros) {
                    const id = ++sequencia;

                    return new Promise((ok, falhou) => {
                        const vigia = setTimeout(() => {
                            if (!pendentes.delete(id)) return;
                            falhou(erro('O navegador não respondeu ao comando ' + metodo + ' (45s).', 'timeout-cdp'));
                        }, 45000);

                        pendentes.set(id, {
                            ok: (valor) => { clearTimeout(vigia); ok(valor); },
                            falhou: (falha) => { clearTimeout(vigia); falhou(falha); }
                        });

                        socket.send(JSON.stringify({ id, method: metodo, params: parametros || {} }));
                    });
                },
                fechar() {
                    try {
                        socket.close();
                    } catch (falha) { /* já fechado */ }
                }
            });
        });

        socket.addEventListener('message', (evento) => {
            let mensagem;
            try {
                mensagem = JSON.parse(evento.data);
            } catch (falha) {
                return;
            }

            const pendente = mensagem.id && pendentes.get(mensagem.id);
            if (!pendente) return;

            pendentes.delete(mensagem.id);
            if (mensagem.error) pendente.falhou(erro(mensagem.error.message, 'cdp'));
            else pendente.ok(mensagem.result);
        });
    });
}

async function cdpVivo(cdp) {
    try {
        await Promise.race([
            cdp.enviar('Runtime.evaluate', { expression: '1', returnByValue: true }),
            new Promise((_, rejeitar) => setTimeout(() => rejeitar(erro('ping timeout', 'timeout-cdp')), 5000))
        ]);
        return true;
    } catch (falha) {
        return false;
    }
}

/* Sobe o Chrome do SpyHub (porta/perfil próprios, não briga com o extrator). */
async function abrir() {
    if (estado.cdp && await cdpVivo(estado.cdp)) return estado.cdp;

    estado.cdp = null;
    if (estado.iniciando) return estado.iniciando;

    estado.iniciando = (async () => {
        const binario = navegador.acharNavegador();
        if (!binario) {
            throw erro('Chrome/Edge não encontrado nesta máquina. A verificação automática só roda onde '
                + 'existe navegador (defina CHROME_PATH ou rode o script local).', 'sem-chrome');
        }

        fs.mkdirSync(PERFIL, { recursive: true });

        console.log('[spyhub] abrindo Chrome dedicado (' + PERFIL + ')'
            + (navegador.modoHeadless() ? ' em modo headless' : ''));

        estado.processo = spawn(binario, navegador.flagsNavegador({
            porta: PORTA,
            perfil: PERFIL,
            url: URL_LOGIN
        }), { stdio: 'ignore' });

        estado.processo.on('exit', () => {
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

/* ---------- conversa com a página ---------- */

const MARCADOR = 'data-spyhub-alvo';

async function avaliar(cdp, expressao) {
    const resposta = await cdp.enviar('Runtime.evaluate', {
        expression: expressao,
        returnByValue: true,
        awaitPromise: true
    });

    if (resposta.exceptionDetails) {
        throw erro(resposta.exceptionDetails.text || 'erro ao executar na página', 'cdp');
    }

    return resposta.result ? resposta.result.value : undefined;
}

async function navegar(cdp, url) {
    try {
        await cdp.enviar('Page.navigate', { url });
    } catch (falha) {
        /* navegação abortada (download/redirect) não invalida a sessão */
    }

    await esperarPronto(cdp);
}

async function esperarPronto(cdp, limiteMs) {
    const limite = Date.now() + (limiteMs || 30000);

    while (Date.now() < limite) {
        try {
            const estadoPagina = await avaliar(cdp,
                '({ pronto: document.readyState, corpo: Boolean(document.body) })');

            if (estadoPagina && estadoPagina.pronto === 'complete' && estadoPagina.corpo) {
                await esperarDomQuieto(cdp, 600, 8000);
                return true;
            }
        } catch (falha) { /* página trocando */ }

        await esperar(400);
    }

    return false;
}

/* Espera o DOM parar de mudar (SPA/hidratação) antes de digitar/clicar. */
async function esperarDomQuieto(cdp, quietoMs, limiteMs) {
    const quieto = quietoMs || 700;
    const limite = limiteMs || 15000;

    try {
        return await avaliar(cdp, 'new Promise((ok) => {' +
            ' const limite = setTimeout(() => ok(true), ' + limite + ');' +
            ' let observador = null;' +
            ' const parar = () => { clearTimeout(limite); if (observador) observador.disconnect(); ok(true); };' +
            ' let quieto = setTimeout(parar, ' + quieto + ');' +
            ' observador = new MutationObserver(() => {' +
            '   clearTimeout(quieto);' +
            '   quieto = setTimeout(parar, ' + quieto + ');' +
            ' });' +
            ' observador.observe(document.body, { childList: true, subtree: true, characterData: true });' +
            '})');
    } catch (falha) {
        return false;
    }
}

async function textoPagina(cdp) {
    return String(await avaliar(cdp, 'document.body ? document.body.innerText : ""') || '')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/* Marca o primeiro elemento visível da lista de seletores com o atributo
   data-spyhub-alvo, para os próximos comandos mexerem no elemento certo. */
async function marcarPrimeiro(cdp, seletores) {
    return String(await avaliar(cdp, '(() => {' +
        ' const seletores = ' + JSON.stringify(seletores) + ';' +
        ' document.querySelectorAll("[' + MARCADOR + ']").forEach((el) => el.removeAttribute("' + MARCADOR + '"));' +
        ' const visivel = (el) => {' +
        '   if (!el || el.disabled) return false;' +
        '   const estilo = window.getComputedStyle(el);' +
        '   if (estilo.display === "none" || estilo.visibility === "hidden" || estilo.opacity === "0") return false;' +
        '   const caixa = el.getBoundingClientRect();' +
        '   return caixa.width > 0 && caixa.height > 0;' +
        ' };' +
        ' const rotulo = (el) => ((el.getAttribute("aria-label") || "") + " " + (el.getAttribute("placeholder") || "")' +
        '   + " " + (el.getAttribute("name") || "") + " " + (el.type || ""));' +
        ' for (const seletor of seletores) {' +
        '   let lista = [];' +
        '   try { lista = Array.from(document.querySelectorAll(seletor)); } catch (falha) { continue; }' +
        '   const alvo = lista.find(visivel);' +
        '   if (alvo) {' +
        '     alvo.setAttribute("' + MARCADOR + '", "1");' +
        '     try { alvo.scrollIntoView({ block: "center" }); } catch (falha) {}' +
        '     return seletor + " | " + rotulo(alvo);' +
        '   }' +
        ' }' +
        ' return "";' +
        '})()') || '');
}

/* Preenche o elemento marcado como React/Vue esperam (setter nativo + eventos). */
async function preencherMarcado(cdp, texto) {
    const preencheu = await avaliar(cdp, '(() => {' +
        ' const el = document.querySelector("[' + MARCADOR + ']");' +
        ' if (!el) return false;' +
        ' const texto = ' + JSON.stringify(String(texto)) + ';' +
        ' el.focus();' +
        ' if (el.isContentEditable) {' +
        '   el.textContent = texto;' +
        '   el.dispatchEvent(new InputEvent("input", { bubbles: true, data: texto }));' +
        '   return true;' +
        ' }' +
        ' const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;' +
        ' const descritor = Object.getOwnPropertyDescriptor(proto, "value");' +
        ' if (descritor && descritor.set) descritor.set.call(el, texto);' +
        ' else el.value = texto;' +
        ' el.dispatchEvent(new Event("input", { bubbles: true }));' +
        ' el.dispatchEvent(new Event("change", { bubbles: true }));' +
        ' return true;' +
        '})()');

    if (!preencheu) return false;

    const valor = String(await avaliar(cdp, '(() => {' +
        ' const el = document.querySelector("[' + MARCADOR + ']");' +
        ' return el ? (el.value != null ? el.value : (el.textContent || "")) : "";' +
        '})()') || '');

    if (valor.indexOf(String(texto)) === -1) {
        await cdp.enviar('Input.insertText', { text: String(texto) });
    }

    await teclar(cdp, 'Tab');
    await esperar(250);

    return true;
}

async function teclar(cdp, tecla) {
    const codigo = tecla === 'Enter' ? 13 : (tecla === 'Tab' ? 9 : 0);
    const comum = { key: tecla, code: tecla, windowsVirtualKeyCode: codigo, nativeVirtualKeyCode: codigo };

    await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, comum));

    if (tecla === 'Enter') {
        await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r', unmodifiedText: '\r' }, comum));
    }

    await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, comum));
}

/* Clica no primeiro elemento cujo texto casa com o padrão (regex, sem case). */
async function clicarPorTexto(cdp, padrao) {
    return Boolean(await avaliar(cdp, '(() => {' +
        ' const regex = new RegExp(' + JSON.stringify(padrao) + ', "i");' +
        ' const visivel = (el) => {' +
        '   const caixa = el.getBoundingClientRect();' +
        '   return caixa.width > 0 && caixa.height > 0;' +
        ' };' +
        ' const alvos = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], a"));' +
        ' const alvo = alvos.find((el) => !el.disabled && visivel(el)' +
        '   && regex.test(((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").trim()));' +
        ' if (!alvo) return false;' +
        ' try { alvo.scrollIntoView({ block: "center" }); } catch (falha) {}' +
        ' alvo.click();' +
        ' return true;' +
        '})()'));
}

async function existe(cdp, expressao) {
    try {
        return Boolean(await avaliar(cdp, expressao));
    } catch (falha) {
        return false;
    }
}

async function esperarPor(cdp, expressao, tentativas, intervalo) {
    for (let i = 0; i < tentativas; i += 1) {
        if (await existe(cdp, expressao)) return true;
        await esperar(intervalo || 500);
    }

    return false;
}

/* ---------- login ---------- */

const SELETORES_USUARIO = [
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[name="login"]',
    'input[name="username"]',
    'input[placeholder*="mail" i]',
    'input[placeholder*="usu" i]',
    'input[placeholder*="login" i]',
    'input[type="text"]'
];

async function preencherLogin(cdp) {
    const cred = credenciais();

    const campoUsuario = await marcarPrimeiro(cdp, SELETORES_USUARIO);
    if (!campoUsuario) throw erro('Campo de usuário não encontrado na tela de login do SpyHub.', 'campo-login');
    if (!await preencherMarcado(cdp, cred.usuario)) {
        throw erro('Não consegui preencher o usuário do SpyHub.', 'campo-login');
    }

    const campoSenha = await marcarPrimeiro(cdp, ['input[type="password"]']);
    if (!campoSenha) throw erro('Campo de senha não encontrado na tela de login do SpyHub.', 'campo-login');
    if (!await preencherMarcado(cdp, cred.senha)) {
        throw erro('Não consegui preencher a senha do SpyHub.', 'campo-login');
    }

    await esperar(300);

    /* submit: botão do formulário da senha, senão botão de texto entrar/acessar */
    const clicou = await avaliar(cdp, '(() => {' +
        ' const senha = document.querySelector("input[type=password]");' +
        ' const escopo = (senha && (senha.form || senha.closest("form"))) || document;' +
        ' const nome = (b) => ((b.innerText || b.value || b.getAttribute("aria-label") || "") + "").trim();' +
        ' const botoes = Array.from(escopo.querySelectorAll("button, [role=button], input[type=submit]"));' +
        ' const uteis = botoes.filter((b) => !b.disabled && /entrar|acessar|login|continuar|sign in|log in/i.test(nome(b)));' +
        ' const alvo = uteis[0] || escopo.querySelector("button[type=submit], input[type=submit]");' +
        ' if (!alvo) return false;' +
        ' try { alvo.scrollIntoView({ block: "center" }); } catch (falha) {}' +
        ' alvo.click();' +
        ' return true;' +
        '})()');

    if (!clicou) await teclar(cdp, 'Enter');

    return true;
}

/* Garante sessão no SpyHub. Se o perfil do Chrome já tem cookie válido,
   nem aparece o formulário — e não precisa logar de novo. */
async function garantirLogin(cdp) {
    const cred = credenciais();

    if (!cred.usuario || !cred.senha) {
        throw erro('Defina SPYHUB_USUARIO e SPYHUB_SENHA no .env para a verificação automática.', 'sem-credenciais');
    }

    await navegar(cdp, URL_LOGIN);
    await esperarDomQuieto(cdp);

    const formulario = await esperarPor(cdp, 'Boolean(document.querySelector(\'input[type="password"]\'))', 24, 500);
    if (!formulario) return cdp;

    for (let tentativa = 1; tentativa <= 3; tentativa += 1) {
        console.log('[spyhub] login (tentativa ' + tentativa + ')');
        await preencherLogin(cdp);

        const saiu = await esperarPor(cdp, '!document.querySelector(\'input[type="password"]\')',
            Math.ceil(PADRAO.esperaLogin / 500), 500);

        if (saiu) {
            await esperarDomQuieto(cdp);
            console.log('[spyhub] login concluído.');
            return cdp;
        }

        const texto = await textoPagina(cdp);

        if (/senha (inv|incorret)|credencia|usu[aá]rio (inv|n[aã]o)|login inv|dados incorret/i.test(texto)) {
            throw erro('Login no SpyHub recusado. Confira SPYHUB_USUARIO/SPYHUB_SENHA no .env.', 'login-recusado');
        }

        await esperar(1500);
    }

    throw erro('O login no SpyHub não concluiu (o formulário continua na tela).', 'login');
}

/* ---------- busca de pessoa física ---------- */

const SELETORES_BUSCA = [
    '#tab_cpf input[name="cpf"]',
    '#tab_cpf input[type="text"]',
    'input[name="cpf"]',
    'input[placeholder*="cpf" i]',
    'input[name*="cpf" i]',
    'input[id*="cpf" i]',
    'input[aria-label*="cpf" i]',
    'input[placeholder*="documento" i]',
    'input[inputmode="numeric"]',
    'input[type="tel"]',
    'input[placeholder*="pesquis" i]',
    'input[placeholder*="buscar" i]',
    'input[type="search"]',
    'input[name*="search" i]',
    'input[name*="query" i]',
    'input[aria-label*="pesquis" i]',
    'input[type="text"]'
];

/* A tela de pessoa física abre na aba NOME; CPF fica em outra aba. */
const SELETORES_ABA_CPF = [
    '#li_module_cpf a',
    'a[href="#tab_cpf"]',
    '[data-module="cpf"]',
    '#tab_cpf-tab',
    '[aria-controls="tab_cpf"]'
];

async function abrirAbaCpf(cdp) {
    const abriu = Boolean(await avaliar(cdp, '(() => {' +
        ' const seletores = ' + JSON.stringify(SELETORES_ABA_CPF) + ';' +
        ' const visivel = (el) => {' +
        '   if (!el) return false;' +
        '   const caixa = el.getBoundingClientRect();' +
        '   return caixa.width > 0 && caixa.height > 0;' +
        ' };' +
        ' for (const seletor of seletores) {' +
        '   let alvo = null;' +
        '   try { alvo = document.querySelector(seletor); } catch (falha) { continue; }' +
        '   if (visivel(alvo)) { alvo.click(); return seletor; }' +
        ' }' +
        ' /* plano B: aba cujo texto é exatamente CPF */' +
        ' const abas = Array.from(document.querySelectorAll(\'a, button, [role="tab"], li\'));' +
        ' const alvo = abas.find((el) => visivel(el) && /^\\s*cpf\\s*$/i.test((el.innerText || "").trim()));' +
        ' if (!alvo) return "";' +
        ' alvo.click();' +
        ' return "texto:CPF";' +
        '})()') || '');

    if (abriu) {
        /* espera o painel do CPF aparecer (SPA troca a aba na hora) */
        await esperarPor(cdp, '(() => {' +
            ' const campo = document.querySelector(\'#tab_cpf input[name="cpf"], #tab_cpf input\');' +
            ' if (!campo) return false;' +
            ' const caixa = campo.getBoundingClientRect();' +
            ' return caixa.width > 0 && caixa.height > 0;' +
            '})()', 10, 300);
    }

    return abriu;
}

/* Clica no CONSULTAR do painel do CPF (há um botão por aba, quase todos ocultos). */
async function clicarConsultarCpf(cdp) {
    const clicou = Boolean(await avaliar(cdp, '(() => {' +
        ' const visivel = (el) => {' +
        '   if (!el || el.disabled) return false;' +
        '   const caixa = el.getBoundingClientRect();' +
        '   return caixa.width > 0 && caixa.height > 0;' +
        ' };' +
        ' const painel = document.querySelector("#tab_cpf");' +
        ' const escopos = painel ? [painel, document] : [document];' +
        ' for (const escopo of escopos) {' +
        '   const botoes = Array.from(escopo.querySelectorAll(\'button, [role="button"], input[type="submit"], a\'));' +
        '   const alvo = botoes.find((el) => visivel(el)' +
        '     && /consultar|buscar|pesquisar/i.test(((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").trim()));' +
        '   if (alvo) {' +
        '     try { alvo.scrollIntoView({ block: "center" }); } catch (falha) {}' +
        '     alvo.click();' +
        '     return true;' +
        '   }' +
        ' }' +
        ' return false;' +
        '})()'));

    if (!clicou) await teclar(cdp, 'Enter');

    return clicou;
}

const EXPRESSAO_SENHA = 'Boolean(document.querySelector(\'input[type="password"]\'))';
const EXPRESSAO_SEM_SENHA = '!document.querySelector(\'input[type="password"]\')';

/* Só conta como "pronto" quando existe campo VISÍVEL (o esqueleto da SPA tem
   inputs ocultos e o teste antigo passava antes da tela montar). */
const EXPRESSAO_FORMULARIO_BUSCA = '(() => {' +
    ' const visivel = (el) => {' +
    '   if (!el) return false;' +
    '   const caixa = el.getBoundingClientRect();' +
    '   return caixa.width > 0 && caixa.height > 0;' +
    ' };' +
    ' return visivel(document.querySelector("#li_module_cpf a"))' +
    '   || visivel(document.querySelector(\'#tab_cpf input[name="cpf"]\'))' +
    '   || Array.from(document.querySelectorAll("input, textarea")).some(visivel);' +
    '})()';

/* Abre a tela de um módulo; se a sessão caiu (login no meio do caminho), refaz. */
async function garantirSessaoBusca(cdp, url) {
    const alvo = url || URL_BUSCA;

    await navegar(cdp, alvo);
    await esperarDomQuieto(cdp);

    if (await existe(cdp, EXPRESSAO_SENHA)) {
        await garantirLogin(cdp);
        await navegar(cdp, alvo);
        await esperarDomQuieto(cdp);
    }

    await esperarPor(cdp, EXPRESSAO_FORMULARIO_BUSCA, 40, 500);

    return alvo;
}

/* Nomes dos campos visíveis: entra no erro para não precisar abrir o Chrome. */
async function descreverCampos(cdp) {
    try {
        const lista = await avaliar(cdp, '(() => {' +
            ' const visivel = (el) => {' +
            '   const caixa = el.getBoundingClientRect();' +
            '   return caixa.width > 0 && caixa.height > 0;' +
            ' };' +
            ' return Array.from(document.querySelectorAll("input, textarea")).filter(visivel).slice(0, 5)' +
            '   .map((el) => el.id ? ("#" + el.id)' +
            '     : (el.getAttribute("name") ? ("[name=" + el.getAttribute("name") + "]") : el.tagName.toLowerCase()));' +
            '})()');

        return Array.isArray(lista) ? lista.join(', ') : '';
    } catch (falha) {
        return '';
    }
}

/* Rótulos dos botões visíveis (diagnóstico dos módulos novos). */
async function descreverBotoes(cdp) {
    try {
        const lista = await avaliar(cdp, '(() => {' +
            ' const visivel = (el) => {' +
            '   const caixa = el.getBoundingClientRect();' +
            '   return caixa.width > 0 && caixa.height > 0;' +
            ' };' +
            ' return Array.from(document.querySelectorAll("button, [role=button], input[type=submit], a"))' +
            '   .filter(visivel)' +
            '   .map((el) => ((el.innerText || el.value || el.getAttribute("aria-label") || "") + "").trim())' +
            '   .filter((texto) => texto && texto.length <= 40)' +
            '   .slice(0, 12);' +
            '})()');

        return Array.isArray(lista) ? lista : [];
    } catch (falha) {
        return [];
    }
}

/* Lê o selo "usadas/100" do módulo antes de consultar: módulo estourado é
   marcado na hora (economiza uma consulta perdida) e módulo renovado volta. */
async function conferirCota(cdp, modulo) {
    let texto = '';

    try {
        texto = await textoPagina(cdp);
    } catch (falha) {
        return null;
    }

    const quota = quotaDoTexto(texto, modulo.chaves);

    if (quota && quota.usadas >= quota.total) {
        modulo.usadas = quota.usadas;
        modulo.total = quota.total;
        esgotarModulo(modulo, 'selo ' + quota.usadas + '/' + quota.total);
    } else if (quota) {
        liberarModulo(modulo, quota);
    } else if (textoIndicaLimite(texto)) {
        esgotarModulo(modulo, 'aviso de limite na página');
    }

    return quota;
}

/* Marca o campo de busca, digita o CPF e dispara a pesquisa. */
async function prepararBusca(cdp, valor, modulo) {
    let campo = '';

    /* o SpyHub abre em NOME; sem trocar para a aba CPF o texto iria para o campo errado.
       A SPA pode re-renderizar depois do clique, então tenta algumas vezes. */
    for (let tentativa = 0; tentativa < 3 && !campo; tentativa += 1) {
        if (tentativa) await esperar(700);

        await abrirAbaCpf(cdp);
        campo = await marcarPrimeiro(cdp, SELETORES_BUSCA);
    }

    if (!campo) {
        const visiveis = await descreverCampos(cdp);
        throw erro('Campo de busca de CPF não encontrado em ' + ((modulo && modulo.url) || URL_BUSCA)
            + ' (o layout mudou?). Campos visíveis: ' + (visiveis || 'nenhum'), 'campo-busca');
    }

    const info = await avaliar(cdp, '(() => {' +
        ' const el = document.querySelector("[' + MARCADOR + ']");' +
        ' if (!el) return { maxlength: 0 };' +
        ' const max = el.getAttribute("maxlength");' +
        ' return { maxlength: max ? Number(max) : 0 };' +
        '})()') || { maxlength: 0 };

    const comMascara = Number(info.maxlength || 0) >= 14;

    if (!await preencherMarcado(cdp, valor)) {
        throw erro('Não consegui digitar o CPF no campo de busca.', 'campo-busca');
    }

    /* foto da tela antes de consultar: o resultado é o que aparecer depois */
    const textoBase = await textoPagina(cdp);

    await clicarConsultarCpf(cdp);

    await esperar(500);

    return { comMascara, campo, textoBase };
}

/* ---------- leitura dos telefones ---------- */

const RE_TELEFONE_MASCARADO = /\(?\d{2}\)?[\s.-]*[\*•]{2,}[\s.-]*(?:\d{0,5}[\s.-]*)?\d{4}/g;
const RE_TELEFONE_FORMATADO = /(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*\d{4,5}[\s.-]*\d{4}/g;
const RE_TELEFONE_CRU = /\b\d{12,13}\b/g;

/* Extrai números de telefone do texto da página (com ou sem máscara). */
function extrairTelefones(texto) {
    const bruto = String(texto || '');
    const achados = [];
    const vistos = new Set();

    const adicionar = (valor, minimo) => {
        const limpo = parser.limpar(valor);
        const digitos = parser.apenasDigitos(limpo);

        if (digitos.length < (minimo || 8) || digitos.length > 13) return;
        if (vistos.has(digitos)) return;

        vistos.add(digitos);
        achados.push({ bruto: limpo, digitos, final: digitos.slice(-4), mascarado: /[\*•]/.test(limpo) });
    };

    const varrer = (regex, minimo) => {
        let achado;
        regex.lastIndex = 0;
        while ((achado = regex.exec(bruto)) !== null) adicionar(achado[0], minimo);
    };

    varrer(RE_TELEFONE_MASCARADO, 6);
    varrer(RE_TELEFONE_FORMATADO, 8);
    varrer(RE_TELEFONE_CRU, 12);

    return achados;
}

/* Procura um telefone que termine nos 4 dígitos pedidos. Ignora o próprio
   CPF pesquisado (11 dígitos) e aceita máscara tipo "(19) *****-0906". */
function acharTelefoneComFinal(texto, final4, cpf) {
    const final = parser.apenasDigitos(final4).slice(-4);
    if (final.length !== 4) return null;

    const cpfDigitos = parser.apenasDigitos(cpf);
    const telefones = extrairTelefones(texto);
    const achado = telefones.find((telefone) => telefone.digitos !== cpfDigitos
        && telefone.digitos.slice(-4) === final);

    if (achado) return achado;

    /* Plano B: máscara que o regex não fechou por causa de espaços quebrados. */
    const regex = new RegExp('(?:[\\*•]{2,})[\\s.-]*\\d{0,4}[\\s.-]*' + final, 'g');
    const mascara = regex.exec(String(texto || ''));
    if (mascara) return { bruto: mascara[0], digitos: final, final, mascarado: true };

    return null;
}

/* Linhas que só existem depois da consulta (o rodapé/instruções da tela ficam de fora). */
function textoNovoDepois(texto, base) {
    const antigas = new Set(String(base || '').split('\n').map((linha) => linha.trim()).filter(Boolean));
    return String(texto || '')
        .split('\n')
        .map((linha) => linha.trim())
        .filter((linha) => linha && !antigas.has(linha))
        .join('\n');
}

/* Espera o resultado da busca estabilizar (SPA carrega em pedaços). */
async function esperarResultadoBusca(cdp, cpf, final4, textoBase) {
    const inicio = Date.now();
    let ultimo = '';
    let estavel = 0;

    while (Date.now() - inicio < PADRAO.esperaResultado) {
        await esperar(600);

        let texto;
        try {
            texto = await textoPagina(cdp);
        } catch (falha) {
            continue;
        }

        if (/captcha|n[aã]o sou um rob|verifique que voc|cloudflare/i.test(texto)) {
            throw erro('O SpyHub pediu captcha/verificação. Resolva na janela do Chrome e rode de novo.', 'captcha');
        }

        if (RE_LIMITE_CONSULTA.test(texto)) {
            throw erro('O módulo do SpyHub informou limite de consultas/créditos.', 'limite');
        }

        if (/sess[aã]o expirada|fa[cç]a login novamente/i.test(texto)) {
            throw erro('A sessão do SpyHub expirou durante a verificação.', 'sessao');
        }

        /* só o que apareceu DEPOIS do clique conta: a tela inicial também
           tem textos com "não encontrado" nas instruções. */
        const novo = textoNovoDepois(texto, textoBase);

        const temTelefone = Boolean(acharTelefoneComFinal(novo, final4, cpf));
        const temCpf = novo.replace(/\D/g, '').indexOf(cpf) !== -1;
        const semResultado = /nenhum resultado|n[aã]o (foi )?encontrad|nada encontrad|sem resultado|n[aã]o localizad/i.test(novo);

        if (temTelefone || temCpf || semResultado) {
            if (texto === ultimo) estavel += 1;
            else {
                estavel = 0;
                ultimo = texto;
            }

            if (estavel >= 1) return texto;
            continue;
        }

        ultimo = texto;
        estavel = 0;
    }

    throw erro('Tempo esgotado esperando o resultado do CPF ' + parser.formatarCpf(cpf) + '.', 'timeout-resultado');
}

/* Consulta UM registro DENTRO de um módulo: abre a tela, digita o CPF e classifica. */
async function consultarNoModulo(cdp, modulo, registro, final4) {
    await garantirSessaoBusca(cdp, modulo.url);
    await conferirCota(cdp, modulo);

    if (modulo.esgotado) {
        throw erro('Módulo ' + modulo.nome + ' sem consultas disponíveis ('
            + modulo.usadas + '/' + modulo.total + (modulo.motivo ? ': ' + modulo.motivo : '') + ').', 'limite');
    }

    const tentativa = await prepararBusca(cdp, registro.cpf, modulo);
    let base = tentativa.textoBase;
    let texto = await esperarResultadoBusca(cdp, registro.cpf, final4, base);

    /* Alguns inputs exigem a máscara: se o site reclamou do formato, repete. */
    if (!tentativa.comMascara && !acharTelefoneComFinal(texto, final4, registro.cpf)
        && /cpf inv[aá]lido|formato inv[aá]lido|documento inv[aá]lido|d[ií]gitos inv[aá]lidos/i.test(texto)) {
        await garantirSessaoBusca(cdp, modulo.url);
        const nova = await prepararBusca(cdp, registro.cpfFormatado, modulo);
        base = nova.textoBase;
        texto = await esperarResultadoBusca(cdp, registro.cpf, final4, base);
    }

    /* a consulta foi gasta de verdade: atualiza o selo do módulo */
    atualizarCota(modulo, texto);

    /* olha primeiro o que a consulta acrescentou à tela; se nada mudou, a página inteira */
    const novo = textoNovoDepois(texto, base) || texto;
    const telefone = acharTelefoneComFinal(novo, final4, registro.cpf);

    if (telefone) {
        return {
            encontrado: true,
            telefone: telefone.bruto,
            telefoneDigitos: telefone.digitos,
            modulo: modulo.nome,
            moduloId: modulo.id,
            texto
        };
    }

    const semResultado = /nenhum resultado|n[aã]o (foi )?encontrad|nada encontrad|sem resultado|n[aã]o localizad/i.test(novo);

    return {
        encontrado: false,
        motivo: semResultado
            ? 'SpyHub não retornou resultado para este CPF'
            : 'Nenhum telefone terminando em ' + final4,
        /* trecho do retorno do site: ajuda a conferir a reprovação sem abrir o Chrome */
        retorno: parser.limpar(novo).slice(0, 400),
        modulo: modulo.nome,
        moduloId: modulo.id,
        texto
    };
}

/* Consulta UM registro trocando de módulo quando a cota estoura: o MESMO CPF é
   repetido no módulo seguinte (a consulta recusada pelo limite não gasta crédito). */
async function consultarRegistro(registro, job) {
    const final4 = registro.finais[0];
    const cdp = await abrir();
    const disponiveis = modulosDisponiveis();

    if (!disponiveis.length) {
        throw erro('Todos os módulos do SpyHub estão no limite de consultas ('
            + estado.modulos.map((modulo) => modulo.nome + ' ' + modulo.usadas + '/' + modulo.total).join(', ')
            + '). Espere a cota renovar para continuar.', 'limite');
    }

    if (job && disponiveis[0] !== estado.modulos[0]) {
        log(job, 'info', 'Usando o módulo ' + disponiveis[0].nome + ' (o anterior estourou a cota).');
    }

    let ultimo = null;

    for (const modulo of disponiveis) {
        try {
            return await consultarNoModulo(cdp, modulo, registro, final4);
        } catch (falha) {
            if (falha.codigo !== 'limite') throw falha;

            /* cota estourada: marca o módulo e repete o CPF no próximo */
            esgotarModulo(modulo, falha.message);
            ultimo = falha;

            if (job) {
                log(job, 'aviso', 'Módulo ' + modulo.nome + ' no limite ('
                    + modulo.usadas + '/' + modulo.total + ') -> trocando para o próximo módulo.');
            }
        }
    }

    throw erro('Nenhum módulo do SpyHub aceitou a consulta agora. '
        + (ultimo ? ultimo.message : ''), 'limite');
}

/* ---------- job: fila sequencial de registros ---------- */

function log(job, tipo, mensagem) {
    job.log.push({
        quando: new Date().toISOString(),
        tipo,
        mensagem: String(mensagem == null ? '' : mensagem).slice(0, 500)
    });

    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}

const ERROS_FATAIS = ['sem-chrome', 'sem-credenciais', 'login-recusado', 'captcha', 'limite', 'login', 'campo-login'];

/* Cria o job e devolve o id; o processamento segue em background (polling). */
function iniciar(registros) {
    if (estado.job && estado.job.status === 'rodando') {
        throw erro('Já existe uma verificação em andamento. Aguarde terminar.', 'ocupado');
    }

    const lista = (Array.isArray(registros) ? registros : []).slice(0, PADRAO.limite);
    if (!lista.length) throw erro('Nenhum registro válido para verificar.', 'sem-registros');

    const job = {
        id: crypto.randomUUID(),
        status: 'rodando',
        total: lista.length,
        feitos: 0,
        aprovados: [],
        reprovados: [],
        log: [],
        erro: '',
        iniciadoEm: new Date().toISOString(),
        finalizadoEm: null
    };

    estado.job = job;
    processar(job, lista);

    return { id: job.id, total: job.total };
}

async function reiniciarConexaoSePreciso() {
    if (estado.cdp && !await cdpVivo(estado.cdp)) {
        try {
            estado.cdp.fechar();
        } catch (falha) { /* já fechado */ }

        estado.cdp = null;
    }
}

/* Retry com espera crescente: 3 tentativas por CPF antes de reprovar. */
async function comRetry(job, registro, acao) {
    let ultima = null;

    for (let tentativa = 1; tentativa <= PADRAO.tentativas; tentativa += 1) {
        try {
            return await acao();
        } catch (falha) {
            ultima = falha;
            log(job, 'erro', registro.cpfFormatado + ': tentativa ' + tentativa + '/'
                + PADRAO.tentativas + ' falhou (' + falha.message + ')');

            if (ERROS_FATAIS.indexOf(falha.codigo) !== -1) throw falha;

            await reiniciarConexaoSePreciso();
            await esperar(1200 * tentativa);
        }
    }

    throw ultima;
}

async function processar(job, registros) {
    try {
        const ativo = moduloAtivo();

        log(job, 'info', 'Verificação iniciada: ' + registros.length + ' registro(s).');
        log(job, 'info', 'Módulos: ' + estado.modulos.map((modulo) => modulo.nome + ' ('
            + modulo.usadas + '/' + modulo.total + (modulo.esgotado ? ', esgotado' : '') + ')').join(' | ')
            + (ativo ? ' -> usando ' + ativo.nome + '.' : ' -> todos esgotados.'));

        for (const registro of registros) {
            const rotulo = registro.cpfFormatado + ' (final ' + registro.finais.join('/') + ')';
            log(job, 'info', 'Consultando ' + rotulo + '...');

            try {
                const resultado = await comRetry(job, registro, () => consultarRegistro(registro, job));

                if (resultado.encontrado) {
                    job.aprovados.push({
                        cnpj: registro.cnpj,
                        cnpjFormatado: registro.cnpjFormatado,
                        cpf: registro.cpf,
                        cpfFormatado: registro.cpfFormatado,
                        nome: registro.nome,
                        razaoSocial: registro.razaoSocial,
                        nomeFantasia: registro.nomeFantasia,
                        telefoneDesmascarado: registro.telefoneDesmascarado || resultado.telefone,
                        telefoneEncontrado: resultado.telefone,
                        endereco: registro.endereco,
                        finais: registro.finais.slice(),
                        modulo: resultado.modulo || '',
                        ficha: registro.ficha
                    });
                    log(job, 'ok', 'APROVADO ' + rotulo + ' - telefone ' + resultado.telefone
                        + (resultado.modulo ? ' [' + resultado.modulo + ']' : ''));
                } else {
                    job.reprovados.push(Object.assign({}, registro, {
                        motivo: resultado.motivo,
                        retorno: resultado.retorno || '',
                        modulo: resultado.modulo || ''
                    }));
                    log(job, 'aviso', 'REPROVADO ' + rotulo + ' - ' + resultado.motivo
                        + (resultado.modulo ? ' [' + resultado.modulo + ']' : ''));
                }
            } catch (falha) {
                job.reprovados.push(Object.assign({}, registro, { motivo: falha.message }));
                log(job, 'erro', 'ERRO ' + rotulo + ' - ' + falha.message);

                if (ERROS_FATAIS.indexOf(falha.codigo) !== -1) {
                    job.status = 'erro';
                    job.erro = falha.message;
                    log(job, 'erro', 'Verificação interrompida: ' + falha.message);
                    return;
                }
            }

            job.feitos += 1;

            if (PADRAO.intervalo) await esperar(PADRAO.intervalo);
        }

        job.status = 'concluido';
        log(job, 'ok', 'Fim: ' + job.aprovados.length + ' aprovado(s), '
            + job.reprovados.length + ' reprovado(s).');
    } catch (falha) {
        job.status = 'erro';
        job.erro = falha.message;
        log(job, 'erro', 'Falha geral: ' + falha.message);
    } finally {
        job.finalizadoEm = new Date().toISOString();
    }
}

/* ---------- estado para a tela ---------- */

function instantaneo(id) {
    const job = estado.job;
    if (!job) return null;
    if (id && job.id !== id) return null;

    return {
        id: job.id,
        status: job.status,
        total: job.total,
        feitos: job.feitos,
        progresso: job.total ? Math.round((job.feitos / job.total) * 100) : 0,
        aprovados: job.aprovados,
        reprovados: job.reprovados,
        log: job.log,
        erro: job.erro,
        iniciadoEm: job.iniciadoEm,
        finalizadoEm: job.finalizadoEm
    };
}

function status() {
    const binario = navegador.acharNavegador();
    const conectado = Boolean(estado.cdp);
    const cred = credenciais();
    const ativo = moduloAtivo();
    const modulos = descreverModulos();

    return {
        navegador: Boolean(binario),
        chrome: conectado,
        motivo: navegador.motivoIndisponivel(binario, conectado),
        headless: navegador.modoHeadless(),
        ocupado: Boolean(estado.job && estado.job.status === 'rodando'),
        porta: PORTA,
        jobId: estado.job ? estado.job.id : '',
        credenciais: Boolean(cred.usuario && cred.senha),
        urlBusca: URL_BUSCA,
        moduloAtivo: ativo ? ativo.nome : '',
        moduloQuota: ativo ? (ativo.usadas + '/' + ativo.total) : '',
        modulos
    };
}

function fechar() {
    if (estado.processo && estado.processo.pid) {
        navegador.encerrarProcesso(estado.processo.pid);
    }

    try {
        if (estado.cdp) estado.cdp.fechar();
    } catch (falha) { /* já fechado */ }

    estado.processo = null;
    estado.cdp = null;
}

/* Depois de um comando de CLI, solta o socket CDP e o processo filho do Chrome
   (sem matar a janela) para o Node terminar. Sem isso, `node spyhub.js testar`
   imprime o resultado, grava os arquivos e fica pendurado segurando a conexão. */
function encerrarCli(alvo) {
    const cdp = alvo || estado.cdp;

    try {
        if (cdp) cdp.fechar();
    } catch (falha) { /* já fechado */ }

    if (!alvo) estado.cdp = null;

    if (estado.processo && typeof estado.processo.unref === 'function') {
        estado.processo.unref();
    }
}

/* ---------- CLI de teste ---------- */

async function acompanharConsole(id) {
    let vistos = 0;

    while (true) {
        const job = instantaneo(id);
        if (!job) throw new Error('Job não encontrado.');

        job.log.slice(vistos).forEach((linha) => {
            console.log('[' + linha.quando.slice(11, 19) + '] ' + linha.mensagem);
        });
        vistos = job.log.length;

        if (job.status !== 'rodando') {
            console.log('\nAprovados: ' + job.aprovados.length + ' | Reprovados: ' + job.reprovados.length);
            console.log(JSON.stringify({
                status: job.status,
                erro: job.erro,
                aprovados: job.aprovados,
                reprovados: job.reprovados.map((item) => ({
                    cpf: item.cpfFormatado,
                    finais: item.finais,
                    motivo: item.motivo,
                    retorno: item.retorno || ''
                }))
            }, null, 2));

            /* mesmos arquivos que o painel exporta, para conferir offline */
            const arquivoCsv = path.join(process.cwd(), 'aprovados-spyhub.csv');
            const arquivoTxt = path.join(process.cwd(), 'reprovados-spyhub.txt');

            fs.writeFileSync(arquivoCsv, '\uFEFF' + parser.csvDeAprovados(job.aprovados), 'utf8');
            fs.writeFileSync(arquivoTxt, parser.txtDeReprovados(job.reprovados), 'utf8');

            console.log('\nArquivos: ' + arquivoCsv + ' | ' + arquivoTxt);
            return job;
        }

        await esperar(1500);
    }
}

/* Diagnóstico dos módulos: abre cada URL, mostra o selo X/100, os campos e os
   botões visíveis. NÃO consulta ninguém (não gasta crédito) — serve para ver
   qual módulo está disponível e como o layout de cada um está hoje. */
async function diagnosticarModulos() {
    const cdp = await abrir();
    await garantirLogin(cdp);

    const saida = [];

    for (const modulo of estado.modulos) {
        await navegar(cdp, modulo.url);
        await esperarDomQuieto(cdp);

        let texto = '';
        try {
            texto = await textoPagina(cdp);
        } catch (falha) { /* página ainda carregando */ }

        const quota = quotaDoTexto(texto, modulo.chaves);

        if (quota) {
            modulo.usadas = quota.usadas;
            modulo.total = quota.total;
            modulo.esgotado = quota.usadas >= quota.total;
        }

        saida.push({
            id: modulo.id,
            nome: modulo.nome,
            url: modulo.url,
            selo: quota ? (quota.usadas + '/' + quota.total) : 'não encontrado',
            esgotado: modulo.esgotado,
            avisoDeLimite: textoIndicaLimite(texto),
            campos: await descreverCampos(cdp),
            botoes: await descreverBotoes(cdp)
        });
    }

    console.log(JSON.stringify(saida, null, 2));
    return saida;
}

async function principal() {
    try {
        const comando = process.argv[2];
        const caminho = process.argv[3];

        if (comando === 'status') {
            console.log(JSON.stringify(status(), null, 2));
            return;
        }

        if (comando === 'modulos') {
            await diagnosticarModulos();
            return;
        }

        if (comando === 'fechar') {
            fechar();
            console.log('Chrome do SpyHub fechado.');
            return;
        }

        if ((comando === 'analisar' || comando === 'testar') && caminho) {
            const analise = parser.parseEntrada(fs.readFileSync(caminho, 'utf8'));

            console.log('Formato: ' + analise.formato + ' | registros: ' + analise.total
                + ' | ignorados: ' + analise.ignoradosTotal);

            if (comando === 'analisar') {
                console.log(JSON.stringify({
                    registros: analise.registros.map((item) => ({
                        cpf: item.cpfFormatado,
                        nome: item.nome,
                        finais: item.finais,
                        cnpj: item.cnpjFormatado,
                        empresa: item.nomeFantasia,
                        telefone: item.telefoneDesmascarado
                    })),
                    ignorados: analise.ignorados
                }, null, 2));
                return;
            }

            if (!analise.total) return;

            const { id } = iniciar(analise.registros);
            await acompanharConsole(id);
            return;
        }

        console.log([
            'Motor de Verificação SpyHub (QGC TEAM by JV).',
            '',
            'Uso:',
            '  node spyhub.js testar <arquivo.txt|csv>   verifica de verdade e mostra o JSON',
            '  node spyhub.js analisar <arquivo>         só o parser (não abre o Chrome)',
            '  node spyhub.js modulos                    selo X/100, campos e botões de cada módulo',
            '  node spyhub.js status                     estado do Chrome/sessão/credenciais',
            '  node spyhub.js fechar                     fecha o Chrome dedicado',
            '',
            'Módulos (100 consultas em cada): ' + estado.modulos.map((modulo) => modulo.nome + ' -> ' + modulo.url).join(' | '),
            'Quando um estoura a cota, o mesmo CPF é consultado no próximo automaticamente.',
            '',
            'No painel, os endpoints são POST /api/spyhub/verificar e GET /api/spyhub/jobs/:id.'
        ].join('\n'));
    } finally {
        /* o trabalho terminou: solta o socket (senão o Node fica vivo para sempre) */
        encerrarCli();
    }
}

module.exports = {
    iniciar,
    instantaneo,
    status,
    fechar,
    encerrarCli,
    credenciais,
    extrairTelefones,
    acharTelefoneComFinal,
    textoNovoDepois,
    /* módulos e cota (testável sem abrir o Chrome) */
    quotaDoTexto,
    quotasDoTexto,
    textoIndicaLimite,
    descreverModulos,
    modulosDoMotor: () => estado.modulos,
    modulosDisponiveis,
    esgotarModulo,
    liberarModulo,
    atualizarCota,
    PADRAO,
    URL_LOGIN,
    URL_BUSCA,
    MODULOS
};

if (require.main === module) {
    principal().catch((falha) => {
        console.error('Erro: ' + falha.message);
        process.exitCode = 1;
    });
}

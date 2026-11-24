#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Captura de API (extratorgov.online)
   ---------------------------------------------------------
   Abre o Chrome com um perfil separado (o seu login fica
   salvo só ali), conecta no DevTools via CDP e grava todas
   as chamadas XHR/fetch/websocket que a página fizer.

   Serve para descobrir se o site tem uma API por trás do
   Streamlit. Você faz login e UMA consulta de exemplo; o
   script salva tudo em captura-api.json.

   Uso:
     node capturar-api.js
     node capturar-api.js --url=https://extratorgov.online/
     node capturar-api.js --segundos=120        (para sozinho)
     node capturar-api.js --fechar              (fecha o Chrome ao sair)

   Não precisa de npm install: usa o WebSocket do Node 22.
   ========================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PORTA = Number(process.env.CDP_PORT || 9222);
const PERFIL = path.join(os.tmpdir(), 'qgc-captura-extrator');
const LIMITE_CORPO = 30000;

const opcoes = {
    url: 'https://extratorgov.online/',
    saida: path.join(process.cwd(), 'captura-api.json'),
    segundos: 0,
    fechar: false,
    tudo: false,
    ajuda: false
};

process.argv.slice(2).forEach((arg) => {
    if (arg === '-h' || arg === '--ajuda' || arg === '--help') opcoes.ajuda = true;
    else if (arg.startsWith('--url=')) opcoes.url = arg.slice(6);
    else if (arg.startsWith('--saida=')) opcoes.saida = path.resolve(arg.slice(8));
    else if (arg.startsWith('--segundos=')) opcoes.segundos = parseInt(arg.slice(11), 10) || 0;
    else if (arg === '--fechar') opcoes.fechar = true;
    else if (arg === '--tudo') opcoes.tudo = true;
});

function uso() {
    console.log([
        'Captura as chamadas de rede do extratorgov.online (ou de outra URL).',
        '',
        'Uso:',
        '  node capturar-api.js [opções]',
        '',
        'Opções:',
        '  --url=URL        página a abrir. Padrão: https://extratorgov.online/',
        '  --saida=arq.json arquivo de saída. Padrão: captura-api.json',
        '  --segundos=N     encerra e salva sozinho depois de N segundos.',
        '  --fechar         fecha o Chrome ao encerrar (padrão: deixa aberto).',
        '  --tudo           inclui telemetria (Streamlit/Fivetran) no relatório.',
        '  -h, --ajuda      mostra esta ajuda.',
        '',
        'Como usar:',
        '  1. rode o script;',
        '  2. na janela do Chrome que abrir, faça login e UMA consulta;',
        '  3. volte ao terminal e aperte Ctrl+C;',
        '  4. me envie o arquivo captura-api.json.'
    ].join('\n'));
}

/* Procura Chrome (ou Edge) nos caminhos padrão do Windows. */
function acharNavegador() {
    const candidatos = [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);

    return candidatos.find((caminho) => fs.existsSync(caminho)) || '';
}

async function esperarDevtools(tentativas) {
    const total = tentativas || 60;

    for (let i = 0; i < total; i += 1) {
        try {
            const resposta = await fetch(`http://127.0.0.1:${PORTA}/json/version`);
            if (resposta.ok) return await resposta.json();
        } catch (erro) { /* ainda subindo */ }

        await new Promise((resolver) => setTimeout(resolver, 250));
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

        await new Promise((resolver) => setTimeout(resolver, 250));
    }

    throw new Error('Nenhuma aba aberta para conectar.');
}

/* Cliente mínimo do Chrome DevTools Protocol sobre WebSocket nativo. */
function conectarCdp(urlWebsocket) {
    return new Promise((resolver, rejeitar) => {
        const socket = new WebSocket(urlWebsocket);
        const pendentes = new Map();
        const ouvintes = [];
        let sequencia = 0;

        socket.addEventListener('error', () => rejeitar(new Error('Falha ao conectar no DevTools do Chrome.')));

        socket.addEventListener('open', () => {
            resolver({
                enviar(metodo, parametros) {
                    const id = ++sequencia;
                    return new Promise((ok, falhou) => {
                        pendentes.set(id, { ok, falhou });
                        socket.send(JSON.stringify({ id, method: metodo, params: parametros || {} }));
                    });
                },
                aoReceber(ouvinte) {
                    ouvintes.push(ouvinte);
                },
                aoFechar(ouvinte) {
                    socket.addEventListener('close', ouvinte);
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

            if (mensagem.id && pendentes.has(mensagem.id)) {
                const pendente = pendentes.get(mensagem.id);
                pendentes.delete(mensagem.id);
                if (mensagem.error) pendente.falhou(new Error(mensagem.error.message));
                else pendente.ok(mensagem.result);
                return;
            }

            ouvintes.forEach((ouvinte) => {
                try {
                    ouvinte(mensagem);
                } catch (erro) { /* ouvinte não pode derrubar a captura */ }
            });
        });
    });
}

/* Telemetria do próprio Streamlit: não é API do site, só polui o relatório. */
const HOSTS_TELEMETRIA = /(^|\.)(streamlit\.io|fivetran\.com|segment\.io|segment\.com|google-analytics\.com|googletagmanager\.com|sentry\.io|amplitude\.com|mixpanel\.com|hotjar\.com|clarity\.ms)$/i;

/* Só o que interessa: nada de CSS, JS, fonte, imagem ou o websocket do Streamlit. */
function interessa(url) {
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (!opcoes.tudo) {
        try {
            if (HOSTS_TELEMETRIA.test(new URL(url).host)) return false;
        } catch (erro) { /* segue o jogo */ }
    }
    if (/\/(static|_stcore)\//i.test(url)) return false;
    if (/\.(js|mjs|css|woff2?|ttf|eot|png|jpe?g|gif|svg|ico|map)(\?|#|$)/i.test(url)) return false;
    return true;
}

function filtrarCabecalhos(cabecalhos) {
    const interessantes = /^(authorization|content-type|x-api-key|api-key|apikey|x-auth-token|x-access-token|token|x-requested-with|accept|origin|referer)$/i;
    const limpos = {};

    Object.keys(cabecalhos || {}).forEach((nome) => {
        if (interessantes.test(nome)) limpos[nome.toLowerCase()] = String(cabecalhos[nome]).slice(0, 500);
    });

    return limpos;
}

function hostDe(url) {
    try {
        return new URL(url).host;
    } catch (erro) {
        return '(invalido)';
    }
}

function caminhoDe(url) {
    try {
        const alvo = new URL(url);
        return alvo.pathname + (alvo.search ? alvo.search.slice(0, 120) : '');
    } catch (erro) {
        return '';
    }
}

async function principal() {
    if (opcoes.ajuda) {
        uso();
        return;
    }

    const navegador = acharNavegador();
    if (!navegador) {
        console.error('Chrome/Edge não encontrado. Instale o Chrome ou defina CHROME_PATH.');
        process.exitCode = 1;
        return;
    }

    fs.mkdirSync(PERFIL, { recursive: true });

    const capturas = [];
    const abertas = new Map();
    const websockets = [];
    let encerrando = false;
    let cdp = null;
    let processo = null;

    function imprimir(item) {
        const marca = item.status >= 400 ? '!!' : ' >';
        console.log(`${marca} [${item.metodo}] ${item.status || '???'} ${hostDe(item.url)}${caminhoDe(item.url)} (${item.tamanhoResposta || 0} chars)`);

        if (item.corpoEnviado) {
            console.log('       enviado: ' + item.corpoEnviado.replace(/\s+/g, ' ').slice(0, 240));
        }
    }

    async function fecharRequisicao(idRequisicao) {
        const item = abertas.get(idRequisicao);
        if (!item) return;
        abertas.delete(idRequisicao);

        try {
            const corpo = await cdp.enviar('Network.getResponseBody', { requestId: idRequisicao });
            const texto = corpo.base64Encoded
                ? Buffer.from(corpo.body, 'base64').toString('utf8')
                : String(corpo.body == null ? '' : corpo.body);
            item.corpoResposta = texto.slice(0, LIMITE_CORPO);
            item.tamanhoResposta = texto.length;
        } catch (erro) {
            item.corpoResposta = '(corpo não disponível)';
            item.tamanhoResposta = 0;
        }

        // O HTML do Streamlit não ajuda em nada.
        const ehHtml = /html/i.test(item.mime || '');
        if (item.tipo === 'Document' && ehHtml) return;

        capturas.push(item);
        imprimir(item);
    }

    function salvar() {
        const hosts = {};
        capturas.forEach((item) => {
            const host = hostDe(item.url);
            hosts[host] = (hosts[host] || 0) + 1;
        });

        fs.writeFileSync(opcoes.saida, JSON.stringify({
            capturadoEm: new Date().toISOString(),
            urlInicial: opcoes.url,
            hosts,
            websockets,
            chamadas: capturas
        }, null, 2), 'utf8');

        console.log('');
        console.log('Salvo em: ' + opcoes.saida);
        console.log('Chamadas HTTP: ' + capturas.length + ' | websockets: ' + websockets.length);
        console.log('Eventos CDP: ' + eventosRecebidos + ' | requisições brutas: ' + pedidosBrutos);

        Object.keys(hosts).sort((a, b) => hosts[b] - hosts[a]).forEach((host) => {
            console.log('  ' + String(hosts[host]).padStart(3) + 'x  ' + host);
        });

        const hostDoSite = hostDe(opcoes.url);
        const outros = Object.keys(hosts).filter((host) => host !== hostDoSite);

        if (capturas.length === 0 && outros.length === 0) {
            console.log('');
            console.log('Nenhuma chamada HTTP apareceu. Se você fez uma consulta e nada foi');
            console.log('capturado, o app é 100% Streamlit: os dados vão por websocket binário');
            console.log('(_stcore/stream) e não existe API HTTP para integrar.');
        }
    }

    function finalizar(codigo) {
        if (encerrando) return;
        encerrando = true;

        try {
            salvar();
        } catch (erro) {
            console.error('Falha ao salvar: ' + erro.message);
        }

        if (opcoes.fechar && processo && processo.pid) {
            spawnSync('taskkill', ['/PID', String(processo.pid), '/T', '/F'], { stdio: 'ignore' });
        }

        process.exit(codigo || 0);
    }

    process.on('SIGINT', () => finalizar(0));

    console.log('Abrindo o Chrome (perfil separado: ' + PERFIL + ') ...');
    console.log('Faça login e depois UMA consulta de exemplo dentro dessa janela.');

    processo = spawn(navegador, [
        '--remote-debugging-port=' + PORTA,
        '--user-data-dir=' + PERFIL,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,950',
        opcoes.url
    ], { stdio: 'ignore' });

    processo.on('exit', () => {
        if (!encerrando) {
            console.log('O Chrome foi fechado.');
            finalizar(0);
        }
    });

    await esperarDevtools();
    const pagina = await acharPagina();
    cdp = await conectarCdp(pagina.webSocketDebuggerUrl);

    console.log('Conectado na aba: "' + (pagina.title || '') + '" (' + pagina.url + ')');

    let eventosRecebidos = 0;
    let pedidosBrutos = 0;

    cdp.aoReceber((mensagem) => {
        const dados = mensagem.params || {};
        eventosRecebidos += 1;

        if (process.env.DEBUG_CAPTURA) console.log('   evento: ' + mensagem.method);

        if (mensagem.method === 'Network.requestWillBeSent') {
            pedidosBrutos += 1;
            const pedido = dados.request || {};
            if (!interessa(pedido.url)) return;

            abertas.set(dados.requestId, {
                hora: new Date().toISOString(),
                tipo: dados.type || '',
                metodo: pedido.method || '',
                url: pedido.url,
                cabecalhos: filtrarCabecalhos(pedido.headers),
                corpoEnviado: pedido.postData ? String(pedido.postData).slice(0, LIMITE_CORPO) : '',
                status: 0,
                mime: '',
                corpoResposta: ''
            });
            return;
        }

        if (mensagem.method === 'Network.responseReceived') {
            const item = abertas.get(dados.requestId);
            if (!item) return;
            item.status = dados.response.status;
            item.mime = dados.response.mimeType || '';
            item.cabecalhosResposta = filtrarCabecalhos(dados.response.headers);
            return;
        }

        if (mensagem.method === 'Network.loadingFinished') {
            fecharRequisicao(dados.requestId);
            return;
        }

        if (mensagem.method === 'Network.loadingFailed') {
            abertas.delete(dados.requestId);
            return;
        }

        if (mensagem.method === 'Network.webSocketCreated') {
            websockets.push({ hora: new Date().toISOString(), url: dados.url });
            console.log(' > [WS] ' + dados.url);
        }
    });

    await cdp.enviar('Network.enable', {
        maxTotalBufferSize: 50000000,
        maxResourceBufferSize: 5000000
    });
    await cdp.enviar('Page.enable');

    await new Promise((resolver) => setTimeout(resolver, 1500));
    await cdp.enviar('Page.reload', { ignoreCache: true });

    console.log('');
    console.log('Capturando... (Ctrl+C encerra e salva)');

    if (opcoes.segundos > 0) {
        console.log('Encerro sozinho em ' + opcoes.segundos + ' segundos.');
        setTimeout(() => finalizar(0), opcoes.segundos * 1000);
    }

    cdp.aoFechar(() => {
        if (!encerrando) {
            console.log('A conexão com o Chrome caiu.');
            finalizar(0);
        }
    });
}

principal().catch((erro) => {
    console.error('Erro: ' + erro.message);
    process.exitCode = 1;
});


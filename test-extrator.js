'use strict';
/* =========================================================
   Testes do extrator automático (Chrome) no painel.

   Cobre o que apareceu no uso real pelo Render: o container não
   tem Chrome, a consulta devolvia "sem retorno" para todo CPF e
   não dizia o porquê. Agora o extrator se recusa a consultar
   (codigo 'sem-chrome') e o painel mostra o caminho local.
   ========================================================= */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extrator = require('./extrator');

/* ---------- detecção do navegador ---------- */

assert.strictEqual(typeof extrator.acharNavegador, 'function', 'acharNavegador exportado');
assert.strictEqual(typeof extrator.motivoIndisponivel, 'function', 'motivoIndisponivel exportado');

assert.strictEqual(extrator.acharNavegador([]), '', 'lista vazia não acha navegador');
assert.strictEqual(
    extrator.acharNavegador(['C:\\pasta\\que\\nao\\existe\\chrome.exe']),
    '',
    'caminho inexistente é ignorado'
);
assert.strictEqual(extrator.acharNavegador([__filename]), __filename, 'usa o primeiro caminho existente');

console.log('OK - extrator: detecção do navegador (CHROME_PATH, Windows, Linux, macOS)');

/* ---------- motivo da indisponibilidade ---------- */

assert.strictEqual(extrator.motivoIndisponivel('', false), 'sem-chrome', 'sem binário = sem-chrome');
assert.strictEqual(extrator.motivoIndisponivel('/usr/bin/google-chrome', false), 'chrome-fechado', 'binário sem janela = chrome-fechado');
assert.strictEqual(extrator.motivoIndisponivel('/usr/bin/google-chrome', true), '', 'conectado = pronto');

console.log('OK - extrator: motivo (sem-chrome / chrome-fechado / pronto)');

/* ---------- status() expõe a situação ---------- */

const situacao = extrator.status();

assert.strictEqual(typeof situacao.chrome, 'boolean', 'status.chrome é booleano');
assert.strictEqual(typeof situacao.navegador, 'boolean', 'status.navegador é booleano');
assert.strictEqual(typeof situacao.motivo, 'string', 'status.motivo é texto');
assert.strictEqual(typeof situacao.porta, 'number', 'status.porta é número');
assert.strictEqual(situacao.ocupado, false, 'sem consulta em andamento no início');
assert.strictEqual(situacao.progresso, null, 'sem progresso no início');

console.log('OK - extrator: status() informa chrome, navegador e motivo');

/* ---------- headless (container sem tela) ---------- */

const headlessOriginal = process.env.EXTRATOR_HEADLESS;
const uaOriginal = process.env.EXTRATOR_USER_AGENT;

function comHeadless(valor, funcao) {
    if (valor === null) delete process.env.EXTRATOR_HEADLESS;
    else process.env.EXTRATOR_HEADLESS = valor;

    try {
        return funcao();
    } finally {
        if (headlessOriginal === undefined) delete process.env.EXTRATOR_HEADLESS;
        else process.env.EXTRATOR_HEADLESS = headlessOriginal;
    }
}

assert.strictEqual(comHeadless('1', () => extrator.modoHeadless()), true, 'EXTRATOR_HEADLESS=1 liga o modo headless');
assert.strictEqual(comHeadless('true', () => extrator.modoHeadless()), true, 'aceita true');
assert.strictEqual(comHeadless('0', () => extrator.modoHeadless()), false, 'EXTRATOR_HEADLESS=0 abre janela');
assert.strictEqual(comHeadless('nao', () => extrator.modoHeadless()), false, 'aceita nao');
assert.strictEqual(
    typeof comHeadless(null, () => extrator.modoHeadless()),
    'boolean',
    'sem a variável o padrão é decidido pela plataforma'
);
assert.strictEqual(typeof extrator.status().headless, 'boolean', 'status.headless é booleano');

console.log('OK - extrator: modo headless configurável por EXTRATOR_HEADLESS');

/* ---------- flags do Chrome ---------- */

const flagsHeadless = comHeadless('1', () => extrator.flagsNavegador('https://exemplo.test/'));

['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-setuid-sandbox'].forEach((flag) => {
    assert.ok(flagsHeadless.includes(flag), 'headless inclui ' + flag);
});
assert.ok(flagsHeadless[0].startsWith('--remote-debugging-port='), 'primeira flag é a porta de depuração');
assert.ok(flagsHeadless.some((flag) => flag.startsWith('--user-data-dir=')), 'usa perfil dedicado');
assert.strictEqual(flagsHeadless[flagsHeadless.length - 1], 'https://exemplo.test/', 'a URL fica por último');
assert.ok(!flagsHeadless.some((flag) => flag.startsWith('--user-agent=')), 'sem EXTRATOR_USER_AGENT não força UA');

process.env.EXTRATOR_USER_AGENT = 'Mozilla/5.0 (Teste)';
const flagsComUa = comHeadless('1', () => extrator.flagsNavegador());
assert.ok(flagsComUa.includes('--user-agent=Mozilla/5.0 (Teste)'), 'EXTRATOR_USER_AGENT vira flag');
if (uaOriginal === undefined) delete process.env.EXTRATOR_USER_AGENT;
else process.env.EXTRATOR_USER_AGENT = uaOriginal;

const flagsJanela = comHeadless('0', () => extrator.flagsNavegador());

assert.ok(!flagsJanela.includes('--headless=new'), 'sem headless não passa --headless');
assert.ok(!flagsJanela.includes('--no-sandbox'), 'sem headless mantém o sandbox');
assert.ok(flagsJanela.includes('--window-size=1400,1000'), 'janela continua no tamanho de sempre');
assert.ok(/^https:\/\/extratorgov\.online\/$/.test(flagsJanela[flagsJanela.length - 1]), 'sem URL usa o site padrão');

console.log('OK - extrator: flags do Chrome (headless, sandbox, /dev/shm, janela)');

/* ---------- imagem Docker com Chromium ---------- */

const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
const dockerignore = fs.readFileSync(path.join(__dirname, '.dockerignore'), 'utf8');
const guia = fs.readFileSync(path.join(__dirname, 'EXTRATOR-CHROME.md'), 'utf8');

assert.ok(/^FROM node:/m.test(dockerfile), 'Dockerfile usa imagem Node oficial');
assert.ok(dockerfile.includes('chromium'), 'Dockerfile instala o Chromium');
assert.ok(dockerfile.includes('CHROME_PATH=/usr/bin/chromium'), 'Dockerfile aponta o CHROME_PATH');
assert.ok(dockerfile.includes('EXTRATOR_HEADLESS=1'), 'Dockerfile liga o modo headless');
assert.ok(dockerfile.includes('CMD ["node", "index.js"]'), 'Dockerfile sobe o painel');

['node_modules', '.env'].forEach((entrada) => {
    assert.ok(dockerignore.split(/\r?\n/).includes(entrada), '.dockerignore ignora ' + entrada);
});

assert.ok(guia.includes('EXTRATOR_HEADLESS'), 'guia explica o modo headless');
assert.ok(guia.includes('no-sandbox'), 'guia explica o --no-sandbox');
assert.ok(/Docker/i.test(guia), 'guia explica o deploy com Docker');

console.log('OK - imagem Docker: Chromium instalado, headless ligado e guia de deploy');

/* ---------- detecção única (navegador.js) ---------- */

const moduloNavegador = require('./navegador');
const mapearFonte = fs.readFileSync(path.join(__dirname, 'mapear-tela.js'), 'utf8');
const consultarFonte = fs.readFileSync(path.join(__dirname, 'consultar-extrator.js'), 'utf8');

['acharNavegador', 'motivoIndisponivel', 'modoHeadless', 'flagsNavegador', 'encerrarProcesso'].forEach((nome) => {
    assert.strictEqual(typeof moduloNavegador[nome], 'function', 'navegador.js exporta ' + nome);
});

assert.strictEqual(extrator.acharNavegador, moduloNavegador.acharNavegador, 'extrator usa a detecção única');
assert.strictEqual(extrator.modoHeadless, moduloNavegador.modoHeadless, 'extrator usa o mesmo modo headless');

assert.ok(mapearFonte.includes("require('./navegador')"), 'mapear-tela usa navegador.js');
assert.ok(mapearFonte.includes('navegador.flagsNavegador'), 'mapear-tela abre o Chrome com as mesmas flags');
assert.ok(consultarFonte.includes("require('./navegador')"), 'consultar-extrator usa navegador.js');
assert.ok(!/taskkill/.test(mapearFonte), 'mapear-tela fecha o navegador sem taskkill (funciona em Linux)');
assert.ok(!/taskkill/.test(consultarFonte), 'consultar-extrator fecha o navegador sem taskkill (funciona em Linux)');
assert.ok(!/taskkill/.test(fs.readFileSync(path.join(__dirname, 'extrator.js'), 'utf8')), 'extrator fecha o navegador sem taskkill (funciona em Linux)');

console.log('OK - navegador.js: detecção e abertura compartilhadas entre os scripts');

/* ---------- servidor sem Chrome: recusa em vez de "sem retorno" ---------- */

const existeOriginal = fs.existsSync;

(async () => {
    /* finge um container sem navegador nenhum — nenhum Chrome é aberto
       e nenhuma consulta real chega ao extratorgov.online */
    fs.existsSync = () => false;

    try {
        let semChrome = null;
        try {
            await extrator.consultarCpfs(['52998224725']);
        } catch (erro) {
            semChrome = erro;
        }

        assert.ok(semChrome, 'consulta sem Chrome falha na hora (não devolve linha sem retorno)');
        assert.strictEqual(semChrome.codigo, 'sem-chrome', 'erro marcado com codigo sem-chrome');
        assert.ok(semChrome.message.indexOf('Chrome') >= 0, 'mensagem explica a falta do Chrome');

        console.log('OK - extrator: sem Chrome a consulta é recusada com codigo sem-chrome');

        /* validação de entrada continua antes da checagem do navegador */
        let semCpf = null;
        try {
            await extrator.consultarCpfs(['sem numero aqui']);
        } catch (erro) {
            semCpf = erro;
        }
        assert.ok(semCpf && semCpf.codigo === 400, 'entrada inválida responde 400');

        const vinteSeis = Array.from({ length: 26 }, (_, indice) => String(10000000000 + indice));

        let muitos = null;
        try {
            await extrator.consultarCpfs(vinteSeis);
        } catch (erro) {
            muitos = erro;
        }
        assert.ok(muitos && muitos.codigo === 400, 'acima de 25 CPFs responde 400');
        assert.ok(/Máximo de 25/.test(muitos.message), 'mensagem diz o limite de 25 por consulta');
    } finally {
        fs.existsSync = existeOriginal;
    }

    console.log('OK - extrator: validação de entrada (CPF ausente e limite de 25)');

    /* ---------- integração: aviso no painel e resposta da API ---------- */

    const raiz = __dirname;
    const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
    const painel = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
    const servidor = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
    const estilos = fs.readFileSync(path.join(raiz, 'style.css'), 'utf8');

    assert.ok(html.includes('id="suja-extrator-aviso"'), 'aviso do passo 2 na tela Listas');
    assert.ok(html.includes('id="extrator-aviso"'), 'aviso na tela Consultar CPF');
    assert.ok(html.includes('id="btn-consultar-cpfs"'), 'botão de consultar tem id para ser desabilitado');
    assert.ok(html.includes('onclick="copiarComandoExtrator()"'), 'botão Copiar comando');
    assert.ok(html.includes('node extrator.js testar cpfs.txt'), 'comando do script local no HTML');
    assert.ok(html.includes('class="aviso-extrator oculto"'), 'avisos começam ocultos');

    ['verificarExtratorPainel', 'renderizarAvisoExtrator', 'copiarComandoExtrator'].forEach((nome) => {
        assert.ok(new RegExp('function ' + nome + '\\(').test(painel), 'app.js define ' + nome);
    });
    assert.ok(painel.includes("const COMANDO_EXTRATOR = 'node extrator.js testar cpfs.txt'"), 'comando centralizado no app.js');
    assert.ok(
        painel.indexOf('extratorSituacao.navegador === false') >= 0,
        'consultar/levar verificam o aviso de sem Chrome'
    );

    assert.ok(servidor.includes("codigo: 'sem-chrome'"), 'API devolve codigo sem-chrome');
    assert.ok(servidor.includes('res.status(503).json({'), 'API responde 503 quando não há Chrome');

    assert.ok(estilos.includes('.aviso-extrator'), 'estilo do aviso de sem Chrome');
    assert.ok(estilos.includes('.aviso-extrator code'), 'estilo do comando no aviso');

    console.log('OK - integração: aviso no painel, resposta 503 e CSS');
    console.log('');
    console.log('Todos os testes do extrator automático passaram.');
})().catch((erro) => {
    fs.existsSync = existeOriginal;
    console.error(erro);
    process.exitCode = 1;
});

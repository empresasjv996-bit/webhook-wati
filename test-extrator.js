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

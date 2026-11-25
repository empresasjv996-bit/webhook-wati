/* =========================================================
   QGC TEAM by JV - Teste do filtro "Analisar conversas de"
   ---------------------------------------------------------
   Confere que a tela Conversas manda o colaborador escolhido
   em ?vendedor= para /api/clientes, que o select é montado com
   os donos dos leads e que a rota do servidor é só do admin.
   Roda com: node test-conversas-filtro.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------
   1. app.js: o select vira querystring
   --------------------------------------------------------- */
const elementos = {};

function elemento(id) {
    if (!elementos[id]) {
        elementos[id] = {
            id,
            innerHTML: '',
            textContent: '',
            value: '',
            children: [],
            dataset: {},
            classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
            appendChild(filho) { this.children.push(filho); },
            setAttribute() {},
            remove() {}
        };
    }
    return elementos[id];
}

const chamadas = [];

async function fetchFalso(url) {
    const endereco = String(url);
    chamadas.push(endereco);

    if (endereco.indexOf('/api/clientes/vendedores') === 0) {
        return {
            ok: true,
            json: async () => ([
                { email: 'colaborador@qgcteam.com', nome: 'Claudio', total: 3, ativos: 2 },
                { email: 'vendedor@qgcteam.com', nome: 'Vendedor Jv', total: 1, ativos: 1 }
            ])
        };
    }

    return { ok: true, json: async () => ([]) };
}

const documento = {
    readyState: 'loading',
    addEventListener() {},
    getElementById: elemento,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => elemento('novo-' + Math.random())
};

const contexto = {
    document: documento,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchFalso,
    URLSearchParams,
    alert: () => {},
    confirm: () => true,
    Notification: function Notification() {},
    EventSource: function EventSource() { this.close = () => {}; },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { reload() {} }
};

contexto.window = contexto;
contexto.globalThis = contexto;

vm.createContext(contexto);
vm.runInContext(fs.readFileSync('app.js', 'utf8'), contexto, { filename: 'app.js' });

(async () => {
    /* o select nasce com "Todos" e ganha um item por colaborador */
    const colaboradores = await contexto.carregarVendedoresConversas(true);
    assert.strictEqual(colaboradores.length, 2, 'dois colaboradores com conversas');

    const select = elemento('filtro-conversas-vendedor');
    assert.ok(select.innerHTML.indexOf('Todos os colaboradores') >= 0, 'opção "Todos" no select');
    assert.ok(select.innerHTML.indexOf('Claudio') >= 0, 'nome do colaborador no select');
    assert.ok(select.innerHTML.indexOf('(3)') >= 0, 'total de conversas no rótulo');

    /* escolher um colaborador filtra a lista no servidor */
    contexto.filtrarConversasPorVendedor('colaborador@qgcteam.com');
    await dormir(20);

    const urlFiltrada = chamadas.filter((endereco) => endereco.indexOf('/api/clientes?') === 0).pop();
    assert.ok(urlFiltrada, 'a lista de conversas foi buscada');
    assert.ok(urlFiltrada.indexOf('vendedor=colaborador%40qgcteam.com') >= 0,
        'colaborador escolhido vai na querystring: ' + urlFiltrada);
    assert.ok(elemento('contact-list').innerHTML.indexOf('Nenhuma conversa desse colaborador') >= 0,
        'lista vazia avisa que o colaborador não tem conversas');

    /* voltar para "Todos" remove o parâmetro */
    contexto.filtrarConversasPorVendedor('');
    await dormir(20);

    const urlTodos = chamadas.filter((endereco) => endereco.indexOf('/api/clientes?') === 0).pop();
    assert.ok(urlTodos.indexOf('vendedor=') === -1, 'sem colaborador escolhido não filtra: ' + urlTodos);

    /* ---------------------------------------------------------
       2. Guardas de código: HTML, servidor e banco
       --------------------------------------------------------- */
    const html = fs.readFileSync('index.html', 'utf8');
    assert.ok(/id="filtro-conversas-vendedor"/.test(html), 'select do filtro está no index.html');
    assert.ok(/Analisar conversas de/.test(html), 'rótulo do filtro está no index.html');
    assert.ok(/onchange="filtrarConversasPorVendedor\(this\.value\)"/.test(html), 'select chama filtrarConversasPorVendedor');
    assert.ok(/onclick="atualizarConversas\(\)"/.test(html), 'botão Atualizar refaz o filtro');

    const index = fs.readFileSync('index.js', 'utf8');
    assert.ok(/app\.get\('\/api\/clientes\/vendedores', exigirAdmin/.test(index),
        'rota /api/clientes/vendedores existe e exige admin');
    assert.ok(/listarVendedoresDosLeads\(\)/.test(index), 'rota usa banco.listarVendedoresDosLeads');

    const banco = fs.readFileSync('db.js', 'utf8');
    assert.strictEqual((banco.match(/async listarVendedoresDosLeads\(\)/g) || []).length, 2,
        'listarVendedoresDosLeads existe no Postgres e no modo demo');

    const css = fs.readFileSync('style.css', 'utf8');
    assert.ok(/\.filtro-conversas select/.test(css), 'estilo do select do filtro');

    console.log('OK - filtro "Analisar conversas de" filtra por colaborador e é restrito ao admin');
})().catch((erro) => {
    console.error(erro);
    process.exitCode = 1;
});

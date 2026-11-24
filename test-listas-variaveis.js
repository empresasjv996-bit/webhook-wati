/* Testes do formato "lista por variáveis" ({{1}}, {{2}}...).
   Roda com: node test-listas-variaveis.js  — não abre o servidor. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---------- app.js (importação no navegador) ---------- */
function elementoFalso() {
    return {
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        style: {},
        dataset: {},
        value: '',
        innerHTML: '',
        appendChild() {},
        removeChild() {},
        click() {},
        setAttribute() {},
        addEventListener() {},
        querySelector() { return elementoFalso(); },
        querySelectorAll() { return []; }
    };
}

function carregarApp() {
    const documento = {
        readyState: 'loading', // evita iniciarPainel() no fim do arquivo
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return elementoFalso(); },
        body: { appendChild() {}, removeChild() {} }
    };

    const janela = {
        fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
        location: { href: '' }
    };

    const contexto = {
        window: janela,
        document: documento,
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        location: janela.location,
        navigator: { userAgent: 'node' },
        console,
        setTimeout, clearTimeout, setInterval, clearInterval,
        fetch: janela.fetch,
        Blob: function Blob() {},
        URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
        EventSource: function EventSource() {},
        Notification: { permission: 'default', requestPermission: async () => 'default' },
        AudioContext: function AudioContext() {}
    };

    vm.createContext(contexto);
    vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), contexto, { filename: 'app.js' });
    return contexto;
}

const app = carregarApp();
const noApp = (codigo) => vm.runInContext(codigo, app);
/* Objetos criados dentro do vm têm outro protótipo; compara pelo JSON. */
const limpo = (valor) => JSON.parse(JSON.stringify(valor));

/* Cabeçalhos aceitos para variável */
assert.strictEqual(noApp(`chaveVariavelColuna('{{1}}')`), '1');
assert.strictEqual(noApp(`chaveVariavelColuna('{{ nome }}')`), 'nome');
assert.strictEqual(noApp(`chaveVariavelColuna('var1')`), '1');
assert.strictEqual(noApp(`chaveVariavelColuna('variavel_2')`), '2');
assert.strictEqual(noApp(`chaveVariavelColuna('Nome')`), '');
assert.strictEqual(noApp(`chaveVariavelColuna('cnpj')`), '');

/* Leitura do CSV com cabeçalho de variáveis */
const tabela = noApp(`lerTabelaCsv('telefone;{{1}};{{2}}\\n5511999999999;João;12.345.678/0001-90')`);
assert.deepStrictEqual(limpo(tabela.colunas), ['telefone', '{{1}}', '{{2}}']);
assert.strictEqual(tabela.linhas.length, 1);

/* Montagem dos contatos: variáveis separadas dos atributos */
const contatos = noApp(`
    tabelaLista = {
        colunas: ['telefone', '{{1}}', '{{2}}', 'CNPJ'],
        linhas: [
            ['5511999999999', 'João da Silva', '12.345.678/0001-90', 'empresa-x'],
            ['5511888888888', 'Maria Souza', '98.765.432/0001-10', 'empresa-y'],
            ['123', 'Inválido', '', '']
        ],
        mapa: ['telefone', 'variavel', 'variavel', 'cnpj'],
        custom: ['', '', '', ''],
        variaveis: ['', '1', '2', '']
    };
    montarContatosDaLista();
`);

assert.strictEqual(contatos.length, 2);
assert.deepStrictEqual(limpo(contatos[0].variaveis), { 1: 'João da Silva', 2: '12.345.678/0001-90' });
assert.strictEqual(contatos[0].atributos.cnpj, 'empresa-x');
assert.strictEqual(contatos[0].telefone, '5511999999999');
assert.deepStrictEqual(limpo(contatos[1].variaveis), { 1: 'Maria Souza', 2: '98.765.432/0001-10' });

/* Lista antiga (sem variáveis) continua funcionando */
const antigos = noApp(`
    tabelaLista = {
        colunas: ['telefone', 'Nome'],
        linhas: [['5511999999999', 'Ana']],
        mapa: ['telefone', 'nome'],
        custom: ['', '']
    };
    montarContatosDaLista();
`);
assert.strictEqual(antigos[0].nome, 'Ana');
assert.deepStrictEqual(limpo(antigos[0].variaveis), {});

/* Variável nome também alimenta o campo nome do contato */
const comNome = noApp(`
    tabelaLista = {
        colunas: ['telefone', '{{nome}}'],
        linhas: [['5511999999999', 'Carlos']],
        mapa: ['telefone', 'variavel'],
        custom: ['', ''],
        variaveis: ['', 'nome']
    };
    montarContatosDaLista();
`);
assert.strictEqual(comNome[0].nome, 'Carlos');
assert.deepStrictEqual(limpo(comNome[0].variaveis), { nome: 'Carlos' });

/* Prévia da campanha mostra {{1}} em vez de "1" */
const preview = noApp(`
    mapaVariaveisCampanha = {
        '1': { origem: 'atributo', valor: '1' },
        '2': { origem: 'fixo', valor: 'QGC TEAM by JV' }
    };
    montarPreviewTemplate({ corpo: 'Olá {{1}}, sobre {{2}}.', variaveis: ['1', '2'] });
`);
assert.strictEqual(preview, 'Olá «{{1}}», sobre QGC TEAM by JV.');

console.log('OK - importação no formato de listas por variáveis');

/* ---------- Validar listas: arquivo local rende só telefones ---------- */
const doArquivo = limpo(noApp(`
    extrairTelefonesValidacao([
        'CPF Persona:            256.255.598-80',
        'CNPJ:                   26.526.968/0001-40',
        'CEP:                    09820-020',
        'Inicio Atividade:       11/11/2016',
        'Tel Empresa 1:          (11) 4362-1043',
        'Telefone cadastro:      55 (**) ***** 7130',
        'Final visivel:          7130',
        'Telefones:',
        '    (11) 4238-3161',
        '    1532265950',
        '    1532265950',
        'Telefone desmascarado:  (19) 98955-7130',
        'Razao Social:           GRAZIELA CAPRONI 31422348881',
        'Tel Empresa 2:          000000000000',
        'Movel 011 9876-5432 e +55 21 99876-5432'
    ].join('\\n'))
`));

assert.deepStrictEqual(doArquivo, [
    '(11) 4362-1043',
    '(11) 4238-3161',
    '1532265950',
    '(19) 98955-7130',
    '011 9876-5432',
    '+55 21 99876-5432'
]);

/* Nada de CPF/CNPJ/CEP/data virando telefone */
assert.strictEqual(noApp(`pareceTelefoneValidacao('31422348881')`), false);
assert.strictEqual(noApp(`pareceTelefoneValidacao('38454528890')`), false);
assert.strictEqual(noApp(`pareceTelefoneValidacao('09820020')`), false);
assert.strictEqual(noApp(`pareceTelefoneValidacao('11987654321')`), true);
assert.strictEqual(noApp(`pareceTelefoneValidacao('5511987654321')`), true);

console.log('OK - leitura de arquivo na validação aproveita só telefones');

/* ---------- index.js (resolução no envio) ---------- */
const { valorDoContato } = require('./index.js');

assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', nome: '', atributos: {}, variaveis: { 1: 'João' } }, '1'),
    'João'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', variaveis: { 1: 'João' } }, '{{1}}'),
    'João'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', nome: '', variaveis: { nome: 'Maria' } }, 'nome'),
    'Maria'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', nome: 'Ana', variaveis: { nome: 'Maria' } }, 'nome'),
    'Ana'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', atributos: { cnpj: '12.345.678/0001-90' } }, 'cnpj'),
    '12.345.678/0001-90'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', atributos: { 1: 'atributo' }, variaveis: { 1: 'variável' } }, '1'),
    'variável'
);
assert.strictEqual(
    valorDoContato({ telefone: '5511999999999', atributos: {} }, '1'),
    ''
);

console.log('OK - resolução das variáveis no envio da campanha');


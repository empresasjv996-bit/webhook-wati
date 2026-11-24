/* =========================================================
   QGC TEAM by JV - Testes do processador de Lista Suja
   Cenários UAT do briefing + unidades do parser.
   Roda com: node test-lista-suja.js
   ========================================================= */

'use strict';

const assert = require('assert');
const {
    processarListaSuja,
    validarCpf,
    formatarCnpj,
    normalizarTelefone,
    extrairTelefones,
    segmentarRegistros
} = require('./lista-suja');

/* ---------- UAT 1: cenário positivo (MARCOS TOBIAS LIMA) ---------- */

const blocoMarcos = [
    'CPF Persona:            123.456.789-09',
    'CNPJ:                   27.964.767/0001-97',
    'Email cadastro:         marcos@exemplo.com',
    'Telefone cadastro:      (12) 3153-3128',
    'Nome:                   MARCOS TOBIAS LIMA',
    'Nascimento:             10/05/1985',
    'Nome da mae:            MARIA TOBIAS LIMA',
    'Sexo:                   Masculino',
    'Telefones:',
    '    (12) 99711-2233',
    '    (12) 99711-2233',
    '    (12) 3153-3129',
    '    +55 12 99888-7766',
    '    012 3456-7890',
    'Endereco:               RUA DAS FLORES, 123 - CENTRO'
].join('\n');

const resultadoMarcos = processarListaSuja(blocoMarcos);

assert.strictEqual(resultadoMarcos.registros, 1, '1 registro detectado');
assert.strictEqual(resultadoMarcos.descartados.length, 0, 'nenhum descarte');
assert.strictEqual(resultadoMarcos.linhas.length, 5, '5 linhas na saída (1 por telefone)');

assert.deepStrictEqual(resultadoMarcos.linhas, [
    '551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '5512997112233;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '551231533129;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '5512998887766;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '551234567890;MARCOS TOBIAS LIMA;27.964.767/0001-97'
], 'formato {telefone};{nome};{cnpj} exato');

console.log('OK - UAT 1: cenário positivo (5 linhas, formato exato)');

/* ---------- UAT 2: CPF inválido ---------- */

const blocoCpfInvalido = [
    'CPF Persona:            529.982.247-24',  // dígito verificador errado (válido é 25)
    'CNPJ:                   27.964.767/0001-97',
    'Telefone cadastro:      (12) 3153-3128',
    'Nome:                   PESSOA CPF ERRADO'
].join('\n');

const resultadoCpfInvalido = processarListaSuja(blocoCpfInvalido);

assert.strictEqual(resultadoCpfInvalido.linhas.length, 0, 'nada na lista verde');
assert.strictEqual(resultadoCpfInvalido.descartados.length, 1, '1 descarte');
assert.strictEqual(resultadoCpfInvalido.descartados[0].motivo, 'CPF Inválido', 'motivo exato');

console.log('OK - UAT 2: CPF inválido vai para descartados com motivo');

/* ---------- UAT 3: sem telefone ---------- */

const blocoSemTelefone = [
    'CPF Persona:            529.982.247-25',  // CPF válido (dígitos conferem)
    'CNPJ:                   27.964.767/0001-97',
    'Telefone cadastro:      ---',
    'Nome:                   PESSOA SEM TELEFONE',
    'Telefones:',
    '    (sem registro)'
].join('\n');

const resultadoSemTelefone = processarListaSuja(blocoSemTelefone);

assert.strictEqual(resultadoSemTelefone.linhas.length, 0, 'nada na lista verde');
assert.strictEqual(resultadoSemTelefone.descartados.length, 1, '1 descarte');
assert.strictEqual(resultadoSemTelefone.descartados[0].motivo, 'Sem Telefone Válido', 'motivo exato');

console.log('OK - UAT 3: sem telefone vai para descartados com motivo');

/* ---------- UAT 4: deduplicação (coberto no UAT 1: 1297112233 repetido) ---------- */

const blocoDuplicado = [
    'CPF Persona:            123.456.789-09',
    'Telefone cadastro:      (11) 98765-4321',
    'Nome:                   PESSOA DUPLICADA',
    'Telefones:',
    '    11987654321',
    '    (11) 98765-4321'
].join('\n');

const resultadoDuplicado = processarListaSuja(blocoDuplicado);

assert.strictEqual(resultadoDuplicado.linhas.length, 1, 'mesmo telefone gera 1 linha só');
assert.strictEqual(resultadoDuplicado.linhas[0], '5511987654321;PESSOA DUPLICADA;', 'linha única');

console.log('OK - UAT 4: deduplicação de telefone por registro');

/* ---------- UAT 5: performance (1.000 registros < 2s) ---------- */

const blocoBase = [
    'CPF Persona:            123.456.789-09',
    'CNPJ:                   27.964.767/0001-97',
    'Telefone cadastro:      (12) 3153-3128',
    'Nome:                   PESSOA TESTE'
].join('\n');

const milRegistros = Array.from({ length: 1000 }, () => blocoBase).join('\n\n');

const inicio = Date.now();
const resultadoMil = processarListaSuja(milRegistros);
const duracao = Date.now() - inicio;

assert.strictEqual(resultadoMil.registros, 1000, '1000 registros detectados');
assert.strictEqual(resultadoMil.linhas.length, 1000, '1000 linhas na saída');
assert.ok(duracao < 2000, 'processou em ' + duracao + 'ms (limite 2000ms)');

console.log('OK - UAT 5: 1.000 registros em ' + duracao + 'ms');

/* ---------- unidades ---------- */

assert.strictEqual(validarCpf('123.456.789-09'), true, 'CPF de teste válido');
assert.strictEqual(validarCpf('529.982.247-25'), true, 'CPF de teste válido');
assert.strictEqual(validarCpf('529.982.247-24'), false, 'dígito verificador errado');
assert.strictEqual(validarCpf('111.111.111-11'), false, 'sequência repetida rejeitada');
assert.strictEqual(validarCpf('123'), false, 'curto demais');

assert.strictEqual(formatarCnpj('27964767000197'), '27.964.767/0001-97', 'CNPJ formatado');

assert.strictEqual(normalizarTelefone('(11) 98765-4321'), '5511987654321');
assert.strictEqual(normalizarTelefone('+55 21 99876-5432'), '5521998765432');
assert.strictEqual(normalizarTelefone('011 9876-5432'), '551198765432');
assert.strictEqual(normalizarTelefone('1532265950'), '551532265950');
assert.strictEqual(normalizarTelefone('7130'), null, 'curto demais rejeitado');
assert.strictEqual(normalizarTelefone('55 (**) ***** 7130'), null, 'mascarado não vira telefone');

assert.deepStrictEqual(
    extrairTelefones('(11) 4238-3161\n1532265950\n000000000000\nMovel 011 9876-5432 e +55 21 99876-5432'),
    ['551142383161', '551198765432', '5521998765432', '551532265950'],
    'extração com máscara e crus'
);

const doisRegistros = blocoMarcos + '\n\n' + blocoSemTelefone;
assert.strictEqual(segmentarRegistros(doisRegistros).length, 2, 'segmenta 2 registros');

console.log('OK - unidades do parser (CPF, CNPJ, telefone, segmentação)');

/* ---------- integração da tela (index.html + app.js + lista branca) ---------- */

const fs = require('fs');
const path = require('path');

const raiz = __dirname;
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const painel = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
const servidor = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
const estilos = fs.readFileSync(path.join(raiz, 'style.css'), 'utf8');

assert.ok(html.includes('id="view-listasuja"'), 'tela "Processar Lista" existe no index.html');
assert.ok(html.includes('id="suja-texto"'), 'textarea da lista bruta');
assert.ok(html.includes('id="suja-saida"'), 'textarea do resultado');
assert.ok(html.includes('id="tabela-suja-descartados"'), 'tabela de descartados');
assert.ok(html.includes('onclick="processarListaSujaPainel()"'), 'botão Processar Lista');
assert.ok(html.includes('onclick="copiarListaSuja()"'), 'botão Copiar');
assert.ok(html.includes('onclick="baixarListaSuja()"'), 'botão Baixar .txt');
assert.ok(html.includes('<script src="lista-suja.js"></script>'), 'parser carregado no index.html');
assert.ok(
    html.indexOf('src="lista-suja.js"') < html.indexOf('src="app.js"'),
    'lista-suja.js precisa vir antes de app.js'
);

['mostrarAbaListaSuja', 'renderizarListaSuja', 'processarListaSujaPainel', 'copiarListaSuja',
    'baixarListaSuja', 'usarListaSujaNaImportacao', 'limparListaSuja'].forEach((nome) => {
    assert.ok(new RegExp('function ' + nome + '\\(').test(painel), 'app.js define ' + nome);
});

assert.ok(painel.includes("'telefone;{{1}};{{2}}'"), 'enviar para a importação usa telefone;{{1}};{{2}}');
assert.ok(servidor.includes("'lista-suja.js'"), 'lista-suja.js está na lista branca de estáticos');
assert.ok(estilos.includes('.suja-bruto'), 'estilo do trecho bruto do descarte');
assert.ok(estilos.includes('.suja-tabs'), 'estilo das abas');

console.log('OK - integração da tela (HTML, app.js, lista branca e CSS)');
console.log('');
console.log('Todos os testes do processador de Lista Suja passaram.');

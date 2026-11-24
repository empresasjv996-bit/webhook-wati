/* Teste rápido dos formatos de template da Wati (v3 e v1). Roda com:
   node test-templates.js  — não abre o servidor. */
const assert = require('assert');
const { normalizarTemplateWati, renderizarMensagemTemplate } = require('./index.js');

const v3 = normalizarTemplateWati({
    id: 'abc',
    name: 'pedido_atualizado',
    status: 'APPROVED',
    category: 'UTILITY',
    language_option: { key: 'pt_BR', value: 'pt_BR', text: 'Português (BR)' },
    body: 'Olá {{1}}, seu pedido {{2}} foi atualizado.',
    custom_params: [{ name: 'nome_cliente', value: '' }, { name: 'numero_pedido', value: '' }]
});

assert.strictEqual(v3.idioma, 'pt_BR');
assert.deepStrictEqual(v3.variaveis, ['nome_cliente', 'numero_pedido']);
assert.strictEqual(v3.aprovado, true);
assert.strictEqual(
    renderizarMensagemTemplate(v3.corpo, [
        { name: 'nome_cliente', value: 'Ana' },
        { name: 'numero_pedido', value: '123' }
    ], v3.variaveis),
    'Olá Ana, seu pedido 123 foi atualizado.'
);

const v1 = normalizarTemplateWati({
    name: 'boas_vindas',
    status: 'APPROVED',
    language: 'pt_BR',
    body: 'Olá {{nome}}, tudo bem?',
    customParams: [{ name: 'nome' }]
});

assert.deepStrictEqual(v1.variaveis, ['nome']);
assert.strictEqual(renderizarMensagemTemplate(v1.corpo, [{ name: 'nome', value: 'Ana' }]), 'Olá Ana, tudo bem?');

const midia = normalizarTemplateWati({
    name: 'com_imagem',
    status: 'APPROVED',
    language: 'pt_BR',
    body: 'Confira {{1}}',
    custom_params: [{ name: 'produto' }],
    header: { type: 'IMAGE', header_param_mapping: { param_name: 'imagem_url' } }
});

assert.deepStrictEqual(midia.variaveis, ['produto', 'imagem_url']);

const semNomes = normalizarTemplateWati({
    name: 'posicional',
    status: 'APPROVED',
    language: 'pt_BR',
    body: '{{1}} e {{2}}'
});

assert.deepStrictEqual(semNomes.variaveis, ['1', '2']);

const pendente = normalizarTemplateWati({
    name: 'em_analise',
    status: 'PENDING',
    language: 'pt_BR',
    body: 'Oi {{1}}'
});

assert.strictEqual(pendente.aprovado, false);

const comBotoes = normalizarTemplateWati({
    name: 'com_botao',
    status: 'APPROVED',
    language: 'pt_BR',
    body: 'Olá {{1}}',
    custom_params: [{ name: 'nome' }],
    buttons: [{ type: 'URL', parameter: { url: 'https://x.test/{{2}}' } }]
});

assert.deepStrictEqual(comBotoes.variaveis, ['nome', '2']);

console.log('OK - normalização e prévia dos templates validados.');

/* Testes da consulta de CNPJ (dados públicos da empresa).
   Roda com: node test-cnpj.js
   Não abre o servidor e não acessa a internet. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
    somenteDigitos,
    validarCnpj,
    formatarCnpj,
    formatarCnae,
    normalizarEmpresa,
    telefonesDaEmpresa
} = require('./cnpj');

/* ---------- dígito verificador ---------- */
assert.strictEqual(validarCnpj('11.222.333/0001-81').valido, true, 'CNPJ formatado válido');
assert.strictEqual(validarCnpj('11222333000181').valido, true, 'CNPJ só dígitos válido');
assert.strictEqual(validarCnpj('33.000.167/0001-01').valido, true, 'Petrobras');
assert.strictEqual(validarCnpj('04.252.011/0001-10').valido, true, 'Banco do Brasil');

const cnpjErrado = validarCnpj('11.222.333/0001-80');
assert.strictEqual(cnpjErrado.valido, false, 'dígito verificador errado é recusado');
assert.strictEqual(cnpjErrado.motivo, 'dígito verificador não confere');

assert.strictEqual(validarCnpj('1122233300018').valido, false, '13 dígitos é recusado');
assert.strictEqual(validarCnpj('00000000000000').valido, false, 'dígitos repetidos é recusado');
assert.strictEqual(validarCnpj('').valido, false, 'vazio é recusado');

assert.strictEqual(somenteDigitos('11.222.333/0001-81'), '11222333000181');
assert.strictEqual(formatarCnpj('11222333000181'), '11.222.333/0001-81');
assert.strictEqual(formatarCnpj('123'), '123', 'CNPJ incompleto não é formatado');
assert.strictEqual(formatarCnae(4930202), '4930-2/02');
assert.strictEqual(formatarCnae('4930-2/02'), '4930-2/02');
assert.strictEqual(formatarCnae(600001), '0600-0/01', 'CNAE numérico perde o zero à esquerda');
assert.strictEqual(formatarCnae('0600001'), '0600-0/01');

/* ---------- telefones da empresa ---------- */
const telefones = telefonesDaEmpresa({
    ddd_telefone_1: '1130621010',
    ddd_telefone_2: '(11) 98765-4321',
    telefone: '1130621010'
});

assert.strictEqual(telefones.length, 2, 'telefone repetido não entra duas vezes');
assert.deepStrictEqual(telefones[0], {
    numero: '1130621010',
    formatado: '(11) 3062-1010',
    wati: '551130621010',
    tipo: 'fixo'
});
assert.strictEqual(telefones[1].wati, '5511987654321', 'celular vai para a Wati com DDI 55');
assert.strictEqual(telefones[1].tipo, 'celular');

const telefoneEstranho = telefonesDaEmpresa({ ddd_telefone_1: '7130' });
assert.strictEqual(telefoneEstranho.length, 1);
assert.strictEqual(telefoneEstranho[0].wati, '', 'número mascarado/curto não vira telefone Wati');
assert.deepStrictEqual(telefonesDaEmpresa({}), [], 'sem telefone publicado');

/* ---------- normalização da resposta pública ---------- */
const empresa = normalizarEmpresa({
    cnpj: '26.526.968/0001-40',
    razao_social: 'EMPRESA EXEMPLO LTDA',
    nome_fantasia: 'EXEMPLO',
    descricao_situacao_cadastral: 'ATIVA',
    data_situacao_cadastral: '2000-01-01',
    data_inicio_atividade: '1998-05-20',
    porte: 'DEMAIS',
    natureza_juridica: '206-2 - Sociedade Empresária Limitada',
    capital_social: 100000,
    cnae_fiscal: 4930202,
    cnae_fiscal_descricao: 'Transporte rodoviário de carga',
    cnaes_secundarios: [{ codigo: 4930201, descricao: 'Transporte rodoviário de carga municipal' }],
    logradouro: 'R LUIZA GUAZZELI BATTISTIN',
    numero: '60',
    complemento: 'SALA 2',
    bairro: 'DEMARCHI',
    municipio: 'SAO BERNARDO DO CAMPO',
    uf: 'SP',
    cep: '09820-020',
    ddd_telefone_1: '1130621010',
    email: 'Contato@Exemplo.com.br',
    qsa: [{
        nome_socio: 'FULANO DE TAL',
        qualificacao_socio: '49 - Sócio-Administrador',
        cnpj_cpf_do_socio: '***123456**',
        cpf_representante_legal: '123.456.789-00',
        nome_representante_legal: 'REPRESENTANTE'
    }]
});

assert.strictEqual(empresa.cnpj, '26526968000140');
assert.strictEqual(empresa.cnpjFormatado, '26.526.968/0001-40');
assert.strictEqual(empresa.razaoSocial, 'EMPRESA EXEMPLO LTDA');
assert.strictEqual(empresa.nomeFantasia, 'EXEMPLO');
assert.strictEqual(empresa.situacao, 'ATIVA');
assert.strictEqual(empresa.cnae, '4930-2/02');
assert.strictEqual(empresa.cnaesSecundarios[0].codigo, '4930-2/01');
assert.strictEqual(empresa.email, 'contato@exemplo.com.br');
assert.strictEqual(empresa.cep, '09820020');
assert.strictEqual(
    empresa.endereco,
    'R LUIZA GUAZZELI BATTISTIN, 60 - SALA 2 - DEMARCHI, SAO BERNARDO DO CAMPO - SP, CEP 09820-020'
);
assert.strictEqual(empresa.telefones[0].wati, '551130621010');

/* Sócios: apenas nome e qualificação; CPF/CNPJ do sócio é descartado. */
assert.deepStrictEqual(empresa.socios, [{ nome: 'FULANO DE TAL', qualificacao: '49 - Sócio-Administrador' }]);

const serializado = JSON.stringify(empresa);
assert.ok(!/cnpj_cpf_do_socio|123456|cpf_representante|123\.456\.789/.test(serializado),
    'CPF/CNPJ de sócio não pode sair na normalização');
assert.ok(!/representante/i.test(serializado), 'representante legal não entra');

/* Resposta vazia/incompleta não quebra. */
const vazia = normalizarEmpresa(null);
assert.strictEqual(vazia.razaoSocial, '');
assert.strictEqual(vazia.cnpjFormatado, '');
assert.deepStrictEqual(vazia.telefones, []);

/* ---------- ligação com o painel (sem abrir o servidor) ---------- */
const raiz = __dirname;
const ler = (arquivo) => fs.readFileSync(path.join(raiz, arquivo), 'utf8');

const html = ler('index.html');
const app = ler('app.js');
const servidor = ler('index.js');

assert.ok(html.includes('id="cnpj-texto"'), 'index.html tem a caixa de CNPJ');
assert.ok(html.includes('id="tabela-cnpj"'), 'index.html tem a tabela de CNPJ');
assert.ok(html.includes('onclick="consultarCnpjsValidacao()"'), 'botão de consulta no HTML');
assert.ok(html.includes('onclick="baixarCnpjValidacao()"'), 'botão de .csv no HTML');

['consultarCnpjsValidacao', 'renderizarCnpjValidacao', 'usarTelefoneCnpj', 'usarTodosTelefonesCnpj', 'baixarCnpjValidacao']
    .forEach((nome) => assert.ok(app.includes('function ' + nome), 'app.js tem ' + nome));

assert.ok(app.includes("'/api/cnpj/consultar'"), 'app.js chama a rota de CNPJ');
assert.ok(/split\(\/\[\\r\\n,;\]\+\//.test(app), 'entrada de CNPJ aceita várias linhas');

assert.ok(servidor.includes("app.post('/api/cnpj/consultar', exigirAdmin"), 'rota exige administrador');
assert.ok(servidor.includes('brasilapi.com.br/api/cnpj/v1/'), 'usa a BrasilAPI');
assert.ok(servidor.includes('minhareceita.org/'), 'tem fallback na Minha Receita');
assert.ok(servidor.includes('pedidos.length > 20'), 'limite de 20 CNPJs por consulta');

/* A consulta de CNPJ em si continua pública; o extrator é usado só pela rota nova. */
const trechoCnpj = servidor.slice(
    servidor.indexOf("app.post('/api/cnpj/consultar'"),
    servidor.indexOf('CONSULTA DE CPF NO EXTRATOR')
);
assert.ok(!/extrator|saldo|credencial/i.test(trechoCnpj), 'consulta de CNPJ não usa o extrator pago');
assert.ok(servidor.includes("app.post('/api/extrator/consultar', exigirAdmin"), 'rota do extrator exige administrador');

/* ---------- tela: tabela e atalho para a lista ---------- */
function carregarTela() {
    const elementos = {};
    const documento = {
        readyState: 'loading', // evita iniciarPainel() no fim do app.js
        addEventListener() {},
        getElementById(id) { return elementos[id] || null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() {
            return {
                classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
                style: {}, click() {}, setAttribute() {}, remove() {},
                appendChild() {}, removeChild() {}
            };
        },
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

    elementos['tabela-cnpj'] = { innerHTML: '' };
    elementos['coletados-lista'] = { textContent: '' };

    return { elementos, noVm: (codigo) => vm.runInContext(codigo, contexto) };
}

const tela = carregarTela();

tela.noVm(`
    consultaCnpj = [{
        status: 'ok',
        original: '33.000.167/0001-01',
        cnpj: '33000167000101',
        cnpjFormatado: '33.000.167/0001-01',
        razaoSocial: 'PETROLEO BRASILEIRO S A PETROBRAS',
        nomeFantasia: '',
        situacao: 'ATIVA',
        endereco: 'REPUBLICA DO CHILE, 65 - CENTRO, RIO DE JANEIRO - RJ',
        cnae: '0600-0/01',
        cnaeDescricao: 'Extração de petróleo',
        telefones: [{ numero: '2121660000', formatado: '(21) 2166-0000', wati: '552121660000', tipo: 'fixo' }],
        email: 'contato@empresa.com.br',
        fonte: 'BrasilAPI'
    }, {
        status: 'invalido',
        original: '11.222.333/0001-80',
        message: 'dígito verificador não confere'
    }];
    renderizarCnpjValidacao();
`);

const htmlCnpj = tela.elementos['tabela-cnpj'].innerHTML;

assert.ok(htmlCnpj.includes('33.000.167/0001-01'), 'tabela mostra o CNPJ formatado');
assert.ok(htmlCnpj.includes('PETROLEO BRASILEIRO S A PETROBRAS'), 'tabela mostra a razão social');
assert.ok(htmlCnpj.includes('(21) 2166-0000'), 'tabela mostra o telefone da empresa');
assert.ok(htmlCnpj.includes('usarTelefoneCnpj(0, 0)'), 'botão manda o telefone para a validação');
assert.ok(htmlCnpj.includes('usarTodosTelefonesCnpj(0)'), 'botão “Todos” da empresa');
assert.ok(htmlCnpj.includes('CNPJ inválido'), 'tabela avisa o CNPJ inválido');
assert.ok(htmlCnpj.includes('contato@empresa.com.br'), 'tabela mostra o e-mail');
assert.ok(!htmlCnpj.includes('<script'), 'nenhum HTML da resposta é injetado');

/* Atalho: telefone da empresa vai para os coletados sem duplicar. */
tela.noVm(`adicionarColetado('552121660000', '(21) 2166-0000')`);
tela.noVm(`adicionarColetado('552121660000', '(21) 2166-0000')`);

let coletados = tela.noVm(`telefonesColetados.join(',')`);
assert.strictEqual(coletados, '552121660000', 'não duplica o número coletado');

tela.noVm(`adicionarColetado('5511987654321', '(11) 98765-4321')`);
coletados = tela.noVm(`telefonesColetados.join(',')`);
assert.strictEqual(coletados, '552121660000,5511987654321', 'acumula os coletados');

assert.strictEqual(
    tela.elementos['coletados-lista'].textContent,
    '552121660000  |  5511987654321',
    'painel de coletados mostra os números prontos para a Wati'
);

console.log('OK - testes de CNPJ (dígito, normalização, telefone e ligação com o painel).');

'use strict';
/* =========================================================
   Testes do Motor de Verificação SpyHub.

   Duas camadas:
     1. parser puro (spyhub-parser.js) — CPF, blocos do dump,
        CSV com aspas, dedupe, ignorados e exportações;
     2. integração da tela — rotas em /api/spyhub, HTML, app.js
        e CSS, garantindo que o painel chama o backend certo.
   Nenhum acesso real ao app.spyhub.io é feito aqui.
   ========================================================= */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const parser = require('./spyhub-parser');
const spyhub = require('./spyhub');

const ler = (arquivo) => fs.readFileSync(path.join(__dirname, arquivo), 'utf8');

/* ---------- CPF: dígito verificador e formatação ---------- */

assert.strictEqual(parser.validarCpf('529.982.247-25'), true, 'CPF válido com máscara');
assert.strictEqual(parser.validarCpf('52998224725'), true, 'CPF válido sem máscara');
assert.strictEqual(parser.validarCpf('111.444.777-35'), true, 'outro CPF válido');
assert.strictEqual(parser.validarCpf('529.982.247-24'), false, 'dígito verificador errado é recusado');
assert.strictEqual(parser.validarCpf('111.111.111-11'), false, 'CPF repetido é recusado');
assert.strictEqual(parser.validarCpf('5299822472'), false, 'CPF com 10 dígitos é recusado');
assert.strictEqual(parser.validarCpf(''), false, 'CPF vazio é recusado');

assert.strictEqual(parser.formatarCpf('52998224725'), '529.982.247-25', 'formata CPF');
assert.strictEqual(parser.formatarCnpj('21420227000166'), '21.420.227/0001-66', 'formata CNPJ');
assert.strictEqual(parser.normalizarChave('Final visível'), 'final_visivel', 'normaliza rótulo com acento');
assert.strictEqual(parser.apenasDigitos('(19) 99220-0906'), '19992200906', 'só os dígitos do telefone');
assert.strictEqual(parser.finalDe('55 (**) ***** 0906'), '0906', 'últimos 4 dígitos de telefone mascarado');

console.log('OK - spyhub: CPF (dígito verificador, máscara, repetidos) e utilitários');

/* ---------- leitura de um bloco do dump ---------- */

const BLOCO_VALIDO = [
    'CNPJ: 21420227000166',
    'Razao Social: ACOUGUE E MERCEARIA SAO JOAO LTDA',
    'Nome Fantasia: MERCEARIA SAO JOAO',
    '--- DADOS DA EMPRESA ---',
    'Logradouro: RUA DAS FLORES, 100',
    'Bairro: CENTRO',
    'Cidade: CAMPINAS',
    'CEP: 13010-000',
    'Tel Empresa 1: (19) 3272-2219',
    '--- DADOS DA PERSONA ---',
    'CPF Persona: 529.982.247-25',
    'Nome Persona: JOAO DA SILVA',
    'Telefones:',
    '(19) 99220-0906',
    '(19) 3272-2219',
    'Telefone cadastro: 55 (**) ***** 0906',
    'Final visivel: 0906'
].join('\n');

const campos = parser.lerCampos(BLOCO_VALIDO);

assert.strictEqual(campos.razao_social, 'ACOUGUE E MERCEARIA SAO JOAO LTDA',
    'título de seção não entra no valor do campo anterior');
assert.strictEqual(campos.cpf_persona, '529.982.247-25', 'CPF Persona lido');
assert.strictEqual(campos.final_visivel, '0906', 'Final visivel lido');
assert.ok(campos.telefones.indexOf('99220-0906') >= 0, 'Telefones multilinha preservados');
assert.ok(campos.telefones.indexOf('3272-2219') >= 0, 'todos os telefones do bloco entram');

console.log('OK - spyhub: leitura de campos do dump (seções e telefones multilinha)');

/* ---------- blocos: com e sem a linha de ===== ---------- */

const BLOCO_INVALIDO = [
    'CNPJ: 11222333000181',
    'Razao Social: EMPRESA TESTE',
    'CPF Persona: 111.111.111-11',
    'Final visivel: 1234'
].join('\n');

const BLOCO_SEM_FINAL = [
    'CNPJ: 11222333000181',
    'Razao Social: OUTRA EMPRESA',
    'CPF Persona: 111.444.777-35',
    'Telefone cadastro: 55 19 98888-7777'
].join('\n');

const DUMP_COM_SEPARADOR = [BLOCO_VALIDO, '============================================',
    BLOCO_INVALIDO, '============================================', BLOCO_SEM_FINAL].join('\n');

const blocos = parser.separarBlocos(DUMP_COM_SEPARADOR);
assert.strictEqual(blocos.length, 3, 'dump com ===== vira 3 blocos');
assert.ok(blocos[0].indexOf('529.982.247-25') >= 0, 'primeiro bloco preservado');
assert.ok(!/=====/.test(blocos[1]), 'linha de separador não fica no bloco');

const DUMP_COLADO = [BLOCO_VALIDO, BLOCO_SEM_FINAL].join('\n');
assert.strictEqual(parser.separarBlocos(DUMP_COLADO).length, 2,
    'dump sem separador quebra no próximo CNPJ depois do CPF Persona');

assert.strictEqual(parser.separarBlocos('texto solto\nsem nenhum campo').length, 0,
    'bloco sem CNPJ/CPF Persona é descartado');

console.log('OK - spyhub: separação de blocos (=====, dump colado, lixo)');

/* ---------- dump -> registros ---------- */

const doDump = parser.registrosDoDump(DUMP_COM_SEPARADOR);

assert.strictEqual(doDump.formato, 'dump', 'formato identificado como dump');
assert.strictEqual(doDump.registros.length, 2, 'dois registros válidos no dump');
assert.strictEqual(doDump.ignorados.length, 1, 'CPF repetido cai nos ignorados');
assert.ok(/inválido/i.test(doDump.ignorados[0].motivo), 'motivo do ignorado explica o CPF inválido');

const primeiro = doDump.registros[0];

assert.strictEqual(primeiro.cpf, '52998224725', 'CPF só com dígitos');
assert.strictEqual(primeiro.cpfFormatado, '529.982.247-25', 'CPF formatado para a tela');
assert.strictEqual(primeiro.nome, 'JOAO DA SILVA', 'nome da persona vem de "Nome Persona"');
assert.strictEqual(primeiro.cnpjFormatado, '21.420.227/0001-66', 'CNPJ formatado');
assert.deepStrictEqual(primeiro.finais, ['0906'], 'final vem de "Final visivel"');
assert.strictEqual(primeiro.razaoSocial, 'ACOUGUE E MERCEARIA SAO JOAO LTDA', 'razão social do bloco');
assert.strictEqual(primeiro.nomeFantasia, 'MERCEARIA SAO JOAO', 'nome fantasia do bloco');
assert.strictEqual(primeiro.telefoneDesmascarado, '(19) 3272-2219', 'telefone da empresa como desmascarado');
assert.strictEqual(primeiro.endereco, 'RUA DAS FLORES, 100, CENTRO, CAMPINAS, 13010-000',
    'endereço montado de logradouro/bairro/cidade/cep');
assert.ok(primeiro.ficha.indexOf('CPF Persona: 529.982.247-25') >= 0, 'ficha completa preservada');

assert.deepStrictEqual(doDump.registros[1].finais, ['7777'],
    'sem "Final visivel", usa o fim de "Telefone cadastro"');
assert.strictEqual(doDump.registros[1].cpfFormatado, '111.444.777-35', 'segundo CPF válido');

const repetido = parser.registrosDoDump([BLOCO_VALIDO, BLOCO_VALIDO].join('\n=====\n'));
assert.strictEqual(repetido.registros.length, 1, 'mesmo CPF/final não entra duas vezes');
assert.strictEqual(repetido.ignorados[0].motivo, 'Registro repetido', 'repetido é marcado como tal');

/* nome: rótulo genérico funciona e "Nome da mae" não é confundido com a persona */
const BLOCO_NOME_GENERICO = [
    'CNPJ: 11222333000181',
    'CPF Persona: 111.444.777-35',
    'Nome: MARIA SOUZA',
    'Nome da mae: ANA SOUZA',
    'Final visivel: 1234'
].join('\n');

const comNome = parser.registrosDoDump(BLOCO_NOME_GENERICO);
assert.strictEqual(comNome.registros.length, 1, 'bloco com "Nome:" continua válido');
assert.strictEqual(comNome.registros[0].nome, 'MARIA SOUZA', '"Nome:" genérico é aceito como nome da persona');
assert.ok(comNome.registros[0].nome.indexOf('ANA') === -1, '"Nome da mae" não entra como nome da persona');

const semNome = parser.registrosDoDump(BLOCO_INVALIDO.replace('111.111.111-11', '111.444.777-35'));
assert.strictEqual(semNome.registros[0].nome, '', 'bloco sem nome fica com nome vazio (não inventa valor)');

console.log('OK - spyhub: dump -> registros (final, nome, endereço, ficha, dedupe)');

/* ---------- CSV ---------- */

const CSV = [
    'cnpj;cpf;razao_social;nome_fantasia;telefone_desmascarado;endereco;final',
    '21.420.227/0001-66;529.982.247-25;"ACOUGUE; MERCEARIA";MERCEARIA;"(19) 99220-0906";"RUA A, 10, CENTRO";0906',
    '21.420.227/0001-66;529.982.247-25;REPETIDA;REPETIDA;11999999999;RUA B;0906',
    '11.222.333/0001-81;111.111.111-11;INVALIDA;INVALIDA;11999999999;RUA C;4321'
].join('\r\n');

assert.strictEqual(parser.pareceCsv(CSV), true, 'CSV com cabeçalho reconhecido');
assert.strictEqual(parser.pareceCsv(DUMP_COM_SEPARADOR), false, 'dump não é confundido com CSV');
assert.strictEqual(parser.detectarSeparador('a;b;c'), ';', 'separador ponto e vírgula');

const doCsv = parser.registrosDoCsv(CSV);

assert.strictEqual(doCsv.formato, 'csv', 'formato csv');
assert.strictEqual(doCsv.registros.length, 1, 'uma linha válida depois do dedupe');
assert.strictEqual(doCsv.registros[0].razaoSocial, 'ACOUGUE; MERCEARIA',
    'aspas duplas preservam o separador dentro da célula');
assert.strictEqual(doCsv.registros[0].telefoneDesmascarado, '(19) 99220-0906', 'telefone desmascarado do CSV');
assert.deepStrictEqual(doCsv.registros[0].finais, ['0906'], 'final do CSV');
assert.strictEqual(doCsv.ignorados.length, 2, 'repetido + CPF inválido ignorados');

const CSV_COM_VIRGULA = [
    'cpf,telefone_cadastro,razao_social',
    '11144477735,55 19 98888-7777,"EMPRESA, COM VIRGULA"'
].join('\n');

const csvVirgula = parser.registrosDoCsv(CSV_COM_VIRGULA);
assert.strictEqual(csvVirgula.registros.length, 1, 'CSV com vírgula aceito');
assert.strictEqual(csvVirgula.registros[0].razaoSocial, 'EMPRESA, COM VIRGULA', 'vírgula dentro de aspas');
assert.deepStrictEqual(csvVirgula.registros[0].finais, ['7777'], 'final veio do telefone_cadastro');

/* coluna nome no CSV (aceita "nome", "nome_persona" e "nome_completo") */
const CSV_COM_NOME = [
    'cnpj;cpf;nome;telefone_cadastro;razao_social',
    '21.420.227/0001-66;529.982.247-25;JOAO DA SILVA;55 19 98888-7777;ACOUGUE'
].join('\n');

const csvNome = parser.registrosDoCsv(CSV_COM_NOME);
assert.strictEqual(csvNome.registros.length, 1, 'CSV com coluna nome aceito');
assert.strictEqual(csvNome.registros[0].nome, 'JOAO DA SILVA', 'coluna nome do CSV vira registro.nome');

const CSV_NOME_COMPLETO = [
    'cpf;nome_completo;final',
    '11144477735;MARIA SOUZA;1234'
].join('\n');

assert.strictEqual(parser.registrosDoCsv(CSV_NOME_COMPLETO).registros[0].nome, 'MARIA SOUZA',
    'cabeçalho "nome_completo" também alimenta registro.nome');

console.log('OK - spyhub: CSV (aspas, vírgula, dedupe, final alternativo, coluna nome)');

/* ---------- parseEntrada ---------- */

const entradaDump = parser.parseEntrada(DUMP_COM_SEPARADOR);
assert.strictEqual(entradaDump.formato, 'dump', 'parseEntrada detecta dump');
assert.strictEqual(entradaDump.total, 2, 'total do dump');
assert.strictEqual(entradaDump.ignoradosTotal, 1, 'ignorados do dump');

const entradaCsv = parser.parseEntrada(CSV);
assert.strictEqual(entradaCsv.formato, 'csv', 'parseEntrada detecta CSV');
assert.strictEqual(entradaCsv.total, 1, 'total do CSV');

const entradaVazia = parser.parseEntrada('   ');
assert.strictEqual(entradaVazia.formato, 'vazio', 'entrada vazia marcada como vazio');
assert.strictEqual(entradaVazia.total, 0, 'vazio não gera registros');

console.log('OK - spyhub: parseEntrada escolhe dump/CSV/vazio');

/* ---------- exportações ---------- */

const aprovado = Object.assign({}, primeiro, { razaoSocial: 'ACOUGUE; MERCEARIA' });
const csv = parser.csvDeAprovados([aprovado]);

assert.deepStrictEqual(parser.COLUNAS_APROVADOS,
    ['cnpj', 'cpf_persona', 'nome', 'razao_social', 'nome_fantasia', 'telefone_desmascarado', 'endereco'],
    'ordem das colunas do CSV de aprovados (nome logo depois do CPF)');
assert.ok(csv.startsWith('cnpj;cpf_persona;nome;razao_social;nome_fantasia;telefone_desmascarado;endereco\r\n'),
    'cabeçalho do CSV de aprovados');
assert.ok(csv.indexOf('21.420.227/0001-66;529.982.247-25;JOAO DA SILVA;ACOUGUE, MERCEARIA') >= 0,
    'CSV traz o nome da persona e troca ";" do texto por "," para não quebrar colunas');
assert.ok(csv.indexOf('RUA DAS FLORES') >= 0, 'endereço exportado');
assert.ok(csv.endsWith('\r\n'), 'CSV termina com quebra de linha');

const csvSemNome = parser.csvDeAprovados([{ cpfFormatado: '529.982.247-25', razaoSocial: 'X' }]);
assert.ok(csvSemNome.indexOf('529.982.247-25;;X;') >= 0, 'sem nome, a célula fica vazia (colunas alinhadas)');

const txt = parser.txtDeReprovados([{ cpfFormatado: '529.982.247-25', finais: ['0906'], motivo: 'Nenhum telefone', ficha: BLOCO_VALIDO }]);
assert.ok(txt.startsWith('### 529.982.247-25 - finais 0906 - Nenhum telefone'), 'cabeçalho do TXT de reprovados');
assert.ok(txt.indexOf('CPF Persona: 529.982.247-25') >= 0, 'TXT mantém a ficha completa');

const txtComRetorno = parser.txtDeReprovados([{
    cpfFormatado: '529.982.247-25', finais: ['0906'], motivo: 'Nenhum telefone', ficha: BLOCO_VALIDO,
    retorno: 'Nenhum resultado\nencontrado'
}]);
assert.ok(txtComRetorno.indexOf('Retorno do site: Nenhum resultado encontrado') >= 0,
    'TXT guarda o retorno do site numa linha só (sem quebrar a ficha)');

console.log('OK - spyhub: exportações CSV (aprovados) e TXT (reprovados)');

/* ---------- motor: estado sem abrir o Chrome ---------- */

const situacao = spyhub.status();
assert.strictEqual(typeof situacao.navegador, 'boolean', 'status.navegador é booleano');
assert.strictEqual(typeof situacao.credenciais, 'boolean', 'status.credenciais é booleano');
assert.strictEqual(typeof situacao.headless, 'boolean', 'status.headless é booleano');
assert.strictEqual(situacao.ocupado, false, 'nenhum job rodando nos testes');
assert.strictEqual(situacao.porta, Number(process.env.CDP_PORT_SPYHUB || 9226), 'porta do Chrome dedicado');
assert.ok(/spyhub\.io/.test(situacao.urlBusca), 'status informa a URL de busca');

assert.strictEqual(typeof spyhub.iniciar, 'function', 'iniciar exportado');
assert.strictEqual(typeof spyhub.instantaneo, 'function', 'instantaneo exportado');
assert.strictEqual(spyhub.instantaneo('nao-existe'), null, 'instantaneo devolve null para id desconhecido');

assert.throws(() => spyhub.iniciar([]), /Nenhum registro/, 'iniciar sem registros falha na hora');

const codigoSpyhub = ler('spyhub.js');
assert.ok(!/require\(['"]puppeteer/.test(codigoSpyhub), 'motor usa CDP puro (sem puppeteer)');

/* credenciais nunca no código: compara com o .env sem embutir os valores aqui
   (o .env fica fora do git; se não existir na máquina, o teste só pula) */
const caminhoEnv = path.join(__dirname, '.env');
const segredosEnv = fs.existsSync(caminhoEnv)
    ? (fs.readFileSync(caminhoEnv, 'utf8').match(/^\s*SPYHUB_(?:USUARIO|SENHA)\s*=\s*(.+)$/gim) || [])
        .map((linha) => linha.slice(linha.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''))
        .filter((valor) => valor.length >= 3)
    : [];

segredosEnv.forEach((segredo) => {
    assert.ok(codigoSpyhub.indexOf(segredo) === -1,
        'credencial do .env nunca aparece no código-fonte');
});

assert.ok(codigoSpyhub.indexOf('SPYHUB_USUARIO') >= 0 && codigoSpyhub.indexOf('SPYHUB_SENHA') >= 0,
    'motor lê as credenciais do .env');
assert.ok(codigoSpyhub.indexOf('CDP_PORT_SPYHUB') >= 0, 'porta própria do SpyHub');
assert.ok(codigoSpyhub.indexOf('qgc-painel-spyhub') >= 0, 'perfil de Chrome próprio (não briga com o extrator)');

console.log('OK - spyhub: status() e motor sem Chrome/credenciais no código');

/* ---------- CLI: soltar o socket ao terminar ---------- */

let socketFechado = false;
spyhub.encerrarCli({ fechar() { socketFechado = true; } });
assert.strictEqual(socketFechado, true, 'encerrarCli fecha o socket CDP aberto');
assert.doesNotThrow(() => spyhub.encerrarCli(), 'encerrarCli sem conexão não lança');
assert.ok(/finally\s*\{\s*[\s\S]*?encerrarCli\(\)/.test(codigoSpyhub),
    'principal() chama encerrarCli no finally (CLI não fica pendurado)');

console.log('OK - spyhub: CLI solta o socket CDP ao terminar (não fica pendurado)');

/* ---------- casamento do telefone com os 4 finais ---------- */

const telefones = spyhub.extrairTelefones(
    'Telefones: (19) 3272-2219 / (19) 99220-0906 / 5519992200906 / (19) *****-0906 / CPF 529.982.247-25'
);

assert.ok(telefones.some((item) => item.final === '0906' && item.mascarado === false),
    'extrai telefone completo terminando em 0906');
assert.ok(telefones.some((item) => item.mascarado === true), 'reconhece telefone mascarado');

assert.strictEqual(
    spyhub.acharTelefoneComFinal('Telefones: (19) 3272-2219 (19) 99220-0906', '0906', '52998224725').bruto,
    '(19) 99220-0906',
    'aprova quando algum telefone termina nos 4 dígitos'
);
assert.strictEqual(
    spyhub.acharTelefoneComFinal('Nenhum resultado encontrado', '0906', '52998224725'),
    null,
    'sem telefone no texto = não encontrado'
);
assert.strictEqual(
    spyhub.acharTelefoneComFinal('CPF 529.982.247-25', '4725', '52998224725'),
    null,
    'o próprio CPF não conta como telefone'
);
assert.ok(
    spyhub.acharTelefoneComFinal('Telefone cadastro: 55 (**) ***** 0906', '0906', '52998224725'),
    'telefone mascarado terminando nos dígitos também aprova'
);

console.log('OK - spyhub: casamento do telefone com os 4 finais (máscara e CPF excluídos)');

/* ---------- diferença de texto: só o que a consulta acrescentou ---------- */

const BASE_TELA = 'SPY HUB\nPessoa Fisica\nEssa consulta retorna telefones e emails.\nCONSULTAR';
const TELA_DEPOIS = BASE_TELA + '\nNenhum resultado encontrado para o CPF informado';

assert.strictEqual(
    spyhub.textoNovoDepois(TELA_DEPOIS, BASE_TELA),
    'Nenhum resultado encontrado para o CPF informado',
    'textoNovoDepois ignora as instruções fixas da tela'
);
assert.strictEqual(
    spyhub.textoNovoDepois(TELA_DEPOIS, '').indexOf('Pessoa Fisica') >= 0,
    true,
    'sem base, o texto inteiro é considerado novo'
);

console.log('OK - spyhub: diferença de texto (evita "não encontrado" das instruções)');

/* ---------- integração: rotas, tela e CSS ---------- */

const servidor = ler('index.js');
const rotas = ler(path.join('routes', 'contatos-spyhub.js'));
const html = ler('index.html');
const app = ler('app.js');
const estilos = ler('style.css');
const exemploEnv = ler('.env.exemplo');

assert.ok(servidor.indexOf("require('./routes/contatos-spyhub')") >= 0, 'index.js carrega as rotas do SpyHub');
assert.ok(servidor.indexOf("app.use('/api/spyhub'") >= 0, 'rotas montadas em /api/spyhub');

assert.ok(rotas.indexOf("router.post('/verificar'") >= 0, 'POST /verificar existe');
assert.ok(rotas.indexOf("router.get('/jobs/:id'") >= 0, 'GET /jobs/:id existe');
assert.ok(rotas.indexOf("router.get('/jobs/:id/aprovados.csv'") >= 0, 'exportação CSV no servidor');
assert.ok(rotas.indexOf("router.get('/jobs/:id/reprovados.txt'") >= 0, 'exportação TXT no servidor');
assert.ok(rotas.indexOf("router.post('/fechar'") >= 0, 'POST /fechar existe');
assert.ok(rotas.indexOf('exigirAdmin') >= 0, 'todas as rotas passam pela autenticação de admin');
assert.ok(rotas.indexOf('sem-registros') < 0 || rotas.indexOf("'sem-chrome'") >= 0,
    'rota trata a falta de Chrome');
assert.ok(rotas.indexOf('parseEntrada') >= 0, 'parser roda no backend');

assert.ok(html.indexOf('id="view-spyhub"') >= 0, 'tela Verificação SpyHub existe');
assert.ok(html.indexOf('data-view="spyhub"') >= 0, 'botão no menu leva para a tela');
assert.ok(html.indexOf('id="spyhub-texto"') >= 0, 'caixa para colar a lista');
assert.ok(html.indexOf('id="spyhub-arquivo"') >= 0, 'upload do arquivo .txt/.csv');
assert.ok(html.indexOf('onclick="executarVerificacaoSpyhub()"') >= 0, 'botão Executar Verificação');
assert.ok(html.indexOf('id="tabela-spyhub-aprovados"') >= 0, 'tabela de aprovados');
assert.ok(html.indexOf('<th>Nome</th>') >= 0, 'tabela de aprovados tem a coluna Nome');
assert.ok(app.indexOf("escaparHtml(item.nome || '')") >= 0, 'app.js mostra o nome do aprovado na tabela');
assert.ok(html.indexOf('id="lista-spyhub-reprovados"') >= 0, 'lista de reprovados');
assert.ok(html.indexOf('onclick="baixarSpyhubAprovados()"') >= 0, 'botão de exportar aprovados');
assert.ok(html.indexOf('onclick="baixarSpyhubReprovados()"') >= 0, 'botão de exportar reprovados');

['executarVerificacaoSpyhub', 'carregarArquivoSpyhub', 'verificarSpyhubStatus', 'renderizarSpyhub',
    'acompanharSpyhub', 'baixarSpyhubAprovados', 'baixarSpyhubReprovados', 'limparSpyhub'].forEach((nome) => {
        assert.ok(app.indexOf('function ' + nome) >= 0, 'app.js define ' + nome);
    });

assert.ok(app.indexOf("'/api/spyhub/verificar'") >= 0, 'app.js envia a lista para /api/spyhub/verificar');
assert.ok(app.indexOf("'/api/spyhub/jobs/'") >= 0, 'app.js acompanha o job por polling');
assert.ok(app.indexOf("spyhub: 'Verificação SpyHub'") >= 0, 'título da tela no mapa de navegação');
assert.ok(app.indexOf("if (view === 'spyhub') verificarSpyhubStatus(true);") >= 0, 'tela checa o Chrome ao abrir');

assert.ok(estilos.indexOf('.spyhub-log') >= 0, 'CSS do log');
assert.ok(estilos.indexOf('.spyhub-linha.ok') >= 0, 'CSS das linhas aprovadas');
assert.ok(estilos.indexOf('.spyhub-ficha') >= 0, 'CSS das fichas reprovadas');
assert.ok(estilos.indexOf('.spyhub-texto') >= 0, 'CSS da caixa de entrada');

assert.ok(exemploEnv.indexOf('SPYHUB_USUARIO') >= 0 && exemploEnv.indexOf('SPYHUB_SENHA') >= 0,
    '.env.exemplo documenta as credenciais do SpyHub');
assert.ok(exemploEnv.indexOf('CDP_PORT_SPYHUB') >= 0, '.env.exemplo documenta a porta própria');

console.log('OK - spyhub: rota /api/spyhub, tela, handlers, CSS e .env.exemplo');

/* ---------- rotas de verdade (router chamado sem abrir porta) ---------- */

const criarRotasSpyhub = require('./routes/contatos-spyhub');

(async () => {
    /* admin liberado de propósito: aqui só testamos a lógica das rotas.
       Sem servidor HTTP: em Windows com proxy/firewall o loopback falha
       de forma intermitente (ETIMEDOUT) e o teste ficaria instável. */
    const router = criarRotasSpyhub({ exigirAdmin: (req, res, next) => next() });

    const chamarRota = (metodo, caminho, corpo) => new Promise((ok, falhar) => {
        const req = { method: metodo, url: caminho, originalUrl: caminho, body: corpo || {}, headers: {}, query: {}, params: {} };
        const res = {
            statusCode: 200,
            cabecalhos: {},
            corpo: undefined,
            status(codigo) { this.statusCode = codigo; return this; },
            setHeader(nome, valor) { this.cabecalhos[String(nome).toLowerCase()] = valor; },
            json(dados) { this.corpo = dados; ok({ status: this.statusCode, corpo: dados, cabecalhos: this.cabecalhos }); },
            send(dados) { this.corpo = dados; ok({ status: this.statusCode, corpo: dados, cabecalhos: this.cabecalhos }); },
            end() { ok({ status: this.statusCode, corpo: this.corpo, cabecalhos: this.cabecalhos }); }
        };

        Promise.resolve(router.handle(req, res, () => ok({ status: 404, corpo: {} }))).catch(falhar);
    });

    const status = await chamarRota('GET', '/status');
    assert.strictEqual(status.status, 200, 'GET /status responde 200');
    assert.strictEqual(status.corpo.success, true, 'GET /status marca success');
    assert.strictEqual(typeof status.corpo.navegador, 'boolean', 'GET /status informa o Chrome');
    assert.strictEqual(typeof status.corpo.credenciais, 'boolean', 'GET /status informa as credenciais');

    const vazio = await chamarRota('POST', '/verificar', {});
    assert.strictEqual(vazio.status, 400, 'lista vazia responde 400');

    const semRegistro = await chamarRota('POST', '/verificar', { texto: 'texto sem CPF nem CNPJ' });
    assert.strictEqual(semRegistro.status, 400, 'texto sem registros responde 400');
    assert.ok(/Nenhum registro/i.test(semRegistro.corpo.message), 'mensagem explica que não há registros');

    const grande = await chamarRota('POST', '/verificar', { texto: 'x'.repeat(2 * 1024 * 1024 + 10) });
    assert.strictEqual(grande.status, 413, 'lista acima de 2 MB responde 413');
    assert.ok(/muito grande/i.test(grande.corpo.message), 'mensagem pede para dividir a lista');

    const jobInexistente = await chamarRota('GET', '/jobs/00000000-0000-0000-0000-000000000000');
    assert.strictEqual(jobInexistente.status, 404, 'job desconhecido responde 404');

    const csvInexistente = await chamarRota('GET', '/jobs/nao-existe/aprovados.csv');
    assert.strictEqual(csvInexistente.status, 404, 'exportação de job desconhecido responde 404');

    console.log('OK - spyhub: rotas /status, /verificar e /jobs/:id respondem como esperado');
    console.log('\nTodos os testes do SpyHub passaram.');
})().catch((falha) => {
    console.error(falha);
    process.exit(1);
});





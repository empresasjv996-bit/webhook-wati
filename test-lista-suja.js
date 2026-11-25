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
    segmentarRegistros,
    normalizarEntradaExtrator,
    aplicarResultadoExtrator,
    montarLinhasComEmpresa,
    montarCadastroCsv,
    mascararCpf,
    cpfCombina
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
assert.strictEqual(resultadoSemTelefone.descartados.length, 0, 'CPF válido não é descartado por falta de telefone');
assert.strictEqual(resultadoSemTelefone.semTelefone.length, 1, '1 registro aguardando o extrator');
assert.deepStrictEqual(resultadoSemTelefone.cpfs, ['529.982.247-25'], 'CPF completo formatado na lista do extrator');

console.log('OK - UAT 3: sem telefone fica aguardando o extrator (não é descartado)');

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

/* ---------- UAT 6: dump LIVE C6 PJ (empresa + persona + sócios) ---------- */

const blocoLive = [
    '  CNPJ:                   27964767000197',
    '  CPF Persona:            014.079.598-75',
    '  Email cadastro:         pr*****@gmail.com',
    '  Telefone cadastro:      55 (**) ***** 9400',
    '  Final visivel:          9400',
    '',
    '  --- DADOS DA EMPRESA ---',
    '  Razao Social:           IMPERIAL MARKETING E PROPAGANDA LTDA',
    '  Nome Fantasia:          IMP',
    '  Situacao:               ATIVA',
    '  Porte:                  ME',
    '  Capital Social:         R$ 100000',
    '  Inicio Atividade:       14/06/2017',
    '  Logradouro:             R DE CAXIAS 53, 53',
    '  Bairro:                 CENTRO',
    '  Cidade:                 LORENA - SP',
    '  CEP:                    12600-040',
    '  Tel Empresa 1:          (12) 3157-3730',
    '  Tel Empresa 2:          -',
    '  Email Empresa:          contador@dilonet.com.br',
    '',
    '  --- DADOS DA PERSONA (CPF) ---',
    '  Nome:                   MARCOS TOBIAS LIMA',
    '  Nascimento:             01/03/1965',
    '  Nome da mae:            YOLANDA FERREIRA SILVA',
    '  Sexo:                   M',
    '  Email:                  digitalbrasil.vip@r7.com',
    '  Telefones:',
    '                          (12) 3153-3128',
    '                          (12) 98261-8776',
    '  Endereco:               R DE CAXIAS, 53 - CENTRO, LORENA - SP, CEP: 12600-040'
].join('\n');

const blocoLiveSocios = [
    '  CNPJ:                   55251617000171',
    '  CPF Persona:            305.863.028-08',
    '  Email cadastro:         la*****@gmail.com',
    '  Telefone cadastro:      55 (**) ***** 9866',
    '  Final visivel:          9866',
    '',
    '  --- DADOS DA EMPRESA ---',
    '  Razao Social:           SHIRATORI COMERCIO DE ALIMENTOS E BEBIDAS LTDA',
    '  Nome Fantasia:          -',
    '  Situacao:               ATIVA',
    '  Porte:                  MICRO EMPRESA',
    '  Capital Social:         R$ 400000',
    '  Inicio Atividade:       2024-05-23',
    '  Logradouro:             KENNEDY, 700',
    '  Bairro:                 VILA MARLENE',
    '  Cidade:                 SAO BERNARDO DO CAMPO - SP',
    '  CEP:                    09726901',
    '  Tel Empresa 1:          1134505751',
    '  Tel Empresa 2:          -',
    '  Email Empresa:          -',
    '',
    '  --- DADOS DA PERSONA (CPF) ---',
    '  Nome:                   LAYLA SHIRATORI',
    '  Nascimento:             19/10/1982',
    '  Nome da mae:            MARCIA APARECIDA EBOLI SHIRATORI',
    '  Email:                  laylashiratori@gmail.com',
    '  Telefones:',
    '                          (11) 3333-4444',
    '  Endereco:               R JOAQUIM FLORIANO, 233 - ITAIM BIBI, SAO PAULO - SP, CEP: 04534-010',
    '',
    '  --- SOCIOS (1) ---',
    '',
    '  [Socio 1]',
    '  Nome:                   LAYLA SHIRATORI',
    '  Qualificacao:           Sócio-Administrador',
    '  Data Entrada:           2026-06-01',
    '  CPF Mascarado:          ***863028**',
    '  CPF Completo:           305.863.028-08',
    '  Nascimento:             19/10/1982',
    '  Nome da mae:            MARCIA APARECIDA EBOLI SHIRATORI',
    '  Telefones:',
    '                          (11) 99999-8888',
    '  Email:                  laylashiratori@gmail.com'
].join('\n');

const resultadoLive = processarListaSuja(blocoLive + '\n\n' + blocoLiveSocios);

assert.strictEqual(resultadoLive.registros, 2, '2 registros LIVE');
assert.strictEqual(resultadoLive.validos.length, 2, '2 registros válidos');
assert.strictEqual(resultadoLive.descartados.length, 0, 'nenhum descarte');
assert.deepStrictEqual(resultadoLive.linhas, [
    '551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '5512982618776;MARCOS TOBIAS LIMA;27.964.767/0001-97',
    '551133334444;LAYLA SHIRATORI;55.251.617/0001-71'
], 'telefones da persona (telefone do sócio não entra)');

assert.deepStrictEqual(resultadoLive.cpfs, ['014.079.598-75', '305.863.028-08'], 'CPFs um por linha para o extrator');

assert.strictEqual(resultadoLive.validos[0].empresa.razaoSocial, 'IMPERIAL MARKETING E PROPAGANDA LTDA');
assert.strictEqual(resultadoLive.validos[0].empresa.cidade, 'LORENA');
assert.strictEqual(resultadoLive.validos[0].empresa.uf, 'SP');
assert.strictEqual(resultadoLive.validos[0].empresa.cep, '12600-040');
assert.strictEqual(resultadoLive.validos[1].empresa.cidade, 'SAO BERNARDO DO CAMPO');
assert.strictEqual(resultadoLive.validos[1].empresa.cep, '09726-901');
assert.strictEqual(resultadoLive.validos[1].empresa.telefone1, '(11) 3450-5751');
assert.strictEqual(resultadoLive.validos[1].empresa.nomeFantasia, '', 'nome fantasia "-" vira vazio');

assert.strictEqual(resultadoLive.validos[1].socios.length, 1, 'sócio separado da persona');
assert.strictEqual(resultadoLive.validos[1].socios[0].nome, 'LAYLA SHIRATORI');
assert.strictEqual(resultadoLive.validos[1].socios[0].cpfFormatado, '305.863.028-08');
assert.strictEqual(resultadoLive.validos[1].socios[0].telefones[0], '5511999998888');

assert.strictEqual(mascararCpf('30586302808'), '305.863.xxx-xx');
assert.strictEqual(cpfCombina('305.863.xxx-xx', '30586302808'), true);
assert.strictEqual(cpfCombina('305.863.xxx-xx', '99986302808'), false);
assert.strictEqual(cpfCombina('305.863.028-08', '30586302808'), true);

/* extrator por CPF mascarado */
const comMascarado = aplicarResultadoExtrator(resultadoLive.validos, '305.863.xxx-xx;5511999990000');
assert.strictEqual(comMascarado.aplicados, 1, 'CPF mascarado casa com o registro');
assert.ok(comMascarado.registros[1].telefones.includes('5511999990000'), 'telefone revelado entrou na lista');

/* extrator por nome (linha LIVE do site) */
const comLive = aplicarResultadoExtrator(
    resultadoLive.validos,
    '✓ [LIVE] MARCOS TOBIAS LIMA | Mask: (12) *****8776 | Revelado: 12998218776'
);
assert.strictEqual(comLive.aplicados, 1, 'linha LIVE casa pelo nome');
assert.ok(comLive.registros[0].telefones.includes('5512998218776'), 'revelado do LIVE entrou');

/* JSON do painel */
const comJson = aplicarResultadoExtrator(resultadoLive.validos, JSON.stringify({
    resultados: [{ cpf: '30586302808', status: 'ok', nome: 'LAYLA SHIRATORI', telefones: [{ wati: '5511988887777' }] }]
}));
assert.strictEqual(comJson.aplicados, 1, 'JSON do painel casa pelo CPF');
assert.ok(comJson.registros[1].telefones.includes('5511988887777'), 'telefone do JSON entrou');

/* registro sem telefone no dump: o extrator é quem completa */
const soEmpresa = processarListaSuja(blocoLive.replace(/  Telefones:[\s\S]*?  Endereco:/, '  Endereco:'));
assert.strictEqual(soEmpresa.linhas.length, 0, 'sem telefone no dump: nada pronto');
assert.deepStrictEqual(soEmpresa.cpfs, ['014.079.598-75'], 'CPF na lista do extrator');
assert.strictEqual(soEmpresa.semTelefone.length, 1);

const completado = aplicarResultadoExtrator(
    soEmpresa.validos,
    '014.079.xxx-xx;5512999999999'
);
assert.strictEqual(completado.registros[0].telefones[0], '5512999999999');
assert.deepStrictEqual(
    completado.registros[0].linhas,
    ['5512999999999;MARCOS TOBIAS LIMA;27.964.767/0001-97'],
    'saída final {telefone};{nome};{cnpj}'
);

/* dados da empresa para a ficha/importação */
const importacao = montarLinhasComEmpresa(completado.registros);
assert.ok(importacao.cabecalho.indexOf('telefone;{{1}};{{2}};razao_social;') === 0, 'cabeçalho com as 3 colunas + atributos');
assert.strictEqual(importacao.linhas.length, 1);
assert.ok(importacao.linhas[0].indexOf('5512999999999;MARCOS TOBIAS LIMA;27.964.767/0001-97;IMPERIAL MARKETING') === 0);

const cadastro = montarCadastroCsv(resultadoLive.validos);
assert.strictEqual(cadastro.linhas.length, 2, '1 linha por empresa');
assert.ok(cadastro.colunas.indexOf('razao_social') >= 0);
assert.ok(cadastro.linhas[1].indexOf('55.251.617/0001-71;SHIRATORI COMERCIO DE ALIMENTOS E BEBIDAS LTDA') === 0);

console.log('OK - UAT 6: dump LIVE C6 PJ (empresa/persona/sócios, extrator e lista final)');

/* ---------- UAT 8: CSV do extrator (CPF;NOME;...;REVELADO) ---------- */

const csvExtrator = [
    'CPF;NOME;NASCIMENTO;RENDA;EMAIL;BANCO;AGENCIA;CONTA;MASK;REVELADO',
    '014.079.598-75;MARCOS TOBIAS LIMA;10/05/1985;16421.91;marcos@exemplo.com;NUBANK S.A.;;N/A;(12) *****8776;12998218776',
    '305.863.028-08;LAYLA SHIRATORI;19/10/1982;3153.53;layla@exemplo.com;BANCO BRADESCO;7733;N/A;(11) *****9866;11959949866'
].join('\n');

const itensCsv = normalizarEntradaExtrator(csvExtrator);

assert.strictEqual(itensCsv.length, 2, 'o cabeçalho do CSV não vira item');
assert.strictEqual(itensCsv[0].cpf, '014.079.598-75', 'CPF da coluna CPF');
assert.strictEqual(itensCsv[0].nome, 'MARCOS TOBIAS LIMA', 'nome da coluna NOME');
assert.deepStrictEqual(
    itensCsv[0].telefones,
    ['5512998218776'],
    'só o REVELADO vira telefone (nascimento, renda e agência ficam de fora)'
);

/* sem cabeçalho e separado por Tab também vale */
const semCabecalho = normalizarEntradaExtrator('014.079.598-75;MARCOS TOBIAS LIMA;12998218776');
assert.strictEqual(semCabecalho[0].nome, 'MARCOS TOBIAS LIMA');
assert.deepStrictEqual(semCabecalho[0].telefones, ['5512998218776'], 'CSV sem cabeçalho (CPF;NOME;telefone)');

const comTab = normalizarEntradaExtrator('014.079.598-75\tMARCOS TOBIAS LIMA\t12998218776');
assert.deepStrictEqual(comTab[0].telefones, ['5512998218776'], 'CSV separado por Tab');

/* dump do passo 1 ainda sem telefone: o CSV do extrator completa */
const semTelefonesLive = resultadoLive.validos.map((registro) => Object.assign({}, registro, { telefones: [] }));
const comCsv = aplicarResultadoExtrator(semTelefonesLive, csvExtrator);

assert.strictEqual(comCsv.linhas, 2, '2 linhas lidas do CSV');
assert.strictEqual(comCsv.aplicados, 2, '2 CPFs ganharam telefone');
assert.strictEqual(comCsv.jaAplicados, 0);
assert.strictEqual(comCsv.naoEncontrados.length, 0, 'todas casadas pelo CPF');
assert.deepStrictEqual(comCsv.registros[0].telefones, ['5512998218776']);
assert.deepStrictEqual(comCsv.registros[1].telefones, ['5511959949866'], 'CPF mascarado do dump também casa');

/* aplicar de novo não duplica e explica o "0 aplicados" */
const repetido = aplicarResultadoExtrator(comCsv.registros, csvExtrator);
assert.strictEqual(repetido.aplicados, 0, 'segunda aplicação não duplica telefone');
assert.strictEqual(repetido.jaAplicados, 2, 'segunda aplicação conta como já aplicada');
assert.deepStrictEqual(repetido.registros[1].telefones, ['5511959949866']);

/* linha casada mas sem telefone reconhecido */
const semTelefoneCsv = aplicarResultadoExtrator(
    semTelefonesLive,
    '014.079.598-75;MARCOS TOBIAS LIMA;10/05/1985;N/A;N/A;N/A;N/A;N/A;(12) *****8776;N/A'
);
assert.strictEqual(semTelefoneCsv.semTelefoneNaLinha, 1, 'linha sem telefone é sinalizada');

/* planilha final: telefone;{{1}};{{2}} + dados da empresa do passo 1 */
const planilhaFinal = montarLinhasComEmpresa(comCsv.registros);
assert.strictEqual(planilhaFinal.linhas.length, 2, '1 linha por telefone revelado');
assert.ok(
    planilhaFinal.linhas[0].indexOf('5512998218776;MARCOS TOBIAS LIMA;27.964.767/0001-97;IMPERIAL MARKETING') === 0,
    'planilha final junta empresa do dump + telefone do extrator'
);
assert.ok(planilhaFinal.cabecalho.indexOf('telefone;{{1}};{{2}};') === 0, 'cabeçalho do envio');

/* ---------- "só o número do extrator": os do dump saem da lista ---------- */

/* resultadoLive tem 2 registros com telefone de dump (3 + 1 números) */
const comDump = aplicarResultadoExtrator(resultadoLive.validos, csvExtrator);

assert.strictEqual(comDump.aplicados, 2, 'troca o número do dump pelo revelado');
assert.deepStrictEqual(comDump.registros[0].telefones, ['5512998218776'], 'sobra só o número revelado (MARCOS)');
assert.deepStrictEqual(comDump.registros[1].telefones, ['5511959949866'], 'sobra só o número revelado (LAYLA)');
assert.ok(
    (comDump.registros[1].telefonesDump || []).indexOf('551133334444') >= 0,
    'número do dump fica guardado para conferência'
);
assert.ok(comDump.numerosDescartados >= 3, 'conta quantos números do dump saíram da lista');
assert.strictEqual(comDump.registros[0].linhas.length, 1, '1 linha por pessoa, não 1 por número do dump');
assert.strictEqual(comDump.registros[1].linhas.length, 1);
assert.strictEqual(comDump.registros[1].telefoneDoExtrator, true);

const planilhaSoExtrator = montarLinhasComEmpresa(comDump.registros);
assert.strictEqual(planilhaSoExtrator.linhas.length, 2, 'planilha final sem os números do dump');
assert.ok(planilhaSoExtrator.linhas.join('\n').indexOf('551133334444') === -1, 'número do dump não vai para o envio');

/* extrator atendeu só 1 CPF: o outro fica sem telefone (não inventa número) */
const parcial = aplicarResultadoExtrator(
    resultadoLive.validos,
    '014.079.598-75;MARCOS TOBIAS LIMA;10/05/1985;16421.91;marcos@exemplo.com;NUBANK S.A.;;N/A;(12) *****8776;12998218776'
);
assert.deepStrictEqual(parcial.registros[1].telefones, [], 'quem o extrator não atendeu sai de Prontos');
assert.ok((parcial.registros[1].telefonesDump || []).indexOf('551133334444') >= 0, 'e o número antigo fica guardado');
assert.strictEqual(parcial.registros[1].aguardandoExtrator, true);

/* { apenasExtrator: false } volta ao modo antigo: soma dump + revelado */
const somando = aplicarResultadoExtrator(resultadoLive.validos, csvExtrator, { apenasExtrator: false });
assert.ok(somando.registros[1].telefones.indexOf('551133334444') >= 0, 'dump mantido quando apenasExtrator=false');
assert.ok(somando.registros[1].telefones.indexOf('5511959949866') >= 0, 'revelado somado ao dump');
assert.ok(somando.numerosDescartados === 0, 'sem descarte no modo soma');

/* desmarcar a opção devolve os números guardados em telefonesDump */
const devolvido = aplicarResultadoExtrator(comDump.registros, csvExtrator, { apenasExtrator: false });
assert.ok(devolvido.registros[0].telefones.indexOf('551231533128') >= 0, 'número do dump volta à lista');
assert.ok(devolvido.registros[1].telefones.indexOf('551133334444') >= 0);
assert.ok(devolvido.registros[1].telefones.indexOf('5511959949866') >= 0, 'revelado continua');
assert.strictEqual(devolvido.numerosRestaurados, 3, 'conta os números devolvidos');
assert.strictEqual(somando.numerosRestaurados, 0, 'nada a devolver quando não houve descarte');

console.log('OK - UAT 8: CSV do extrator (CPF;NOME;...;REVELADO) aplicado e planilha final');

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

/* ---------- UAT 7: tolerância à colagem (PDF, HTML, CRLF, rótulos) ---------- */

const blocoColagem = [
    'CNPJ:                   27.964.767/0001-97',
    'CPF Persona:            014.079.598-75',
    '--- DADOS DA EMPRESA ---',
    'Razao Social:           IMPERIAL MARKETING E PROPAGANDA LTDA',
    'Cidade:                 SAO JOSE DOS CAMPOS/SP',
    '--- DADOS DA PERSONA (CPF) ---',
    'Nome:                   MARCOS TOBIAS LIMA',
    'Telefones:',
    '    (12) 3153-3128'
];

const blocoCpfPrimeiro = [
    'CPF Persona:            014.079.598-75',
    'Nome:                   MARCOS TOBIAS LIMA',
    'Telefones:',
    '    (12) 3153-3128',
    'CNPJ:                   27.964.767/0001-97'
];

const variantesColagem = {
    'quebras CRLF': blocoColagem.join('\r\n'),
    'linhas indentadas com espaço': blocoColagem.map((linha) => '   ' + linha).join('\n'),
    'linhas indentadas com NBSP': blocoColagem.map((linha) => '\u00A0\u00A0' + linha).join('\n'),
    'colagem esmagada em uma linha (PDF/tabela)': blocoColagem.join(' '),
    'rótulo "CPF da Persona"': blocoColagem.join('\n').replace('CPF Persona:', 'CPF da Persona:'),
    'rótulo "CPF Persona (Titular)"': blocoColagem.join('\n').replace('CPF Persona:', 'CPF Persona (Titular):'),
    'CPF Persona antes do CNPJ (dump antigo)': blocoCpfPrimeiro.join('\n'),
    'linha em branco entre registros': blocoColagem.join('\n') + '\n\n' + blocoColagem.join('\n')
};

Object.keys(variantesColagem).forEach((nome) => {
    const saida = processarListaSuja(variantesColagem[nome]);

    assert.ok(saida.registros >= 1, nome + ': registro reconhecido');
    assert.ok(
        saida.linhas[0] === '551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97',
        nome + ': telefone, nome e CNPJ na lista final'
    );
});

const doisNaColagem = processarListaSuja(variantesColagem['linha em branco entre registros']);
assert.strictEqual(doisNaColagem.registros, 2, 'dois blocos separados por linha em branco');

/* texto que não é dump: erro explicativo (e não uma lista vazia silenciosa) */
let erroFormato = null;
try {
    processarListaSuja('Telefone: (12) 3153-3128\nNome: PESSOA QUALQUER');
} catch (erro) {
    erroFormato = erro;
}

assert.ok(erroFormato, 'texto sem os rótulos do dump é recusado');
assert.strictEqual(erroFormato.codigo, 'formato', 'erro marcado como problema de formato');
assert.ok(erroFormato.message.indexOf('CPF Persona') >= 0, 'mensagem diz qual rótulo era esperado');

console.log('OK - UAT 7: colagem tolerante (CRLF, NBSP, uma linha, rótulos alternativos)');

/* ---------- integração da tela (index.html + app.js + lista branca) ---------- */

const fs = require('fs');
const path = require('path');

const raiz = __dirname;
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const painel = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
const servidor = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
const estilos = fs.readFileSync(path.join(raiz, 'style.css'), 'utf8');

assert.ok(html.includes('id="view-listas"'), 'tela "Listas" existe no index.html');
assert.ok(!html.includes('id="view-listasuja"'), 'a tela separada de Lista Suja foi unificada em Listas');

const telaListas = html.slice(html.indexOf('id="view-listas"'), html.indexOf('id="view-canais"'));

assert.ok(telaListas.includes('id="suja-texto"'), 'passo do dump dentro da tela Listas');
assert.ok(telaListas.includes('id="suja-extrator-aviso"'), 'aviso de servidor sem Chrome dentro da tela Listas');
assert.ok(html.includes('id="extrator-aviso"'), 'aviso de servidor sem Chrome na tela Consultar CPF');
assert.ok(html.includes('onclick="copiarComandoExtrator()"'), 'botão Copiar comando do extrator local');
assert.ok(telaListas.includes('id="lista-importar"'), 'planilha pronta recolhida na mesma tela');
assert.ok(telaListas.includes('id="lista-texto"'), 'importação manual na mesma tela');
assert.ok(telaListas.includes('REVELADO'), 'passo 3 explica o CSV do extrator');
assert.ok(telaListas.includes('id="suja-so-extrator"'), 'passo 3 tem o "só o telefone do extrator"');
assert.ok(
    /<input id="suja-so-extrator" type="checkbox" checked>/.test(telaListas),
    'a lista final vem marcada só com o número do extrator'
);
assert.ok(painel.includes('preencherPlanilhaFinalListaSuja();'), 'aplicar resultado já preenche a planilha pronta');
assert.ok(painel.includes('apenasExtrator: apenasExtratorListaSuja()'), 'app.js passa a opção apenasExtrator');
assert.ok(painel.includes('numerosDescartados'), 'app.js avisa quantos números do dump saíram');
assert.ok(telaListas.includes('id="tabela-listas"'), 'listas salvas na mesma tela');
assert.ok(painel.includes("if (view === 'listasuja') view = 'listas';"), 'irPara aceita o apelido antigo "listasuja"');
assert.ok(painel.includes('function abrirImportacaoLista('), 'app.js abre a planilha pronta ao enviar para importação');
assert.ok(html.includes('id="suja-texto"'), 'textarea da lista bruta');
assert.ok(html.includes('id="suja-saida"'), 'textarea do resultado');
assert.ok(html.includes('id="suja-cpfs"'), 'textarea dos CPFs para o extrator');
assert.ok(html.includes('id="suja-extrator"'), 'textarea do resultado do extrator');
assert.ok(html.includes('id="tabela-suja-descartados"'), 'tabela de descartados');
assert.ok(html.includes('id="tabela-suja-sem-telefone"'), 'tabela de registros sem telefone');
assert.ok(html.includes('id="suja-aba-sem-telefone"'), 'aba Sem telefone');
assert.ok(html.includes('onclick="processarListaSujaPainel()"'), 'botão Processar Lista');
assert.ok(html.includes('onclick="copiarListaSuja()"'), 'botão Copiar');
assert.ok(html.includes('onclick="baixarListaSuja()"'), 'botão Baixar .txt');
assert.ok(html.includes('onclick="baixarListaSujaFinal()"'), 'botão Baixar planilha final (.csv)');
assert.ok(html.includes('onclick="copiarListaSujaCpfs()"'), 'botão Copiar CPFs');
assert.ok(html.includes('onclick="baixarListaSujaCpfs()"'), 'botão Baixar CPFs');
assert.ok(html.includes('onclick="levarListaSujaParaExtrator()"'), 'botão Levar para Consultar CPF');
assert.ok(html.includes('onclick="aplicarResultadoExtratorPainel()"'), 'botão Aplicar resultado do extrator');
assert.ok(html.includes('onclick="puxarResultadoExtratorPainel()"'), 'botão Usar última consulta do painel');
assert.ok(html.includes('onclick="usarListaSujaNaImportacaoComEmpresa()"'), 'botão Enviar com dados da empresa');
assert.ok(html.includes('onclick="baixarCadastroListaSuja()"'), 'botão Baixar cadastro .csv');
assert.ok(html.includes('<script src="lista-suja.js"></script>'), 'parser carregado no index.html');
assert.ok(
    html.indexOf('src="lista-suja.js"') < html.indexOf('src="app.js"'),
    'lista-suja.js precisa vir antes de app.js'
);

['mostrarAbaListaSuja', 'renderizarListaSuja', 'recalcularListaSuja', 'processarListaSujaPainel',
    'aplicarResultadoExtratorPainel', 'puxarResultadoExtratorPainel', 'copiarListaSuja',
    'apenasExtratorListaSuja', 'resumoDoExtratorListaSuja', 'usarResultadoExtratorListaSuja',
    'copiarListaSujaCpfs', 'baixarListaSujaCpfs', 'levarListaSujaParaExtrator', 'cpfsDaCaixa',
    'baixarListaSuja', 'usarListaSujaNaImportacao', 'usarListaSujaNaImportacaoComEmpresa',
    'preencherPlanilhaFinalListaSuja', 'baixarListaSujaFinal',
    'baixarCadastroListaSuja', 'limparListaSuja', 'verificarExtratorPainel', 'copiarComandoExtrator'].forEach((nome) => {
    assert.ok(new RegExp('function ' + nome + '\\(').test(painel), 'app.js define ' + nome);
});

assert.ok(painel.includes("'telefone;{{1}};{{2}}'"), 'enviar para a importação usa telefone;{{1}};{{2}}');
assert.ok(servidor.includes("'lista-suja.js'"), 'lista-suja.js está na lista branca de estáticos');
assert.ok(estilos.includes('.suja-bruto'), 'estilo do trecho bruto do descarte');
assert.ok(estilos.includes('.suja-tabs'), 'estilo das abas do resultado');
assert.ok(estilos.includes('.lista-importar'), 'estilo da planilha pronta recolhida');
assert.ok(estilos.includes('.aviso-extrator'), 'estilo do aviso de extrator sem Chrome');

console.log('OK - integração da tela (HTML, app.js, lista branca e CSS)');
console.log('');
console.log('Todos os testes do processador de Lista Suja passaram.');

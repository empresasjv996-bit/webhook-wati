/* =========================================================
   QGC TEAM by JV - Testes do disparo de campanhas na Wati
   Garante que os contatos de um template saem numa requisição só
   (uma campanha no painel da Wati, não uma por contato) e que o
   intervalo padrão é de 5 segundos.
   Roda com: node test-campanhas.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    avaliarEnvioTemplate,
    normalizarParametrosTemplate,
    rotuloBroadcastWati,
    deduplicarContatosPorTelefone,
    montarDestinatariosTemplate,
    corpoEnvioTemplateWati
} = require('./index');

/* ---------- UAT 1: o lote inteiro vai numa requisição (uma campanha) ---------- */

const contatos = [
    { telefone: '55 11 97598-8590', parametros: [{ name: 'nome', value: 'Ana' }], envioId: 101 },
    { telefone: '(11) 99966-7672', parametros: [{ name: 'nome', value: 'Bruno' }], envioId: 102 },
    { telefone: '551199555444', parametros: [{ name: 'nome', value: 'Carla' }], envioId: 103 }
];

const fila = montarDestinatariosTemplate(contatos, 'Promocao Novembro');

assert.strictEqual(fila.length, 3, 'os 3 contatos entram no mesmo lote');
assert.deepStrictEqual(
    fila.map((item) => item.numero),
    ['5511975988590', '11999667672', '551199555444'],
    'telefones normalizados (só dígitos)'
);

const corpo = corpoEnvioTemplateWati('promo_novembro', rotuloBroadcastWati('Promocao Novembro'), fila);

assert.strictEqual(corpo.template_name, 'promo_novembro');
assert.strictEqual(corpo.broadcast_name, 'Promocao_Novembro', 'o nome da campanha vira o broadcast da Wati');
assert.strictEqual(corpo.recipients.length, 3, 'uma única requisição leva todos os contatos');
assert.deepStrictEqual(corpo.recipients[0], {
    target: '5511975988590',
    local_message_id: 'campanha-Promocao_Novembro-101',
    custom_params: [{ name: 'nome', value: 'Ana' }]
});

/* Dois lotes da mesma campanha usam o mesmo broadcast_name (continuam na
   mesma campanha da Wati, sem "campanha de 1 contato" por mensagem). */
const segundoLote = montarDestinatariosTemplate(
    [{ telefone: '5511988887777', parametros: [{ name: 'nome', value: 'Dora' }], envioId: 104 }],
    'Promocao Novembro'
);
const corpoSegundoLote = corpoEnvioTemplateWati('promo_novembro', rotuloBroadcastWati('Promocao Novembro'), segundoLote);

assert.strictEqual(corpoSegundoLote.broadcast_name, corpo.broadcast_name);

/* ---------- UAT 2: contato sem telefone válido não entra no lote ---------- */

assert.strictEqual(montarDestinatariosTemplate([{ telefone: '', envioId: 1 }, { telefone: 'sem numero' }], 'x').length, 0);

/* ---------- UAT 3: parâmetros do template no formato da v3 ---------- */

assert.deepStrictEqual(
    normalizarParametrosTemplate([{ name: 'nome', value: 123 }, { value: 'sem nome' }, null]),
    [{ name: 'nome', value: '123' }],
    'só variáveis com nome, sempre como texto'
);

/* ---------- UAT 4: leitura da resposta da v3 ---------- */

const aceito = avaliarEnvioTemplate({
    ok: true,
    status: 200,
    dados: { result: true, recipients: [{ target: '5511975988590' }, { target: '5511999667672' }] }
});

assert.strictEqual(aceito.aceito, true);
assert.strictEqual(aceito.semDestinatarios, false);
assert.deepStrictEqual(aceito.porNumero, {});

const parcial = avaliarEnvioTemplate({
    ok: true,
    status: 200,
    dados: {
        result: true,
        recipients: [
            { whatsapp_number: '5511975988590' },
            { whatsapp_number: '5511999667672', errors: [{ message: 'not on WhatsApp' }] }
        ]
    }
});

assert.strictEqual(parcial.aceito, false);
assert.strictEqual(parcial.podeTentarV1, false, 'erro de destinatário na v3 não pode ser repetido na v1');
assert.deepStrictEqual(parcial.porNumero, { '5511999667672': 'not on WhatsApp' });

const falhaTotal = avaliarEnvioTemplate({
    ok: true,
    status: 200,
    dados: { success: false, message: 'token invalido' }
});

assert.strictEqual(falhaTotal.aceito, false);
assert.strictEqual(falhaTotal.podeTentarV1, true, 'falha inteira da v3 libera a tentativa na v1');

const semJson = avaliarEnvioTemplate({ ok: false, status: 500, dados: null, texto: 'boom' });
assert.strictEqual(semJson.aceito, false);
assert.strictEqual(semJson.podeTentarV1, true);

/* ---------- UAT 5: worker e formulário (guarda contra regressão) ---------- */

const fonteIndex = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

assert.ok(fonteIndex.includes('enviarTemplateWatiLote('), 'o worker precisa usar o envio em lote');
assert.ok(fonteIndex.includes('enviosPendentesCampanha('), 'o worker precisa buscar os pendentes da campanha');
assert.ok(!/function enviarTemplateWati\(/.test(fonteIndex), 'o envio unitário antigo (1 campanha por contato) saiu de cena');
assert.ok(/parseInt\(intervalo, 10\) \|\| 5000/.test(fonteIndex), 'intervalo padrão de 5 segundos no servidor');
assert.ok(fonteIndex.includes('enviarViaWati(item.telefone'), 'texto livre continua um por vez');

const fonteHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
assert.ok(fonteHtml.includes('<option value="5000">5 segundos (recomendado)</option>'), 'formulário oferece 5 segundos');
assert.ok(!fonteHtml.includes('8000'), 'nada de 8 segundos no formulário');

const fonteDb = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');
assert.ok(fonteDb.includes('intervalo_ms INTEGER NOT NULL DEFAULT 5000'), 'tabela nova já nasce com 5 segundos');
assert.ok(
    fonteDb.includes('ALTER TABLE campanhas ALTER COLUMN intervalo_ms SET DEFAULT 5000'),
    'bancos existentes migram para 5 segundos'
);
assert.ok(fonteDb.includes('enviosPendentesCampanha'), 'banco expõe os pendentes por campanha (Postgres e demo)');

/* ---------- UAT 6: ninguém recebe a mesma campanha duas vezes ---------- */

const listaComRepetidos = [
    { telefone: '55 11 97598-8590', nome: 'Ana' },
    { telefone: '(11) 99966-7672', nome: 'Bruno' },
    { telefone: '5511975988590', nome: 'Ana (outra linha da lista)' },
    { telefone: '11 99966-7672', nome: 'Bruno (outra linha da lista)' },
    { telefone: '551199555444', nome: 'Carla' }
];

const deduplicada = deduplicarContatosPorTelefone(listaComRepetidos);

assert.strictEqual(deduplicada.unicos.length, 3, 'a campanha tem uma linha por número');
assert.strictEqual(deduplicada.repetidos.length, 2, 'as linhas repetidas do mesmo WhatsApp são ignoradas');
assert.deepStrictEqual(
    deduplicada.unicos.map((contato) => contato.nome),
    ['Ana', 'Bruno', 'Carla'],
    'mantém a primeira ocorrência de cada número'
);

/* O mesmo número duas vezes no lote viraria duas mensagens no WhatsApp: a Wati
   não deduplica destinatário por nós. */
assert.strictEqual(
    montarDestinatariosTemplate([
        { telefone: '5511975988590', envioId: 1 },
        { telefone: '55 11 97598-8590', envioId: 2 }
    ], 'Promo').length,
    1,
    'número repetido sai uma vez só no lote'
);

/* Contato sem telefone continua na campanha (vira falha visível no painel). */
assert.strictEqual(
    deduplicarContatosPorTelefone([{ telefone: '' }, { telefone: null }]).unicos.length,
    2,
    'contato sem número não é escondido da campanha'
);

assert.ok(
    fonteIndex.includes('const semRepetidos = deduplicarContatosPorTelefone(contatos);'),
    'a criação da campanha deduplica os contatos por número (antes de validar)'
);
assert.ok(
    fonteIndex.includes('banco.enviosDuplicadosCampanha('),
    'o worker fecha os repetidos de campanhas criadas antes da correção'
);
assert.ok(
    fonteDb.includes('enviosDuplicadosCampanha'),
    'banco expõe os repetidos por campanha (Postgres e demo)'
);

/* ---------- UAT 7: contato incompleto não trava a campanha ---------- */

const linhasMesmoNumero = [
    { telefone: '5511975988590', nome: '', atributos: { cnpj: '' } },
    { telefone: '55 11 97598-8590', nome: 'Ana Souza', atributos: { cnpj: '12.345.678/0001-90' } }
];

const comHeranca = deduplicarContatosPorTelefone(linhasMesmoNumero);

assert.strictEqual(comHeranca.unicos.length, 1, 'continua uma linha por número');
assert.strictEqual(comHeranca.unicos[0].nome, 'Ana Souza', 'o nome que só existia na linha repetida é aproveitado');
assert.strictEqual(comHeranca.unicos[0].atributos.cnpj, '12.345.678/0001-90', 'atributo vazio também é completado');
assert.strictEqual(linhasMesmoNumero[0].nome, '', 'a lista original não é alterada pela campanha');

assert.ok(
    !fonteIndex.includes('Complete a lista antes de disparar'),
    'um contato sem o dado não bloqueia mais a campanha inteira'
);
assert.ok(fonteIndex.includes('mapa.padrao'), 'variável aceita valor de reserva para quem não tem o dado');
assert.ok(fonteIndex.includes('contatosSemDado'), 'a resposta diz quantos contatos ficaram de fora');

const fonteApp = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

assert.ok(fonteApp.includes('data-padrao'), 'formulário tem o campo "se o contato não tiver, usar"');
assert.ok(fonteApp.includes('semDadoTotal'), 'painel avisa quem ficou de fora por falta de dado');
assert.ok(
    fonteHtml.includes('se o contato não tiver, usar'),
    'ajuda do formulário explica o valor de reserva'
);

console.log('OK - disparo em lote (uma campanha na Wati) e intervalo de 5 segundos validados.');
console.log('OK - uma mensagem por número: contatos repetidos na lista não recebem a campanha duas vezes.');
console.log('OK - contato sem o dado da variável não trava a campanha (valor de reserva / fica de fora).');

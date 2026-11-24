/* =========================================================
   QGC TEAM by JV - Testes do módulo de telefone
   Executar: node test-telefone.js
   ========================================================= */

const assert = require('assert');
const { analisarTelefone, analisarListaTelefones, telefoneCompleto } = require('./telefone');

let testes = 0;

function conferir(entrada, esperado, dddPadrao) {
    const resultado = analisarTelefone(entrada, dddPadrao);
    testes += 1;

    Object.keys(esperado).forEach((campo) => {
        assert.deepStrictEqual(
            resultado[campo],
            esperado[campo],
            `"${entrada}" -> campo ${campo}: esperado ${JSON.stringify(esperado[campo])}, veio ${JSON.stringify(resultado[campo])}`
        );
    });
}

// Já completo, com DDI.
conferir('5511998765432', { valido: true, status: 'ok', wati: '5511998765432', tipo: 'celular' });

// Só DDD + celular (11 dígitos).
conferir('11987654321', { valido: true, status: 'ok', wati: '5511987654321', formatado: '(11) 98765-4321' });

// Celular antigo de 8 dígitos: ganha o 9º dígito.
conferir('1198765432', { valido: true, status: 'completado', wati: '5511998765432', motivo: '9º dígito adicionado' });

// Formatação com máscara e DDI.
conferir('+55 (11) 98765-4321', { valido: true, status: 'ok', wati: '5511987654321' });

// Fixo de 10 dígitos: não recebe 9º dígito.
conferir('1133334444', { valido: true, status: 'ok', tipo: 'fixo', wati: '551133334444', formatado: '(11) 3333-4444' });

// Fixo com DDI.
conferir('551133334444', { valido: true, status: 'ok', tipo: 'fixo', wati: '551133334444' });

// Zero de tronco na frente.
conferir('011987654321', { valido: true, status: 'ok', wati: '5511987654321' });

// Sem DDD + DDD padrão (celular e fixo).
conferir('987654321', { valido: true, status: 'ok', wati: '5511987654321' }, '11');
conferir('33334444', { valido: true, status: 'ok', tipo: 'fixo', wati: '551133334444' }, '11');

// Sem DDD e sem DDD padrão.
conferir('987654321', { valido: false, motivo: 'sem DDD e sem DDD padrão configurado' });

// DDD que não existe.
conferir('20987654321', { valido: false, motivo: 'DDD 20 não existe' });

// Celular com segundo dígito inválido (depois do 9 tem que vir 6 a 9).
conferir('11912345678', { valido: false, motivo: 'celular inválido (depois do 9 vem 6 a 9)' });

// Todos os dígitos iguais.
conferir('11999999999', { valido: false, motivo: 'todos os dígitos são iguais' });

// Tamanho errado / vazio.
conferir('11999', { valido: false, motivo: 'tamanho inválido (5 dígitos com DDD)' });
conferir('', { valido: false, motivo: 'vazio' });

// DDI que não é 55.
conferir('4411987654321', { valido: false, motivo: 'DDI não suportado (só Brasil/55)' });

// telefoneCompleto (atalho).
assert.strictEqual(telefoneCompleto('1198765432'), '5511998765432');
assert.strictEqual(telefoneCompleto('abc'), '');
testes += 2;

// Resumo da lista.
const lista = analisarListaTelefones(['1198765432', '5511998765432', '123'], '11');
assert.deepStrictEqual(lista.resumo, { total: 3, ok: 1, completados: 1, invalidos: 1 });
testes += 1;

console.log(`OK - ${testes} verificações de telefone passaram.`);

/* =========================================================
   QGC TEAM by JV - Telefones brasileiros
   ---------------------------------------------------------
   Normaliza, valida e completa números no padrão da Wati
   (DDI 55 + DDD + número, só dígitos).

   A validação é de formato: DDD oficial (ANATEL), celular
   (9 + 6 a 9) ou fixo (2 a 5) e o 9º dígito dos celulares
   antigos. Não consulta nenhum serviço externo, então não
   confirma se a linha existe/está no WhatsApp — para isso
   use o envio/cadastro na Wati.
   ========================================================= */

// DDDs em uso no Brasil (ANATEL).
const DDDS_VALIDOS = new Set(
    ('11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,' +
        '41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,' +
        '71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99')
        .split(',')
);

/* Remove tudo o que não é dígito. */
function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

/* Formata um número nacional (DDD + 8 ou 9 dígitos) para leitura. */
function formatarTelefoneBrasil(nacional) {
    const numero = apenasDigitos(nacional);

    if (numero.length === 11) {
        return `(${numero.slice(0, 2)}) ${numero.slice(2, 7)}-${numero.slice(7)}`;
    }
    if (numero.length === 10) {
        return `(${numero.slice(0, 2)}) ${numero.slice(2, 6)}-${numero.slice(6)}`;
    }

    return numero;
}

/* Completa o número com o DDD informado quando ele vier só com 8/9 dígitos
   (ex.: "987654321" + DDD 11). Sem DDD padrão o número fica inválido. */
function analisarTelefone(valor, dddPadrao) {
    const original = valor == null ? '' : String(valor).trim();

    const resultado = {
        original,
        valido: false,
        status: 'invalido',
        motivo: '',
        tipo: '',
        ddd: '',
        numero: '',
        nacional: '',
        wati: '',
        e164: '',
        formatado: ''
    };

    const invalido = (motivo) => {
        resultado.motivo = motivo;
        return resultado;
    };

    let digitos = apenasDigitos(original);
    if (!digitos) return invalido('vazio');

    // Zeros à esquerda: tronco/DDD digitado com 0 (011, 021...) ou 00 de operadora.
    digitos = digitos.replace(/^0+/, '');
    if (!digitos) return invalido('vazio');

    // DDI 55 já incluso -> remove para trabalhar só com DDD + número.
    if (digitos.length === 12 || digitos.length === 13) {
        if (!digitos.startsWith('55')) return invalido('DDI não suportado (só Brasil/55)');
        digitos = digitos.slice(2);
    } else if (digitos.length > 13) {
        return invalido('número com dígitos demais');
    }

    // Sem DDD: usa o DDD padrão (útil para listas por cidade).
    if (digitos.length === 8 || digitos.length === 9) {
        const ddd = apenasDigitos(dddPadrao).slice(0, 2);
        if (!DDDS_VALIDOS.has(ddd)) return invalido('sem DDD e sem DDD padrão configurado');
        digitos = ddd + digitos;
    }

    if (digitos.length !== 10 && digitos.length !== 11) {
        return invalido(`tamanho inválido (${digitos.length} dígitos com DDD)`);
    }

    const ddd = digitos.slice(0, 2);
    if (!DDDS_VALIDOS.has(ddd)) return invalido(`DDD ${ddd} não existe`);

    let numero = digitos.slice(2);
    let completado = false;

    // Celular antigo: 8 dígitos começando em 6, 7, 8 ou 9 -> ganha o 9º dígito.
    if (numero.length === 8) {
        const primeiro = numero[0];

        if (primeiro >= '6' && primeiro <= '9') {
            numero = '9' + numero;
            completado = true;
        } else if (!(primeiro >= '2' && primeiro <= '5')) {
            return invalido('número deve começar entre 2 e 9');
        }
    }

    if (/^(\d)\1+$/.test(numero)) return invalido('todos os dígitos são iguais');

    if (numero.length === 9) {
        if (numero[0] !== '9') return invalido('celular deve começar com 9');
        if (numero[1] < '6' || numero[1] > '9') {
            return invalido('celular inválido (depois do 9 vem 6 a 9)');
        }
        resultado.tipo = 'celular';
    } else {
        if (!(numero[0] >= '2' && numero[0] <= '5')) {
            return invalido('fixo deve começar entre 2 e 5');
        }
        resultado.tipo = 'fixo';
    }

    const nacional = ddd + numero;

    resultado.valido = true;
    resultado.status = completado ? 'completado' : 'ok';
    resultado.motivo = completado ? '9º dígito adicionado' : '';
    resultado.ddd = ddd;
    resultado.numero = numero;
    resultado.nacional = nacional;
    resultado.wati = '55' + nacional;
    resultado.e164 = '+55' + nacional;
    resultado.formatado = formatarTelefoneBrasil(nacional);

    return resultado;
}

/* Versão curta: devolve o número pronto para a Wati (55 + DDD + número)
   ou '' quando o telefone não é válido. */
function telefoneCompleto(valor, dddPadrao) {
    const analisado = analisarTelefone(valor, dddPadrao);
    return analisado.valido ? analisado.wati : '';
}

/* Analisa vários telefones de uma vez e devolve o resumo usado pela API/CLI. */
function analisarListaTelefones(telefones, dddPadrao) {
    const lista = Array.isArray(telefones) ? telefones : [];
    const resultados = lista.map((item) => analisarTelefone(item, dddPadrao));

    const resumo = { total: resultados.length, ok: 0, completados: 0, invalidos: 0 };

    resultados.forEach((item) => {
        if (!item.valido) resumo.invalidos += 1;
        else if (item.status === 'completado') resumo.completados += 1;
        else resumo.ok += 1;
    });

    return { resultados, resumo };
}

module.exports = {
    DDDS_VALIDOS,
    apenasDigitos,
    formatarTelefoneBrasil,
    analisarTelefone,
    analisarListaTelefones,
    telefoneCompleto
};

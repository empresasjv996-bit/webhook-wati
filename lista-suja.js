/* =========================================================
   QGC TEAM by JV - Processador de "Lista Suja" (ETL local)
   ---------------------------------------------------------
   Transforma o dump bruto (blocos com "CPF Persona:", "CNPJ:",
   "Telefone cadastro:", "Telefones:" etc.) em linhas prontas
   para disparo no formato:

       {telefone_e164};{nome_completo};{cnpj_formatado}

   Pipeline (tudo em memória, roda no navegador):
     A) parsing: segmenta por "CPF Persona:", mapeia chaves,
        normaliza telefones (DDI 55, sem máscara, 10-11 dígitos);
     B) validação: CPF com dígito verificador + ao menos 1
        telefone válido (senão -> descartado com motivo);
     C) saída: 1 linha por telefone válido (deduplicado).

   Uso no navegador: <script src="lista-suja.js"></script>
   Uso no Node (testes): require('./lista-suja')
   ========================================================= */

'use strict';

/* ---------- utilidades ---------- */

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

function normalizarChave(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/* ---------- validação de CPF (dígitos verificadores) ---------- */

function validarCpf(valor) {
    const digitos = apenasDigitos(valor);

    if (!/^\d{11}$/.test(digitos) || /^(\d)\1{10}$/.test(digitos)) return false;

    let soma = 0;
    for (let i = 0; i < 9; i += 1) soma += parseInt(digitos[i], 10) * (10 - i);
    let dv1 = (soma * 10) % 11;
    if (dv1 === 10) dv1 = 0;
    if (dv1 !== parseInt(digitos[9], 10)) return false;

    soma = 0;
    for (let i = 0; i < 10; i += 1) soma += parseInt(digitos[i], 10) * (11 - i);
    let dv2 = (soma * 10) % 11;
    if (dv2 === 10) dv2 = 0;

    return dv2 === parseInt(digitos[10], 10);
}

/* ---------- telefones ---------- */

/* Formato brasileiro padrão: XX.XXX.XXX/XXXX-XX */
function formatarCnpj(valor) {
    const digitos = apenasDigitos(valor);
    if (digitos.length !== 14) return digitos;
    return digitos.slice(0, 2) + '.' + digitos.slice(2, 5) + '.' + digitos.slice(5, 8) +
        '/' + digitos.slice(8, 12) + '-' + digitos.slice(12);
}

/* Normaliza para E.164 brasileiro (55 + DDD + número) ou null.
   Validação por comprimento (DDD + número, 10 ou 11 dígitos), como
   pede o briefing; prefixos 55 e 0 de tronco são removidos. */
function normalizarTelefone(valor) {
    let digitos = apenasDigitos(valor);

    if (digitos.length >= 12 && digitos.startsWith('55')) digitos = digitos.slice(2);
    if (digitos.length >= 11 && digitos.startsWith('0')) digitos = digitos.slice(1);

    if (digitos.length === 10 || digitos.length === 11) return '55' + digitos;

    return null;
}

/* Extrai candidatos de telefone de um texto (mascarados ou crus). */
function extrairTelefones(texto) {
    const alvo = String(texto || '');
    const candidatos = [];

    /* com máscara: (11) 4238-3161, +55 21 99876-5432, 011 9876-5432 */
    const mascarados = alvo.match(/(?:\+\s*55|55)?[\s.-]*\(?\d{2}\)?[\s.-]*\d{4,5}[\s.-]\d{4}(?!\d)/g) || [];
    mascarados.forEach((achado) => candidatos.push(achado));

    /* crus: sequências de 10-11 dígitos isoladas */
    const crus = alvo.match(/(?<![\d.])\d{10,11}(?![\d.])/g) || [];
    crus.forEach((achado) => candidatos.push(achado));

    /* traço sem espaço: 99876-5432 -> 998765432 */
    const comTraco = alvo.match(/\b\d{4,5}-\d{4}\b/g) || [];
    comTraco.forEach((achado) => candidatos.push(achado.replace(/\D/g, '')));

    const normalizados = [];

    candidatos.forEach((candidato) => {
        const e164 = normalizarTelefone(candidato);
        if (e164 && !normalizados.includes(e164)) normalizados.push(e164);
    });

    return normalizados;
}

/* ---------- parsing ---------- */

/* Divide o texto bruto em blocos: cada bloco começa em "CPF Persona:". */
function segmentarRegistros(texto) {
    const limpo = String(texto || '').replace(/^﻿/, '');

    return limpo
        .split(/^(?=CPF\s*Persona\s*:)/im)
        .map((parte) => parte.trim())
        .filter((parte) => parte && /^cpf\s*persona\s*:/i.test(parte));
}

/* Lê as chaves "Chave: valor" de um bloco; linhas sem chave viram
   continuação da última chave (listas de telefones, endereços...). */
function extrairChaves(bloco) {
    const chaves = {};
    let chaveAtual = null;

    String(bloco || '').split(/\r?\n/).forEach((linha) => {
        const casada = /^\s*([^:]{1,50}?)\s*:\s*(.*)$/.exec(linha);

        if (casada) {
            chaveAtual = normalizarChave(casada[1]);
            chaves[chaveAtual] = (chaves[chaveAtual] ? chaves[chaveAtual] + '\n' : '') + casada[2];
        } else if (chaveAtual && linha.trim()) {
            chaves[chaveAtual] += '\n' + linha;
        }
    });

    return chaves;
}

/* ---------- pipeline por registro ---------- */

/* Campos de onde saem os telefones da PERSONA (empresa não entra). */
const CHAVES_TELEFONE_PERSONA = ['telefone cadastro', 'telefones'];

function processarRegistro(bloco) {
    const chaves = extrairChaves(bloco);

    /* B1: CPF Persona precisa passar pelo dígito verificador */
    const cpf = apenasDigitos(chaves['cpf persona']).slice(0, 11);

    if (!validarCpf(cpf)) {
        return { descartado: true, motivo: 'CPF Inválido', bruto: bloco };
    }

    /* A/B2: telefones da persona (Telefone cadastro + lista Telefones) */
    const textoTelefones = CHAVES_TELEFONE_PERSONA
        .map((chave) => chaves[chave])
        .filter(Boolean)
        .join('\n');

    const telefones = extrairTelefones(textoTelefones);

    if (!telefones.length) {
        return { descartado: true, motivo: 'Sem Telefone Válido', bruto: bloco };
    }

    /* C: saída — 1 linha por telefone válido */
    const nome = String(chaves['nome'] || '').split(/\r?\n/)[0].trim();
    const cnpj = formatarCnpj(chaves['cnpj'] || '');

    return {
        pronto: true,
        cpf,
        nome,
        cnpj,
        telefones,
        linhas: telefones.map((telefone) => telefone + ';' + nome + ';' + cnpj)
    };
}

/* ---------- API principal ---------- */

function processarListaSuja(texto) {
    const registros = segmentarRegistros(texto);

    if (!registros.length) {
        const erro = new Error('Nenhum registro com "CPF Persona:" encontrado no texto colado.');
        erro.codigo = 'formato';
        throw erro;
    }

    const prontos = [];
    const descartados = [];

    registros.forEach((bloco) => {
        try {
            const resultado = processarRegistro(bloco);

            if (resultado.descartado) {
                descartados.push({ motivo: resultado.motivo, bruto: bloco.slice(0, 400) });
            } else {
                prontos.push(resultado);
            }
        } catch (erro) {
            /* dado malformado nunca derruba o processamento */
            descartados.push({ motivo: 'Erro ao processar: ' + erro.message, bruto: bloco.slice(0, 400) });
        }
    });

    const linhas = [];
    prontos.forEach((registro) => linhas.push.apply(linhas, registro.linhas));

    return {
        registros: registros.length,
        prontos,
        descartados,
        linhas
    };
}

/* ---------- export (Node) / globais (navegador) ---------- */

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        processarListaSuja,
        processarRegistro,
        segmentarRegistros,
        extrairChaves,
        extrairTelefones,
        normalizarTelefone,
        validarCpf,
        formatarCnpj,
        normalizarChave,
        apenasDigitos
    };
}

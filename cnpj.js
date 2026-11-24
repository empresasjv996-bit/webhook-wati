/* =========================================================
   QGC TEAM by JV - CNPJ de empresas (dados públicos)
   ---------------------------------------------------------
   Valida o dígito verificador, formata e normaliza a resposta
   da BrasilAPI / Minha Receita. A resposta fica restrita ao
   que a Receita publica da EMPRESA: razão social, nome
   fantasia, situação, CNAE, endereço, telefone e e-mail
   corporativos. CPF do sócio (qsa), filiação e qualquer dado
   de pessoa física são descartados na normalização.
   ========================================================= */

const { analisarTelefone } = require('./telefone');

/* Remove tudo o que não é dígito. */
function somenteDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

function texto(valor) {
    return String(valor == null ? '' : valor).trim();
}

/* Dígito verificador do CNPJ (módulo 11, pesos 2..9 da direita p/ esquerda). */
function digitoCnpj(base) {
    const pesos = base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

    let soma = 0;
    for (let posicao = 0; posicao < base.length; posicao += 1) {
        soma += Number(base[posicao]) * pesos[posicao];
    }

    const resto = soma % 11;
    return resto < 2 ? '0' : String(11 - resto);
}

/* Aceita "26.526.968/0001-40", "26526968000140" etc. e devolve
   { valido, cnpj, motivo } — nunca lança erro. */
function validarCnpj(valor) {
    const cnpj = somenteDigitos(valor);

    const invalido = (motivo) => ({ valido: false, cnpj, motivo });

    if (!cnpj) return invalido('CNPJ vazio');
    if (cnpj.length !== 14) return invalido('CNPJ precisa de 14 números');
    if (/^(\d)\1+$/.test(cnpj)) return invalido('todos os dígitos são iguais');

    if (digitoCnpj(cnpj.slice(0, 12)) !== cnpj[12]) return invalido('dígito verificador não confere');
    if (digitoCnpj(cnpj.slice(0, 13)) !== cnpj[13]) return invalido('dígito verificador não confere');

    return { valido: true, cnpj, motivo: '' };
}

/* 26526968000140 -> 26.526.968/0001-40 */
function formatarCnpj(valor) {
    const cnpj = somenteDigitos(valor);
    if (cnpj.length !== 14) return cnpj;

    return cnpj.slice(0, 2) + '.' + cnpj.slice(2, 5) + '.' + cnpj.slice(5, 8) +
        '/' + cnpj.slice(8, 12) + '-' + cnpj.slice(12);
}

/* 4930202 -> 4930-2/02. A BrasilAPI manda o CNAE como número,
   então 600001 chega sem o zero à esquerda: completa para 7 dígitos. */
function formatarCnae(valor) {
    let codigo = somenteDigitos(valor).replace(/^0+$/, '');
    if (!codigo) return texto(valor);
    if (codigo.length < 7) codigo = codigo.padStart(7, '0');
    if (codigo.length !== 7) return texto(valor);

    return codigo.slice(0, 4) + '-' + codigo[4] + '/' + codigo.slice(5);
}

function montarEndereco(dados) {
    const partes = [];

    let linha = texto(dados.logradouro);
    const numero = texto(dados.numero);
    const complemento = texto(dados.complemento);
    const bairro = texto(dados.bairro);

    if (numero) linha += (linha ? ', ' : '') + numero;
    if (complemento) linha += (linha ? ' - ' : '') + complemento;
    if (bairro) linha += (linha ? ' - ' : '') + bairro;
    if (linha) partes.push(linha);

    const cidade = texto(dados.municipio);
    const uf = texto(dados.uf);
    if (cidade || uf) partes.push([cidade, uf].filter(Boolean).join(' - '));

    const cep = somenteDigitos(dados.cep);
    if (cep.length === 8) partes.push('CEP ' + cep.slice(0, 5) + '-' + cep.slice(5));

    return partes.join(', ');
}

/* Telefones publicados da empresa, já no padrão da Wati quando o
   formato é de telefone brasileiro (fixo 10 ou celular 11 dígitos). */
function telefonesDaEmpresa(dados) {
    const origens = [dados.ddd_telefone_1, dados.ddd_telefone_2, dados.telefone]
        .map(texto)
        .filter(Boolean);

    const telefones = [];
    const vistos = new Set();

    origens.forEach((bruto) => {
        const digitos = somenteDigitos(bruto);
        if (!digitos || vistos.has(digitos)) return;
        vistos.add(digitos);

        const analisado = analisarTelefone(bruto);

        if (!analisado.valido) {
            telefones.push({ numero: digitos, formatado: bruto, wati: '', tipo: '' });
            return;
        }

        telefones.push({
            numero: analisado.nacional,
            formatado: analisado.formatado,
            wati: analisado.wati,
            tipo: analisado.tipo
        });
    });

    return telefones;
}

/* Converte a resposta da BrasilAPI/Minha Receita no formato do painel.
   Só campos da empresa: nada de CPF/CNPJ de sócio, filiação, etc. */
function normalizarEmpresa(dados) {
    const origem = dados && typeof dados === 'object' ? dados : {};
    const cnpj = somenteDigitos(origem.cnpj);

    const socios = (Array.isArray(origem.qsa) ? origem.qsa : [])
        .map((socio) => ({
            nome: texto(socio && socio.nome_socio),
            qualificacao: texto(socio && socio.qualificacao_socio)
        }))
        .filter((socio) => socio.nome);

    const cnaesSecundarios = (Array.isArray(origem.cnaes_secundarios) ? origem.cnaes_secundarios : [])
        .slice(0, 30)
        .map((item) => ({
            codigo: formatarCnae(item && item.codigo),
            descricao: texto(item && item.descricao)
        }));

    return {
        cnpj,
        cnpjFormatado: formatarCnpj(cnpj),
        razaoSocial: texto(origem.razao_social),
        nomeFantasia: texto(origem.nome_fantasia),
        situacao: texto(origem.descricao_situacao_cadastral),
        dataSituacao: texto(origem.data_situacao_cadastral),
        dataAbertura: texto(origem.data_inicio_atividade),
        porte: texto(origem.porte),
        naturezaJuridica: texto(origem.natureza_juridica),
        capitalSocial: Number(origem.capital_social) || 0,
        cnae: formatarCnae(origem.cnae_fiscal),
        cnaeDescricao: texto(origem.cnae_fiscal_descricao),
        cnaesSecundarios,
        endereco: montarEndereco(origem),
        municipio: texto(origem.municipio),
        uf: texto(origem.uf),
        cep: somenteDigitos(origem.cep),
        telefones: telefonesDaEmpresa(origem),
        email: texto(origem.email).toLowerCase(),
        socios
    };
}

module.exports = {
    somenteDigitos,
    digitoCnpj,
    validarCnpj,
    formatarCnpj,
    formatarCnae,
    montarEndereco,
    telefonesDaEmpresa,
    normalizarEmpresa
};

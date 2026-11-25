/* =========================================================
   QGC TEAM by JV - Processador de "Lista Suja" (ETL local)
   ---------------------------------------------------------
   Transforma o dump bruto (blocos LIVE C6 PJ com "CNPJ:",
   "CPF Persona:", "--- DADOS DA EMPRESA ---",
   "--- DADOS DA PERSONA (CPF) ---" e "--- SOCIOS ---")
   em três artefatos:

     1) lista de CPFs para o extrator (um por linha,
        no formato 000.000.000-00);
     2) cadastro da empresa + persona + sócios (vai para a
        ficha do cliente quando o disparo for importado);
     3) lista final pronta para disparo, no formato:

            {telefone_e164};{nome_completo};{cnpj_formatado}

   Pipeline (tudo em memória, roda no navegador):
     A) parsing: segmenta por "CNPJ:", separa a seção de
        sócios, mapeia chaves e normaliza telefones;
     B) validação: CPF pelo dígito verificador (CPF inválido
        -> descartado). Registro sem telefone real fica em
        "aguardando extrator" (não é descartado);
     C) extrator: casa a saída (CPF completo, CPF mascarado
        ou nome) e junta os telefones revelados;
     D) saída: 1 linha por telefone (deduplicado).

   Uso no navegador: <script src="lista-suja.js"></script>
   Uso no Node (testes): require('./lista-suja')
   ========================================================= */

'use strict';

/* ---------- utilidades ---------- */

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

function normalizarTexto(valor) {
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

/* Formato de exibição: 000.000.000-00 */
function formatarCpf(valor) {
    const digitos = apenasDigitos(valor).slice(0, 11);
    if (digitos.length !== 11) return '';
    return digitos.slice(0, 3) + '.' + digitos.slice(3, 6) + '.' + digitos.slice(6, 9) + '-' + digitos.slice(9);
}

/* Chave que o painel do extrator devolve: 000.000.xxx-xx.
   Serve só para casar a resposta com o registro — nunca para consultar. */
function mascararCpf(valor) {
    const digitos = apenasDigitos(valor).slice(0, 11);
    if (digitos.length !== 11) return '';
    return digitos.slice(0, 3) + '.' + digitos.slice(3, 6) + '.xxx-xx';
}

/* Compara um CPF completo ou mascarado (000.000.xxx-xx, ***.312.***-**) com
   um CPF de 11 dígitos. Posições com x/* são curinga. */
function cpfCombina(entrada, cpf) {
    const alvo = apenasDigitos(cpf).slice(0, 11);
    if (alvo.length !== 11) return false;

    const limpo = String(entrada == null ? '' : entrada).replace(/[^\dxX*]/g, '').toLowerCase();
    if (limpo.length !== 11) return false;

    for (let i = 0; i < 11; i += 1) {
        if (/[0-9]/.test(limpo[i]) && limpo[i] !== alvo[i]) return false;
    }

    return true;
}

/* ---------- telefones ---------- */

/* Mantém só o primeiro valor útil de um campo (as listas vêm multilinha). */
function campoLimpo(valor) {
    const texto = String(valor == null ? '' : valor).split(/\r?\n/)[0].trim();

    if (!texto || /^-+$/.test(texto) || /^sem informa/i.test(texto)) return '';
    if (!/[a-zA-Z0-9\u00C0-\u00FF]/.test(texto)) return '';

    return texto;
}

/* Formato brasileiro padrão: XX.XXX.XXX/XXXX-XX */
function formatarCnpj(valor) {
    const digitos = apenasDigitos(valor);
    if (digitos.length !== 14) return digitos;
    return digitos.slice(0, 2) + '.' + digitos.slice(2, 5) + '.' + digitos.slice(5, 8) +
        '/' + digitos.slice(8, 12) + '-' + digitos.slice(12);
}

/* CEP: 12600040 -> 12600-040 (devolve o texto original se não tiver 8 dígitos). */
function formatarCep(valor) {
    const texto = campoLimpo(valor);
    const digitos = apenasDigitos(texto);

    if (digitos.length !== 8) return texto;
    return digitos.slice(0, 5) + '-' + digitos.slice(5);
}

/* "LORENA - SP" -> { cidade: 'LORENA', uf: 'SP' } */
function separarCidadeUf(valor) {
    const texto = campoLimpo(valor);
    const achado = /^(.*?)\s*[-/]\s*([A-Za-z]{2})$/.exec(texto);

    if (!achado) return { cidade: texto, uf: '' };
    return { cidade: achado[1].trim(), uf: achado[2].toUpperCase() };
}

/* Telefone de exibição: 5511980990083 -> (11) 98099-0083 */
function formatarTelefoneBr(valor) {
    const e164 = normalizarTelefone(valor);
    if (!e164) return '';

    const ddd = e164.slice(2, 4);
    const numero = e164.slice(4);

    if (numero.length === 9) return '(' + ddd + ') ' + numero.slice(0, 5) + '-' + numero.slice(5);
    return '(' + ddd + ') ' + numero.slice(0, 4) + '-' + numero.slice(4);
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

    /* crus: 10-11 dígitos isolados, ou 12-13 já com DDI 55 */
    const crus = alvo.match(/(?<![\d.])(?:55\d{10,11}|\d{10,11})(?![\d.])/g) || [];
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

/* Rótulos que abrem um registro. O dump muda de versão para versão:
   "CPF Persona:", "CPF da Persona:", "CPF Persona (Titular):". */
const ROTULO_CNPJ = 'CNPJ\\s*(?:\\([^)\\n]*\\))?\\s*:';
const ROTULO_CPF_PERSONA = 'CPF\\s*(?:da\\s+)?Persona\\s*(?:\\([^)\\n]*\\))?\\s*:';

/* Espaços invisíveis (NBSP, ideográfico, zero-width) viram espaço comum:
   ao copiar de PDF/HTML eles entram no começo da linha e o rótulo deixa de
   casar com "^CPF Persona:". */
function normalizarEspacos(texto) {
    return String(texto == null ? '' : texto)
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
}

/* Cópia de PDF/tabela às vezes esmaga o dump em uma linha só. Aqui as quebras
   voltam: antes de cada marcador de seção (--- ... ---) e antes de cada
   rótulo conhecido do dump, para o parser voltar a ler campo por campo. */
const ROTULOS_DUMP = [
    'cnpj',
    'cpf\\s*(?:da\\s+)?persona',
    'cpf\\s*completo',
    'cpf\\s*mascarado',
    'cpf',
    'raz[aã]o\\s+social',
    'nome\\s+fantasia',
    'nome\\s+da\\s+m[aã]e',
    'nome',
    'situa[çc][aã]o',
    'capital\\s+social',
    'in[ií]cio\\s+atividade',
    'data\\s+entrada',
    'qualifica[çc][aã]o',
    'logradouro',
    'nascimento',
    'endere[çc]o',
    'bairro',
    'cidade',
    'telefones',
    'telefone\\s+desmascarado',
    'telefone\\s+cadastro',
    'tel\\s+empresa\\s+[12]',
    'email\\s+empresa',
    'email',
    's[óo]cios',
    'porte',
    'renda',
    'sexo',
    'cep',
    'uf'
];

const ROTULOS_DUMP_ORDENADOS = ROTULOS_DUMP
    .slice()
    .sort((a, b) => b.length - a.length)
    .join('|');

/* Quebra antes de um rótulo que aparece no meio da linha; rótulos que já
   abrem linha (mesmo indentados) ficam como estão. */
const QUEBRA_ANTES_DE_ROTULO = new RegExp(
    '(?<=\\S)[ \\t]*(?=(?:' + ROTULOS_DUMP_ORDENADOS + ')\\b(?:\\s*\\([^)\\n]{0,40}\\))?\\s*:)',
    'gi'
);

const QUEBRA_ANTES_DE_SECAO = /(?<=\S)[ \t]*(?=-{2,}\s*[A-ZÀ-Ú])/g;

function restaurarQuebras(texto) {
    return String(texto == null ? '' : texto)
        .replace(QUEBRA_ANTES_DE_SECAO, '\n')
        .replace(QUEBRA_ANTES_DE_ROTULO, '\n');
}

/* Divide o texto bruto em blocos. O dump LIVE C6 PJ traz o CNPJ ANTES do
   CPF Persona; segmentar pelo CPF jogaria o CNPJ de um registro para dentro
   do bloco anterior. Então, quando o texto tem blocos com "CNPJ:", corta por
   ali; se não, mantém o comportamento antigo (por "CPF Persona:"). */
function segmentarBlocos(texto) {
    const limpo = texto;

    const inicioCnpj = new RegExp('^[ \\t]*(?=' + ROTULO_CNPJ + ')', 'im');
    const inicioCpf = new RegExp('^[ \\t]*(?=' + ROTULO_CPF_PERSONA + ')', 'im');
    const testeCpf = new RegExp('^[ \\t]*' + ROTULO_CPF_PERSONA, 'im');

    const cortar = (padrao) => limpo
        .split(padrao)
        .map((parte) => parte.trim())
        .filter((parte) => parte && testeCpf.test(parte));

    /* Sem nenhum rótulo no começo de linha o texto não é um dump por
       blocos — devolve vazio para a mensagem de ajuda explicar o motivo. */
    if (!inicioCpf.test(limpo) && !inicioCnpj.test(limpo)) return [];

    const porCpf = cortar(inicioCpf);

    const indiceCnpj = limpo.search(new RegExp('^[ \\t]*' + ROTULO_CNPJ, 'im'));
    const indiceCpf = limpo.search(new RegExp('^[ \\t]*' + ROTULO_CPF_PERSONA, 'im'));

    /* Só corta por CNPJ quando ele abre o registro (LIVE C6 PJ). No dump
       antigo o CNPJ vem depois do CPF Persona e o corte por CNPJ perderia. */
    if (indiceCnpj < 0 || (indiceCpf >= 0 && indiceCpf < indiceCnpj)) return porCpf;

    const porCnpj = cortar(inicioCnpj);
    const totalCnpj = (limpo.match(new RegExp('^[ \\t]*' + ROTULO_CNPJ, 'gim')) || []).length;

    return porCnpj.length && porCnpj.length === totalCnpj ? porCnpj : porCpf;
}

/* Sem blocos na primeira tentativa, pode ser a colagem que perdeu as quebras
   (PDF/tabela): recoloca as quebras antes dos rótulos e tenta outra vez. */
function segmentarRegistros(texto) {
    const limpo = normalizarEspacos(texto);
    const direto = segmentarBlocos(limpo);
    if (direto.length) return direto;

    const recuperado = restaurarQuebras(limpo);
    if (recuperado === limpo) return [];

    return segmentarBlocos(recuperado);
}

/* Explica o que o parser viu, para o usuário corrigir a colagem sozinho. */
function mensagemFormato(texto) {
    const limpo = normalizarEspacos(texto);
    const totalCnpj = (limpo.match(new RegExp(ROTULO_CNPJ, 'gi')) || []).length;
    const totalCpf = (limpo.match(new RegExp(ROTULO_CPF_PERSONA, 'gi')) || []).length;
    const cpfNoInicio = (limpo.match(new RegExp('^[ \\t]*' + ROTULO_CPF_PERSONA, 'gim')) || []).length;
    const linhas = limpo.split('\n').filter((linha) => linha.trim()).length;

    let dica;

    if (!totalCpf) {
        dica = 'Não achei nenhum rótulo "CPF Persona:" no texto — confira se o dump certo foi colado.';
    } else if (!cpfNoInicio) {
        dica = 'Há ' + totalCpf + ' "CPF Persona:" no meio do texto, mas nenhum abrindo uma linha: '
            + 'as quebras de linha se perderam na cópia. Cole de novo mantendo uma linha por campo.';
    } else {
        dica = 'Nenhum bloco ficou completo (CNPJ + CPF Persona no mesmo registro).';
    }

    return 'Nenhuma lista reconhecida no texto colado. ' + dica
        + ' Li ' + linhas + ' linha(s), com ' + totalCnpj + ' "CNPJ:" e ' + totalCpf + ' "CPF Persona:".';
}

/* Busca uma chave aceitando variações do rótulo: "CPF Persona",
   "CPF da Persona" ou "CPF Persona (Titular)" (o texto entre parênteses
   entra na chave e viraria outra chave). */
function lerChave(chaves, ...nomes) {
    const alvos = nomes.map((nome) => normalizarTexto(nome));

    const exata = alvos.find((alvo) => chaves[alvo]);
    if (exata) return chaves[exata];

    const parecida = Object.keys(chaves).find((chave) =>
        alvos.some((alvo) => chave.startsWith(alvo + ' ('))
    );

    return parecida ? chaves[parecida] : '';
}

/* Lê as chaves "Chave: valor" de um bloco; linhas sem chave viram
   continuação da última chave (listas de telefones, endereços...). */
function extrairChaves(bloco) {
    const chaves = {};
    let chaveAtual = null;

    String(bloco || '').split(/\r?\n/).forEach((linha) => {
        const casada = /^\s*([^:]{1,50}?)\s*:\s*(.*)$/.exec(linha);

        if (casada) {
            chaveAtual = normalizarTexto(casada[1]);
            chaves[chaveAtual] = (chaves[chaveAtual] ? chaves[chaveAtual] + '\n' : '') + casada[2];
        } else if (chaveAtual && linha.trim()) {
            chaves[chaveAtual] += '\n' + linha;
        }
    });

    return chaves;
}

/* Separa o bloco principal da seção "--- SOCIOS (n) ---" e devolve um bloco
   por "[Socio n]". Sem isso, telefones/e-mails dos sócios entrariam nos dados
   da persona (todas as chaves repetidas são concatenadas). */
function separarSecoes(bloco) {
    const texto = String(bloco || '').replace(/\r\n?/g, '\n');
    const marcador = /^[ \t]*-{2,}\s*S[ÓO]CIOS?\b[^\n]*$/im.exec(texto);

    if (!marcador) return { principal: texto, socios: [] };

    const principal = texto.slice(0, marcador.index);
    const resto = texto.slice(marcador.index + marcador[0].length);

    const socios = resto
        .split(/^[ \t]*\[\s*S[ÓO]CIO\s+\d+\s*\][ \t]*$/im)
        .map((parte) => parte.trim())
        .filter(Boolean);

    return { principal, socios };
}

/* ---------- extração de campos ---------- */

function extrairEmpresa(chaves) {
    const local = separarCidadeUf(chaves['cidade']);
    const cnpj = apenasDigitos(campoLimpo(lerChave(chaves, 'cnpj'))).slice(0, 14);

    return {
        cnpj,
        cnpjFormatado: formatarCnpj(cnpj),
        razaoSocial: campoLimpo(chaves['razao social']),
        nomeFantasia: campoLimpo(chaves['nome fantasia']),
        situacao: campoLimpo(chaves['situacao']),
        porte: campoLimpo(chaves['porte']),
        capitalSocial: campoLimpo(chaves['capital social']),
        inicioAtividade: campoLimpo(chaves['inicio atividade']),
        logradouro: campoLimpo(chaves['logradouro']),
        bairro: campoLimpo(chaves['bairro']),
        cidade: local.cidade,
        uf: local.uf,
        cep: formatarCep(chaves['cep']),
        telefone1: formatarTelefoneBr(chaves['tel empresa 1']),
        telefone2: formatarTelefoneBr(chaves['tel empresa 2']),
        email: campoLimpo(chaves['email empresa'])
    };
}

function extrairPersona(chaves) {
    /* Telefone desmascarado (quando o dump já trouxe) vale mais que o mascarado. */
    const textoTelefones = ['telefone desmascarado', 'telefone cadastro', 'telefones']
        .map((chave) => chaves[chave])
        .filter(Boolean)
        .join('\n');

    return {
        nome: campoLimpo(chaves['nome']),
        nascimento: campoLimpo(chaves['nascimento']),
        nomeMae: campoLimpo(chaves['nome da mae']),
        sexo: campoLimpo(chaves['sexo']),
        email: campoLimpo(chaves['email']),
        telefones: extrairTelefones(textoTelefones),
        endereco: campoLimpo(chaves['endereco'])
    };
}

function extrairSocio(bloco) {
    const chaves = extrairChaves(bloco);
    const cpf = apenasDigitos(
        campoLimpo(chaves['cpf completo']) || campoLimpo(chaves['cpf'])
    ).slice(0, 11);

    return {
        nome: campoLimpo(chaves['nome']),
        qualificacao: campoLimpo(chaves['qualificacao']),
        dataEntrada: campoLimpo(chaves['data entrada']),
        cpf,
        cpfFormatado: formatarCpf(cpf),
        cpfMascarado: mascararCpf(cpf),
        cpfMascaradoOrigem: campoLimpo(chaves['cpf mascarado']),
        nascimento: campoLimpo(chaves['nascimento']),
        nomeMae: campoLimpo(chaves['nome da mae']),
        renda: campoLimpo(chaves['renda']),
        telefones: extrairTelefones(chaves['telefones']),
        email: campoLimpo(chaves['email']),
        endereco: campoLimpo(chaves['endereco'])
    };
}

/* ---------- pipeline por registro ---------- */

function processarRegistro(bloco) {
    const secoes = separarSecoes(bloco);
    const chaves = extrairChaves(secoes.principal);

    /* B1: CPF Persona precisa passar pelo dígito verificador */
    const cpf = apenasDigitos(campoLimpo(lerChave(chaves, 'cpf persona', 'cpf da persona'))).slice(0, 11);

    if (!validarCpf(cpf)) {
        return { descartado: true, motivo: 'CPF Inválido', bruto: bloco };
    }

    const empresa = extrairEmpresa(chaves);
    const persona = extrairPersona(chaves);
    const socios = secoes.socios
        .map(extrairSocio)
        .filter((socio) => socio.nome || socio.cpfFormatado);

    /* Telefones reais encontrados no próprio dump (quando existirem).
       Sem nenhum, o registro fica aguardando a saída do extrator. */
    const telefones = persona.telefones.slice();

    return {
        pronto: true,
        cpf,
        cpfFormatado: formatarCpf(cpf),
        cpfMascarado: mascararCpf(cpf),
        nome: persona.nome,
        cnpj: empresa.cnpjFormatado,
        persona,
        empresa,
        socios,
        telefones,
        aguardandoExtrator: !telefones.length,
        linhas: telefones.map((telefone) => telefone + ';' + persona.nome + ';' + empresa.cnpjFormatado)
    };
}

/* Monta as linhas de disparo a partir dos telefones atuais do registro. */
function linhasDoRegistro(registro) {
    return (registro.telefones || [])
        .map((telefone) => telefone + ';' + (registro.nome || '') + ';' + (registro.cnpj || ''));
}

/* ---------- API principal ---------- */

/* Um registro por CNPJ (a mesma empresa pode aparecer repetida no dump). */
function registrosUnicos(registros) {
    const vistos = new Set();
    const saida = [];

    (registros || []).forEach((registro) => {
        const chave = (registro.empresa && registro.empresa.cnpj) || registro.cpf;
        if (!chave || vistos.has(chave)) return;
        vistos.add(chave);
        saida.push(registro);
    });

    return saida;
}

function processarListaSuja(texto) {
    const registros = segmentarRegistros(texto);

    if (!registros.length) {
        const erro = new Error(mensagemFormato(texto));
        erro.codigo = 'formato';
        throw erro;
    }

    const prontos = [];
    const aguardando = [];
    const descartados = [];

    registros.forEach((bloco) => {
        try {
            const resultado = processarRegistro(bloco);

            if (resultado.descartado) {
                descartados.push({ motivo: resultado.motivo, bruto: bloco.slice(0, 400) });
            } else if (resultado.telefones.length) {
                prontos.push(resultado);
            } else {
                aguardando.push(resultado);
            }
        } catch (erro) {
            /* dado malformado nunca derruba o processamento */
            descartados.push({ motivo: 'Erro ao processar: ' + erro.message, bruto: bloco.slice(0, 400) });
        }
    });

    const validos = prontos.concat(aguardando);
    const linhas = [];
    prontos.forEach((registro) => linhas.push.apply(linhas, registro.linhas));

    return {
        registros: registros.length,
        prontos,
        aguardando,
        semTelefone: aguardando,
        validos,
        descartados,
        linhas,
        /* CPFs completos, um por linha, para colar no extrator */
        cpfs: validos.map((registro) => registro.cpfFormatado),
        cpfsSemTelefone: aguardando.map((registro) => registro.cpfFormatado),
        empresas: registrosUnicos(validos).map((registro) => Object.assign({}, registro.empresa, {
            cpfPersona: registro.cpfFormatado,
            nomePersona: registro.nome,
            socios: registro.socios
        }))
    };
}

/* ---------- saída do extrator ---------- */

/* Junta os telefones de um item (JSON do painel, array de objetos ou texto). */
function telefonesDoItem(item) {
    const saida = [];

    function juntar(valor) {
        if (valor == null || valor === '') return;
        if (Array.isArray(valor)) { valor.forEach(juntar); return; }

        if (typeof valor === 'object') {
            juntar(valor.wati);
            juntar(valor.e164);
            juntar(valor.numero);
            juntar(valor.formatado);
            juntar(valor.revelado);
            juntar(valor.telefone);
            juntar(valor.telefones);
            return;
        }

        extrairTelefones(String(valor)).forEach((telefone) => {
            if (!saida.includes(telefone)) saida.push(telefone);
        });
    }

    juntar(item && item.telefones);
    juntar(item && item.telefone);
    juntar(item && item.telefones_wati);
    juntar(item && item.revelado);
    juntar(item && item.wati);

    return saida;
}

const REGEX_CPF_FORMATADO = /[\d*xX]{3}\s*\.\s*[\d*xX]{3}\s*\.\s*[\d*xX]{3}\s*-\s*[\d*xX]{2}/g;

function itensDoJson(dados) {
    const lista = Array.isArray(dados)
        ? dados
        : (dados && (dados.resultados || dados.registros || dados.itens || dados.linhas));

    if (!Array.isArray(lista)) return null;

    return lista.map((item) => ({
        cpf: String((item && (item.cpf || item.CPF || item.documento)) || ''),
        nome: String((item && (item.nome || item.NOME || item.name)) || ''),
        telefones: telefonesDoItem(item || {}),
        texto: ''
    }));
}

/* Colunas separadas por ; ou Tab (o CSV do extrator usa ; e os nomes não
   têm vírgula; a vírgula fica de fora para não quebrar "SILVA, JOAO"). */
function camposDaLinha(linha) {
    if (linha.indexOf(';') === -1 && linha.indexOf('\t') === -1) return null;

    const campos = linha.split(/\s*[;\t]\s*/).map((campo) => campo.trim());
    return campos.length >= 2 ? campos : null;
}

/* Nome de pessoa: letras/espaços, sem dígito, e-mail ou barra (por isso
   "12/11/1980" e "N/A" não passam). */
function pareceNome(valor) {
    const texto = String(valor == null ? '' : valor).trim();

    if (texto.length < 4 || texto.length > 80) return false;
    return /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.\s-]*$/.test(texto);
}

function acharColuna(chaves, nomes) {
    for (let i = 0; i < chaves.length; i += 1) {
        if (nomes.indexOf(chaves[i]) >= 0) return i;
    }

    return -1;
}

/* Cada linha pode ser "000.000.000-00;5511...", "✓ [LIVE] NOME | Mask: ... |
   Revelado: 11999...", o CSV do extrator
   "CPF;NOME;NASCIMENTO;RENDA;EMAIL;BANCO;AGENCIA;CONTA;MASK;REVELADO"
   ou "NOME;5511..." (nesse caso casa pelo nome). */
function itensDoTexto(texto) {
    const itens = [];
    let colunas = null; /* mapa do cabeçalho do CSV do extrator */

    String(texto || '').replace(/\r\n?/g, '\n').split('\n').forEach((linha) => {
        if (!linha.trim()) return;

        const campos = camposDaLinha(linha);

        /* Cabeçalho do CSV: guarda onde está o CPF, o nome e o telefone
           revelado e passa para a próxima linha. */
        if (campos) {
            const chaves = campos.map((campo) => normalizarTexto(campo).replace(/\s+/g, ' '));

            if (chaves.indexOf('cpf') >= 0 || chaves.indexOf('revelado') >= 0) {
                colunas = {
                    cpf: acharColuna(chaves, ['cpf', 'cpf persona', 'documento']),
                    nome: acharColuna(chaves, ['nome', 'nome persona', 'titular', 'cliente']),
                    telefone: acharColuna(chaves, ['revelado', 'telefone', 'telefones', 'celular', 'whatsapp'])
                };
                return;
            }
        }

        const cpfs = linha.match(REGEX_CPF_FORMATADO) || [];
        let semCpf = linha.replace(REGEX_CPF_FORMATADO, ' ');

        (semCpf.match(/\b\d{11}\b/g) || []).forEach((achado) => {
            if (validarCpf(achado)) cpfs.push(achado);
        });

        if (cpfs.length) {
            semCpf = semCpf.replace(/\b\d{11}\b/g, (achado) => (validarCpf(achado) ? ' ' : achado));
        }

        const live = /\[\s*LIVE\s*\]\s*(.+?)\s*\|/i.exec(linha);
        let nome = live ? live[1].trim() : '';
        let telefones = null;

        /* CSV do extrator: cada dado vem da sua coluna, então nascimento,
           renda, agência e conta não viram telefone. */
        if (campos) {
            const cpfDaColuna = colunas && colunas.cpf >= 0 ? campos[colunas.cpf] : campos[0];
            const nomeDaColuna = colunas && colunas.nome >= 0 ? campos[colunas.nome] : campos[1];
            const telefoneDaColuna = colunas && colunas.telefone >= 0
                ? campos[colunas.telefone]
                : campos[campos.length - 1];

            if (!cpfs.length && cpfDaColuna && apenasDigitos(cpfDaColuna).length === 11) {
                cpfs.push(cpfDaColuna);
            }

            if (!nome && nomeDaColuna && pareceNome(nomeDaColuna)) nome = nomeDaColuna;

            if (telefoneDaColuna) telefones = extrairTelefones(telefoneDaColuna);
        }

        if (!telefones || !telefones.length) telefones = extrairTelefones(semCpf);

        if (!cpfs.length && !telefones.length && !nome) return;

        itens.push({
            cpf: cpfs[0] || '',
            nome: nome ? nome.trim() : '',
            telefones,
            texto: linha.trim()
        });
    });

    return itens;
}

function normalizarEntradaExtrator(entrada) {
    if (entrada && typeof entrada === 'object') {
        const doJson = itensDoJson(entrada);
        if (doJson) return doJson;
    }

    const texto = String(entrada == null ? '' : entrada).trim();
    if (!texto) return [];

    if (texto.charAt(0) === '{' || texto.charAt(0) === '[') {
        try {
            const doJson = itensDoJson(JSON.parse(texto));
            if (doJson) return doJson;
        } catch (erro) { /* não era JSON: cai na leitura por linha */ }
    }

    return itensDoTexto(texto);
}

/* Casa a saída do extrator com os registros do dump (CPF completo, CPF
   mascarado 000.000.xxx-xx ou nome) e junta os telefones revelados. */
function aplicarResultadoExtrator(registros, entrada) {
    const itens = normalizarEntradaExtrator(entrada);
    const atualizados = (registros || []).map((registro) => Object.assign({}, registro, {
        telefones: (registro.telefones || []).slice()
    }));
    const naoEncontrados = [];
    let aplicados = 0;
    let jaAplicados = 0;
    let semTelefoneNaLinha = 0;

    itens.forEach((item) => {
        let alvo = null;

        if (item.cpf) {
            const candidatos = atualizados.filter((registro) => cpfCombina(item.cpf, registro.cpf));

            if (candidatos.length === 1) {
                alvo = candidatos[0];
            } else if (candidatos.length > 1 && item.nome) {
                /* CPF mascarado só mostra 6 dígitos: desempata pelo nome. */
                const chave = normalizarTexto(item.nome);
                const porNome = candidatos.filter((registro) => normalizarTexto(registro.nome) === chave);
                if (porNome.length === 1) alvo = porNome[0];
            }
        }

        if (!alvo && item.nome) {
            const chave = normalizarTexto(item.nome);
            const iguais = atualizados.filter((registro) => normalizarTexto(registro.nome) === chave);
            if (iguais.length === 1) alvo = iguais[0];
        }

        if (!alvo && item.nome) {
            const procurado = ' ' + normalizarTexto(item.texto || item.nome) + ' ';
            const contidos = atualizados.filter((registro) => {
                const nome = normalizarTexto(registro.nome);
                return nome.length >= 8 && procurado.indexOf(' ' + nome + ' ') >= 0;
            });
            if (contidos.length === 1) alvo = contidos[0];
        }

        if (!alvo) {
            naoEncontrados.push(item);
            return;
        }

        if (!item.telefones.length) semTelefoneNaLinha += 1;

        let novos = 0;
        item.telefones.forEach((telefone) => {
            if (alvo.telefones.includes(telefone)) return;
            alvo.telefones.push(telefone);
            novos += 1;
        });

        if (novos) aplicados += 1;
        else jaAplicados += 1;
    });

    atualizados.forEach((registro) => {
        registro.aguardandoExtrator = !registro.telefones.length;
        registro.linhas = linhasDoRegistro(registro);
    });

    return {
        registros: atualizados,
        aplicados,
        jaAplicados,
        semTelefoneNaLinha,
        naoEncontrados,
        linhas: itens.length
    };
}

/* ---------- cadastro da empresa / importação ---------- */

/* Campos da empresa/persona que viram atributos do cliente na importação
   (a ficha do cliente no painel já exibe clientes.atributos). */
const ATRIBUTOS_CADASTRO = [
    'razao_social', 'nome_fantasia', 'situacao', 'porte', 'capital_social',
    'inicio_atividade', 'logradouro', 'bairro', 'cidade', 'uf', 'cep',
    'tel_empresa_1', 'tel_empresa_2', 'email_empresa', 'cpf', 'nascimento',
    'nome_mae', 'sexo', 'email', 'endereco', 'socios'
];

const COLUNAS_CADASTRO = ['cnpj'].concat(ATRIBUTOS_CADASTRO).concat(['nome']);

function celulaCsv(valor) {
    return String(valor == null ? '' : valor).replace(/[\r\n;]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/* Uma linha por empresa (CNPJ), com persona e sócios — para guardar/baixar. */
function montarCadastroCsv(registros) {
    const linhas = registrosUnicos(registros).map((registro) => {
        const empresa = registro.empresa || {};
        const persona = registro.persona || {};
        const socios = (registro.socios || []).map((socio) => socio.nome).filter(Boolean).join(' | ');

        return [
            empresa.cnpjFormatado, empresa.razaoSocial, empresa.nomeFantasia, empresa.situacao,
            empresa.porte, empresa.capitalSocial, empresa.inicioAtividade, empresa.logradouro,
            empresa.bairro, empresa.cidade, empresa.uf, empresa.cep, empresa.telefone1,
            empresa.telefone2, empresa.email, registro.cpfFormatado, persona.nascimento,
            persona.nomeMae, persona.sexo, persona.email, persona.endereco, socios,
            persona.nome || registro.nome
        ].map(celulaCsv).join(';');
    });

    return { colunas: COLUNAS_CADASTRO, linhas };
}

/* Lista final de importação com as 3 primeiras colunas do disparo
   (telefone;{{1}}=nome;{{2}}=CNPJ) + os dados da empresa como atributos. */
function montarLinhasComEmpresa(registros) {
    const cabecalho = ['telefone', '{{1}}', '{{2}}'].concat(ATRIBUTOS_CADASTRO).join(';');
    const linhas = [];

    (registros || []).forEach((registro) => {
        const empresa = registro.empresa || {};
        const persona = registro.persona || {};
        const socios = (registro.socios || []).map((socio) => socio.nome).filter(Boolean).join(' | ');

        (registro.telefones || []).forEach((telefone) => {
            linhas.push([
                telefone, registro.nome, registro.cnpj, empresa.razaoSocial, empresa.nomeFantasia,
                empresa.situacao, empresa.porte, empresa.capitalSocial, empresa.inicioAtividade,
                empresa.logradouro, empresa.bairro, empresa.cidade, empresa.uf, empresa.cep,
                empresa.telefone1, empresa.telefone2, empresa.email, registro.cpfFormatado,
                persona.nascimento, persona.nomeMae, persona.sexo, persona.email,
                persona.endereco, socios
            ].map(celulaCsv).join(';'));
        });
    });

    return { cabecalho, linhas };
}




if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        processarListaSuja,
        processarRegistro,
        segmentarRegistros,
        restaurarQuebras,
        mensagemFormato,
        normalizarEspacos,
        extrairChaves,
        separarSecoes,
        extrairEmpresa,
        extrairPersona,
        extrairSocio,
        extrairTelefones,
        normalizarTelefone,
        normalizarEntradaExtrator,
        aplicarResultadoExtrator,
        montarCadastroCsv,
        montarLinhasComEmpresa,
        linhasDoRegistro,
        registrosUnicos,
        validarCpf,
        formatarCpf,
        mascararCpf,
        cpfCombina,
        formatarCnpj,
        formatarCep,
        separarCidadeUf,
        formatarTelefoneBr,
        normalizarTexto,
        normalizarChave: normalizarTexto,
        apenasDigitos
    };
}

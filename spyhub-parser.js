'use strict';
/* =========================================================
   QGC TEAM by JV - Parser da Verificação SpyHub
   ---------------------------------------------------------
   Transforma a lista bruta (dump do LIVE C6 PJ, colado em
   blocos separados por "=====") ou um CSV em registros:

     { cnpj, cpf, cpfFormatado, nome, razaoSocial, nomeFantasia,
       telefoneDesmascarado, endereco, finais: ['0906'], ficha }

   Regras (as mesmas que o painel mostra na tela):
     - CPF vem de "CPF Persona" (só dígitos) e passa pelo
       dígito verificador; bloco sem CPF válido é ignorado;
     - nome vem de "Nome Persona" (ou "Nome"/"Nome completo")
       e acompanha o registro até o CSV dos aprovados;
     - final vem de "Final visivel" e, se faltar, dos 4
       últimos dígitos de "Telefone cadastro";
     - a ficha original é preservada inteira para o caso
       "não encontrado".

   Módulo puro (navegador + Node), sem dependências.
   ========================================================= */

const SEPARADOR_BLOCO = /^\s*={6,}\s*$/;
const ROTULO = /^\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ()/.-]{0,45}?)\s*:\s*(.*)$/;
/* "--- DADOS DA EMPRESA ---" e "=====" são títulos de seção, não valor do campo anterior. */
const TITULO_SECAO = /^\s*(?:-{3,}|={3,}|_{3,}).*(?:-{3,}|={3,}|_{3,})\s*$/;
/* Rótulos que trazem o nome da persona. A ordem importa: o rótulo específico
   vence o genérico ("Nome da mae" e "Nome fantasia" não entram aqui). */
const CHAVES_NOME = ['nome_persona', 'nome_da_persona', 'nome_completo', 'nome_pessoa',
    'nome_pf', 'nome_titular', 'nome'];

function apenasDigitos(valor) {
    return String(valor == null ? '' : valor).replace(/\D/g, '');
}

function limpar(valor) {
    return String(valor == null ? '' : valor).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

/* "Nome da mae" -> "nome_da_mae"; "Tel Empresa 1" -> "tel_empresa_1" */
function normalizarChave(texto) {
    return limpar(texto)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/* Dígito verificador do CPF (rejeita 111.111.111-11 e afins). */
function validarCpf(valor) {
    const cpf = apenasDigitos(valor);

    if (cpf.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(cpf)) return false;

    const calcular = (base) => {
        let soma = 0;
        for (let i = 0; i < base.length; i += 1) {
            soma += Number(base[i]) * (base.length + 1 - i);
        }
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };

    return calcular(cpf.slice(0, 9)) === Number(cpf[9]) && calcular(cpf.slice(0, 10)) === Number(cpf[10]);
}

function formatarCpf(valor) {
    const cpf = apenasDigitos(valor);
    if (cpf.length !== 11) return cpf;
    return cpf.slice(0, 3) + '.' + cpf.slice(3, 6) + '.' + cpf.slice(6, 9) + '-' + cpf.slice(9);
}

function formatarCnpj(valor) {
    const cnpj = apenasDigitos(valor);
    if (cnpj.length !== 14) return cnpj;
    return cnpj.slice(0, 2) + '.' + cnpj.slice(2, 5) + '.' + cnpj.slice(5, 8) + '/' + cnpj.slice(8, 12) + '-' + cnpj.slice(12);
}

/* ---------- leitura dos campos de um bloco ---------- */

/* Devolve { chave: valor } e mantém listas (Telefones:) como texto multilinha. */
function lerCampos(bloco) {
    const campos = {};
    let atual = null;

    String(bloco || '').split(/\r?\n/).forEach((linha) => {
        if (!linha.trim()) return;

        if (TITULO_SECAO.test(linha)) {
            atual = null;
            return;
        }

        const achado = ROTULO.exec(linha);
        if (achado) {
            atual = normalizarChave(achado[1]);
            const valor = limpar(achado[2]);
            campos[atual] = campos[atual] && valor === '' ? campos[atual] : valor;
            return;
        }

        if (atual) {
            campos[atual] = (campos[atual] ? campos[atual] + '\n' : '') + limpar(linha);
        }
    });

    return campos;
}

function valorDe(campos, chaves) {
    for (const chave of chaves) {
        if (campos[chave]) return campos[chave];
    }
    return '';
}

/* Telefones de um campo multilinha (ou de um campo simples). */
function telefonesDoValor(valor) {
    return String(valor || '')
        .split(/[\n,;|]/)
        .map((linha) => limpar(linha))
        .filter((linha) => apenasDigitos(linha).length >= 8);
}

/* últimos 4 dígitos, quando o valor tem dígitos suficientes */
function finalDe(valor) {
    const digitos = apenasDigitos(valor);
    return digitos.length >= 4 ? digitos.slice(-4) : '';
}

function enderecoDaEmpresa(campos) {
    return [campos.logradouro, campos.bairro, campos.cidade, campos.cep]
        .map(limpar)
        .filter(Boolean)
        .join(', ');
}


/* ---------- bloco -> registro ---------- */

function problemaDoRegistro(registro) {
    if (!registro.cpf) return 'Bloco sem "CPF Persona"';
    if (!validarCpf(registro.cpf)) return 'CPF inválido (dígito verificador)';
    if (!registro.finais.length) return 'Sem "Final visivel" nem "Telefone cadastro"';
    return '';
}

function registroDoBloco(bloco, indice) {
    const campos = lerCampos(bloco);
    const ficha = String(bloco || '').replace(/^\s+|\s+$/g, '');

    const cpfBruto = valorDe(campos, ['cpf_persona', 'cpf_da_persona', 'cpf_persona_titular', 'cpf']);
    const cpf = apenasDigitos(cpfBruto);
    const cnpj = apenasDigitos(valorDe(campos, ['cnpj', 'cnpj_empresa']));

    const telefonesPersona = telefonesDoValor(campos.telefones);
    const telefonesEmpresa = telefonesDoValor(campos.tel_empresa_1).concat(telefonesDoValor(campos.tel_empresa_2));

    const telefoneDesmascarado = limpar(valorDe(campos, ['telefone_desmascarado', 'telefone_revelado']))
        || telefonesEmpresa[0]
        || telefonesPersona[0]
        || '';

    /* finais: "Final visivel" manda; senão, o fim de "Telefone cadastro"
       e, por último, o fim do telefone desmascarado. */
    const finais = [];
    const adicionarFinal = (valor) => {
        const final = finalDe(valor);
        if (final && finais.indexOf(final) === -1) finais.push(final);
    };

    adicionarFinal(valorDe(campos, ['final_visivel', 'final_visiveis', 'finais_visiveis', 'final']));
    if (!finais.length) adicionarFinal(valorDe(campos, ['telefone_cadastro']));
    if (!finais.length) adicionarFinal(telefoneDesmascarado);

    const endereco = limpar(valorDe(campos, ['endereco', 'endereco_persona'])) || enderecoDaEmpresa(campos);

    const registro = {
        indice: indice || 0,
        cnpj,
        cnpjFormatado: formatarCnpj(cnpj),
        cpf,
        cpfFormatado: formatarCpf(cpf),
        nome: limpar(valorDe(campos, CHAVES_NOME)),
        razaoSocial: limpar(valorDe(campos, ['razao_social', 'empresa'])),
        nomeFantasia: limpar(valorDe(campos, ['nome_fantasia', 'fantasia'])),
        telefoneDesmascarado,
        endereco,
        finais,
        ficha
    };

    const problema = problemaDoRegistro(registro);
    if (problema) return { registro: null, ignorado: { motivo: problema, cpf: cpfBruto, ficha } };

    return { registro, ignorado: null };
}

/* ---------- separação dos blocos ---------- */

/* Quebra por linhas de "=====" e, se não houver separador, a cada "CNPJ:"
   que abre um novo registro (dump colado sem as linhas de traço). */
function separarBlocos(texto) {
    const normalizado = String(texto || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u00a0/g, ' ');

    let blocos = [];
    let atual = [];

    normalizado.split('\n').forEach((linha) => {
        if (SEPARADOR_BLOCO.test(linha)) {
            blocos.push(atual.join('\n'));
            atual = [];
            return;
        }

        if (/^\s*cnpj\s*:/i.test(linha) && atual.some((item) => /^\s*cpf\s+persona\s*:/i.test(item))) {
            blocos.push(atual.join('\n'));
            atual = [];
        }

        atual.push(linha);
    });

    blocos.push(atual.join('\n'));

    return blocos
        .map((bloco) => bloco.replace(/^\s+|\s+$/g, ''))
        .filter((bloco) => bloco && /cpf\s+persona|cnpj\s*:/i.test(bloco));
}

/* ---------- CSV ---------- */

function detectarSeparador(linha) {
    const candidatos = [';', '\t', ','];
    let melhor = ';';
    let maior = 0;

    candidatos.forEach((separador) => {
        const total = linha.split(separador).length - 1;
        if (total > maior) {
            maior = total;
            melhor = separador;
        }
    });

    return melhor;
}

/* Divide uma linha de CSV respeitando aspas duplas. */
function dividirLinha(linha, separador) {
    const celulas = [];
    let atual = '';
    let dentroDeAspas = false;

    for (let i = 0; i < linha.length; i += 1) {
        const caractere = linha[i];

        if (caractere === '"') {
            if (dentroDeAspas && linha[i + 1] === '"') {
                atual += '"';
                i += 1;
            } else {
                dentroDeAspas = !dentroDeAspas;
            }
            continue;
        }

        if (caractere === separador && !dentroDeAspas) {
            celulas.push(atual);
            atual = '';
            continue;
        }

        atual += caractere;
    }

    celulas.push(atual);
    return celulas.map((celula) => celula.trim());
}

const COLUNAS_CSV = {
    cnpj: ['cnpj'],
    cpf: ['cpf', 'cpf_persona', 'cpf persona', 'cpf da persona'],
    nome: ['nome', 'nome_persona', 'nome persona', 'nome_completo', 'nome completo', 'nome da persona'],
    razaoSocial: ['razao_social', 'razao social', 'empresa'],
    nomeFantasia: ['nome_fantasia', 'nome fantasia', 'fantasia'],
    telefoneDesmascarado: ['telefone_desmascarado', 'telefone desmascarado', 'telefone', 'revelado'],
    endereco: ['endereco', 'endereço'],
    final: ['final', 'final_visivel', 'final visivel', 'finais', 'final_visiveis', 'ultimos_4', 'últimos 4'],
    telefoneCadastro: ['telefone_cadastro', 'telefone cadastro'],
    ficha: ['ficha', 'ficha_completa', 'dump']
};

function chaveDeColuna(cabecalho) {
    const chave = normalizarChave(cabecalho);

    for (const destino of Object.keys(COLUNAS_CSV)) {
        const achou = COLUNAS_CSV[destino].some((nome) => normalizarChave(nome) === chave);
        if (achou) return destino;
    }

    return '';
}

function pareceCsv(texto) {
    const linhas = String(texto || '').split(/\r?\n/).filter((linha) => linha.trim());
    if (linhas.length < 2) return false;

    const cabecalho = linhas[0];
    if (!/[;,\t]/.test(cabecalho)) return false;

    const chaves = dividirLinha(cabecalho, detectarSeparador(cabecalho)).map(chaveDeColuna).filter(Boolean);
    return chaves.indexOf('cpf') !== -1 && (chaves.indexOf('final') !== -1 || chaves.indexOf('telefoneCadastro') !== -1
        || chaves.indexOf('telefoneDesmascarado') !== -1);
}

function registrosDoCsv(texto) {
    const linhas = String(texto || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((linha) => linha.trim());
    const separador = detectarSeparador(linhas[0]);
    const cabecalho = dividirLinha(linhas[0], separador);
    const mapa = cabecalho.map(chaveDeColuna);

    const registros = [];
    const ignorados = [];
    const vistos = new Set();

    linhas.slice(1).forEach((linha, posicao) => {
        const celulas = dividirLinha(linha, separador);
        const campos = {};

        mapa.forEach((destino, indice) => {
            if (destino) campos[destino] = celulas[indice] || '';
        });

        const cpf = apenasDigitos(campos.cpf);
        const final = finalDe(campos.final) || finalDe(campos.telefoneCadastro);

        const registro = {
            indice: posicao + 1,
            cnpj: apenasDigitos(campos.cnpj),
            cnpjFormatado: formatarCnpj(campos.cnpj),
            cpf,
            cpfFormatado: formatarCpf(cpf),
            nome: limpar(campos.nome),
            razaoSocial: limpar(campos.razaoSocial),
            nomeFantasia: limpar(campos.nomeFantasia),
            telefoneDesmascarado: limpar(campos.telefoneDesmascarado),
            endereco: limpar(campos.endereco),
            finais: final ? [final] : [],
            ficha: limpar(campos.ficha) || linha
        };

        const problema = problemaDoRegistro(registro);
        if (problema) {
            ignorados.push({ motivo: problema, cpf: campos.cpf || '', ficha: linha });
            return;
        }

        const chave = registro.cpf + '|' + registro.finais.join(',');
        if (vistos.has(chave)) {
            ignorados.push({ motivo: 'Registro repetido', cpf: registro.cpfFormatado, ficha: linha });
            return;
        }

        vistos.add(chave);
        registros.push(registro);
    });

    return { formato: 'csv', registros, ignorados };
}

/* ---------- entrada (dump ou CSV) ---------- */

function registrosDoDump(texto) {
    const registros = [];
    const ignorados = [];
    const vistos = new Set();

    separarBlocos(texto).forEach((bloco, indice) => {
        const { registro, ignorado } = registroDoBloco(bloco, indice + 1);

        if (ignorado) {
            ignorados.push(ignorado);
            return;
        }

        const chave = registro.cpf + '|' + registro.finais.join(',');
        if (vistos.has(chave)) {
            ignorados.push({ motivo: 'Registro repetido', cpf: registro.cpfFormatado, ficha: registro.ficha });
            return;
        }

        vistos.add(chave);
        registros.push(registro);
    });

    return { formato: 'dump', registros, ignorados };
}

/* Ponto de entrada do backend: aceita o dump bruto ou o CSV. */
function parseEntrada(texto) {
    const bruto = String(texto == null ? '' : texto);

    if (!bruto.trim()) {
        return { formato: 'vazio', registros: [], ignorados: [], total: 0, ignoradosTotal: 0 };
    }

    const resultado = pareceCsv(bruto) ? registrosDoCsv(bruto) : registrosDoDump(bruto);

    return Object.assign({}, resultado, {
        total: resultado.registros.length,
        ignoradosTotal: resultado.ignorados.length
    });
}

/* Exportações usadas pela tela e pelos testes. */
const COLUNAS_APROVADOS = ['cnpj', 'cpf_persona', 'nome', 'razao_social', 'nome_fantasia',
    'telefone_desmascarado', 'endereco'];

function csvDeAprovados(aprovados) {
    const linhas = [COLUNAS_APROVADOS.join(';')];

    (aprovados || []).forEach((item) => {
        linhas.push([
            item.cnpjFormatado || item.cnpj,
            item.cpfFormatado || item.cpf,
            item.nome,
            item.razaoSocial,
            item.nomeFantasia,
            item.telefoneDesmascarado || item.telefoneEncontrado,
            item.endereco
        ].map((valor) => String(valor == null ? '' : valor).replace(/[\r\n]+/g, ' ').replace(/;/g, ',')).join(';'));
    });

    return linhas.join('\r\n') + '\r\n';
}

function txtDeReprovados(reprovados) {
    return (reprovados || [])
        .map((item) => {
            const cabecalho = '### ' + (item.cpfFormatado || item.cpf || 'sem CPF')
                + ' - finais ' + ((item.finais || []).join(', ') || '-')
                + ' - ' + (item.motivo || 'nao encontrado');
            const retorno = String(item.retorno || '').replace(/[\r\n]+/g, ' ').trim();
            return cabecalho + '\r\n' + String(item.ficha || '') + '\r\n'
                + (retorno ? 'Retorno do site: ' + retorno + '\r\n' : '');
        })
        .join('\r\n');
}

module.exports = {
    apenasDigitos,
    limpar,
    normalizarChave,
    validarCpf,
    formatarCpf,
    formatarCnpj,
    lerCampos,
    separarBlocos,
    parseEntrada,
    pareceCsv,
    detectarSeparador,
    dividirLinha,
    registrosDoCsv,
    registrosDoDump,
    finalDe,
    csvDeAprovados,
    txtDeReprovados,
    COLUNAS_APROVADOS
};

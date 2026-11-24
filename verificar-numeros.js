#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Verificador de listas de telefone
   ---------------------------------------------------------
   Lê uma lista .csv/.txt, confere cada telefone (DDD, fixo/
   celular) e devolve uma lista nova com o número completo no
   formato da Wati: 55 + DDD + número.

   Uso:
     node verificar-numeros.js lista.csv
     node verificar-numeros.js lista.csv saida.csv
     node verificar-numeros.js lista.csv --ddd=11 --coluna=1
     node verificar-numeros.js lista.csv --json

   O CSV de saída mantém todas as colunas originais (a coluna
   do telefone passa a ter o número completo) e acrescenta:
   status_telefone, tipo_telefone, e164, motivo_telefone.
   ========================================================= */

const fs = require('fs');
const path = require('path');
const { analisarTelefone } = require('./telefone');

const TERMOS_TELEFONE = /telefone|celular|whatsapp|fone|n[uú]mero/i;

function uso() {
    console.log([
        'Verifica e completa os telefones de uma lista.',
        '',
        'Uso:',
        '  node verificar-numeros.js <lista.csv|lista.txt> [saida.csv] [opções]',
        '',
        'Opções:',
        '  --coluna=N       coluna do telefone (1 = primeira). Padrão: detecta pelo cabeçalho.',
        '  --ddd=11         DDD usado quando o número vier sem DDD (8/9 dígitos).',
        '  --saida=arq.csv  nome do arquivo de saída.',
        '  --json           imprime o resultado em JSON (bom para integrar).',
        '  -h, --ajuda      mostra esta ajuda.',
        '',
        'Exemplo:',
        '  node verificar-numeros.js clientes.csv clientes-corrigidos.csv --ddd=11'
    ].join('\n'));
}

function lerArgumentos(argv) {
    const opcoes = { entrada: '', saida: '', ddd: '', coluna: 0, json: false, ajuda: false };
    const restantes = [];

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === '--json') opcoes.json = true;
        else if (arg === '-h' || arg === '--ajuda' || arg === '--help') opcoes.ajuda = true;
        else if (arg === '--ddd') opcoes.ddd = argv[(i += 1)] || '';
        else if (arg.startsWith('--ddd=')) opcoes.ddd = arg.slice(6);
        else if (arg === '--coluna') opcoes.coluna = parseInt(argv[(i += 1)], 10) || 0;
        else if (arg.startsWith('--coluna=')) opcoes.coluna = parseInt(arg.slice(9), 10) || 0;
        else if (arg === '--saida') opcoes.saida = argv[(i += 1)] || '';
        else if (arg.startsWith('--saida=')) opcoes.saida = arg.slice(8);
        else restantes.push(arg);
    }

    opcoes.entrada = restantes[0] || '';
    if (!opcoes.saida && restantes[1]) opcoes.saida = restantes[1];

    return opcoes;
}

/* Escolhe o separador com base na primeira linha (padrão do modelo: ";"). */
function detectarDelimitador(texto) {
    const primeira = texto.split(/\r?\n/).find((linha) => linha.trim()) || '';
    let melhor = ';';
    let maior = 0;

    [';', '\t', ','].forEach((candidato) => {
        const total = primeira.split(candidato).length - 1;
        if (total > maior) {
            maior = total;
            melhor = candidato;
        }
    });

    return melhor;
}

/* Lê CSV/TXT simples, aceitando campos entre aspas (com "" e quebra de linha). */
function lerCsv(texto, delimitador) {
    const linhas = [];
    let linha = [];
    let campo = '';
    let dentroAspas = false;

    for (let i = 0; i < texto.length; i += 1) {
        const caractere = texto[i];

        if (dentroAspas) {
            if (caractere === '"') {
                if (texto[i + 1] === '"') {
                    campo += '"';
                    i += 1;
                } else {
                    dentroAspas = false;
                }
            } else {
                campo += caractere;
            }
            continue;
        }

        if (caractere === '"') {
            dentroAspas = true;
        } else if (caractere === delimitador) {
            linha.push(campo);
            campo = '';
        } else if (caractere === '\n') {
            linha.push(campo);
            linhas.push(linha);
            linha = [];
            campo = '';
        } else if (caractere !== '\r') {
            campo += caractere;
        }
    }

    if (campo !== '' || linha.length) {
        linha.push(campo);
        linhas.push(linha);
    }

    return linhas.filter((colunas) => colunas.some((valor) => String(valor).trim() !== ''));
}

function escaparCampo(valor, delimitador) {
    const texto = String(valor == null ? '' : valor);

    if (texto.includes(delimitador) || texto.includes('"') || /[\r\n]/.test(texto)) {
        return '"' + texto.replace(/"/g, '""') + '"';
    }

    return texto;
}

function escreverCsv(linhas, delimitador) {
    return linhas
        .map((colunas) => colunas.map((valor) => escaparCampo(valor, delimitador)).join(delimitador))
        .join('\r\n') + '\r\n';
}

/* Cabeçalho quando tem um termo conhecido (telefone/celular...) ou quando a
   linha não traz nenhum telefone e tem texto. */
function pareceCabecalho(colunas) {
    if (colunas.some((valor) => TERMOS_TELEFONE.test(String(valor)))) return true;

    const temTelefone = colunas.some((valor) => {
        const digitos = String(valor).replace(/\D/g, '');
        return digitos.length >= 10 && digitos.length <= 13;
    });

    return !temTelefone && colunas.some((valor) => /[a-zA-ZÀ-ÿ]/.test(String(valor)));
}

function acharColunaTelefone(linhas, cabecalho) {
    // 1) Pelo nome da coluna.
    for (let i = 0; i < cabecalho.length; i += 1) {
        if (TERMOS_TELEFONE.test(String(cabecalho[i]))) return i;
    }

    // 2) Pela coluna que tem mais números com cara de telefone (10 a 13 dígitos).
    const totalColunas = linhas.reduce((maior, colunas) => Math.max(maior, colunas.length), 0);
    let melhor = -1;
    let melhorTaxa = 0;

    for (let i = 0; i < totalColunas; i += 1) {
        let preenchidas = 0;
        let comTelefone = 0;

        linhas.forEach((colunas) => {
            const valor = String(colunas[i] == null ? '' : colunas[i]).trim();
            if (!valor) return;

            preenchidas += 1;
            const digitos = valor.replace(/\D/g, '');
            if (digitos.length >= 10 && digitos.length <= 13) comTelefone += 1;
        });

        const taxa = preenchidas ? comTelefone / preenchidas : 0;
        if (taxa > melhorTaxa) {
            melhorTaxa = taxa;
            melhor = i;
        }
    }

    return melhorTaxa >= 0.5 ? melhor : -1;
}

function principal() {
    const opcoes = lerArgumentos(process.argv.slice(2));

    if (opcoes.ajuda || !opcoes.entrada) {
        uso();
        process.exit(opcoes.ajuda ? 0 : 1);
    }

    const caminho = path.resolve(opcoes.entrada);

    if (!fs.existsSync(caminho)) {
        console.error('Arquivo não encontrado: ' + caminho);
        process.exit(1);
    }

    const bruto = fs.readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');

    if (!bruto.trim()) {
        console.error('O arquivo está vazio: ' + caminho);
        process.exit(1);
    }

    const delimitador = detectarDelimitador(bruto);
    const linhas = lerCsv(bruto, delimitador);

    if (!linhas.length) {
        console.error('Nenhuma linha encontrada em ' + caminho);
        process.exit(1);
    }

    const temCabecalho = pareceCabecalho(linhas[0]);
    const cabecalho = temCabecalho
        ? linhas[0]
        : linhas[0].map((valor, indice) => 'coluna' + (indice + 1));
    const dados = temCabecalho ? linhas.slice(1) : linhas;

    const indice = opcoes.coluna > 0 ? opcoes.coluna - 1 : acharColunaTelefone(dados, cabecalho);

    if (indice < 0 || indice >= cabecalho.length) {
        console.error('Não achei a coluna do telefone. Use --coluna=1 (1 = primeira coluna).');
        process.exit(1);
    }

    const resultados = [];
    const saida = [];
    const resumo = { total: 0, ok: 0, completados: 0, invalidos: 0 };

    dados.forEach((colunas, posicao) => {
        // Deixa todas as linhas com a mesma quantidade de colunas do cabeçalho.
        const linha = cabecalho.map((valor, i) => (colunas[i] == null ? '' : colunas[i]));
        const original = String(linha[indice] == null ? '' : linha[indice]).trim();
        const analisado = analisarTelefone(original, opcoes.ddd);

        resumo.total += 1;
        if (!analisado.valido) resumo.invalidos += 1;
        else if (analisado.status === 'completado') resumo.completados += 1;
        else resumo.ok += 1;

        // Número completo (55 + DDD + número) para reimportar na lista.
        linha[indice] = analisado.valido ? analisado.wati : original;
        linha.push(
            analisado.valido ? analisado.status : 'invalido',
            analisado.tipo,
            analisado.e164,
            analisado.motivo
        );

        saida.push(linha);
        resultados.push(Object.assign({}, analisado, {
            linha: posicao + (temCabecalho ? 2 : 1)
        }));
    });

    const cabecalhoSaida = cabecalho.concat([
        'status_telefone',
        'tipo_telefone',
        'e164',
        'motivo_telefone'
    ]);

    const caminhoSaida = opcoes.saida
        ? path.resolve(opcoes.saida)
        : path.join(
            path.dirname(caminho),
            path.basename(caminho, path.extname(caminho)) + '-verificado.csv'
        );

    // BOM para o Excel abrir os acentos corretamente.
    fs.writeFileSync(caminhoSaida, '\uFEFF' + escreverCsv([cabecalhoSaida].concat(saida), delimitador), 'utf8');

    const invalidos = resultados.filter((item) => !item.valido);

    if (opcoes.json) {
        console.log(JSON.stringify({ resumo, coluna: indice + 1, saida: caminhoSaida, resultados }, null, 2));
        return;
    }

    console.log('');
    console.log('Arquivo:  ' + caminho);
    console.log('Coluna:   ' + (indice + 1) + ' (' + (cabecalho[indice] || 'sem nome') + ')');
    console.log('Linhas:   ' + resumo.total + ' | já corretos: ' + resumo.ok +
        ' | completados: ' + resumo.completados + ' | inválidos: ' + resumo.invalidos);
    console.log('Saída:    ' + caminhoSaida);

    if (invalidos.length) {
        console.log('');
        console.log('Inválidos (primeiros 10):');
        invalidos.slice(0, 10).forEach((item) => {
            console.log('  linha ' + item.linha + ': "' + item.original + '" -> ' + item.motivo);
        });
        if (invalidos.length > 10) console.log('  ... e mais ' + (invalidos.length - 10) + '.');
    }

    console.log('');
}

principal();

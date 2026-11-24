#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Consulta no painel (extratorgov.online)
   ---------------------------------------------------------
   Abre o Chrome com o perfil da automação, faz login, anexa a
   lista no campo "Selecionar lista de CPFs" do painel, dispara
   "INICIAR EXTRAÇÃO" e acompanha o painel até o resultado.

   Uso:
     node consultar-extrator.js lista-cpfs.txt
     node consultar-extrator.js lista-cpfs.csv --nao-iniciar
     node consultar-extrator.js lista-cpfs.txt --espera=300 --fechar

   A lista é o mesmo arquivo que você escolheria na mão no painel
   (um CPF por linha ou CSV, no formato que o site aceita). Ela vai
   do seu computador direto para a página, como um anexo normal.

   Requer: mapear-tela.js (login automático) e Node 22+.
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');

const mapear = require('./mapear-tela');
const navegador = require('./navegador');

const SELETOR_UPLOAD = 'input[data-testid="stFileUploaderDropzoneInput"]';

const opcoes = {
    lista: '',
    url: 'https://extratorgov.online/',
    saida: path.join(process.cwd(), 'consulta'),
    downloads: path.join(process.cwd(), 'downloads'),
    espera: 180,
    iniciar: true,
    fechar: false,
    ajuda: false
};

process.argv.slice(2).forEach((arg) => {
    if (arg === '-h' || arg === '--ajuda' || arg === '--help') opcoes.ajuda = true;
    else if (arg === '--nao-iniciar') opcoes.iniciar = false;
    else if (arg === '--fechar') opcoes.fechar = true;
    else if (arg.startsWith('--url=')) opcoes.url = arg.slice(6);
    else if (arg.startsWith('--saida=')) opcoes.saida = path.resolve(arg.slice(8));
    else if (arg.startsWith('--downloads=')) opcoes.downloads = path.resolve(arg.slice(12));
    else if (arg.startsWith('--espera=')) opcoes.espera = parseInt(arg.slice(9), 10) || 180;
    else if (!arg.startsWith('-') && !opcoes.lista) opcoes.lista = arg;
});

function uso() {
    console.log([
        'Envia uma lista de CPFs no painel do extratorgov.online e acompanha a extração.',
        '',
        'Uso:',
        '  node consultar-extrator.js <lista.txt|lista.csv> [opções]',
        '',
        'Opções:',
        '  --nao-iniciar     para depois de anexar a lista (não clica em INICIAR EXTRAÇÃO).',
        '  --espera=N        segundos acompanhando o painel. Padrão: 180.',
        '  --saida=nome      prefixo dos arquivos salvos. Padrão: ./consulta',
        '  --downloads=dir   pasta onde os arquivos baixados do painel vão cair.',
        '                    Padrão: ./downloads',
        '  --url=URL         página a abrir. Padrão: https://extratorgov.online/',
        '  --fechar          fecha o Chrome ao terminar.',
        '  -h, --ajuda       mostra esta ajuda.',
        '',
        'Fluxo:',
        '  1. o script abre o Chrome e faz login sozinho (EXTRATOR_USUARIO/EXTRATOR_SENHA);',
        '  2. anexa a lista no campo "Selecionar lista de CPFs";',
        '  3. clica em INICIAR EXTRAÇÃO e acompanha o painel;',
        '  4. salva consulta.json/consulta.png e baixa o resultado em ./downloads.',
        '',
        'Exemplo:',
        '  node consultar-extrator.js lista-cpfs.txt --espera=300'
    ].join('\n'));
}

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

function lerLista(caminho) {
    const bruto = fs.readFileSync(caminho, 'utf8').replace(/^\uFEFF/, '');
    const linhas = bruto.split(/\r?\n/).filter((linha) => linha.trim());

    return { bruto, linhas };
}

/* ---------- conversa com a página via CDP ---------- */

const LER_PAINEL = '({ titulo: document.title, url: location.href, texto: document.body ? document.body.innerText : "" })';

/* Clica no primeiro botão cujo texto casa com o padrão (regex, sem diferenciar maiúsculas). */
async function clicarPorTexto(cdp, padrao) {
    return mapear.avaliar(cdp, '(() => {' +
        ' const regex = new RegExp(' + JSON.stringify(padrao) + ', "i");' +
        ' const alvo = Array.from(document.querySelectorAll("button")).find((b) => regex.test((b.innerText || "").trim()));' +
        ' if (!alvo || alvo.disabled) return false;' +
        ' alvo.click();' +
        ' return true;' +
        '})()');
}

/* O Streamlit expõe o uploader como input[type=file]; para escrever nele é preciso o
   nodeId do DOM (a página não consegue ler arquivo do disco sozinha). */
async function acharNodeDoUpload(cdp) {
    await cdp.enviar('DOM.enable');

    const documento = await cdp.enviar('DOM.getDocument', { depth: 0 });
    const achado = await cdp.enviar('DOM.querySelector', {
        nodeId: documento.root.nodeId,
        selector: SELETOR_UPLOAD
    });

    return achado && achado.nodeId ? achado.nodeId : 0;
}

async function esperarUploader(cdp, tentativas) {
    const total = tentativas || 30;

    for (let i = 0; i < total; i += 1) {
        if (await acharNodeDoUpload(cdp)) return true;
        await esperar(500);
    }

    return false;
}

/* O painel não mostra o nome do arquivo: ele responde "3 CPFs carregados com sucesso!".
   Então aceitamos o nome do arquivo OU essa confirmação. Devolve o texto visto. */
async function esperarListaCarregada(cdp, nome, tentativas) {
    const total = tentativas || 30;
    // A confirmação ("✓ 3 CPFs carregados com sucesso!") é um bloco à parte, fora do
    // uploader; por isso lemos o corpo da página inteira.
    const lerPagina = 'document.body ? document.body.innerText : ""';

    for (let i = 0; i < total; i += 1) {
        const texto = String(await mapear.avaliar(cdp, lerPagina) || '').replace(/\s+/g, ' ').trim();

        if (texto.toLowerCase().includes(nome.toLowerCase())) return '"' + nome + '" no painel';

        const carregados = /[\d.,]+\s+cpfs?\s+carregad\w*[^.!]{0,40}/i.exec(texto);

        if (carregados) return carregados[0].replace(/\s+/g, ' ').trim();

        await esperar(500);
    }

    return '';
}

/* Faz o "Baixar" do painel cair direto numa pasta conhecida em vez de Downloads. */
async function prepararPastaDownloads(cdp, pasta) {
    fs.mkdirSync(pasta, { recursive: true });

    try {
        await cdp.enviar('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: pasta,
            eventsEnabled: true
        });
        return true;
    } catch (erro) {
        try {
            await cdp.enviar('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: pasta });
            return true;
        } catch (erro2) {
            return false;
        }
    }
}

function arquivosNaPasta(pasta) {
    try {
        return fs.readdirSync(pasta)
            .filter((nome) => !nome.endsWith('.crdownload'))
            .map((nome) => {
                const completo = path.join(pasta, nome);
                const info = fs.statSync(completo);
                return { nome, completo, tamanho: info.size, quando: info.mtimeMs };
            });
    } catch (erro) {
        return [];
    }
}

/* Mostra só o pedaço novo do painel (o Streamlit repete o texto todo a cada evento). */
function novidade(anterior, atual) {
    let igual = 0;

    while (igual < anterior.length && igual < atual.length && anterior[igual] === atual[igual]) {
        igual += 1;
    }

    const trecho = atual.slice(igual).replace(/\s+/g, ' ').trim();

    return trecho ? trecho.slice(0, 300) : '(painel atualizado)';
}

const TERMOS_SEM_CREDITO = /saldo insuficiente|sem cr[eé]dito|cr[eé]ditos? insuficientes?|compre cr[eé]ditos|recarregue a conta|adquira cr[eé]ditos?/i;
const TERMOS_FIM = /conclu[ií]d|finalizad|processamento encerrado/i;

/* Acompanha o painel: imprime o que muda, para por crédito, por download ou por tempo. */
async function acompanhar(cdp, limiteSegundos, pastaDownloads, antes) {
    const inicio = Date.now();
    const historico = [];
    let ultimo = '';
    let clicouBaixar = false;

    while (Date.now() - inicio < limiteSegundos * 1000) {
        const painel = await mapear.avaliar(cdp, LER_PAINEL);
        const texto = String((painel && painel.texto) || '').replace(/[ \t]+/g, ' ').trim();

        if (texto && texto !== ultimo) {
            historico.push({ em: new Date().toISOString(), texto });
            console.log('[' + new Date().toLocaleTimeString('pt-BR') + '] ' + novidade(ultimo, texto));
            ultimo = texto;
        }

        if (TERMOS_SEM_CREDITO.test(texto)) {
            return { estado: 'sem-credito', painel, historico };
        }

        const novos = arquivosNaPasta(pastaDownloads).filter((arquivo) => !antes.has(arquivo.nome));

        if (novos.length) {
            return { estado: 'baixado', painel, historico, arquivos: novos };
        }

        const botaoDownload = '(() => {' +
            ' const alvo = Array.from(document.querySelectorAll("button, a")).find((el) =>' +
            '   /stDownloadButton/.test(el.getAttribute("data-testid") || "") ||' +
            '   /baixar|download/i.test(el.innerText || ""));' +
            ' return alvo || null;' +
            '})()';

        const temDownload = await mapear.avaliar(cdp, 'Boolean(' + botaoDownload + ')');

        if (temDownload && !clicouBaixar) {
            clicouBaixar = await mapear.avaliar(cdp, '(() => {' +
                ' const alvo = (' + botaoDownload + ');' +
                ' if (!alvo) return false;' +
                ' alvo.click();' +
                ' return true;' +
                '})()');

            if (clicouBaixar) {
                console.log('Cliquei no download do painel; esperando o arquivo aparecer em ' + pastaDownloads + '.');
                await esperar(3000);
            }

            continue;
        }

        if (TERMOS_FIM.test(texto) && !temDownload) {
            return { estado: 'concluido', painel, historico };
        }

        await esperar(2500);
    }

    return { estado: 'tempo-esgotado', painel: null, historico };
}

async function salvarArtefatos(cdp, prefixo, painel) {
    const dados = Object.assign({}, painel);
    dados.capturadoEm = new Date().toISOString();

    fs.writeFileSync(prefixo + '.json', JSON.stringify(dados, null, 2), 'utf8');
    console.log('Painel salvo em ' + prefixo + '.json');

    try {
        const print = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(prefixo + '.png', Buffer.from(print.data, 'base64'));
        console.log('Print salvo em ' + prefixo + '.png');
    } catch (erro) {
        console.log('Não consegui salvar o print: ' + erro.message);
    }
}

async function principal() {
    if (opcoes.ajuda) {
        uso();
        return;
    }

    if (!opcoes.lista) {
        uso();
        process.exitCode = 1;
        return;
    }

    const caminhoLista = path.resolve(opcoes.lista);

    if (!fs.existsSync(caminhoLista)) {
        console.error('Lista não encontrada: ' + caminhoLista);
        process.exitCode = 1;
        return;
    }

    const { linhas } = lerLista(caminhoLista);

    if (!linhas.length) {
        console.error('A lista está vazia: ' + caminhoLista);
        process.exitCode = 1;
        return;
    }

    const nomeLista = path.basename(caminhoLista);

    console.log('Lista:     ' + caminhoLista);
    console.log('Linhas:    ' + linhas.length);
    console.log('Primeira:  ' + linhas[0].slice(0, 40));
    console.log('');

    let sessao;

    try {
        sessao = await mapear.abrirNavegador(opcoes.url);
    } catch (erro) {
        console.error(erro.message);
        process.exitCode = 1;
        return;
    }

    const { processo, cdp } = sessao;

    try {
        const entrou = await mapear.fazerLogin(cdp);

        if (!entrou) {
            console.error('Não consegui entrar no painel. Confira EXTRATOR_USUARIO/EXTRATOR_SENHA no .env.');
            process.exitCode = 1;
            return;
        }

        console.log('Login concluído.');
        await esperar(2000);
        await mapear.esperarEstabilizar(cdp);

        if (!await esperarUploader(cdp, 20)) {
            console.log('O campo de upload não apareceu; tentando o modo "LISTA MANUAL"...');
            await clicarPorTexto(cdp, 'lista manual');
            await mapear.esperarEstabilizar(cdp);
        }

        if (!await esperarUploader(cdp, 20)) {
            console.error('Não achei o campo "Selecionar lista de CPFs". O painel mudou de layout?');
            await salvarArtefatos(cdp, opcoes.saida, await mapear.avaliar(cdp, LER_PAINEL));
            process.exitCode = 1;
            return;
        }

        // Reconsulta o nodeId na hora: cada rerun do Streamlit recria o input.
        const nodeId = await acharNodeDoUpload(cdp);
        await cdp.enviar('DOM.setFileInputFiles', { nodeId, files: [caminhoLista] });
        await mapear.esperarEstabilizar(cdp);

        const confirmacao = await esperarListaCarregada(cdp, nomeLista, 20);

        if (confirmacao) {
            console.log('Lista anexada: ' + confirmacao);
        } else {
            console.log('Anexei ' + nomeLista + ', mas o painel ainda não confirmou o carregamento.');
        }

        if (!opcoes.iniciar) {
            console.log('Modo --nao-iniciar: parando antes de clicar em INICIAR EXTRAÇÃO.');
            await salvarArtefatos(cdp, opcoes.saida, await mapear.avaliar(cdp, LER_PAINEL));
            return;
        }

        await prepararPastaDownloads(cdp, opcoes.downloads);

        const antes = new Set(arquivosNaPasta(opcoes.downloads).map((arquivo) => arquivo.nome));

        if (!await clicarPorTexto(cdp, 'iniciar\\s+extra')) {
            console.error('Botão "INICIAR EXTRAÇÃO" não encontrado (ou desabilitado).');
            await salvarArtefatos(cdp, opcoes.saida, await mapear.avaliar(cdp, LER_PAINEL));
            process.exitCode = 1;
            return;
        }

        console.log('INICIAR EXTRAÇÃO clicado. Acompanhando por até ' + opcoes.espera + 's...');
        console.log('');

        const resultado = await acompanhar(cdp, opcoes.espera, opcoes.downloads, antes);

        console.log('');

        if (resultado.estado === 'sem-credito') {
            console.log('O painel reclamou de crédito/saldo. Recarregue a conta e rode de novo.');
        } else if (resultado.estado === 'baixado') {
            resultado.arquivos.forEach((arquivo) => {
                console.log('Baixado: ' + arquivo.completo + ' (' + arquivo.tamanho + ' bytes)');
            });
        } else if (resultado.estado === 'concluido') {
            console.log('O painel indicou extração concluída.');
        } else {
            console.log('Não vi o fim da extração em ' + opcoes.espera + 's; salvando o estado atual.');
            console.log('Se ainda estiver rodando, aumente o --espera ou veja o print.');
        }

        const painel = resultado.painel || await mapear.avaliar(cdp, LER_PAINEL);
        painel.estado = resultado.estado;
        painel.lista = caminhoLista;
        painel.historico = resultado.historico.map((passo) => ({
            em: passo.em,
            texto: passo.texto.slice(0, 4000)
        }));

        await salvarArtefatos(cdp, opcoes.saida, painel);
    } finally {
        if (opcoes.fechar && processo && processo.pid) {
            navegador.encerrarProcesso(processo.pid);
        }
    }
}

if (require.main === module) {
    principal().catch((erro) => {
        console.error('Erro: ' + erro.message);
        process.exitCode = 1;
    });
}




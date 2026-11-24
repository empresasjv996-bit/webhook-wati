#!/usr/bin/env node
/* =========================================================
   QGC TEAM by JV - Mapeamento da tela (extratorgov.online)
   ---------------------------------------------------------
   Abre o Chrome com o perfil de captura, você faz login e
   abre a tela de consulta; ao apertar ENTER, o script salva:

     tela.json  -> estrutura (botões, campos, tabelas, textos)
     tela.png   -> print da tela

   Com esses dois arquivos eu monto a automação com os
   seletores certos. Nenhuma senha é lida ou salva: campos
   type="password" são ignorados.

   Uso:
     node mapear-tela.js
     node mapear-tela.js --agora            (captura sem esperar ENTER)
     node mapear-tela.js --espera=6000      (ms de espera antes de capturar)
   ========================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const PORTA = Number(process.env.CDP_PORT || 9223);
const PERFIL = path.join(os.tmpdir(), 'qgc-captura-extrator');

const opcoes = {
    url: 'https://extratorgov.online/',
    saida: path.join(process.cwd(), 'tela'),
    espera: 4000,
    agora: false,
    entrar: false,
    fechar: false,
    ajuda: false
};

process.argv.slice(2).forEach((arg) => {
    if (arg === '-h' || arg === '--ajuda' || arg === '--help') opcoes.ajuda = true;
    else if (arg.startsWith('--url=')) opcoes.url = arg.slice(6);
    else if (arg.startsWith('--saida=')) opcoes.saida = path.resolve(arg.slice(8));
    else if (arg.startsWith('--espera=')) opcoes.espera = parseInt(arg.slice(9), 10) || 4000;
    else if (arg === '--agora') opcoes.agora = true;
    else if (arg === '--entrar') opcoes.entrar = true;
    else if (arg === '--fechar') opcoes.fechar = true;
});

function uso() {
    console.log([
        'Mapeia a tela do site para montar a automação (DOM + print).',
        '',
        'Uso:',
        '  node mapear-tela.js [opções]',
        '',
        'Opções:',
        '  --url=URL      página a abrir. Padrão: https://extratorgov.online/',
        '  --saida=nome   prefixo dos arquivos. Padrão: ./tela (gera tela.json e tela.png)',
        '  --espera=N     ms de espera antes de ler a tela. Padrão: 4000',
        '  --agora        não espera ENTER (útil para testar)',
        '  --entrar       faz login sozinho usando EXTRATOR_USUARIO/EXTRATOR_SENHA do .env',
        '  --fechar       fecha o Chrome ao terminar',
        '  -h, --ajuda    mostra esta ajuda',
        '',
        'Fluxo normal:',
        '  1. rode o script;',
        '  2. faça login e abra a tela onde você cola os números;',
        '  3. volte ao terminal e aperte ENTER;',
        '  4. me envie tela.json e tela.png.'
    ].join('\n'));
}

function acharNavegador() {
    const candidatos = [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);

    return candidatos.find((caminho) => fs.existsSync(caminho)) || '';
}

async function esperarDevtools(tentativas) {
    const total = tentativas || 60;

    for (let i = 0; i < total; i += 1) {
        try {
            const resposta = await fetch(`http://127.0.0.1:${PORTA}/json/version`);
            if (resposta.ok) return await resposta.json();
        } catch (erro) { /* ainda subindo */ }

        await new Promise((resolver) => setTimeout(resolver, 250));
    }

    throw new Error('O Chrome não abriu a porta de depuração ' + PORTA + '.');
}

async function acharPagina() {
    for (let i = 0; i < 40; i += 1) {
        try {
            const alvos = await (await fetch(`http://127.0.0.1:${PORTA}/json/list`)).json();
            const pagina = alvos.find((alvo) => alvo.type === 'page' && alvo.webSocketDebuggerUrl);
            if (pagina) return pagina;
        } catch (erro) { /* tenta de novo */ }

        await new Promise((resolver) => setTimeout(resolver, 250));
    }

    throw new Error('Nenhuma aba aberta para conectar.');
}

function conectarCdp(urlWebsocket) {
    return new Promise((resolver, rejeitar) => {
        const socket = new WebSocket(urlWebsocket);
        const pendentes = new Map();
        let sequencia = 0;

        socket.addEventListener('error', () => rejeitar(new Error('Falha ao conectar no DevTools do Chrome.')));

        socket.addEventListener('open', () => {
            resolver({
                enviar(metodo, parametros) {
                    const id = ++sequencia;
                    return new Promise((ok, falhou) => {
                        pendentes.set(id, { ok, falhou });
                        socket.send(JSON.stringify({ id, method: metodo, params: parametros || {} }));
                    });
                },
                fechar() {
                    try {
                        socket.close();
                    } catch (erro) { /* já fechado */ }
                }
            });
        });

        socket.addEventListener('message', (evento) => {
            let mensagem;
            try {
                mensagem = JSON.parse(evento.data);
            } catch (erro) {
                return;
            }

            const pendente = mensagem.id && pendentes.get(mensagem.id);
            if (!pendente) return;
            pendentes.delete(mensagem.id);
            if (mensagem.error) pendente.falhou(new Error(mensagem.error.message));
            else pendente.ok(mensagem.result);
        });
    });
}

/* Sobe o Chrome no perfil da automação e conecta no DevTools.
   Devolve { processo, pagina, cdp } para quem quiser reaproveitar
   (por exemplo consultar-extrator.js). */
async function abrirNavegador(url) {
    const navegador = acharNavegador();

    if (!navegador) {
        throw new Error('Chrome/Edge não encontrado. Instale o Chrome ou defina CHROME_PATH.');
    }

    fs.mkdirSync(PERFIL, { recursive: true });

    console.log('Abrindo o Chrome (perfil: ' + PERFIL + ') ...');

    const processo = spawn(navegador, [
        '--remote-debugging-port=' + PORTA,
        '--user-data-dir=' + PERFIL,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1400,1000',
        url
    ], { stdio: 'ignore' });

    await esperarDevtools();

    const pagina = await acharPagina();
    const cdp = await conectarCdp(pagina.webSocketDebuggerUrl);

    await cdp.enviar('Page.enable');

    return { processo, pagina, cdp };
}

/* Roda dentro da página: devolve a estrutura dos elementos visíveis.
   Campos type="password" são descartados de propósito. */
function coletarTela() {
    const limpo = (valor) => String(valor == null ? '' : valor).replace(/\s+/g, ' ').trim();

    const visivel = (el) => {
        const area = el.getBoundingClientRect();
        const estilo = window.getComputedStyle(el);
        return area.width > 0 && area.height > 0 && estilo.visibility !== 'hidden' && estilo.display !== 'none';
    };

    const atributos = (el) => {
        const nomes = ['data-testid', 'aria-label', 'placeholder', 'type', 'role', 'name', 'title', 'id', 'class'];
        const saida = {};

        nomes.forEach((nome) => {
            let valor = el.getAttribute(nome);
            if (!valor) return;
            if (nome === 'class') valor = valor.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
            saida[nome] = limpo(valor).slice(0, 200);
        });

        return saida;
    };

    const elementos = [];

    document.querySelectorAll('button, textarea, input, select, [role="button"], [role="textbox"], [data-testid]').forEach((el) => {
        if (!visivel(el)) return;

        const tag = el.tagName.toLowerCase();
        if (tag === 'input' && String(el.type).toLowerCase() === 'password') return;

        const item = {
            tag: tag,
            attrs: atributos(el),
            texto: limpo(el.innerText || '').slice(0, 200)
        };

        if (tag === 'input') item.tipo = el.type;
        if (tag === 'select') item.opcoes = Array.from(el.options || []).map((o) => limpo(o.textContent)).slice(0, 40);

        elementos.push(item);
    });

    const tabelas = Array.from(document.querySelectorAll('table')).slice(0, 5).map((tabela) => ({
        colunas: Array.from(tabela.querySelectorAll('thead th')).map((th) => limpo(th.innerText)).slice(0, 25),
        linhas: Array.from(tabela.querySelectorAll('tbody tr')).slice(0, 5).map((linha) => (
            Array.from(linha.children).map((celula) => limpo(celula.innerText).slice(0, 100))
        ))
    }));

    const iframes = Array.from(document.querySelectorAll('iframe'))
        .map((quadro) => quadro.getAttribute('src'))
        .filter(Boolean)
        .slice(0, 10);

    return {
        titulo: document.title,
        url: location.href,
        textoVisivel: limpo(document.body ? document.body.innerText : '').slice(0, 8000),
        elementos: elementos,
        tabelas: tabelas,
        iframes: iframes
    };
}

const COLETAR = '(' + coletarTela.toString() + ')()';

/* ---------- login automático (a senha fica só no seu .env) ---------- */

function lerEnv() {
    const valores = {};
    const arquivo = path.join(process.cwd(), '.env');

    if (!fs.existsSync(arquivo)) return valores;

    fs.readFileSync(arquivo, 'utf8').split(/\r?\n/).forEach((linha) => {
        const achado = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(linha);
        if (!achado) return;

        let valor = achado[2].trim();
        const aspas = (valor.startsWith('"') && valor.endsWith('"')) || (valor.startsWith("'") && valor.endsWith("'"));
        if (aspas && valor.length >= 2) valor = valor.slice(1, -1);

        valores[achado[1]] = valor;
    });

    return valores;
}

function credenciais() {
    const arquivo = lerEnv();
    return {
        usuario: process.env.EXTRATOR_USUARIO || arquivo.EXTRATOR_USUARIO || '',
        senha: process.env.EXTRATOR_SENHA || arquivo.EXTRATOR_SENHA || ''
    };
}

async function avaliar(cdp, expressao) {
    const resposta = await cdp.enviar('Runtime.evaluate', {
        expression: expressao,
        returnByValue: true,
        awaitPromise: true
    });

    if (resposta.exceptionDetails) {
        throw new Error(resposta.exceptionDetails.text || 'erro ao executar na página');
    }

    return resposta.result ? resposta.result.value : undefined;
}

/* Um "localizador" é uma expressão JS que devolve o elemento dentro da página. */
async function preencher(cdp, localizador, texto) {
    const achou = await avaliar(cdp, '(() => {' +
        ' const el = (' + localizador + ');' +
        ' if (!el) return false;' +
        ' el.focus();' +
        ' el.click();' +
        ' el.select();' +
        ' return true;' +
        '})()');

    if (!achou) return false;

    await cdp.enviar('Input.insertText', { text: texto });

    const digitou = await avaliar(cdp, '(() => {' +
        ' const el = (' + localizador + ');' +
        ' return Boolean(el && el.value);' +
        '})()');

    if (!digitou) {
        // Plano B: setter nativo + eventos (funciona com React/Streamlit).
        const forcou = await avaliar(cdp, '(() => {' +
            ' const el = (' + localizador + ');' +
            ' if (!el) return false;' +
            ' const descritor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");' +
            ' descritor.set.call(el, ' + JSON.stringify(texto) + ');' +
            ' el.dispatchEvent(new Event("input", { bubbles: true }));' +
            ' el.dispatchEvent(new Event("change", { bubbles: true }));' +
            ' return true;' +
            '})()');

        if (!forcou) return false;
    }

    // O Streamlit só aplica o texto quando o campo perde o foco (o famoso "Press Enter
    // to apply"). Sem o TAB o formulário é enviado vazio e o site responde
    // "Credenciais inválidas" — comprovado no extratorgov.online.
    await teclar(cdp, 'Tab');
    await new Promise((resolver) => setTimeout(resolver, 400));

    return true;
}

const LOCALIZADOR_USUARIO = 'Array.from(document.querySelectorAll("input")).find((el) => /usu/i.test(el.getAttribute("aria-label") || ""))';
const LOCALIZADOR_SENHA = 'document.querySelector("input[type=password]")';

/* Espera a tela ficar pronta: "login" se apareceu o formulário,
   "pronto" se a página carregou sem login, "carregando" se estourou o tempo. */
async function esperarFormulario(cdp, tentativas) {
    const total = tentativas || 30;

    for (let i = 0; i < total; i += 1) {
        const estado = await avaliar(cdp, '(() => {' +
            ' if ((' + LOCALIZADOR_USUARIO + ') || (' + LOCALIZADOR_SENHA + ')) return "login";' +
            ' const corpo = document.body ? document.body.innerText : "";' +
            ' if (corpo.trim().length > 150 && !/acessar terminal|bem-vindo de volta|senha/i.test(corpo)) return "pronto";' +
            ' return "carregando";' +
            '})()');

        if (estado !== 'carregando') return estado;

        await new Promise((resolver) => setTimeout(resolver, 500));
    }

    return 'carregando';
}

/* Manda uma tecla de verdade pelo DevTools. O Streamlit só comita o texto digitado
   (aquele "Press Enter to apply") quando o campo perde o foco — sem isso o formulário
   é enviado vazio e o site responde "Credenciais inválidas".
   Importante: TAB vai como rawKeyDown SEM texto, senão o Chrome insere um "\t" no campo. */
async function teclar(cdp, tecla) {
    const codigo = tecla === 'Enter' ? 13 : (tecla === 'Tab' ? 9 : 0);
    const comum = { key: tecla, code: tecla, windowsVirtualKeyCode: codigo, nativeVirtualKeyCode: codigo };

    await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, comum));

    if (tecla === 'Enter') {
        await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'char', text: '\r', unmodifiedText: '\r' }, comum));
    }

    await cdp.enviar('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, comum));
}

/* Clica no submit do formulário de login. O site tem um botão "Acessar plataforma"
   (que também envia o form, mas vazio) e o submit real "Acessar Terminal" — por isso
   o filtro por escopo do formulário + exclusão de "plataforma". */
async function clicarSubmitLogin(cdp) {
    return avaliar(cdp, '(() => {' +
        ' const senha = document.querySelector("input[type=password]");' +
        ' if (!senha) return false;' +
        ' const escopo = senha.form || senha.closest("form") || senha.closest("div[data-testid=stForm]") || document;' +
        ' const botoes = Array.from(escopo.querySelectorAll("button"));' +
        ' const nome = (b) => (b.innerText || "").trim().toLowerCase();' +
        ' const uteis = botoes.filter((b) => /acessar|entrar|logar|login/i.test(nome(b)) && !/plataforma/i.test(nome(b)));' +
        ' const alvo = uteis.find((b) => /terminal/.test(nome(b))) ||' +
        '   uteis.find((b) => nome(b) === "acessar") ||' +
        '   uteis[0] ||' +
        '   escopo.querySelector("button[data-testid*=FormSubmit], button[kind=primaryFormSubmit], button[type=submit]");' +
        ' if (!alvo) return false;' +
        ' alvo.scrollIntoView({ block: "center" });' +
        ' alvo.click();' +
        ' return true;' +
        '})()');
}

/* Espera o resultado do login: "ok" só depois de duas leituras seguidas sem o campo
   de senha (o Streamlit remove/recria o form no rerun), "recusado" quando o site nega,
   "login" se o formulário continuar na tela. */
async function esperarResultadoLogin(cdp, tentativas) {
    let confirmacoes = 0;

    for (let i = 0; i < tentativas; i += 1) {
        await new Promise((resolver) => setTimeout(resolver, 500));

        const estado = await avaliar(cdp, '(() => {' +
            ' const corpo = document.body ? document.body.innerText : "";' +
            ' if (document.querySelector("input[type=password]")) {' +
            '   if (/senha (inv|incorret)|usu[aá]rio (inv|incorret|n[aã]o)|credenci/i.test(corpo)) return "recusado";' +
            '   return "aguardando";' +
            ' }' +
            ' return "ok";' +
            '})()');

        if (estado === 'recusado') return 'recusado';

        if (estado === 'ok') {
            confirmacoes += 1;
            if (confirmacoes >= 2) return 'ok';
        } else {
            confirmacoes = 0;
        }
    }

    return 'login';
}

/* Espera o DOM do Streamlit parar de mudar (hidratação/reruns) antes de digitar.
   Sem isso o primeiro rerun apaga o que foi digitado e o login vai vazio. */
async function esperarEstabilizar(cdp) {
    return avaliar(cdp, 'new Promise((ok) => {' +
        ' const limite = setTimeout(() => { ok(true); }, 15000);' +
        ' let observador = null;' +
        ' const parar = () => {' +
        '   clearTimeout(limite);' +
        '   if (observador) observador.disconnect();' +
        '   ok(true);' +
        ' };' +
        ' let quieto = setTimeout(parar, 1200);' +
        ' observador = new MutationObserver(() => {' +
        '   clearTimeout(quieto);' +
        '   quieto = setTimeout(parar, 1200);' +
        ' });' +
        ' observador.observe(document.body, { childList: true, subtree: true, characterData: true });' +
        '})');
}

/* Confere se os dois campos estão preenchidos com o esperado e sem "Press Enter to apply". */
async function valoresConferem(cdp, esperadoUsuario, esperadoSenha) {
    return avaliar(cdp, '(() => {' +
        ' const campoUsuario = (' + LOCALIZADOR_USUARIO + ');' +
        ' const campoSenha = (' + LOCALIZADOR_SENHA + ');' +
        ' if (!campoUsuario || !campoSenha) return false;' +
        ' if (campoUsuario.value.trim() !== ' + JSON.stringify(esperadoUsuario) + ') return false;' +
        ' if (campoSenha.value !== ' + JSON.stringify(esperadoSenha) + ') return false;' +
        ' return !/Press Enter to apply/i.test(document.body.innerText);' +
        '})()');
}

/* Preenche e confere os dois campos; repete se um rerun do Streamlit limpar tudo. */
async function prepararCampos(cdp, usuario, senha) {
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
        const preencheuUsuario = await preencher(cdp, LOCALIZADOR_USUARIO, usuario);
        const preencheuSenha = await preencher(cdp, LOCALIZADOR_SENHA, senha);

        if (!preencheuUsuario || !preencheuSenha) return false;

        if (await valoresConferem(cdp, usuario, senha)) {
            await new Promise((resolver) => setTimeout(resolver, 700));

            if (await valoresConferem(cdp, usuario, senha)) return true;
        }

        await new Promise((resolver) => setTimeout(resolver, 1000));
    }

    return false;
}

async function fazerLogin(cdp) {
    const { usuario, senha } = credenciais();
    const estado = await esperarFormulario(cdp, 30);

    if (estado === 'carregando') {
        console.log('A página demorou a carregar; login automático cancelado.');
        return false;
    }

    if (estado === 'pronto') {
        const aindaNoLogin = await avaliar(cdp, '/acessar terminal|bem-vindo de volta|senha/i.test(document.body ? document.body.innerText : "")');

        if (aindaNoLogin) {
            console.log('A tela de login não terminou de carregar.');
            return false;
        }

        console.log('Sessão já autenticada (não há formulário de login).');
        return true;
    }

    if (!usuario || !senha) {
        console.log('Formulário de login na tela, mas faltam EXTRATOR_USUARIO / EXTRATOR_SENHA.');
        console.log('Acrescente essas duas linhas ao .env da raiz do projeto e rode de novo.');
        return false;
    }

    // Digitar antes do Streamlit hidratar faz o valor se perder no rerun e o formulário
    // é enviado vazio ("Credenciais inválidas"). Por isso espera o DOM estabilizar.
    await esperarEstabilizar(cdp);

    if (!await prepararCampos(cdp, usuario, senha)) {
        console.log('Não consegui preencher os campos de login.');
        return false;
    }

    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
        // Os campos já foram confirmados com TAB (dentro de preencher). Aqui é o clique no
        // submit de verdade ("Acessar Terminal"), não no "Acessar plataforma" da landing.
        const clicou = await clicarSubmitLogin(cdp);
        if (!clicou) throw new Error('Botão de login ("Acessar") não encontrado na tela.');

        const resultado = await esperarResultadoLogin(cdp, 40);

        if (resultado === 'ok') return true;

        if (resultado !== 'recusado' || tentativa === 2) break;

        // Pode ter sido um rerun apagando os campos: recarrega e tenta uma vez mais
        // antes de culpar as credenciais.
        console.log('O site recusou o login; recarregando a página e tentando de novo.');
        await avaliar(cdp, 'location.reload(), true');
        await new Promise((resolver) => setTimeout(resolver, 4000));
        await esperarFormulario(cdp, 30);
        await esperarEstabilizar(cdp);

        if (!await prepararCampos(cdp, usuario, senha)) break;
    }

    console.log('O site recusou o login (usuário, senha ou créditos).');

    return false;
}

async function principal() {
    if (opcoes.ajuda) {
        uso();
        return;
    }

    let sessao;

    try {
        sessao = await abrirNavegador(opcoes.url);
    } catch (erro) {
        console.error(erro.message);
        process.exitCode = 1;
        return;
    }

    const { processo, pagina, cdp } = sessao;

    try {
        console.log('Conectado em: ' + pagina.url);
        console.log('Faça login na janela e abra a tela onde você cola os números.');

        if (opcoes.entrar) {
            const entrou = await fazerLogin(cdp);

            if (entrou) {
                console.log('Login concluído.');
                await new Promise((resolver) => setTimeout(resolver, 3000));
            } else {
                console.log('Não consegui entrar sozinho. Faça o login na janela.');
            }
        }

        if (opcoes.agora) {
            await new Promise((resolver) => setTimeout(resolver, opcoes.espera));
        } else {
            const leitor = readline.createInterface({ input: process.stdin, output: process.stdout });
            await new Promise((resolver) => {
                leitor.question('\nAperte ENTER aqui quando a tela de consulta estiver aberta... ', () => {
                    leitor.close();
                    resolver();
                });
            });
        }

        const avaliado = await cdp.enviar('Runtime.evaluate', {
            expression: COLETAR,
            returnByValue: true
        });

        if (avaliado.exceptionDetails) {
            throw new Error('Falha ao ler a tela: ' + (avaliado.exceptionDetails.text || 'erro desconhecido'));
        }

        const tela = (avaliado.result && avaliado.result.value) || {};
        tela.capturadoEm = new Date().toISOString();
        tela.abaConectada = pagina.url;

        fs.writeFileSync(opcoes.saida + '.json', JSON.stringify(tela, null, 2), 'utf8');
        console.log('Estrutura salva em ' + opcoes.saida + '.json');

        try {
            const print = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
            fs.writeFileSync(opcoes.saida + '.png', Buffer.from(print.data, 'base64'));
            console.log('Print salvo em ' + opcoes.saida + '.png');
        } catch (erro) {
            console.log('Não consegui salvar o print: ' + erro.message);
        }

        const elementos = Array.isArray(tela.elementos) ? tela.elementos : [];
        const tabelas = Array.isArray(tela.tabelas) ? tela.tabelas : [];

        console.log('');
        console.log('Título: ' + (tela.titulo || '(sem título)'));
        console.log('URL: ' + (tela.url || '(desconhecida)'));
        console.log('Elementos: ' + elementos.length + ' | tabelas: ' + tabelas.length);
        console.log('');
        console.log('Me envie tela.json e tela.png. Nenhuma senha foi lida (campos password são ignorados).');

        cdp.fechar();
    } finally {
        if (opcoes.fechar && processo && processo.pid) {
            spawnSync('taskkill', ['/PID', String(processo.pid), '/T', '/F'], { stdio: 'ignore' });
        }
    }
}

module.exports = {
    abrirNavegador,
    fazerLogin,
    avaliar,
    esperarFormulario,
    esperarEstabilizar,
    credenciais,
    PERFIL
};

if (require.main === module) {
    principal().catch((erro) => {
        console.error('Erro: ' + erro.message);
        process.exitCode = 1;
    });
}



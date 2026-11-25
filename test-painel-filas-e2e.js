/* =========================================================
   QGC TEAM by JV - Teste das filas do painel do colaborador
   ---------------------------------------------------------
   O painel tem só duas filas:
     - Aguardando     -> o cliente ainda não respondeu
     - Conversa ativa -> o cliente já respondeu
   Confere o campo `respondido` em /api/clientes (modo demo),
   a divisão das filas e o botão de recolher a ficha.
   Roda com: node test-painel-filas-e2e.js (modo demo, porta 3109).
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');

const PORTA = 3109;
const BASE = 'http://127.0.0.1:' + PORTA;

const filho = spawn(process.execPath, ['index.js'], {
    cwd: __dirname,
    env: Object.assign({}, process.env, {
        PORT: String(PORTA),
        MODO_DEMO: '1',
        DATABASE_URL: 'postgres://placeholder/demo'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
});

let log = '';
filho.stdout.on('data', (dado) => { log += dado.toString(); });
filho.stderr.on('data', (dado) => { log += dado.toString(); });

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function esperarServidor() {
    for (let tentativa = 0; tentativa < 80; tentativa++) {
        try {
            const resposta = await fetch(BASE + '/login');
            if (resposta.ok) return;
        } catch (erro) { /* ainda subindo */ }
        await dormir(250);
    }
    throw new Error('Servidor não subiu na porta ' + PORTA + '\n' + log);
}

async function lerJson(resposta) {
    try { return await resposta.json(); } catch (erro) { return {}; }
}

async function sessao(email) {
    const login = await fetch(BASE + '/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, senha: '123456' })
    });
    assert.strictEqual(login.status, 200, 'login de ' + email + ' falhou: ' + (await login.text()));

    const setCookie = login.headers.getSetCookie
        ? login.headers.getSetCookie()[0]
        : login.headers.get('set-cookie');
    const cookie = String(setCookie || '').split(';')[0];
    assert.ok(cookie, 'cookie de sessão não veio no login de ' + email);
    return cookie;
}

(async () => {
    try {
        await esperarServidor();

        /* ---------- 1. /api/clientes informa quem já respondeu ---------- */
        const cookie = await sessao('colaborador@qgcteam.com');

        const resposta = await fetch(BASE + '/api/clientes?status=ativos&limite=200', {
            headers: { Cookie: cookie }
        });
        const clientes = await lerJson(resposta);

        assert.strictEqual(resposta.status, 200, JSON.stringify(clientes));
        assert.ok(Array.isArray(clientes) && clientes.length, 'a carteira do colaborador tem leads');

        clientes.forEach((cliente) => {
            assert.strictEqual(typeof cliente.respondido, 'boolean',
                'todo lead diz se o cliente respondeu: ' + JSON.stringify(cliente));
        });

        const ativas = clientes.filter((cliente) => cliente.respondido === true);
        const aguardando = clientes.filter((cliente) => cliente.respondido === false);

        assert.strictEqual(ativas.length + aguardando.length, clientes.length,
            'cada lead cai em uma única fila');
        assert.ok(ativas.length >= 1, 'há conversa ativa (cliente respondeu): ' + JSON.stringify(clientes));
        assert.ok(aguardando.length >= 1, 'há lead aguardando resposta: ' + JSON.stringify(clientes));

        const comResposta = ativas[0];
        const semResposta = aguardando[0];

        const mensagensComResposta = await lerJson(await fetch(
            BASE + '/api/clientes/' + encodeURIComponent(comResposta.telefone) + '/mensagens',
            { headers: { Cookie: cookie } }
        ));
        assert.ok(mensagensComResposta.some((m) => m.direcao === 'recebida'),
            'quem está em Conversa ativa tem mensagem recebida');

        const mensagensSemResposta = await lerJson(await fetch(
            BASE + '/api/clientes/' + encodeURIComponent(semResposta.telefone) + '/mensagens',
            { headers: { Cookie: cookie } }
        ));
        assert.ok(!mensagensSemResposta.some((m) => m.direcao === 'recebida'),
            'quem está em Aguardando não tem nenhuma mensagem do cliente');

        /* ao finalizar o atendimento o lead sai das duas filas */
        const finalizar = await fetch(BASE + '/api/finalizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ telefone: semResposta.telefone })
        });
        assert.strictEqual(finalizar.status, 200, 'finalizar o atendimento do lead testado');

        const depoisDeFinalizar = await lerJson(await fetch(
            BASE + '/api/clientes?status=ativos&limite=200',
            { headers: { Cookie: cookie } }
        ));
        assert.ok(!depoisDeFinalizar.some((c) => c.telefone === semResposta.telefone),
            'lead finalizado não aparece em Aguardando nem em Conversa ativa');

        console.log('OK - painel recebe as duas filas: ' + aguardando.length + ' aguardando / '
            + ativas.length + ' conversa ativa');

        /* ---------- 2. HTML: só duas filas + ficha recolhível ---------- */
        const html = fs.readFileSync('colaborador.html', 'utf8');

        const filtros = (html.match(/data-filtro="[^"]+"/g) || [])
            .map((item) => item.replace('data-filtro="', '').replace('"', ''));

        assert.deepStrictEqual(filtros, ['aguardando', 'ativa'],
            'painel do colaborador tem só as filas Aguardando e Conversa ativa: ' + JSON.stringify(filtros));
        assert.ok(!/data-filtro="(todos|finalizados|ativos)"/.test(html),
            'as abas antigas (Todos / Finalizados) saíram do painel');
        assert.ok(/id="contador-aguardando"/.test(html) && /id="contador-ativa"/.test(html),
            'as filas mostram quantos leads têm');

        assert.ok(/id="painel-ficha"/.test(html), 'painel da ficha tem id para recolher');
        assert.ok(/id="ficha-corpo"/.test(html), 'conteúdo da ficha fica num bloco recolhível');
        assert.ok(/id="btn-ficha"[^>]*aria-expanded="true"/.test(html), 'botão de recolher a ficha começa aberto');
        assert.ok(/aria-controls="ficha-corpo"/.test(html), 'botão de recolher aponta para a ficha');

        console.log('OK - painel do colaborador tem as duas filas e a ficha recolhível');

        /* ---------- 3. JS/CSS que fazem a tela funcionar ---------- */
        const js = fs.readFileSync('colaborador.js', 'utf8');

        assert.ok(/parametros\.set\('status', 'ativos'\)/.test(js),
            'as duas filas carregam só atendimentos abertos');
        assert.ok(!/finalizados/.test(js), 'o painel não pede mais a lista de finalizados');
        assert.ok(/function clienteRespondido/.test(js) && /function clientesDaFila/.test(js),
            'o painel separa os leads pelo campo respondido');
        assert.ok(/const VAZIO_DA_FILA/.test(js), 'cada fila tem mensagem própria de lista vazia');
        assert.ok(/function aplicarEstadoFicha/.test(js) && /qgc-ficha-recolhida/.test(js),
            'estado da ficha é aplicado e lembrado entre visitas');
        assert.ok(/contatos\.unshift\(aberto\)/.test(js),
            'conversa aberta não some da lista quando muda de fila');
        assert.ok(/const etiqueta = fixado \? 'aberto'/.test(js),
            'conversa fixada é marcada como aberta na lista');

        const css = fs.readFileSync('colaborador.css', 'utf8');
        assert.ok(/\.client-panel\.recolhida/.test(css), 'CSS da ficha recolhida');
        assert.ok(/\.filters button \.contador/.test(css), 'CSS do contador das filas');
        assert.ok(/\.contact-item \.tag-fila/.test(css), 'CSS da etiqueta respondeu/aguardando');
        assert.ok(/\.contact-item \.tag-fila\.aberto/.test(css), 'CSS da etiqueta aberto');

        console.log('OK - filas e ficha recolhível ligadas no JS/CSS');

        /* ---------- 4. Painel do admin: mesmas duas filas ---------- */
        const adminHtml = fs.readFileSync('index.html', 'utf8');

        const filasAdmin = (adminHtml.match(/filtrarConversas\('([^']+)'/g) || [])
            .map((item) => item.replace("filtrarConversas('", '').replace("'", ''));

        assert.deepStrictEqual(filasAdmin, ['aguardando', 'ativa'],
            'tela Conversas do admin tem só Aguardando e Conversa ativa: ' + JSON.stringify(filasAdmin));
        assert.ok(!/filtrarConversas\('(ativos|todos|finalizado)'/.test(adminHtml),
            'as abas antigas (Todos / Finalizados) saíram do painel do admin');
        assert.ok(/id="contador-aguardando-admin"/.test(adminHtml) && /id="contador-ativa-admin"/.test(adminHtml),
            'o admin também vê quantos leads há em cada fila');

        const appJs = fs.readFileSync('app.js', 'utf8');
        assert.ok(/let filtroStatus = 'aguardando'/.test(appJs), 'a tela Conversas do admin abre em Aguardando');
        assert.ok(/status: 'ativos'/.test(appJs), 'o admin só pede atendimentos abertos (finalizado sai do painel)');
        assert.ok(/function conversasDaFila/.test(appJs) && /function renderizarConversas/.test(appJs),
            'o admin separa os leads pelo campo respondido');
        assert.ok(!/status: filtroStatus/.test(appJs), 'o filtro antigo não vai mais para a API');
        assert.ok(/const etiqueta = fixado \? 'aberto'/.test(appJs),
            'a conversa aberta do admin fica marcada na lista');

        const styleCss = fs.readFileSync('style.css', 'utf8');
        assert.ok(/\.filtros button \.contador/.test(styleCss), 'CSS do contador das filas do admin');
        assert.ok(/\.contact-item \.tag-fila\.aberto/.test(styleCss), 'CSS da etiqueta aberto no admin');

        const cookieAdmin = await sessao('admin@qgcteam.com');
        const comoAdmin = await lerJson(await fetch(BASE + '/api/clientes?status=ativos&limite=200', {
            headers: { Cookie: cookieAdmin }
        }));

        assert.ok(Array.isArray(comoAdmin) && comoAdmin.length, 'o admin vê os leads de todos os colaboradores');
        comoAdmin.forEach((cliente) => {
            assert.strictEqual(typeof cliente.respondido, 'boolean',
                'o admin também recebe o campo respondido: ' + JSON.stringify(cliente));
        });

        console.log('OK - painel do admin também tem as duas filas');
    } catch (erro) {
        console.error(erro && erro.stack ? erro.stack : erro);
        console.error('--- log do servidor ---\n' + log);
        process.exitCode = 1;
    } finally {
        filho.kill();
    }
})();

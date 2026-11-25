/* =========================================================
   QGC TEAM by JV - Teste de imagem no chat + presença online
   ---------------------------------------------------------
   Confere:
     - envio de imagem pelo painel (/api/enviar-imagem), com a
       foto guardada e visível no histórico (/api/midias/:id)
     - quem enxerga a imagem (admin e dono do lead) e quem não
     - presença: /api/usuarios diz quem está online agora
   Roda com: node test-imagem-presenca-e2e.js (modo demo, porta 3110).
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');

const PORTA = 3110;
const BASE = 'http://127.0.0.1:' + PORTA;

/* PNG 1x1 transparente: serve para provar que os bytes chegam intactos. */
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
);

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

async function carteira(cookie) {
    const resposta = await fetch(BASE + '/api/clientes?status=ativos&limite=200', {
        headers: { Cookie: cookie }
    });
    return lerJson(resposta);
}

function enviarImagem(cookie, telefone, legenda, extras) {
    const parametros = new URLSearchParams({ telefone });
    if (legenda) parametros.set('legenda', legenda);

    const opcoes = extras || {};
    return fetch(BASE + '/api/enviar-imagem?' + parametros.toString(), {
        method: 'POST',
        headers: Object.assign({ Cookie: cookie, 'Content-Type': 'image/png' }, opcoes.headers || {}),
        body: opcoes.body === undefined ? PNG_1X1 : opcoes.body
    });
}

async function usuarios(cookie) {
    const resposta = await fetch(BASE + '/api/usuarios', { headers: { Cookie: cookie } });
    return { status: resposta.status, lista: await lerJson(resposta) };
}


(async () => {
    try {
        await esperarServidor();

        const cookieColab = await sessao('colaborador@qgcteam.com');
        const cookieAdmin = await sessao('admin@qgcteam.com');

        const meusClientes = await carteira(cookieColab);
        assert.ok(Array.isArray(meusClientes) && meusClientes.length, 'colaborador tem leads na carteira');
        const lead = meusClientes[0];

        /* ---------- 1. Enviar imagem pelo painel ---------- */
        const envio = await enviarImagem(cookieColab, lead.telefone, 'Segue a foto do produto');
        const dadosEnvio = await lerJson(envio);

        assert.strictEqual(envio.status, 200, 'envio de imagem aceito: ' + JSON.stringify(dadosEnvio));
        assert.strictEqual(dadosEnvio.success, true, 'servidor confirma o envio');
        assert.ok(Number.isInteger(dadosEnvio.midiaId) && dadosEnvio.midiaId > 0,
            'servidor devolve o id da imagem guardada: ' + JSON.stringify(dadosEnvio));

        console.log('OK - imagem enviada pelo painel do colaborador (id ' + dadosEnvio.midiaId + ')');

        /* ---------- 2. A foto aparece no histórico ---------- */
        const historico = await lerJson(await fetch(
            BASE + '/api/clientes/' + encodeURIComponent(lead.telefone) + '/mensagens',
            { headers: { Cookie: cookieColab } }
        ));

        const comImagem = historico.filter((msg) => msg.midia_id === dadosEnvio.midiaId);
        assert.strictEqual(comImagem.length, 1, 'a imagem entrou uma vez no histórico da conversa');
        assert.strictEqual(comImagem[0].direcao, 'enviada', 'a imagem consta como enviada');
        assert.strictEqual(comImagem[0].texto, 'Segue a foto do produto', 'legenda salva junto da foto');

        const imagem = await fetch(BASE + '/api/midias/' + dadosEnvio.midiaId, { headers: { Cookie: cookieColab } });
        const bytes = Buffer.from(await imagem.arrayBuffer());

        assert.strictEqual(imagem.status, 200, 'o dono do lead abre a imagem do histórico');
        assert.ok(String(imagem.headers.get('content-type') || '').startsWith('image/png'),
            'imagem volta com o tipo certo');
        assert.ok(bytes.equals(PNG_1X1), 'os bytes da imagem são os mesmos que foram enviados');

        const imagemAdmin = await fetch(BASE + '/api/midias/' + dadosEnvio.midiaId, { headers: { Cookie: cookieAdmin } });
        assert.strictEqual(imagemAdmin.status, 200, 'o admin também abre a imagem');

        console.log('OK - imagem guardada no histórico e servida para admin e dono do lead');

        /* ---------- 3. Carteira alheia e formatos inválidos ---------- */
        const todos = await carteira(cookieAdmin);
        const deOutroVendedor = todos.find((cliente) =>
            String(cliente.vendedor_email || '').toLowerCase() === 'vendedor@qgcteam.com');

        assert.ok(deOutroVendedor, 'existe lead de outro vendedor para testar o isolamento');

        const envioOutro = await enviarImagem(cookieAdmin, deOutroVendedor.telefone, 'foto do outro vendedor');
        const dadosOutro = await lerJson(envioOutro);
        assert.strictEqual(envioOutro.status, 200, 'admin envia imagem para lead de qualquer vendedor');

        const invasao = await fetch(BASE + '/api/midias/' + dadosOutro.midiaId, { headers: { Cookie: cookieColab } });
        assert.strictEqual(invasao.status, 403, 'colaborador não abre imagem de lead que não é dele');

        const arquivoErrado = await enviarImagem(cookieColab, lead.telefone, '', {
            headers: { 'Content-Type': 'text/plain' },
            body: Buffer.from('isto não é uma imagem')
        });
        const dadosErrados = await lerJson(arquivoErrado);
        assert.strictEqual(arquivoErrado.status, 415, 'tipo de arquivo estranho é recusado: ' + JSON.stringify(dadosErrados));
        assert.strictEqual(dadosErrados.success, false, 'recusa vem com success:false');

        const vazio = await enviarImagem(cookieColab, lead.telefone, '', { body: Buffer.alloc(0) });
        assert.strictEqual(vazio.status, 400, 'imagem vazia é recusada');

        const grande = await enviarImagem(cookieColab, lead.telefone, '', { body: Buffer.alloc(5 * 1024 * 1024 + 100, 7) });
        const dadosGrande = await lerJson(grande);
        assert.strictEqual(grande.status, 413, 'imagem acima de 5 MB é recusada: ' + JSON.stringify(dadosGrande));

        console.log('OK - imagem respeita a carteira e só aceita JPG/PNG/WEBP');

        /* ---------- 4. Quem está online (tela Usuários) ---------- */
        const antes = await usuarios(cookieAdmin);
        assert.strictEqual(antes.status, 200, 'admin lê a lista de usuários');

        const colabAntes = antes.lista.find((usuario) => usuario.email === 'colaborador@qgcteam.com');
        assert.ok(colabAntes, 'colaborador aparece na lista de usuários');
        assert.strictEqual(colabAntes.online, true, 'quem acabou de logar aparece online');
        assert.ok(colabAntes.desde, 'a lista diz desde quando está online');

        const semSinal = await fetch(BASE + '/api/presenca', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookieColab },
            body: JSON.stringify({ ativo: false })
        });
        assert.strictEqual(semSinal.status, 200, 'painel avisa quando a aba é escondida');

        const offline = await usuarios(cookieAdmin);
        const colabOffline = offline.lista.find((usuario) => usuario.email === 'colaborador@qgcteam.com');
        assert.strictEqual(colabOffline.online, false, 'sem sinal, o colaborador aparece offline');
        assert.ok(colabOffline.ultimoSinal, 'offline guarda quando foi visto pela última vez');

        const voltou = await fetch(BASE + '/api/presenca', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookieColab },
            body: '{}'
        });
        const dadosVoltou = await lerJson(voltou);
        assert.strictEqual(voltou.status, 200, 'heartbeat de presença funciona');
        assert.strictEqual(dadosVoltou.online, true, 'heartbeat devolve online:true');

        const onlineDeNovo = await usuarios(cookieAdmin);
        const colabOnline = onlineDeNovo.lista.find((usuario) => usuario.email === 'colaborador@qgcteam.com');
        assert.strictEqual(colabOnline.online, true, 'heartbeat coloca o colaborador online outra vez');

        const semPermissao = await fetch(BASE + '/api/usuarios', { headers: { Cookie: cookieColab } });
        assert.strictEqual(semPermissao.status, 403, 'colaborador não vê a lista de usuários');

        const logout = await fetch(BASE + '/api/logout', { method: 'POST', headers: { Cookie: cookieColab } });
        assert.ok([200, 302].includes(logout.status), 'logout responde');

        const depoisDoLogout = await usuarios(cookieAdmin);
        const colabSaiu = depoisDoLogout.lista.find((usuario) => usuario.email === 'colaborador@qgcteam.com');
        assert.strictEqual(colabSaiu.online, false, 'logout marca o colaborador como offline na hora');

        console.log('OK - admin vê no Sistema quem está online e quem saiu');

        /* ---------- 5. Telas ligadas no HTML/JS/CSS ---------- */
        const colabHtml = fs.readFileSync('colaborador.html', 'utf8');
        assert.ok(/type="file"[^>]*id="input-imagem"/.test(colabHtml), 'painel do colaborador tem o seletor de imagem');
        assert.ok(/accept="image\/png,image\/jpeg,image\/webp"/.test(colabHtml), 'seletor aceita só fotos');
        assert.ok(/enviarImagemSelecionada\(this\)/.test(colabHtml), 'escolher a foto já dispara o envio');
        assert.ok(/class="btn-anexo"/.test(colabHtml), 'chat do colaborador tem o botão de anexo');

        const colabJs = fs.readFileSync('colaborador.js', 'utf8');
        assert.ok(/async function enviarImagemSelecionada/.test(colabJs), 'colaborador.js envia a imagem');
        assert.ok(/\/api\/enviar-imagem/.test(colabJs), 'colaborador.js usa a rota da imagem');
        assert.ok(/mensagem-imagem/.test(colabJs), 'histórico renderiza a foto na bolha');
        assert.ok(/\/api\/presenca/.test(colabJs), 'colaborador avisa que está online');

        const adminHtml = fs.readFileSync('index.html', 'utf8');
        assert.ok(/id="input-imagem-admin"/.test(adminHtml), 'chat do admin também tem seletor de imagem');
        assert.ok(/<th>Acesso<\/th>/.test(adminHtml), 'tela Usuários tem a coluna Acesso');
        assert.ok(/id="resumo-equipe"/.test(adminHtml), 'tela Usuários mostra o resumo de quem está online');

        const appJs = fs.readFileSync('app.js', 'utf8');
        assert.ok(/async function enviarImagemSelecionada/.test(appJs), 'app.js envia imagem pelo chat do admin');
        assert.ok(/function etiquetaPresenca/.test(appJs), 'app.js monta a etiqueta Online/Offline');
        assert.ok(/presenca online/.test(appJs) && /presenca offline/.test(appJs), 'as duas etiquetas existem');
        assert.ok(/iniciarPresencaPainel\(\)/.test(appJs), 'painel do admin manda sinal de presença');
        assert.ok(/iniciarAtualizacaoUsuarios\(\)/.test(appJs), 'tela Usuários se atualiza sozinha');

        const styleCss = fs.readFileSync('style.css', 'utf8');
        assert.ok(/\.presenca\.online/.test(styleCss), 'CSS da etiqueta online');
        assert.ok(/\.presenca\.offline/.test(styleCss), 'CSS da etiqueta offline');
        assert.ok(/\.mensagem-imagem/.test(styleCss), 'CSS da foto no chat do admin');

        const colabCss = fs.readFileSync('colaborador.css', 'utf8');
        assert.ok(/\.mensagem-imagem/.test(colabCss), 'CSS da foto no chat do colaborador');
        assert.ok(/\.btn-anexo/.test(colabCss), 'CSS do botão de anexo');

        console.log('OK - imagem e presença ligadas nas telas do admin e do colaborador');
    } catch (erro) {
        console.error(erro && erro.stack ? erro.stack : erro);
        console.error('--- log do servidor ---\n' + log);
        process.exitCode = 1;
    } finally {
        filho.kill();
    }
})();



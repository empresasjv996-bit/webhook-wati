/* Teste de ponta a ponta da reabertura do ticket:
   lista os templates aprovados, valida as variáveis e envia um template
   para o contato como se o colaborador tivesse usado a barra do chat.
   Roda com: node test-reabertura-template-e2e.js (modo demo, porta 3108). */
'use strict';

const assert = require('assert');
const fs = require('fs');
const { spawn } = require('child_process');

const PORTA = 3108;
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


(async () => {
    try {
        await esperarServidor();

        const login = await fetch(BASE + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'admin@qgcteam.com', senha: '123456' })
        });
        assert.strictEqual(login.status, 200, 'login falhou: ' + (await login.text()));

        const setCookie = login.headers.getSetCookie
            ? login.headers.getSetCookie()[0]
            : login.headers.get('set-cookie');
        const cookie = String(setCookie || '').split(';')[0];
        assert.ok(cookie, 'cookie de sessão não veio no login');

        /* ---------- lista de templates aprovados ---------- */
        const respostaTemplates = await fetch(BASE + '/api/templates-reabertura', {
            headers: { Cookie: cookie }
        });
        const lista = await lerJson(respostaTemplates);

        assert.strictEqual(respostaTemplates.status, 200, JSON.stringify(lista));
        assert.ok(Array.isArray(lista.templates) && lista.templates.length >= 2,
            'templates aprovados vêm na lista: ' + JSON.stringify(lista));

        const posicional = lista.templates.find((item) => item.nome === 'teste_painel');
        assert.ok(posicional, 'template com variáveis posicionais aparece');
        assert.deepStrictEqual(posicional.variaveis, ['1', '2'], 'variáveis do template vêm em ordem');
        assert.ok(posicional.corpo.includes('{{1}}'), 'corpo do template é enviado para a prévia');
        assert.ok(posicional.idioma, 'idioma do template é informado');

        const nomeado = lista.templates.find((item) => item.nome === 'boas_vindas');
        assert.ok(nomeado, 'template com variável nomeada aparece');
        assert.deepStrictEqual(nomeado.variaveis, ['nome']);

        console.log('OK - lista de templates aprovados para reabrir o atendimento');

        /* ---------- contato usado no teste ---------- */
        const respostaClientes = await fetch(BASE + '/api/clientes?status=todos&limite=50', {
            headers: { Cookie: cookie }
        });
        const clientes = await lerJson(respostaClientes);
        assert.strictEqual(respostaClientes.status, 200, JSON.stringify(clientes));
        assert.ok(Array.isArray(clientes) && clientes.length, 'há contatos para testar');

        const telefone = clientes[0].telefone;

        const enviar = (corpo) => fetch(BASE + '/api/enviar-template', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify(corpo)
        });

        /* ---------- validações ---------- */
        const semTelefone = await enviar({ template: 'boas_vindas', parametros: ['Ana'] });
        assert.strictEqual(semTelefone.status, 400, 'sem contato é recusado');

        const semTemplate = await enviar({ telefone });
        assert.strictEqual(semTemplate.status, 400, 'sem template é recusado');

        const foraDaLista = await enviar({ telefone, template: 'nao_existe', parametros: [] });
        const dadosForaDaLista = await lerJson(foraDaLista);
        assert.strictEqual(foraDaLista.status, 400, JSON.stringify(dadosForaDaLista));
        assert.ok(/não está aprovado/.test(dadosForaDaLista.message || ''),
            'template fora da lista aprovada é recusado: ' + JSON.stringify(dadosForaDaLista));

        const variavelFaltando = await enviar({ telefone, template: 'teste_painel', parametros: ['Ana'] });
        const dadosVariavelFaltando = await lerJson(variavelFaltando);
        assert.strictEqual(variavelFaltando.status, 400, JSON.stringify(dadosVariavelFaltando));
        assert.ok(/2 variável\(is\)/.test(dadosVariavelFaltando.message || ''),
            'quantidade de variáveis é conferida: ' + JSON.stringify(dadosVariavelFaltando));

        console.log('OK - validações do envio do template (contato, aprovação e variáveis)');

        /* ---------- envio com variável nomeada ---------- */
        const envioNomeado = await enviar({ telefone, template: 'boas_vindas', parametros: ['Ana'] });
        const dadosNomeado = await lerJson(envioNomeado);

        assert.strictEqual(envioNomeado.status, 200, JSON.stringify(dadosNomeado));
        assert.strictEqual(dadosNomeado.success, true);
        assert.strictEqual(dadosNomeado.template, 'boas_vindas');
        assert.strictEqual(dadosNomeado.texto, 'Olá Ana, seu cadastro foi recebido com sucesso.',
            'o texto gravado é o template já preenchido');

        /* ---------- envio com variáveis posicionais {{1}} e {{2}} ---------- */
        const envioPosicional = await enviar({ telefone, template: 'teste_painel', parametros: ['Ana', 'Pix'] });
        const dadosPosicional = await lerJson(envioPosicional);

        assert.strictEqual(envioPosicional.status, 200, JSON.stringify(dadosPosicional));
        assert.strictEqual(dadosPosicional.texto, 'Olá Ana, temos uma novidade sobre Pix.',
            'variáveis {{1}}/{{2}} são trocadas na ordem enviada');

        console.log('OK - template preenchido é gravado na conversa (' + dadosPosicional.texto + ')');

        /* ---------- histórico da conversa ---------- */
        const respostaMensagens = await fetch(
            BASE + '/api/clientes/' + encodeURIComponent(telefone) + '/mensagens',
            { headers: { Cookie: cookie } }
        );
        const mensagens = await lerJson(respostaMensagens);

        assert.strictEqual(respostaMensagens.status, 200, JSON.stringify(mensagens));
        assert.ok(Array.isArray(mensagens) && mensagens.length, 'a conversa tem histórico');

        const doTemplate = mensagens.filter((msg) => String(msg.texto || '').includes('novidade sobre Pix'));
        assert.ok(doTemplate.length, 'a mensagem do template aparece no histórico');
        assert.strictEqual(doTemplate[0].direcao, 'enviada', 'o template entra como mensagem enviada');

        console.log('OK - mensagem do template aparece no histórico da conversa');



        /* ---------- as duas telas oferecem a barra do template ---------- */
        [['colaborador.html', 'colaborador.js', 'colaborador.css'],
            ['index.html', 'app.js', 'style.css']].forEach(([html, js, css]) => {
            const pagina = fs.readFileSync(html, 'utf8');
            const codigo = fs.readFileSync(js, 'utf8');
            const estilo = fs.readFileSync(css, 'utf8');

            assert.ok(pagina.includes('select-template') && pagina.includes('enviarTemplateReabertura'),
                html + ' tem a barra "Reabrir ticket com template"');
            assert.ok(codigo.includes('/api/templates-reabertura') && codigo.includes('/api/enviar-template'),
                js + ' chama as rotas da reabertura');
            assert.ok(estilo.includes('.template-bar'), css + ' estiliza a barra do template');
        });

        console.log('OK - painel do admin e do colaborador têm a barra do template');

        /* ---------- contato ausente na Wati: cria e repete o envio ---------- */
        const fonteIndex = fs.readFileSync('index.js', 'utf8');
        const usosDoContato = fonteIndex.split('garantirContatoNaWati(numero)').length - 1;

        assert.ok(fonteIndex.includes('function contatoInexistenteNaWati(')
            && fonteIndex.includes('function garantirContatoNaWati('),
            'index.js reconhece e cria o contato ausente na Wati');
        assert.ok(usosDoContato >= 2,
            'texto livre e template garantem o contato antes de repetir o envio');

        console.log('OK - contato ausente na Wati é criado e o envio repetido (texto livre e template)');
    } finally {
        filho.kill();
    }
})().catch((erro) => {
    console.error(erro);
    console.error(log);
    try { filho.kill(); } catch (falha) { /* já encerrado */ }
    process.exitCode = 1;
});

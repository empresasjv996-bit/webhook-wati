/* Teste de ponta a ponta do formato "lista por variáveis":
   importa uma lista com {{1}}/{{2}}, confere os atributos e cria uma
   campanha de template usando essas variáveis.
   Roda com: node test-listas-variaveis-e2e.js (modo demo, porta 3107). */
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');

const PORTA = 3107;
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

        const nomeLista = 'TESTE VARIAVEIS ' + Date.now();
        const criacao = await fetch(BASE + '/api/listas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
                nome: nomeLista,
                contatos: [
                    { telefone: '5511999999999', nome: '', atributos: { cnpj: '12.345.678/0001-90' }, variaveis: { 1: 'João da Silva', 2: '12.345.678/0001-90' } },
                    { telefone: '5511888888888', nome: '', atributos: {}, variaveis: { 1: 'Maria Souza', 2: '98.765.432/0001-10' } }
                ]
            })
        });
        const lista = await lerJson(criacao);
        assert.strictEqual(criacao.status, 200, JSON.stringify(lista));
        assert.strictEqual(lista.success, true);
        assert.strictEqual(lista.total, 2);

        const respostaAtributos = await fetch(BASE + '/api/listas/' + lista.id + '/atributos', {
            headers: { Cookie: cookie }
        });
        const atributos = await lerJson(respostaAtributos);
        assert.strictEqual(atributos.formato, 'variaveis');
        assert.strictEqual(atributos.total, 2);

        const porNome = {};
        (atributos.atributos || []).forEach((item) => { porNome[item.nome] = item; });

        assert.strictEqual(porNome['1'] && porNome['1'].tipo, 'variavel');
        assert.strictEqual(porNome['1'] && porNome['1'].comValor, 2);
        assert.strictEqual(porNome['2'] && porNome['2'].tipo, 'variavel');
        assert.strictEqual(porNome['2'] && porNome['2'].comValor, 2);
        assert.strictEqual(porNome.cnpj && porNome.cnpj.tipo, 'atributo');

        const criacaoCampanha = await fetch(BASE + '/api/campanhas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({
                nome: 'Campanha variaveis ' + Date.now(),
                listaId: lista.id,
                mensagem: '',
                canal: 'template',
                templateNome: 'teste_painel',
                templateIdioma: 'pt_BR',
                parametros: [
                    { nome: '1', origem: 'atributo', valor: '1' },
                    { nome: '2', origem: 'atributo', valor: '2' }
                ],
                intervalo: 3000
            })
        });
        const campanha = await lerJson(criacaoCampanha);
        assert.strictEqual(criacaoCampanha.status, 200, JSON.stringify(campanha));
        assert.strictEqual(campanha.success, true);
        assert.strictEqual(campanha.total, 2);

        // A fila demorada do modo demo envia sozinha; confere que as duas
        // mensagens saíram com os valores {{1}}/{{2}} já resolvidos.
        let resumo = null;
        for (let tentativa = 0; tentativa < 40; tentativa++) {
            const respostaLista = await fetch(BASE + '/api/campanhas', { headers: { Cookie: cookie } });
            const campanhas = await lerJson(respostaLista);
            resumo = (campanhas.campanhas || campanhas || []).find((item) => String(item.id) === String(campanha.id));
            if (resumo && (Number(resumo.enviados) + Number(resumo.falhas)) >= 2) break;
            await dormir(300);
        }

        assert.ok(resumo, 'campanha criada não apareceu na listagem');
        assert.strictEqual(Number(resumo.falhas), 0, 'houve falha no envio demo: ' + JSON.stringify(resumo));

        console.log('OK - lista {{1}}/{{2}} importada e campanha enviada para ' + resumo.enviados + ' contato(s)');
    } finally {
        filho.kill();
    }
})().catch((erro) => {
    console.error(erro);
    console.error(log);
    try { filho.kill(); } catch (falha) { /* já encerrado */ }
    process.exitCode = 1;
});

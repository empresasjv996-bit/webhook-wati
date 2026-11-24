/* =========================================================
   QGC TEAM by JV - Teste de comportamento do menu
   Executa o app.js num DOM mínimo e confere: abrir/fechar dos
   grupos, destaque do grupo da tela atual e troca de tela.
   Roda com: node test-menu-ui.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function classe(inicial) {
    const set = new Set(String(inicial || '').split(/\s+/).filter(Boolean));

    return {
        add: (...nomes) => nomes.forEach((nome) => set.add(nome)),
        remove: (...nomes) => nomes.forEach((nome) => set.delete(nome)),
        contains: (nome) => set.has(nome),
        toggle: (nome, forcar) => {
            const valor = forcar === undefined ? !set.has(nome) : !!forcar;
            if (valor) set.add(nome); else set.delete(nome);
            return valor;
        }
    };
}

function botao(view) {
    return {
        tag: 'button',
        dataset: view ? { view } : {},
        attrs: {},
        classList: classe(view === 'inicio' ? 'active' : ''),
        setAttribute(nome, valor) { this.attrs[nome] = String(valor); },
        getAttribute(nome) { return this.attrs[nome]; }
    };
}

const html = fs.readFileSync('index.html', 'utf8');
const menu = html.slice(html.indexOf('<div class="top-nav"'), html.indexOf('<div class="top-actions">'));

/* botões diretos (Início, Listas) ficam antes do primeiro grupo */
const diretos = Array.from(menu.split('<div class="nav-grupo"')[0].matchAll(/data-view="([a-z]+)"/g))
    .map((m) => botao(m[1]));

const views = Array.from(html.matchAll(/<section class="view([^"]*)" id="(view-[a-z]+)"/g)).map((m) => ({
    id: m[2],
    classList: classe('view' + m[1])
}));

const grupos = [];

menu.split('<div class="nav-grupo" data-grupo="').slice(1).forEach((parte) => {
    const nome = parte.slice(0, parte.indexOf('"'));
    const gatilho = botao();
    gatilho.classList.add('nav-grupo-btn');

    const itens = Array.from(parte.matchAll(/data-view="([a-z]+)"/g)).map((m) => botao(m[1]));

    const grupo = {
        dataset: { grupo: nome },
        classList: classe('nav-grupo'),
        querySelector(seletor) {
            if (seletor === 'button.active') return itens.find((item) => item.classList.contains('active')) || null;
            if (seletor === '.nav-grupo-btn') return gatilho;
            return null;
        }
    };

    grupos.push({ nome, grupo, gatilho, itens });
});

const conteudo = { scrollTop: 99 };

const documento = {
    readyState: 'loading',
    querySelectorAll(seletor) {
        if (seletor === '.view') return views;
        if (seletor === '.top-nav button') return diretos.concat(grupos.reduce((todos, g) => todos.concat([g.gatilho], g.itens), []));
        if (seletor === '.nav-grupo') return grupos.map((g) => g.grupo);
        if (seletor === '.nav-grupo.aberto') return grupos.filter((g) => g.grupo.classList.contains('aberto')).map((g) => g.grupo);
        if (seletor === '.content') return [conteudo];
        return [];
    },
    getElementById(id) { return views.find((view) => view.id === id) || null; },
    querySelector(seletor) {
        if (seletor === '.content') return conteudo;

        const grupo = seletor.match(/^\.nav-grupo\[data-grupo="([a-z]+)"\]$/);
        if (grupo) {
            const achado = grupos.find((g) => g.nome === grupo[1]);
            return achado ? achado.grupo : null;
        }

        return null;
    },
    addEventListener() {}
};

const contexto = {
    document: documento,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    alert: () => {},
    confirm: () => true,
    Notification: function Notification() {},
    EventSource: function EventSource() { this.close = () => {}; },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { reload: () => {} }
};

contexto.window = contexto;
contexto.globalThis = contexto;

vm.createContext(contexto);
vm.runInContext(fs.readFileSync('app.js', 'utf8'), contexto, { filename: 'app.js' });

['carregarDashboard', 'carregarConversas', 'carregarTabelaClientes', 'carregarListas', 'carregarCanais',
    'carregarWebhook', 'carregarVendedoresCampanha', 'carregarListasCampanha', 'carregarCampanhas',
    'alterarCanalCampanha', 'iniciarAtividadeWati', 'carregarLogs', 'carregarAuditoria', 'carregarUsuarios',
    'pararAtividadeWati'].forEach((nome) => { contexto[nome] = () => {}; });

const grupoDe = (nome) => grupos.find((g) => g.nome === nome);
const aberto = () => grupos.filter((g) => g.grupo.classList.contains('aberto')).map((g) => g.nome);
const ativo = () => grupos.filter((g) => g.grupo.classList.contains('nav-grupo-ativo')).map((g) => g.nome);
const direto = (nome) => diretos.find((b) => b.dataset.view === nome);

function tela(nome) {
    return views.find((view) => view.id === 'view-' + nome);
}

/* troca de tela: Listas concentra dump, CPF, telefone e planilha */
contexto.mostrarListas();
assert.strictEqual(tela('listas').classList.contains('oculto'), false, 'tela Listas aparece');
assert.strictEqual(tela('inicio').classList.contains('oculto'), true, 'Início some');
assert.strictEqual(direto('listas').classList.contains('active'), true, 'botão Listas fica ativo');
assert.strictEqual(direto('inicio').classList.contains('active'), false, 'Início deixa de ficar ativo');
assert.deepStrictEqual(ativo(), [], 'nenhum grupo destacado na tela Listas');
assert.deepStrictEqual(aberto(), [], 'submenus fecham ao trocar de tela');

/* o apelido antigo continua abrindo a tela única */
assert.strictEqual(tela('listasuja'), undefined, 'não existe mais a tela separada de Lista Suja');
contexto.irPara('inicio');
contexto.irPara('listasuja');
assert.strictEqual(tela('listas').classList.contains('oculto'), false, 'irPara("listasuja") cai na tela Listas');

/* abrir/fechar grupos */
contexto.alternarGrupoNav('contatos');
assert.deepStrictEqual(aberto(), ['contatos'], 'Contatos abre');
assert.strictEqual(grupoDe('contatos').gatilho.getAttribute('aria-expanded'), 'true', 'aria-expanded acompanha');

contexto.alternarGrupoNav('contatos');
assert.deepStrictEqual(aberto(), [], 'clicar de novo fecha');

contexto.alternarGrupoNav('envio');
contexto.alternarGrupoNav('sistema');
assert.deepStrictEqual(aberto(), ['sistema'], 'abrir outro grupo fecha o anterior');

contexto.irPara('listas');
assert.deepStrictEqual(aberto(), [], 'irPara fecha tudo');
assert.strictEqual(direto('listas').classList.contains('active'), true, 'botão Listas ativo depois do irPara');
assert.strictEqual(tela('listas').classList.contains('oculto'), false, 'tela Listas aparece');
assert.strictEqual(conteudo.scrollTop, 0, 'troca de tela volta ao topo');

contexto.irPara('extrator');
assert.deepStrictEqual(ativo(), ['contatos'], 'grupo Contatos destacado em Consultar CPF');

console.log('OK - menu: Início/Listas diretos e grupos Contatos/Envio/Sistema abrem, fecham e destacam a tela atual');

/* =========================================================
   QGC TEAM by JV - Testes do menu
   Início · Listas · Contatos · Envio · Sistema
   Roda com: node test-navegacao.js
   ========================================================= */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = __dirname;
const html = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
const painel = fs.readFileSync(path.join(raiz, 'app.js'), 'utf8');
const estilos = fs.readFileSync(path.join(raiz, 'style.css'), 'utf8');

/* ---------- recorta a barra de navegação ---------- */

const inicioMenu = html.indexOf('<div class="top-nav"');
const fimMenu = html.indexOf('<div class="top-actions">');

assert.ok(inicioMenu > -1, 'barra de navegação (.top-nav) existe no index.html');
assert.ok(fimMenu > inicioMenu, 'barra de navegação fica antes das ações do topo');

const menu = html.slice(inicioMenu, fimMenu);

assert.strictEqual(
    (menu.match(/<div/g) || []).length,
    (menu.match(/<\/div>/g) || []).length,
    'tags <div> do menu balanceadas (estrutura do topo fechada)'
);

/* ---------- grupos na ordem definida ---------- */

const grupos = Array.from(menu.matchAll(/class="nav-grupo" data-grupo="([a-z]+)"/g)).map((m) => m[1]);

assert.deepStrictEqual(grupos, ['contatos', 'envio', 'sistema'], 'grupos do menu: Contatos, Envio e Sistema');

assert.ok(
    /<div class="top-nav" id="menu">[\s\S]*?<button class="active" data-view="inicio" onclick="irPara\('inicio'\)">Início<\/button>/.test(menu),
    'Início continua como botão direto, ativo por padrão'
);

assert.ok(
    /<button data-view="listas" onclick="mostrarListas\(\)">Listas<\/button>/.test(menu),
    'Listas é um botão direto (fluxo único: colar arquivo -> mapear colunas -> importar)'
);

/* ---------- itens de cada submenu ---------- */

const itens = {};

menu.split(/<div class="nav-grupo" data-grupo="/).slice(1).forEach((parte) => {
    const nome = parte.slice(0, parte.indexOf('"'));
    itens[nome] = Array.from(parte.matchAll(/data-view="([a-z]+)"/g)).map((m) => m[1]);
});

assert.deepStrictEqual(itens.contatos, ['conversas', 'clientes', 'extrator', 'spyhub'],
    'Contatos: Conversas, Clientes, Consultar CPF e Verificação SpyHub');
assert.deepStrictEqual(itens.envio, ['campanhas', 'wati', 'canais'], 'Envio: Campanhas, Atividade Wati e Canais');
assert.deepStrictEqual(itens.sistema, ['logs', 'auditoria', 'usuarios'], 'Sistema: Logs, Auditoria e Usuários');

/* ---------- todo item aponta para uma tela real ---------- */

const views = Array.from(menu.matchAll(/data-view="([a-z]+)"/g)).map((m) => m[1]);
const vistas = new Set();

views.forEach((view) => {
    assert.ok(html.includes('id="view-' + view + '"'), 'a tela view-' + view + ' existe no index.html');
    assert.ok(!vistas.has(view), 'a tela ' + view + ' aparece uma única vez no menu');
    vistas.add(view);
});

assert.strictEqual(
    views.length,
    Array.from(menu.matchAll(/data-view="[a-z]+"[^>]*onclick="/g)).length,
    'todo item do menu tem onclick (nenhum item morto)'
);

/* ---------- cada item do submenu explica o que faz ---------- */

assert.strictEqual(
    (menu.match(/data-view="[a-z]+"[^>]*>[\s\S]{0,120}?<small>[^<]+<\/small>/g) || []).length,
    views.filter((view) => view !== 'inicio' && view !== 'listas').length,
    'todo item do submenu tem uma linha de ajuda (<small>)'
);

/* ---------- tela única de listas (importação de contatos) ---------- */

const telaListas = html.slice(html.indexOf('id="view-listas"'), html.indexOf('id="view-canais"'));

assert.ok(!html.includes('id="view-listasuja"'), 'não existe mais tela separada de Lista Suja');
assert.ok(!html.includes('class="listas-nav"'), 'não existem mais abas Importar <-> Lista Suja');
assert.ok(telaListas.includes('id="painel-importar"'), 'tela Listas tem um painel único de importação');
assert.ok(telaListas.includes('id="lista-texto"'), 'tela Listas recebe o arquivo/contatos colados');
assert.ok(telaListas.includes('id="tabela-listas"'), 'tela Listas mostra as listas salvas');
assert.ok(estilos.includes('.lista-texto'), 'style.css estiliza a caixa de contatos');

assert.strictEqual(
    Array.from(menu.matchAll(/class="nav-grupo-btn"/g)).length,
    grupos.length,
    'cada grupo tem um botão que abre o submenu'
);

assert.strictEqual(
    Array.from(menu.matchAll(/class="nav-submenu"/g)).length,
    grupos.length,
    'cada grupo tem um submenu vertical'
);

/* ---------- lógica de abrir/fechar ---------- */

['alternarGrupoNav', 'fecharGruposNav', 'ligarMenuAgrupado'].forEach((nome) => {
    assert.ok(new RegExp('function ' + nome + '\\(').test(painel), 'app.js define ' + nome);
});

assert.ok(
    /function iniciarPainel\(\)[\s\S]{0,600}?ligarMenuAgrupado\(\)/.test(painel),
    'iniciarPainel liga o menu agrupado (clique fora e Esc)'
);

assert.ok(
    /document\.querySelectorAll\('\.nav-grupo'\)/.test(painel),
    'irPara destaca o grupo da tela atual'
);

assert.ok(
    /function irPara\(view\)[\s\S]{0,2000}?fecharGruposNav\(\)/.test(painel),
    'irPara fecha os submenus ao trocar de tela'
);

/* ---------- estilos ---------- */

['.nav-grupo {', '.nav-submenu {', '.nav-grupo.aberto > .nav-submenu', '.nav-grupo-ativo', '.nav-submenu button small', '.nav-submenu button.active small'].forEach((regra) => {
    assert.ok(estilos.includes(regra), 'style.css contém ' + regra);
});

assert.ok(estilos.includes('@keyframes navSubmenuAbrir'), 'animação de abertura do submenu');

console.log('OK - menu: Início e Listas diretos + 3 grupos (Contatos, Envio, Sistema) com ajuda em cada item');
console.log('OK - tela única de Listas (arquivo/contatos colados -> colunas -> importação -> listas salvas)');
console.log('');
console.log('Todos os testes de navegação passaram.');

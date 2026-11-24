/* =========================================================
   QGC TEAM by JV - Painel Administrativo
   Funções ativas: Conversas, Clientes, Listas, Ficha,
   tempo real (SSE), som, notificações e pesquisa.
   ========================================================= */

const STATUS_LABEL = {
    vendido: 'Vendido',
    pensando: 'Pensando',
    'nao-quis': 'Não Quis',
    finalizado: 'Finalizado'
};

const STATUS_CLASSE = {
    vendido: 'status-vendido',
    pensando: 'status-pensando',
    'nao-quis': 'status-nao-quis',
    finalizado: 'status-pensando'
};

let clienteAtivo = null;
let clientesCache = [];
let filtroStatus = 'ativos';
let buscaAtual = '';
let fichaTelefone = null;
let sse = null;
let audioCtx = null;
let somAtivo = true;
let notificacoesAtivas = false;
let mudoAtivo = false;
let timerBusca = null;

/* Atalho para document.getElementById */
function $(id) { return document.getElementById(id); }

/* Escapa texto para não quebrar o HTML */
function escaparHtml(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function apenasNumeros(valor) { return String(valor || '').replace(/\D/g, ''); }

function formatarTelefone(telefone) {
    const num = apenasNumeros(telefone);
    if (num.length === 13) return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
    if (num.length === 12) return `+${num.slice(0, 2)} (${num.slice(2, 4)}) ${num.slice(4, 8)}-${num.slice(8)}`;
    if (num.length === 11) return `(${num.slice(0, 2)}) ${num.slice(2, 7)}-${num.slice(7)}`;
    return num || telefone || '-';
}

function formatarData(valor) {
    if (!valor) return '';
    const data = new Date(valor);
    if (isNaN(data.getTime())) return '';
    return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/* Quem enviou: painel, campanha ou Wati (mensagens antigas não têm autor). */
function rotuloAutor(mensagem) {
    if (!mensagem || mensagem.direcao !== 'enviada') return '';

    const origem = String(mensagem.origem || '').toLowerCase();
    const autor = String(mensagem.autor_nome || '').trim();

    if (origem === 'campanha') return autor ? 'Campanha · ' + autor : 'Campanha';
    if (autor) return autor;
    if (origem === 'wati') return 'Wati';
    return 'Painel';
}

function iniciais(nome) {
    const limpo = String(nome || '?').trim();
    const partes = limpo.split(/\s+/).filter(Boolean);
    if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
    return limpo.substring(0, 2).toUpperCase();
}

/* Mensagem rápida no canto da tela */
function toast(mensagem, tipo) {
    let container = $('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const item = document.createElement('div');
    item.className = 'toast' + (tipo ? ' ' + tipo : '');
    item.textContent = mensagem;
    container.appendChild(item);

    setTimeout(() => {
        item.classList.add('saindo');
        setTimeout(() => item.remove(), 300);
    }, 3200);
}

/* ---------------------------------------------------------
   NAVEGAÇÃO ENTRE AS TELAS
   --------------------------------------------------------- */
function irPara(view) {
    /* A antiga tela "Lista Suja" virou o fluxo único da tela Listas. */
    if (view === 'listasuja') view = 'listas';

    const titulos = {
        campanhas: 'Campanhas',
        wati: 'Atividade Wati',
        canais: 'Canais',
        logs: 'Logs',
        auditoria: 'Auditoria',
        extrator: 'Consultar CPF',
        usuarios: 'Usuários'
    };

    // Ao trocar de tela, para a atualização automática da Atividade Wati
    pararAtividadeWati();

    document.querySelectorAll('.view').forEach((secao) => secao.classList.add('oculto'));

    const painel = $('view-' + view);
    if (painel) {
        painel.classList.remove('oculto');
    } else {
        const generico = $('view-modulo');
        if (generico) {
            generico.classList.remove('oculto');
            const tituloModulo = $('modulo-titulo');
            if (tituloModulo) tituloModulo.textContent = titulos[view] || 'Módulo';
        }
    }

    document.querySelectorAll('.top-nav button').forEach((botao) => {
        botao.classList.toggle('active', botao.dataset.view === view);
    });

    // destaca o grupo do menu que contém a tela atual e fecha os submenus
    document.querySelectorAll('.nav-grupo').forEach((grupo) => {
        grupo.classList.toggle('nav-grupo-ativo', !!grupo.querySelector('button.active'));
    });
    fecharGruposNav();

    if (view === 'inicio') carregarDashboard();
    if (view === 'conversas') carregarConversas(true);
    if (view === 'clientes') carregarTabelaClientes();
    if (view === 'listas') carregarListas();
    if (view === 'canais') { carregarCanais(); carregarWebhook(); }
    if (view === 'campanhas') { carregarVendedoresCampanha(); carregarListasCampanha(); carregarCampanhas(); alterarCanalCampanha(); }
    if (view === 'wati') iniciarAtividadeWati();
    if (view === 'logs') carregarLogs();
    if (view === 'auditoria') carregarAuditoria();
    if (view === 'usuarios') carregarUsuarios();

    const conteudo = document.querySelector('.content');
    if (conteudo) conteudo.scrollTop = 0;
}

function irParaConversas() { irPara('conversas'); }
function mostrarClientes() { irPara('clientes'); }
function mostrarListas() { irPara('listas'); }
function mostrarInicio() { irPara('inicio'); }

/* Abre o bloco "Planilha pronta" da tela Listas — usado quando outra tela
   preenche o texto e leva o usuário direto para a importação. */
function abrirImportacaoLista() {
    const bloco = $('lista-importar');
    if (!bloco) return;

    bloco.open = true;

    if (typeof bloco.scrollIntoView === 'function') {
        bloco.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
}

/* --- menu agrupado (Início e Listas diretos · Contatos · Envio · Sistema) --- */
function alternarGrupoNav(nome) {
    const alvo = document.querySelector('.nav-grupo[data-grupo="' + nome + '"]');
    const estavaAberto = !!(alvo && alvo.classList.contains('aberto'));

    fecharGruposNav();

    if (alvo && !estavaAberto) {
        alvo.classList.add('aberto');
        const gatilho = alvo.querySelector('.nav-grupo-btn');
        if (gatilho) gatilho.setAttribute('aria-expanded', 'true');
    }
}

function fecharGruposNav() {
    document.querySelectorAll('.nav-grupo.aberto').forEach((grupo) => {
        grupo.classList.remove('aberto');
        const gatilho = grupo.querySelector('.nav-grupo-btn');
        if (gatilho) gatilho.setAttribute('aria-expanded', 'false');
    });
}

function ligarMenuAgrupado() {
    document.addEventListener('click', (evento) => {
        if (!evento.target.closest('.nav-grupo')) fecharGruposNav();
    });

    document.addEventListener('keydown', (evento) => {
        if (evento.key === 'Escape') fecharGruposNav();
    });
}

/* ---------------------------------------------------------
   USUÁRIO LOGADO / SAIR
   --------------------------------------------------------- */
async function carregarUsuario() {
    try {
        const resposta = await fetch('/api/me');
        if (!resposta.ok) return;
        const dados = await resposta.json();
        const avatar = $('avatar-usuario');
        if (avatar && dados.nome) {
            avatar.textContent = dados.nome.charAt(0).toUpperCase();
            avatar.title = dados.nome + ' (' + dados.role + ')';
        }
    } catch (erro) { console.error('Erro ao carregar usuário:', erro); }
}

async function sair() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch (erro) { /* ignora */ }
    window.location.href = '/login';
}

/* ---------------------------------------------------------
   BACKUP E LIMPEZA DO HISTÓRICO DE CONVERSAS (admin)
   --------------------------------------------------------- */
async function baixarBackupConversas() {
    try {
        const resposta = await fetch('/api/conversas/exportar');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const texto = await resposta.text();
        let total = 0;
        try {
            const dados = JSON.parse(texto);
            total = Array.isArray(dados.mensagens) ? dados.mensagens.length : 0;
        } catch (erro) { total = 0; }

        const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
        const blob = new Blob([texto], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'conversas-' + carimbo + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);

        toast('Backup baixado: ' + total + ' mensagem(ns).');
    } catch (erro) {
        console.error('Erro ao baixar o backup:', erro);
        toast('Não foi possível gerar o backup das conversas.', 'erro');
    }
}

async function limparConversasDoPainel() {
    let resumo = null;
    try {
        const resposta = await fetch('/api/conversas/status');
        if (resposta.ok) resumo = await resposta.json();
    } catch (erro) { resumo = null; }

    const total = resumo && Number(resumo.mensagens) ? Number(resumo.mensagens) : 0;

    if (resumo && total === 0 && Number(resumo.eventosMensagem || 0) === 0) {
        toast('Não há conversas para limpar.');
        return;
    }

    const aviso = 'Isso vai apagar o histórico de TODAS as conversas'
        + (total ? ' (' + total + ' mensagem(ns))' : '')
        + '.\n\nOs textos de mensagens da Atividade Wati também serão apagados.'
        + '\nClientes, fichas, campanhas e auditoria serão mantidos.\n\nDeseja continuar?';

    if (!confirm(aviso)) return;

    const digitado = prompt('Digite LIMPAR (em maiúsculas) para confirmar a exclusão do histórico:');
    if (String(digitado || '').trim().toUpperCase() !== 'LIMPAR') {
        toast('Limpeza cancelada.');
        return;
    }

    try {
        const resposta = await fetch('/api/conversas/limpar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmar: 'LIMPAR', incluirEventosWati: true })
        });

        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível limpar as conversas.', 'erro');
            return;
        }

        toast('Histórico limpo: ' + (dados.mensagensRemovidas || 0) + ' mensagem(ns) removida(s).');
        clienteAtivo = null;
        fichaTelefone = null;
        fecharFicha();
        limparChat();
        carregarConversas();
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao limpar conversas:', erro);
        toast('Erro de conexão ao limpar as conversas.', 'erro');
    }
}

/* Reset completo dos dados de teste: clientes (com fichas), conversas e listas. */
async function limparDadosDoPainel() {
    let resumo = null;
    try {
        const resposta = await fetch('/api/dados/status');
        if (resposta.ok) resumo = await resposta.json();
    } catch (erro) { resumo = null; }

    const clientes = resumo ? Number(resumo.clientes || 0) : 0;
    const mensagens = resumo ? Number(resumo.mensagens || 0) : 0;
    const listas = resumo ? Number(resumo.listas || 0) : 0;

    if (resumo && clientes === 0 && mensagens === 0 && listas === 0) {
        toast('Não há clientes, conversas ou listas para limpar.');
        return;
    }

    const aviso = 'Isso vai apagar DEFINITIVAMENTE:\n'
        + '• ' + clientes + ' cliente(s), com as fichas de atendimento\n'
        + '• ' + mensagens + ' mensagem(ns) e as prévias das conversas\n'
        + '• ' + listas + ' lista(s) importada(s)\n'
        + '• os textos de mensagens da Atividade Wati\n\n'
        + 'Campanhas, usuários, canais e auditoria serão mantidos.\n\n'
        + 'Deseja continuar?';

    if (!confirm(aviso)) return;

    const digitado = prompt('Digite LIMPAR TUDO (em maiúsculas) para confirmar:');
    if (String(digitado || '').trim().toUpperCase() !== 'LIMPAR TUDO') {
        toast('Limpeza cancelada.');
        return;
    }

    try {
        const resposta = await fetch('/api/dados/limpar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmar: 'LIMPAR TUDO', incluirEventosWati: true })
        });

        const dados = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível limpar os dados.', 'erro');
            return;
        }

        toast('Dados limpos: ' + (dados.clientesRemovidos || 0) + ' cliente(s), '
            + (dados.mensagensRemovidas || 0) + ' mensagem(ns) e '
            + (dados.listasRemovidas || 0) + ' lista(s).');

        clienteAtivo = null;
        fichaTelefone = null;
        clientesCache = [];
        fecharFicha();
        limparChat();
        carregarConversas();
        carregarDashboard();
        if (typeof carregarTabelaClientes === 'function') carregarTabelaClientes();
        if (typeof carregarListas === 'function') carregarListas();
        if (typeof carregarCampanhas === 'function') carregarCampanhas();
    } catch (erro) {
        console.error('Erro ao limpar os dados:', erro);
        toast('Erro de conexão ao limpar os dados.', 'erro');
    }
}

/* ---------------------------------------------------------
   DASHBOARD (cards + desempenho da equipe)
   --------------------------------------------------------- */
async function carregarDashboard() {
    try {
        const resposta = await fetch('/api/dashboard');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
        const dados = await resposta.json();

        const vendidos = $('admin-vendidos');
        if (vendidos) vendidos.textContent = (dados.vendido || 0) + ' Vendidos';

        const pensando = $('admin-pensando');
        if (pensando) pensando.textContent = (dados.pensando || 0) + ' Pensando';

        const naoQuis = $('admin-nao-quis');
        if (naoQuis) naoQuis.textContent = (dados['nao-quis'] || 0) + ' Não Quis';

        const conversas = $('total-conversas');
        if (conversas) conversas.textContent = (dados.conversasAtivas || 0) + ' conversa(s) ativa(s)';

        const totalClientes = $('total-clientes');
        if (totalClientes) totalClientes.textContent = (dados.clientes || 0) + ' cliente(s)';

        const totalListas = $('total-listas');
        if (totalListas) totalListas.textContent = (dados.listas || 0) + ' lista(s) · importar .txt';

        const totalMensagens = $('total-mensagens');
        if (totalMensagens) totalMensagens.textContent = 'Mensagens hoje: ' + (dados.mensagensHoje || 0);

        const totalCampanhas = $('total-campanhas');
        if (totalCampanhas) totalCampanhas.textContent = (dados.campanhasAtivas || 0) + ' em andamento';

        const totalEventosWati = $('total-eventos-wati');
        if (totalEventosWati) totalEventosWati.textContent = (dados.eventosWatiHoje || 0) + ' evento(s) hoje';
    } catch (erro) {
        console.error('Erro ao carregar o painel:', erro);
    }
}

/* ---------------------------------------------------------
   CONVERSAS
   --------------------------------------------------------- */
function filtrarConversas(status, botao) {
    filtroStatus = status;
    document.querySelectorAll('.filtros button').forEach((el) => el.classList.remove('active'));
    if (botao) botao.classList.add('active');
    carregarConversas(true);
}

async function carregarConversas(manterSelecao) {
    const lista = $('contact-list');
    if (!lista) return;

    try {
        const parametros = new URLSearchParams({
            status: filtroStatus,
            busca: buscaAtual,
            limite: 50
        });

        const resposta = await fetch('/api/clientes?' + parametros.toString());
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        clientesCache = await resposta.json();
        lista.innerHTML = '';

        if (!clientesCache.length) {
            lista.innerHTML = '<p class="vazio">Nenhum contato encontrado.</p>';
            return;
        }

        clientesCache.forEach((cliente) => {
            const item = document.createElement('div');
            const estaAtivo = clienteAtivo && clienteAtivo.telefone === cliente.telefone;
            item.className = 'contact-item' + (estaAtivo ? ' active' : '');
            item.dataset.telefone = cliente.telefone;
            item.onclick = () => abrirConversa(cliente.telefone);
            item.innerHTML = `
                <div class="avatar">${escaparHtml(iniciais(cliente.nome))}</div>
                <div class="contact-info">
                    <h4>${escaparHtml(cliente.nome || 'Sem nome')}</h4>
                    <p>${escaparHtml(cliente.mensagem || 'Sem mensagem')}</p>
                    <small class="contact-owner">👤 ${escaparHtml(cliente.vendedor_nome || cliente.vendedor_email || 'Sem vendedor')}</small>
                </div>
                <div class="contact-meta">
                    <span class="mini-badge ${STATUS_CLASSE[cliente.status] || ''}">${escaparHtml(STATUS_LABEL[cliente.status] || cliente.status || '-')}</span>
                </div>
            `;
            lista.appendChild(item);
        });

        if (manterSelecao && clienteAtivo) {
            const aindaExiste = clientesCache.some((c) => c.telefone === clienteAtivo.telefone);
            if (aindaExiste) return;
        }

        if (clientesCache.length) abrirConversa(clientesCache[0].telefone);
        else limparChat();
    } catch (erro) {
        console.error('Erro ao carregar contatos:', erro);
        lista.innerHTML = '<p class="vazio">Erro ao buscar contatos no servidor.</p>';
    }
}

function limparChat() {
    clienteAtivo = null;
    const nome = $('chat-name');
    if (nome) nome.textContent = 'Nenhuma conversa';
    const status = $('chat-status');
    if (status) status.textContent = 'Selecione um contato';
    const avatar = $('chat-avatar');
    if (avatar) avatar.textContent = '?';
    const area = $('messages');
    if (area) area.innerHTML = '<p class="vazio">Nenhuma mensagem por aqui.</p>';
}

async function abrirConversa(telefone) {
    const encontrado = clientesCache.find((c) => c.telefone === telefone);
    const cliente = encontrado || { telefone, nome: 'Contato', status: 'pensando' };

    clienteAtivo = { telefone: cliente.telefone, nome: cliente.nome, status: cliente.status };

    document.querySelectorAll('.contact-item').forEach((el) => {
        el.classList.toggle('active', el.dataset.telefone === telefone);
    });

    const nome = $('chat-name');
    if (nome) nome.textContent = cliente.nome || 'Contato';
    const status = $('chat-status');
    if (status) status.textContent = formatarTelefone(telefone);
    const avatar = $('chat-avatar');
    if (avatar) avatar.textContent = iniciais(cliente.nome);

    await carregarMensagens(telefone);
}

async function carregarMensagens(telefone) {
    const area = $('messages');
    if (!area) return;

    try {
        const resposta = await fetch('/api/clientes/' + encodeURIComponent(telefone) + '/mensagens');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const mensagens = await resposta.json();
        area.innerHTML = '';

        if (!mensagens.length) {
            area.innerHTML = '<p class="vazio">Nenhuma mensagem registrada ainda.</p>';
            return;
        }

        mensagens.forEach((msg) => {
            const bolha = document.createElement('div');
            bolha.className = 'message ' + (msg.direcao === 'enviada' ? 'sent' : 'received');
            const legenda = [rotuloAutor(msg), formatarData(msg.criado_em)].filter(Boolean).join(' · ');
            bolha.innerHTML = '<p>' + escaparHtml(msg.texto) + '</p><span>' + escaparHtml(legenda) + '</span>';
            area.appendChild(bolha);
        });

        area.scrollTop = area.scrollHeight;
    } catch (erro) {
        console.error('Erro ao carregar mensagens:', erro);
        area.innerHTML = '<p class="vazio">Erro ao carregar o histórico.</p>';
    }
}

function adicionarMensagemNaTela(direcao, texto, autor) {
    const area = $('messages');
    if (!area) return;

    const vazio = area.querySelector('.vazio');
    if (vazio) vazio.remove();

    const bolha = document.createElement('div');
    bolha.className = 'message ' + (direcao === 'enviada' ? 'sent' : 'received');
    const legenda = [autor || '', formatarData(new Date().toISOString())].filter(Boolean).join(' · ');
    bolha.innerHTML = '<p>' + escaparHtml(texto) + '</p><span>' + escaparHtml(legenda) + '</span>';
    area.appendChild(bolha);
    area.scrollTop = area.scrollHeight;
}

async function enviarMensagem() {
    const input = $('message');
    if (!clienteAtivo) { toast('Selecione um contato primeiro.', 'erro'); return; }
    if (!input) return;

    const texto = input.value.trim();
    if (!texto) return;

    const botao = document.querySelector('.input-area button');
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/enviar-mensagem', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefone: clienteAtivo.telefone, mensagem: texto })
        });

        const dados = await resposta.json().catch(() => ({}));

        if (resposta.ok && dados.success) {
            input.value = '';
            adicionarMensagemNaTela('enviada', texto, 'Você');
        } else {
            toast(dados.message || 'A Wati recusou o envio.', 'erro');
        }
    } catch (erro) {
        console.error('Erro ao enviar mensagem:', erro);
        toast('Erro de conexão ao enviar a mensagem.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
        input.focus();
    }
}

const sendMessage = enviarMensagem;

async function mudarStatus(status) {
    if (!fichaTelefone) { toast('Abra a ficha de um cliente primeiro.', 'erro'); return; }

    document.querySelectorAll('.status-btn').forEach((botao) => {
        botao.classList.toggle('active', botao.dataset.status === status);
    });

    try {
        const resposta = await fetch('/api/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefone: fichaTelefone, status })
        });

        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        if (clienteAtivo && clienteAtivo.telefone === fichaTelefone) clienteAtivo.status = status;
        toast('Status atualizado para ' + (STATUS_LABEL[status] || status) + '.');
        carregarConversas(true);
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao mudar status:', erro);
        toast('Não foi possível salvar o status.', 'erro');
    }
}

async function finalizarAtendimento() {
    const telefone = clienteAtivo ? clienteAtivo.telefone : fichaTelefone;
    if (!telefone) { toast('Selecione um contato primeiro.', 'erro'); return; }
    if (!confirm('Finalizar o atendimento deste cliente?')) return;

    try {
        const resposta = await fetch('/api/finalizar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefone })
        });

        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        toast('Atendimento finalizado.');
        fecharFicha();
        carregarConversas();
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao finalizar:', erro);
        toast('Não foi possível finalizar o atendimento.', 'erro');
    }
}

/* ---------------------------------------------------------
   CLIENTES (tabela) E PESQUISA
   --------------------------------------------------------- */
function pesquisarClientes(valor) {
    buscaAtual = (valor || '').trim();
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => {
        carregarConversas(true);
        const viewClientes = $('view-clientes');
        if (viewClientes && !viewClientes.classList.contains('oculto')) carregarTabelaClientes();
    }, 350);
}

async function carregarTabelaClientes() {
    const corpo = $('tabela-clientes');
    if (!corpo) return;

    try {
        const parametros = new URLSearchParams({ status: 'todos', busca: buscaAtual, limite: 200 });
        const resposta = await fetch('/api/clientes?' + parametros.toString());
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const clientes = await resposta.json();
        corpo.innerHTML = '';

        if (!clientes.length) {
            corpo.innerHTML = '<tr><td colspan="7" class="vazio">Nenhum cliente encontrado.</td></tr>';
            return;
        }

        clientes.forEach((cliente) => {
            const linha = document.createElement('tr');
            linha.innerHTML = `
                <td>${escaparHtml(cliente.nome || '-')}</td>
                <td>${escaparHtml(formatarTelefone(cliente.telefone))}</td>
                <td>${escaparHtml(cliente.mensagem || '-')}</td>
                <td><span class="mini-badge ${STATUS_CLASSE[cliente.status] || ''}">${escaparHtml(STATUS_LABEL[cliente.status] || cliente.status || '-')}</span></td>
                <td>${escaparHtml(cliente.vendedor_nome || '—')}</td>
                <td>${escaparHtml(formatarData(cliente.criado_em))}</td>
                <td>
                    <div class="actions-cell">
                        <button class="btn-mini" data-acao="ficha">📋 Ficha</button>
                        <button class="btn-mini" data-acao="conversa">💬 Conversa</button>
                    </div>
                </td>
            `;

            const botoes = linha.querySelectorAll('button');
            botoes[0].onclick = () => abrirFicha(cliente.telefone);
            botoes[1].onclick = () => {
                irPara('conversas');
                abrirConversa(cliente.telefone);
            };

            corpo.appendChild(linha);
        });
    } catch (erro) {
        console.error('Erro ao carregar clientes:', erro);
        corpo.innerHTML = '<tr><td colspan="6" class="vazio">Erro ao buscar clientes no servidor.</td></tr>';
    }
}

/* FIM PARTE 6 */

/* =========================================================
   PARTE 7 - FICHA DO CLIENTE
   ========================================================= */

function preencherCampo(id, valor) {
    const campo = $(id);
    if (campo) campo.value = valor === null || valor === undefined ? '' : String(valor);
}

function marcarStatusAtivo(status) {
    document.querySelectorAll('.status-btn').forEach((botao) => {
        botao.classList.toggle('active', !!status && botao.dataset.status === status);
    });
}

function abrirFicha(telefone) {
    const alvo = telefone || (clienteAtivo && clienteAtivo.telefone) || fichaTelefone;
    if (!alvo) { toast('Selecione um contato primeiro.', 'erro'); return; }

    fichaTelefone = alvo;

    const overlay = $('ficha-overlay');
    if (overlay) overlay.classList.remove('oculto');

    const empresa = $('ficha-empresa');
    if (empresa) {
        const nomeConhecido = clienteAtivo && clienteAtivo.telefone === alvo ? clienteAtivo.nome : '';
        empresa.textContent = nomeConhecido || formatarTelefone(alvo);
    }

    const telefoneEl = $('ficha-telefone');
    if (telefoneEl) telefoneEl.textContent = formatarTelefone(alvo);

    ['ficha-cnpj', 'ficha-socio', 'ficha-cpf', 'ficha-responsavel', 'ficha-outros'].forEach((id) => preencherCampo(id, ''));
    const listaAtributos = $('ficha-atributos');
    if (listaAtributos) listaAtributos.innerHTML = '<li><span>Carregando...</span></li>';
    marcarStatusAtivo(null);

    carregarFicha(alvo);
}

async function carregarFicha(telefone) {
    try {
        const resposta = await fetch('/api/clientes/' + encodeURIComponent(telefone) + '/ficha');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const ficha = await resposta.json();
        if (fichaTelefone !== telefone) return;

        const empresa = $('ficha-empresa');
        if (empresa && ficha.nome) empresa.textContent = ficha.nome;

        const telefoneEl = $('ficha-telefone');
        if (telefoneEl) telefoneEl.textContent = formatarTelefone(ficha.telefone || telefone);

        preencherCampo('ficha-cnpj', ficha.cnpj);
        preencherCampo('ficha-socio', ficha.socio);
        preencherCampo('ficha-cpf', ficha.cpf);
        preencherCampo('ficha-responsavel', ficha.responsavel);

        const vendedor = $('ficha-vendedor');
        if (vendedor) {
            vendedor.textContent = ficha.vendedor_nome || ficha.vendedor_email || 'Sem vendedor';
        }

        const outros = Array.isArray(ficha.outros_socios) ? ficha.outros_socios : [];
        const linhas = outros.map((item) => {
            if (item && typeof item === 'object') return [item.nome, item.cpf].filter(Boolean).join(' - ');
            return String(item || '');
        }).filter(Boolean);

        const textarea = $('ficha-outros');
        if (textarea) textarea.value = linhas.join('\n');

        const listaAtributos = $('ficha-atributos');
        if (listaAtributos) {
            const atributos = (ficha.atributos && typeof ficha.atributos === 'object') ? ficha.atributos : {};
            const itens = Object.keys(atributos)
                .filter((chave) => atributos[chave])
                .map((chave) => '<li><span>' + escaparHtml(chave) + '</span><strong>' + escaparHtml(atributos[chave]) + '</strong></li>');

            listaAtributos.innerHTML = itens.length ? itens.join('') : '<li><span>Nenhum atributo importado</span></li>';
        }

        marcarStatusAtivo(ficha.status);
    } catch (erro) {
        console.error('Erro ao carregar ficha:', erro);
        toast('Não foi possível carregar a ficha do cliente.', 'erro');
    }
}

function fecharFicha() {
    const overlay = $('ficha-overlay');
    if (overlay) overlay.classList.add('oculto');
}

async function salvarFicha() {
    if (!fichaTelefone) { toast('Abra a ficha de um cliente primeiro.', 'erro'); return; }

    const campoOutros = $('ficha-outros');
    const outros = (campoOutros ? campoOutros.value : '')
        .split(/\r?\n/)
        .map((linha) => linha.trim())
        .filter(Boolean);

    const dados = {
        cnpj: (($('ficha-cnpj') || {}).value || '').trim(),
        socio: (($('ficha-socio') || {}).value || '').trim(),
        cpf: (($('ficha-cpf') || {}).value || '').trim(),
        responsavel: (($('ficha-responsavel') || {}).value || '').trim(),
        outros_socios: outros
    };

    try {
        const resposta = await fetch('/api/clientes/' + encodeURIComponent(fichaTelefone) + '/ficha', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dados)
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || retorno.success === false) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        toast('Ficha salva com sucesso.');
    } catch (erro) {
        console.error('Erro ao salvar ficha:', erro);
        toast('Não foi possível salvar a ficha.', 'erro');
    }
}

async function copiarFicha() {
    if (!fichaTelefone) { toast('Abra a ficha de um cliente primeiro.', 'erro'); return; }

    const valor = (id) => (($(id) || {}).value || '').trim();
    const textoEl = (id) => (($(id) || {}).textContent || '').trim();

    const linhas = [
        'FICHA - QGC TEAM by JV',
        'Empresa: ' + (textoEl('ficha-empresa') || '-'),
        'CNPJ: ' + (valor('ficha-cnpj') || '-'),
        'Sócio Mestre: ' + (valor('ficha-socio') || '-'),
        'CPF: ' + (valor('ficha-cpf') || '-'),
        'Telefone: ' + (textoEl('ficha-telefone') || formatarTelefone(fichaTelefone)),
        'Responsável: ' + (valor('ficha-responsavel') || '-')
    ];

    const outros = valor('ficha-outros');
    if (outros) {
        linhas.push('Outros sócios:');
        outros.split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean).forEach((linha) => linhas.push('- ' + linha));
    }

    const texto = linhas.join('\n');

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(texto);
        } else {
            const area = document.createElement('textarea');
            area.value = texto;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        toast('Ficha copiada para a área de transferência.');
    } catch (erro) {
        console.error('Erro ao copiar ficha:', erro);
        toast('Não foi possível copiar a ficha.', 'erro');
    }
}


/* =========================================================
   PARTE 8 - LISTAS (importar .txt / colar contatos)
   ========================================================= */

/* Campos que o mapa de colunas oferece (o mesmo nome vira atributo na Wati) */
const CAMPOS_LISTA = [
    { chave: 'telefone', rotulo: 'Telefone (obrigatório)' },
    { chave: 'nome', rotulo: 'Nome' },
    { chave: 'cnpj', rotulo: 'CNPJ → cnpj' },
    { chave: 'cpf', rotulo: 'CPF → cpf' },
    { chave: 'razao_social', rotulo: 'Razão social → razao_social' },
    { chave: 'ag_conta', rotulo: 'Agência / Conta → ag_conta' },
    { chave: 'socio', rotulo: 'Sócio → socio' },
    { chave: 'responsavel', rotulo: 'Responsável → responsavel' },
    { chave: 'nome_fantasia', rotulo: 'Nome fantasia → nome_fantasia' },
    { chave: 'situacao', rotulo: 'Situação → situacao' },
    { chave: 'porte', rotulo: 'Porte → porte' },
    { chave: 'capital_social', rotulo: 'Capital social → capital_social' },
    { chave: 'inicio_atividade', rotulo: 'Início atividade → inicio_atividade' },
    { chave: 'logradouro', rotulo: 'Logradouro → logradouro' },
    { chave: 'bairro', rotulo: 'Bairro → bairro' },
    { chave: 'cidade', rotulo: 'Cidade → cidade' },
    { chave: 'uf', rotulo: 'UF → uf' },
    { chave: 'cep', rotulo: 'CEP → cep' },
    { chave: 'tel_empresa_1', rotulo: 'Tel. empresa 1 → tel_empresa_1' },
    { chave: 'tel_empresa_2', rotulo: 'Tel. empresa 2 → tel_empresa_2' },
    { chave: 'email_empresa', rotulo: 'E-mail empresa → email_empresa' },
    { chave: 'nascimento', rotulo: 'Nascimento → nascimento' },
    { chave: 'nome_mae', rotulo: 'Nome da mãe → nome_mae' },
    { chave: 'sexo', rotulo: 'Sexo → sexo' },
    { chave: 'email', rotulo: 'E-mail → email' },
    { chave: 'endereco', rotulo: 'Endereço → endereco' },
    { chave: 'socios', rotulo: 'Sócios → socios' }
];

/* Colunas do cadastro da empresa que já têm nome de atributo pronto. */
const DESTINOS_CADASTRO = [
    'razao_social', 'nome_fantasia', 'situacao', 'porte', 'capital_social',
    'inicio_atividade', 'logradouro', 'bairro', 'cidade', 'uf', 'cep',
    'tel_empresa_1', 'tel_empresa_2', 'email_empresa', 'cpf', 'nascimento',
    'nome_mae', 'sexo', 'email', 'endereco', 'socios'
];

const MAPA_MEMORIA_CHAVE = 'qgc-mapa-lista';

let tabelaLista = null; // { colunas: [], linhas: [[...]], mapa: [], custom: [] }

/* "Razão Social" -> "razao_social" (mesmo padrão de atributo da Wati) */
function normalizarChave(texto) {
    return String(texto || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 40);
}

/* Variável do template a partir do cabeçalho da coluna:
   "{{1}}" -> "1" · "{{nome}}" -> "nome" · "var1"/"variavel_1" -> "1".
   É o que liga a coluna da planilha ao {{n}} usado na campanha. */
function chaveVariavelColuna(coluna) {
    const bruto = String(coluna || '').trim();
    if (!bruto) return '';

    let achado = bruto.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (achado) return normalizarChave(achado[1]);

    achado = bruto.match(/^var(?:iavel)?[\s_-]*([a-zA-Z0-9_]+)$/i);
    if (achado) return normalizarChave(achado[1]);

    return '';
}

function separadorDoCsv(linha) {
    const candidatos = [';', ',', '\t'];
    let escolhido = ';';
    let maior = 0;

    candidatos.forEach((separador) => {
        const total = String(linha).split(separador).length - 1;
        if (total > maior) { maior = total; escolhido = separador; }
    });

    return escolhido;
}

/* Divide uma linha respeitando aspas ("Silva; Filho"). */
function dividirLinhaCsv(linha, separador) {
    const celulas = [];
    let atual = '';
    let dentroAspas = false;

    for (let i = 0; i < linha.length; i++) {
        const caractere = linha[i];

        if (caractere === '"') {
            if (dentroAspas && linha[i + 1] === '"') { atual += '"'; i++; }
            else dentroAspas = !dentroAspas;
            continue;
        }

        if (caractere === separador && !dentroAspas) {
            celulas.push(atual);
            atual = '';
            continue;
        }

        atual += caractere;
    }

    celulas.push(atual);
    return celulas.map((celula) => celula.trim());
}

function lerTabelaCsv(texto) {
    const linhas = String(texto || '')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .map((linha) => linha.trim())
        .filter((linha) => linha.replace(/[;,\t\s]/g, '').length);

    if (!linhas.length) return null;

    const separador = separadorDoCsv(linhas[0]);
    const celulas = linhas.map((linha) => dividirLinhaCsv(linha, separador));
    const primeira = celulas[0];

    // Cabeçalho = primeira linha sem nenhum telefone.
    const temCabecalho = !primeira.some((celula) => apenasNumeros(celula).length >= 10);
    const colunas = primeira.map((celula, indice) => (temCabecalho && celula) ? celula : ('Coluna ' + (indice + 1)));
    const dados = temCabecalho ? celulas.slice(1) : celulas;

    return { colunas, linhas: dados.filter((linha) => linha.some((celula) => celula)) };
}

function lerMapaMemoria() {
    try {
        const bruto = window.localStorage.getItem(MAPA_MEMORIA_CHAVE);
        return bruto ? (JSON.parse(bruto) || {}) : {};
    } catch (erro) {
        return {};
    }
}

function gravarMapaMemoria() {
    if (!tabelaLista) return;

    try {
        const memoria = lerMapaMemoria();
        tabelaLista.colunas.forEach((coluna, indice) => {
            const chave = normalizarChave(coluna);
            const destino = tabelaLista.mapa[indice];
            if (chave && destino && destino !== 'custom' && destino !== 'variavel') memoria[chave] = destino;
        });
        window.localStorage.setItem(MAPA_MEMORIA_CHAVE, JSON.stringify(memoria));
    } catch (erro) { /* localStorage indisponível */ }
}

/* Adivinha o destino da coluna pelo nome e, quando não há nome, pelo conteúdo. */
function adivinharDestino(coluna, indice, linhas) {
    const chave = normalizarChave(coluna);

    if (chave) {
        if (DESTINOS_CADASTRO.indexOf(chave) >= 0) return chave;
        if (/cnpj/.test(chave)) return 'cnpj';
        if (/cpf/.test(chave)) return 'cpf';
        if (/(razao|social|empresa|fantasia|company)/.test(chave)) return 'razao_social';
        if (/(agencia|ag_conta|conta|banco)/.test(chave)) return 'ag_conta';
        if (/(socio|socios)/.test(chave)) return 'socio';
        if (/(responsavel|vendedor)/.test(chave)) return 'responsavel';
        if (/(telefone|phone|whats|celular|fone|numero|number)/.test(chave)) return 'telefone';
        if (/(nome|name|contato|cliente)/.test(chave)) return 'nome';
    }

    const amostras = linhas.slice(0, 6)
        .map((linha) => String(linha[indice] || '').trim())
        .filter(Boolean);

    if (!amostras.length) return '';

    const digitos = amostras.map((amostra) => apenasNumeros(amostra));
    if (digitos.every((numero) => numero.length >= 10 && numero.length <= 13)) return 'telefone';

    return '';
}

function analisarLista() {
    const campo = $('lista-texto');
    const tabela = lerTabelaCsv(campo ? campo.value : '');

    if (!tabela || !tabela.linhas.length) {
        toast('Cole os contatos ou envie o arquivo antes de analisar.', 'erro');
        return;
    }

    const memoria = lerMapaMemoria();
    tabela.variaveis = tabela.colunas.map((coluna) => chaveVariavelColuna(coluna));

    tabela.mapa = tabela.colunas.map((coluna, indice) => {
        // Cabeçalho {{1}}/{{2}} já define a variável: não precisa mapear à mão.
        if (tabela.variaveis[indice]) return 'variavel';

        const lembrado = memoria[normalizarChave(coluna)];
        // "custom" depende do nome digitado na hora, então não reaproveita.
        return (lembrado && lembrado !== 'custom') ? lembrado : adivinharDestino(coluna, indice, tabela.linhas);
    });
    tabela.custom = tabela.colunas.map(() => '');

    // Se ninguém ficou como telefone, pega a coluna que só tem números de telefone.
    if (!tabela.mapa.includes('telefone')) {
        const indice = tabela.colunas.findIndex((coluna, posicao) => {
            const amostras = tabela.linhas.slice(0, 6).map((linha) => apenasNumeros(linha[posicao]));
            return amostras.length && amostras.every((numero) => numero.length >= 10 && numero.length <= 13);
        });

        if (indice >= 0) tabela.mapa[indice] = 'telefone';
    }

    // Sem coluna de nome: a primeira coluna de texto que sobrou vira o nome
    // (cobre listas antigas no formato "telefone;nome" e cabeçalhos desconhecidos).
    if (!tabela.mapa.includes('nome')) {
        const indice = tabela.colunas.findIndex((coluna, posicao) => {
            if (tabela.mapa[posicao]) return false;

            const amostras = tabela.linhas.slice(0, 6)
                .map((linha) => String(linha[posicao] || '').trim())
                .filter(Boolean);

            return amostras.length > 0 && amostras.every((valor) =>
                /[a-zA-ZÀ-ÿ]/.test(valor) && apenasNumeros(valor).length < 10
            );
        });

        if (indice >= 0) tabela.mapa[indice] = 'nome';
    }

    tabelaLista = tabela;
    renderizarMapaLista();

    const painel = $('lista-mapeamento');
    if (painel) painel.classList.remove('oculto');

    const progresso = $('lista-progresso');
    if (progresso) progresso.textContent = '';
}

function lerArquivoLista(input) {
    const arquivo = input && input.files && input.files[0];
    if (!arquivo) return;

    const leitor = new FileReader();

    leitor.onload = () => {
        const campo = $('lista-texto');
        if (!campo) return;

        campo.value = String(leitor.result || '').trim();
        toast('Arquivo carregado: ' + arquivo.name);
        analisarLista();
    };

    leitor.onerror = () => toast('Não foi possível ler o arquivo.', 'erro');
    leitor.readAsText(arquivo, 'UTF-8');
}

/* Modelo pronto do formato: telefone + variáveis {{1}}, {{2}}...
   O BOM (\uFEFF) mantém os acentos corretos quando abre no Excel. */
function baixarModeloLista() {
    const conteudo = [
        'telefone;{{1}};{{2}}',
        '5511999999999;João da Silva;12.345.678/0001-90',
        ''
    ].join('\r\n');

    try {
        const blob = new Blob(['\uFEFF' + conteudo], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = 'modelo-lista-variaveis.csv';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        toast('Modelo .csv baixado. Preencha e importe aqui.');
    } catch (erro) {
        toast('Não foi possível gerar o modelo .csv.', 'erro');
    }
}

function renderizarMapaLista() {
    const caixa = $('lista-colunas');
    if (!caixa || !tabelaLista) return;

    caixa.innerHTML = '';

    tabelaLista.colunas.forEach((coluna, indice) => {
        const exemplos = tabelaLista.linhas.slice(0, 3)
            .map((linha) => String(linha[indice] || '').trim())
            .filter(Boolean);

        const linha = document.createElement('div');
        linha.className = 'mapa-linha';

        const info = document.createElement('div');
        info.className = 'mapa-coluna';
        info.innerHTML = '<strong>' + escaparHtml(coluna) + '</strong>' +
            '<small>' + escaparHtml(exemplos.join(' · ') || 'sem exemplo') + '</small>';

        const seletor = document.createElement('select');
        seletor.className = 'form-control mapa-select';
        seletor.innerHTML = '<option value="">Ignorar coluna</option>' +
            CAMPOS_LISTA.map((campo) => `<option value="${campo.chave}">${escaparHtml(campo.rotulo)}</option>`).join('') +
            '<option value="variavel">Variável do template…</option>' +
            '<option value="custom">Atributo personalizado…</option>';
        seletor.value = tabelaLista.mapa[indice] || '';

        const personalizado = document.createElement('input');
        personalizado.className = 'form-control mapa-custom';
        personalizado.type = 'text';
        personalizado.placeholder = 'nome do atributo (ex.: ag_conta)';
        personalizado.value = tabelaLista.custom[indice] || '';
        personalizado.classList.toggle('oculto', seletor.value !== 'custom');

        const variavel = document.createElement('input');
        variavel.className = 'form-control mapa-custom mapa-variavel';
        variavel.type = 'text';
        variavel.placeholder = 'variável do template (ex.: 1)';
        variavel.value = (tabelaLista.variaveis && tabelaLista.variaveis[indice]) || '';
        variavel.classList.toggle('oculto', seletor.value !== 'variavel');

        seletor.onchange = () => {
            tabelaLista.mapa[indice] = seletor.value;
            personalizado.classList.toggle('oculto', seletor.value !== 'custom');
            variavel.classList.toggle('oculto', seletor.value !== 'variavel');

            if (seletor.value === 'custom' && !personalizado.value) {
                personalizado.value = normalizarChave(coluna);
                tabelaLista.custom[indice] = personalizado.value;
            }

            if (seletor.value === 'variavel' && !variavel.value) {
                variavel.value = chaveVariavelColuna(coluna);
                tabelaLista.variaveis[indice] = variavel.value;
            }

            atualizarResumoLista();
        };

        personalizado.oninput = () => {
            tabelaLista.custom[indice] = personalizado.value;
            atualizarResumoLista();
        };

        variavel.oninput = () => {
            tabelaLista.variaveis = tabelaLista.variaveis || [];
            tabelaLista.variaveis[indice] = variavel.value;
            atualizarResumoLista();
        };

        linha.appendChild(info);
        linha.appendChild(seletor);
        linha.appendChild(personalizado);
        linha.appendChild(variavel);
        caixa.appendChild(linha);
    });

    atualizarResumoLista();
}

function montarContatosDaLista() {
    if (!tabelaLista) return [];

    const vistos = new Set();
    const contatos = [];

    tabelaLista.linhas.forEach((linha) => {
        const contato = { telefone: '', nome: '', atributos: {}, variaveis: {} };

        tabelaLista.colunas.forEach((coluna, indice) => {
            const destino = tabelaLista.mapa[indice];
            const valor = String(linha[indice] || '').trim();
            if (!destino || !valor) return;

            if (destino === 'telefone') contato.telefone = apenasNumeros(valor);
            else if (destino === 'nome') contato.nome = valor;
            else if (destino === 'variavel') {
                // Guarda no formato { "1": "João", "2": "..." } — o mesmo
                // {{1}}/{{2}} do template, sem virar atributo da Wati.
                const informada = (tabelaLista.variaveis && tabelaLista.variaveis[indice]) || '';
                const variavel = normalizarChave(informada || chaveVariavelColuna(coluna));
                if (!variavel) return;

                contato.variaveis[variavel] = valor;
                if (variavel === 'nome' && !contato.nome) contato.nome = valor;
            } else if (destino === 'custom') {
                const atributo = normalizarChave(tabelaLista.custom[indice]);
                if (atributo) contato.atributos[atributo] = valor;
            } else {
                contato.atributos[destino] = valor;
            }
        });

        if (contato.telefone.length < 10 || vistos.has(contato.telefone)) return;
        vistos.add(contato.telefone);
        contatos.push(contato);
    });

    return contatos;
}

function atualizarResumoLista() {
    const resumo = $('lista-resumo');
    if (!resumo) return;

    const contatos = montarContatosDaLista();
    const atributos = new Set();
    const variaveis = new Set();

    contatos.forEach((contato) => {
        Object.keys(contato.atributos).forEach((nome) => atributos.add(nome));
        Object.keys(contato.variaveis || {}).forEach((nome) => variaveis.add(nome));
    });

    const listaAtributos = Array.from(atributos);
    const textoAtributos = listaAtributos.length
        ? ' · atributos: ' + listaAtributos.slice(0, 6).join(', ') + (listaAtributos.length > 6 ? '…' : '')
        : '';

    // Mostra {{1}}, {{2}}... com quantos contatos têm valor em cada variável.
    const listaVariaveis = Array.from(variaveis);
    const textoVariaveis = listaVariaveis.length
        ? ' · variáveis: ' + listaVariaveis.map((nome) => {
            const preenchidos = contatos.filter((contato) => contato.variaveis && contato.variaveis[nome]).length;
            return '{{' + nome + '}} (' + preenchidos + ')';
        }).join(', ')
        : '';

    resumo.innerHTML = '<strong>' + contatos.length + '</strong> contato(s) válido(s) de ' +
        (tabelaLista ? tabelaLista.linhas.length : 0) + ' linha(s)' + escaparHtml(textoAtributos + textoVariaveis) +
        (contatos.length ? '' : ' — escolha a coluna do telefone.');
}

/* Confere os telefones mapeados na API (/api/telefones/verificar) e troca a
   célula pelo número completo: 55 + DDD + número (com o 9º dígito quando é
   celular antigo). Inválidos ficam como estão e só entram na contagem. */
async function verificarNumerosLista() {
    if (!tabelaLista) { toast('Clique em "Analisar colunas" antes de verificar.', 'erro'); return; }

    const indice = tabelaLista.mapa.indexOf('telefone');
    if (indice < 0) { toast('Escolha a coluna do telefone antes de verificar.', 'erro'); return; }

    const telefones = tabelaLista.linhas.map((linha) => apenasNumeros(linha[indice]));
    if (!telefones.some(Boolean)) { toast('Nenhum telefone para verificar.', 'erro'); return; }

    const botao = document.querySelector('button[onclick="verificarNumerosLista()"]');
    if (botao) botao.disabled = true;

    const progresso = $('lista-progresso');
    if (progresso) progresso.textContent = 'Verificando ' + telefones.length + ' telefone(s)...';

    try {
        const resposta = await fetch('/api/telefones/verificar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ telefones })
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !retorno.success) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        let completados = 0;
        (retorno.resultados || []).forEach((item, posicao) => {
            if (!item.valido) return;
            if (item.status === 'completado') completados += 1;
            if (tabelaLista.linhas[posicao]) tabelaLista.linhas[posicao][indice] = item.wati;
        });

        const resumo = retorno.resumo || {};
        const validos = (resumo.total || 0) - (resumo.invalidos || 0);

        atualizarResumoLista();

        const partes = [
            'Números verificados: ' + validos + ' válido(s)',
            completados + ' completado(s) com 9º dígito/DDI',
            (resumo.invalidos || 0) + ' inválido(s)'
        ];

        if (progresso) progresso.textContent = partes.join(' · ') + '.';
        toast(partes.join(' · '), resumo.invalidos ? 'erro' : undefined);
    } catch (erro) {
        if (progresso) progresso.textContent = erro.message || 'Não foi possível verificar os números.';
        toast(erro.message || 'Não foi possível verificar os números.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

/* ---------------------------------------------------------
   CONSULTAR CPF (EXTRATOR)
   Envia CPFs ao extratorgov.online (via API do painel) e
   devolve nome + telefone(s) de cada um.
   --------------------------------------------------------- */
let extratorResultado = { resumo: null, resultados: [] };
let telefonesColetados = [];

/* Extrai CPFs (11 dígitos) de um texto colado, sem repetir. */
function cpfsDeTexto(texto) {
    const achados = String(texto || '')
        .replace(/﻿/g, '')
        .match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g) || [];

    const cpfs = [];
    const vistos = new Set();

    achados.forEach((achado) => {
        const digitos = apenasNumeros(achado);
        if (digitos.length !== 11 || vistos.has(digitos)) return;
        vistos.add(digitos);
        cpfs.push(digitos);
    });

    return cpfs;
}

function entradasCpfs() {
    const caixa = $('extrator-texto');
    if (!caixa) return [];
    return cpfsDeTexto(caixa.value);
}

function carregarArquivoCpfs(input) {
    const arquivo = input && input.files && input.files[0];
    const caixa = $('extrator-texto');
    const progresso = $('extrator-progresso');

    if (!arquivo) return;

    if (arquivo.size > 2 * 1024 * 1024) {
        toast('Arquivo muito grande (máximo 2 MB). Divida a lista em partes.', 'erro');
        if (input) input.value = '';
        return;
    }

    const leitor = new FileReader();

    leitor.onload = () => {
        const cpfs = cpfsDeTexto(leitor.result);

        if (!cpfs.length) {
            toast('Nenhum CPF encontrado em ' + arquivo.name + '.', 'erro');
            if (input) input.value = '';
            return;
        }

        const atuais = caixa
            ? String(caixa.value || '').split(/\r?\n/).map((linha) => linha.trim()).filter(Boolean)
            : [];

        const existentes = new Set(atuais.map((linha) => apenasNumeros(linha).slice(0, 11)));
        const novas = cpfs.filter((cpf) => !existentes.has(cpf));

        if (caixa) caixa.value = atuais.concat(novas).join('\n');

        const partes = [cpfs.length + ' CPF(s) lido(s) de ' + arquivo.name];
        if (novas.length < cpfs.length) partes.push((cpfs.length - novas.length) + ' já estava(m) na caixa');
        if (progresso) progresso.textContent = partes.join(' · ') + '. Clique em "Consultar CPFs".';
        toast(partes.join(' · ') + '.');
        if (input) input.value = '';
    };

    leitor.onerror = () => {
        toast('Não foi possível ler o arquivo.', 'erro');
        if (input) input.value = '';
    };

    leitor.readAsText(arquivo, 'UTF-8');
}

function formatarCpfPainel(cpf) {
    const digitos = apenasNumeros(cpf);
    if (digitos.length !== 11) return cpf;
    return digitos.slice(0, 3) + '.' + digitos.slice(3, 6) + '.' + digitos.slice(6, 9) + '-' + digitos.slice(9);
}

function cartaoValidacao(valor, rotulo, classe) {
    return '<div class="validar-card ' + (classe || '') + '"><strong>' + valor + '</strong><span>' + rotulo + '</span></div>';
}

function renderizarExtrator() {
    const resultados = extratorResultado.resultados || [];
    const resumo = extratorResultado.resumo || {};
    const caixa = $('extrator-resumo');
    const corpo = $('tabela-extrator');

    if (caixa) {
        caixa.innerHTML = [
            cartaoValidacao(resumo.comTelefone || 0, 'com telefone', 'ok'),
            cartaoValidacao(resumo.semRetorno || 0, 'sem retorno', 'invalido'),
            cartaoValidacao(resumo.total || 0, 'consultados', 'completado')
        ].join('');
    }

    if (!corpo) return;

    if (!resultados.length) {
        corpo.innerHTML = '<tr><td colspan="4" class="vazio">Nenhum CPF consultado.</td></tr>';
        return;
    }

    corpo.innerHTML = resultados.map((item) => {
        const rotulo = item.status === 'ok' ? 'com telefone' : 'sem retorno';
        const classe = item.status === 'ok' ? 'status-vendido' : 'status-nao-quis';

        const celulasTelefone = item.telefones && item.telefones.length
            ? item.telefones.map((telefone) =>
                '<span class="telefone-chip">' + escaparHtml(telefone.formatado || telefone.wati) +
                ' <button class="btn-mini" type="button" onclick="copiarTelefoneUnico(\'' + (telefone.wati || '') + '\')">📋</button></span>'
            ).join(' ')
            : (item.message ? '<small>' + escaparHtml(item.message) + '</small>' : '-');

        return '<tr>' +
            '<td>' + formatarCpfPainel(item.cpf) + '</td>' +
            '<td><span class="status-badge ' + classe + '">' + rotulo + '</span></td>' +
            '<td>' + escaparHtml(item.nome || '-') + '</td>' +
            '<td>' + celulasTelefone + '</td>' +
            '</tr>';
    }).join('');
}

async function copiarTelefoneUnico(wati) {
    if (!wati) return;

    try {
        await navigator.clipboard.writeText(wati);
        toast(wati + ' copiado.');
    } catch (falha) {
        toast('Não consegui copiar.', 'erro');
    }
}

async function consultarCpfsExtrator() {
    const cpfs = entradasCpfs();

    if (!cpfs.length) { toast('Cole pelo menos um CPF (11 dígitos) para consultar.', 'erro'); return; }
    if (cpfs.length > 25) { toast('Máximo de 25 CPFs por consulta (você colou ' + cpfs.length + ').', 'erro'); return; }

    const progresso = $('extrator-progresso');
    const status = $('extrator-status');
    const botao = document.querySelector('button[onclick="consultarCpfsExtrator()"]');

    if (botao) botao.disabled = true;
    if (status) status.textContent = '';
    if (progresso) progresso.textContent = 'Consultando ' + cpfs.length + ' CPF(s) no extrator... (~1 minuto por CPF)';

    /* Mostra o progresso real da fila (a consulta roda um CPF por vez). */
    const relogio = setInterval(async () => {
        try {
            const respostaStatus = await fetch('/api/extrator/status');
            const situacao = await respostaStatus.json().catch(() => ({}));

            if (situacao.progresso && situacao.progresso.total) {
                const passos = situacao.progresso;
                const texto = 'Consultando ' + passos.atual + '/' + passos.total + ' CPF(s)' +
                    (passos.cpf ? ' · atual: ' + formatarCpfPainel(passos.cpf) : '') +
                    ' · (~1 minuto por CPF)';
                if (progresso) progresso.textContent = texto;
            }
        } catch (erro) { /* sem status: segue */ }
    }, 5000);

    try {
        const resposta = await fetch('/api/extrator/consultar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cpfs })
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !retorno.success) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        extratorResultado = { resumo: retorno.resumo || {}, resultados: retorno.resultados || [] };
        renderizarExtrator();

        const resumo = extratorResultado.resumo;
        const partes = [
            (resumo.comTelefone || 0) + ' com telefone',
            (resumo.semRetorno || 0) + ' sem retorno'
        ];

        if (progresso) progresso.textContent = partes.join(' · ') + '.';
        toast(partes.join(' · '), resumo.semRetorno ? 'erro' : undefined);
    } catch (erro) {
        if (progresso) progresso.textContent = erro.message || 'Não foi possível consultar os CPFs.';
        toast(erro.message || 'Não foi possível consultar os CPFs.', 'erro');
    } finally {
        clearInterval(relogio);
        if (botao) botao.disabled = false;
    }
}

function telefonesDoExtrator() {
    const telefones = [];

    (extratorResultado.resultados || []).forEach((item) => {
        (item.telefones || []).forEach((telefone) => {
            if (telefone.wati && !telefones.includes(telefone.wati)) telefones.push(telefone.wati);
        });
    });

    return telefones;
}

function baixarExtrator() {
    const resultados = (extratorResultado.resultados || []).filter((item) => item.status === 'ok');
    if (!resultados.length) { toast('Nenhum resultado com telefone para baixar.', 'erro'); return; }

    const linhas = ['cpf;nome;telefones_wati;telefones_formatados'];

    resultados.forEach((item) => {
        linhas.push([
            formatarCpfPainel(item.cpf),
            item.nome,
            (item.telefones || []).map((telefone) => telefone.wati).join(' '),
            (item.telefones || []).map((telefone) => telefone.formatado).join(' ')
        ].map((valor) => String(valor == null ? '' : valor).replace(/;/g, ',')).join(';'));
    });

    const blob = new Blob(['﻿' + linhas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    link.href = url;
    link.download = 'extrator-cpf-' + carimbo + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast(resultados.length + ' CPF(s) no .csv.');
}

async function copiarTelefonesExtrator() {
    const telefones = telefonesDoExtrator();
    if (!telefones.length) { toast('Nenhum telefone para copiar. Consulte os CPFs primeiro.', 'erro'); return; }

    const texto = telefones.join('\n');

    try {
        await navigator.clipboard.writeText(texto);
        toast(telefones.length + ' telefone(s) copiado(s) no formato Wati.');
    } catch (falha) {
        const area = document.createElement('textarea');
        area.value = texto;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        toast(telefones.length + ' telefone(s) copiado(s).');
    }
}

function usarExtratorNaLista() {
    const telefones = telefonesDoExtrator();
    if (!telefones.length) { toast('Nenhum telefone para importar.', 'erro'); return; }

    const caixa = $('lista-texto');
    if (caixa) caixa.value = ['telefone'].concat(telefones).join('\n');

    irPara('listas');
    analisarLista();
    abrirImportacaoLista();
    toast(telefones.length + ' telefone(s) levado(s) para a importação de listas.');
}

function limparExtrator() {
    ['extrator-texto'].forEach((id) => {
        const campo = $(id);
        if (campo) campo.value = '';
    });

    const arquivo = $('extrator-arquivo');
    if (arquivo) arquivo.value = '';

    const progresso = $('extrator-progresso');
    if (progresso) progresso.textContent = '';

    const status = $('extrator-status');
    if (status) status.textContent = '';

    const cnpjTexto = $('cnpj-texto');
    if (cnpjTexto) cnpjTexto.value = '';

    const cnpjProgresso = $('cnpj-progresso');
    if (cnpjProgresso) cnpjProgresso.textContent = '';

    consultaCnpj = [];
    renderizarCnpjValidacao();

    extratorResultado = { resumo: null, resultados: [] };
    renderizarExtrator();
}

/* ---------------------------------------------------------
   TELEFONES COLETADOS (via consulta de CNPJ)
   --------------------------------------------------------- */
function renderizarColetados() {
    const alvo = $('coletados-lista');
    if (!alvo) return;

    if (!telefonesColetados.length) {
        alvo.textContent = 'Nenhum telefone coletado ainda.';
        return;
    }

    alvo.textContent = telefonesColetados.join('  |  ');
}

async function copiarColetados() {
    if (!telefonesColetados.length) { toast('Nenhum telefone coletado.', 'erro'); return; }

    const texto = telefonesColetados.join('\n');

    try {
        await navigator.clipboard.writeText(texto);
        toast(telefonesColetados.length + ' telefone(s) copiado(s).');
    } catch (falha) {
        const area = document.createElement('textarea');
        area.value = texto;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        toast(telefonesColetados.length + ' telefone(s) copiado(s).');
    }
}

function usarColetadosNaLista() {
    if (!telefonesColetados.length) { toast('Nenhum telefone coletado para importar.', 'erro'); return; }

    const caixa = $('lista-texto');
    if (caixa) caixa.value = ['telefone'].concat(telefonesColetados).join('\n');

    irPara('listas');
    analisarLista();
    abrirImportacaoLista();
    toast(telefonesColetados.length + ' telefone(s) levado(s) para a importação de listas.');
}

function limparColetados() {
    telefonesColetados = [];
    renderizarColetados();
    toast('Coletados limpos.');
}

function adicionarColetado(wati, formatado) {
    if (!wati) { toast('Telefone não reconhecido como número do Brasil.', 'erro'); return; }

    if (!telefonesColetados.includes(wati)) {
        telefonesColetados.push(wati);
        renderizarColetados();
        toast('+' + (formatado || wati) + ' coletado.');
    } else {
        toast('Esse telefone já está na lista de coletados.', 'erro');
    }
}

/* ---------------------------------------------------------
   CONSULTA DE CNPJ (dados públicos da empresa)
   Puxa razão social, situação, endereço, telefone e e-mail da
   empresa na base pública da Receita (BrasilAPI/Minha Receita).
   O servidor descarta o CPF do sócio: o painel recebe só o que
   é da empresa. Nada é gravado no banco.
   --------------------------------------------------------- */
let consultaCnpj = [];

async function consultarCnpjsValidacao() {
    const caixa = $('cnpj-texto');
    const progresso = $('cnpj-progresso');
    const botao = document.querySelector('button[onclick="consultarCnpjsValidacao()"]');

    const linhas = String(caixa ? caixa.value : '')
        .split(/[\r\n,;]+/)
        .map((linha) => linha.trim())
        .filter(Boolean);

    if (!linhas.length) { toast('Cole pelo menos um CNPJ para consultar.', 'erro'); return; }

    const unicos = Array.from(new Set(linhas.map((linha) => apenasNumeros(linha)).filter(Boolean)));
    if (!unicos.length) { toast('Nenhum CNPJ digitado.', 'erro'); return; }
    if (unicos.length > 20) {
        toast('Consulte no máximo 20 CNPJs por vez (você colou ' + unicos.length + ').', 'erro');
        return;
    }

    if (botao) botao.disabled = true;
    if (progresso) progresso.textContent = 'Consultando ' + unicos.length + ' CNPJ(s) na base pública...';

    try {
        const resposta = await fetch('/api/cnpj/consultar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cnpjs: unicos })
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !retorno.success) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        consultaCnpj = retorno.resultados || [];
        renderizarCnpjValidacao();

        const resumo = retorno.resumo || {};
        const partes = [(resumo.ok || 0) + ' empresa(s) encontrada(s)'];
        if (resumo.comTelefone) partes.push(resumo.comTelefone + ' com telefone');

        const problemas = (resumo.naoEncontrados || 0) + (resumo.invalidos || 0) + (resumo.erros || 0);
        if (problemas) partes.push(problemas + ' sem retorno');

        if (progresso) progresso.textContent = partes.join(' · ') + '.';
        toast(partes.join(' · '), problemas ? 'erro' : undefined);
    } catch (erro) {
        if (progresso) progresso.textContent = erro.message || 'Não foi possível consultar os CNPJs.';
        toast(erro.message || 'Não foi possível consultar os CNPJs.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

function renderizarCnpjValidacao() {
    const corpo = $('tabela-cnpj');
    if (!corpo) return;

    if (!consultaCnpj.length) {
        corpo.innerHTML = '<tr><td colspan="6" class="vazio">Cole um CNPJ e clique em “Consultar CNPJ”.</td></tr>';
        return;
    }

    corpo.innerHTML = consultaCnpj.map((item, indice) => {
        if (item.status !== 'ok') {
            const etiqueta = item.status === 'invalido'
                ? 'CNPJ inválido'
                : (item.status === 'nao_encontrado' ? 'não encontrado' : 'falha na consulta');

            return '<tr>' +
                '<td>' + escaparHtml(item.original || item.cnpj || '-') + '</td>' +
                '<td colspan="4"><span class="status-badge status-nao-quis">' + etiqueta + '</span> ' +
                    escaparHtml(item.message || '') + '</td>' +
                '<td>-</td>' +
                '</tr>';
        }

        const telefones = item.telefones || [];
        const celulasTelefone = telefones.length
            ? telefones.map((telefone, posicao) => (telefone.wati
                ? '<button class="btn-mini" type="button" onclick="usarTelefoneCnpj(' + indice + ', ' + posicao + ')">↪ ' +
                    escaparHtml(telefone.formatado) + '</button>'
                : '<small>' + escaparHtml(telefone.formatado || telefone.numero) + ' (formato não reconhecido)</small>'
            )).join('<br>')
            : '<small>sem telefone publicado</small>';

        const detalhes = [
            item.endereco || '',
            item.cnaeDescricao ? 'CNAE ' + item.cnae + ' — ' + item.cnaeDescricao : ''
        ].filter(Boolean).map((texto) => '<br><small>' + escaparHtml(texto) + '</small>').join('');

        const temTelefone = telefones.some((telefone) => telefone.wati);

        return '<tr>' +
            '<td>' + escaparHtml(item.cnpjFormatado || item.cnpj || '-') +
                (item.fonte ? '<br><small>' + escaparHtml(item.fonte) + (item.cache ? ' · cache' : '') + '</small>' : '') +
                '</td>' +
            '<td><strong>' + escaparHtml(item.razaoSocial || '-') + '</strong>' +
                (item.nomeFantasia ? '<br><small>' + escaparHtml(item.nomeFantasia) + '</small>' : '') +
                detalhes + '</td>' +
            '<td>' + escaparHtml(item.situacao || '-') +
                (item.dataSituacao ? '<br><small>' + escaparHtml(item.dataSituacao) + '</small>' : '') + '</td>' +
            '<td>' + celulasTelefone + '</td>' +
            '<td>' + (item.email ? escaparHtml(item.email) : '-') + '</td>' +
            '<td>' + (temTelefone
                ? '<button class="btn-mini" type="button" onclick="usarTodosTelefonesCnpj(' + indice + ')">↪ Todos</button>'
                : '-') + '</td>' +
            '</tr>';
    }).join('');
}

function usarTelefoneCnpj(indice, posicao) {
    const empresa = consultaCnpj[indice];
    const telefone = empresa && empresa.telefones ? empresa.telefones[posicao] : null;

    if (!telefone || !telefone.wati) { toast('Telefone da empresa não reconhecido como número do Brasil.', 'erro'); return; }

    adicionarColetado(telefone.wati, telefone.formatado);
}

function usarTodosTelefonesCnpj(indice) {
    const empresa = consultaCnpj[indice];
    const watis = ((empresa && empresa.telefones) || [])
        .map((telefone) => telefone.wati)
        .filter(Boolean);

    if (!watis.length) { toast('Nenhum telefone publicado para essa empresa.', 'erro'); return; }

    watis.forEach((wati) => {
        if (!telefonesColetados.includes(wati)) telefonesColetados.push(wati);
    });

    renderizarColetados();
    toast(watis.length + ' telefone(s) da empresa coletado(s).');
}

/* Baixa as empresas consultadas em .csv (só campos da empresa). */
function baixarCnpjValidacao() {
    const empresas = consultaCnpj.filter((item) => item.status === 'ok');
    if (!empresas.length) { toast('Consulte pelo menos um CNPJ antes de baixar.', 'erro'); return; }

    const linhas = ['cnpj;razao_social;nome_fantasia;situacao;cnae;endereco;telefones;email'];

    empresas.forEach((item) => {
        const telefones = (item.telefones || [])
            .map((telefone) => telefone.wati || telefone.numero)
            .join(' ');

        linhas.push([
            item.cnpjFormatado || item.cnpj,
            item.razaoSocial,
            item.nomeFantasia,
            item.situacao,
            (item.cnae + ' ' + item.cnaeDescricao).trim(),
            item.endereco,
            telefones,
            item.email
        ].map((valor) => String(valor == null ? '' : valor).replace(/;/g, ',')).join(';'));
    });

    const blob = new Blob(['﻿' + linhas.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    link.href = url;
    link.download = 'cnpj-' + carimbo + '.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast(empresas.length + ' empresa(s) no .csv.');
}


async function salvarLista() {
    const campoNome = $('lista-nome');
    const nome = (campoNome ? campoNome.value : '').trim();

    if (!tabelaLista) { toast('Clique em "Analisar colunas" antes de importar.', 'erro'); return; }
    if (!nome) { toast('Informe um nome para a lista.', 'erro'); return; }

    const contatos = montarContatosDaLista();
    if (!contatos.length) { toast('Nenhum telefone válido encontrado.', 'erro'); return; }

    const botao = document.querySelector('button[onclick="salvarLista()"]');
    if (botao) botao.disabled = true;

    const progresso = $('lista-progresso');
    const mostrarProgresso = (texto) => { if (progresso) progresso.textContent = texto; };

    try {
        mostrarProgresso('Gravando a lista...');

        const resposta = await fetch('/api/listas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, contatos })
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !retorno.success) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        gravarMapaMemoria();

        const querWati = $('lista-enviar-wati') ? $('lista-enviar-wati').checked : false;
        let enviadosWati = null;
        let falhasWati = 0;
        let primeiroErroWati = '';

        if (querWati) {
            const tamanhoLote = 20;
            enviadosWati = 0;

            for (let inicio = 0; inicio < contatos.length; inicio += tamanhoLote) {
                const lote = contatos.slice(inicio, inicio + tamanhoLote);
                mostrarProgresso('Enviando para a Wati: ' + Math.min(inicio + tamanhoLote, contatos.length) + ' de ' + contatos.length + '...');

                const envio = await fetch('/api/wati/contatos', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ contatos: lote })
                });

                const resultado = await envio.json().catch(() => ({}));
                if (!envio.ok) throw new Error(resultado.message || ('HTTP ' + envio.status));

                enviadosWati += Number(resultado.enviados) || 0;
                falhasWati += Number(resultado.falhas) || 0;

                if (!primeiroErroWati && Array.isArray(resultado.resultados)) {
                    const comErro = resultado.resultados.find((item) => !item.ok && item.message);
                    if (comErro) primeiroErroWati = comErro.message;
                }
            }
        }

        const partes = ['Lista "' + nome + '" importada com ' + retorno.total + ' contato(s)'];

        if (retorno.novos || retorno.atualizados) {
            partes.push((retorno.novos || 0) + ' novo(s), ' + (retorno.atualizados || 0) + ' atualizado(s)');
        }
        if (enviadosWati !== null) {
            partes.push(falhasWati
                ? enviadosWati + ' na Wati, ' + falhasWati + ' com falha'
                : enviadosWati + ' enviado(s) para a Wati com atributos');
        }

        mostrarProgresso(partes.join(' · '));
        toast(partes.join(' · '), falhasWati ? 'erro' : undefined);

        if (falhasWati && primeiroErroWati) console.warn('Wati:', primeiroErroWati);

        if (campoNome) campoNome.value = '';
        const campoTexto = $('lista-texto');
        if (campoTexto) campoTexto.value = '';

        const arquivo = $('lista-arquivo');
        if (arquivo) arquivo.value = '';

        tabelaLista = null;
        const painel = $('lista-mapeamento');
        if (painel) painel.classList.add('oculto');

        carregarListas();
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao salvar lista:', erro);
        mostrarProgresso(erro.message || 'Não foi possível salvar a lista.');
        toast(erro.message || 'Não foi possível salvar a lista.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

async function carregarListas() {
    const corpo = $('tabela-listas');
    if (!corpo) return;

    try {
        const resposta = await fetch('/api/listas');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const listas = await resposta.json();
        corpo.innerHTML = '';

        if (!listas.length) {
            corpo.innerHTML = '<tr><td colspan="4" class="vazio">Nenhuma lista importada ainda.</td></tr>';
            return;
        }

        listas.forEach((lista) => {
            const linha = document.createElement('tr');
            linha.innerHTML = `
                <td>${escaparHtml(lista.nome || '-')}</td>
                <td>${escaparHtml(lista.total || 0)}</td>
                <td>${escaparHtml(formatarData(lista.criado_em) || '-')}</td>
                <td><button class="btn-mini danger" title="Excluir lista">🗑️</button></td>
            `;

            const botao = linha.querySelector('button');
            if (botao) botao.onclick = () => excluirLista(lista.id, lista.nome);

            corpo.appendChild(linha);
        });
    } catch (erro) {
        console.error('Erro ao carregar listas:', erro);
        corpo.innerHTML = '<tr><td colspan="4" class="vazio">Erro ao buscar listas no servidor.</td></tr>';
    }
}

async function excluirLista(id, nome) {
    if (!confirm('Excluir a lista "' + (nome || id) + '"?')) return;

    try {
        const resposta = await fetch('/api/listas/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        toast('Lista excluída.');
        carregarListas();
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao excluir lista:', erro);
        toast('Não foi possível excluir a lista.', 'erro');
    }
}


/* =========================================================
   PARTE 9 - SOM, NOTIFICAÇÕES E MUDO
   ========================================================= */

function tocarSom() {
    if (!somAtivo || mudoAtivo) return;

    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;

        audioCtx = audioCtx || new AudioCtx();
        const osc = audioCtx.createOscillator();
        const ganho = audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1180, audioCtx.currentTime + 0.12);

        ganho.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        ganho.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.02);
        ganho.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);

        osc.connect(ganho);
        ganho.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.4);
    } catch (erro) { /* navegador sem suporte a áudio */ }
}

function atualizarBotoesAudio() {
    const botaoSom = $('btn-som');
    if (botaoSom) {
        botaoSom.textContent = somAtivo ? '🔊' : '🔇';
        botaoSom.title = somAtivo ? 'Som de novas mensagens (ligado)' : 'Som de novas mensagens (desligado)';
    }

    const botaoNotif = $('btn-notif');
    if (botaoNotif) {
        botaoNotif.textContent = notificacoesAtivas ? '🔔' : '🔕';
        botaoNotif.title = notificacoesAtivas ? 'Notificações de desktop (ligadas)' : 'Notificações de desktop (desligadas)';
    }

    const botaoMudo = $('btn-mudo');
    if (botaoMudo) {
        botaoMudo.textContent = mudoAtivo ? '🔕' : '🔔';
        botaoMudo.title = mudoAtivo ? 'Silenciado (clique para ativar)' : 'Silenciar tudo';
    }
}

function toggleSom() {
    somAtivo = !somAtivo;
    if (somAtivo) tocarSom();
    atualizarBotoesAudio();
    toast(somAtivo ? 'Som de novas mensagens ativado.' : 'Som de novas mensagens desativado.');
}

function toggleMudo() {
    mudoAtivo = !mudoAtivo;
    atualizarBotoesAudio();
    toast(mudoAtivo ? 'Silenciado: sem sons e sem notificações.' : 'Sons e notificações liberados.');
}

function toggleNotificacoes() {
    if (!('Notification' in window)) {
        toast('Este navegador não suporta notificações.', 'erro');
        return;
    }

    if (notificacoesAtivas) {
        notificacoesAtivas = false;
        atualizarBotoesAudio();
        toast('Notificações desativadas.');
        return;
    }

    Notification.requestPermission().then((permissao) => {
        notificacoesAtivas = permissao === 'granted';
        atualizarBotoesAudio();
        if (notificacoesAtivas) toast('Notificações de desktop ativadas.');
        else toast('Permissão de notificação negada.', 'erro');
    }).catch(() => toast('Não foi possível solicitar permissão.', 'erro'));
}

function notificarDesktop(titulo, texto) {
    if (!notificacoesAtivas || mudoAtivo) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try { new Notification(titulo, { body: texto }); }
    catch (erro) { /* ignora falha de notificação */ }
}


/* =========================================================
   PARTE 10 - TEMPO REAL (SSE) E INICIALIZAÇÃO
   ========================================================= */

function atualizarIndicadorSSE(conectado) {
    const indicador = $('sse-status');
    if (!indicador) return;

    indicador.textContent = conectado ? '● online' : '● reconectando...';
    indicador.classList.toggle('sse-online', conectado);
    indicador.classList.toggle('sse-offline', !conectado);
}

function jaMostradaNaTela(texto) {
    const area = $('messages');
    if (!area) return false;

    const bolhas = area.querySelectorAll('.message p');
    const ultima = bolhas[bolhas.length - 1];
    return !!ultima && ultima.textContent === String(texto);
}

function conectarSSE() {
    if (typeof EventSource === 'undefined') return;

    if (sse) sse.close();
    sse = new EventSource('/api/eventos');

    sse.onopen = () => atualizarIndicadorSSE(true);
    sse.onerror = () => atualizarIndicadorSSE(false);

    sse.addEventListener('conectado', () => atualizarIndicadorSSE(true));

    sse.addEventListener('mensagem', (evento) => {
        let dados = {};
        try { dados = JSON.parse(evento.data || '{}'); } catch (erro) { return; }
        if (!dados.telefone) return;

        const ehConversaAtiva = clienteAtivo && clienteAtivo.telefone === dados.telefone;

        if (dados.direcao === 'recebida') {
            tocarSom();
            notificarDesktop(dados.nome || formatarTelefone(dados.telefone), dados.texto || 'Nova mensagem');
        }

        if (ehConversaAtiva && !jaMostradaNaTela(dados.texto)) {
            adicionarMensagemNaTela(dados.direcao, dados.texto);
        }

        carregarConversas(true);
        carregarDashboard();
    });

    sse.addEventListener('status', () => {
        carregarConversas(true);
        carregarDashboard();

        const overlay = $('ficha-overlay');
        if (fichaTelefone && overlay && !overlay.classList.contains('oculto')) carregarFicha(fichaTelefone);
    });

    sse.addEventListener('ficha', () => {
        const overlay = $('ficha-overlay');
        if (fichaTelefone && overlay && !overlay.classList.contains('oculto')) carregarFicha(fichaTelefone);
    });

    sse.addEventListener('lista', () => {
        carregarListas();
        carregarDashboard();
    });

    sse.addEventListener('campanha', () => {
        const painel = $('view-campanhas');
        if (painel && !painel.classList.contains('oculto')) carregarCampanhas();
        carregarDashboard();
    });

    // Histórico apagado por outro administrador
    sse.addEventListener('conversas', () => {
        clienteAtivo = null;
        fichaTelefone = null;
        fecharFicha();
        limparChat();
        carregarConversas();
        carregarDashboard();
    });

    // Lead novo direcionado para um vendedor (campanhas)
    sse.addEventListener('clientes', () => {
        const painel = $('view-clientes');
        if (painel && !painel.classList.contains('oculto')) carregarTabelaClientes();
        carregarDashboard();
    });

    // Qualquer evento novo da Wati recarrega a tela Atividade Wati
    sse.addEventListener('wati', () => {
        const painel = $('view-wati');
        if (painel && !painel.classList.contains('oculto')) carregarAtividadeWati();

        const inicio = $('view-inicio');
        if (inicio && !inicio.classList.contains('oculto')) carregarDashboard();
    });
}

function iniciarPainel() {
    carregarUsuario();
    carregarDashboard();
    atualizarBotoesAudio();
    ligarMenuAgrupado();
    conectarSSE();

    const campoMensagem = $('message');
    if (campoMensagem) {
        campoMensagem.addEventListener('keypress', (evento) => {
            if (evento.key === 'Enter') {
                evento.preventDefault();
                enviarMensagem();
            }
        });
    }
}

/* =========================================================
   PARTE 11 - CANAIS (WhatsApp / Wati)
   ========================================================= */

function rotuloCanal(canal) {
    if (canal.modoDemo) return { chave: 'demo', texto: 'Modo demo' };
    if (canal.ativo) return { chave: 'conectado', texto: 'Configurado' };
    return { chave: 'pendente', texto: 'Pendente' };
}

function cartaoCanal(canal) {
    const rotulo = rotuloCanal(canal);

    return `
        <div class="screen-panel canal-card">
            <div class="canal-head">
                <span class="canal-icone">🛠️</span>
                <div class="canal-titulo">
                    <h3>${escaparHtml(canal.nome || 'Canal')}</h3>
                    <small>${escaparHtml(canal.provedor || '—')}</small>
                </div>
                <span class="canal-status ${rotulo.chave}">${rotulo.texto}</span>
            </div>

            <div class="canal-dados">
                <div class="info-group"><label>Número</label><p>${escaparHtml(canal.numero || '—')}</p></div>
                <div class="info-group"><label>Tenant</label><p>${escaparHtml(canal.tenant || '—')}</p></div>
                <div class="info-group"><label>Host</label><p>${escaparHtml(canal.host || '—')}</p></div>
                <div class="info-group"><label>Token</label><p>${escaparHtml(canal.token || '—')}</p></div>
            </div>
        </div>`;
}

async function carregarCanais() {
    const container = $('canais-lista');
    if (!container) return;

    try {
        const resposta = await fetch('/api/canais');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const canais = await resposta.json();
        if (!Array.isArray(canais) || !canais.length) {
            container.innerHTML = '<div class="screen-panel"><p class="vazio">Nenhum canal configurado.</p></div>';
            return;
        }

        container.innerHTML = canais.map(cartaoCanal).join('');
    } catch (erro) {
        container.innerHTML = '<div class="screen-panel"><p class="vazio">Não foi possível carregar o canal.</p></div>';
        toast('Erro ao carregar canais.', 'erro');
    }
}

async function testarCanal(botao) {
    const textoOriginal = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = 'Testando...'; }

    try {
        const resposta = await fetch('/api/canais/testar', { method: 'POST' });
        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (resposta.ok && dados.ok) {
            const extra = dados.tempoMs ? ` (${dados.tempoMs} ms)` : '';
            toast((dados.message || 'Conexão OK.') + extra);
        } else {
            toast(dados.message || 'Falha ao testar a conexão.', 'erro');
        }

        carregarCanais();
    } catch (erro) {
        toast('Erro ao testar o canal.', 'erro');
    } finally {
        if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
    }
}

/* ---------------------------------------------------------
   WEBHOOK SEGURO (token na URL do webhook)
   --------------------------------------------------------- */
let webhookAtual = null;

function renderizarWebhook(dados) {
    const status = $('webhook-status');
    const campo = $('webhook-url');
    const dica = $('webhook-dica');
    const botao = $('webhook-toggle');
    const atividade = $('webhook-atividade');
    if (!status || !campo || !dica || !botao) return;

    webhookAtual = dados || null;

    if (!dados) {
        status.textContent = 'Não foi possível carregar o estado do webhook.';
        status.className = 'webhook-status erro';
        campo.value = '';
        dica.textContent = 'Atualize a página ou tente novamente em instantes.';
        if (atividade) atividade.textContent = '';
        botao.disabled = true;
        botao.textContent = 'Indisponível';
        return;
    }

    if (dados.ativo) {
        status.textContent = dados.viaAmbiente
            ? 'Token exigido (definido no Environment do Render).'
            : 'Token exigido — webhook protegido.';
        status.className = 'webhook-status ativo';
    } else if (dados.temSegredo) {
        status.textContent = 'Token ainda não exigido — qualquer origem consegue chamar o webhook.';
        status.className = 'webhook-status pendente';
    } else {
        status.textContent = 'Sem segredo disponível para proteger o webhook.';
        status.className = 'webhook-status erro';
    }

    campo.value = dados.url || (dados.viaAmbiente ? 'Segredo definido no Render — a URL é /webhook?token=SEU_WEBHOOK_SECRET' : '');
    dica.textContent = dados.aviso || '';

    if (atividade) {
        if (dados.ultimoEvento) {
            atividade.textContent = `Último evento recebido: ${dados.ultimoEvento.tipo}` +
                ` · ${formatarData(dados.ultimoEvento.criado_em)}` +
                (dados.eventosHoje ? ` · ${dados.eventosHoje} evento(s) hoje` : '');
        } else {
            atividade.textContent = 'Nenhum evento recebido ainda — confira se a URL acima está cadastrada como webhook na Wati.';
        }
    }

    if (dados.viaAmbiente) {
        botao.disabled = true;
        botao.textContent = 'Definido no Render';
    } else {
        botao.disabled = false;
        botao.textContent = dados.ativo ? 'Desativar exigência' : 'Ativar exigência do token';
    }
}

async function carregarWebhook() {
    try {
        const resposta = await fetch('/api/webhook');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
        renderizarWebhook(await resposta.json());
    } catch (erro) {
        renderizarWebhook(null);
    }
}

async function alternarWebhook(botao) {
    if (!webhookAtual) return;

    const ativar = !webhookAtual.ativo;
    const textoOriginal = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = ativar ? 'Ativando...' : 'Desativando...'; }

    try {
        const resposta = await fetch('/api/webhook/ativar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo: ativar })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }
        if (!resposta.ok) throw new Error(dados.message || 'Falha ao alterar o webhook.');

        renderizarWebhook(dados);
        toast(ativar ? 'Token do webhook ativado.' : 'Token do webhook desativado.');
    } catch (erro) {
        toast(erro.message || 'Erro ao alterar o webhook.', 'erro');
        if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
        carregarWebhook();
    }
}

async function copiarWebhook() {
    const campo = $('webhook-url');
    const texto = campo ? String(campo.value || '').trim() : '';

    if (!texto) { toast('Nenhuma URL disponível para copiar.', 'erro'); return; }

    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(texto);
        } else {
            campo.select();
            document.execCommand('copy');
        }
        toast('URL copiada. Cole na Wati em Settings → Webhook.');
    } catch (erro) {
        console.error('Erro ao copiar URL do webhook:', erro);
        campo.select();
        toast('Selecione a URL e copie com Ctrl+C.', 'erro');
    }
}

/* =========================================================
   PARTE 12 - CAMPANHAS
   ========================================================= */

let filtroLogs = '';
let vendedoresDisponiveis = [];
let vendedoresCarregados = false;
let templatesCampanha = [];
let templatesCampanhaCarregados = false;
let atributosListaCampanha = [];
let mapaVariaveisCampanha = {};

/* Troca entre texto livre e template aprovado (Wati) */
function alterarCanalCampanha() {
    const canal = (($('campanha-canal') || {}).value) || 'texto';
    const blocoTemplate = $('campanha-bloco-template');
    const blocoMensagem = $('campanha-bloco-mensagem');

    if (blocoTemplate) blocoTemplate.classList.toggle('oculto', canal !== 'template');
    if (blocoMensagem) blocoMensagem.classList.toggle('oculto', canal === 'template');

    if (canal === 'template') {
        carregarTemplatesCampanha();
        carregarAtributosListaCampanha();
    }
}

function chaveTemplate(template) {
    return template ? `${template.nome}|${template.idioma || ''}` : '';
}

function templateSelecionado() {
    const select = $('campanha-template');
    const indice = select ? parseInt(select.value, 10) : NaN;
    if (!Number.isInteger(indice) || indice < 0) return null;
    return templatesCampanha[indice] || null;
}

async function carregarTemplatesCampanha(forcar) {
    const select = $('campanha-template');
    const status = $('campanha-template-status');
    if (!select) return;

    if (templatesCampanhaCarregados && !forcar) return;

    const anterior = chaveTemplate(templateSelecionado());

    if (status) status.textContent = 'Consultando templates na Wati...';
    select.innerHTML = '<option value="">Carregando templates...</option>';

    try {
        const resposta = await fetch('/api/wati/templates' + (forcar ? '?atualizar=1' : ''));
        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        templatesCampanha = Array.isArray(dados.templates) ? dados.templates : [];
        templatesCampanhaCarregados = true;

        if (!templatesCampanha.length) {
            select.innerHTML = '<option value="">Nenhum template encontrado</option>';
            if (status) status.textContent = dados.aviso || 'A Wati não devolveu templates para esta conta.';
            renderizarParametrosTemplate();
            return;
        }

        const aprovados = templatesCampanha.filter((t) => t.aprovado);

        if (!aprovados.length) {
            select.innerHTML = '<option value="">Nenhum template aprovado</option>';
            if (status) {
                status.textContent = templatesCampanha.length + ' template(s) na conta, nenhum aprovado ainda.'
                    + (dados.demo ? ' · modo demo' : '');
            }
            renderizarParametrosTemplate();
            return;
        }

        // Só templates APPROVED podem ser disparados; o value é o índice na
        // lista completa, então nome + idioma ficam preservados.
        select.innerHTML = '<option value="">Selecione o template...</option>' + templatesCampanha.map((template, indice) => {
            if (!template.aprovado) return '';
            const idioma = template.idioma ? ' (' + template.idioma + ')' : '';
            return `<option value="${indice}">${escaparHtml(template.nome + idioma)}</option>`;
        }).join('');

        const indiceAnterior = templatesCampanha.findIndex((template) =>
            template.aprovado && chaveTemplate(template) === anterior
        );
        if (indiceAnterior >= 0) select.value = String(indiceAnterior);

        if (status) {
            status.textContent = aprovados.length + ' template(s) aprovado(s)' + (dados.demo ? ' · modo demo' : '') + '.';
        }
    } catch (erro) {
        templatesCampanha = [];
        templatesCampanhaCarregados = false;
        select.innerHTML = '<option value="">Erro ao carregar templates</option>';
        if (status) status.textContent = 'Não foi possível consultar os templates da Wati. ' + (erro.message || '');
    }

    renderizarParametrosTemplate();
}

async function carregarAtributosListaCampanha() {
    const listaId = (($('campanha-lista') || {}).value) || '';
    atributosListaCampanha = [];

    if (!listaId) {
        renderizarParametrosTemplate();
        return;
    }

    try {
        const resposta = await fetch('/api/listas/' + encodeURIComponent(listaId) + '/atributos');
        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }
        atributosListaCampanha = (resposta.ok && Array.isArray(dados.atributos)) ? dados.atributos : [];
    } catch (erro) {
        atributosListaCampanha = [];
    }

    renderizarParametrosTemplate();
}

/* Prévia com os valores já ligados: valor fixo aparece direto; atributo
   aparece entre « » porque muda de contato para contato. */
function montarPreviewTemplate(template) {
    const variaveis = Array.isArray(template.variaveis) ? template.variaveis : [];

    return String(template.corpo || '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (achado, bruto) => {
        let chave = String(bruto).trim();

        if (/^\d+$/.test(chave)) {
            const indice = parseInt(chave, 10) - 1;
            if (variaveis[indice]) chave = String(variaveis[indice]);
        }

        const estado = mapaVariaveisCampanha[chave];
        if (!estado || !estado.valor) return achado;
        if (estado.origem === 'fixo') return estado.valor;

        // Variável numérica vem da coluna {{n}} da lista.
        return /^\d+$/.test(estado.valor) ? `«{{${estado.valor}}}»` : `«${estado.valor}»`;
    });
}

function renderizarParametrosTemplate() {
    const caixa = $('campanha-parametros');
    if (!caixa) return;

    const template = templateSelecionado();
    const preview = $('campanha-template-preview');

    if (preview) {
        preview.classList.toggle('oculto', !template);
        preview.textContent = template
            ? (montarPreviewTemplate(template) || 'A Wati não devolveu o corpo deste template.')
            : '';
    }

    if (!template) {
        caixa.innerHTML = '<p class="mapa-ajuda">Escolha um template para ver as variáveis.</p>';
        return;
    }

    const variaveis = Array.isArray(template.variaveis) ? template.variaveis : [];

    if (!variaveis.length) {
        caixa.innerHTML = '<p class="mapa-ajuda">Este template não tem variáveis — é só criar a campanha.</p>';
        return;
    }

    caixa.innerHTML = variaveis.map((variavel) => {
        const chave = String(variavel);
        return `
            <div class="template-parametro" data-variavel="${escaparHtml(chave)}">
                <span class="template-variavel">{{${escaparHtml(chave)}}}</span>
                <select class="form-control" data-origem>
                    <option value="atributo">Atributo da lista</option>
                    <option value="fixo">Valor fixo</option>
                </select>
                <select class="form-control" data-atributo></select>
                <input class="form-control oculto" data-fixo type="text" placeholder="valor fixo">
            </div>`;
    }).join('');

    Array.from(caixa.querySelectorAll('.template-parametro')).forEach((linha, indiceVariavel) => {
        const variavel = linha.dataset.variavel;
        const seletorOrigem = linha.querySelector('[data-origem]');
        const seletorAtributo = linha.querySelector('[data-atributo]');
        const campoFixo = linha.querySelector('[data-fixo]');
        const estado = mapaVariaveisCampanha[variavel] || {};

        // 1º procura atributo com o mesmo nome da variável ({{nome}} -> nome);
        // 2º usa a coluna {{1}}, {{2}}... na mesma posição do template.
        const sugestao = atributosListaCampanha.find((a) =>
            String(a.nome).toLowerCase() === variavel.toLowerCase()
        ) || atributosListaCampanha.find((a) =>
            a.tipo === 'variavel' && String(a.nome) === String(indiceVariavel + 1)
        );

        seletorAtributo.innerHTML = '<option value="">Escolha o atributo...</option>' + atributosListaCampanha.map((a) => {
            const rotulo = a.tipo === 'variavel' ? `{{${a.nome}}}` : a.nome;
            return `<option value="${escaparHtml(a.nome)}">${escaparHtml(rotulo)} (${Number(a.comValor) || 0})</option>`;
        }).join('');

        seletorOrigem.value = estado.origem || (atributosListaCampanha.length ? 'atributo' : 'fixo');
        seletorAtributo.value = estado.origem !== 'fixo' && estado.valor ? estado.valor : (sugestao ? sugestao.nome : '');
        campoFixo.value = estado.origem === 'fixo' ? (estado.valor || '') : '';

        function sincronizar() {
            const origem = seletorOrigem.value;
            seletorAtributo.classList.toggle('oculto', origem !== 'atributo');
            campoFixo.classList.toggle('oculto', origem !== 'fixo');

            mapaVariaveisCampanha[variavel] = {
                origem,
                valor: origem === 'fixo' ? campoFixo.value.trim() : seletorAtributo.value
            };

            if (preview) preview.textContent = montarPreviewTemplate(template);
        }

        seletorOrigem.onchange = sincronizar;
        seletorAtributo.onchange = sincronizar;
        campoFixo.oninput = sincronizar;
        sincronizar();
    });
}

async function carregarVendedoresCampanha() {
    const select = $('campanha-vendedor');

    try {
        const resposta = await fetch('/api/usuarios');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
        const usuarios = await resposta.json();
        vendedoresDisponiveis = (Array.isArray(usuarios) ? usuarios : []).filter((u) => u.ativo !== false);
        vendedoresCarregados = true;

        if (select) {
            const atual = select.value;
            select.innerHTML = '<option value="">Todos (sem direcionamento)</option>' + vendedoresDisponiveis.map((u) =>
                `<option value="${escaparHtml(u.email)}">${escaparHtml(u.nome)}${u.role === 'admin' ? ' (admin)' : ''}</option>`
            ).join('');
            if (atual) select.value = atual;
        }
    } catch (erro) {
        if (select) select.innerHTML = '<option value="">Erro ao carregar vendedores</option>';
        console.error('Erro ao carregar vendedores:', erro);
    }

    return vendedoresDisponiveis;
}

function opcoesVendedor(selecionado) {
    const alvo = String(selecionado || '').toLowerCase();
    const existe = vendedoresDisponiveis.some((u) => String(u.email || '').toLowerCase() === alvo);
    const extra = alvo && !existe
        ? `<option value="${escaparHtml(selecionado)}" selected>${escaparHtml(selecionado)} (removido)</option>`
        : '';

    return '<option value="">Sem direcionamento</option>' + extra + vendedoresDisponiveis.map((u) => {
        const marcado = String(u.email || '').toLowerCase() === alvo ? ' selected' : '';
        return `<option value="${escaparHtml(u.email)}"${marcado}>${escaparHtml(u.nome)}</option>`;
    }).join('');
}

function rotuloStatusCampanha(status) {
    const mapa = {
        ativa: 'Em andamento',
        pausada: 'Pausada',
        concluida: 'Concluída',
        cancelada: 'Cancelada'
    };
    return mapa[status] || status || '—';
}

async function carregarListasCampanha() {
    const select = $('campanha-lista');
    if (!select) return;

    try {
        const resposta = await fetch('/api/listas');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const listas = await resposta.json();
        if (!Array.isArray(listas) || !listas.length) {
            select.innerHTML = '<option value="">Nenhuma lista importada</option>';
            carregarAtributosListaCampanha();
            return;
        }

        const anterior = select.value;
        select.innerHTML = '<option value="">Selecione a lista...</option>' + listas.map((lista) =>
            `<option value="${escaparHtml(lista.id)}">${escaparHtml(lista.nome)} (${Number(lista.total) || 0} contatos)</option>`
        ).join('');

        if (anterior) select.value = anterior;
        carregarAtributosListaCampanha();
    } catch (erro) {
        select.innerHTML = '<option value="">Erro ao carregar listas</option>';
    }
}

function cartaoCampanha(campanha) {
    const total = Number(campanha.total) || 0;
    const enviados = Number(campanha.enviados) || 0;
    const falhas = Number(campanha.falhas) || 0;
    const feitos = enviados + falhas;
    const percentual = total ? Math.min(100, Math.round((feitos / total) * 100)) : 0;
    const status = String(campanha.status || '');
    const mensagem = String(campanha.mensagem || '');
    const ehTemplate = campanha.canal === 'template';
    const templateNome = String(campanha.template_nome || '');
    const resumoMensagem = (ehTemplate ? '📋 ' + (templateNome || 'Template') + ' · ' : '') + mensagem;

    const botoes = [];
    if (status === 'ativa') botoes.push('<button class="btn-mini" data-acao="pausar">⏸ Pausar</button>');
    if (status === 'pausada') botoes.push('<button class="btn-mini" data-acao="retomar">▶ Retomar</button>');
    if (status === 'ativa' || status === 'pausada') botoes.push('<button class="btn-mini" data-acao="cancelar">✕ Cancelar</button>');
    botoes.push('<button class="btn-mini" data-acao="excluir">🗑️</button>');

    return `
        <div class="campanha-card" data-id="${escaparHtml(campanha.id)}">
            <div class="campanha-head">
                <div class="campanha-titulo">
                    <h4>${escaparHtml(campanha.nome || 'Campanha')}</h4>
                    <small>${escaparHtml(resumoMensagem.slice(0, 110))}${resumoMensagem.length > 110 ? '…' : ''}</small>
                </div>
                <span class="campanha-status ${escaparHtml(status)}">${escaparHtml(rotuloStatusCampanha(status))}</span>
            </div>

            <div class="progresso"><span style="width: ${percentual}%"></span></div>

            <div class="campanha-numeros">
                <span><strong>${enviados}</strong>/${total} enviados</span>
                <span>${falhas} falha(s)</span>
                <span>${percentual}%</span>
            </div>

            <div class="campanha-destino">
                <span>👤 Direcionar leads para</span>
                <select data-destino class="campanha-destino-select">${opcoesVendedor(campanha.vendedor_email)}</select>
            </div>

            <div class="campanha-acoes">${botoes.join('')}</div>
        </div>`;
}

async function carregarCampanhas() {
    const container = $('campanhas-lista');
    if (!container) return;

    // Garante a lista de vendedores antes de montar os selects de direcionamento
    if (!vendedoresCarregados) await carregarVendedoresCampanha();

    try {
        const resposta = await fetch('/api/campanhas');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const campanhas = await resposta.json();
        if (!Array.isArray(campanhas) || !campanhas.length) {
            container.innerHTML = '<p class="vazio">Nenhuma campanha criada ainda.</p>';
            return;
        }

        container.innerHTML = campanhas.map(cartaoCampanha).join('');

        Array.from(container.querySelectorAll('.campanha-card')).forEach((card) => {
            const id = card.dataset.id;
            card.querySelectorAll('button[data-acao]').forEach((botao) => {
                botao.onclick = () => {
                    const acao = botao.dataset.acao;
                    if (acao === 'excluir') excluirCampanha(id, botao);
                    else acaoCampanha(id, acao, botao);
                };
            });

            const destino = card.querySelector('select[data-destino]');
            if (destino) destino.onchange = () => direcionarCampanha(id, destino.value, destino);
        });
    } catch (erro) {
        container.innerHTML = '<p class="vazio">Não foi possível carregar as campanhas.</p>';
    }
}

async function criarCampanha(botao) {
    const nome = (($('campanha-nome') || {}).value || '').trim();
    const listaId = ($('campanha-lista') || {}).value || '';
    const canal = ($('campanha-canal') || {}).value || 'texto';
    const mensagem = (($('campanha-mensagem') || {}).value || '').trim();
    const intervalo = ($('campanha-intervalo') || {}).value || '8000';
    const vendedorEmail = ($('campanha-vendedor') || {}).value || '';

    if (!nome) { toast('Informe o nome da campanha.', 'erro'); return; }
    if (!listaId) { toast('Escolha a lista de contatos.', 'erro'); return; }
    if (canal === 'texto' && !mensagem) { toast('Escreva a mensagem da campanha.', 'erro'); return; }

    let template = null;
    let parametros = [];

    if (canal === 'template') {
        template = templateSelecionado();

        if (!template) { toast('Escolha o template aprovado da Wati.', 'erro'); return; }
        if (!template.aprovado) { toast('Esse template ainda não foi aprovado pela Wati.', 'erro'); return; }

        const variaveis = Array.isArray(template.variaveis) ? template.variaveis : [];
        const semValor = variaveis.filter((variavel) => {
            const estado = mapaVariaveisCampanha[variavel];
            return !estado || !estado.valor;
        });

        if (semValor.length) {
            toast('Ligue a(s) variável(is) ' + semValor.map((v) => '{{' + v + '}}').join(', ') + ' do template.', 'erro');
            return;
        }

        parametros = variaveis.map((variavel) => ({
            nome: variavel,
            origem: mapaVariaveisCampanha[variavel].origem,
            valor: mapaVariaveisCampanha[variavel].valor
        }));
    }

    const textoOriginal = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = 'Criando...'; }

    try {
        const resposta = await fetch('/api/campanhas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nome,
                listaId,
                mensagem,
                intervalo: Number(intervalo),
                vendedorEmail,
                canal,
                templateNome: template ? template.nome : '',
                templateIdioma: template ? template.idioma : '',
                parametros
            })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível criar a campanha.', 'erro');
            return;
        }

        toast(`Campanha criada com ${dados.total} contato(s). Envio iniciado.`
            + (dados.templateNome ? ` Template: ${dados.templateNome}.` : '')
            + (dados.vendedorNome ? ` Leads direcionados para ${dados.vendedorNome}.` : ''));
        if ($('campanha-nome')) $('campanha-nome').value = '';
        if ($('campanha-mensagem')) $('campanha-mensagem').value = '';
        carregarCampanhas();
    } catch (erro) {
        toast('Erro ao criar a campanha.', 'erro');
    } finally {
        if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
    }
}

async function direcionarCampanha(id, vendedorEmail, select) {
    if (select) select.disabled = true;

    try {
        const resposta = await fetch('/api/campanhas/' + encodeURIComponent(id) + '/direcionar', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vendedorEmail: vendedorEmail || '' })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível direcionar a campanha.', 'erro');
            carregarCampanhas();
            return;
        }

        toast(dados.vendedorNome
            ? `Leads direcionados para ${dados.vendedorNome}.`
            : 'Campanha sem direcionamento (todos veem os leads).');
        carregarCampanhas();
    } catch (erro) {
        toast('Erro ao direcionar a campanha.', 'erro');
        carregarCampanhas();
    } finally {
        if (select) select.disabled = false;
    }
}

async function acaoCampanha(id, acao, botao) {
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/campanhas/' + encodeURIComponent(id) + '/' + acao, { method: 'POST' });
        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível alterar a campanha.', 'erro');
            return;
        }

        const rotulos = { pausar: 'pausada', retomar: 'retomada', cancelar: 'cancelada' };
        toast('Campanha ' + (rotulos[acao] || 'atualizada') + '.');
        carregarCampanhas();
    } catch (erro) {
        toast('Erro ao alterar a campanha.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

async function excluirCampanha(id, botao) {
    if (!confirm('Excluir esta campanha e todo o histórico de envios dela?')) return;
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/campanhas/' + encodeURIComponent(id), { method: 'DELETE' });
        if (!resposta.ok) { toast('Não foi possível excluir a campanha.', 'erro'); return; }
        toast('Campanha excluída.');
        carregarCampanhas();
    } catch (erro) {
        toast('Erro ao excluir a campanha.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

/* =========================================================
   PARTE 13 - LOGS E AUDITORIA
   ========================================================= */

async function carregarLogs(direcao) {
    if (direcao !== undefined) filtroLogs = direcao;

    const corpo = $('tabela-logs');
    if (!corpo) return;

    try {
        const parametros = new URLSearchParams({ limite: 200 });
        if (filtroLogs) parametros.set('direcao', filtroLogs);

        const resposta = await fetch('/api/logs?' + parametros.toString());
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const logs = await resposta.json();
        if (!Array.isArray(logs) || !logs.length) {
            corpo.innerHTML = '<tr><td colspan="4" class="vazio">Nenhuma mensagem registrada.</td></tr>';
            return;
        }

        corpo.innerHTML = logs.map((log) => `
            <tr>
                <td>${escaparHtml(formatarData(log.criado_em))}</td>
                <td>${escaparHtml(log.nome || formatarTelefone(log.telefone))}</td>
                <td>${log.direcao === 'recebida' ? '📥 Recebida' : '📤 Enviada'}</td>
                <td>${escaparHtml(log.texto || '')}</td>
            </tr>`).join('');
    } catch (erro) {
        corpo.innerHTML = '<tr><td colspan="4" class="vazio">Erro ao carregar os logs.</td></tr>';
    }
}

async function carregarAuditoria() {
    const corpo = $('tabela-auditoria');
    if (!corpo) return;

    try {
        const resposta = await fetch('/api/auditoria?limite=200');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const registros = await resposta.json();
        if (!Array.isArray(registros) || !registros.length) {
            corpo.innerHTML = '<tr><td colspan="4" class="vazio">Nenhuma ação registrada ainda.</td></tr>';
            return;
        }

        corpo.innerHTML = registros.map((registro) => `
            <tr>
                <td>${escaparHtml(formatarData(registro.criado_em))}</td>
                <td>${escaparHtml(registro.ator || 'sistema')}</td>
                <td>${escaparHtml(registro.acao || '')}</td>
                <td>${escaparHtml(registro.detalhe || '')}</td>
            </tr>`).join('');
    } catch (erro) {
        corpo.innerHTML = '<tr><td colspan="4" class="vazio">Erro ao carregar a auditoria.</td></tr>';
    }
}

/* =========================================================
   PARTE 13.B - ATIVIDADE WATI
   ========================================================= */

let filtroEventosWati = '';
let timerAtividadeWati = null;

const ROTULOS_EVENTO_WATI = {
    message: { texto: 'Mensagem', classe: 'msg' },
    sent: { texto: 'Enviada', classe: 'enviada' },
    delivered: { texto: 'Entregue', classe: 'entregue' },
    read: { texto: 'Lida', classe: 'lida' },
    failed: { texto: 'Falhou', classe: 'falha' },
    replied: { texto: 'Respondeu', classe: 'resposta' },
    received: { texto: 'Recebida', classe: 'msg' },
    contact_created: { texto: 'Contato criado', classe: 'contato' },
    contact_updated: { texto: 'Contato atualizado', classe: 'contato' },
    tag_updated: { texto: 'Etiqueta', classe: 'contato' }
};

function rotuloEventoWati(tipo) {
    const chave = String(tipo || '').toLowerCase();
    return ROTULOS_EVENTO_WATI[chave] || { texto: chave || 'evento', classe: 'outro' };
}

/* Depois da chegada via SSE, conferimos a lista a cada 15s: assim eventos
   que não geram notificação (ex.: campanha em andamento) também aparecem. */
function iniciarAtividadeWati() {
    carregarAtividadeWati();
    pararAtividadeWati();
    timerAtividadeWati = setInterval(() => carregarAtividadeWati(), 15000);
}

function pararAtividadeWati() {
    if (timerAtividadeWati) {
        clearInterval(timerAtividadeWati);
        timerAtividadeWati = null;
    }
}

async function carregarAtividadeWati(filtro) {
    if (filtro !== undefined) filtroEventosWati = filtro;

    const corpo = $('tabela-wati');
    if (!corpo) return;

    const parametros = new URLSearchParams({ limite: 200 });
    if (filtroEventosWati) parametros.set('filtro', filtroEventosWati);

    try {
        const resposta = await fetch('/api/wati/eventos?' + parametros.toString());
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const eventos = await resposta.json();
        const resumo = $('wati-resumo');

        if (!Array.isArray(eventos) || !eventos.length) {
            if (resumo) resumo.textContent = 'Nenhum evento ainda';
            corpo.innerHTML = '<tr><td colspan="5" class="vazio">Nada recebido da Wati ainda. Confira em Canais se o webhook está cadastrado na Wati apontando para a URL segura.</td></tr>';
            return;
        }

        if (resumo) {
            resumo.textContent = `${eventos.length} evento${eventos.length > 1 ? 's' : ''}` +
                (filtroEventosWati ? ` · ${filtroEventosWati}` : '');
        }

        corpo.innerHTML = eventos.map((evento) => {
            const rotulo = rotuloEventoWati(evento.tipo);

            const contato = evento.nome
                ? `${escaparHtml(evento.nome)}<br><small>${escaparHtml(formatarTelefone(evento.telefone))}</small>`
                : escaparHtml(formatarTelefone(evento.telefone));

            const detalhe = evento.texto
                ? escaparHtml(String(evento.texto).substring(0, 140))
                : escaparHtml(evento.status || (evento.whatsapp_message_id ? 'id ' + evento.whatsapp_message_id : '—'));

            return `
                <tr>
                    <td>${escaparHtml(formatarData(evento.criado_em))}</td>
                    <td><span class="wati-badge ${rotulo.classe}">${escaparHtml(rotulo.texto)}</span></td>
                    <td>${contato}</td>
                    <td>${escaparHtml(evento.campanha || '—')}</td>
                    <td>${detalhe}</td>
                </tr>`;
        }).join('');
    } catch (erro) {
        corpo.innerHTML = '<tr><td colspan="5" class="vazio">Erro ao carregar a atividade da Wati.</td></tr>';
    }
}

/* =========================================================
   PARTE 14 - USUÁRIOS
   ========================================================= */

async function carregarUsuarios() {
    const corpo = $('tabela-usuarios');
    if (!corpo) return;

    try {
        const resposta = await fetch('/api/usuarios');
        if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

        const usuarios = await resposta.json();
        if (!Array.isArray(usuarios) || !usuarios.length) {
            corpo.innerHTML = '<tr><td colspan="5" class="vazio">Nenhum usuário cadastrado.</td></tr>';
            return;
        }

        corpo.innerHTML = '';

        usuarios.forEach((usuario) => {
            const linha = document.createElement('tr');
            const ativo = usuario.ativo !== false;

            linha.innerHTML = `
                <td>${escaparHtml(usuario.nome || '-')}</td>
                <td>${escaparHtml(usuario.email || '-')}</td>
                <td>${usuario.role === 'admin' ? 'Administrador' : 'Colaborador'}</td>
                <td><span class="mini-badge ${ativo ? 'status-vendido' : 'status-nao-quis'}">${ativo ? 'Ativo' : 'Inativo'}</span></td>
                <td>
                    <div class="actions-cell">
                        <button class="btn-mini" data-acao="status">${ativo ? 'Desativar' : 'Ativar'}</button>
                        <button class="btn-mini" data-acao="senha">Nova senha</button>
                        <button class="btn-mini" data-acao="excluir">🗑️</button>
                    </div>
                </td>`;

            const [bStatus, bSenha, bExcluir] = linha.querySelectorAll('button');
            bStatus.onclick = () => alternarUsuario(usuario.id, !ativo, bStatus);
            bSenha.onclick = () => trocarSenhaUsuario(usuario, bSenha);
            bExcluir.onclick = () => excluirUsuario(usuario.id, usuario.nome, bExcluir);

            corpo.appendChild(linha);
        });
    } catch (erro) {
        corpo.innerHTML = '<tr><td colspan="5" class="vazio">Erro ao carregar usuários.</td></tr>';
    }
}

async function criarUsuario(botao) {
    const nome = (($('usuario-nome') || {}).value || '').trim();
    const email = (($('usuario-email') || {}).value || '').trim();
    const senha = ($('usuario-senha') || {}).value || '';
    const role = ($('usuario-role') || {}).value || 'colaborador';

    if (!nome) { toast('Informe o nome do usuário.', 'erro'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('Informe um e-mail válido.', 'erro'); return; }
    if (senha.length < 6) { toast('A senha precisa ter pelo menos 6 caracteres.', 'erro'); return; }

    const textoOriginal = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = 'Criando...'; }

    try {
        const resposta = await fetch('/api/usuarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, email, senha, role })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível criar o usuário.', 'erro');
            return;
        }

        toast('Usuário criado.');
        ['usuario-nome', 'usuario-email', 'usuario-senha'].forEach((id) => { if ($(id)) $(id).value = ''; });
        carregarUsuarios();
    } catch (erro) {
        toast('Erro ao criar o usuário.', 'erro');
    } finally {
        if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
    }
}

async function alternarUsuario(id, ativo, botao) {
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/usuarios/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ativo })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível alterar o usuário.', 'erro');
            return;
        }

        toast(ativo ? 'Usuário ativado.' : 'Usuário desativado.');
        carregarUsuarios();
    } catch (erro) {
        toast('Erro ao alterar o usuário.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

async function trocarSenhaUsuario(usuario, botao) {
    const nova = prompt('Nova senha para ' + (usuario.nome || usuario.email) + ' (mínimo 6 caracteres):');
    if (nova === null) return;
    if (String(nova).length < 6) { toast('A senha precisa ter pelo menos 6 caracteres.', 'erro'); return; }

    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/usuarios/' + encodeURIComponent(usuario.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ senha: String(nova) })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível alterar a senha.', 'erro');
            return;
        }

        toast('Senha atualizada.');
    } catch (erro) {
        toast('Erro ao alterar a senha.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

async function excluirUsuario(id, nome, botao) {
    if (!confirm('Excluir o usuário ' + (nome || '') + '? O histórico dele continua na auditoria.')) return;
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/usuarios/' + encodeURIComponent(id), { method: 'DELETE' });
        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível excluir o usuário.', 'erro');
            return;
        }

        toast('Usuário excluído.');
        carregarUsuarios();
    } catch (erro) {
        toast('Erro ao excluir o usuário.', 'erro');
    } finally {
        if (botao) botao.disabled = false;
    }
}

/* =========================================================
   SESSÃO EXPIRADA - volta para o login em qualquer 401
   ========================================================= */
const fetchSemSessao = window.fetch;

window.fetch = async function (...argumentos) {
    const resposta = await fetchSemSessao.apply(this, argumentos);
    const alvo = String(argumentos[0] || '');

    if (resposta.status === 401 && alvo.indexOf('/api/login') === -1 && alvo.indexOf('/api/logout') === -1) {
        window.location.href = '/login';
    }

    return resposta;
};

/* ---------------------------------------------------------
   PROCESSAR LISTA (LISTA SUJA)
   ETL local no navegador: dump bruto -> linhas
   {telefone};{nome};{cnpj} prontas para disparo.
   O parser puro fica em lista-suja.js (carregado antes deste).
   --------------------------------------------------------- */
let listaSuja = {
    registros: 0,
    validos: [],
    prontos: [],
    semTelefone: [],
    descartados: [],
    linhas: [],
    cpfs: [],
    empresas: []
};

function mostrarAbaListaSuja(aba) {
    const paineis = {
        prontos: $('suja-painel-prontos'),
        'sem-telefone': $('suja-painel-sem-telefone'),
        descartados: $('suja-painel-descartados')
    };
    const abas = {
        prontos: $('suja-aba-prontos'),
        'sem-telefone': $('suja-aba-sem-telefone'),
        descartados: $('suja-aba-descartados')
    };

    Object.keys(paineis).forEach((chave) => {
        if (paineis[chave]) paineis[chave].classList.toggle('oculto', chave !== aba);
        if (abas[chave]) abas[chave].classList.toggle('active', chave === aba);
    });
}

function renderizarListaSuja() {
    const abaProntos = $('suja-aba-prontos');
    const abaSemTelefone = $('suja-aba-sem-telefone');
    const abaDescartados = $('suja-aba-descartados');
    const saida = $('suja-saida');
    const cpfs = $('suja-cpfs');
    const corpo = $('tabela-suja-descartados');
    const corpoSem = $('tabela-suja-sem-telefone');

    if (abaProntos) abaProntos.textContent = 'Prontos (' + listaSuja.linhas.length + ')';
    if (abaSemTelefone) abaSemTelefone.textContent = 'Sem telefone (' + listaSuja.semTelefone.length + ')';
    if (abaDescartados) abaDescartados.textContent = 'Descartados (' + listaSuja.descartados.length + ')';
    if (saida) saida.value = listaSuja.linhas.join('\n');
    if (cpfs) cpfs.value = listaSuja.cpfs.join('\n');

    if (corpoSem) {
        if (!listaSuja.semTelefone.length) {
            corpoSem.innerHTML = '<tr><td colspan="4" class="vazio">Nenhum registro sem telefone.</td></tr>';
        } else {
            corpoSem.innerHTML = listaSuja.semTelefone.map((item) => (
                '<tr>' +
                '<td>' + escaparHtml(item.cpfFormatado) + '</td>' +
                '<td>' + escaparHtml(item.nome || '-') + '</td>' +
                '<td>' + escaparHtml(item.cnpj || '-') + '</td>' +
                '<td>' + escaparHtml((item.empresa && item.empresa.razaoSocial) || '-') + '</td>' +
                '</tr>'
            )).join('');
        }
    }

    if (corpo) {
        if (!listaSuja.descartados.length) {
            corpo.innerHTML = '<tr><td colspan="2" class="vazio">Nenhum descarte.</td></tr>';
        } else {
            corpo.innerHTML = listaSuja.descartados.map((item) => (
                '<tr>' +
                '<td><span class="status-badge status-nao-quis">' + escaparHtml(item.motivo) + '</span></td>' +
                '<td><pre class="suja-bruto">' + escaparHtml(item.bruto) + '</pre></td>' +
                '</tr>'
            )).join('');
        }
    }
}

/* Recalcula as abas e a lista final depois de aplicar o extrator. */
function recalcularListaSuja(registros) {
    listaSuja.validos = registros;
    listaSuja.prontos = registros.filter((registro) => (registro.telefones || []).length);
    listaSuja.semTelefone = registros.filter((registro) => !(registro.telefones || []).length);
    listaSuja.linhas = [];
    listaSuja.cpfs = registros.map((registro) => registro.cpfFormatado);

    listaSuja.prontos.forEach((registro) => {
        listaSuja.linhas.push.apply(listaSuja.linhas, linhasDoRegistro(registro));
    });

    renderizarListaSuja();
}

function processarListaSujaPainel() {
    const caixa = $('suja-texto');
    const progresso = $('suja-progresso');

    if (!caixa || !String(caixa.value || '').trim()) {
        toast('Cole a lista bruta antes de processar.', 'erro');
        return;
    }

    const botao = document.querySelector('button[onclick="processarListaSujaPainel()"]');
    if (botao) botao.disabled = true;
    if (progresso) progresso.textContent = 'Processando...';

    /* o setTimeout deixa o estado de loading pintar antes do parse (que é rápido) */
    setTimeout(() => {
        try {
            const resultado = processarListaSuja(caixa.value);

            listaSuja = resultado;
            renderizarListaSuja();

            const partes = [
                resultado.registros + ' registro(s)',
                resultado.linhas.length + ' linha(s) pronta(s)',
                resultado.cpfs.length + ' CPF(s) para o extrator',
                resultado.descartados.length + ' descartado(s)'
            ];

            if (progresso) progresso.textContent = partes.join(' · ') + '.';
            toast(partes.join(' · '), resultado.descartados.length ? 'erro' : undefined);
            mostrarAbaListaSuja(resultado.linhas.length ? 'prontos' : (resultado.semTelefone.length ? 'sem-telefone' : 'descartados'));
        } catch (erro) {
            if (progresso) progresso.textContent = erro.message || 'Não foi possível processar a lista.';
            toast(erro.message || 'Não foi possível processar a lista.', 'erro');
        } finally {
            if (botao) botao.disabled = false;
        }
    }, 30);
}

/* Passo 3: aplica o que veio do extrator (colado ou da última consulta do painel). */
function aplicarResultadoExtratorPainel() {
    const caixa = $('suja-extrator');
    const progresso = $('suja-progresso');

    if (!listaSuja.validos.length) {
        toast('Processe a lista do passo 1 antes de aplicar o extrator.', 'erro');
        return;
    }

    if (!caixa || !String(caixa.value || '').trim()) {
        toast('Cole o resultado do extrator no passo 3.', 'erro');
        return;
    }

    try {
        const resultado = aplicarResultadoExtrator(listaSuja.validos, caixa.value);

        recalcularListaSuja(resultado.registros);

        const partes = [
            resultado.aplicados + ' CPF(s) com telefone revelado',
            listaSuja.semTelefone.length + ' sem telefone',
            resultado.naoEncontrados.length + ' linha(s) não casada(s)'
        ];

        if (progresso) progresso.textContent = partes.join(' · ') + '.';
        toast(partes.join(' · '), resultado.naoEncontrados.length ? 'erro' : undefined);
        mostrarAbaListaSuja(listaSuja.linhas.length ? 'prontos' : 'sem-telefone');
    } catch (erro) {
        toast(erro.message || 'Não foi possível aplicar o resultado do extrator.', 'erro');
    }
}

function puxarResultadoExtratorPainel() {
    const resultados = (extratorResultado && extratorResultado.resultados) || [];

    if (!resultados.length) {
        toast('Nenhuma consulta feita no módulo "Consultar CPF" ainda.', 'erro');
        return;
    }

    if (!listaSuja.validos.length) {
        toast('Processe a lista do passo 1 antes.', 'erro');
        return;
    }

    const caixa = $('suja-extrator');
    if (caixa) caixa.value = JSON.stringify({ resultados }, null, 2);

    const resultado = aplicarResultadoExtrator(listaSuja.validos, { resultados });
    recalcularListaSuja(resultado.registros);

    toast(resultado.aplicados + ' CPF(s) casado(s) com a última consulta do painel.');
    mostrarAbaListaSuja(listaSuja.linhas.length ? 'prontos' : 'sem-telefone');
}

/* ---------- passo 2: CPFs para o extrator ---------- */

/* Usa o que está na caixa (o usuário pode apagar CPFs antes de consultar). */
function cpfsDaCaixa() {
    const caixa = $('suja-cpfs');
    const texto = caixa && String(caixa.value || '').trim() ? caixa.value : listaSuja.cpfs.join('\n');

    return texto
        .split(/\r?\n/)
        .map((linha) => linha.trim())
        .filter(Boolean);
}

function baixarArquivoTexto(nome, conteudo, tipo) {
    const blob = new Blob([conteudo], { type: tipo || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    link.href = url;
    link.download = nome.replace('{carimbo}', carimbo);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

async function copiarListaSujaCpfs() {
    const cpfs = cpfsDaCaixa();
    if (!cpfs.length) { toast('Processe a lista antes de copiar os CPFs.', 'erro'); return; }

    const texto = cpfs.join('\n');

    try {
        await navigator.clipboard.writeText(texto);
        toast(cpfs.length + ' CPF(s) copiado(s).');
    } catch (falha) {
        const area = document.createElement('textarea');
        area.value = texto;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        toast(cpfs.length + ' CPF(s) copiado(s).');
    }
}

function baixarListaSujaCpfs() {
    const cpfs = cpfsDaCaixa();
    if (!cpfs.length) { toast('Processe a lista antes de baixar os CPFs.', 'erro'); return; }

    baixarArquivoTexto('cpfs-extrator-{carimbo}.txt', cpfs.join('\r\n') + '\r\n');
    toast(cpfs.length + ' CPF(s) no .txt.');
}

function levarListaSujaParaExtrator() {
    const cpfs = cpfsDaCaixa();
    if (!cpfs.length) { toast('Processe a lista antes de levar os CPFs.', 'erro'); return; }

    const caixa = $('extrator-texto');
    if (!caixa) { toast('Abra a tela "Consultar CPF".', 'erro'); return; }

    caixa.value = cpfs.join('\n');
    irPara('extrator');
    toast(cpfs.length + ' CPF(s) na tela de Consultar CPF (máximo 25 por consulta).');
}

async function copiarListaSuja() {
    if (!listaSuja.linhas.length) { toast('Processe a lista antes de copiar.', 'erro'); return; }

    const texto = listaSuja.linhas.join('\n');

    try {
        await navigator.clipboard.writeText(texto);
        toast(listaSuja.linhas.length + ' linha(s) copiada(s).');
    } catch (falha) {
        const area = document.createElement('textarea');
        area.value = texto;
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
        toast(listaSuja.linhas.length + ' linha(s) copiada(s).');
    }
}

function baixarListaSuja() {
    if (!listaSuja.linhas.length) { toast('Processe a lista antes de baixar.', 'erro'); return; }

    const blob = new Blob([listaSuja.linhas.join('\r\n') + '\r\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const carimbo = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

    link.href = url;
    link.download = 'lista-limpa-' + carimbo + '.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    toast(listaSuja.linhas.length + ' linha(s) no .txt.');
}

function usarListaSujaNaImportacao() {
    if (!listaSuja.linhas.length) { toast('Processe a lista antes de importar.', 'erro'); return; }

    const caixa = $('lista-texto');
    if (!caixa) { toast('Abra a tela de importação de listas.', 'erro'); return; }

    /* As linhas já saem como telefone;nome;cnpj. O cabeçalho {{1}}/{{2}}
       deixa o painel ligar nome e CNPJ nas variáveis do template. */
    caixa.value = ['telefone;{{1}};{{2}}'].concat(listaSuja.linhas).join('\n');

    irPara('listas');
    analisarLista();
    abrirImportacaoLista();
    toast(listaSuja.linhas.length + ' linha(s) na importação ({{1}} = nome, {{2}} = CNPJ).');
}

/* Mesma lista, mas com os dados da empresa/persona nas colunas extras:
   viram atributos do cliente (a ficha do painel já mostra clientes.atributos). */
function usarListaSujaNaImportacaoComEmpresa() {
    if (!listaSuja.linhas.length) { toast('Processe a lista antes de importar.', 'erro'); return; }

    const caixa = $('lista-texto');
    if (!caixa) { toast('Abra a tela de importação de listas.', 'erro'); return; }

    const montado = montarLinhasComEmpresa(listaSuja.validos);
    caixa.value = [montado.cabecalho].concat(montado.linhas).join('\n');

    irPara('listas');
    analisarLista();
    abrirImportacaoLista();
    toast(montado.linhas.length + ' linha(s) com os dados da empresa (ficha do cliente).');
}

function baixarCadastroListaSuja() {
    if (!listaSuja.validos.length) { toast('Processe a lista antes de baixar o cadastro.', 'erro'); return; }

    const cadastro = montarCadastroCsv(listaSuja.validos);
    const conteudo = [cadastro.colunas.join(';')].concat(cadastro.linhas).join('\r\n') + '\r\n';

    baixarArquivoTexto('cadastro-empresas-{carimbo}.csv', '\uFEFF' + conteudo, 'text/csv;charset=utf-8');
    toast(cadastro.linhas.length + ' empresa(s) no .csv.');
}

function limparListaSuja() {
    ['suja-texto', 'suja-saida', 'suja-cpfs', 'suja-extrator'].forEach((id) => {
        const campo = $(id);
        if (campo) campo.value = '';
    });

    const progresso = $('suja-progresso');
    if (progresso) progresso.textContent = '';

    listaSuja = {
        registros: 0,
        validos: [],
        prontos: [],
        semTelefone: [],
        descartados: [],
        linhas: [],
        cpfs: [],
        empresas: []
    };

    renderizarListaSuja();
    mostrarAbaListaSuja('prontos');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarPainel);
} else {
    iniciarPainel();
}


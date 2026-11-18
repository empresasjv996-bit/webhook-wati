/* =========================================================
   QGC TEAM - Painel Administrativo
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
    const titulos = {
        campanhas: 'Campanhas',
        canais: 'Canais',
        logs: 'Logs',
        auditoria: 'Auditoria',
        usuarios: 'Usuários'
    };

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

    if (view === 'inicio') carregarDashboard();
    if (view === 'conversas') carregarConversas(true);
    if (view === 'clientes') carregarTabelaClientes();
    if (view === 'listas') carregarListas();
    if (view === 'canais') carregarCanais();
    if (view === 'campanhas') { carregarListasCampanha(); carregarCampanhas(); }
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
            bolha.innerHTML = '<p>' + escaparHtml(msg.texto) + '</p><span>' + escaparHtml(formatarData(msg.criado_em)) + '</span>';
            area.appendChild(bolha);
        });

        area.scrollTop = area.scrollHeight;
    } catch (erro) {
        console.error('Erro ao carregar mensagens:', erro);
        area.innerHTML = '<p class="vazio">Erro ao carregar o histórico.</p>';
    }
}

function adicionarMensagemNaTela(direcao, texto) {
    const area = $('messages');
    if (!area) return;

    const vazio = area.querySelector('.vazio');
    if (vazio) vazio.remove();

    const bolha = document.createElement('div');
    bolha.className = 'message ' + (direcao === 'enviada' ? 'sent' : 'received');
    bolha.innerHTML = '<p>' + escaparHtml(texto) + '</p><span>' + escaparHtml(formatarData(new Date().toISOString())) + '</span>';
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
            adicionarMensagemNaTela('enviada', texto);
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
            corpo.innerHTML = '<tr><td colspan="6" class="vazio">Nenhum cliente encontrado.</td></tr>';
            return;
        }

        clientes.forEach((cliente) => {
            const linha = document.createElement('tr');
            linha.innerHTML = `
                <td>${escaparHtml(cliente.nome || '-')}</td>
                <td>${escaparHtml(formatarTelefone(cliente.telefone))}</td>
                <td>${escaparHtml(cliente.mensagem || '-')}</td>
                <td><span class="mini-badge ${STATUS_CLASSE[cliente.status] || ''}">${escaparHtml(STATUS_LABEL[cliente.status] || cliente.status || '-')}</span></td>
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

        const outros = Array.isArray(ficha.outros_socios) ? ficha.outros_socios : [];
        const linhas = outros.map((item) => {
            if (item && typeof item === 'object') return [item.nome, item.cpf].filter(Boolean).join(' - ');
            return String(item || '');
        }).filter(Boolean);

        const textarea = $('ficha-outros');
        if (textarea) textarea.value = linhas.join('\n');

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
        'FICHA - QGC TEAM',
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

function interpretarLinhaContato(linha) {
    const limpa = String(linha || '').trim();
    if (!limpa) return null;

    const partes = limpa.split(/[;,\t]/).map((parte) => parte.trim()).filter(Boolean);
    if (!partes.length) return null;

    const indiceTelefone = partes.findIndex((parte) => parte.replace(/\D/g, '').length >= 10);
    if (indiceTelefone < 0) return null;

    const telefone = partes[indiceTelefone].replace(/\D/g, '');
    if (telefone.length < 10) return null;

    const nome = partes.filter((parte, indice) => indice !== indiceTelefone).join(' ').trim();
    return { telefone, nome };
}

function lerArquivoLista(input) {
    const arquivo = input && input.files && input.files[0];
    if (!arquivo) return;

    const leitor = new FileReader();

    leitor.onload = () => {
        const campo = $('lista-texto');
        if (!campo) return;

        const conteudo = String(leitor.result || '').trim();
        const atual = campo.value.trim();
        campo.value = atual ? atual + '\n' + conteudo : conteudo;
        toast('Arquivo carregado: ' + arquivo.name);
    };

    leitor.onerror = () => toast('Não foi possível ler o arquivo.', 'erro');
    leitor.readAsText(arquivo, 'UTF-8');
}

async function salvarLista() {
    const campoNome = $('lista-nome');
    const campoTexto = $('lista-texto');
    const nome = (campoNome ? campoNome.value : '').trim();
    const texto = (campoTexto ? campoTexto.value : '');

    if (!nome) { toast('Informe um nome para a lista.', 'erro'); return; }

    const contatos = texto.split(/\r?\n/).map(interpretarLinhaContato).filter(Boolean);
    if (!contatos.length) { toast('Nenhum telefone válido encontrado.', 'erro'); return; }

    const botao = document.querySelector('button[onclick="salvarLista()"]');
    if (botao) botao.disabled = true;

    try {
        const resposta = await fetch('/api/listas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, contatos })
        });

        const retorno = await resposta.json().catch(() => ({}));
        if (!resposta.ok || !retorno.success) throw new Error(retorno.message || ('HTTP ' + resposta.status));

        toast('Lista "' + nome + '" importada com ' + retorno.total + ' contato(s).');
        if (campoNome) campoNome.value = '';
        if (campoTexto) campoTexto.value = '';
        const arquivo = $('lista-arquivo');
        if (arquivo) arquivo.value = '';

        carregarListas();
        carregarDashboard();
    } catch (erro) {
        console.error('Erro ao salvar lista:', erro);
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
}

function iniciarPainel() {
    carregarUsuario();
    carregarDashboard();
    atualizarBotoesAudio();
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

/* =========================================================
   PARTE 12 - CAMPANHAS
   ========================================================= */

let filtroLogs = '';

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
            return;
        }

        const anterior = select.value;
        select.innerHTML = '<option value="">Selecione a lista...</option>' + listas.map((lista) =>
            `<option value="${escaparHtml(lista.id)}">${escaparHtml(lista.nome)} (${Number(lista.total) || 0} contatos)</option>`
        ).join('');

        if (anterior) select.value = anterior;
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
                    <small>${escaparHtml(mensagem.slice(0, 90))}${mensagem.length > 90 ? '…' : ''}</small>
                </div>
                <span class="campanha-status ${escaparHtml(status)}">${escaparHtml(rotuloStatusCampanha(status))}</span>
            </div>

            <div class="progresso"><span style="width: ${percentual}%"></span></div>

            <div class="campanha-numeros">
                <span><strong>${enviados}</strong>/${total} enviados</span>
                <span>${falhas} falha(s)</span>
                <span>${percentual}%</span>
            </div>

            <div class="campanha-acoes">${botoes.join('')}</div>
        </div>`;
}

async function carregarCampanhas() {
    const container = $('campanhas-lista');
    if (!container) return;

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
        });
    } catch (erro) {
        container.innerHTML = '<p class="vazio">Não foi possível carregar as campanhas.</p>';
    }
}

async function criarCampanha(botao) {
    const nome = (($('campanha-nome') || {}).value || '').trim();
    const listaId = ($('campanha-lista') || {}).value || '';
    const mensagem = (($('campanha-mensagem') || {}).value || '').trim();
    const intervalo = ($('campanha-intervalo') || {}).value || '8000';

    if (!nome) { toast('Informe o nome da campanha.', 'erro'); return; }
    if (!listaId) { toast('Escolha a lista de contatos.', 'erro'); return; }
    if (!mensagem) { toast('Escreva a mensagem da campanha.', 'erro'); return; }

    const textoOriginal = botao ? botao.textContent : '';
    if (botao) { botao.disabled = true; botao.textContent = 'Criando...'; }

    try {
        const resposta = await fetch('/api/campanhas', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nome, listaId, mensagem, intervalo: Number(intervalo) })
        });

        let dados = {};
        try { dados = await resposta.json(); } catch (erro) { dados = {}; }

        if (!resposta.ok || !dados.success) {
            toast(dados.message || 'Não foi possível criar a campanha.', 'erro');
            return;
        }

        toast(`Campanha criada com ${dados.total} contato(s). Envio iniciado.`);
        if ($('campanha-nome')) $('campanha-nome').value = '';
        if ($('campanha-mensagem')) $('campanha-mensagem').value = '';
        carregarCampanhas();
    } catch (erro) {
        toast('Erro ao criar a campanha.', 'erro');
    } finally {
        if (botao) { botao.disabled = false; botao.textContent = textoOriginal; }
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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarPainel);
} else {
    iniciarPainel();
}


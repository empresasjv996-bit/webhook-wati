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

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarPainel);
} else {
    iniciarPainel();
}


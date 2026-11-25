/* =========================================================
   QGC TEAM by JV - Painel do colaborador
   - mostra apenas os leads da carteira do usuário logado
   - carrega o histórico completo da conversa
   - atualiza a lista/mensagens por polling (SSE é só admin)
   ========================================================= */
(function () {
    'use strict';

    let clienteAtivo = null;
    let clientesCache = [];
    let filtroAtual = 'ativos';
    let buscaAtual = '';
    let timerBusca = null;
    let sequenciaLista = 0;

    function $(id) { return document.getElementById(id); }

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
        if (num.length === 13) return '+' + num.slice(0, 2) + ' (' + num.slice(2, 4) + ') ' + num.slice(4, 9) + '-' + num.slice(9);
        if (num.length === 12) return '+' + num.slice(0, 2) + ' (' + num.slice(2, 4) + ') ' + num.slice(4, 8) + '-' + num.slice(8);
        if (num.length === 11) return '(' + num.slice(0, 2) + ') ' + num.slice(2, 7) + '-' + num.slice(7);
        return num || telefone || '-';
    }

    function formatarData(valor) {
        if (!valor) return '';
        const data = new Date(valor);
        if (isNaN(data.getTime())) return '';
        return data.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }

    /* O servidor pode devolver o motivo da recusa como texto ou como objeto
       (erros da Wati/Meta vêm aninhados). Sem isso o alert virava
       "[object Object]" e escondia a causa real da falha. */
    function mensagemDoErro(dados, padrao) {
        const valores = dados ? [dados.message, dados.erro, dados.error, dados.aviso] : [];

        for (let i = 0; i < valores.length; i++) {
            const valor = valores[i];

            if (typeof valor === 'string' && valor.trim()) return valor.trim();
            if (typeof valor === 'number') return String(valor);

            if (valor && typeof valor === 'object') {
                try {
                    const texto = JSON.stringify(valor);
                    if (texto && texto !== '{}') return texto;
                } catch (erro) { /* cai no padrão */ }
            }
        }

        return padrao;
    }

    function iniciais(nome) {
        const limpo = String(nome || '?').trim();
        const partes = limpo.split(/\s+/).filter(Boolean);
        if (partes.length >= 2) return (partes[0][0] + partes[1][0]).toUpperCase();
        return limpo.substring(0, 2).toUpperCase();
    }

    /* Dados da empresa/persona importados na lista (clientes.atributos).
       É o que a Lista Suja manda em "Enviar com dados da empresa". */
    const ROTULOS_FICHA = {
        cnpj: 'CNPJ',
        razao_social: 'Razão social',
        nome_fantasia: 'Nome fantasia',
        situacao: 'Situação',
        porte: 'Porte',
        capital_social: 'Capital social',
        inicio_atividade: 'Início atividade',
        logradouro: 'Logradouro',
        bairro: 'Bairro',
        cidade: 'Cidade',
        uf: 'UF',
        cep: 'CEP',
        tel_empresa_1: 'Tel. empresa 1',
        tel_empresa_2: 'Tel. empresa 2',
        email_empresa: 'E-mail empresa',
        cpf: 'CPF',
        nascimento: 'Nascimento',
        nome_mae: 'Nome da mãe',
        sexo: 'Sexo',
        email: 'E-mail',
        endereco: 'Endereço',
        socios: 'Sócios',
        socio: 'Sócio',
        responsavel: 'Responsável',
        ag_conta: 'Agência / conta'
    };

    const ORDEM_FICHA = [
        'razao_social', 'nome_fantasia', 'cnpj', 'situacao', 'porte', 'capital_social',
        'inicio_atividade', 'logradouro', 'bairro', 'cidade', 'uf', 'cep',
        'tel_empresa_1', 'tel_empresa_2', 'email_empresa', 'socio', 'socios',
        'cpf', 'nascimento', 'nome_mae', 'sexo', 'email', 'endereco', 'ag_conta', 'responsavel'
    ];

    function ordemFicha(chave) {
        const indice = ORDEM_FICHA.indexOf(chave);
        return indice < 0 ? ORDEM_FICHA.length : indice;
    }

    function renderizarAtributosFicha(ficha) {
        const lista = $('ficha-atributos');
        if (!lista) return;

        const dados = Object.assign({}, (ficha && ficha.atributos) || {});
        if (ficha && ficha.cnpj) dados.cnpj = ficha.cnpj;
        if (ficha && ficha.cpf) dados.cpf = ficha.cpf;
        if (ficha && ficha.socio) dados.socio = ficha.socio;
        if (ficha && ficha.responsavel) dados.responsavel = ficha.responsavel;

        const chaves = Object.keys(dados)
            .filter((chave) => String(dados[chave] == null ? '' : dados[chave]).trim())
            .sort((a, b) => ordemFicha(a) - ordemFicha(b) || a.localeCompare(b));

        lista.innerHTML = chaves.length
            ? chaves.map((chave) => (
                '<li><span>' + escaparHtml(ROTULOS_FICHA[chave] || chave) + '</span>' +
                '<strong>' + escaparHtml(dados[chave]) + '</strong></li>'
            )).join('')
            : '<li><span>Nenhum dado da empresa importado</span></li>';
    }

    function rotuloMensagem(msg) {
        const data = formatarData(msg.criado_em);
        if (msg.direcao !== 'enviada') return data;

        const autor = String(msg.autor_nome || '').trim();
        if (msg.origem === 'campanha') return ['Campanha' + (autor ? ' · ' + autor : ''), data].filter(Boolean).join(' · ');
        return [autor || 'Você', data].filter(Boolean).join(' · ');
    }

    /* Qualquer 401 volta para o login. */
    const fetchOriginal = window.fetch;
    window.fetch = async function (...argumentos) {
        const resposta = await fetchOriginal.apply(this, argumentos);
        if (resposta.status === 401) window.location.href = '/login';
        return resposta;
    };

    async function carregarUsuario() {
        try {
            const resposta = await fetch('/api/me');
            if (!resposta.ok) return;
            const dados = await resposta.json();
            const nome = $('nome-atendente');
            const avatar = $('avatar-atendente');
            if (nome) nome.textContent = dados.nome || 'Atendente';
            if (avatar) avatar.textContent = String(dados.nome || '?').charAt(0).toUpperCase();
        } catch (erro) { console.error('Erro ao carregar usuário:', erro); }
    }

    function parametrosDaLista() {
        const parametros = new URLSearchParams();
        parametros.set('limite', '200');
        parametros.set('status', filtroAtual === 'finalizados' ? 'finalizado' : (filtroAtual === 'todos' ? 'todos' : 'ativos'));
        if (buscaAtual) parametros.set('busca', buscaAtual);
        return parametros;
    }

    function marcarItemAtivo() {
        document.querySelectorAll('.contact-item').forEach((el) => {
            el.classList.toggle('active', !!clienteAtivo && el.dataset.telefone === clienteAtivo.telefone);
        });
    }

    function renderizarLista() {
        const lista = $('lista-contatos');
        if (!lista) return;

        lista.innerHTML = '';

        if (!clientesCache.length) {
            const vazio = document.createElement('p');
            vazio.style.cssText = 'padding:20px; color:var(--text-muted); text-align:center;';
            vazio.textContent = buscaAtual
                ? 'Nenhum contato encontrado para esta busca.'
                : (filtroAtual === 'finalizados' ? 'Nenhum atendimento finalizado.' : 'Nenhum lead na sua carteira.');
            lista.appendChild(vazio);
            return;
        }

        clientesCache.forEach((cliente) => {
            const item = document.createElement('div');
            item.className = 'contact-item' + (clienteAtivo && clienteAtivo.telefone === cliente.telefone ? ' active' : '');
            item.dataset.telefone = cliente.telefone;
            item.innerHTML = `
                <div class="avatar">${escaparHtml(iniciais(cliente.nome))}</div>
                <div class="contact-info">
                    <h4>${escaparHtml(cliente.nome || 'Sem nome')}</h4>
                    <p>${escaparHtml(cliente.mensagem || 'Sem mensagem')}</p>
                </div>
            `;
            item.addEventListener('click', () => abrirCliente(cliente));
            lista.appendChild(item);
        });
    }

    function limparSelecao() {
        clienteAtivo = null;

        const nome = $('chat-nome');
        if (nome) nome.textContent = 'Nenhum cliente';
        const telefone = $('chat-telefone');
        if (telefone) telefone.textContent = 'Selecione um contato';
        const avatar = $('chat-avatar');
        if (avatar) avatar.textContent = '?';
        const fichaNome = $('ficha-nome');
        if (fichaNome) fichaNome.textContent = '-';
        const fichaTelefone = $('ficha-telefone');
        if (fichaTelefone) fichaTelefone.textContent = '-';
        const area = $('mensagens');
        if (area) area.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:20px;">Nenhuma conversa selecionada.</p>';

        marcarItemAtivo();
    }

    async function carregarClientes(manterSelecao, silencioso) {
        const minhaSequencia = ++sequenciaLista;

        try {
            const resposta = await fetch('/api/clientes?' + parametrosDaLista().toString());
            if (!resposta.ok) throw new Error('HTTP ' + resposta.status);
            if (minhaSequencia !== sequenciaLista) return;

            const dados = await resposta.json();
            clientesCache = Array.isArray(dados) ? dados : [];

            renderizarLista();

            const atual = clienteAtivo && clientesCache.find((c) => c.telefone === clienteAtivo.telefone);

            if (manterSelecao && atual) {
                clienteAtivo.nome = atual.nome;
                marcarItemAtivo();
                return;
            }

            if (silencioso) {
                if (!clientesCache.length) limparSelecao();
                return;
            }

            if (clientesCache.length) await abrirCliente(clientesCache[0]);
            else limparSelecao();
        } catch (erro) {
            console.error('Erro ao carregar clientes:', erro);
            if (!silencioso) {
                const lista = $('lista-contatos');
                if (lista) lista.innerHTML = '<p style="padding:20px; color:var(--text-muted); text-align:center;">Erro ao carregar seus contatos.</p>';
            }
        }
    }

    async function carregarMensagens(telefone, forcarScroll) {
        const area = $('mensagens');
        if (!area) return;

        try {
            const resposta = await fetch('/api/clientes/' + encodeURIComponent(telefone) + '/mensagens');

            if (resposta.status === 403) {
                alert('Este contato não está na sua carteira.');
                await carregarClientes(false);
                return;
            }
            if (!resposta.ok) throw new Error('HTTP ' + resposta.status);

            const mensagens = await resposta.json();
            const estavaNoFim = area.scrollHeight - area.scrollTop - area.clientHeight < 90;

            area.innerHTML = '';

            if (!Array.isArray(mensagens) || !mensagens.length) {
                area.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:20px;">Nenhuma mensagem registrada ainda.</p>';
                return;
            }

            mensagens.forEach((msg) => {
                const bolha = document.createElement('div');
                bolha.className = 'message ' + (msg.direcao === 'enviada' ? 'sent' : 'received');
                bolha.innerHTML = '<p>' + escaparHtml(msg.texto) + '</p><span>' + escaparHtml(rotuloMensagem(msg)) + '</span>';
                area.appendChild(bolha);
            });

            if (forcarScroll || estavaNoFim) area.scrollTop = area.scrollHeight;
        } catch (erro) {
            console.error('Erro ao carregar mensagens:', erro);
            area.innerHTML = '<p style="color:var(--text-muted); text-align:center; padding:20px;">Erro ao carregar o histórico.</p>';
        }
    }

    async function carregarFicha(telefone) {
        try {
            const resposta = await fetch('/api/clientes/' + encodeURIComponent(telefone) + '/ficha');
            if (!resposta.ok) return;

            const ficha = await resposta.json();
            if (!clienteAtivo || clienteAtivo.telefone !== telefone) return;

            const nome = $('ficha-nome');
            if (nome) nome.textContent = ficha.nome || clienteAtivo.nome || '-';
            const fone = $('ficha-telefone');
            if (fone) fone.textContent = formatarTelefone(ficha.telefone || telefone);

            const chatNome = $('chat-nome');
            if (chatNome && ficha.nome) chatNome.textContent = ficha.nome;

            renderizarAtributosFicha(ficha);
        } catch (erro) {
            console.error('Erro ao carregar ficha:', erro);
        }
    }

    async function abrirCliente(cliente) {
        if (!cliente || !cliente.telefone) return;

        clienteAtivo = {
            telefone: cliente.telefone,
            nome: cliente.nome || 'Contato'
        };

        marcarItemAtivo();

        const nome = $('chat-nome');
        if (nome) nome.textContent = clienteAtivo.nome;
        const telefone = $('chat-telefone');
        if (telefone) telefone.textContent = formatarTelefone(clienteAtivo.telefone);
        const avatar = $('chat-avatar');
        if (avatar) avatar.textContent = iniciais(clienteAtivo.nome);

        const fichaNome = $('ficha-nome');
        if (fichaNome) fichaNome.textContent = clienteAtivo.nome;
        const fichaTelefone = $('ficha-telefone');
        if (fichaTelefone) fichaTelefone.textContent = formatarTelefone(clienteAtivo.telefone);

        const listaAtributos = $('ficha-atributos');
        if (listaAtributos) listaAtributos.innerHTML = '<li><span>Carregando...</span></li>';

        await carregarMensagens(clienteAtivo.telefone, true);
        await carregarFicha(clienteAtivo.telefone);
    }

    async function enviarMensagem() {
        const input = $('input-mensagem');
        if (!input || !clienteAtivo) return;

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
            if (!resposta.ok || dados.success === false) {
                throw new Error(mensagemDoErro(dados, 'A Wati recusou o envio.'));
            }

            input.value = '';
            await carregarMensagens(clienteAtivo.telefone, true);
            await carregarClientes(true, true);
        } catch (erro) {
            alert(mensagemDoErro(erro, 'Erro ao enviar a mensagem.'));
        } finally {
            if (botao) botao.disabled = false;
            input.focus();
        }
    }

    async function finalizarAtendimento() {
        if (!clienteAtivo) return;
        if (!confirm('Finalizar o atendimento de ' + clienteAtivo.nome + '?')) return;

        try {
            const resposta = await fetch('/api/finalizar', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ telefone: clienteAtivo.telefone })
            });

            const dados = await resposta.json().catch(() => ({}));
            if (!resposta.ok || dados.success === false) {
                throw new Error(mensagemDoErro(dados, 'Não foi possível finalizar.'));
            }

            clienteAtivo = null;
            await carregarClientes(false);
        } catch (erro) {
            alert(mensagemDoErro(erro, 'Erro ao finalizar o atendimento.'));
        }
    }

    function iniciar() {
        // Funções chamadas pelos onclick do HTML
        window.enviarMensagem = enviarMensagem;
        window.finalizarAtendimento = finalizarAtendimento;

        document.querySelectorAll('.filters button').forEach((botao) => {
            botao.addEventListener('click', () => {
                document.querySelectorAll('.filters button').forEach((b) => b.classList.remove('active'));
                botao.classList.add('active');
                filtroAtual = botao.dataset.filtro || 'ativos';
                carregarClientes(false);
            });
        });

        const busca = $('busca-contatos');
        if (busca) {
            busca.addEventListener('input', () => {
                buscaAtual = busca.value.trim();
                clearTimeout(timerBusca);
                timerBusca = setTimeout(() => carregarClientes(true), 350);
            });
        }

        const campo = $('input-mensagem');
        if (campo) {
            campo.addEventListener('keypress', (evento) => {
                if (evento.key === 'Enter') {
                    evento.preventDefault();
                    enviarMensagem();
                }
            });
        }

        carregarUsuario();
        carregarClientes(false);

        // Atualização periódica (o SSE é restrito ao admin)
        setInterval(async () => {
            if (document.hidden) return;
            await carregarClientes(true, true);
            if (clienteAtivo) await carregarMensagens(clienteAtivo.telefone, false);
        }, 12000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', iniciar);
    } else {
        iniciar();
    }
})();

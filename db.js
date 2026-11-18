/* =========================================================
   QGC TEAM - Camada de dados
   ---------------------------------------------------------
   - Em produção (Render) usa o Postgres do DATABASE_URL.
   - Sem DATABASE_URL válida, cai automaticamente no modo demo
     (banco em memória com dados de exemplo), permitindo rodar
     o painel localmente com `npm start` sem instalar Postgres.
   ========================================================= */

'use strict';

const { Pool } = require('pg');

// Carrega o .env local sem depender do pacote dotenv (Node 20.12+).
if (!process.env.DATABASE_URL && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (erro) { /* .env é opcional */ }
}

const DATABASE_URL = process.env.DATABASE_URL || '';
const URL_INVALIDA = !DATABASE_URL || /xxxxxx|placeholder|exemplo|example/i.test(DATABASE_URL);
const MODO_DEMO = process.env.MODO_DEMO === '1' || URL_INVALIDA;

/* ---------------------------------------------------------
   POSTGRES (produção)
   --------------------------------------------------------- */
function criarBancoPostgres() {
    const pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    return {
        async prepararBanco() {
            const comandos = [
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ DEFAULT NOW()',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS mensagem TEXT',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cnpj TEXT',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS socio TEXT',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cpf TEXT',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS responsavel TEXT',
                "ALTER TABLE clientes ADD COLUMN IF NOT EXISTS outros_socios JSONB DEFAULT '[]'::jsonb",
                `CREATE TABLE IF NOT EXISTS mensagens (
                    id SERIAL PRIMARY KEY,
                    telefone TEXT NOT NULL,
                    direcao TEXT NOT NULL DEFAULT 'recebida',
                    texto TEXT NOT NULL,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                'CREATE INDEX IF NOT EXISTS idx_mensagens_telefone ON mensagens (telefone)',
                `CREATE TABLE IF NOT EXISTS listas (
                    id SERIAL PRIMARY KEY,
                    nome TEXT NOT NULL,
                    total INTEGER NOT NULL DEFAULT 0,
                    contatos JSONB NOT NULL DEFAULT '[]'::jsonb,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`
            ];

            for (const comando of comandos) {
                try { await pool.query(comando); }
                catch (erro) { console.warn('Banco (estrutura):', erro.message); }
            }
            console.log('Estrutura do banco verificada.');
        },

        async listarClientes({ status, busca, limite }) {
            const filtros = [];
            const valores = [];

            if (status === 'ativos') filtros.push("status <> 'finalizado'");
            else if (status === 'finalizado') filtros.push("status = 'finalizado'");

            if (busca) {
                valores.push(`%${busca}%`);
                filtros.push(`(nome ILIKE $${valores.length} OR telefone ILIKE $${valores.length})`);
            }

            valores.push(limite);
            const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

            const { rows } = await pool.query(
                `SELECT nome, telefone, mensagem, status, criado_em FROM clientes ${where} ORDER BY criado_em DESC NULLS LAST LIMIT $${valores.length}`,
                valores
            );
            return rows;
        },

        async contarPorStatus() {
            const { rows } = await pool.query('SELECT status, COUNT(*)::int AS total FROM clientes GROUP BY status');
            const counts = { vendido: 0, pensando: 0, 'nao-quis': 0, finalizado: 0 };
            rows.forEach((linha) => {
                if (counts[linha.status] !== undefined) counts[linha.status] = linha.total;
            });
            return counts;
        },

        async resumoDashboard() {
            const resumo = {
                clientes: 0, conversasAtivas: 0, listas: 0, mensagensHoje: 0,
                vendido: 0, pensando: 0, 'nao-quis': 0, finalizado: 0
            };

            try {
                const porStatus = await pool.query('SELECT status, COUNT(*)::int AS total FROM clientes GROUP BY status');
                porStatus.rows.forEach((linha) => {
                    if (resumo[linha.status] !== undefined) resumo[linha.status] = linha.total;
                    resumo.clientes += linha.total;
                    if (linha.status !== 'finalizado') resumo.conversasAtivas += linha.total;
                });
            } catch (erro) { console.error('Dashboard (clientes):', erro.message); }

            try {
                const listas = await pool.query('SELECT COUNT(*)::int AS total FROM listas');
                resumo.listas = listas.rows[0].total;
            } catch (erro) { console.error('Dashboard (listas):', erro.message); }

            try {
                const hoje = await pool.query('SELECT COUNT(*)::int AS total FROM mensagens WHERE criado_em >= CURRENT_DATE');
                resumo.mensagensHoje = hoje.rows[0].total;
            } catch (erro) { console.error('Dashboard (mensagens):', erro.message); }

            return resumo;
        },


        async obterFicha(telefone) {
            const { rows } = await pool.query(
                'SELECT nome, telefone, cnpj, socio, cpf, responsavel, outros_socios, status, mensagem FROM clientes WHERE telefone = $1',
                [telefone]
            );
            return rows[0] || null;
        },

        async salvarFicha(telefone, dados) {
            const outros = JSON.stringify(Array.isArray(dados.outros_socios) ? dados.outros_socios : []);
            const resultado = await pool.query(
                `UPDATE clientes
                    SET cnpj = $1, socio = $2, cpf = $3, responsavel = $4, outros_socios = $5::jsonb
                  WHERE telefone = $6
                  RETURNING telefone`,
                [dados.cnpj || null, dados.socio || null, dados.cpf || null, dados.responsavel || null, outros, telefone]
            );
            return resultado.rowCount > 0;
        },

        async listarMensagens(telefone) {
            const { rows } = await pool.query(
                'SELECT id, direcao, texto, criado_em FROM mensagens WHERE telefone = $1 ORDER BY criado_em ASC, id ASC LIMIT 300',
                [telefone]
            );
            return rows;
        },

        async registrarMensagem(telefone, direcao, texto) {
            try {
                await pool.query(
                    'INSERT INTO mensagens (telefone, direcao, texto) VALUES ($1, $2, $3)',
                    [telefone, direcao, texto]
                );
            } catch (erro) { console.error('Erro ao salvar mensagem:', erro.message); }
        },

        async atualizarUltimaMensagem(telefone, texto) {
            await pool.query('UPDATE clientes SET mensagem = $1 WHERE telefone = $2', [texto, telefone]);
        },

        async registrarRecebida({ nome, telefone, mensagem }) {
            await pool.query(
                `INSERT INTO clientes (nome, telefone, mensagem, status)
                 VALUES ($1, $2, $3, 'pensando')
                 ON CONFLICT (telefone) DO UPDATE
                 SET mensagem = $3, nome = $1, criado_em = NOW(), status = 'pensando'`,
                [nome, telefone, mensagem]
            );
        },

        async atualizarStatus(telefone, status) {
            await pool.query('UPDATE clientes SET status = $1 WHERE telefone = $2', [status, telefone]);
        },

        async finalizarAtendimento(telefone) {
            await pool.query("UPDATE clientes SET status = 'finalizado' WHERE telefone = $1", [telefone]);
        },

        async listarListas() {
            const { rows } = await pool.query('SELECT id, nome, total, criado_em FROM listas ORDER BY criado_em DESC LIMIT 100');
            return rows;
        },

        async criarLista(nome, contatos) {
            const { rows } = await pool.query(
                'INSERT INTO listas (nome, total, contatos) VALUES ($1, $2, $3::jsonb) RETURNING id',
                [nome, contatos.length, JSON.stringify(contatos)]
            );
            return { id: rows[0].id, total: contatos.length };
        },

        async excluirLista(id) {
            await pool.query('DELETE FROM listas WHERE id = $1', [id]);
        }
    };
}

/* ---------------------------------------------------------
   MEMÓRIA (modo demo - roda local sem Postgres)
   --------------------------------------------------------- */
function criarBancoMemoria() {
    const clientes = new Map();
    const mensagens = [];
    const listas = [];
    let mensagemId = 1;
    let listaId = 1;

    function minutosAtras(minutos) {
        return new Date(Date.now() - minutos * 60 * 1000).toISOString();
    }

    function semearCliente(dados) {
        clientes.set(dados.telefone, Object.assign({
            cnpj: null,
            socio: null,
            cpf: null,
            responsavel: null,
            outros_socios: [],
            mensagem: '',
            status: 'pensando',
            criado_em: minutosAtras(30)
        }, dados));
    }

    function semearMensagem(telefone, direcao, texto, minutos) {
        mensagens.push({
            id: mensagemId++,
            telefone,
            direcao,
            texto,
            criado_em: minutosAtras(minutos)
        });
    }

    /* Dados de exemplo para o painel abrir já com conteúdo */
    semearCliente({
        nome: 'Carlos Mendes', telefone: '5511998887766', status: 'pensando',
        mensagem: 'Boa tarde! Qual o valor do plano?', criado_em: minutosAtras(12),
        cnpj: '12.345.678/0001-90', socio: 'Carlos Mendes', cpf: '123.456.789-00',
        responsavel: 'Claudio', outros_socios: ['Ana Mendes - 987.654.321-00']
    });
    semearCliente({
        nome: 'Maria Oliveira', telefone: '5521987776655', status: 'vendido',
        mensagem: 'Pode mandar o contrato amanhã.', criado_em: minutosAtras(40),
        cnpj: '98.765.432/0001-10', socio: 'Maria Oliveira', cpf: '321.654.987-00',
        responsavel: 'Vendedor Jv', outros_socios: []
    });
    semearCliente({
        nome: 'João Souza', telefone: '5511976665544', status: 'nao-quis',
        mensagem: 'Achei caro, obrigado.', criado_em: minutosAtras(95),
        cnpj: '11.222.333/0001-44', socio: 'João Souza', cpf: '111.222.333-44',
        responsavel: 'Claudio', outros_socios: ['Paulo Souza - 555.666.777-88']
    });
    semearCliente({
        nome: 'Fernanda Lima', telefone: '5511965554433', status: 'finalizado',
        mensagem: 'Muito obrigada pelo atendimento!', criado_em: minutosAtras(180),
        cnpj: null, socio: 'Fernanda Lima', cpf: '222.333.444-55',
        responsavel: 'Vendedor Jv', outros_socios: []
    });

    semearMensagem('5511998887766', 'recebida', 'Olá, boa tarde!', 14);
    semearMensagem('5511998887766', 'enviada', 'Boa tarde, Carlos! Tudo bem? Como posso ajudar?', 13);
    semearMensagem('5511998887766', 'recebida', 'Boa tarde! Qual o valor do plano?', 12);

    semearMensagem('5521987776655', 'recebida', 'Oi, quero fechar o plano de vocês.', 42);
    semearMensagem('5521987776655', 'enviada', 'Perfeito, Maria! Vou preparar o contrato.', 41);
    semearMensagem('5521987776655', 'recebida', 'Pode mandar o contrato amanhã.', 40);

    semearMensagem('5511976665544', 'recebida', 'Quanto custa a mensalidade?', 96);
    semearMensagem('5511976665544', 'recebida', 'Achei caro, obrigado.', 95);

    semearMensagem('5511965554433', 'recebida', 'Muito obrigada pelo atendimento!', 182);
    semearMensagem('5511965554433', 'enviada', 'Nós que agradecemos, Fernanda! 💚', 181);

    listas.push({
        id: listaId++,
        nome: 'Clientes SP - Novembro',
        total: 2,
        contatos: [
            { telefone: '5511998887766', nome: 'Carlos Mendes' },
            { telefone: '5521987776655', nome: 'Maria Oliveira' }
        ],
        criado_em: minutosAtras(60)
    });

    return {
        async prepararBanco() {
            console.log('MODO DEMO: banco em memória pronto com dados de exemplo.');
        },

        async listarClientes({ status, busca, limite }) {
            let itens = Array.from(clientes.values());

            if (status === 'ativos') itens = itens.filter((c) => c.status !== 'finalizado');
            else if (status === 'finalizado') itens = itens.filter((c) => c.status === 'finalizado');

            if (busca) {
                const alvo = String(busca).toLowerCase();
                itens = itens.filter((c) =>
                    String(c.nome || '').toLowerCase().includes(alvo) ||
                    String(c.telefone || '').includes(alvo)
                );
            }

            itens.sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));

            return itens.slice(0, limite).map((c) => ({
                nome: c.nome, telefone: c.telefone, mensagem: c.mensagem,
                status: c.status, criado_em: c.criado_em
            }));
        },

        async contarPorStatus() {
            const counts = { vendido: 0, pensando: 0, 'nao-quis': 0, finalizado: 0 };
            clientes.forEach((c) => {
                if (counts[c.status] !== undefined) counts[c.status] += 1;
            });
            return counts;
        },

        async resumoDashboard() {
            const resumo = {
                clientes: clientes.size, conversasAtivas: 0, listas: listas.length, mensagensHoje: 0,
                vendido: 0, pensando: 0, 'nao-quis': 0, finalizado: 0
            };

            clientes.forEach((c) => {
                if (resumo[c.status] !== undefined) resumo[c.status] += 1;
                if (c.status !== 'finalizado') resumo.conversasAtivas += 1;
            });

            const hoje = new Date().toDateString();
            resumo.mensagensHoje = mensagens.filter((m) => new Date(m.criado_em).toDateString() === hoje).length;

            return resumo;
        },


        async obterFicha(telefone) {
            const c = clientes.get(telefone);
            if (!c) return null;
            return {
                nome: c.nome, telefone: c.telefone, cnpj: c.cnpj, socio: c.socio,
                cpf: c.cpf, responsavel: c.responsavel,
                outros_socios: Array.isArray(c.outros_socios) ? c.outros_socios.slice() : [],
                status: c.status, mensagem: c.mensagem
            };
        },

        async salvarFicha(telefone, dados) {
            const c = clientes.get(telefone);
            if (!c) return false;
            clientes.set(telefone, Object.assign({}, c, {
                cnpj: dados.cnpj || null,
                socio: dados.socio || null,
                cpf: dados.cpf || null,
                responsavel: dados.responsavel || null,
                outros_socios: Array.isArray(dados.outros_socios) ? dados.outros_socios.slice() : []
            }));
            return true;
        },

        async listarMensagens(telefone) {
            return mensagens
                .filter((m) => m.telefone === telefone)
                .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em) || a.id - b.id)
                .slice(-300)
                .map((m) => ({ id: m.id, direcao: m.direcao, texto: m.texto, criado_em: m.criado_em }));
        },

        async registrarMensagem(telefone, direcao, texto) {
            mensagens.push({
                id: mensagemId++,
                telefone,
                direcao,
                texto,
                criado_em: new Date().toISOString()
            });
        },

        async atualizarUltimaMensagem(telefone, texto) {
            const c = clientes.get(telefone);
            if (c) c.mensagem = texto;
        },

        async registrarRecebida({ nome, telefone, mensagem }) {
            const atual = clientes.get(telefone) || {
                cnpj: null, socio: null, cpf: null, responsavel: null, outros_socios: []
            };
            clientes.set(telefone, Object.assign({}, atual, {
                nome,
                telefone,
                mensagem,
                status: 'pensando',
                criado_em: new Date().toISOString()
            }));
        },

        async atualizarStatus(telefone, status) {
            const c = clientes.get(telefone);
            if (c) c.status = status;
        },

        async finalizarAtendimento(telefone) {
            const c = clientes.get(telefone);
            if (c) c.status = 'finalizado';
        },

        async listarListas() {
            return listas
                .slice()
                .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))
                .slice(0, 100)
                .map((l) => ({ id: l.id, nome: l.nome, total: l.total, criado_em: l.criado_em }));
        },

        async criarLista(nome, contatos) {
            const id = listaId++;
            listas.push({
                id,
                nome,
                total: contatos.length,
                contatos: contatos.slice(),
                criado_em: new Date().toISOString()
            });
            return { id, total: contatos.length };
        },

        async excluirLista(id) {
            const indice = listas.findIndex((l) => String(l.id) === String(id));
            if (indice >= 0) listas.splice(indice, 1);
        }
    };
}

/* ---------------------------------------------------------
   ESCOLHA AUTOMÁTICA + EXPORTAÇÃO
   --------------------------------------------------------- */
const banco = MODO_DEMO ? criarBancoMemoria() : criarBancoPostgres();
banco.modoDemo = MODO_DEMO;

module.exports = banco;


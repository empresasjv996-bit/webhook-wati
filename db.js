/* =========================================================
   QGC TEAM by JV - Camada de dados
   ---------------------------------------------------------
   - Em produção (Render) usa o Postgres do DATABASE_URL.
   - Sem DATABASE_URL válida, cai automaticamente no modo demo
     (banco em memória com dados de exemplo), permitindo rodar
     o painel localmente com `npm start` sem instalar Postgres.
   ========================================================= */

'use strict';

const { Pool } = require('pg');
const { gerarHash } = require('./senha');

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
                // colunas extras mapeadas na importação de listas (viram atributos na Wati)
                "ALTER TABLE clientes ADD COLUMN IF NOT EXISTS atributos JSONB DEFAULT '{}'::jsonb",
                // dono do lead (vendedor que recebeu a lista da campanha)
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS vendedor_email TEXT',
                'ALTER TABLE clientes ADD COLUMN IF NOT EXISTS vendedor_nome TEXT',
                'CREATE INDEX IF NOT EXISTS idx_clientes_vendedor ON clientes (vendedor_email)',
                `CREATE TABLE IF NOT EXISTS mensagens (
                    id SERIAL PRIMARY KEY,
                    telefone TEXT NOT NULL,
                    direcao TEXT NOT NULL DEFAULT 'recebida',
                    texto TEXT NOT NULL,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                'CREATE INDEX IF NOT EXISTS idx_mensagens_telefone ON mensagens (telefone)',
                // autor da mensagem (quem enviou pelo painel/campanha) e origem
                'ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS autor_email TEXT',
                'ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS autor_nome TEXT',
                'ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS campanha_id INTEGER',
                'ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS origem TEXT',
                'CREATE INDEX IF NOT EXISTS idx_mensagens_autor ON mensagens (autor_email)',
                'CREATE INDEX IF NOT EXISTS idx_mensagens_campanha ON mensagens (campanha_id)',
                `CREATE TABLE IF NOT EXISTS listas (
                    id SERIAL PRIMARY KEY,
                    nome TEXT NOT NULL,
                    total INTEGER NOT NULL DEFAULT 0,
                    contatos JSONB NOT NULL DEFAULT '[]'::jsonb,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                `CREATE TABLE IF NOT EXISTS usuarios (
                    id SERIAL PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    nome TEXT NOT NULL,
                    senha_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'colaborador',
                    ativo BOOLEAN NOT NULL DEFAULT TRUE,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                `CREATE TABLE IF NOT EXISTS campanhas (
                    id SERIAL PRIMARY KEY,
                    nome TEXT NOT NULL,
                    lista_id INTEGER,
                    mensagem TEXT NOT NULL,
                    canal TEXT NOT NULL DEFAULT 'texto',
                    template_nome TEXT,
                    template_idioma TEXT,
                    template_parametros JSONB NOT NULL DEFAULT '[]'::jsonb,
                    intervalo_ms INTEGER NOT NULL DEFAULT 8000,
                    status TEXT NOT NULL DEFAULT 'ativa',
                    total INTEGER NOT NULL DEFAULT 0,
                    enviados INTEGER NOT NULL DEFAULT 0,
                    falhas INTEGER NOT NULL DEFAULT 0,
                    vendedor_email TEXT,
                    vendedor_nome TEXT,
                    proximo_envio_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                `CREATE TABLE IF NOT EXISTS campanha_envios (
                    id SERIAL PRIMARY KEY,
                    campanha_id INTEGER NOT NULL REFERENCES campanhas (id) ON DELETE CASCADE,
                    telefone TEXT NOT NULL,
                    nome TEXT,
                    mensagem TEXT,
                    parametros JSONB NOT NULL DEFAULT '[]'::jsonb,
                    status TEXT NOT NULL DEFAULT 'pendente',
                    erro TEXT,
                    enviado_em TIMESTAMPTZ
                )`,
                'CREATE INDEX IF NOT EXISTS idx_envios_campanha ON campanha_envios (campanha_id)',
                'CREATE INDEX IF NOT EXISTS idx_envios_pendentes ON campanha_envios (status)',
                // tudo o que a Wati manda pelo webhook (mensagem, campanha, contato...)
                `CREATE TABLE IF NOT EXISTS eventos_wati (
                    id SERIAL PRIMARY KEY,
                    tipo TEXT NOT NULL,
                    telefone TEXT,
                    nome TEXT,
                    campanha TEXT,
                    texto TEXT,
                    status TEXT,
                    whatsapp_message_id TEXT,
                    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                'CREATE INDEX IF NOT EXISTS idx_eventos_wati_criado ON eventos_wati (criado_em DESC)',
                'CREATE INDEX IF NOT EXISTS idx_eventos_wati_tipo ON eventos_wati (tipo)',
                'CREATE INDEX IF NOT EXISTS idx_eventos_wati_telefone ON eventos_wati (telefone)',
                // destino da campanha (vendedor que recebe os leads)
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS vendedor_email TEXT',
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS vendedor_nome TEXT',
                // canal da campanha: "texto" (sessão) ou "template" (aprovado na Wati)
                "ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'texto'",
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS template_nome TEXT',
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS template_idioma TEXT',
                "ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS template_parametros JSONB NOT NULL DEFAULT '[]'::jsonb",
                // quem criou a campanha (aparece como autor das mensagens disparadas)
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS criado_por_email TEXT',
                'ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS criado_por_nome TEXT',
                // valores já resolvidos por contato (template) + texto final do envio
                "ALTER TABLE campanha_envios ADD COLUMN IF NOT EXISTS parametros JSONB NOT NULL DEFAULT '[]'::jsonb",
                'ALTER TABLE campanha_envios ADD COLUMN IF NOT EXISTS mensagem TEXT',
                `CREATE TABLE IF NOT EXISTS auditoria (
                    id SERIAL PRIMARY KEY,
                    ator TEXT,
                    acao TEXT NOT NULL,
                    detalhe TEXT,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                // configurações que precisam sobreviver aos reinícios do Render
                // (ex.: segredo do JWT quando JWT_SECRET não está no Environment)
                `CREATE TABLE IF NOT EXISTS configuracoes (
                    chave TEXT PRIMARY KEY,
                    valor TEXT NOT NULL,
                    criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )`,
                // envios que ficaram presos em "enviando" (restart no meio do processo)
                "UPDATE campanha_envios SET status = 'pendente' WHERE status = 'enviando'"
            ];

            for (const comando of comandos) {
                try { await pool.query(comando); }
                catch (erro) { console.warn('Banco (estrutura):', erro.message); }
            }

            // Usuários iniciais (só na primeira execução, quando a tabela está vazia)
            try {
                const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM usuarios');
                if (rows[0].total === 0) {
                    const iniciais = [
                        ['admin@qgcteam.com', 'Admin Master', 'admin'],
                        ['colaborador@qgcteam.com', 'Claudio', 'colaborador'],
                        ['vendedor@qgcteam.com', 'Vendedor Jv', 'colaborador']
                    ];
                    for (const [email, nome, role] of iniciais) {
                        await pool.query(
                            'INSERT INTO usuarios (email, nome, senha_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
                            [email, nome, gerarHash('123456'), role]
                        );
                    }
                    console.log('Usuários iniciais criados.');
                }
            } catch (erro) { console.warn('Banco (usuários iniciais):', erro.message); }

            console.log('Estrutura do banco verificada.');
        },

        async listarClientes({ status, busca, limite, vendedorEmail, somenteMeus }) {
            const filtros = [];
            const valores = [];

            if (status === 'ativos') filtros.push("status <> 'finalizado'");
            else if (status === 'finalizado') filtros.push("status = 'finalizado'");

            if (busca) {
                valores.push(`%${busca}%`);
                filtros.push(`(nome ILIKE $${valores.length} OR telefone ILIKE $${valores.length})`);
            }

            // Vendedor logado só enxerga os leads que estão na carteira dele.
            // (O painel admin não envia vendedorEmail e continua vendo tudo.)
            if (vendedorEmail) {
                valores.push(vendedorEmail);
                filtros.push(`LOWER(vendedor_email) = LOWER($${valores.length})`);
            }

            valores.push(limite);
            const where = filtros.length ? `WHERE ${filtros.join(' AND ')}` : '';

            const { rows } = await pool.query(
                `SELECT nome, telefone, mensagem, status, criado_em, vendedor_email, vendedor_nome
                   FROM clientes ${where}
                  ORDER BY criado_em DESC NULLS LAST
                  LIMIT $${valores.length}`,
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
                clientes: 0, conversasAtivas: 0, listas: 0, mensagensHoje: 0, campanhasAtivas: 0,
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

            try {
                const campanhas = await pool.query("SELECT COUNT(*) FILTER (WHERE status = 'ativa')::int AS ativas FROM campanhas");
                resumo.campanhasAtivas = campanhas.rows[0].ativas;
            } catch (erro) { console.error('Dashboard (campanhas):', erro.message); }

            return resumo;
        },


        async obterFicha(telefone) {
            const { rows } = await pool.query(
                `SELECT nome, telefone, cnpj, socio, cpf, responsavel, outros_socios,
                        atributos, status, mensagem, vendedor_email, vendedor_nome
                   FROM clientes WHERE telefone = $1`,
                [telefone]
            );
            return rows[0] || null;
        },

        /* Dono atual do lead (usado para isolar o acesso dos colaboradores). */
        async obterDonoCliente(telefone) {
            const { rows } = await pool.query(
                'SELECT vendedor_email, vendedor_nome FROM clientes WHERE telefone = $1',
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

        /* Importação de lista com colunas mapeadas (ex.: planilha exportada da Wati).
           - nome/telefone entram no cadastro do cliente;
           - cnpj/cpf/socio/responsavel também alimentam a ficha;
           - o resto fica em clientes.atributos e é enviado como atributo na Wati. */
        async salvarContatosImportados(contatos) {
            let novos = 0;
            let atualizados = 0;

            for (const contato of contatos) {
                const atributos = JSON.stringify(contato.atributos || {});
                const { rows } = await pool.query(
                    `INSERT INTO clientes (nome, telefone, atributos, cnpj, cpf, socio, responsavel, mensagem, status)
                     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, '', 'pensando')
                     ON CONFLICT (telefone) DO UPDATE
                        SET nome = CASE
                                WHEN clientes.nome IS NULL OR BTRIM(clientes.nome) = '' THEN EXCLUDED.nome
                                ELSE clientes.nome
                            END,
                            atributos = COALESCE(clientes.atributos, '{}'::jsonb) || EXCLUDED.atributos,
                            cnpj = COALESCE(NULLIF(BTRIM(clientes.cnpj), ''), EXCLUDED.cnpj),
                            cpf = COALESCE(NULLIF(BTRIM(clientes.cpf), ''), EXCLUDED.cpf),
                            socio = COALESCE(NULLIF(BTRIM(clientes.socio), ''), EXCLUDED.socio),
                            responsavel = COALESCE(NULLIF(BTRIM(clientes.responsavel), ''), EXCLUDED.responsavel)
                     RETURNING (xmax = 0) AS inserido`,
                    [
                        contato.nome || contato.telefone,
                        contato.telefone,
                        atributos,
                        contato.cnpj || null,
                        contato.cpf || null,
                        contato.socio || null,
                        contato.responsavel || null
                    ]
                );

                if (rows[0] && rows[0].inserido) novos++;
                else atualizados++;
            }

            return { novos, atualizados };
        },

        async listarMensagens(telefone) {
            const { rows } = await pool.query(
                `SELECT id, direcao, texto, autor_email, autor_nome, campanha_id, origem, criado_em
                   FROM mensagens WHERE telefone = $1
                  ORDER BY criado_em ASC, id ASC LIMIT 300`,
                [telefone]
            );
            return rows;
        },

        async registrarMensagem(telefone, direcao, texto, extras) {
            const dados = extras || {};
            try {
                await pool.query(
                    `INSERT INTO mensagens (telefone, direcao, texto, autor_email, autor_nome, campanha_id, origem)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        telefone,
                        direcao,
                        texto,
                        dados.autorEmail || null,
                        dados.autorNome || null,
                        dados.campanhaId || null,
                        dados.origem || null
                    ]
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

        /* ---------------- EVENTOS DA WATI (webhook) ----------------
           Guarda qualquer coisa que a Wati mande: mensagem recebida/enviada,
           status de campanha (sent/delivered/read/failed) e contato criado.
           O payload cru fica no JSONB para servir de diagnóstico. */
        async registrarEventoWati(evento) {
            const dados = evento || {};

            try {
                const { rows } = await pool.query(
                    `INSERT INTO eventos_wati (tipo, telefone, nome, campanha, texto, status, whatsapp_message_id, payload)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                     RETURNING id, criado_em`,
                    [
                        String(dados.tipo || 'desconhecido').substring(0, 60),
                        dados.telefone || null,
                        dados.nome ? String(dados.nome).substring(0, 120) : null,
                        dados.campanha ? String(dados.campanha).substring(0, 160) : null,
                        dados.texto ? String(dados.texto).substring(0, 2000) : null,
                        dados.status ? String(dados.status).substring(0, 60) : null,
                        dados.whatsappMessageId ? String(dados.whatsappMessageId).substring(0, 120) : null,
                        JSON.stringify(dados.payload || {})
                    ]
                );
                return rows[0] || null;
            } catch (erro) {
                console.error('Erro ao salvar evento da Wati:', erro.message);
                return null;
            }
        },

        async listarEventosWati({ limite, tipos }) {
            const valores = [];
            let filtro = '';

            if (Array.isArray(tipos) && tipos.length) {
                valores.push(tipos);
                filtro = `WHERE tipo = ANY($${valores.length})`;
            }

            valores.push(limite);

            const { rows } = await pool.query(
                `SELECT id, tipo, telefone, nome, campanha, texto, status, whatsapp_message_id, criado_em
                   FROM eventos_wati ${filtro}
                  ORDER BY id DESC
                  LIMIT $${valores.length}`,
                valores
            );
            return rows;
        },

        async ultimoEventoWati() {
            try {
                const { rows } = await pool.query(
                    'SELECT id, tipo, telefone, nome, campanha, criado_em FROM eventos_wati ORDER BY id DESC LIMIT 1'
                );
                return rows[0] || null;
            } catch (erro) {
                return null;
            }
        },

        async contarEventosWatiHoje() {
            try {
                const { rows } = await pool.query(
                    'SELECT COUNT(*)::int AS total FROM eventos_wati WHERE criado_em >= CURRENT_DATE'
                );
                return rows[0].total;
            } catch (erro) {
                return 0;
            }
        },

        /* Contato que nasceu/foi atualizado na Wati. Cria o cliente no painel
           se ainda não existir e mescla os atributos, sem mexer no status. */
        async registrarContatoWati({ telefone, nome, atributos }) {
            const numero = String(telefone || '').replace(/\D/g, '');
            if (!numero) return false;

            const nomeLimpo = String(nome || '').trim().substring(0, 120) || numero;
            const extras = atributos && typeof atributos === 'object' ? atributos : {};

            try {
                await pool.query(
                    `INSERT INTO clientes (nome, telefone, mensagem, status, atributos)
                     VALUES ($1, $2, '', 'pensando', $3::jsonb)
                     ON CONFLICT (telefone) DO UPDATE
                        SET nome = CASE
                                WHEN COALESCE(BTRIM(clientes.nome), '') = '' THEN EXCLUDED.nome
                                ELSE clientes.nome
                            END,
                            atributos = COALESCE(clientes.atributos, '{}'::jsonb) || EXCLUDED.atributos`,
                    [nomeLimpo, numero, JSON.stringify(extras)]
                );
                return true;
            } catch (erro) {
                console.error('Erro ao registrar contato da Wati:', erro.message);
                return false;
            }
        },

        async atualizarStatus(telefone, status) {
            await pool.query('UPDATE clientes SET status = $1 WHERE telefone = $2', [status, telefone]);
        },

        // Coloca o lead na carteira do vendedor escolhido na campanha.
        // Cria o cliente se ele ainda não existir no banco.
        async atribuirVendedor({ telefone, nomeContato, vendedorEmail, vendedorNome }) {
            if (!telefone || !vendedorEmail) return false;

            const nomeLimpo = String(nomeContato || '').trim() || telefone;

            await pool.query(
                `INSERT INTO clientes (nome, telefone, mensagem, status, vendedor_email, vendedor_nome, responsavel)
                 VALUES ($1, $2, '', 'pensando', $3, $4, $5)
                 ON CONFLICT (telefone) DO UPDATE
                    SET vendedor_email = EXCLUDED.vendedor_email,
                        vendedor_nome = EXCLUDED.vendedor_nome,
                        responsavel = COALESCE(NULLIF(clientes.responsavel, ''), EXCLUDED.responsavel)`,
                [nomeLimpo, telefone, vendedorEmail, vendedorNome || null, vendedorNome || null]
            );

            return true;
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
        },

        async obterContatosLista(id) {
            const { rows } = await pool.query('SELECT contatos FROM listas WHERE id = $1', [id]);
            return rows[0] && Array.isArray(rows[0].contatos) ? rows[0].contatos : [];
        },

        /* ---------------- USUÁRIOS ---------------- */
        async listarUsuarios() {
            const { rows } = await pool.query(
                'SELECT id, email, nome, role, ativo, criado_em FROM usuarios ORDER BY criado_em ASC, id ASC'
            );
            return rows;
        },

        async buscarUsuarioPorEmail(email) {
            const { rows } = await pool.query(
                'SELECT id, email, nome, role, ativo, senha_hash FROM usuarios WHERE LOWER(email) = LOWER($1)',
                [email]
            );
            return rows[0] || null;
        },

        async criarUsuario({ email, nome, senhaHash, role }) {
            const { rows } = await pool.query(
                'INSERT INTO usuarios (email, nome, senha_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, email, nome, role, ativo',
                [email, nome, senhaHash, role]
            );
            return rows[0];
        },

        async atualizarUsuario(id, { nome, role, ativo, senhaHash }) {
            const sets = [];
            const valores = [];

            if (nome !== undefined) { valores.push(nome); sets.push(`nome = $${valores.length}`); }
            if (role !== undefined) { valores.push(role); sets.push(`role = $${valores.length}`); }
            if (ativo !== undefined) { valores.push(!!ativo); sets.push(`ativo = $${valores.length}`); }
            if (senhaHash) { valores.push(senhaHash); sets.push(`senha_hash = $${valores.length}`); }

            if (!sets.length) return false;

            valores.push(id);
            const resultado = await pool.query(
                `UPDATE usuarios SET ${sets.join(', ')} WHERE id = $${valores.length}`,
                valores
            );
            return resultado.rowCount > 0;
        },

        async excluirUsuario(id) {
            const resultado = await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
            return resultado.rowCount > 0;
        },

        /* ---------------- CAMPANHAS ---------------- */
        async criarCampanha({
            nome, listaId, mensagem, intervaloMs, contatos, vendedorEmail, vendedorNome,
            canal, templateNome, templateIdioma, templateParametros,
            criadoPorEmail, criadoPorNome
        }) {
            const cliente = await pool.connect();
            try {
                await cliente.query('BEGIN');

                const { rows } = await cliente.query(
                    `INSERT INTO campanhas (nome, lista_id, mensagem, canal, template_nome, template_idioma,
                                            template_parametros, intervalo_ms, total, status,
                                            vendedor_email, vendedor_nome, criado_por_email, criado_por_nome,
                                            proximo_envio_em)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'ativa', $10, $11, $12, $13, NOW())
                     RETURNING id`,
                    [
                        nome, listaId || null, mensagem,
                        canal === 'template' ? 'template' : 'texto',
                        templateNome || null, templateIdioma || null,
                        JSON.stringify(Array.isArray(templateParametros) ? templateParametros : []),
                        intervaloMs, contatos.length, vendedorEmail || null, vendedorNome || null,
                        criadoPorEmail || null, criadoPorNome || null
                    ]
                );
                const id = rows[0].id;

                const tamanho = 200;
                for (let i = 0; i < contatos.length; i += tamanho) {
                    const parte = contatos.slice(i, i + tamanho);
                    const valores = [];
                    const linhas = parte.map((contato, indice) => {
                        const base = indice * 5;
                        valores.push(
                            id,
                            contato.telefone,
                            contato.nome || null,
                            contato.mensagem || null,
                            JSON.stringify(Array.isArray(contato.parametros) ? contato.parametros : [])
                        );
                        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb)`;
                    });
                    await cliente.query(
                        `INSERT INTO campanha_envios (campanha_id, telefone, nome, mensagem, parametros)
                         VALUES ${linhas.join(', ')}`,
                        valores
                    );
                }

                await cliente.query('COMMIT');
                return { id, total: contatos.length };
            } catch (erro) {
                await cliente.query('ROLLBACK');
                throw erro;
            } finally {
                cliente.release();
            }
        },

        async listarCampanhas() {
            const { rows } = await pool.query(
                `SELECT c.id, c.nome, c.mensagem, c.canal, c.template_nome, c.template_idioma,
                        c.intervalo_ms, c.status, c.total, c.enviados, c.falhas,
                        c.vendedor_email, c.vendedor_nome,
                        c.criado_em, c.atualizado_em,
                        (SELECT COUNT(*)::int FROM campanha_envios e
                          WHERE e.campanha_id = c.id AND e.status IN ('pendente', 'enviando')) AS pendentes
                   FROM campanhas c
                  ORDER BY c.criado_em DESC
                  LIMIT 50`
            );
            return rows;
        },

        async atualizarStatusCampanha(id, status) {
            const resultado = await pool.query(
                'UPDATE campanhas SET status = $2, atualizado_em = NOW() WHERE id = $1',
                [id, status]
            );
            return resultado.rowCount > 0;
        },

        async direcionarCampanha(id, vendedorEmail, vendedorNome) {
            const resultado = await pool.query(
                'UPDATE campanhas SET vendedor_email = $2, vendedor_nome = $3, atualizado_em = NOW() WHERE id = $1',
                [id, vendedorEmail || null, vendedorNome || null]
            );
            return resultado.rowCount > 0;
        },

        async excluirCampanha(id) {
            const resultado = await pool.query('DELETE FROM campanhas WHERE id = $1', [id]);
            return resultado.rowCount > 0;
        },

        async resumoCampanhas() {
            try {
                const { rows } = await pool.query(
                    "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'ativa')::int AS ativas FROM campanhas"
                );
                return { total: rows[0].total, ativas: rows[0].ativas };
            } catch (erro) {
                return { total: 0, ativas: 0 };
            }
        },

        async proximoEnvioPendente() {
            const { rows } = await pool.query(
                `SELECT e.id AS envio_id, e.telefone, e.nome,
                        e.mensagem AS envio_mensagem, e.parametros AS envio_parametros,
                        c.id AS campanha_id, c.nome AS campanha, c.mensagem,
                        c.canal, c.template_nome, c.template_idioma,
                        c.vendedor_email, c.vendedor_nome,
                        c.criado_por_email, c.criado_por_nome
                   FROM campanha_envios e
                   JOIN campanhas c ON c.id = e.campanha_id
                  WHERE e.status = 'pendente'
                    AND c.status = 'ativa'
                    AND c.proximo_envio_em <= NOW()
                  ORDER BY e.id ASC
                  LIMIT 1`
            );
            return rows[0] || null;
        },

        async reservarEnvio(envioId) {
            const resultado = await pool.query(
                "UPDATE campanha_envios SET status = 'enviando' WHERE id = $1 AND status = 'pendente'",
                [envioId]
            );
            return resultado.rowCount > 0;
        },

        async concluirEnvio(envioId, campanhaId, ok, erro) {
            await pool.query(
                'UPDATE campanha_envios SET status = $2, erro = $3, enviado_em = NOW() WHERE id = $1',
                [envioId, ok ? 'enviado' : 'falha', erro ? String(erro).slice(0, 500) : null]
            );

            await pool.query(
                `UPDATE campanhas c
                    SET enviados = c.enviados + $2,
                        falhas = c.falhas + $3,
                        proximo_envio_em = NOW() + make_interval(secs => (c.intervalo_ms::float8 / 1000.0)),
                        atualizado_em = NOW(),
                        status = CASE
                            WHEN NOT EXISTS (
                                SELECT 1 FROM campanha_envios e
                                 WHERE e.campanha_id = c.id AND e.status IN ('pendente', 'enviando')
                            ) THEN 'concluida'
                            ELSE c.status
                        END
                  WHERE c.id = $1`,
                [campanhaId, ok ? 1 : 0, ok ? 0 : 1]
            );
        },

        /* ---------------- LOGS / AUDITORIA ---------------- */
        async listarLogs({ limite, direcao }) {
            const filtros = [];
            const valores = [];

            if (direcao === 'recebida' || direcao === 'enviada') {
                valores.push(direcao);
                filtros.push(`m.direcao = $${valores.length}`);
            }

            valores.push(limite);
            const { rows } = await pool.query(
                `SELECT m.id, m.telefone, m.direcao, m.texto, m.criado_em, c.nome
                   FROM mensagens m
                   LEFT JOIN clientes c ON c.telefone = m.telefone
                   ${filtros.length ? 'WHERE ' + filtros.join(' AND ') : ''}
                  ORDER BY m.id DESC
                  LIMIT $${valores.length}`,
                valores
            );
            return rows;
        },

        /* ---------------- CONVERSAS: BACKUP E LIMPEZA ---------------- */
        async exportarConversas() {
            const mensagens = await pool.query(
                `SELECT m.id, m.telefone, c.nome, m.direcao, m.texto,
                        m.autor_email, m.autor_nome, m.campanha_id, m.origem, m.criado_em
                   FROM mensagens m
                   LEFT JOIN clientes c ON c.telefone = m.telefone
                  ORDER BY m.id ASC`
            );

            const clientes = await pool.query(
                `SELECT telefone, nome, status, mensagem, vendedor_email, vendedor_nome
                   FROM clientes
                  ORDER BY telefone ASC`
            );

            return {
                gerado_em: new Date().toISOString(),
                mensagens: mensagens.rows,
                clientes: clientes.rows
            };
        },

        async contarConversas() {
            const mensagens = await pool.query('SELECT COUNT(*)::int AS total FROM mensagens');
            const eventos = await pool.query(
                "SELECT COUNT(*)::int AS total FROM eventos_wati WHERE tipo = 'message' OR texto IS NOT NULL"
            );
            const clientes = await pool.query("SELECT COUNT(*)::int AS total FROM clientes WHERE COALESCE(mensagem, '') <> ''");

            return {
                mensagens: mensagens.rows[0].total,
                eventosMensagem: eventos.rows[0].total,
                clientesComPrevia: clientes.rows[0].total
            };
        },

        /* Apaga o histórico das conversas. Mantém clientes, fichas, campanhas e auditoria. */
        async limparConversas({ incluirEventosWati = true } = {}) {
            const cliente = await pool.connect();
            try {
                await cliente.query('BEGIN');

                const removidas = await cliente.query('DELETE FROM mensagens');
                const atualizados = await cliente.query(
                    "UPDATE clientes SET mensagem = '' WHERE COALESCE(mensagem, '') <> ''"
                );

                let eventos = { rowCount: 0 };
                if (incluirEventosWati) {
                    eventos = await cliente.query(
                        "DELETE FROM eventos_wati WHERE tipo = 'message' OR texto IS NOT NULL"
                    );
                }

                await cliente.query('COMMIT');

                return {
                    mensagensRemovidas: removidas.rowCount,
                    clientesAtualizados: atualizados.rowCount,
                    eventosRemovidos: eventos.rowCount
                };
            } catch (erro) {
                await cliente.query('ROLLBACK');
                throw erro;
            } finally {
                cliente.release();
            }
        },

        /* Contagens usadas pelo botão "Limpar tudo" do painel. */
        async contarDados() {
            const { rows: clientes } = await pool.query('SELECT COUNT(*)::int AS total FROM clientes');
            const { rows: comPrevia } = await pool.query(
                "SELECT COUNT(*)::int AS total FROM clientes WHERE COALESCE(mensagem, '') <> ''"
            );
            const { rows: listas } = await pool.query('SELECT COUNT(*)::int AS total FROM listas');
            const { rows: campanhas } = await pool.query('SELECT COUNT(*)::int AS total FROM campanhas');
            const { rows: mensagens } = await pool.query('SELECT COUNT(*)::int AS total FROM mensagens');
            const { rows: eventos } = await pool.query(
                "SELECT COUNT(*)::int AS total FROM eventos_wati WHERE tipo = 'message' OR texto IS NOT NULL"
            );

            return {
                clientes: clientes[0].total,
                clientesComPrevia: comPrevia[0].total,
                listas: listas[0].total,
                campanhas: campanhas[0].total,
                mensagens: mensagens[0].total,
                eventosMensagem: eventos[0].total
            };
        },

        /* Reset dos dados de teste: apaga clientes (com as fichas), todo o
           histórico de conversas e as listas importadas. Campanhas, usuários,
           canais e auditoria são preservados. */
        async limparDados({ incluirEventosWati = true } = {}) {
            const cliente = await pool.connect();
            try {
                await cliente.query('BEGIN');

                const mensagens = await cliente.query('DELETE FROM mensagens');
                const clientes = await cliente.query('DELETE FROM clientes');
                const listas = await cliente.query('DELETE FROM listas');

                let eventos = { rowCount: 0 };
                if (incluirEventosWati) {
                    eventos = await cliente.query(
                        "DELETE FROM eventos_wati WHERE tipo = 'message' OR texto IS NOT NULL"
                    );
                }

                await cliente.query('COMMIT');

                return {
                    mensagensRemovidas: mensagens.rowCount,
                    clientesRemovidos: clientes.rowCount,
                    listasRemovidas: listas.rowCount,
                    eventosRemovidos: eventos.rowCount
                };
            } catch (erro) {
                await cliente.query('ROLLBACK');
                throw erro;
            } finally {
                cliente.release();
            }
        },

        async registrarAuditoria(ator, acao, detalhe) {
            try {
                await pool.query(
                    'INSERT INTO auditoria (ator, acao, detalhe) VALUES ($1, $2, $3)',
                    [ator || null, acao, detalhe ? String(detalhe).slice(0, 1000) : null]
                );
            } catch (erro) {
                console.error('Erro ao gravar auditoria:', erro.message);
            }
        },

        async listarAuditoria(limite) {
            const { rows } = await pool.query(
                'SELECT id, ator, acao, detalhe, criado_em FROM auditoria ORDER BY id DESC LIMIT $1',
                [limite]
            );
            return rows;
        },

        /* Cofre chave/valor: devolve o valor existente ou grava o novo uma única
           vez. O INSERT ... ON CONFLICT evita que duas instâncias subindo juntas
           criem segredos diferentes - quem perder a corrida relê o valor vencedor. */
        async obterOuCriarConfiguracao(chave, gerarValor) {
            const { rows } = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
            if (rows.length) return rows[0].valor;

            const valor = typeof gerarValor === 'function' ? String(gerarValor()) : String(gerarValor);
            await pool.query(
                'INSERT INTO configuracoes (chave, valor) VALUES ($1, $2) ON CONFLICT (chave) DO NOTHING',
                [chave, valor]
            );

            const { rows: gravado } = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
            return gravado.length ? gravado[0].valor : valor;
        },

        async obterConfiguracao(chave) {
            const { rows } = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
            return rows.length ? rows[0].valor : null;
        },

        async definirConfiguracao(chave, valor) {
            await pool.query(
                `INSERT INTO configuracoes (chave, valor) VALUES ($1, $2)
                 ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor`,
                [chave, String(valor)]
            );
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
    const usuarios = [
        { id: 1, email: 'admin@qgcteam.com', nome: 'Admin Master', role: 'admin', ativo: true, senha_hash: gerarHash('123456'), criado_em: new Date().toISOString() },
        { id: 2, email: 'colaborador@qgcteam.com', nome: 'Claudio', role: 'colaborador', ativo: true, senha_hash: gerarHash('123456'), criado_em: new Date().toISOString() },
        { id: 3, email: 'vendedor@qgcteam.com', nome: 'Vendedor Jv', role: 'colaborador', ativo: true, senha_hash: gerarHash('123456'), criado_em: new Date().toISOString() }
    ];
    const campanhas = [];
    const envios = [];
    const auditoria = [];
    const eventosWati = [];
    const configuracoes = new Map();
    let mensagemId = 1;
    let listaId = 1;
    let usuarioId = 4;
    let campanhaId = 1;
    let envioId = 1;
    let auditoriaId = 1;
    let eventoWatiId = 1;

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
            atributos: {},
            vendedor_email: null,
            vendedor_nome: null,
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

    function semearEventoWati(dados) {
        eventosWati.push({
            id: eventoWatiId++,
            tipo: dados.tipo || 'message',
            telefone: dados.telefone || null,
            nome: dados.nome || null,
            campanha: dados.campanha || null,
            texto: dados.texto || null,
            status: dados.status || null,
            whatsapp_message_id: dados.whatsappMessageId || null,
            payload: dados.payload || {},
            criado_em: minutosAtras(dados.minutos || 5)
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
        responsavel: 'Vendedor Jv', outros_socios: [],
        vendedor_email: 'vendedor@qgcteam.com', vendedor_nome: 'Vendedor Jv'
    });
    semearCliente({
        nome: 'João Souza', telefone: '5511976665544', status: 'nao-quis',
        mensagem: 'Achei caro, obrigado.', criado_em: minutosAtras(95),
        cnpj: '11.222.333/0001-44', socio: 'João Souza', cpf: '111.222.333-44',
        responsavel: 'Claudio', outros_socios: ['Paulo Souza - 555.666.777-88'],
        vendedor_email: 'colaborador@qgcteam.com', vendedor_nome: 'Claudio'
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

    // Atividade de exemplo da Wati (webhook)
    semearEventoWati({
        tipo: 'message', telefone: '5511998887766', nome: 'Carlos Mendes',
        texto: 'Boa tarde! Qual o valor do plano?', status: 'received',
        minutos: 12, payload: { eventType: 'message', waId: '5511998887766', owner: false }
    });
    semearEventoWati({
        tipo: 'sent', telefone: '5521987776655', nome: 'Maria Oliveira',
        campanha: 'Promoção Novembro', texto: 'Oi, quero fechar o plano de vocês.',
        status: 'sent', minutos: 40,
        payload: { eventType: 'sent', waId: '5521987776655', campaignName: 'Promoção Novembro' }
    });
    semearEventoWati({
        tipo: 'delivered', telefone: '5521987776655', nome: 'Maria Oliveira',
        campanha: 'Promoção Novembro', status: 'delivered', minutos: 39,
        payload: { eventType: 'delivered', waId: '5521987776655', campaignName: 'Promoção Novembro' }
    });

    return {
        async prepararBanco() {
            console.log('MODO DEMO: banco em memória pronto com dados de exemplo.');
        },

        async listarClientes({ status, busca, limite, vendedorEmail, somenteMeus }) {
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

            if (vendedorEmail) {
                const alvo = String(vendedorEmail).toLowerCase();
                itens = itens.filter((c) => String(c.vendedor_email || '').toLowerCase() === alvo);
            }

            itens.sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));

            return itens.slice(0, limite).map((c) => ({
                nome: c.nome, telefone: c.telefone, mensagem: c.mensagem,
                status: c.status, criado_em: c.criado_em,
                vendedor_email: c.vendedor_email || null, vendedor_nome: c.vendedor_nome || null
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
                campanhasAtivas: campanhas.filter((c) => c.status === 'ativa').length,
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
                atributos: c.atributos && typeof c.atributos === 'object' ? Object.assign({}, c.atributos) : {},
                status: c.status, mensagem: c.mensagem,
                vendedor_email: c.vendedor_email || null, vendedor_nome: c.vendedor_nome || null
            };
        },

        async obterDonoCliente(telefone) {
            const c = clientes.get(telefone);
            if (!c) return null;
            return { vendedor_email: c.vendedor_email || null, vendedor_nome: c.vendedor_nome || null };
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
                .map((m) => ({
                    id: m.id, direcao: m.direcao, texto: m.texto,
                    autor_email: m.autor_email || null, autor_nome: m.autor_nome || null,
                    campanha_id: m.campanha_id || null, origem: m.origem || null,
                    criado_em: m.criado_em
                }));
        },

        async registrarMensagem(telefone, direcao, texto, extras) {
            const dados = extras || {};
            mensagens.push({
                id: mensagemId++,
                telefone,
                direcao,
                texto,
                autor_email: dados.autorEmail || null,
                autor_nome: dados.autorNome || null,
                campanha_id: dados.campanhaId || null,
                origem: dados.origem || null,
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

        async atribuirVendedor({ telefone, nomeContato, vendedorEmail, vendedorNome }) {
            if (!telefone || !vendedorEmail) return false;

            const atual = clientes.get(telefone) || {
                cnpj: null, socio: null, cpf: null, responsavel: null, outros_socios: [],
                mensagem: '', status: 'pensando', criado_em: new Date().toISOString()
            };

            clientes.set(telefone, Object.assign({}, atual, {
                nome: atual.nome || String(nomeContato || '').trim() || telefone,
                telefone,
                vendedor_email: vendedorEmail,
                vendedor_nome: vendedorNome || null,
                responsavel: atual.responsavel || vendedorNome || null
            }));

            return true;
        },

        async finalizarAtendimento(telefone) {
            const c = clientes.get(telefone);
            if (c) c.status = 'finalizado';
        },

        async salvarContatosImportados(contatos) {
            let novos = 0;
            let atualizados = 0;

            contatos.forEach((contato) => {
                const atual = clientes.get(contato.telefone);
                const atributos = Object.assign({}, (contato && contato.atributos) || {});

                if (atual) {
                    atual.atributos = Object.assign({}, atual.atributos || {}, atributos);
                    if (!atual.nome) atual.nome = contato.nome || atual.nome;
                    atual.cnpj = atual.cnpj || contato.cnpj || null;
                    atual.cpf = atual.cpf || contato.cpf || null;
                    atual.socio = atual.socio || contato.socio || null;
                    atual.responsavel = atual.responsavel || contato.responsavel || null;
                    atualizados++;
                    return;
                }

                semearCliente({
                    nome: contato.nome || contato.telefone,
                    telefone: contato.telefone,
                    atributos,
                    cnpj: contato.cnpj || null,
                    cpf: contato.cpf || null,
                    socio: contato.socio || null,
                    responsavel: contato.responsavel || null,
                    mensagem: '',
                    status: 'pensando',
                    criado_em: new Date().toISOString()
                });
                novos++;
            });

            return { novos, atualizados };
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
        },

        async obterContatosLista(id) {
            const lista = listas.find((l) => String(l.id) === String(id));
            return lista ? lista.contatos.slice() : [];
        },

        /* ---------------- USUÁRIOS ---------------- */
        async listarUsuarios() {
            return usuarios
                .map((u) => ({ id: u.id, email: u.email, nome: u.nome, role: u.role, ativo: u.ativo, criado_em: u.criado_em }))
                .sort((a, b) => new Date(a.criado_em) - new Date(b.criado_em) || a.id - b.id);
        },

        async buscarUsuarioPorEmail(email) {
            const alvo = String(email || '').toLowerCase();
            return usuarios.find((u) => u.email.toLowerCase() === alvo) || null;
        },

        async criarUsuario({ email, nome, senhaHash, role }) {
            const novo = {
                id: usuarioId++,
                email,
                nome,
                role: role || 'colaborador',
                ativo: true,
                senha_hash: senhaHash,
                criado_em: new Date().toISOString()
            };
            usuarios.push(novo);
            return { id: novo.id, email: novo.email, nome: novo.nome, role: novo.role, ativo: novo.ativo };
        },

        async atualizarUsuario(id, { nome, role, ativo, senhaHash }) {
            const usuario = usuarios.find((u) => String(u.id) === String(id));
            if (!usuario) return false;
            if (nome !== undefined) usuario.nome = nome;
            if (role !== undefined) usuario.role = role;
            if (ativo !== undefined) usuario.ativo = !!ativo;
            if (senhaHash) usuario.senha_hash = senhaHash;
            return true;
        },

        async excluirUsuario(id) {
            const indice = usuarios.findIndex((u) => String(u.id) === String(id));
            if (indice < 0) return false;
            usuarios.splice(indice, 1);
            return true;
        },

        /* ---------------- CAMPANHAS ---------------- */
        async criarCampanha({
            nome, listaId: idLista, mensagem, intervaloMs, contatos, vendedorEmail, vendedorNome,
            canal, templateNome, templateIdioma, templateParametros,
            criadoPorEmail, criadoPorNome
        }) {
            const id = campanhaId++;
            campanhas.push({
                id,
                nome,
                lista_id: idLista || null,
                mensagem,
                canal: canal === 'template' ? 'template' : 'texto',
                template_nome: templateNome || null,
                template_idioma: templateIdioma || null,
                template_parametros: Array.isArray(templateParametros) ? templateParametros : [],
                intervalo_ms: intervaloMs,
                vendedor_email: vendedorEmail || null,
                vendedor_nome: vendedorNome || null,
                criado_por_email: criadoPorEmail || null,
                criado_por_nome: criadoPorNome || null,
                status: 'ativa',
                total: contatos.length,
                enviados: 0,
                falhas: 0,
                proximo_envio_em: new Date().toISOString(),
                criado_em: new Date().toISOString(),
                atualizado_em: new Date().toISOString()
            });

            contatos.forEach((contato) => {
                envios.push({
                    id: envioId++,
                    campanha_id: id,
                    telefone: contato.telefone,
                    nome: contato.nome || null,
                    mensagem: contato.mensagem || null,
                    parametros: Array.isArray(contato.parametros) ? contato.parametros : [],
                    status: 'pendente',
                    erro: null,
                    enviado_em: null
                });
            });

            return { id, total: contatos.length };
        },

        async listarCampanhas() {
            return campanhas
                .slice()
                .sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em))
                .slice(0, 50)
                .map((c) => Object.assign({}, c, {
                    pendentes: envios.filter((e) => e.campanha_id === c.id && (e.status === 'pendente' || e.status === 'enviando')).length
                }));
        },

        async atualizarStatusCampanha(id, status) {
            const campanha = campanhas.find((c) => String(c.id) === String(id));
            if (!campanha) return false;
            campanha.status = status;
            campanha.atualizado_em = new Date().toISOString();
            return true;
        },

        async direcionarCampanha(id, vendedorEmail, vendedorNome) {
            const campanha = campanhas.find((c) => String(c.id) === String(id));
            if (!campanha) return false;
            campanha.vendedor_email = vendedorEmail || null;
            campanha.vendedor_nome = vendedorNome || null;
            campanha.atualizado_em = new Date().toISOString();
            return true;
        },

        async excluirCampanha(id) {
            const indice = campanhas.findIndex((c) => String(c.id) === String(id));
            if (indice < 0) return false;
            campanhas.splice(indice, 1);
            for (let i = envios.length - 1; i >= 0; i--) {
                if (String(envios[i].campanha_id) === String(id)) envios.splice(i, 1);
            }
            return true;
        },

        async resumoCampanhas() {
            return {
                total: campanhas.length,
                ativas: campanhas.filter((c) => c.status === 'ativa').length
            };
        },

        async proximoEnvioPendente() {
            const agora = Date.now();

            const envio = envios.find((e) => {
                if (e.status !== 'pendente') return false;
                const campanha = campanhas.find((c) => c.id === e.campanha_id);
                if (!campanha || campanha.status !== 'ativa') return false;
                return new Date(campanha.proximo_envio_em).getTime() <= agora;
            });
            if (!envio) return null;

            const campanha = campanhas.find((c) => c.id === envio.campanha_id);
            return {
                envio_id: envio.id,
                telefone: envio.telefone,
                nome: envio.nome,
                envio_mensagem: envio.mensagem || null,
                envio_parametros: Array.isArray(envio.parametros) ? envio.parametros.slice() : [],
                campanha_id: campanha.id,
                campanha: campanha.nome,
                mensagem: campanha.mensagem,
                canal: campanha.canal || 'texto',
                template_nome: campanha.template_nome || null,
                template_idioma: campanha.template_idioma || null,
                vendedor_email: campanha.vendedor_email || null,
                vendedor_nome: campanha.vendedor_nome || null,
                criado_por_email: campanha.criado_por_email || null,
                criado_por_nome: campanha.criado_por_nome || null
            };
        },

        async reservarEnvio(id) {
            const envio = envios.find((e) => String(e.id) === String(id));
            if (!envio || envio.status !== 'pendente') return false;
            envio.status = 'enviando';
            return true;
        },

        async concluirEnvio(id, idCampanha, ok, erro) {
            const envio = envios.find((e) => String(e.id) === String(id));
            if (envio) {
                envio.status = ok ? 'enviado' : 'falha';
                envio.erro = erro || null;
                envio.enviado_em = new Date().toISOString();
            }

            const campanha = campanhas.find((c) => String(c.id) === String(idCampanha));
            if (!campanha) return;

            if (ok) campanha.enviados += 1; else campanha.falhas += 1;
            campanha.proximo_envio_em = new Date(Date.now() + campanha.intervalo_ms).toISOString();
            campanha.atualizado_em = new Date().toISOString();

            const restantes = envios.filter((e) => e.campanha_id === campanha.id && (e.status === 'pendente' || e.status === 'enviando'));
            if (!restantes.length) campanha.status = 'concluida';
        },

        /* ---------------- EVENTOS DA WATI (webhook) ---------------- */
        async registrarEventoWati(evento) {
            const dados = evento || {};
            const registro = {
                id: eventoWatiId++,
                tipo: String(dados.tipo || 'desconhecido').substring(0, 60),
                telefone: dados.telefone || null,
                nome: dados.nome || null,
                campanha: dados.campanha || null,
                texto: dados.texto ? String(dados.texto).substring(0, 2000) : null,
                status: dados.status || null,
                whatsapp_message_id: dados.whatsappMessageId || null,
                payload: dados.payload || {},
                criado_em: new Date().toISOString()
            };

            eventosWati.push(registro);
            return { id: registro.id, criado_em: registro.criado_em };
        },

        async listarEventosWati({ limite, tipos }) {
            const filtrar = Array.isArray(tipos) && tipos.length;
            return eventosWati
                .filter((e) => !filtrar || tipos.includes(e.tipo))
                .slice()
                .sort((a, b) => b.id - a.id)
                .slice(0, limite || 200)
                .map((e) => ({
                    id: e.id, tipo: e.tipo, telefone: e.telefone, nome: e.nome,
                    campanha: e.campanha, texto: e.texto, status: e.status,
                    whatsapp_message_id: e.whatsapp_message_id, criado_em: e.criado_em
                }));
        },

        async ultimoEventoWati() {
            if (!eventosWati.length) return null;
            const ultimo = eventosWati.slice().sort((a, b) => b.id - a.id)[0];
            return {
                id: ultimo.id, tipo: ultimo.tipo, telefone: ultimo.telefone,
                nome: ultimo.nome, campanha: ultimo.campanha, criado_em: ultimo.criado_em
            };
        },

        async contarEventosWatiHoje() {
            const hoje = new Date().toDateString();
            return eventosWati.filter((e) => new Date(e.criado_em).toDateString() === hoje).length;
        },

        async registrarContatoWati({ telefone, nome, atributos }) {
            const numero = String(telefone || '').replace(/\D/g, '');
            if (!numero) return false;

            const atual = clientes.get(numero);
            const extras = atributos && typeof atributos === 'object' ? atributos : {};

            if (atual) {
                clientes.set(numero, Object.assign({}, atual, {
                    nome: atual.nome || String(nome || '').trim() || numero,
                    atributos: Object.assign({}, atual.atributos || {}, extras)
                }));
                return true;
            }

            semearCliente({
                nome: String(nome || '').trim() || numero,
                telefone: numero,
                atributos: Object.assign({}, extras),
                mensagem: '',
                status: 'pensando',
                criado_em: new Date().toISOString()
            });
            return true;
        },

        /* ---------------- LOGS / AUDITORIA ---------------- */
        async listarLogs({ limite, direcao }) {
            return mensagens
                .filter((m) => !direcao || m.direcao === direcao)
                .sort((a, b) => b.id - a.id)
                .slice(0, limite)
                .map((m) => {
                    const cliente = clientes.get(m.telefone);
                    return {
                        id: m.id,
                        telefone: m.telefone,
                        direcao: m.direcao,
                        texto: m.texto,
                        criado_em: m.criado_em,
                        nome: cliente ? cliente.nome : null
                    };
                });
        },

        /* ---------------- CONVERSAS: BACKUP E LIMPEZA ---------------- */
        async exportarConversas() {
            return {
                gerado_em: new Date().toISOString(),
                mensagens: mensagens.map((m) => {
                    const cliente = clientes.get(m.telefone);
                    return {
                        id: m.id, telefone: m.telefone, nome: cliente ? cliente.nome : null,
                        direcao: m.direcao, texto: m.texto,
                        autor_email: m.autor_email || null, autor_nome: m.autor_nome || null,
                        campanha_id: m.campanha_id || null, origem: m.origem || null,
                        criado_em: m.criado_em
                    };
                }),
                clientes: Array.from(clientes.values()).map((c) => ({
                    telefone: c.telefone, nome: c.nome, status: c.status, mensagem: c.mensagem,
                    vendedor_email: c.vendedor_email || null, vendedor_nome: c.vendedor_nome || null
                }))
            };
        },

        async contarConversas() {
            let clientesComPrevia = 0;
            clientes.forEach((c) => { if (String(c.mensagem || '') !== '') clientesComPrevia += 1; });
            return {
                mensagens: mensagens.length,
                eventosMensagem: eventosWati.filter((e) => e.tipo === 'message' || String(e.texto || '') !== '').length,
                clientesComPrevia
            };
        },

        async limparConversas({ incluirEventosWati = true } = {}) {
            const removidas = mensagens.length;
            mensagens.length = 0;

            let clientesAtualizados = 0;
            clientes.forEach((c) => {
                if (String(c.mensagem || '') !== '') {
                    c.mensagem = '';
                    clientesAtualizados += 1;
                }
            });

            let eventosRemovidos = 0;
            if (incluirEventosWati) {
                for (let i = eventosWati.length - 1; i >= 0; i--) {
                    if (eventosWati[i].tipo === 'message' || String(eventosWati[i].texto || '') !== '') {
                        eventosWati.splice(i, 1);
                        eventosRemovidos += 1;
                    }
                }
            }

            return { mensagensRemovidas: removidas, clientesAtualizados, eventosRemovidos };
        },

        async contarDados() {
            let clientesComPrevia = 0;
            clientes.forEach((c) => { if (String(c.mensagem || '') !== '') clientesComPrevia += 1; });

            return {
                clientes: clientes.size,
                clientesComPrevia,
                listas: listas.length,
                campanhas: campanhas.length,
                mensagens: mensagens.length,
                eventosMensagem: eventosWati.filter((e) => e.tipo === 'message' || String(e.texto || '') !== '').length
            };
        },

        async limparDados({ incluirEventosWati = true } = {}) {
            const mensagensRemovidas = mensagens.length;
            mensagens.length = 0;

            const clientesRemovidos = clientes.size;
            clientes.clear();

            const listasRemovidas = listas.length;
            listas.length = 0;

            let eventosRemovidos = 0;
            if (incluirEventosWati) {
                for (let i = eventosWati.length - 1; i >= 0; i--) {
                    if (eventosWati[i].tipo === 'message' || String(eventosWati[i].texto || '') !== '') {
                        eventosWati.splice(i, 1);
                        eventosRemovidos += 1;
                    }
                }
            }

            return { mensagensRemovidas, clientesRemovidos, listasRemovidas, eventosRemovidos };
        },

        async registrarAuditoria(ator, acao, detalhe) {
            auditoria.push({
                id: auditoriaId++,
                ator: ator || null,
                acao,
                detalhe: detalhe || null,
                criado_em: new Date().toISOString()
            });
        },

        async listarAuditoria(limite) {
            return auditoria
                .slice()
                .sort((a, b) => b.id - a.id)
                .slice(0, limite);
        },

        async obterOuCriarConfiguracao(chave, gerarValor) {
            if (configuracoes.has(chave)) return configuracoes.get(chave);

            const valor = typeof gerarValor === 'function' ? String(gerarValor()) : String(gerarValor);
            configuracoes.set(chave, valor);
            return valor;
        },

        async obterConfiguracao(chave) {
            return configuracoes.has(chave) ? configuracoes.get(chave) : null;
        },

        async definirConfiguracao(chave, valor) {
            configuracoes.set(chave, String(valor));
        }
    };
}

/* ---------------------------------------------------------
   ESCOLHA AUTOMÁTICA + EXPORTAÇÃO
   --------------------------------------------------------- */
const banco = MODO_DEMO ? criarBancoMemoria() : criarBancoPostgres();
banco.modoDemo = MODO_DEMO;

module.exports = banco;


# Incidente: conversas "sumindo" da carteira dos colaboradores

> Documento de handoff (25/11/2026). Diagnóstico feito **somente leitura** contra o
> painel de produção `https://webhook-wati.onrender.com` (login admin).
> **Nenhum arquivo de código foi alterado ainda** — esta é a base para a correção.

---

## 1. O que os colaboradores relataram

- `jv` (`jvzika@qgcteam.com`), `c98` (`c98@qgcteam.com`) e `NRZ` (`nariz@qgcteam.com`)
  dizem que as conversas "sumiram" do painel `/colaborador`.
- O painel mostra a mensagem **"Nenhum lead na sua carteira."**

## 2. Como o painel decide o que mostrar

1. `colaborador.js` → `carregarClientes()` chama `GET /api/clientes?limite=200&status=...`
   (**sem** filtro de dono: o servidor decide pelo token).
2. `index.js` → `app.get('/api/clientes')` (linhas ~1577-1596):
   - admin (`ehAdmin(req)`) → vê tudo, podendo filtrar por `?vendedor=email`;
   - colaborador → `vendedorEmail = req.user.email` (do JWT).
3. `db.js` → `listarClientes()` (linhas ~190-220) aplica
   `LOWER(vendedor_email) = LOWER($n)`.
4. `renderizarLista()` (colaborador.js ~186) mostra **"Nenhum lead na sua carteira."**
   sempre que a API devolve `[]`.

Ou seja: **lista vazia = a API respondeu 200 com zero leads para o e-mail logado**
(erro de rede/401 mostraria "Erro ao carregar seus contatos.").

## 3. Situação real da base (medida em produção)

| Carteira | Leads |
|---|---|
| `nariz@qgcteam.com` (NRZ) | 62 |
| `jvzika@qgcteam.com` (jv) | 54 |
| `breno@qgcteam.com` (RICA) | 42 |
| `c98@qgcteam.com` (98) | 41 |
| `colaborador@qgcteam.com` (Claudio – **conta excluída**) | 20 |
| **sem dono** (`vendedor_email` nulo) | 42 |
| **total de contatos** | 261 |

- A API responde corretamente para todos: `status=ativos` e `status=todos` devolvem
  41 / 62 / 54 / 42 (testado com `?vendedor=<email>`).
- **Não existe divergência de e-mail/caixa/espaço**: os valores crus em
  `clientes.vendedor_email` são exatamente `c98@qgcteam.com`, `nariz@qgcteam.com`, etc.
- **Não houve exclusão de leads**: 0 mensagens apontam para telefone que não existe
  mais em `clientes`.
- Todos os leads estão com `status = 'pensando'` (nada preso em "finalizado").
- 42 leads estão **sem dono**, 13 deles já com mensagens recebidas (respostas de
  clientes que ninguém enxerga, só o admin).

## 4. Causa raiz confirmada: campanha **rouba** o lead de quem já estava atendendo

`db.js` → `atribuirVendedor()` (linhas ~504-520):

```sql
INSERT INTO clientes (nome, telefone, mensagem, status, vendedor_email, vendedor_nome, responsavel)
VALUES ($1, $2, '', 'pensando', $3, $4, $5)
ON CONFLICT (telefone) DO UPDATE
   SET vendedor_email = EXCLUDED.vendedor_email,   -- <== SOBRESCREVE o dono atual
       vendedor_nome = EXCLUDED.vendedor_nome,
       responsavel = COALESCE(NULLIF(clientes.responsavel, ''), EXCLUDED.responsavel)
```

`atribuirVendedor` é chamada por `registrarEnvioBemSucedido()` (`index.js` ~2664-2693)
a **cada mensagem aceita pela Wati**. Se o contato de uma campanha já pertence a outro
colaborador, ele é transferido em silêncio para o dono da campanha.

### Prova concreta (a única conversa perdida de verdade)

| Lead | Conversa | Dono agora |
|---|---|---|
| `5518996993769` | NRZ respondeu em **25/11 17:48:26** | **c98** |

A campanha **#10** (41 contatos, direcionada a `c98`, enviada às **17:50:16**) incluiu
esse contato e o levou de NRZ. É exatamente o "sumiu do NRZ depois que enviei a
campanha de novo redirecionada".

### Conferência de quem **não** perdeu nada

| Colaborador | Conversas próprias | Ainda na carteira |
|---|---|---|
| `breno@` (RICA) | 5 | 5 ✔ |
| `jvzika@` (jv) | 3 | 3 ✔ |
| `c98@` (98) | 1 | 1 ✔ |
| `nariz@` (NRZ) | 1 | **0 — roubada pela campanha #10** |

Mapa campanha → dono atual (nenhuma outra troca de dono foi encontrada):

```
#11 -> jvzika=24 (destino jvzika)
#10 -> c98=41     (destino c98)
#9  -> nariz=37   (destino nariz)
#7  -> jvzika=6   (destino jvzika)
#6  -> jvzika=24  (destino jvzika)
#5  -> nariz=25   (destino nariz)
#4  -> breno=42   (destino breno)
#3  -> colaborador=20 (destino colaborador)
```

## 5. Vetores de perda que continuam abertos

1. **Campanha sobrescreve dono** (item 4) — principal, ainda ativo.
2. **Excluir usuário órfã os leads**: `DELETE /api/usuarios/:id` (`index.js` ~2505)
   apaga só o usuário. Os 20 leads de Claudio ficaram sem acesso (só o admin vê).
3. **42 leads sem dono**: contatos criados pelo webhook/importação nascem com
   `vendedor_email` nulo e nunca entram na carteira de ninguém.
4. **Telefone com formatos diferentes** gera contato duplicado (5 casos achados):
   `11972375899` × `5511972375899`, `551999044268` × `5519999044268`,
   `554499981028` × `5544999981028`, `556281708669` × `5562981708669`,
   `557788597942` × `5577988597942`. A resposta do cliente cai no contato novo
   (sem dono) e "desaparece" da conversa que o colaborador estava atendendo.

## 6. Plano de correção (não aplicado ainda)

1. **`db.js` → `atribuirVendedor()` (Postgres e modo demo):** só preencher o dono
   quando estiver vazio.
   ```sql
   ON CONFLICT (telefone) DO UPDATE
      SET vendedor_email = COALESCE(NULLIF(TRIM(clientes.vendedor_email), ''), EXCLUDED.vendedor_email),
          vendedor_nome  = COALESCE(NULLIF(TRIM(clientes.vendedor_nome),  ''), EXCLUDED.vendedor_nome),
          responsavel    = COALESCE(NULLIF(clientes.responsavel, ''), EXCLUDED.responsavel)
   ```
   Assim campanha só **inclui** lead novo; nunca **rouba** lead de outro colaborador.
2. **`db.js` → `listarClientes()`:** comparar com `TRIM` dos dois lados
   (`LOWER(TRIM(vendedor_email)) = LOWER(TRIM($n))`) — defesa contra espaço/caixa.
3. **`index.js` → `DELETE /api/usuarios/:id`:** se o usuário tem leads, responder
   `409` com a contagem e aceitar `?transferirPara=<email>` para transferir antes de
   excluir (nunca mais deixar lead órfão). Espelhar em `app.js`
   `excluirUsuario()` (oferecer o e-mail de destino quando a API devolver `409`).
4. **`colaborador.js`:** tratar `401` em `carregarClientes()` com
   `window.location.href = '/login'` (hoje o painel só loga o erro no console) e
   avisar quando a atualização automática falhar.
5. **Telefone:** normalizar o número no webhook/importação (com/sem `55`, com/sem o
   9º dígito) antes do `ON CONFLICT`, juntando os duplicados.
6. **Dados a decidir com o usuário:** os 20 leads de Claudio (transferir para quem?)
   e os 42 sem dono (distribuir? deixar no admin?).

## 7. Testes a criar

- `test-carteira-dono.js`: garante que `atribuirVendedor` **não** troca dono
  existente (modo demo), que `listarClientes` usa `TRIM` e que a rota de exclusão
  devolve `409` com `possuiLeads` (guardas de código, no estilo dos testes atuais).
- Rodar `npm test` e `npm run test:e2e` no fim.

## 8. Estado do repositório

- Código: **intacto** (`git status` só tinha os arquivos temporários de diagnóstico,
  removidos em seguida). Último commit:
  `7b3081c ux: aviso curto de ticket vencido e destaque na barra do template`.
- Scripts de diagnóstico usados nesta investigação **foram apagados** de propósito:
  continham a senha do admin de produção e não devem ir para o repositório.
  Para repetir a medição basta autenticar no painel e consultar:
  `GET /api/clientes?status=todos&limite=200&vendedor=<email>`,
  `GET /api/clientes/vendedores`, `GET /api/conversas/exportar` e
  `GET /api/auditoria?limite=500`.

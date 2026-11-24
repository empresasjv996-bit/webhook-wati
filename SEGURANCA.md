# Segurança / variáveis de ambiente

Variáveis lidas pelo app (`index.js` e `db.js`). No Render, configure em
**Service → Environment** e clique em **Save** (o serviço reinicia sozinho).

| Variável | Obrigatória | Para que serve |
| --- | --- | --- |
| `DATABASE_URL` | sim (produção) | Postgres. Sem ela o app sobe em modo demo (memória). |
| `WATI_TOKEN` | sim | Bearer token da API da Wati. |
| `WATI_NUMERO` | sim | Número/tenant da URL da Wati. |
| `WATI_HOST` | não | Padrão `https://live-mt-server.wati.io`. |
| `JWT_SECRET` | recomendada | Assina o cookie de sessão (`qgc_token`). |
| `WEBHOOK_SECRET` | recomendada | Exige `?token=...` no `POST /webhook`. |
| `PORT` | não | O Render injeta automaticamente. |

## JWT_SECRET

Ordem de preferência usada no boot:

1. `JWT_SECRET` do Environment (mais seguro: o segredo fica fora do banco).
2. Segredo aleatório gerado uma vez e guardado na tabela `configuracoes`
   (`SELECT valor FROM configuracoes WHERE chave = 'jwt_secret'`).
3. Segredo temporário em memória — só acontece se o banco estiver fora do ar;
   nesse caso as sessões caem a cada reinício.

O campo `configurado.jwtSecretOrigem` do `GET /api/health` mostra qual caminho
está em uso: `env`, `banco` ou `temporario`.

Para gerar uma chave (copie o valor e cole no Render):

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Definir ou trocar o `JWT_SECRET` **desloga todos os usuários uma única vez**
(os cookies antigos passam a ser inválidos). Basta cada um entrar de novo.

## WEBHOOK_SECRET

Há dois caminhos (o primeiro tem prioridade se a variável existir):

1. **`WEBHOOK_SECRET` no Render** — o valor é usado direto e o token passa a ser
   exigido em todo `POST /webhook`.
2. **Sem a variável** — o app gera um segredo aleatório, guarda na tabela
   `configuracoes` e mostra a URL pronta em **Canais → Webhook seguro**. Enquanto
   ninguém usa essa URL, o webhook continua aceitando chamadas sem token (para
   não perder mensagens). No primeiro recebimento com token válido a exigência
   liga sozinha; o botão do painel permite ligar/desligar na mão.

Passo a passo (caminho 2, o mais simples):

1. Abra **Canais** no painel admin e copie a URL de *Webhook seguro*
   (`https://webhook-wati.onrender.com/webhook?token=...`).
2. Na Wati, cadastre o webhook com essa URL.
3. Envie uma mensagem de teste para o WhatsApp conectado: o webhook responde
   `200`, a mensagem aparece em **Logs** e a exigência do token é ativada
   automaticamente (aparece `ativo` no painel e em `webhookSecret` no health).

Passo a passo (caminho 1, com env var):

1. Gere um segredo (comando acima) e crie `WEBHOOK_SECRET` no Render.
2. Cadastre na Wati `https://webhook-wati.onrender.com/webhook?token=SEGREDO`.
3. Envie uma mensagem de teste e confira os **Logs**.

> ⚠️ Se a env var `WEBHOOK_SECRET` estiver definida sem a URL da Wati já
> atualizada, as mensagens recebidas são recusadas com `401` (`Webhook recusado:
> segredo inválido.`). Use o caminho 2 para migrar sem risco.

O envio aceita o token na query (`?token=...`) ou no header
`x-webhook-secret`, e compara em tempo constante (`crypto.timingSafeEqual`).

## Conferindo

```powershell
# origem do segredo do JWT + estado do webhook
Invoke-RestMethod https://webhook-wati.onrender.com/api/health |
  Select-Object -ExpandProperty configurado
```

```powershell
# webhook deve responder 401 quando o segredo não for enviado
try { Invoke-WebRequest -Method Post -Uri 'https://webhook-wati.onrender.com/webhook' -Body '{}' -ContentType 'application/json' -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

## Arquivos servidos pelo painel (lista branca)

O `express.static` roda com **lista branca** (`ARQUIVOS_PUBLICOS`, no topo do
`index.js`). Só estes arquivos são públicos:

`index.html`, `app.js`, `style.css`, `login.html`, `login.css`,
`colaborador.html`, `colaborador.css`, `colaborador.js`,
`logo-qgc.png.jpeg`, `favicon.ico`.

Todo o resto responde `404` — inclusive `index.js`, `db.js`, `senha.js`,
`cnpj.js`, `package.json`, `prisma/`, `listas/`, `downloads/`, `backups/`,
`server.log` e qualquer `.md`/`test-*.js`. Arquivos que começam com ponto
(`.env`) também são negados (`dotfiles: 'deny'`).

> Antes dessa correção o projeto inteiro era servido: `https://webhook-wati.onrender.com/index.js`
> e `/db.js` devolviam `200`. Se criar uma tela nova, acrescente o arquivo em
> `ARQUIVOS_PUBLICOS`; sem isso o navegador recebe `404`.

```powershell
# tudo abaixo deve responder 404
'/index.js','/db.js','/package.json','/prisma/schema.prisma','/.env' | ForEach-Object {
  try { (Invoke-WebRequest -Method Head -Uri "https://webhook-wati.onrender.com$_" -UseBasicParsing).StatusCode }
  catch { "$_ -> $($_.Exception.Response.StatusCode.value__)" }
}
```

## Isolamento dos colaboradores

- Cada lead pertence ao vendedor gravado em `clientes.vendedor_email`, que é
  preenchido quando a campanha é disparada para aquele vendedor
  (`/api/campanhas` → worker → `atribuirVendedor`).
- O colaborador só lista e abre leads cujo `vendedor_email` seja o e-mail da
  sessão. A regra vale no servidor: `/api/clientes`, ficha, mensagens, status,
  envio e finalização respondem `403` para leads de outra pessoa.
- O administrador continua vendo tudo. Dashboard, logs, campanhas, listas,
  canais, auditoria, usuários e o SSE (`/api/eventos`) são exclusivos do admin.
- Leads sem dono (importados direto em Listas, antes de uma campanha) ficam
  visíveis apenas para o admin.
- Se uma campanha posterior enviar para o mesmo telefone com outro vendedor,
  o dono passa a ser o vendedor da campanha mais recente.

## Limpeza do histórico de conversas

No painel admin, em **Conversas**, use **⬇ Backup** antes de
**🧹 Limpar histórico**. A limpeza:

- apaga `mensagens`;
- limpa `clientes.mensagem` (a prévia na lista);
- apaga os textos em `eventos_wati` (Atividade Wati);
- mantém clientes, fichas, campanhas, usuários e auditoria.

Também é possível rodar localmente com o `DATABASE_URL` real:

```powershell
node scripts/backup-limpar-conversas.js                  # só backup
node scripts/backup-limpar-conversas.js --confirmar=LIMPAR
```

O script grava o backup em `backups/` antes de apagar e se recusa a rodar no
modo demo (sem `DATABASE_URL` válida).

## Reset dos dados de teste (clientes + conversas + listas)

Em **Conversas**, o botão **🧨 Limpar tudo** faz o reset completo dos dados de
teste de uma só vez (somente administrador):

- apaga todos os `clientes` (as fichas ficam dentro do próprio cliente);
- apaga `mensagens` e limpa as prévias das conversas;
- apaga todas as `listas` importadas;
- apaga os textos de mensagens da Atividade Wati;
- mantém campanhas, usuários, canais, configurações e a auditoria.

A rota exige confirmação digitada (`confirmar: "LIMPAR TUDO"`):

```http
GET  /api/dados/status   -> { clientes, listas, campanhas, mensagens, ... }
POST /api/dados/limpar   { "confirmar": "LIMPAR TUDO", "incluirEventosWati": true }
```

A limpeza grava um registro em **Auditoria** e avisa os painéis abertos pelo
SSE. Use **⬇ Backup** antes: o backup atual baixa apenas as conversas, então
clientes e listas precisam ser exportados separadamente se forem necessários
depois.

## Senhas dos usuários

As contas criadas no primeiro boot usam `123456` (`admin@qgcteam.com`,
`colaborador@qgcteam.com`, `vendedor@qgcteam.com`). Troque em **Usuários** no
painel admin e apague/desative quem não usa mais.

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

## Senhas dos usuários

As contas criadas no primeiro boot usam `123456` (`admin@qgcteam.com`,
`colaborador@qgcteam.com`, `vendedor@qgcteam.com`). Troque em **Usuários** no
painel admin e apague/desative quem não usa mais.

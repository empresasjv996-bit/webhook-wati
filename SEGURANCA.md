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

Com a variável definida, todo `POST /webhook` precisa chegar com o segredo —
`?token=SEGREDO` na URL ou o header `x-webhook-secret`. Passo a passo:

1. Gere um segredo (mesmo comando acima).
2. No Render, crie `WEBHOOK_SECRET` com esse valor e salve.
3. Na Wati, edite o webhook para
   `https://webhook-wati.onrender.com/webhook?token=SEGREDO`.
4. Envie uma mensagem de teste para o WhatsApp conectado e confira em
   **Logs** se aparece `Mensagem salva -> ...`.

> ⚠️ Se definir `WEBHOOK_SECRET` **antes** de atualizar a URL na Wati, as
> mensagens recebidas passam a ser recusadas com `401` (`Webhook recusado:
> segredo inválido.`). Faça na ordem acima (2 → 3) para não perder mensagens.

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

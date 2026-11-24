# DeepSeek — como usar neste projeto

> Documento interno QGC TEAM — integração do DeepSeek no `meu-webhook`.

## 1. Configuração no `.env`

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash
```

| Variável | Obrigatória | Padrão | Para que serve |
|-|-|-|-|
| `DEEPSEEK_API_KEY` | sim | — | Chave da API (`Authorization: Bearer`) |
| `DEEPSEEK_MODEL` | não | `deepseek-flash` | Modelo usado quando não se passa `modelo` |
| `DEEPSEEK_BASE_URL` | não | `https://api.deepseek.com` | Trocar só se usar proxy/gateway |
| `DEEPSEEK_TIMEOUT_MS` | não | `60000` | Timeout de cada requisição |

O `.env` já está no `.gitignore` — nunca sobe para o Git.

## 2. “Consigo usar igual eu usava?” — Sim

A API do DeepSeek é **compatível com a da OpenAI**. O que muda é só a URL base e o nome do modelo:

| OpenAI | DeepSeek |
|-|-|
| `https://api.openai.com/v1/chat/completions` | `https://api.deepseek.com/chat/completions` |
| `model: "gpt-4o-mini"` | `model: "deepseek-flash"` |
| `Authorization: Bearer <key>` | `Authorization: Bearer <key>` (igual) |
| `messages: [{ role, content }]` | `messages: [{ role, content }]` (igual) |
| `response_format: { type: "json_object" }` | funciona igual |

## 3. No projeto (`deepseek.js`)

```js
const { perguntar, conversar, estaConfigurado } = require('./deepseek');

// uma pergunta
const resumo = await perguntar('Resuma este contrato em 3 linhas: ...', {
    sistema: 'Você é um assistente objetivo.',
    maxTokens: 1024,
    temperature: 0.3
});

// conversa com histórico
const resposta = await conversar([
    { role: 'system', content: 'Você é um assistente objetivo.' },
    { role: 'user', content: 'Primeira pergunta' },
    { role: 'assistant', content: 'Primeira resposta' },
    { role: 'user', content: 'Segunda pergunta' }
]);
```

Opções aceitas: `modelo`, `maxTokens`, `temperature`, `json` (força objeto JSON), `timeoutMs`.

## 4. Sem o módulo (fetch puro)

```js
const resposta = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'Oi' }]
    })
});
const dados = await resposta.json();
console.log(dados.choices[0].message.content);
```

## 5. Com o SDK oficial da OpenAI

```bash
npm i openai
```

```js
const OpenAI = require('openai');

const cliente = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com'
});

const r = await cliente.chat.completions.create({
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Oi' }]
});
```

## 6. Modelos disponíveis nesta conta

Confirmado via `GET https://api.deepseek.com/models`:

| Modelo | Observação |
|-|-|
| `deepseek-flash` | rápido/barato — padrão do projeto (o alias `deepseek-chat` cai nele) |
| `deepseek-v4-pro` | mais forte; resposta simples levou ~1,5s |

## 7. Cuidado: são modelos de raciocínio

Eles “pensam” antes de responder (`reasoning_content`) e esses tokens contam no `max_tokens`.
Com `maxTokens` baixo (ex.: 10) a resposta volta **vazia** com `finish_reason: "length"`.
O `deepseek.js` detecta esse caso e lança erro pedindo para aumentar `maxTokens` — use pelo menos 256/512.

## 8. Como testar

### Teste automatizado (recomendado)

```bash
npm run test:deepseek
```

Saída esperada:

```
config: modelo=deepseek-flash base=https://api.deepseek.com
chave configurada: sim
resposta da API: "ok"

3 teste(s) ok.
```

Sem chave no `.env` ele só valida a configuração e avisa que a chamada real foi pulada.

### Teste manual (perguntas de verdade)

```bash
node exemplo-deepseek.js
node exemplo-deepseek.js "Em uma frase: o que é um token JWT?"
node exemplo-deepseek.js "Diga apenas: v4 ok" deepseek-v4-pro
```

Formato: `node exemplo-deepseek.js "<pergunta>" [modelo]`. Ele mostra o modelo, o tempo de resposta e o texto.

### Conferir só a chave (sem passar pelo código)

PowerShell:

```powershell
$k = 'sua-chave'
Invoke-RestMethod -Uri 'https://api.deepseek.com/models' -Headers @{ Authorization = "Bearer $k" } |
    Select-Object -ExpandProperty data | Select-Object -ExpandProperty id
```

Retorna os modelos disponíveis (`deepseek-flash`, `deepseek-v4-pro`). Se der 401, a chave está errada/revogada.

### Mensagens de erro que você vai ver

| Situação | Mensagem |
|-|-|
| Chave ausente no `.env` | `DEEPSEEK_API_KEY não configurada (veja .env.exemplo).` |
| Chave inválida/revogada | `DeepSeek: Authentication Fails, Your api key: ****xxxx is invalid` |
| `maxTokens` baixo em modelo de raciocínio | `DeepSeek: limite de tokens atingido antes da resposta — aumente maxTokens.` |
| Timeout (`DEEPSEEK_TIMEOUT_MS`) | `The operation was aborted due to timeout` |

## 9. Segurança

- A chave foi colada em um chat: **rotacione** em `platform.deepseek.com` e atualize o `.env`.
- O `.env` fica em pasta sincronizada do OneDrive — trate como segredo (não compartilhe a pasta).
- Em produção (Render), cadastre `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` no Environment, não no código.

## 10. Usar o DeepSeek no Claude Code (CLI)

Quando o login da Anthropic expira (`Login expired · Please run /login`), dá para continuar usando o `claude`
com a chave do DeepSeek — o endpoint `https://api.deepseek.com/anthropic` fala o mesmo protocolo (`/v1/messages`).

Configuração aplicada em `C:\Users\ronal\.claude\settings.json` (bloco `env`, vale para todas as pastas):

```json
"env": {
  "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
  "ANTHROPIC_AUTH_TOKEN": "sk-...",
  "ANTHROPIC_MODEL": "deepseek-flash[1m]",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-flash[1m]",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-flash[1m]",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-flash",
  "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-flash",
  "CLAUDE_CODE_EFFORT_LEVEL": "max",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "786432",
  "CLAUDE_CODE_AUTO_MODE_SERVER": "0"
}
```

- Backup do arquivo anterior: `C:\Users\ronal\.claude\settings.json.bak-cline` (o original estava com JSON inválido — faltava a `{` inicial e sobrava um `]`).
- Para voltar a usar a Anthropic, remova o bloco `env` (ou restaure o backup) e rode `/login`.
- Sessões do `claude` **abertas antes da mudança** precisam ser reiniciadas.
- Para usar o modelo mais forte no CLI: troque os valores para `deepseek-v4-pro` (custa mais por token).

### Teste rápido do CLI (não interativo)

```powershell
claude -p "Diga apenas: ok" --max-turns 1
```

Saída esperada: `ok`. O aviso `[claude-code:unrecognized_model]` é cosmético — o CLI não conhece
nomes fora da Anthropic, mas a requisição é roteada corretamente pelo DeepSeek.

### Verificar o endpoint Anthropic na mão

```powershell
$k = 'sua-chave'
$body = @{ model = 'claude-sonnet-4-5'; max_tokens = 64; messages = @(@{ role = 'user'; content = 'Diga ok' }) } |
    ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri 'https://api.deepseek.com/anthropic/v1/messages' -Method Post `
    -Headers @{ 'x-api-key' = $k; 'anthropic-version' = '2023-06-01'; 'Content-Type' = 'application/json' } `
    -Body $body
```

### Mapeamento automático de modelos

| Nome enviado pelo Claude Code | Modelo DeepSeek usado | Preço |
|-|-|-|
| `claude-opus-*` | `deepseek-v4-pro` | preço V4 Pro (mais caro) |
| `claude-sonnet-*` / `claude-haiku-*` | `deepseek-flash` | preço flash |
| `deepseek-flash` / `deepseek-v4-pro` | ele mesmo | normal |

### Problemas comuns no CLI

| Sintoma | Causa / solução |
|-|-|
| `Login expired · Please run /login` | esperado sem login Anthropic — com o `env` acima o `claude` usa o DeepSeek (feche e reabra a sessão) |
| `Auto-update failed: claude.exe in use` | feche **todas** as janelas do `claude` e rode `claude update` (aqui já está na 2.1.331, a última) |
| `401 Authentication Fails` | chave errada/revogada — confira `ANTHROPIC_AUTH_TOKEN` |
| Resposta vazia no Claude Code | modelo de raciocínio sem espaço de tokens — o CLI já envia `max_tokens` alto, mas evite `--max-tokens` baixo |
| `Auto mode classifier` / `session isn't eligible` | gateway na frente da API — ver a seção seguinte (`CLAUDE_CODE_AUTO_MODE_SERVER=0`) |

### Aviso “auto mode classifier” (aparece quando o gateway é o DeepSeek)

```
We're changing auto mode to no longer charge for classifier requests in Claude Code.
However, this session isn't eligible because your requests go through api.deepseek.com...
Press Enter to continue
```

**O que é:** no auto mode, um classificador decide se cada ação (comando de shell, request de rede)
pode rodar sem pedir confirmação. Em sessão direta na Anthropic essa checagem é feita no servidor e
não é cobrada. Com um gateway no meio (`api.deepseek.com`), a checagem não chega ao servidor, então o
próprio Claude Code faz as requisições de classificação — e elas contam como tokens da sua conta.

**Correção aplicada** (recomendada pela doc da Anthropic para gateways que não suportam as checagens):

```json
"CLAUDE_CODE_AUTO_MODE_SERVER": "0"
```

Com isso o classificador é sempre do próprio Claude Code, cobrado do mesmo jeito, e **o aviso não
aparece mais**. A variável é temporária e pode ser removida em versões futuras da Anthropic.

**Sem a variável:** `Enter` continua (não repete na sessão; quando o gateway é nomeado, fica 24h na
máquina) e `Esc` cancela a ação que estava retida.

**Por que não dá para “ficar elegível” com o DeepSeek:** o gateway teria que repassar o header
`anthropic-beta` junto com o campo `safeguards` no request e devolver `safeguard_results` na resposta.
O DeepSeek não implementa isso.

**Conferir na sessão:** `/status` → linha **Auto mode server** (`Enabled`/`Disabled`).

**Custo:** cada checagem do classificador consome tokens do DeepSeek (no `flash` é barato). Se você
fizer muitas ações por sessão, vale ampliar o allowlist em `permissions.allow` para o que é rotina:

```json
"permissions": {
  "allow": [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(npm test:*)",
    "Bash(node -v)"
  ]
}
```

Isso reduz o número de ações que precisam de classificação (e de prompts, caso a Anthropic remova o
fallback numa versão futura).

## 12. Paridade de ferramentas com o Claude

Auditoria feita com `claude -p --output-format stream-json --verbose` (mensagem `system/init`, que lista
as ferramentas reais da sessão) rodando dentro de `C:\Users\ronal\pentest-lab`.

### Ferramentas: idênticas

```
Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree,
Glob, Grep, ListAgents, McpTaskCheck, Monitor, NotebookEdit, PushNotification, Read,
ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, ToolSearch, WebFetch,
WebSearch, Workflow, Write, Yield                                    → 28 ferramentas
```

Também carregam: **19 skills**, 5 agentes (`claude`, `Explore`, `general-purpose`, `Plan`,
`statusline-setup`) e os 4 plugins builtin. O campo `served_by_anthropic` fica `false` — é esperado,
só indica que a inferência não passa pela Anthropic.

### O que realmente estava diferente (e foi corrigido)

| Problema encontrado | Correção |
|-|-|
| Modelo `deepseek-flash` em tudo — fraco para cadeias de tool-use | `ANTHROPIC_MODEL`, `DEFAULT_OPUS/SONNET` e `CLAUDE_CODE_SUBAGENT_MODEL` → `deepseek-v4-pro`; `HAIKU` segue `deepseek-flash` (barato) |
| `ferramentas.md` (guia Kaido, 35 KB) **nunca era carregado** | `@ferramentas.md` no topo de `pentest-lab/CLAUDE.md` (import de memória) |
| Nenhuma memória global: fora da pasta `pentest-lab` o CLI não sabia que era a APT01 | criado `C:\Users\ronal\.claude\CLAUDE.md` (equipe, estilo, pasta de saída, ponteiros para `ferramentas.md` e para o `meu-webhook`) |
| Regras `Write(./workspace/**)`, `Write(./skills/**)`, `Write(./plugins/**)` **nunca valeram** — o CLI avisa: *"only Edit(path) rules are [matched] — Use Edit(...) instead"* | trocadas por `Edit(./workspace/**)`, `Edit(./skills/**)`, `Edit(./plugins/**)` em `pentest-lab/.claude/settings.json` |

### Testes de comprovação

| Teste | Resultado |
|-|-|
| `claude -p "Use a ferramenta Bash para rodar: echo ok-tools"` | `ok-tools` (2 turnos) — tool-use funcionando |
| `claude -p` perguntando o endpoint de CNPJ **só** pelo `ferramentas.md` | `GET https://kaido.sh/api/cnpj/<cnpj>` + header `x-api-key` — import de memória OK |
| `claude -p` em `%TEMP%` perguntando quem é a equipe | respondeu `APT01` + `workspace\<alvo>\` — memória global OK |
| `claude -p "Crie workspace/teste-cli.txt com ok-paridade"` | arquivo criado, `permission_denials: []` — correção `Write`→`Edit` OK |

### Limitação real: `WebSearch` e `WebFetch`

Ambas aparecem na lista, mas **falham** com o gateway DeepSeek:

- `WebSearch` → `is_error: true`, resultado vazio (é ferramenta server-side da Anthropic: o DeepSeek
  não executa `web_search_20250305`).
- `WebFetch` → `Error: Reached max turns (2)`, com o log `[claude-code:unrecognized_model]
  {"model":"deepseek-flash","query_source":"web_fetch_apply"}`; testado também forçando
  `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-pro` e falhou igual.

**Substituto:** `Bash` com `curl`/`python` (o projeto permite `Bash(curl *)` em
`pentest-lab/.claude/settings.local.json`). Já registrado na memória global para o modelo não insistir
nas ferramentas quebradas.

### Se quiser de volta o WebSearch real

Só apontando o CLI para a Anthropic (`ANTHROPIC_BASE_URL` removido + `/login`), ou para um gateway que
implemente as ferramentas server-side. Não há flag que ligue isso via DeepSeek.




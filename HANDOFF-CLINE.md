# HANDOFF — Painel meu-webhook / Verificação SpyHub

> Documento de passagem completo para o **Cline** (ou outra sessão de IA) continuar o trabalho.
> Gerado em **26/11/2026** pela equipe APT01 (sessão Claude Code).
> Projeto: `C:\Users\ronal\OneDrive\Desktop\meu-webhook`
> Produção: `https://webhook-wati.onrender.com`
> Repositório: `https://github.com/empresasjv996-bit/webhook-wati.git` (branch `main`)

---

## 0. TL;DR — onde estamos e o que falta

**O código está pronto, testado, commitado, enviado ao GitHub e o Render já está servindo a versão nova.**
O problema relatado pelo operador ("ainda não aparece no painel") **não é mais falta de deploy**:
o `index.html` de produção contém o item de menu e a tela do SpyHub (evidência na seção 5).

O que o Cline precisa fazer primeiro (em ordem):

1. Descobrir **qual URL** o operador está abrindo (`location.href` na aba do painel).
2. Confirmar que a sessão é de **admin** (a tela é exclusiva de admin; colaborador usa outro painel).
3. Confirmar no DOM se o botão `[data-view="spyhub"]` existe na página carregada.
4. Se existir: explicar que ele fica no **dropdown "Contatos ▾"** (não é aba no topo) e abrir para o operador.
5. Se não existir: forçar reload sem cache / janela anônima / checar domínio próprio + Cloudflare.
6. Depois de visível: conferir `SPYHUB_USUARIO`/`SPYHUB_SENHA` no Render e rodar 1 verificação.
7. Se o login do SpyHub falhar no Render (captcha/headless), usar o motor local validado (seção 9).

**Nada precisa ser reimplementado.** O que falta é diagnóstico de exibição/ambiente e, possivelmente,
configuração de variáveis no Render.

---

## 1. O que é a tarefa

Na aba **Contatos** do painel administrativo, o operador cola um dump/CSV com **CPF + 4 últimos
dígitos do telefone**. O sistema consulta cada CPF em `https://app.spyhub.io/search/pessoa-fisica`
e entrega:

- **aprovados**: CPF cujo resultado do site contém um telefone terminando nos 4 dígitos pedidos;
- **reprovados**: sem correspondência ou erro, preservando a ficha original + trecho do retorno;
- exportação **CSV** (aprovados, com BOM) e **TXT** (reprovados).

Isso substitui o trabalho manual de abrir o SpyHub, digitar CPF e comparar telefone por telefone.

---

## 2. Arquitetura (como funciona)

```
painel (index.html + app.js)
   │  cola lista/CSV; POST /api/spyhub/verificar { texto }
   ▼
routes/contatos-spyhub.js  (admin-only)
   │  parse no servidor (spyhub-parser.js)
   │  job em memória (1 por vez)
   ▼
spyhub.js — motor CDP próprio
   │  abre Chrome dedicado: porta CDP 9226, perfil %TEMP%\qgc-painel-spyhub
   │  login com SPYHUB_USUARIO/SPYHUB_SENHA (ou sessão já salva no perfil)
   │  /search/pessoa-fisica → aba CPF → digita CPF → CONSULTAR
   │  varre só o texto que apareceu DEPOIS do clique (textoNovoDepois)
   │  procura telefone terminando nos 4 dígitos (aceita máscara)
   ▼
GET /api/spyhub/jobs/:id  (polling de 1,5 s na tela)
   ├─ aprovados  → GET /api/spyhub/jobs/:id/aprovados.csv  (BOM UTF-8)
   └─ reprovados → GET /api/spyhub/jobs/:id/reprovados.txt
```

- Um job por vez (409 se já houver verificação em andamento).
- Estado do job **em memória**: se o servidor reiniciar, o painel pede para rodar de novo.
- O motor **não** usa puppeteer/playwright: é CDP puro (WebSocket nativo do Node).
- Chrome/perfil/porta são próprios do SpyHub, então ele pode rodar junto com o extrator
  (que usa porta 9224 e perfil `qgc-painel-extrator`).

---

## 3. Estado do git e do deploy (fatos)

```
branch main
7fb7271  feat: motor de verificacao SpyHub na aba Contatos
f64f0f0  test: E2E visual do painel SpyHub em modo demo
```

- Push realizado: `decf583..f64f0f0 main -> main` (GitHub `empresasjv996-bit/webhook-wati`).
- Render builda **Docker** a partir do `main` (Dockerfile na raiz; Chromium instalado; `EXTRATOR_HEADLESS=1`;
  `PORT=10000`; `CHROME_PATH=/usr/bin/chromium`).
- Deploy confirmado ao vivo (26/11):
  - `app.js` de produção: **57** ocorrências de `spyhub`
  - `style.css`: **13** classes `spyhub-*`
  - `index.html`: **15** ocorrências (menu + tela)
  - headers: `Cache-Control: public, max-age=0`, `cf-cache-status: DYNAMIC` (Cloudflare na frente, sem cache de HTML),
    `last-modified: Thu, 26 Nov 2026 06:43:18 GMT`
- Não há service worker no app (verificado: 0 ocorrências em `index.html`/`app.js`).

### 3.1. Onde o item aparece no painel

O topo do painel tem: `Início`, `Listas`, e os grupos **Contatos ▾**, **Envio ▾**, **Sistema ▾**.
O item **não é aba no topo**. Caminho exato:

**Contatos ▾ → submenu → 4º item: "Verificação SpyHub — CPF x final do telefone"**

Markup de produção (público em `/index.html`):

```html
<button type="button" data-view="spyhub" onclick="irPara('spyhub')">
    Verificação SpyHub <small>CPF x final do telefone</small>
</button>
```

A tela correspondente é `<section class="view oculto" id="view-spyhub">`.

---

## 4. Ambiente da máquina (estado real, 26/11)

- **Porta 3000 e 8080** desta máquina estão ocupadas por **Docker/WSL** (app G0DM0D3, Next.js).
  **Não são o painel meu-webhook.**
- **Porta 8000**: `python -m uvicorn workspace.demo_lab.transfer_service` (laboratório de pentest, não é o painel).
- **Nenhum painel meu-webhook rodando localmente** no momento do handoff.
- A sessão do motor SpyHub usa perfil em `%TEMP%\qgc-painel-spyhub` (fora do git). Ele persiste cookies
  entre execuções; se o Chrome for fechado, a próxima execução reabre e tenta login com as credenciais do `.env`.

---

## 5. Diagnóstico do problema "não aparece no painel"

### 5.1. Evidência de que a produção está correta

```bash
curl -s https://webhook-wati.onrender.com/index.html | grep -n "spyhub"
# 41:  <button type="button" data-view="spyhub" onclick="irPara('spyhub')">
# 42:      Verificação SpyHub <small>CPF x final do telefone</small>
# 665: <section class="view oculto" id="view-spyhub">
# 668:     <h1>Verificação SpyHub</h1>
```

```bash
curl -s https://webhook-wati.onrender.com/index.html | grep -c spyhub     # 15
curl -s https://webhook-wati.onrender.com/app.js    | grep -c spyhub     # 57
curl -s https://webhook-wati.onrender.com/style.css | grep -c spyhub     # 13
```

Observação: `/index.html` é servido publicamente pela whitelist de estáticos do `index.js`; por isso a
verificação acima funciona **sem login**. A rota autenticada do painel é `/admin`.

### 5.2. Matriz de hipóteses (por que o operador não vê)

| # | Hipótese | Como confirmar | Ação |
| - | -------- | -------------- | ---- |
| 1 | Aba aberta antes do deploy (DOM antigo em memória) | No console do painel: `document.querySelector('[data-view="spyhub"]')` → `null` | Ctrl+F5 na aba do painel; ou abrir em anônima |
| 2 | Cache do navegador/WebView | DevTools → Network → recarregar → `index.html` antigo (sem "spyhub" no response) | Hard reload, anônima, `?v=spyhub1` na URL |
| 3 | Não abriu o dropdown **Contatos** | O console retorna um `<button>`; o submenu está `display:none` até clicar | Clicar em **Contatos ▾** |
| 4 | Login de **colaborador** (não admin) | `location.pathname` é `/colaborador`; o painel é `colaborador.html` | Entrar com conta **admin** (`role=admin`) |
| 5 | Outro domínio/host (domínio próprio, IP, outro serviço) | `location.href` diferente de `webhook-wati.onrender.com` | Rodar o mesmo `curl .../index.html | grep -c spyhub` no domínio usado; se 0, o host não é esse deploy |
| 6 | Cloudflare cacheando HTML no domínio próprio | Header `cf-cache-status: HIT` no domínio usado | Purge no Cloudflare ou usar a URL do Render |
| 7 | Erro de JS quebrando o menu | Console com erro; `app.js` 404/antigo | Hard reload; conferir `app.js` de produção |
| 8 | Deploy ainda em andamento no momento da checagem | `last-modified` antigo no `/index.html` | Já está live desde 06:43 (26/11); conferir de novo |

### 5.3. Comandos de diagnóstico no navegador (Console/F12)

```js
location.href
// deve ser https://webhook-wati.onrender.com/... (ou o domínio que aponta para ele)

document.querySelector('[data-view="spyhub"]')
// <button ...>  → existe; o item está no dropdown Contatos
// null          → página carregada é antiga/cache OU é outro host

document.getElementById('view-spyhub')
// <section id="view-spyhub">  → tela existe no HTML carregado

// grupo Contatos e submenu:
document.querySelector('.nav-grupo[data-grupo="contatos"] .nav-grupo-btn').click()
document.querySelector('[data-view="spyhub"]').click()
// a tela deve perder a classe "oculto" e mostrar "Verificação SpyHub"
```

Se `location.href` não for o Render, **peça a URL exata** e rode:

```bash
curl -sI https://<dominio-usado>/index.html | grep -iE "HTTP/|cache-control|cf-cache|last-modified"
curl -s  https://<dominio-usado>/index.html | grep -c spyhub
```

### 5.4. O que já foi descartado

- Deploy não é o problema: produção tem o markup e o bundle novo (seção 5.1).
- Não há service worker.
- O HTML não está sendo cacheado pela Cloudflare na URL do Render (`cf-cache-status: DYNAMIC`).
- O item não é uma aba no topo — é submenu de **Contatos ▾**.

### 5.5. O que **não** foi verificado (limite desta sessão)

- O DOM **autenticado** de produção (`/admin`) não foi inspecionado: não temos a senha do admin de produção.
  O Cline, que já tem acesso ao painel, deve fazer essa checagem (é o passo 3 do TL;DR).
- Não sabemos se o operador usa um domínio próprio na frente do Render.
- Não sabemos com qual conta (admin ou colaborador) ele está logado.

---

## 6. Contas, credenciais e segredos

- **Produção**: a conta do operador. **Não** colocar senha em arquivo/documento; o Cline já tem acesso.
- **Demo local** (modo demo, banco em memória): `admin@qgcteam.com` / `123456`
  (também `colaborador@qgcteam.com` e `vendedor@qgcteam.com`, mesma senha).
  Essas contas de emergência estão documentadas em `SEGURANCA.md`; em produção a senha pode ter sido trocada.
- **SpyHub**: `SPYHUB_USUARIO` / `SPYHUB_SENHA`.
  - Local: no `.env` (gitignored).
  - Render: cadastrar em **Environment** do serviço (ainda **não confirmado**; sem isso o botão
    "Executar Verificação" fica desabilitado com o aviso "Configure SPYHUB_USUARIO e SPYHUB_SENHA").
- Regras: nunca commitar `.env`, `listas/`, `downloads/`, `diagnostico/`, `aprovados-spyhub.csv`,
  `reprovados-spyhub.txt`. Dados pessoais ficam fora do git.

---

## 7. Contrato da API (painel)

| Rota | Método | Corpo/Retorno |
| ---- | ------ | ------------- |
| `/api/spyhub/verificar` | POST | `{ texto }` → `202 { jobId, total, formato, ignoradosTotal }`; 400 vazio/inválido; 413 > 2 MB; 409 job em andamento |
| `/api/spyhub/jobs/:id` | GET | `{ status, log[], total, feitos, aprovados[], reprovados[], erro }` |
| `/api/spyhub/jobs/:id/aprovados.csv` | GET | CSV `;` com BOM UTF-8 |
| `/api/spyhub/jobs/:id/reprovados.txt` | GET | TXT com ficha original + retorno do site |
| `/api/spyhub/status` | GET | `{ navegador, credenciais, ocupado, headless, porta, urlBusca }` |
| `/api/spyhub/fechar` | POST | fecha o Chrome dedicado |

- `status`: `aguardando | rodando | concluido | erro`.
- Todas as rotas passam por `exigirAdmin`.
- Aprovado: `{ cpf, cpfFormatado, finais, telefoneEncontrado, telefoneDesmascarado, ... }`.
- Reprovado: `{ cpf, cpfFormatado, finais, motivo, retorno, ficha }`.

---

## 8. Variáveis de ambiente (nomes; valores fora do git)

```ini
SPYHUB_USUARIO=...             # obrigatório para o motor
SPYHUB_SENHA=...               # obrigatório para o motor
CDP_PORT_SPYHUB=9226           # porta do Chrome dedicado (opcional)
SPYHUB_TENTATIVAS=3            # tentativas por registro (opcional)
SPYHUB_INTERVALO_MS=1200       # pausa entre consultas (opcional)
SPYHUB_ESPERA_RESULTADO=25000  # espera máxima pelo resultado (opcional)
SPYHUB_MAX_REGISTROS=500       # teto por job (opcional)
EXTRATOR_HEADLESS=1            # no Render/Docker o Chrome é headless
SPYHUB_URL / SPYHUB_LOGIN_URL / SPYHUB_BUSCA_URL   # overrides opcionais
```

No Render, o `Dockerfile` já define `CHROME_PATH=/usr/bin/chromium`, `EXTRATOR_HEADLESS=1`, `PORT=10000`.
Falta confirmar/cadastrar `SPYHUB_USUARIO` e `SPYHUB_SENHA` no painel do Render.

---

## 9. Como testar (bateria completa)

Na raiz do projeto:

```powershell
node --check index.js
node --check app.js
node --check spyhub.js
node --check spyhub-parser.js
node --check 'routes\contatos-spyhub.js'
node --check test-spyhub-parser.js
node --check estado-spyhub.js
node --check e2e-spyhub-rota.js
node --check e2e-painel-visual.js

npm test          # suíte completa (12 scripts)
node estado-spyhub.js
```

Estado em 26/11: **`npm test` EXIT=0**, 56 checks `OK`; suítes Lista Suja, extrator, SpyHub e navegação verdes.

### 9.1. E2E ao vivo da rota (consome 1 consulta no SpyHub)

```powershell
node e2e-spyhub-rota.js
```

Sobe um Express mínimo com a **rota real** e o **motor real**, sem banco/worker/Wati.
Valida 202 → polling → CSV (BOM byte a byte) → TXT. Último resultado: `EXIT=0`, ~11 s, 1 aprovado/0 reprovados.

### 9.2. E2E visual pela tela (modo demo, consome 1 consulta)

Terminal 1:

```powershell
$env:MODO_DEMO='1'; $env:WATI_TOKEN=''; $env:WATI_NUMERO=''
$env:PORT='3100'; $env:JWT_SECRET='e2e-local-demo-2026'; node index.js
```

Terminal 2:

```powershell
node e2e-painel-visual.js
```

Faz login admin → Contatos → Verificação SpyHub → cola CSV → executa → confere log/tabela/toasts/
exportações. Screenshots em `diagnostico/painel-spyhub-log.png` e `painel-spyhub-tabela.png`.
Último resultado: `EXIT=0`, 19 s, `1/1 (100%) — concluído`, `csvBom=true`, `txtStatus=200`.

**Cuidado:** `node index.js` sem `MODO_DEMO=1` usa o `DATABASE_URL` real e **inicia o worker de
campanhas da Wati**. Não suba o painel "real" localmente sem autorização do operador.

### 9.3. CLI do motor

```powershell
node spyhub.js analisar listas\spyhub-aprovado.csv   # só parser (sem rede)
node spyhub.js testar   listas\spyhub-aprovado.csv   # consulta real (consome 1 consulta)
node spyhub.js status                                # Chrome/sessão/credenciais
node spyhub.js fechar                                # fecha o Chrome dedicado
```

O `testar` agora **encerra o processo ao terminar** (correção `encerrarCli()` no `finally`).

---

## 10. Mapa dos arquivos

| Arquivo | Papel |
| ------- | ----- |
| `spyhub.js` | Motor CDP (Chrome 9226) + CLI; extração de telefones; `encerrarCli()` |
| `spyhub-parser.js` | Parser puro (CPF/DV, dump, CSV, dedupe, importações de exportação) |
| `routes/contatos-spyhub.js` | Rotas Express `/api/spyhub/*` (admin-only) |
| `app.js` / `index.html` / `style.css` | Tela "Verificação SpyHub" na aba Contatos |
| `index.js` | Bootstrap Express; monta as rotas; worker de campanhas |
| `test-spyhub-parser.js` | Testes do SpyHub (parser, motor, rotas, tela) — sem rede |
| `estado-spyhub.js` | Script de estado/diagnóstico (`--diag`, `--ir`, `--json`) |
| `e2e-spyhub-rota.js` | E2E ao vivo da rota (consome consulta) |
| `e2e-painel-visual.js` | E2E visual pela tela em modo demo (consome consulta) |
| `CONTINUAR.md` | Estado + próximos passos do projeto |
| `SPYHUB.md` | Documentação funcional (formatos, env, erros, troubleshooting) |
| `HANDOFF-CLINE.md` | **Este documento** |

Evidências locais (gitignored): `diagnostico/spyhub-aprovado-0310.csv`, `diagnostico/painel-spyhub-log.png`,
`diagnostico/painel-spyhub-tabela.png`, `aprovados-spyhub.csv`, `reprovados-spyhub.txt`.

---

## 11. Comportamentos conhecidos / pegadinhas

1. **Menu é dropdown**: o item fica em **Contatos ▾**. Sem clicar no grupo, não aparece.
2. **Admin-only**: colaborador entra em `/colaborador` e não tem esse menu.
3. **Cache**: `app.js`/`index.html` antigos no navegador mascaram o deploy; Ctrl+F5 ou anônima.
4. **Domínio próprio**: se houver um domínio na frente, confirme que aponta para o mesmo serviço Render e
   que a Cloudflare não está servindo HTML antigo.
5. **Render headless**: o perfil do Chrome não persiste entre deploys; o login do SpyHub pode pedir
   captcha no container. Se o job parar com `captcha` ou `login`, o caminho validado é o motor **local**.
6. **Primeira tentativa do motor pode falhar** com `Campo de busca de CPF não encontrado (... Campos
   visíveis: nenhum)` por hidratação lenta da SPA; o retry (3x) repete a busca e aprova.
7. **Job em memória**: se o servidor reiniciar no meio, o painel perde o job e pede para rodar de novo.
8. **Um job por vez**: 409 se já existir verificação rodando.
9. **Custo**: cada `testar`/job consome consulta no SpyHub. Não rodar lotes de teste sem necessidade.
10. **Chrome do motor**: fechar o Chrome pai de um processo node antigo pode derrubar a janela; o perfil
    persiste em `%TEMP%\qgc-painel-spyhub` e a próxima execução reloga.

---

## 12. O que o Cline deve fazer (runbook)

### Passo A — identificar a tela que o operador vê

1. Pedir/verificar a URL na barra de endereços.
2. Se for `webhook-wati.onrender.com`: seguir para B.
3. Se for outro domínio: rodar `curl -s https://<dominio>/index.html | grep -c spyhub`; se 0, o domínio
   não está no deploy novo (DNS/cache/serviço diferente) — corrigir o apontamento ou usar a URL do Render.

### Passo B — confirmar sessão admin

1. Login no painel com conta **admin**.
2. `location.pathname` deve ser `/admin` (não `/colaborador`).
3. Se estiver em `/colaborador`, a tela não existe ali; entrar como admin.

### Passo C — confirmar o DOM carregado

No console:

```js
document.querySelector('[data-view="spyhub"]')
```

- `<button>` → item existe; abrir **Contatos ▾** e clicar em **Verificação SpyHub**.
- `null` → página antiga/cache: Ctrl+F5, anônima, `?v=spyhub1`. Se continuar `null`, conferir Network
  (`index.html` de produção tem "spyhub"?) e host.

### Passo D — após a tela abrir

1. Conferir o aviso de status no topo da tela:
   - "✅ Chrome disponível (janela visível/headless)." → ok.
   - "⚠ Configure SPYHUB_USUARIO e SPYHUB_SENHA" → cadastrar no Render e salvar (restart).
   - "⚠ Este servidor não tem Chrome" → motor não roda nesse host.
2. Rodar **uma** verificação com um registro real (consome 1 consulta) e conferir:
   log ao vivo, cards, tabela de aprovados, reprovados, CSV (BOM) e TXT.
3. Se falhar por captcha/login no Render: usar o motor local (seção 9.2/9.3) e explicar ao operador.

### Passo E — reportar

Entregar ao operador: URL conferida, resultado do `document.querySelector`, print da tela com o menu
aberto, status do `/api/spyhub/status`, e (se rodou) o resultado da verificação.

---

## 13. O que NÃO fazer

- Não reimplementar o motor/rotas/tela: já estão prontos e testados.
- Não commitar `.env`, `listas/`, `diagnostico/`, artefatos CSV/TXT com CPF/telefone.
- Não subir o painel com o `.env` real sem ciência do **worker de campanhas** (pode disparar Wati).
- Não rodar consultas em lote no SpyHub só para testar (cada uma consome saldo).
- Não matar processos do Chrome/navegador do operador sem confirmar o que são.
- Não colar credenciais em documentos, chats ou commits.

---

## 14. Referências internas

- `CONTINUAR.md` — estado detalhado e próximos passos do projeto.
- `SPYHUB.md` — documentação funcional (formatos de dump/CSV, env, erros, troubleshooting).
- `SEGURANCA.md` — variáveis, contas de emergência do modo demo, arquivos públicos.
- `EXTRATOR-CHROME.md` — deploy do Chromium no Render (contexto do Dockerfile).
- `ferramentas.md` (fora do projeto, no pentest-lab) — APIs Kaido/OSINT, quando aplicável.

---

## 15. Resumo final para colar no Cline

> O SpyHub está implementado e no ar: commits `7fb7271` e `f64f0f0` enviados ao GitHub, Render
> servindo `app.js` com 57 referências e `index.html` com o item de menu. O operador não vê o item
> porque ele fica no dropdown **Contatos ▾** e/ou a aba dele está com HTML antigo em cache. Confirme:
> URL, sessão admin, `document.querySelector('[data-view="spyhub"]')`, e hard reload. Se o DOM estiver
> correto e ainda assim a verificação falhar, o problema é ambiente (SPYHUB_* no Render ou captcha no
> headless) — o motor local é o caminho validado. Não é preciso refazer nada do zero.

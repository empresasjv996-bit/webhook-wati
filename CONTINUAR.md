# CONTINUAR — Motor de Verificação SpyHub

> Documento de retomada. Quem abrir o projeto (ou outra sessão de IA) começa por aqui.
> **Handoff completo para o Cline/outra IA: `HANDOFF-CLINE.md`** (deploy, diagnóstico do
> "não aparece no painel", runbook e limites).
> Rode `node estado-spyhub.js` para ver o estado atual e os próximos passos sem abrir o código.

## Decisão de operação (26/11): CMD — painel arquivado

O operador optou por rodar a verificação **via CMD**, sem depender do painel/Render:

```cmd
spyhub-cmd.bat listas\minha-lista.csv
```

O `.bat` fixa o diretório do projeto (o motor lê o `.env` do cwd), aceita arrastar-e-soltar e
deixa o Chrome do SpyHub aberto (a próxima execução é mais rápida). O painel foi deployado e está
no ar, mas **não é mais o caminho de operação**; o diagnóstico de exibição no painel fica
arquivado em `HANDOFF-CLINE.md` (seções 5 e 12).

## 0. Como retomar (checklist rápido)

```powershell
node estado-spyhub.js          # docs, arquivos, sintaxe, .env, git, exports e próximos passos
npm run estado                 # atalho para o comando acima
node estado-spyhub.js --diag   # idem + sonda ao vivo no Chrome do SpyHub (CDP 9226)
node estado-spyhub.js --ir     # navega o Chrome para o 1º módulo (/search/avancada) e sonda
node estado-spyhub.js --json   # tudo em JSON (bom para colar em outra sessão)
```

1. Ler este arquivo (seções 2 e 3) e, para detalhes funcionais, `SPYHUB.md`.
2. Rodar `node estado-spyhub.js` e conferir se algo está `[--]` (arquivo/credencial faltando).
3. Se o Chrome estiver fechado, abra rodando uma verificação (`node spyhub.js testar <arquivo>`)
   e depois use `--diag` / `--ir`.
4. Seguir os próximos passos da seção 3, de cima para baixo.

## 1. Objetivo

Na aba **Contatos** do painel administrativo, importar um dump/CSV, extrair **CPF + 4 últimos dígitos do telefone**,
consultar cada CPF nos módulos do SpyHub (`/search/avancada`, `/search/tracker`, `/search/cpf-top` —
100 consultas em cada, trocando sozinho quando um estoura) e entregar:

- **aprovados**: CPF cujo resultado do site contém um telefone terminando nos 4 dígitos pedidos;
- **reprovados**: sem correspondência ou com erro, preservando a ficha original + um trecho do retorno do site;
- exportação **CSV** (aprovados) e **TXT** (reprovados).

## 2. Estado atual (26/11/2026)

### Pronto e testado (estático + rotas)

| Item | Onde |
| --- | --- |
| Parser de dump/CSV, CPF (DV), dedupe, exportações | `spyhub-parser.js` |
| Motor CDP: Chrome dedicado, login, busca, leitura de telefones | `spyhub.js` |
| Rotas `POST /api/spyhub/verificar`, `GET /api/spyhub/jobs/:id`, `GET /api/spyhub/status` | `routes/contatos-spyhub.js` |
| Tela na aba Contatos (colar dump/CSV, progresso, tabela, reprovados, exports) | `index.html`, `app.js`, `style.css` |
| Testes do SpyHub (parser, telefones, rotas, integração estática) | `test-spyhub-parser.js` |
| Documentação funcional | `SPYHUB.md` |
| Variáveis de ambiente documentadas | `.env.exemplo` (credenciais reais só no `.env`, fora do git) |

`npm test` inclui `test-spyhub-parser.js` e todos os testes do SpyHub passam (`OK - ...` até
"Todos os testes do SpyHub passaram.").

### Resolvido nesta sessão (bloqueio do campo de busca)

Corrida do primeiro teste (26/11 05:41): `Campo de busca de CPF não encontrado`, porque
`garantirSessaoBusca()` aceitava qualquer `input` existente (inclusive oculto) e seguia com a SPA
ainda montando.

Correção aplicada em `spyhub.js`:

- `EXPRESSAO_FORMULARIO_BUSCA`: só considera a tela pronta com `#li_module_cpf a` **ou**
  `#tab_cpf input[name="cpf"]` **ou** algum input/textarea **visível** (`rect > 0`);
- `prepararBusca()` tenta 3× (700 ms entre tentativas): `abrirAbaCpf()` → `marcarPrimeiro()`;
- quando falha, o erro passou a listar os campos visíveis (`descreverCampos`).

Prova real (05:56):

```
[05:56:20] Consultando 529.982.247-25 (final 0906)...
[05:56:29] REPROVADO 529.982.247-25 (final 0906) - SpyHub não retornou resultado para este CPF
retorno: "Documento não encontrado ou sem informações mínimas suficientes para validação cadastral."
```

### Validado nesta sessão (26/11, manhã) — APROVADO real + caminho do painel

Caso **aprovado** provado com CPF real de lote já validado pelo extrator (final esperado 7672;
dados completos só no artefato local `diagnostico/spyhub-aprovado-0310.csv`, **fora do git**):

```
[06:10:16] Consultando <CPF real> (final 7672)...
[06:10:25] APROVADO <CPF real> (final 7672) - telefone retornado termina em 7672
[06:10:27] Fim: 1 aprovado(s), 0 reprovado(s).
EXIT=0
```

Uma execução intermediária (06:16) teve a tentativa 1/3 falhar com
`Campo de busca de CPF não encontrado (... Campos visíveis: nenhum)` e o retry aprovou em 10 s —
o retry já cobre a hidratação lenta da SPA.

E2E do caminho do painel em harness isolado (`node e2e-spyhub-rota.js`, usa a **rota real** e o
**motor real**, sem banco, sem worker de campanhas e sem Wati):

```
GET /api/spyhub/status -> navegador=true credenciais=true
POST /api/spyhub/verificar -> HTTP 202
job concluido: 1 aprovado(s), 0 reprovado(s)
GET aprovados.csv -> HTTP 200 | GET reprovados.txt -> HTTP 200
E2E OK | EXIT=0 | ~11 s
```

- BOM do CSV: `response.text()` do fetch remove o BOM na leitura, então o harness passou a conferir
  **byte a byte** (`EF BB BF`). A presença dos bytes é garantida por `res.send('﻿' + csv)`.
- **CLI não fica mais pendurado**: `encerrarCli()` no `finally` de `principal()` fecha o socket CDP
  e solta o processo do Chrome **sem matar a janela**. Antes, `testar` imprimia tudo e continuava
  vivo (sobraram 3 node antigos — PIDs 1276, 27472 e 14760 — ainda conectados ao CDP; dá para
  encerrar com `taskkill /PID <pid> /F`).
- A porta 3000 está ocupada por outro app (G0DM0D3, Next.js) e o painel não estava rodando; por
  isso a conferência visual foi feita em modo demo na porta 3100 (seção abaixo). O painel real/de
  produção continua sendo decisão do operador — o `index.js` inicia o worker de campanhas.

### E2E visual do painel (modo demo, porta 3100) — CONCLUÍDO em 26/11

Painel subiu em **modo demo** (banco em memória, Wati sem token) na porta 3100 e o harness
`node e2e-painel-visual.js` fez o caminho completo pela tela:

```
Login OK: /admin
Status na tela: ✅ Chrome disponível (janela visível).
[06:27:41] Consultando <CPF> (final 7672)...
[06:27:51] APROVADO <CPF> (final 7672) - telefone retornado
1/1 (100%) — concluído
Exportações: {"csvStatus":200,"csvBom":true,"csvLinhas":2,"csvTemCpf":true,"txtStatus":200,"txtBytes":0}
Toasts: "Exportação gerada.\nExportação gerada."
E2E VISUAL OK | EXIT=0 | 22 s
```

- Screenshots (fora do git): `diagnostico/painel-spyhub-log.png` e
  `diagnostico/painel-spyhub-tabela.png`.
- Comando do painel demo (PowerShell):
  `$env:MODO_DEMO='1'; $env:WATI_TOKEN=''; $env:WATI_NUMERO=''; $env:PORT='3100'; $env:JWT_SECRET='e2e-local-demo-2026'; node index.js`
- O harness consome 1 consulta real no SpyHub e exige `listas/spyhub-aprovado.csv` (fora do git).
- A validação **no painel real/de produção** continua sendo decisão do operador (o `index.js`
  inicia o worker de campanhas); em modo demo não houve envio nem escrita no Postgres.



```
#li_module_cpf a                     -> aba "CPF" (clique troca a aba; vira .nav-tab.active)
#tab_cpf                             -> painel da aba CPF (existe; 2 inputs dentro)
#tab_cpf input[name="cpf"]           -> campo do CPF (placeholder "Campo obrigatório"; visível só na aba)
#tab_cpf ... .btn.btn-success.btn-block.text-bold.btn-search  -> botão "CONSULTAR" do painel
.nav-tab                             -> NOME | NOME IDENTICO | CPF | TITULO | CNPJ
```

Retorno do site quando não acha o CPF (usado em `semResultado`):
`"Documento não encontrado ou sem informações mínimas suficientes para validação cadastral."`

Ferramentas: `node estado-spyhub.js --diag` (sonda ao vivo) e `%TEMP%\spyhub-inspect3.js`
(script temporário, fora do repo).

## 3. Próximos passos (na ordem)

### Passo 1 — Validar um caso APROVADO (prioridade) — CONCLUÍDO em 26/11

Evidência na seção 2 ("Validado nesta sessão"): CLI APROVADO (exit 0) e E2E da rota com 1/0.
Os passos abaixo ficam como referência para repetir a validação em outro lote:

1. Escolher 1–2 registros reais (CPF que exista no SpyHub e cujo telefone termine nos 4 dígitos).
2. `node spyhub.js testar <arquivo>` e conferir a linha `APROVADO ... telefone ...`.
3. Se reprovar mesmo tendo o telefone na tela, rodar `node estado-spyhub.js --diag` durante a
   consulta e olhar como o número aparece (máscara `(19) *****-0906`, número quebrado em spans etc.).
4. Cobrir o formato novo em `extrairTelefones()` + teste em `test-spyhub-parser.js`.

### Passo 1b — Registro do que já foi feito (para não repetir)

- [x] Confirmar DOM real da aba CPF e do botão CONSULTAR.
- [x] `abrirAbaCpf()` / `clicarConsultarCpf()` no fluxo de `prepararBusca()`.
- [x] `textoNovoDepois()` para não reprovar por texto fixo da tela.
- [x] Espera por campo visível + 3 tentativas + erro com campos visíveis.
- [x] Reprovação real com retorno do site gravado no job.
- [x] Aprovação real (CLI + rota) com CPF existente e final confirmado.
- [x] CLI solta o socket CDP ao terminar (`encerrarCli()` no `finally`).

### Passo 2 — Validar o painel ponta a ponta — ARQUIVADO (operação via CMD)

**Decisão de 26/11:** o dia a dia é via CMD (`spyhub-cmd.bat`, ver Passo 4). O caminho servidor e o
visual foram validados em modo demo, mas o painel não é mais o caminho de operação. O roteiro abaixo
só é relevante se o operador decidir voltar ao painel (atenção ao worker de campanhas):

1. `npm start` (ou `npm run dev`) e entrar como admin — atenção: o `index.js` inicia o worker de
   campanhas; a porta 3000 está ocupada pelo G0DM0D3 nesta máquina (use `PORT=3100` se preciso).
2. Aba **Contatos** → área SpyHub → colar um dump pequeno (2 registros) e um CSV.
3. Iniciar a verificação e conferir:
   - log de progresso em tempo real (`spyhub-log`);
   - tabela de aprovados (`cnpjFormatado`, `telefoneEncontrado`);
   - reprovados em `<details>` com "Retorno do site" (`spyhub-retorno`);
   - download do CSV (com BOM, abre no Excel) e do TXT.

### Passo 3 — Fechamento

Checklist já executado nesta sessão (26/11): `node --check` em todos os arquivos do motor,
`npm test` verde (inclui os testes novos do SpyHub) e `node estado-spyhub.js` OK.
Antes do commit foi feita a limpeza de dados/segredos nos arquivos versionáveis:

- [x] Remover o CPF real usado como exemplo em `index.html`/`index.js` (troca pelo CPF público de
      teste `529.982.247-25`).
- [x] O teste `spyhub.js` compara com as credenciais **lidas do `.env`** em vez de embutir a senha
      no código de teste.
- [x] `.gitignore` segue cobrindo `listas/`, `diagnostico/`, `aprovados-spyhub.csv` e
      `reprovados-spyhub.txt` (evidências com dados pessoais ficam fora do git).
- [x] Commit: `feat: motor de verificacao SpyHub na aba Contatos`.

Para repetir a bateria:

```powershell
node --check index.js; node --check app.js; node --check spyhub.js; node --check spyhub-parser.js
node --check 'routes\contatos-spyhub.js'; node --check test-spyhub-parser.js; node --check estado-spyhub.js
node --check e2e-spyhub-rota.js
npm test
node estado-spyhub.js
git status --short
```

### Passo 4 — Operação diária via CMD (escolhida em 26/11)

1. `spyhub-cmd.bat listas\minha-lista.csv` — ou arraste o `.txt`/`.csv` para cima do `.bat`.
2. Deixe o Chrome do SpyHub aberto entre execuções: a próxima é mais rápida. A primeira, com o
   Chrome fechado, paga o cold start e o login.
3. Saídas na raiz: `aprovados-spyhub.csv` e `reprovados-spyhub.txt` (gitignored).
4. Diagnóstico: `node spyhub.js status` / `node estado-spyhub.js --diag`.
5. Opcional para lote: `SPYHUB_INTERVALO_MS=600` com moderação (padrão 1200). Não reduza
   `SPYHUB_ESPERA_RESULTADO` sem necessidade — é a paciência para a SPA carregar.

## 4. Mapa dos arquivos

| Arquivo | Papel | Observações |
| --- | --- | --- |
| `spyhub.js` | Motor CDP (Chrome próprio na porta 9226) + CLI | `testar`, `analisar`, `status`, `fechar` |
| `spyhub-parser.js` | Parser puro (sem rede) | CPF/DV, separadores, dedupe, `txtDeReprovados`, `csvDeAprovados` |
| `routes/contatos-spyhub.js` | Router Express do SpyHub | um job por vez, estado em memória |
| `app.js` | UI da aba Contatos | cola texto, polling 1,5 s, tabela, reprovados, downloads |
| `index.html` | Markup da área SpyHub | ids `spyhub-*` |
| `style.css` | Classes `.spyhub-*` | log, ficha, reprovados, retorno |
| `index.js` | Bootstrap | `express.json({ limit: '3mb' })` |
| `test-spyhub-parser.js` | Testes do SpyHub | inclui rotas com `router.handle()` (sem porta) |
| `test-navegacao.js` | Teste de navegação | contatos inclui `spyhub`; regex de `irPara` com janela 2000 |
| `SPYHUB.md` | Documentação funcional | formatos, env, erros, troubleshooting |
| `CONTINUAR.md` | Este documento | estado + próximos passos |
| `estado-spyhub.js` | Script de estado/diagnóstico | lê os docs, checa arquivos, roda `--check` e sonda o Chrome |
| `e2e-spyhub-rota.js` | E2E ao vivo do caminho do painel | Express mínimo + rota real + motor real; sem banco/worker/Wati; consome consulta no SpyHub |
| `e2e-painel-visual.js` | E2E visual pela tela (modo demo) | Chrome próprio (CDP 9230) + login admin + Contatos → SpyHub → job → tabela → exportações; screenshots em `diagnostico/` |

## 5. Contrato da API (painel)

| Rota | Método | Corpo/Retorno |
| --- | --- | --- |
| `/api/spyhub/verificar` | POST | `{ texto }` → `{ id, total, ignorados }`; 400 texto vazio/inválido; 413 > 3 MB; 409 job em andamento |
| `/api/spyhub/jobs/:id` | GET | `{ status, log[], total, feitos, aprovados[], reprovados[], erro }` |
| `/api/spyhub/status` | GET | `{ chrome, sessao, credenciais, job }` |

- `status`: `aguardando | rodando | concluido | erro`.
- Aprovado: `{ cpf, cpfFormatado, finais, telefoneEncontrado, nome, cnpjFormatado, ficha }`.
- Reprovado: `{ cpf, cpfFormatado, finais, motivo, retorno, ficha }`.
- Erro fatal (Chrome/captcha/limite/sessão) encerra o job com `status: 'erro'` e `erro` preenchido.

## 6. Formatos de entrada

- **Dump**: blocos separados por linha em branco; cada bloco vira uma ficha (`campos` + `linhas`).
  O CPF pode estar em qualquer linha; os 4 finais vêm de telefones mascarados (`(19) *****-0906`).
- **CSV**: detecta `,` ou `;` ou tab, respeita aspas; colunas reconhecidas por nome
  (`cpf`, `telefone`, `nome`, `cnpj`, `empresa`, `nome_fantasia`, ...).
- Um registro pode ter vários finais (`finais: ["0906", "1234"]`): aprova no primeiro que casar.
- Duplicados (mesmo CPF + mesmos finais) são descartados; linhas sem CPF válido vão para `ignorados`.

## 7. Variáveis de ambiente

```ini
SPYHUB_USUARIO=...            # obrigatório
SPYHUB_SENHA=...              # obrigatório
CDP_PORT_SPYHUB=9226          # porta do Chrome dedicado
SPYHUB_TENTATIVAS=3           # tentativas por registro
SPYHUB_INTERVALO_MS=1200      # pausa entre registros
SPYHUB_ESPERA_RESULTADO=25000 # espera máxima pelo resultado (ms)
SPYHUB_MAX_REGISTROS=500      # limite por job
EXTRATOR_HEADLESS=false       # precisa ser false (login manual se pedir captcha)
SPYHUB_URL / SPYHUB_LOGIN_URL / SPYHUB_BUSCA_URL   # overrides opcionais
```

## 8. Decisões e limitações conhecidas

- **Um job por vez**; estado em memória → se o servidor reiniciar, o painel pede para rodar de novo.
- Parsing é **server-side**; o front só envia texto e faz polling.
- Exportações são geradas no servidor, sem BOM no TXT e **com** BOM no CSV (Excel).
- Reprovados guardam a ficha original + `retorno` (400 primeiros caracteres limpos do site).
- `acharTelefoneComFinal()` ignora o próprio CPF (11 dígitos) e aceita máscara `(19) *****-0906`.
- Testes de rota usam `router.handle()` com `req`/`res` falsos (loopback HTTP é instável nesta máquina Windows).

## 9. Histórico desta sessão (resumo)

1. CSS da área SpyHub, `.env.exemplo`, credenciais no `.env`.
2. `spyhub-parser.js` + testes (CPF, CSV, dedupe, exports, telefones).
3. `spyhub.js` (Chrome/CDP, login, busca, retorno do site nos reprovados) + CLI com CSV/TXT.
4. Rotas + UI + polling + reprovados com "Retorno do site".
5. Diagnóstico ao vivo do DOM: aba CPF e botão CONSULTAR confirmados.
6. `abrirAbaCpf()` / `clicarConsultarCpf()` implementados; `textoNovoDepois()` para não confundir
   instruções da tela com "não encontrado".
7. Espera por formulário **visível** + 3 tentativas em `prepararBusca()` → **reprovação real validada**
   com o retorno do site (`Documento não encontrado ...`).
8. `estado-spyhub.js` (este estado + sonda `--diag`) e `CONTINUAR.md` para retomar o trabalho.
9. **Caso APROVADO** provado ao vivo (CLI e rota): CPF real do lote do extrator, final 7672,
   `APROVADO` em 9 s; evidências em `diagnostico/` (fora do git).
10. **CLI sem travar**: `encerrarCli()` no `finally` de `principal()` — fecha o socket CDP e solta
    o Chrome sem matar a janela; teste novo em `test-spyhub-parser.js`.
11. **E2E do caminho do painel** em harness isolado (`e2e-spyhub-rota.js`): 202 → concluído →
    CSV/TXT 200 (BOM conferido byte a byte no harness novo).
12. **Limpeza pré-commit**: exemplos com CPF real trocados pelo CPF público de teste; o teste de
    credenciais passou a ler o `.env` em vez de embutir usuário/senha.
13. **Commit** `7fb7271` (16 arquivos) e memória do painel atualizada.
14. **E2E visual** em modo demo (porta 3100): login admin → Contatos → SpyHub → job pela tela →
    tabela/log → exportações (CSV com BOM, TXT), 22 s; screenshots em `diagnostico/`.
    Harness: `node e2e-painel-visual.js`.
15. **Deploy**: commits enviados ao GitHub (`decf583..f64f0f0`) e Render servindo a versão nova
    (`app.js` com 57 referências, `index.html` com o item de menu, `cf-cache-status: DYNAMIC`).
16. **Pendente**: operador confirmar a exibição no painel (o item é submenu de **Contatos ▾**; conferir
    cache/DOM e se a sessão é admin) e cadastrar `SPYHUB_USUARIO`/`SPYHUB_SENHA` no Render.
    Runbook e diagnóstico completos em `HANDOFF-CLINE.md`.


# Verificação SpyHub (aba Contatos)

Motor que confere, no [app.spyhub.io](https://app.spyhub.io), se o CPF de uma
persona possui telefone terminando nos 4 dígitos que vieram no dump. O painel
mostra **aprovados** (telefone confere) e **reprovados** (não confere / erro),
com exportação em CSV e TXT.

Substitui o trabalho manual de abrir o SpyHub, digitar o CPF e comparar número
por número. Tudo roda no servidor: o navegador do painel só envia o texto e
acompanha o progresso.

> Retomando o trabalho? Leia `CONTINUAR.md` (estado atual e próximos passos) e
> rode `node estado-spyhub.js` / `node estado-spyhub.js --diag`.

## Como funciona

```
cola a lista / envia o arquivo
        │  POST /api/spyhub/verificar   { texto }
        ▼
spyhub-parser.js  →  CPF válido + 4 finais + ficha original
        │  job em memória (1 por vez)
        ▼
spyhub.js  →  Chrome dedicado (CDP) → login → /search/pessoa-fisica → CPF
        │  varre o resultado procurando telefone com o final pedido
        ▼
GET /api/spyhub/jobs/:id   (polling de 1,5 s na tela)
        │
        ├─ aprovados  → GET /api/spyhub/jobs/:id/aprovados.csv
        └─ reprovados → GET /api/spyhub/jobs/:id/reprovados.txt
```

- Usa o mesmo esquema do `extrator.js`: Chrome via CDP, sem puppeteer.
- Chrome, porta e perfil são **próprios** (`CDP_PORT_SPYHUB`, perfil
  `qgc-painel-spyhub`), então pode rodar junto com o Consultar CPF.
- A tela abre na aba **NOME**; o motor clica em `#li_module_cpf` (aba **CPF**),
  espera `#tab_cpf input[name="cpf"]` ficar visível, digita e clica no
  **CONSULTAR** do painel.
- Só o que **aparece depois** do clique conta como resultado (`textoNovoDepois`):
  as instruções fixas da tela também falam em "não encontrado" e geravam
  reprovação falsa.
- Só um job por vez (`409` se já existir verificação em andamento).
- O job vive em memória: se o servidor reiniciar, a tela avisa e pede para
  rodar de novo.

## Formatos aceitos

**1. Dump colado (vários blocos).** Blocos separados por linhas de `=====`; se
o separador não vier, o parser quebra no próximo `CNPJ:` depois de um
`CPF Persona:`. Campos reconhecidos:

| Campo | Usado para |
| --- | --- |
| `CNPJ` | identificação do aprovado (formatado) |
| `CPF Persona` | CPF consultado (precisa passar no dígito verificador) |
| `Final visivel` | os 4 dígitos procurados |
| `Telefone cadastro` | alternativa para os 4 finais |
| `Telefone desmascarado` | telefone exibido no CSV |
| `Razao Social` / `Nome Fantasia` | identificação |
| `Logradouro`, `Bairro`, `Cidade`, `CEP` | endereço montado para o CSV |

Blocos sem CPF válido ou sem final são listados como **ignorados** (não
consomem consulta no SpyHub). Registros repetidos (mesmo CPF + mesmo final)
entram uma única vez.

**2. CSV.** A primeira linha precisa ter cabeçalho com `cpf` e (`final` ou
`telefone_cadastro` ou `telefone_desmascarado`). Separador `;`, tabulação ou
vírgula é detectado sozinho; aspas duplas são respeitadas. Colunas aceitas
(com ou sem acento): `cnpj`, `cpf`/`cpf_persona`, `razao_social`,
`nome_fantasia`, `telefone_desmascarado`, `endereco`, `final`,
`telefone_cadastro`, `ficha`.

## Configuração (.env)

```dotenv
SPYHUB_USUARIO=seu-usuario
SPYHUB_SENHA=sua-senha
```

Opcionais:

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `CDP_PORT_SPYHUB` | `9226` | porta do Chrome dedicado do SpyHub |
| `SPYHUB_TENTATIVAS` | `3` | tentativas por CPF antes de reprovar |
| `SPYHUB_INTERVALO_MS` | `1200` | pausa entre consultas (evita bloqueio) |
| `SPYHUB_ESPERA_RESULTADO` | `25000` | tempo máximo esperando o resultado de um CPF |
| `SPYHUB_ESPERA_LOGIN` | `40000` | tempo máximo esperando o login |
| `SPYHUB_MAX_REGISTROS` | `500` | teto de registros por job |
| `SPYHUB_URL` / `SPYHUB_LOGIN_URL` / `SPYHUB_BUSCA_URL` | app.spyhub.io | URLs alternativas |
| `EXTRATOR_HEADLESS` | automático | `1` roda sem janela (o login com captcha pede janela) |

As credenciais ficam **somente** no `.env` (que está no `.gitignore`); o código
não tem usuário/senha e a tela nunca recebe a senha.

## CLI (teste local, sem painel)

```bash
node spyhub.js analisar listas/spyhub.txt   # só o parser: mostra válidos/ignorados
node spyhub.js testar   listas/spyhub.txt   # abre o Chrome e consulta de verdade
node spyhub.js status                       # Chrome aberto? credenciais? job atual?
node spyhub.js fechar                       # fecha o Chrome do SpyHub
```

`testar` imprime aprovados/reprovados no console, salva `aprovados-spyhub.csv`
e `reprovados-spyhub.txt` no diretório atual e **encerra o processo ao terminar**
(fecha o socket CDP; a janela do Chrome continua aberta para a próxima consulta).

## E2E do caminho do painel (ao vivo)

`node e2e-spyhub-rota.js [arquivo.csv|txt]` sobe um Express mínimo com a **rota real**
(`routes/contatos-spyhub.js`) e o motor real — sem banco, sem worker de campanhas e sem
Wati — e valida `POST /verificar` (202), o polling do job, o CSV de aprovados (BOM
conferido byte a byte) e o TXT de reprovados. Cada execução consome consulta no SpyHub;
não faz parte do `npm test`. Sem argumento usa `listas/spyhub-aprovado.csv` (fora do git).

## E2E visual do painel (modo demo)

Valida o caminho completo **pela tela**: abre um Chrome próprio (CDP 9230), faz login
admin, entra em Contatos → Verificação SpyHub, cola o CSV, executa a verificação e
confere log, tabela, toasts e exportações (CSV com BOM e TXT). Salva screenshots em
`diagnostico/` (fora do git). Também consome 1 consulta no SpyHub.

```powershell
# terminal 1 — painel em modo demo (banco em memória, Wati sem token)
$env:MODO_DEMO='1'; $env:WATI_TOKEN=''; $env:WATI_NUMERO=''
$env:PORT='3100'; $env:JWT_SECRET='e2e-local-demo-2026'; node index.js

# terminal 2
node e2e-painel-visual.js
```

Resultado esperado (26/11): `1/1 (100%) — concluído`, `csvStatus=200`, `csvBom=true`,
`txtStatus=200` e dois toasts "Exportação gerada.". O painel real/de produção não é
tocado por esse harness; `index.js` fora do modo demo inicia o worker de campanhas.

## Erros que interrompem o job

`sem-chrome`, `sem-credenciais`, `login-recusado`, `captcha`, `limite`,
`login`, `campo-login` — a verificação para na hora e a tela mostra o motivo.
Falhas passageiras (timeout, resultado vazio) tentam de novo até
`SPYHUB_TENTATIVAS` e, se persistirem, o CPF vai para os reprovados com o
motivo.

## Exportações

- **Aprovados (CSV, `;`, com BOM UTF-8):** `cnpj;cpf_persona;razao_social;nome_fantasia;telefone_desmascarado;endereco`.
  Ponto e vírgula dentro do texto vira vírgula para não quebrar colunas.
- **Reprovados (TXT):** para cada registro, `### CPF - finais XXXX - motivo`,
  seguido da ficha original completa (pronta para conferir/reprocessar).

## Problemas comuns

| Sintoma | Causa / solução |
| --- | --- |
| "Chrome não encontrado" | instale o Chrome ou defina `CHROME_PATH` |
| "Informe SPYHUB_USUARIO e SPYHUB_SENHA no .env" | faltam as credenciais no `.env` |
| Login não passa | captcha/2FA: rode com janela visível e faça o login uma vez; o perfil é reaproveitado |
| "Campo de busca de CPF não encontrado (... Campos visíveis: ...)" | a SPA ainda estava montando ou a aba CPF não abriu; o erro lista os campos visíveis. Rode `node estado-spyhub.js --diag` para ver URL/abas/campos ao vivo |
| Tentativa 1/3 com "Campos visíveis: nenhum" e aprovação no retry | hidratação lenta da SPA: a primeira tentativa navega e não acha campo; o retry repete a busca e segue. Não é preciso fazer nada |
| `node spyhub.js testar` imprimia e não voltava ao prompt | corrigido: `encerrarCli()` no `finally` fecha o socket CDP e solta o Chrome sem matar a janela. Se restar processo antigo de versões anteriores, encerre com `taskkill /PID <pid> /F` |
| Todos reprovados com "não retornou resultado" | confira `SPYHUB_BUSCA_URL` e se a conta tem saldo/consulta liberada; o motivo real aparece em "Retorno do site" |
| `409` ao executar | já existe verificação rodando; aguarde ou feche/reabra a aba |

## Testes

```bash
node test-spyhub-parser.js   # parser + motor + rotas + tela (sem rede)
npm test                     # inclui o teste acima na suíte
node estado-spyhub.js        # estado do motor + próximos passos (CONTINUAR.md)
node estado-spyhub.js --diag # + sonda ao vivo no Chrome (aba, campo, botão)
node e2e-spyhub-rota.js      # E2E ao vivo da rota (consome consulta)
node e2e-painel-visual.js    # E2E visual pela tela em modo demo (consome consulta)
```

O teste de rotas chama o router em memória (sem abrir porta) e não faz nenhuma
consulta real ao SpyHub. Os dois E2E são ao vivo e ficam fora do `npm test`.

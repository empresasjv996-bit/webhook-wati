# Verificação e complemento de telefones

## O que foi verificado sobre o extratorgov.online

O site `https://extratorgov.online/` é uma aplicação **Streamlit** ("EXTRATOR NÚMEROS 2026")
atrás de login, com controle de créditos.

- todas as rotas — inclusive `/api` e `/docs` — devolvem o mesmo HTML do Streamlit;
- `api.extratorgov.online` não existe no DNS;
- o frontend só conversa com o servidor pelo websocket
  `wss://extratorgov.online/_stcore/stream` (capturado com `capturar-api.js`);
- as únicas chamadas HTTP são telemetria do próprio Streamlit
  (`data.streamlit.io`, `webhooks.fivetran.com`) e o iframe do
  `streamlit_cookies_manager`, que guarda o login.

Ou seja: **não existe API REST para integrar**. A consulta roda no servidor do site e
só é acessível pela interface. Se o provedor entregar um endpoint oficial (URL + chave
+ exemplo de resposta), a integração é simples: hoje a validação de formato é feita por
`telefone.js` e basta acrescentar a chamada HTTP nesse ponto.

## O que este projeto faz

`telefone.js` normaliza, valida e completa números brasileiros:

- remove máscara, `+`, espaços e zeros de tronco (`011...`);
- aceita número com ou sem DDI `55`;
- confere o DDD contra a lista oficial da ANATEL;
- identifica celular (9 + 6 a 9) e fixo (2 a 5);
- adiciona o **9º dígito** de celulares antigos (ex.: `1198765432` -> `11998765432`);
- devolve o número pronto para a Wati: **55 + DDD + número** (ex.: `5511998765432`).

> Importante: isso valida o **formato** do número. Não confirma se a linha existe ou se
> tem WhatsApp. Para isso é preciso um serviço externo (Wati ou uma API paga de consulta).

## 1. Pela linha de comando (lista .csv/.txt)

```bash
node verificar-numeros.js clientes.csv
node verificar-numeros.js clientes.csv corrigidos.csv --ddd=11
node verificar-numeros.js clientes.csv --json
```

- Detecta sozinho o separador (`;`, `,` ou Tab) e a coluna do telefone.
- Gera `clientes-verificado.csv` com todas as colunas originais: a coluna do telefone
  passa a ter o número completo e são acrescentadas `status_telefone`, `tipo_telefone`,
  `e164` e `motivo_telefone`.
- `--ddd=11` completa números que vieram sem DDD (8 ou 9 dígitos).

Atalho: `npm run verificar -- clientes.csv`.

## 2. Pelo painel (tela Listas)

Depois de colar o arquivo e clicar em **Analisar colunas**, use
**✓ Verificar e completar números**. O painel envia a coluna do telefone para
`POST /api/telefones/verificar` e troca cada célula pelo número completo.
Os inválidos ficam como estavam e aparecem na contagem.

## 3. Pela API

```http
POST /api/telefones/verificar
Content-Type: application/json
Cookie: qgc_token=...

{
  "telefones": ["1198765432", "1133334444"],
  "dddPadrao": "11"
}
```

Resposta:

```json
{
  "success": true,
  "resumo": { "total": 2, "ok": 1, "completados": 1, "invalidos": 0 },
  "resultados": [
    {
      "original": "1198765432",
      "valido": true,
      "status": "completado",
      "motivo": "9º dígito adicionado",
      "tipo": "celular",
      "ddd": "11",
      "numero": "998765432",
      "nacional": "11998765432",
      "wati": "5511998765432",
      "e164": "+5511998765432",
      "formatado": "(11) 99876-5432"
    }
  ]
}
```

## 4. Conferir se o site tem uma API (`capturar-api.js`)

Diagnóstico que abre o Chrome com um perfil separado, conecta no DevTools e grava as
chamadas de rede da página. Não instala nada (usa o WebSocket nativo do Node 22).

```bash
node capturar-api.js        # ou: npm run capturar
```

1. na janela do Chrome que abrir, faça login;
2. rode **uma** consulta de exemplo;
3. volte ao terminal e aperte **Ctrl+C**;
4. o relatório fica em `captura-api.json`, na pasta do projeto.

Opções: `--url=`, `--saida=`, `--segundos=N`, `--fechar`, `--tudo` (inclui telemetria).

O que ele já mostrou na tela inicial, sem login:

| Evidência | Resultado |
|---|---|
| websockets | apenas `wss://extratorgov.online/_stcore/stream` (protocolo do Streamlit) |
| chamadas HTTP | telemetria do Streamlit e o iframe `streamlit_cookies_manager` |
| host de API | nenhum |

Se depois do login/consulta aparecer um host novo (algo como `api...`), me mande o
`captura-api.json`: aí existe API de verdade e a integração é direta. Se continuar só o
`_stcore/stream`, a consulta roda no servidor do site — a única alternativa seria um
robô de navegador (Playwright), que é frágil, quebra a cada mudança de tela, gasta seus
créditos e depende de autorização do fornecedor.

## 5. Automação do site (login + consulta)

Como não existe API, a automação acontece **no navegador, na sua máquina**, usando o seu
login e os seus créditos. Ela é feita via Chrome DevTools Protocol, sem instalar nada.

Status:

| Etapa | Situação |
|---|---|
| abrir o site e ler a tela | funcionando (`mapear-tela.js`) |
| login automático (usuário + senha + botão) | funcionando |
| detectar login recusado | funcionando ("Credenciais inválidas") |
| anexar a lista de CPFs no painel | funcionando (`consultar-extrator.js`) |
| disparar a extração e baixar o resultado | implementado; falta rodar com crédito na conta |

### O que o painel autenticado mostra

Mapa capturado com `node mapear-tela.js --entrar --agora --fechar` (tela autenticada,
123 elementos):

| Item | Texto na tela |
|---|---|
| cabeçalho | `SESSÃO AUTENTICADA`, `Olá, <usuário>`, `SAIR` |
| status | `CORE ONLINE`, `TLS: ACTIVE`, `ENGINE: ASYNC`, `STATUS: READY` |
| saldo | `CREDITOS DISPONÍVEIS R$ 0.00` + botão `ATUALIZAR SALDO DA CONTA` |
| entrada | `MODO DE ENTRADA`: `LISTA MANUAL` / `GERADOR AUTOMÁTICO`, `Selecionar lista de CPFs`, `upload` |
| execução | `INICIAR EXTRAÇÃO`, `PAUSAR EXTRAÇÃO`, `Aguardando comando...` |

> A conta usada no teste entrou com **R$ 0,00 de crédito**. O login funciona, mas a
> extração provavelmente vai parar por falta de saldo — confirme os créditos antes de
> rodar em volume.

### Como o login automático funciona (e por que ele quebra fácil)

A tela é Streamlit, e isso impõe três cuidados — todos já implementados em
`mapear-tela.js`:

1. **Esperar hidratar**: o script espera o DOM parar de mudar (`MutationObserver`, até
   15 s) e só então digita — se digitar durante o primeiro rerun, o valor se perde.
2. **Confirmar o texto com TAB**: o campo exibe "Press Enter to apply" enquanto o valor
   não foi comitado. O script digita e envia `Tab` de verdade (`rawKeyDown` **sem**
   texto — com texto o Chrome insere um `\t` no campo e o login falha).
3. **Clicar no submit certo**: há dois botões que casam com "acessar" — **Acessar
   plataforma** (envia o formulário vazio e gera "Credenciais inválidas") e **Acessar
   Terminal** (o submit real). O script restringe a busca ao formulário do campo de
   senha e ignora qualquer botão com "plataforma".
4. **Conferir e repetir**: antes do clique ele compara o valor dos dois campos e exige
   que não haja "Press Enter to apply" pendente; se o site recusar, recarrega a página e
   tenta mais uma vez antes de acusar as credenciais.

Sinais no terminal: `Login concluído.` ou `O site recusou o login (usuário, senha ou
créditos).` Se o segundo aparecer com credenciais corretas, confira se o processo não
tem `EXTRATOR_USUARIO`/`EXTRATOR_SENHA` antigos no ambiente — variável de ambiente do
processo ganha do `.env` (feche e reabra o VS Code para limpar).

### Configuração (a senha fica só no seu PC)

Acrescente estas duas linhas ao seu `.env` (ele já existe com `DATABASE_URL` —
**não substitua o arquivo**):

```
EXTRATOR_USUARIO=seu-usuario
EXTRATOR_SENHA=sua-senha
```

O `.env` já está no `.gitignore`. Nunca mande a senha por chat.

### Onde colocar a lista

A lista é um arquivo comum, em qualquer pasta — os scripts recebem o caminho. Já existe a
pasta **`listas\`** no projeto (com `LEIA-ME.txt` e `exemplo-3-cpfs.txt`): é o lugar
natural para a sua. Ela está no `.gitignore`, então o conteúdo não vira commit.

```bash
node consultar-extrator.js listas\minha-lista.txt
```

Caminho relativo (`listas\minha-lista.txt`) ou absoluto (`C:\dados\lista.txt`): o script
resolve a partir da pasta em que você roda o comando. Se a lista tiver CPF real, prefira
deixá-la **fora do OneDrive** (ex.: `C:\extrator\listas\`) e passar o caminho completo.

Formatos aceitos:

| Para quê | Formato | Comando |
|---|---|---|
| conferir/completar telefones (local) | `.csv` com coluna `telefone`/`celular` (separador `;` ou `,`) ou `.txt` com um número por linha | `node verificar-numeros.js minha-lista.csv` |
| extrair no painel do site | `.txt` com um CPF por linha (ou o CSV que o painel aceita) | `node consultar-extrator.js lista-cpfs.txt` |

Saída local: `minha-lista-verificado.csv`, na mesma pasta da entrada. Há um
`lista-exemplo.csv` na raiz só como demonstração:

```bash
node verificar-numeros.js lista-exemplo.csv --ddd=11
```

Opções úteis do verificador: `--coluna=N` (quando o cabeçalho não tem nome de telefone),
`--ddd=11` (DDD para números curtos), `--saida=arquivo.csv`, `--json`.

### Enviar a lista no painel (`consultar-extrator.js`)

```bash
node consultar-extrator.js lista-cpfs.txt                 # fluxo completo
node consultar-extrator.js lista-cpfs.txt --nao-iniciar   # só loga e anexa (teste)
node consultar-extrator.js lista-cpfs.txt --espera=300    # espera mais tempo o fim
```

O que ele faz, em ordem:

1. abre o Chrome no perfil da automação e faz login (`EXTRATOR_USUARIO`/`EXTRATOR_SENHA`);
2. acha o `input[type=file]` do painel (`Selecionar lista de CPFs`) e **anexa o arquivo
   direto do seu disco** via CDP (`DOM.setFileInputFiles`) — sem copiar/colar nada;
3. espera o painel confirmar (`N CPFs carregados com sucesso!`);
4. clica em **INICIAR EXTRAÇÃO** e acompanha a tela, imprimindo só o que muda;
5. joga o download do painel na pasta `./downloads` (ou `--downloads=pasta`) e salva
   `consulta.json` + `consulta.png` com o histórico da tela.

Ele para sozinho e avisa quando o painel reclama de crédito/saldo. Sem `--fechar` o Chrome
fica aberto ao terminar (bom para conferir a tela); com `--fechar` ele fecha. Se o layout do
site mudar, o script salva o print e diz qual seletor não achou, em vez de clicar errado.

### Mapear a tela (quando o site mudar)

```bash
node mapear-tela.js --entrar            # login automático e espera ENTER
node mapear-tela.js --entrar --agora    # login automático e captura direto
```

Gera `tela.json` (campos, botões e textos visíveis) e `tela.png` (print). É o que usei
para descobrir `stFileUploaderDropzoneInput`, `INICIAR EXTRAÇÃO` e o texto de confirmação
dos CPFs. Atalhos: `npm run mapear -- --entrar`, `npm run extrair -- lista.txt`,
`npm run verificar -- lista.csv`.

> Custo e risco: cada consulta gasta créditos da sua conta, e a automação quebra se o
> fornecedor mudar o layout. Use apenas listas com base legal (LGPD) e conforme os
> termos do serviço.

## Testes

```bash
node test-telefone.js
```

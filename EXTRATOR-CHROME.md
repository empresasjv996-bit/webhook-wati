# Extrator automático dentro do servidor (Chrome no Render)

Até hoje o painel publicado no Render não conseguia consultar CPFs: o container
não tem navegador, e o `extrator.js` precisa de um Chrome para logar no
`extratorgov.online` e ler as linhas `✓ [LIVE] ...`. O resultado era "sem
retorno" em todo CPF.

A partir de agora existem dois modos:

| Onde roda | Precisa de quê | Como o navegador abre |
| --- | --- | --- |
| Seu PC (`npm start`) | Chrome/Edge instalado | janela normal, você acompanha |
| Container (`Dockerfile`) | imagem com Chromium | headless (`EXTRATOR_HEADLESS=1`) |

Já validado com a imagem desta pasta (`docker build -t qgc-webhook-chrome .`):

- `chromium --version` → `Chromium 156.0.8078.108` (Debian bookworm);
- Chrome headless abrindo a porta CDP → `CDP 200 Chrome/156...`;
- login real no `extratorgov.online` em headless → `login: true`, painel
  respondeu `Olá, cliente1010 / SESSÃO AUTENTICADA`;
- painel dentro do container → `/api/extrator/status` devolve
  `{"navegador":true,"motivo":"chrome-fechado","headless":true}`.

## 1. Variáveis de ambiente

| Variável | Para que serve | Valor no container |
| --- | --- | --- |
| `CHROME_PATH` | caminho do navegador | `/usr/bin/chromium` (já no Dockerfile) |
| `EXTRATOR_HEADLESS` | `1` = sem janela, `0` = janela | `1` (já no Dockerfile) |
| `EXTRATOR_USER_AGENT` | opcional, força o User-Agent | vazio (usa o do Chromium) |
| `EXTRATOR_USUARIO` / `EXTRATOR_SENHA` | login no extratorgov.online | já existem no Render |
| `CDP_PORT_EXT` | porta de depuração do Chrome | `9224` (padrão) |

Sem `EXTRATOR_HEADLESS`, o padrão é headless **somente** em Linux sem `DISPLAY`
(container); no Windows/macOS continua abrindo a janela.

## 2. Publicar no Render com Docker

O runtime nativo (Nixpacks) **não instala pacotes do sistema**, por isso o
Chromium só existe na imagem Docker.

1. Render Dashboard → serviço do painel → **Settings** → **Language/Runtime** →
   escolha **Docker** (Dockerfile Path: `Dockerfile`, na raiz do repositório).
   Se o seu serviço não permitir a troca, crie um **New → Web Service** apontando
   para o mesmo repositório com Language **Docker** e copie as variáveis de
   ambiente (as mesmas `WATI_*`, `DATABASE_URL`, `JWT_SECRET`, `EXTRATOR_*`).
2. **Plano:** o Chromium + a página do extrator passam de 400 MB de RAM.
   - Free / Starter (512 MB): costuma estourar (o container reinicia no meio da consulta).
   - **Standard (2 GB)** é o mínimo recomendado para rodar sem sustos.
3. Deploy. No log você deve ver o `npm ci`, o `apt-get ... chromium` e depois
   `Servidor rodando na porta 10000`.
4. Confirme o extrator: entre no painel e abra **Consultar CPF**. O aviso amarelo
   **não** deve aparecer. Em `GET /api/extrator/status` (logado como admin) deve
   vir `"navegador": true`, `"headless": true` e `"motivo": "chrome-fechado"` —
   o Chrome só sobe na primeira consulta.

## 3. Testar a imagem na sua máquina

```powershell
docker build -t qgc-webhook-chrome .
docker run --rm -p 3100:10000 --env-file .env -e MODO_DEMO=1 qgc-webhook-chrome
# http://localhost:3100
```

Teste rápido de que o Chromium funciona dentro da imagem:

```powershell
docker run --rm qgc-webhook-chrome `
  chromium --headless=new --no-sandbox --disable-dev-shm-usage --dump-dom about:blank
```

## 4. Testar uma consulta real (custa crédito)

O teste acima não fez extração nenhuma. Para confirmar o fluxo completo com **um**
CPF seu (R$ 0,20 por LIVE, die não desconta):

```powershell
docker run --rm --env-file .env qgc-webhook-chrome `
  node extrator.js testar cpfs.txt
```

O `cpfs.txt` precisa estar dentro da imagem/volume; o jeito mais simples é montar
a pasta:

```powershell
docker run --rm --env-file .env -v "${PWD}:/app" qgc-webhook-chrome `
  node extrator.js testar listas/teste-cpfs.txt
```

Se voltar `"status": "ok"` com telefone, o servidor está pronto para a consulta
automática. Se voltar erro de "campo não apareceu", o layout do site mudou — me
avise que eu ajusto os seletores.

## 5. Como funciona no código

- `navegador.js` — única fonte de verdade: acha o binário (`CHROME_PATH`,
  Windows, Linux, macOS), decide headless (`EXTRATOR_HEADLESS`), monta as flags
  e encerra o processo no sistema certo (`taskkill` no Windows, `SIGKILL` no
  Linux). Usado por `extrator.js`, `mapear-tela.js` e `consultar-extrator.js`.
- `extrator.js` — abre o Chrome com essas flags, loga, sobe o CPF e lê o
  resultado. `status()` informa `navegador`, `motivo` e `headless`.
- `Dockerfile` — Node 22 + Chromium + fontes, `CHROME_PATH=/usr/bin/chromium`,
  `EXTRATOR_HEADLESS=1`, `CMD ["node", "index.js"]`.

## 6. Limites e riscos

- **`/dev/shm`:** o Docker entrega 64 MB; o extrator já passa
  `--disable-dev-shm-usage` para não travar.
- **Sandbox:** em container o Chrome roda como root, então `--no-sandbox` é
  obrigatório (já incluído no modo headless).
- **Sessão do site:** o perfil fica em `/tmp` e se perde em cada deploy/restart.
  O login é refeito automaticamente com `EXTRATOR_USUARIO`/`EXTRATOR_SENHA`.
- **IP de datacenter:** se o `extratorgov.online` bloquear ou pedir captcha no
  login, a consulta falha mesmo com Chromium — nesse caso volte ao fluxo local
  (`node extrator.js testar cpfs.txt`) ou use um proxy residencial.
- **Spin down do plano Free:** 15 min sem tráfego derruba o serviço e a consulta
  em andamento morre. Para lotes longos, plano pago ou consulta em execução
  contínua.

## 7. Continuar no fluxo local

Se preferir não pagar plano maior, o caminho continua funcionando:

1. Tela **Listas** → **Baixar CPFs .txt**;
2. no seu PC: `node extrator.js testar cpfs.txt`;
3. cole o JSON/linhas no **passo 3** → **Aplicar resultado**.

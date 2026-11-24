# Processador de Lista Suja (Dirty List Processor)

> QGC TEAM by JV · Painel admin · Documento interno
> Transforma o dump bruto de consultas em lista limpa pronta para disparo, 100% no navegador.

---

## 1. O que faz

Recebe o dump bruto do **LIVE C6 PJ** (blocos com `CNPJ:`, `CPF Persona:`,
`--- DADOS DA EMPRESA ---`, `--- DADOS DA PERSONA (CPF) ---` e, quando existe,
`--- SOCIOS (n) ---`) e separa o registro em três partes:

1. **persona** (nome, nascimento, mãe, sexo, e-mail, telefones, endereço);
2. **empresa** (razão social, fantasia, situação, porte, capital, endereço, CEP, telefones, e-mail);
3. **sócios** (nome, qualificação, CPF, renda, telefones...).

Saídas:

- **CPFs para o extrator** — um CPF completo por linha (`000.000.000-00`), na ordem dos registros;
- **lista final de disparo** — `{telefone_e164};{nome_completo};{cnpj_formatado}`,
  uma linha por telefone. O telefone revelado pelo extrator entra na lista;
- **cadastro da empresa** — `.csv` com empresa + persona + sócios (para a ficha do cliente).

O processamento é local. A única saída do navegador é o atalho *Levar para Consultar CPF*, que entrega
os CPFs ao módulo do extrator (o mesmo que consulta o extratorgov.online).

## 2. Pipeline (Etapas A → D)

| Etapa | Regra |
|---|---|
| **A. Parsing** | Segmenta por `CNPJ:` quando ele abre o registro (LIVE C6 PJ); no dump antigo (CNPJ depois do `CPF Persona`), segmenta por `CPF Persona:`. A seção `--- SOCIOS ---` é cortada antes de ler a persona, então telefones/e-mails dos sócios **não** entram na persona. Chaves normalizadas (sem acento, minúsculas). |
| **B. Validação** | **CPF Persona** passa pelo dígito verificador. Falhou → descartado com **"CPF Inválido"**. CPF válido sem telefone real **não é descartado**: fica em **"Sem telefone"**, aguardando o extrator. |
| **C. Extrator** | A lista de CPFs (completa) vai para o extrator. Na volta, o painel casa por CPF completo, CPF mascarado (`000.000.xxx-xx`) ou nome (linha `✓ [LIVE] NOME \| ... \| Revelado: ...`) e soma os telefones revelados. Também aceita o JSON do módulo **Consultar CPF**. |
| **D. Saída** | `{telefone};{nome};{cnpj}` — N telefones = N linhas. CNPJ formatado `XX.XXX.XXX/XXXX-XX`. Telefones deduplicados por registro. |

Erro inesperado em um registro nunca derruba o processamento: vira descarte com motivo `Erro ao processar: ...`.

**Colagem tolerante.** Antes de segmentar, o texto passa por `normalizarEspacos` (BOM, CRLF, NBSP e
espaços zero-width) e, se nenhum rótulo abre linha, por `restaurarQuebras`, que devolve a quebra antes
dos marcadores `--- ... ---` e dos rótulos conhecidos. Aceita, portanto:

- `CPF Persona:`, `CPF da Persona:` e `CPF Persona (Titular):` (e o mesmo para `CNPJ (...)`);
- linhas indentadas com espaço ou NBSP (cópia de PDF/HTML);
- CRLF do Windows;
- o dump esmagado em **uma linha só** (tabela/PDF) — nesse caso best effort: CPF, nome, empresa e
  telefone são recuperados, mas valores que ficaram colados na mesma linha podem vir truncados;
- linha em branco entre registros.

Se o texto não tem os rótulos do dump, o parser lança erro com `codigo = 'formato'` e uma mensagem que
diz o que ele viu (`Li N linha(s), com X "CNPJ:" e Y "CPF Persona:"`) — é essa mensagem que aparece em
`suja-progresso` e no toast.

## 3. Uso no painel

Menu **Listas** (tela única — o antigo "Importar lista" e "Lista Suja" viraram o mesmo fluxo):

1. **Cole a lista bruta** e clique em **Processar Lista**.
2. **CPFs para o extrator** — um CPF completo por linha (o campo é editável: apague os que não quer
   consultar). `📋 Copiar CPFs` · `⬇ Baixar CPFs .txt` · `↪ Levar para Consultar CPF`
   (o atalho joga os CPFs na tela *Consultar CPF*; o limite do painel é 25 por consulta).
3. **Cole o resultado do extrator** e clique em **Aplicar resultado**
   (ou `⤓ Usar última consulta do painel`, que reaproveita o JSON da última consulta feita no painel).
4. **Prontos (N)** — lista final + `📋 Copiar` · `⬇ Baixar .txt` · `↪ Enviar para importação` ·
   `↪ Enviar com dados da empresa` · `⬇ Baixar cadastro (.csv)`.
   - *Enviar para importação* usa só `telefone;{{1}};{{2}}` (nome e CNPJ nas variáveis do template).
   - *Enviar com dados da empresa* acrescenta as colunas de atributos (razão social, situação, endereço,
     persona, sócios...). Ao importar, elas ficam em `clientes.atributos` e aparecem na **ficha do cliente**
     (painel admin e painel do vendedor, em `colaborador.html`).
   - Os dois botões de envio abrem a seção **Planilha pronta** (recolhida na mesma tela, `#lista-importar`):
     revise as colunas, confira os números e clique em **Importar lista**.
5. **Sem telefone (N)** — CPFs válidos que ainda não têm telefone (rode o extrator e volte ao passo 3).
6. **Descartados (N)** — tabela Motivo + Dado bruto (400 chars do registro original).
7. **🧹 Limpar** reseta caixas e resultado.

Processamento síncrono com estado de loading (setTimeout antes do parse); 1.000 registros levam ~20ms.

> **Deploy:** `lista-suja.js` faz parte da lista branca de estáticos (`ARQUIVOS_PUBLICOS` em `index.js`).
> Se um arquivo novo do painel não for adicionado lá, chega 404 em produção.

## 4. Testes (UAT do briefing)

`node test-lista-suja.js` (está na cadeia do `npm test`):

| Cenário | Esperado | Status |
|---|---|---|
| Bloco MARCOS TOBIAS LIMA (5 telefones, 1 repetido) | 5 linhas, formato exato `551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97` | ✅ |
| CPF com dígito verificador errado | Descartado, motivo "CPF Inválido" | ✅ |
| CPF válido sem telefone | Fica em "Sem telefone" + CPF na lista do extrator | ✅ |
| Mesmo telefone 2x no registro | 1 linha só | ✅ |
| 1.000 registros | < 2 s (medido: ~20 ms) | ✅ |
| Dump LIVE C6 PJ com empresa/persona/sócios | Empresa, persona e sócios separados; telefone do sócio não entra | ✅ |
| Extrator por CPF mascarado / nome / JSON do painel | Telefone revelado entra na lista | ✅ |
| Lista com dados da empresa | 1 linha por telefone com `telefone;{{1}};{{2}}` + atributos | ✅ |

## 5. Arquivos

| Arquivo | Papel |
|---|---|
| `lista-suja.js` | Parser puro (navegador + Node). Principais funções: `processarListaSuja`, `processarRegistro`, `segmentarRegistros`, `restaurarQuebras`, `normalizarEspacos`, `mensagemFormato`, `extrairEmpresa`, `extrairPersona`, `extrairSocio`, `aplicarResultadoExtrator`, `montarLinhasComEmpresa`, `montarCadastroCsv`, `validarCpf`, `formatarCnpj`. |
| `app.js` | Cola da UI: `processarListaSujaPainel`, `aplicarResultadoExtratorPainel`, `puxarResultadoExtratorPainel`, `mostrarAbaListaSuja`, `renderizarListaSuja`, `recalcularListaSuja`, `copiarListaSuja`, `baixarListaSuja`, `copiarListaSujaCpfs`, `baixarListaSujaCpfs`, `levarListaSujaParaExtrator`, `usarListaSujaNaImportacao`, `usarListaSujaNaImportacaoComEmpresa`, `baixarCadastroListaSuja`, `limparListaSuja`. |
| `index.html` | Tela única `view-listas` (passos 1-3, abas de resultado, planilha pronta recolhida e listas salvas) e script `lista-suja.js` carregado antes de `app.js`. |
| `colaborador.html` / `colaborador.js` / `colaborador.css` | Ficha do cliente no painel do vendedor: exibe `clientes.atributos` (dados da empresa/persona). |
| `style.css` | `.suja-tabs`, `.suja-bruto`. |
| `test-lista-suja.js` | UATs + testes de unidade. |

## 6. Limitações conhecidas (sem empolgação)

- Telefone **mascarado** (`55 (**) ***** 7130`) não vira número: o registro fica em "Sem telefone"
  até o extrator revelar. Quando o dump traz `Telefone desmascarado:`, ele entra normalmente.
- Telefones da empresa (`Tel Empresa 1/2`) **não entram na persona** — vão para o cadastro da empresa.
- Registro sem `CPF Persona:` (ou com CPF inválido) é descartado; sem `CNPJ:` a segmentação cai no
  modo antigo (por `CPF Persona:`).
- CPF mascarado (`000.000.xxx-xx`) só mostra 6 dígitos: se dois registros tiverem o mesmo prefixo,
  o desempate é pelo nome da linha LIVE. Sem nome, vale o primeiro.
- Nome ausente gera linha com o campo vazio (`telefone;;cnpj`) — a espec só barra CPF/telefone.

*Documento interno EQP APT01.*

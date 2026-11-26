# Listas — importação de contatos

> QGC TEAM by JV · Painel admin · Documento interno
> A tela **Listas** tem um fluxo único: colar o arquivo → conferir as colunas → importar na Wati.

---

## 1. O que a tela faz

| Passo | O que acontece |
|---|---|
| **Nome da lista** | Identifica a lista em *Listas salvas* e no histórico. |
| **Arquivo ou contatos colados** | `.csv`/`.txt` (lido no navegador com `FileReader`) ou texto colado. UTF-8, separador `;`, `,` ou Tab, com ou sem cabeçalho. |
| **Analisar colunas** | Faz o parse (`lerTabelaCsv`) e mostra um seletor por coluna. |
| **Vincule as colunas** | `telefone` (obrigatório), `nome`, *Variável do template* (`{{1}}`, `{{2}}`…) ou atributo (fixo ou personalizado). O que ficar em *Ignorar coluna* não vai para a Wati. O painel lembra o de/para em `localStorage` (`qgc-mapa-lista`). |
| **✓ Verificar e completar números** | `POST /api/telefones/verificar`: completa DDI/9º dígito e troca a célula pelo número no formato Wati. |
| **Enviar os contatos para a Wati** | Marcado por padrão: depois de gravar, manda os contatos em lotes de 20 (`POST /api/wati/contatos`). |
| **Importar lista** | `POST /api/listas` grava a lista (`{ nome, contatos }`); as colunas extras viram `clientes.atributos` e aparecem na ficha do cliente (painel admin e painel do vendedor). |
| **Listas salvas** | Tabela com nome, contatos, data e lixeira (`DELETE /api/listas/:id`). |
| **🧹 Limpar** | Zera nome, contatos, arquivo, resumo e o vínculo exibido (`limparImportacaoLista`). A memória de colunas em `localStorage` continua e volta no próximo *Analisar colunas*; as listas salvas não são tocadas. |

### Formato da planilha

```
telefone;{{1}};{{2}}
5511999999999;João da Silva;12.345.678/0001-90
5511888888888;Maria Souza;98.765.432/0001-10
```

- `{{1}}`, `{{2}}`… = variáveis do template usadas na campanha (`contatos.variaveis`);
- qualquer outro nome de coluna = atributo do contato na Wati (`contatos.atributos`);
- telefone é deduplicado e precisa de pelo menos 10 dígitos (`montarContatosDaLista`);
- `⬇ Baixar modelo .csv` gera o arquivo de exemplo (UTF-8 com BOM, abre no Excel).

## 2. De onde vêm os contatos

Outras telas preenchem `#lista-texto`, chamam `analisarLista()` e abrem o painel (`abrirImportacaoLista`):

- **Consultar CPF (Extrator)** → `↪ Usar na importação` (`usarExtratorNaLista`);
- **Telefones coletados** (consulta de CNPJ) → `↪ Usar na importação` (`usarColetadosNaLista`).

## 3. O que saiu da tela

O pipeline antigo de **dump** (passos *1. Cole a lista bruta*, *2. CPFs para o extrator*,
*3. Cole o resultado do extrator*, abas *Prontos / Sem telefone / Descartados* e a planilha
recolhida) foi removido do painel: a tela ficou só com a importação. Os ids `suja-*`,
`#lista-importar` e as funções `processarListaSujaPainel`, `aplicarResultadoExtratorPainel`,
`puxarResultadoExtratorPainel`, `copiarListaSuja*`, `baixarListaSuja*`, `limparListaSuja`
não existem mais em `app.js`/`index.html` (o histórico do git tem a versão anterior).

## 4. Arquivos

| Arquivo | Papel |
|---|---|
| `app.js` | `analisarLista`, `lerArquivoLista`, `baixarModeloLista`, `renderizarMapaLista`, `montarContatosDaLista`, `atualizarResumoLista`, `verificarNumerosLista`, `salvarLista`, `carregarListas`, `excluirLista`, `limparImportacaoLista`, `abrirImportacaoLista`, `usarExtratorNaLista`, `usarColetadosNaLista`. |
| `index.html` | `#view-listas` com `#painel-importar` (nome, contatos, arquivo, `#lista-mapeamento`) e `#tabela-listas`. |
| `style.css` | `.lista-texto`, `.file-row`, `.mapa-*`. |
| `lista-suja.js` | Parser puro do dump (navegador + Node). **Não é mais carregado pelo painel**; fica no repositório como módulo e continua coberto por `test-lista-suja.js`. |
| `test-lista-suja.js` | UATs e unidades do parser + verificação da tela (painel único, sem os ids antigos). |

## 5. Limitações

- Sem a tela de dump, transformar o dump do LIVE C6 PJ em planilha exige o parser fora do painel:
  `node -e "console.log(require('./lista-suja').processarListaSuja(require('fs').readFileSync('dump.txt','utf8')).linhas.join('\n'))"`.
- Telefone **mascarado** (`55 (**) ***** 7130`) não vira número: só entra depois de revelado pelo extrator.
- O vínculo de colunas é salvo por nome de coluna; cabeçalhos diferentes exigem conferir o mapa de novo.

*Documento interno EQP APT01.*

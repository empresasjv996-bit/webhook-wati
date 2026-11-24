# Processador de Lista Suja (Dirty List Processor)

> QGC TEAM by JV · Painel admin · Documento interno
> Transforma o dump bruto de consultas em lista limpa pronta para disparo, 100% no navegador.

---

## 1. O que faz

Recebe o texto bruto (blocos de persona com `CPF Persona:`, `CNPJ:`, `Telefone cadastro:`,
`Telefones:`, `Nome:` etc.), roda um pipeline ETL em memória e devolve linhas no formato de disparo:

```
{telefone_e164};{nome_completo};{cnpj_formatado}

551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97
```

- **1 linha por telefone válido** (deduplicado por registro).
- Nada sai do navegador: não há chamada ao servidor nem gravação em banco.

## 2. Pipeline (Etapas A → B → C)

| Etapa | Regra |
|---|---|
| **A. Parsing** | Segmenta por `CPF Persona:` (cada ocorrência inicia um registro). Linhas `Chave: valor` viram campos; linhas sem chave (lista de telefones, endereço) continuam o campo anterior. Chaves normalizadas (sem acento, minúsculas). |
| **A. Telefones** | Coleta **só** de `Telefone cadastro` + `Telefones` (persona — empresa não entra). Remove máscara, aplica DDI `55`, valida comprimento (10-11 dígitos = DDD + número). Prefixos `55`/`0` de tronco removidos. Deduplica. |
| **B. Validação** | **CPF Persona** passa pelo dígito verificador (2 dígitos, rejeita sequências repetidas). Falhou → descartado com motivo **"CPF Inválido"**. Sem ao menos 1 telefone válido → **"Sem Telefone Válido"**. |
| **C. Saída** | `{telefone};{nome};{cnpj}` — N telefones válidos = N linhas. CNPJ formatado `XX.XXX.XXX/XXXX-XX`. |

Erro inesperado em um registro nunca derruba o processamento: vira descarte com motivo `Erro ao processar: ...`.

## 3. Uso no painel

Menu **Lista Suja** → colar o dump → **Processar Lista**:

- Aba **Prontos (N)** — linhas prontas + `📋 Copiar` · `⬇ Baixar .txt` · `↪ Enviar para importação`
  (o último joga as linhas em `telefone;{{1}};{{2}}` na importação de listas, então `{{1}}` = nome e
  `{{2}}` = CNPJ formatado no template da campanha).
- Aba **Descartados (N)** — tabela Motivo + Dado bruto (400 chars do registro original).
- **🧹 Limpar** reseta caixa e resultado.

Processamento síncrono com estado de loading (setTimeout antes do parse); 1.000 registros levam ~10ms.

> **Deploy:** `lista-suja.js` faz parte da lista branca de estáticos (`ARQUIVOS_PUBLICOS` em `index.js`).
> Se um arquivo novo do painel não for adicionado lá, chega 404 em produção.

## 4. Testes (UAT do briefing)

`node test-lista-suja.js` (está na cadeia do `npm test`):

| Cenário | Esperado | Status |
|---|---|---|
| Bloco MARCOS TOBIAS LIMA (5 telefones, 1 repetido) | 5 linhas, formato exato `551231533128;MARCOS TOBIAS LIMA;27.964.767/0001-97` | ✅ |
| CPF com dígito verificador errado | Descartado, motivo "CPF Inválido" | ✅ |
| CPF válido sem telefone | Descartado, motivo "Sem Telefone Válido" | ✅ |
| Mesmo telefone 2x no registro | 1 linha só | ✅ |
| 1.000 registros | < 2 s (medido: ~10 ms) | ✅ |

## 5. Arquivos

| Arquivo | Papel |
|---|---|
| `lista-suja.js` | Parser puro (UMD: navegador + Node). Funções exportadas: `processarListaSuja`, `processarRegistro`, `segmentarRegistros`, `extrairChaves`, `extrairTelefones`, `normalizarTelefone`, `validarCpf`, `formatarCnpj`. |
| `app.js` | Cola da UI: `processarListaSujaPainel`, `mostrarAbaListaSuja`, `copiarListaSuja`, `baixarListaSuja`, `usarListaSujaNaImportacao`, `limparListaSuja`. |
| `index.html` | View `view-listasuja` + botão de menu (script `lista-suja.js` carregado antes de `app.js`). |
| `style.css` | `.suja-tabs`, `.suja-bruto`. |
| `test-lista-suja.js` | UATs + testes de unidade. |

## 6. Limitações conhecidas (sem empolgação)

- Telefone **mascarado** (`55 (**) ***** 7130`) não vira número: vira descarte se não houver outro válido.
- Telefones fora de `Telefone cadastro`/`Telefones` (ex.: `Tel Empresa 1`) **não entram por decisão de espec** — são da empresa, não da persona.
- Registro sem a linha `CPF Persona:` não é reconhecido (o parser acusa "formato não reconhecido").
- Nome ausente gera linha com o campo vazio (`telefone;;cnpj`) — a espec só barra CPF/telefone.

*Documento interno EQP APT01.*

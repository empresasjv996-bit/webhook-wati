/* =========================================================
   QGC TEAM by JV - Cliente DeepSeek
   ---------------------------------------------------------
   A API do DeepSeek é compatível com a da OpenAI: mesmo
   endpoint (/chat/completions), mesmo formato de mensagens
   ({ role, content }) e mesmo header Authorization: Bearer.
   Mudam apenas a URL base e o nome do modelo — por isso dá
   para usar exatamente como qualquer cliente OpenAI.

   Configuração (.env):
     DEEPSEEK_API_KEY=sk-...                    (obrigatória)
     DEEPSEEK_MODEL=deepseek-flash              (opcional)
     DEEPSEEK_BASE_URL=https://api.deepseek.com (opcional)
     DEEPSEEK_TIMEOUT_MS=60000                  (opcional)

   Uso:
     const { perguntar } = require('./deepseek');
     const texto = await perguntar('Resuma o contrato abaixo: ...');

   Nada é enviado além do texto das mensagens — sem webhook,
   sem log da chave.
   ========================================================= */

'use strict';

// Carrega o .env local sem depender do pacote dotenv (Node 20.12+).
if (!process.env.DEEPSEEK_API_KEY && typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch (erro) { /* .env é opcional */ }
}

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const BASE_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODELO = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS || 60000);

/* Diz se a chave está configurada (útil para checar no boot). */
function estaConfigurado() {
    return Boolean(API_KEY);
}

/* Conversa completa: recebe [{ role, content }] e devolve o texto. */
async function conversar(mensagens, opcoes = {}) {
    if (!API_KEY) {
        throw new Error('DEEPSEEK_API_KEY não configurada (veja .env.exemplo).');
    }

    const corpo = {
        model: opcoes.modelo || MODELO,
        messages: mensagens,
        temperature: opcoes.temperature == null ? 0.7 : opcoes.temperature,
        stream: false
    };
    if (opcoes.maxTokens) corpo.max_tokens = opcoes.maxTokens;
    if (opcoes.json) corpo.response_format = { type: 'json_object' };

    const resposta = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`
        },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(opcoes.timeoutMs || TIMEOUT_MS)
    });

    const dados = await resposta.json().catch(() => ({}));

    if (!resposta.ok) {
        const detalhe = (dados && dados.error && dados.error.message) || `HTTP ${resposta.status}`;
        throw new Error(`DeepSeek: ${detalhe}`);
    }

    const escolha = dados && dados.choices && dados.choices[0];
    const conteudo = (escolha && escolha.message && escolha.message.content) || '';

    // deepseek-flash/deepseek-v4-pro são modelos de raciocínio: eles pensam
    // antes de responder (campo reasoning_content). Se max_tokens for baixo
    // demais, todos os tokens vão para o raciocínio e o content fica vazio.
    if (!conteudo && escolha && escolha.finish_reason === 'length') {
        throw new Error('DeepSeek: limite de tokens atingido antes da resposta — aumente maxTokens.');
    }

    return conteudo;
}

/* Atalho para uma única pergunta, com system prompt opcional. */
async function perguntar(texto, opcoes = {}) {
    const mensagens = [];
    if (opcoes.sistema) mensagens.push({ role: 'system', content: opcoes.sistema });
    mensagens.push({ role: 'user', content: String(texto) });
    return conversar(mensagens, opcoes);
}

module.exports = { conversar, perguntar, estaConfigurado, MODELO, BASE_URL };

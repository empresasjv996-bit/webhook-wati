/* =========================================================
   QGC TEAM by JV - Exemplo de uso do DeepSeek
   ---------------------------------------------------------
   Executar:
     node exemplo-deepseek.js
     node exemplo-deepseek.js "Sua pergunta aqui"
     node exemplo-deepseek.js "Sua pergunta aqui" deepseek-v4-pro
   ========================================================= */

'use strict';

const { perguntar, estaConfigurado, MODELO } = require('./deepseek');

const PERGUNTA_PADRAO = 'Explique em 2 linhas o que é um webhook.';

async function principal() {
    const pergunta = process.argv[2] || PERGUNTA_PADRAO;
    const modelo = process.argv[3] || MODELO;

    if (!estaConfigurado()) {
        console.error('DEEPSEEK_API_KEY não configurada. Preencha o .env (veja .env.exemplo).');
        process.exit(1);
    }

    console.log(`modelo: ${modelo}`);
    console.log(`pergunta: ${pergunta}\n`);

    const inicio = Date.now();
    try {
        const resposta = await perguntar(pergunta, {
            modelo,
            maxTokens: 1024,
            sistema: 'Responda em português do Brasil, de forma objetiva.'
        });
        console.log(`resposta (${Date.now() - inicio} ms):\n${resposta}`);
    } catch (erro) {
        console.error(`erro (${Date.now() - inicio} ms): ${erro.message}`);
        process.exit(1);
    }
}

principal();

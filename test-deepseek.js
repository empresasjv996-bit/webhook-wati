/* =========================================================
   QGC TEAM by JV - Teste do cliente DeepSeek
   Executar: node test-deepseek.js
   ---------------------------------------------------------
   - Valida a configuração (modelo, URL base).
   - Se DEEPSEEK_API_KEY existir no .env, faz uma chamada
     real e confere a resposta; sem chave, apenas avisa.
   ========================================================= */

const assert = require('assert');
const { conversar, perguntar, estaConfigurado, MODELO, BASE_URL } = require('./deepseek');

(async () => {
    let testes = 0;

    assert.strictEqual(typeof conversar, 'function');
    assert.strictEqual(typeof perguntar, 'function');
    testes += 1;

    assert.strictEqual(BASE_URL, (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''));
    assert.ok(MODELO, 'DEEPSEEK_MODEL não pode ficar vazio');
    testes += 1;

    console.log(`config: modelo=${MODELO} base=${BASE_URL}`);
    console.log(`chave configurada: ${estaConfigurado() ? 'sim' : 'não'}`);

    if (!estaConfigurado()) {
        console.log(`\n${testes} teste(s) local(is) ok — chamada real pulada (sem DEEPSEEK_API_KEY).`);
        return;
    }

    // Modelos de raciocínio gastam tokens "pensando" — 10 tokens seriam insuficientes.
    const resposta = await perguntar('Responda apenas com a palavra: ok', { maxTokens: 512, temperature: 0 });
    assert.ok(resposta.length > 0, 'resposta vazia');
    testes += 1;

    console.log(`resposta da API: ${JSON.stringify(resposta)}`);
    console.log(`\n${testes} teste(s) ok.`);
})().catch((erro) => {
    console.error(`FALHOU: ${erro.message}`);
    process.exit(1);
});

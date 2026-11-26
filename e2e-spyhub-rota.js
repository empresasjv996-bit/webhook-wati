'use strict';
/* E2E do caminho do painel SpyHub, isolado do painel inteiro:
   Express mínimo + a rota real (routes/contatos-spyhub.js) + o motor real.
   Não abre banco, não sobe worker de campanhas, não fala com a Wati.

   O que valida:
     POST /api/spyhub/verificar      -> 202 + jobId + total
     GET  /api/spyhub/jobs/:id       -> polling até concluído, log e aprovados
     GET  /api/spyhub/jobs/:id/aprovados.csv -> CSV (BOM conferido byte a byte)
     GET  /api/spyhub/jobs/:id/reprovados.txt -> TXT dos reprovados

   Uso (na raiz do projeto, para o motor achar o .env):
     node e2e-spyhub-rota.js [arquivo.csv|txt]

   Sem argumento, usa listas/spyhub-aprovado.csv (fora do git, porque tem
   dados pessoais). É um teste AO VIVO: cada execução consome consulta no
   SpyHub. Não faz parte do `npm test`.
*/

const fs = require('fs');
const path = require('path');
const express = require('express');

const criarRotas = require('./routes/contatos-spyhub');
const spyhub = require('./spyhub');
const parser = require('./spyhub-parser');

const ARQUIVO = process.argv[2] || path.join(__dirname, 'listas', 'spyhub-aprovado.csv');
const ESPERA_MAX_MS = 120000;

function esperar(ms) {
    return new Promise((resolver) => setTimeout(resolver, ms));
}

(async () => {
    if (!fs.existsSync(ARQUIVO)) {
        console.error('Arquivo de teste não encontrado: ' + ARQUIVO);
        console.error('Crie um CSV com CPF + telefone (dados reais ficam fora do git) ou passe o caminho.');
        process.exit(1);
    }

    const texto = fs.readFileSync(ARQUIVO, 'utf8');
    const registro = parser.parseEntrada(texto).registros[0];
    if (!registro) {
        console.error('Nenhum registro válido no arquivo ' + ARQUIVO);
        process.exit(1);
    }

    const finalEsperado = registro.finais[0];

    const app = express();
    app.use(express.json({ limit: '3mb' }));
    app.use('/api/spyhub', criarRotas({
        exigirAdmin: (req, res, next) => next(),
        registrarAuditoria: async () => {}
    }));

    const servidor = await new Promise((ok) => {
        const s = app.listen(0, '127.0.0.1', () => ok(s));
    });

    const base = 'http://127.0.0.1:' + servidor.address().port;
    let falhou = false;

    try {
        console.log('Arquivo: ' + ARQUIVO + ' | CPF ' + registro.cpfFormatado
            + ' | final esperado ' + finalEsperado);
        console.log('Base do harness: ' + base);

        const status = await (await fetch(base + '/api/spyhub/status')).json();
        console.log('GET /status -> navegador=' + status.navegador
            + ' credenciais=' + status.credenciais + ' ocupado=' + status.ocupado);

        const resposta = await fetch(base + '/api/spyhub/verificar', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ texto })
        });

        const job = await resposta.json();
        console.log('POST /verificar -> HTTP ' + resposta.status + ' jobId=' + job.jobId
            + ' total=' + job.total + ' formato=' + job.formato);

        if (resposta.status !== 202 || !job.jobId) throw new Error('POST /verificar não devolveu 202/jobId');

        const inicio = Date.now();
        let instantaneo = null;
        let vistos = 0;

        do {
            await esperar(1500);
            instantaneo = await (await fetch(base + '/api/spyhub/jobs/' + job.jobId)).json();

            instantaneo.log.slice(vistos).forEach((linha) => {
                console.log('[' + linha.quando.slice(11, 19) + '] ' + linha.mensagem);
            });
            vistos = instantaneo.log.length;

            if (Date.now() - inicio > ESPERA_MAX_MS) throw new Error('tempo esgotado no polling do job');
        } while (instantaneo.status === 'rodando');

        console.log('Job: status=' + instantaneo.status + ' feitos=' + instantaneo.feitos
            + ' aprovados=' + instantaneo.aprovados.length + ' reprovados=' + instantaneo.reprovados.length);

        if (instantaneo.status !== 'concluido') throw new Error('job terminou com status ' + instantaneo.status);

        const csv = await fetch(base + '/api/spyhub/jobs/' + job.jobId + '/aprovados.csv');
        const bytes = new Uint8Array(await csv.arrayBuffer());
        const temBom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
        const corpoCsv = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
        console.log('GET aprovados.csv -> HTTP ' + csv.status
            + ' bom(EF BB BF)=' + temBom
            + ' linhas=' + corpoCsv.trim().split(/\r?\n/).length);
        console.log(corpoCsv.trim());

        const txt = await fetch(base + '/api/spyhub/jobs/' + job.jobId + '/reprovados.txt');
        const corpoTxt = await txt.text();
        console.log('GET reprovados.txt -> HTTP ' + txt.status + ' bytes=' + corpoTxt.length);

        const aprovado = instantaneo.aprovados.find((item) => item.cpf === registro.cpf);
        if (!aprovado) throw new Error('CPF ' + registro.cpfFormatado + ' não saiu nos aprovados');
        if (!temBom) throw new Error('CSV de aprovados sem BOM UTF-8');
        if (String(aprovado.telefoneEncontrado || '').replace(/\D/g, '').slice(-4) !== finalEsperado) {
            throw new Error('telefone aprovado não termina em ' + finalEsperado);
        }

        console.log('E2E OK: rota -> motor -> SpyHub -> exportações.');
    } catch (falha) {
        falhou = true;
        console.error('E2E FALHOU: ' + falha.message);
    } finally {
        spyhub.encerrarCli();
        servidor.close();
        setTimeout(() => process.exit(falhou ? 1 : 0), 300);
    }
})();

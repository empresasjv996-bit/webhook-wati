'use strict';
/* =========================================================
   QGC TEAM by JV - Rotas da Verificação SpyHub
   ---------------------------------------------------------
   Montado em /api/spyhub (index.js):

     GET  /status                 estado do Chrome/credenciais
     POST /verificar              { texto } -> parser + fila -> 202
     GET  /jobs/:id               progresso + log + resultados
     GET  /jobs/:id/aprovados.csv exporta os encontrados
     GET  /jobs/:id/reprovados.txt exporta as fichas completas
     POST /fechar                 fecha o Chrome dedicado

   O parse fica no backend (o dump inteiro chega por texto/CSV),
   como pedido na especificação — o navegador não precisa montar
   os registros.
   ========================================================= */

const express = require('express');

const parser = require('../spyhub-parser');
const spyhub = require('../spyhub');

const LIMITE_TEXTO = 2 * 1024 * 1024; // 2 MB por POST

module.exports = function criarRotasSpyhub(deps) {
    const { exigirAdmin, registrarAuditoria } = deps || {};
    const router = express.Router();

    router.get('/status', exigirAdmin, (req, res) => {
        res.json(Object.assign({ success: true }, spyhub.status()));
    });

    router.post('/verificar', exigirAdmin, (req, res) => {
        const corpo = req.body || {};
        const texto = String(corpo.texto || corpo.csv || '');

        if (!texto.trim()) {
            return res.status(400).json({ success: false, message: 'Cole a lista bruta ou envie o CSV.' });
        }

        if (texto.length > LIMITE_TEXTO) {
            return res.status(413).json({ success: false, message: 'Lista muito grande (limite de 2 MB por envio).' });
        }

        const analise = parser.parseEntrada(texto);

        if (!analise.total) {
            return res.status(400).json({
                success: false,
                message: 'Nenhum registro válido encontrado na lista.',
                ignorados: analise.ignorados.slice(0, 20),
                ignoradosTotal: analise.ignoradosTotal
            });
        }

        const situacao = spyhub.status();

        if (!situacao.navegador) {
            return res.status(503).json({
                success: false,
                codigo: 'sem-chrome',
                message: 'A verificação automática roda só na máquina que tem Chrome. '
                    + 'Use o comando local "node spyhub.js testar lista.txt" ou suba o painel com Chrome instalado.'
            });
        }

        if (!situacao.credenciais) {
            return res.status(400).json({
                success: false,
                codigo: 'sem-credenciais',
                message: 'Defina SPYHUB_USUARIO e SPYHUB_SENHA no .env do servidor.'
            });
        }

        try {
            const job = spyhub.iniciar(analise.registros);

            if (typeof registrarAuditoria === 'function') {
                Promise.resolve(registrarAuditoria(req.user && req.user.nome, 'verificacao spyhub',
                    job.total + ' registro(s) - job ' + job.id)).catch(() => {});
            }

            return res.status(202).json({
                success: true,
                jobId: job.id,
                total: job.total,
                formato: analise.formato,
                ignoradosTotal: analise.ignoradosTotal,
                ignorados: analise.ignorados.slice(0, 20)
            });
        } catch (falha) {
            if (falha.codigo === 'ocupado') {
                return res.status(409).json({ success: false, codigo: 'ocupado', message: falha.message });
            }

            return res.status(400).json({ success: false, message: falha.message });
        }
    });

    router.get('/jobs/:id', exigirAdmin, (req, res) => {
        const job = spyhub.instantaneo(req.params.id);

        if (!job) {
            return res.status(404).json({ success: false, message: 'Verificação não encontrada (ou já reiniciada).' });
        }

        res.json(Object.assign({ success: true }, job));
    });

    router.get('/jobs/:id/aprovados.csv', exigirAdmin, (req, res) => {
        const job = spyhub.instantaneo(req.params.id);

        if (!job) {
            return res.status(404).json({ success: false, message: 'Verificação não encontrada.' });
        }

        const csv = parser.csvDeAprovados(job.aprovados);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="spyhub-aprovados-' + job.id.slice(0, 8) + '.csv"');
        res.send('\uFEFF' + csv);
    });

    router.get('/jobs/:id/reprovados.txt', exigirAdmin, (req, res) => {
        const job = spyhub.instantaneo(req.params.id);

        if (!job) {
            return res.status(404).json({ success: false, message: 'Verificação não encontrada.' });
        }

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="spyhub-reprovados-' + job.id.slice(0, 8) + '.txt"');
        res.send(parser.txtDeReprovados(job.reprovados));
    });

    router.post('/fechar', exigirAdmin, (req, res) => {
        spyhub.fechar();
        res.json({ success: true, message: 'Chrome do SpyHub fechado.' });
    });

    return router;
};

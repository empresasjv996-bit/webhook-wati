/* =========================================================
   QGC TEAM by JV - Senhas
   ---------------------------------------------------------
   Hash com scrypt (nativo do Node, sem dependência extra).
   Formato salvo no banco:  scrypt$<salt>$<hash>
   ========================================================= */

'use strict';

const crypto = require('crypto');

const TAMANHO = 64;

function gerarHash(senha) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(senha || ''), salt, TAMANHO).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

function verificarSenha(senha, armazenado) {
    if (!armazenado) return false;

    const partes = String(armazenado).split('$');
    if (partes.length !== 3 || partes[0] !== 'scrypt') {
        // compatibilidade com senha em texto puro (importação antiga)
        return String(senha || '') === String(armazenado);
    }

    const [, salt, hash] = partes;
    try {
        const calculado = crypto.scryptSync(String(senha || ''), salt, TAMANHO);
        const esperado = Buffer.from(hash, 'hex');
        if (calculado.length !== esperado.length) return false;
        return crypto.timingSafeEqual(calculado, esperado);
    } catch (erro) {
        return false;
    }
}

module.exports = { gerarHash, verificarSenha };

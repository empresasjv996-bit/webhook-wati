/* =========================================================
   Backup + limpeza do histórico de conversas (uso local)
   ---------------------------------------------------------
   - Lê o DATABASE_URL do .env / ambiente (Postgres de produção)
   - Sempre grava um backup em ./backups antes de apagar
   - Só apaga com a confirmação explícita --confirmar=LIMPAR
   - Mantém clientes, fichas, campanhas e auditoria

   Uso:
     node scripts/backup-limpar-conversas.js
     node scripts/backup-limpar-conversas.js --confirmar=LIMPAR
   ========================================================= */

'use strict';

const fs = require('fs');
const path = require('path');
const banco = require('../db');

const CONFIRMADO = process.argv.includes('--confirmar=LIMPAR');

async function main() {
    if (banco.modoDemo) {
        console.error('Este script não roda no modo demo (sem DATABASE_URL real).');
        process.exit(1);
    }

    await banco.prepararBanco();

    const antes = await banco.contarConversas();
    console.log('Estado atual:', antes);

    const backup = await banco.exportarConversas();
    const pasta = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(pasta, { recursive: true });

    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const arquivo = path.join(pasta, 'conversas-' + carimbo + '.json');
    fs.writeFileSync(arquivo, JSON.stringify(backup, null, 2), 'utf8');

    console.log('Backup salvo em:', arquivo);
    console.log('Mensagens no backup:', backup.mensagens.length);

    if (!CONFIRMADO) {
        console.log('');
        console.log('Nada foi apagado. Para limpar, rode novamente com:');
        console.log('  node scripts/backup-limpar-conversas.js --confirmar=LIMPAR');
        return;
    }

    const resultado = await banco.limparConversas({ incluirEventosWati: true });
    console.log('Limpeza concluída:', resultado);

    const depois = await banco.contarConversas();
    console.log('Estado depois:', depois);
}

main()
    .then(() => process.exit(0))
    .catch((erro) => {
        console.error('Falha no backup/limpeza:', erro.message);
        process.exit(1);
    });

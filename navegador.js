'use strict';
/* =========================================================
   QGC TEAM by JV - Onde está o navegador e como abri-lo
   ---------------------------------------------------------
   Usado por extrator.js, mapear-tela.js e consultar-extrator.js.

   Duas realidades:
     - sua máquina (Windows/macOS): o Chrome abre janela normal;
     - container (Docker/Render): não existe tela, e o Chrome precisa
       de --headless=new --no-sandbox --disable-dev-shm-usage.
   ========================================================= */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/* Caminhos procurados quando CHROME_PATH não está definido.
   A lista de teste (opcional) existe para os testes automatizados. */
function acharNavegador(candidatos) {
    const lista = Array.isArray(candidatos) ? candidatos : [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        /* Linux — é o caso da imagem Docker (chromium do Debian) */
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        /* macOS */
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    ];

    return lista.filter(Boolean).find((caminho) => {
        try {
            return fs.existsSync(caminho);
        } catch (erro) {
            return false;
        }
    }) || '';
}

/* Por que a consulta automática não roda agora:
     ''              -> navegador conectado, pode consultar
     'chrome-fechado'-> navegador existe na máquina, janela ainda não aberta
     'sem-chrome'    -> nenhum navegador na máquina (servidor sem Chromium) */
function motivoIndisponivel(navegador, conectado) {
    if (conectado) return '';
    return navegador ? 'chrome-fechado' : 'sem-chrome';
}

/* Em container não existe tela: o Chrome roda headless.
   EXTRATOR_HEADLESS=1|0 força o modo; sem a variável, o padrão é headless
   apenas em Linux sem DISPLAY (container), e janela normal no Windows/macOS. */
function modoHeadless() {
    const valor = String(process.env.EXTRATOR_HEADLESS == null ? '' : process.env.EXTRATOR_HEADLESS)
        .trim()
        .toLowerCase();

    if (['1', 'true', 'sim', 'yes', 'on'].includes(valor)) return true;
    if (['0', 'false', 'nao', 'não', 'no', 'off'].includes(valor)) return false;

    return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

/* Flags do Chrome para uma porta/perfil/URL.
   headless também desliga o sandbox e o uso de /dev/shm pequeno — os dois
   motivos clássicos de o Chrome morrer dentro de Docker. */
function flagsNavegador(opcoes) {
    const config = opcoes || {};
    const flags = [
        '--remote-debugging-port=' + config.porta,
        '--user-data-dir=' + config.perfil,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1400,1000'
    ];

    if (modoHeadless()) {
        flags.push(
            '--headless=new',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--hide-scrollbars',
            '--mute-audio',
            '--disable-blink-features=AutomationControlled'
        );

        if (process.env.EXTRATOR_USER_AGENT) {
            flags.push('--user-agent=' + process.env.EXTRATOR_USER_AGENT);
        }
    }

    flags.push(config.url);

    return flags;
}

/* Encerra o processo do navegador no sistema certo (taskkill só existe no Windows). */
function encerrarProcesso(pid) {
    if (!pid) return;

    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch (erro) {
        /* processo já saiu */
    }
}

module.exports = {
    acharNavegador,
    motivoIndisponivel,
    modoHeadless,
    flagsNavegador,
    encerrarProcesso
};

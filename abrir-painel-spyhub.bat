@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title QGC TEAM - Painel local (Verificacao SpyHub)

rem ============================================================
rem  Atalho de duplo clique para usar a Verificacao SpyHub no
rem  SEU computador, onde o Chrome existe.
rem
rem  MODO DEMO  -> banco em memoria, envio da Wati desligado.
rem                As credenciais do SpyHub vem do .env (consulta real).
rem  Encerrar   -> feche esta janela ou Ctrl+C.
rem  Porta      -> 3100 (mude com: set PORT=3110 e rode de novo)
rem ============================================================

if not defined PORT set "PORT=3100"

echo.
echo ============================================================
echo  QGC TEAM by JV - Painel local (SpyHub)
echo  Endereco : http://localhost:%PORT%/login
echo  Login    : admin@qgcteam.com / 123456
echo  Modo     : DEMO (banco em memoria, Wati desligada)
echo ============================================================
echo.

rem --- ja existe um painel nesta porta? so abre o navegador ---
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }" >nul 2>&1
if not errorlevel 1 goto :iniciar

echo [i] Ja existe um painel rodando na porta %PORT% - so abrindo o navegador.
if defined PAINEL_SEM_NAVEGADOR goto :fim_ja_aberto
start "" "http://localhost:%PORT%/login"
:fim_ja_aberto
endlocal & exit /b 0

:iniciar
if not defined MODO_DEMO set "MODO_DEMO=1"

rem abre o navegador assim que o servidor responder (nao trava a janela)
if defined PAINEL_SEM_NAVEGADOR goto :rodar
start "" /b powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:%PORT%/login' -TimeoutSec 2; if ($r.StatusCode -eq 200) { break } } catch { }; Start-Sleep -Milliseconds 500 }; Start-Process 'http://localhost:%PORT%/login'"

:rodar
node index.js
set "SAIDA=%ERRORLEVEL%"

echo.
echo [i] Painel encerrado (codigo %SAIDA%).
if defined SPYHUB_NO_PAUSE goto :fim
pause
:fim
endlocal & exit /b %SAIDA%

@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title QGC TEAM - Verificacao SpyHub

set "ARQUIVO=%~1"
set "SAIDA=0"

if not defined ARQUIVO (
    echo.
    echo ============================================================
    echo  QGC TEAM by JV - Verificacao SpyHub
    echo ============================================================
    echo.
    echo Arraste o arquivo .txt/.csv para esta janela
    echo ou digite o caminho. Exemplo: listas\minha-lista.csv
    echo.
    set /p "ARQUIVO=Caminho do arquivo: "
)

set "ARQUIVO=%ARQUIVO:"=%"

if not exist "%ARQUIVO%" (
    echo.
    echo [ERRO] Arquivo nao encontrado: "%ARQUIVO%"
    set "SAIDA=2"
    goto :fim
)

echo.
echo Arquivo : "%ARQUIVO%"
echo Motor   : node spyhub.js testar (Chrome dedicado, CDP 9226)
echo.
node spyhub.js testar "%ARQUIVO%"
set "SAIDA=%ERRORLEVEL%"

echo.
if "%SAIDA%"=="0" (
    echo [OK] Fim da verificacao.
    echo Saidas desta execucao ^(se houve registro valido^):
    echo   aprovados-spyhub.csv
    echo   reprovados-spyhub.txt
    echo.
    echo Dica: o Chrome do SpyHub fica aberto ao terminar; a proxima execucao e mais rapida.
) else (
    echo [ERRO] O motor terminou com codigo %SAIDA%.
    echo Veja as mensagens acima. Dica: node spyhub.js status
)

:fim
echo.
if defined SPYHUB_NO_PAUSE goto :sem_pausa
echo %cmdcmdline% | find /i "%~0" >nul
if not errorlevel 1 pause
:sem_pausa
endlocal & exit /b %SAIDA%

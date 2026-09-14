@echo off
REM ============================================================
REM Meeting Processor - abre o aplicativo
REM
REM Clique duas vezes neste arquivo. Na primeira execucao ele
REM instala as dependencias do app (leva alguns minutos).
REM ============================================================
title Meeting Processor
REM Variaveis locais da maquina (ex.: CLAUDE_CONFIG_DIR), uma por linha, CHAVE=VALOR.
if exist "%~dp0.synapse-env" (
    for /f "usebackq eol=# tokens=1* delims==" %%a in ("%~dp0.synapse-env") do set "%%a=%%b"
)
cd /d "%~dp0desktop"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERRO] Node.js nao encontrado no PATH.
    echo  Instale com:  winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\" (
    echo.
    echo  Primeira execucao: instalando as dependencias do app...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERRO] Falha ao instalar as dependencias.
        pause
        exit /b 1
    )
)

echo.
echo  Abrindo o Meeting Processor...
call npm start

REM Se o app fechar por erro, a janela fica aberta para mostrar a mensagem.
if errorlevel 1 pause

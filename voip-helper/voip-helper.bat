@echo off
pushd "%~dp0"

:: 1. Tentar usar o node.exe portatil (se voce rodou o pre-dist.bat)
if exist "bin\node.exe" (
    echo [VoIP] Iniciando via bin\node.exe...
    start /B "" "bin\node.exe" index.js
    exit /b 0
)

:: 2. Tentar usar o node do sistema (caso voce seja o dev)
where node >nul 2>nul
if %ERRORLEVEL% == 0 (
    echo [VoIP] Iniciando via node global...
    start /B "" node index.js
    exit /b 0
)

echo [VoIP] ERRO: Nao foi possivel iniciar o Helper. 
echo Rode o 'pre-dist.bat' para preparar a pasta para seu amigo.
pause
popd

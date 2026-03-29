@echo off
setlocal
pushd "%~dp0"

echo [1/3] Instalando dependencias de producao (npm install)...
call npm install --omit=dev

echo [2/3] Copiando Node.exe do sistema para modo portatil...
if not exist "bin" mkdir "bin"
if exist "C:\Program Files\nodejs\node.exe" (
    copy /Y "C:\Program Files\nodejs\node.exe" "bin\node.exe"
) else (
    where node > temp.txt
    set /p NODE_PATH=<temp.txt
    del temp.txt
    if defined NODE_PATH (
        copy /Y "%NODE_PATH%" "bin\node.exe"
    ) else (
        echo [ERRO] Node.exe nao encontrado no sistema.
        echo Por favor, instale o Node.js antes de rodar este script.
        pause
        exit /b 1
    )
)

echo [3/3] Sucesso!
echo ---
echo Agora voce pode enviar a pasta 'otclientv8' (com a subpasta 'voip-helper') para seu amigo.
echo O VoIP abrira automaticamente junto com o Client e funcionara sem instalacao extra.
pause
popd

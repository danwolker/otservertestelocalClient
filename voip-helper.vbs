Set WshShell = CreateObject("WScript.Shell")
' Executa o script .bat de forma oculta (WindowStyle 0)
WshShell.Run "cmd.exe /c voip-helper\voip-helper.bat", 0, False

' ============================================================
' Synapse (Meeting Processor) - abre o aplicativo sem janela de console.
'
' Use este atalho no dia a dia; o .bat serve quando voce quer
' ver as mensagens (primeira instalacao ou diagnostico de erro).
'
' Um arquivo .synapse-env na raiz do projeto (opcional, fora do git)
' define variaveis de ambiente so para o app, uma por linha, CHAVE=VALOR.
' Exemplo: CLAUDE_CONFIG_DIR=C:\Users\voce\.claude-work
' ============================================================
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
desktopDir = fso.BuildPath(pasta, "desktop")

envFile = fso.BuildPath(pasta, ".synapse-env")
If fso.FileExists(envFile) Then
    Set env = shell.Environment("PROCESS")
    Set f = fso.OpenTextFile(envFile, 1)
    Do Until f.AtEndOfStream
        linha = Trim(f.ReadLine)
        If Len(linha) > 0 And Left(linha, 1) <> "#" Then
            pos = InStr(linha, "=")
            If pos > 1 Then env(Trim(Left(linha, pos - 1))) = Trim(Mid(linha, pos + 1))
        End If
    Loop
    f.Close
End If

If Not fso.FolderExists(fso.BuildPath(desktopDir, "node_modules")) Then
    ' Sem dependencias instaladas, o console e necessario: manda para o .bat.
    shell.Run """" & fso.BuildPath(pasta, "Meeting Processor.bat") & """", 1, False
Else
    shell.CurrentDirectory = desktopDir
    shell.Run "cmd /c npm start", 0, False
End If

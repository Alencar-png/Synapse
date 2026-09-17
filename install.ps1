#Requires -Version 5.1
<#
.SYNOPSIS
    Synapse — instalação em um comando (Windows).

.DESCRIPTION
    Confere o que já está instalado, busca o que falta e deixa o app pronto
    para abrir. É idempotente: o que já está no lugar é pulado, então rodar de
    novo depois de um erro continua de onde parou em vez de recomeçar.

    O script não instala nada no sistema por conta própria. Quando falta uma
    dependência, mostra o comando exato (winget) e para — uma instalação que
    mexe no sistema sem avisar é pior do que uma que espera.

.PARAMETER Model
    Modelo GGML a baixar. Padrão: large-v3-turbo (1,6 GB). Use large-v3 para
    o mais fiel (3,1 GB, cerca do dobro do tempo de transcrição).

.PARAMETER SemModelo
    Não baixa o modelo de transcrição — só as ferramentas.

.PARAMETER Gpu
    Aceleração do whisper.cpp: cpu (padrão) ou cuda (placas NVIDIA, +640 MB).
    Para GPU AMD ou Intel, use a compilação Vulkan — veja desktop/README.md.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Model large-v3 -Gpu cuda
#>

[CmdletBinding()]
param(
    [string]$Model = 'large-v3-turbo',
    [switch]$SemModelo,
    [ValidateSet('cpu', 'cuda')]
    [string]$Gpu = 'cpu'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

# Release do whisper.cpp com binários prontos. Fixa de propósito: a última tag
# nem sempre publica binários, e um instalador que quebra sozinho quando um
# projeto de terceiros muda de rotina não serve para nada.
$WhisperTag = 'v1.9.2'
$Pacote = if ($Gpu -eq 'cuda') { 'whisper-cublas-12.4.0-bin-x64.zip' } else { 'whisper-bin-x64.zip' }

# --- Aparência ---------------------------------------------------------------

function Write-Ok    { param([string]$Texto) Write-Host "  + $Texto" -ForegroundColor Green }
function Write-Baixa { param([string]$Texto) Write-Host "  > $Texto" -ForegroundColor Yellow }
function Write-Titulo { param([string]$Texto) Write-Host ''; Write-Host $Texto }

# Falta uma ferramenta do sistema: dizemos o comando exato e paramos.
function Stop-Falta {
    param([string]$Oque, [string]$Comando)
    Write-Host "  x $Oque não encontrado." -ForegroundColor Red
    Write-Host ''
    Write-Host '    Instale com:'
    Write-Host "      $Comando"
    Write-Host ''
    Write-Host '    E rode .\install.ps1 de novo.'
    Write-Host ''
    exit 1
}

function Test-Comando {
    param([string]$Nome)
    return [bool](Get-Command $Nome -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host "  Synapse — instalação (windows $env:PROCESSOR_ARCHITECTURE)"

# --- Passo 1: ferramentas do sistema ----------------------------------------

Write-Titulo 'Ferramentas do sistema'

# Node 20+: o app é Electron, e versões antigas não abrem a janela.
if (Test-Comando 'node') {
    $nodeVersao = (& node -v).TrimStart('v')
    if ([int]($nodeVersao -split '\.')[0] -lt 20) {
        Stop-Falta "Node.js 20+ (achei a $nodeVersao)" 'winget install OpenJS.NodeJS.LTS'
    }
    Write-Ok "Node.js v$nodeVersao"
} else {
    Stop-Falta 'Node.js' 'winget install OpenJS.NodeJS.LTS'
}

# Python 3.11+: o motor de transcrição usa sintaxe e tipos dessa faixa.
$py = $null
foreach ($candidato in @('python', 'python3', 'py')) {
    if (-not (Test-Comando $candidato)) { continue }
    # `py -3.11` e afins ficam de fora: basta o interpretador padrão servir.
    & $candidato -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>$null
    if ($LASTEXITCODE -eq 0) { $py = $candidato; break }
}
if (-not $py) { Stop-Falta 'Python 3.11+' 'winget install Python.Python.3.12' }
# Sem aspas dentro do -c: o PowerShell as come ao montar a linha de comando
# do processo filho, e o Python recebe um programa quebrado.
$pyVersao = & $py -c 'import sys; print(sys.version.split()[0])'
Write-Ok "Python $pyVersao ($py)"

# ffmpeg: extrai o áudio de qualquer container antes do Whisper.
if (-not (Test-Comando 'ffmpeg')) { Stop-Falta 'ffmpeg' 'winget install Gyan.FFmpeg' }
Write-Ok 'ffmpeg'

# --- Passo 2: ambiente Python ------------------------------------------------

Write-Titulo 'Motor de transcrição (Python)'

$venvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (Test-Path -LiteralPath $venvPython) {
    Write-Ok '.venv já existe'
} else {
    Write-Baixa 'criando .venv'
    & $py -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw 'Não foi possível criar o .venv.' }
    Write-Ok '.venv criado'
}

Write-Baixa 'instalando as dependências do motor'
& $venvPython -m pip install --upgrade pip --quiet
& $venvPython -m pip install -e . --quiet
if ($LASTEXITCODE -ne 0) { throw 'O pip install falhou.' }
Write-Ok 'meeting_processor instalado'

# --- Passo 3: whisper.cpp ----------------------------------------------------

Write-Titulo 'whisper.cpp'

New-Item -ItemType Directory -Force -Path '.whisper-cpp' | Out-Null
if (Test-Path -LiteralPath '.whisper-cpp\whisper-cli.exe') {
    Write-Ok 'whisper-cli.exe já está em .whisper-cpp\'
} else {
    $zip = Join-Path $env:TEMP "synapse-whisper-$WhisperTag.zip"
    Write-Baixa "$Pacote ($WhisperTag)"
    $url = "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperTag/$Pacote"
    # O ProgressPreference do Invoke-WebRequest custa minutos num arquivo
    # grande: a barra é redesenhada a cada bloco recebido.
    $progressoAntes = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } finally {
        $ProgressPreference = $progressoAntes
    }

    # O pacote traz tudo dentro de Release\; o app procura os binários soltos
    # em .whisper-cpp\, ao lado das DLLs que eles carregam.
    $destino = Join-Path $env:TEMP "synapse-whisper-$WhisperTag"
    if (Test-Path -LiteralPath $destino) { Remove-Item -Recurse -Force $destino }
    Expand-Archive -LiteralPath $zip -DestinationPath $destino -Force
    $release = Get-ChildItem -LiteralPath $destino -Directory | Select-Object -First 1
    $origem = if ($release) { $release.FullName } else { $destino }
    Copy-Item -Path (Join-Path $origem '*') -Destination '.whisper-cpp' -Recurse -Force
    Remove-Item -Recurse -Force $destino, $zip

    if (-not (Test-Path -LiteralPath '.whisper-cpp\whisper-cli.exe')) {
        throw "O pacote $Pacote não trouxe whisper-cli.exe."
    }
    Write-Ok "whisper-cli.exe pronto em .whisper-cpp\ ($Gpu)"
}

# --- Passo 4: modelos --------------------------------------------------------

Write-Titulo 'Modelos'

New-Item -ItemType Directory -Force -Path '.models' | Out-Null

function Get-Arquivo {
    param([string]$Url, [string]$Destino)
    # Só vira o arquivo final quando o download termina inteiro: um .bin
    # truncado seria aceito pelo app e só falharia na primeira transcrição.
    $parcial = "$Destino.parcial"
    $progressoAntes = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $parcial -UseBasicParsing
    } finally {
        $ProgressPreference = $progressoAntes
    }
    Move-Item -LiteralPath $parcial -Destination $Destino -Force
}

# Detecção de voz: 0,9 MB que evitam o Whisper inventar "Tchau." nos silêncios.
if (Get-ChildItem '.models\ggml-silero-*.bin' -ErrorAction SilentlyContinue) {
    Write-Ok 'modelo de detecção de voz já está em .models\'
} else {
    Write-Baixa 'ggml-silero-v5.1.2.bin (0,9 MB) — detecção de voz'
    Get-Arquivo 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin' `
                '.models\ggml-silero-v5.1.2.bin'
    Write-Ok 'detecção de voz pronta'
}

$modeloPath = ".models\ggml-$Model.bin"
if ($SemModelo) {
    Write-Host '  - modelo de transcrição pulado (-SemModelo)' -ForegroundColor Yellow
} elseif (Test-Path -LiteralPath $modeloPath) {
    Write-Ok "ggml-$Model.bin já está em .models\"
} else {
    Write-Baixa "ggml-$Model.bin — pode demorar, são gigabytes"
    Get-Arquivo "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin" $modeloPath
    Write-Ok "ggml-$Model.bin pronto"
}

# --- Passo 5: o app ----------------------------------------------------------

Write-Titulo 'App (Electron)'

Write-Baixa 'npm install'
Push-Location 'desktop'
try {
    & cmd /c 'npm install --no-fund --no-audit --loglevel=error'
    if ($LASTEXITCODE -ne 0) { throw 'O npm install falhou.' }
} finally {
    Pop-Location
}
Write-Ok 'dependências do app instaladas'

# --- Pronto ------------------------------------------------------------------

Write-Titulo 'Pronto.'
Write-Host '  Abra com um duplo clique em "Meeting Processor (sem console).vbs"'
Write-Host '  ou pelo terminal:  cd desktop; npm start'
Write-Host ''
Write-Host '  Para abrir junto com o Windows, veja o README (pasta Inicialização).'
Write-Host ''

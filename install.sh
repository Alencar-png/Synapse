#!/usr/bin/env bash
#
# Synapse — instalação em um comando (macOS e Linux).
#
#   ./install.sh                     # modelo padrão (large-v3-turbo, 1,6 GB)
#   ./install.sh --model large-v3    # o mais fiel (3,1 GB), mais lento
#   ./install.sh --sem-modelo        # só as ferramentas; baixe o .bin depois
#
# O script é idempotente: o que já está no lugar é conferido e pulado, então
# rodar de novo depois de um erro continua de onde parou em vez de recomeçar.
#
# Ele nunca instala nada com sudo por conta própria. Quando falta uma
# dependência do sistema, mostra exatamente o comando a rodar e para — uma
# instalação que mexe no sistema sem avisar é pior do que uma que espera.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$RAIZ"

# Release do whisper.cpp com binários prontos. Fixa de propósito: a última tag
# nem sempre publica binários, e um instalador que quebra sozinho quando um
# projeto de terceiros muda de rotina não serve para nada.
WHISPER_TAG="v1.9.2"
MODELO="large-v3-turbo"
BAIXAR_MODELO=1

while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODELO="${2:?--model precisa do nome do modelo}"; shift 2 ;;
    --sem-modelo) BAIXAR_MODELO=0; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Opção desconhecida: $1 (use --help)"; exit 2 ;;
  esac
done

# --- Aparência ---------------------------------------------------------------

if [ -t 1 ]; then
  VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; APAGA=$'\033[0m'
else
  VERDE=''; AMARELO=''; VERMELHO=''; APAGA=''
fi

ok()     { printf '  %s✓%s %s\n' "$VERDE" "$APAGA" "$1"; }
baixa()  { printf '  %s⬇%s %s\n' "$AMARELO" "$APAGA" "$1"; }
erro()   { printf '  %s✗%s %s\n' "$VERMELHO" "$APAGA" "$1" >&2; }
titulo() { printf '\n%s\n' "$1"; }

# Falta uma ferramenta do sistema: dizemos o comando exato e paramos.
falta() {
  erro "$1 não encontrado."
  printf '\n    Instale com:\n      %s\n\n    E rode ./install.sh de novo.\n\n' "$2" >&2
  exit 1
}

# --- Onde estamos ------------------------------------------------------------

case "$(uname -s)" in
  Darwin) SO=macos ;;
  Linux)  SO=linux ;;
  *) erro "Sistema não suportado: $(uname -s). No Windows, use install.ps1."; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64)  ARQ=x64 ;;
  arm64|aarch64) ARQ=arm64 ;;
  *) erro "Arquitetura não suportada: $(uname -m)."; exit 1 ;;
esac

# O comando de instalação sugerido muda com o gerenciador de pacotes.
if   command -v brew    >/dev/null 2>&1; then GP="brew install"
elif command -v apt-get >/dev/null 2>&1; then GP="sudo apt install -y"
elif command -v dnf     >/dev/null 2>&1; then GP="sudo dnf install -y"
elif command -v pacman  >/dev/null 2>&1; then GP="sudo pacman -S --needed"
elif command -v zypper  >/dev/null 2>&1; then GP="sudo zypper install -y"
else GP="o gerenciador de pacotes da sua distribuição:"
fi

printf '\n  Synapse — instalação (%s %s)\n' "$SO" "$ARQ"

# --- Passo 1: ferramentas do sistema ----------------------------------------

titulo "Ferramentas do sistema"

command -v curl >/dev/null 2>&1 || falta "curl" "$GP curl"
command -v tar  >/dev/null 2>&1 || falta "tar"  "$GP tar"

# Node 20+: o app é Electron, e versões antigas não abrem a janela.
if command -v node >/dev/null 2>&1; then
  NODE_MAIOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAIOR" -lt 20 ]; then
    falta "Node.js 20+ (achei a $(node -v))" "$GP node"
  fi
  ok "Node.js $(node -v)"
else
  falta "Node.js" "$GP node"
fi

# Python 3.11+: o motor de transcrição usa sintaxe e tipos dessa faixa.
PY=""
for candidato in python3.13 python3.12 python3.11 python3 python; do
  if command -v "$candidato" >/dev/null 2>&1 \
     && "$candidato" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
    PY="$candidato"
    break
  fi
done
[ -n "$PY" ] || falta "Python 3.11+" "$GP python3"
ok "Python $("$PY" -c 'import sys; print(sys.version.split()[0])') ($PY)"

# ffmpeg: extrai o áudio de qualquer container antes do Whisper.
command -v ffmpeg >/dev/null 2>&1 || falta "ffmpeg" "$GP ffmpeg"
ok "ffmpeg"

# --- Passo 2: ambiente Python ------------------------------------------------

titulo "Motor de transcrição (Python)"

if [ -x .venv/bin/python ]; then
  ok ".venv já existe"
else
  baixa "criando .venv"
  "$PY" -m venv .venv
  ok ".venv criado"
fi

baixa "instalando as dependências do motor"
.venv/bin/python -m pip install --upgrade pip --quiet
.venv/bin/python -m pip install -e . --quiet
ok "meeting_processor instalado"

# --- Passo 3: whisper.cpp ----------------------------------------------------

titulo "whisper.cpp"

mkdir -p .whisper-cpp

if [ -x .whisper-cpp/whisper-cli ]; then
  ok "whisper-cli já está em .whisper-cpp/"
elif [ "$SO" = macos ]; then
  # No macOS não há binário pronto nas releases, e o Homebrew entrega um
  # compilado com Metal — GPU de verdade, melhor do que qualquer coisa que
  # baixássemos pronta.
  if command -v brew >/dev/null 2>&1; then
    brew list whisper-cpp >/dev/null 2>&1 || { baixa "brew install whisper-cpp"; brew install whisper-cpp; }
    ln -sf "$(brew --prefix)/bin/whisper-cli" .whisper-cpp/whisper-cli
    ok "whisper-cli ligado ao do Homebrew (Metal)"
  else
    falta "Homebrew (para o whisper.cpp no macOS)" \
      '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/brew/HEAD/install.sh)"'
  fi
else
  PACOTE="whisper-bin-ubuntu-${ARQ}.tar.gz"
  baixa "$PACOTE ($WHISPER_TAG)"
  curl -fL --progress-bar -o .whisper-cpp/whisper.tgz \
    "https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/${PACOTE}"
  tar xzf .whisper-cpp/whisper.tgz -C .whisper-cpp --strip-components=1
  rm -f .whisper-cpp/whisper.tgz

  # O binário procura as libs ao lado dele, e nem toda distro resolve isso
  # sozinha. O embrulho garante que ache, venha de onde vier a chamada.
  mv .whisper-cpp/whisper-cli .whisper-cpp/whisper-cli.bin
  printf '%s\n' \
    '#!/usr/bin/env sh' \
    '# As libs do whisper.cpp moram ao lado do binário, não no sistema.' \
    'AQUI="$(cd "$(dirname "$0")" && pwd)"' \
    'LD_LIBRARY_PATH="$AQUI${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" exec "$AQUI/whisper-cli.bin" "$@"' \
    > .whisper-cpp/whisper-cli
  chmod +x .whisper-cpp/whisper-cli .whisper-cpp/whisper-cli.bin
  ok "whisper-cli pronto em .whisper-cpp/ (CPU)"
fi

# --- Passo 4: modelos --------------------------------------------------------

titulo "Modelos"

mkdir -p .models

# Detecção de voz: 0,9 MB que evitam o Whisper inventar "Tchau." nos silêncios.
if ls .models/ggml-silero-*.bin >/dev/null 2>&1; then
  ok "modelo de detecção de voz já está em .models/"
else
  baixa "ggml-silero-v5.1.2.bin (0,9 MB) — detecção de voz"
  curl -fL --progress-bar -o .models/ggml-silero-v5.1.2.bin \
    "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
  ok "detecção de voz pronta"
fi

if [ "$BAIXAR_MODELO" -eq 0 ]; then
  printf '  %s—%s modelo de transcrição pulado (--sem-modelo)\n' "$AMARELO" "$APAGA"
elif [ -f ".models/ggml-${MODELO}.bin" ]; then
  ok "ggml-${MODELO}.bin já está em .models/"
else
  baixa "ggml-${MODELO}.bin — pode demorar, são gigabytes"
  # Só vira o arquivo final quando o download termina inteiro: um .bin
  # truncado seria aceito pelo app e só falharia na primeira transcrição.
  curl -fL --progress-bar -o ".models/ggml-${MODELO}.bin.parcial" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${MODELO}.bin"
  mv ".models/ggml-${MODELO}.bin.parcial" ".models/ggml-${MODELO}.bin"
  ok "ggml-${MODELO}.bin pronto"
fi

# --- Passo 5: o app ----------------------------------------------------------

titulo "App (Electron)"

baixa "npm install"
(cd desktop && npm install --no-fund --no-audit --loglevel=error)
ok "dependências do app instaladas"

# --- Passo 6: o atalho -------------------------------------------------------

printf '%s\n' \
  '#!/usr/bin/env sh' \
  '# Abre o Synapse. Criado pelo install.sh.' \
  'cd "$(dirname "$0")/desktop" && exec npm start --silent' \
  > synapse
chmod +x synapse
ok "atalho ./synapse criado"

# --- Pronto ------------------------------------------------------------------

titulo "Pronto."
printf '  Abra com:  %s./synapse%s\n\n' "$VERDE" "$APAGA"
printf '  Sobre gravação: fora do Windows o app captura só o microfone — o\n'
printf '  áudio da chamada, não. Para gravar os dois lados, instale o OBS\n'
printf '  Studio e ligue-o em Configurações → Gravar pelo OBS Studio.\n\n'

"""Extração de áudio de arquivos de vídeo usando ffmpeg."""

import hashlib
import logging
import subprocess
import sys
from pathlib import Path

from .config import Settings
from .utils import ascii_slug

logger = logging.getLogger(__name__)

# Ler metadados é instantâneo; o minuto existe para o caso de o arquivo estar
# num disco de rede que parou de responder.
PROBE_TIMEOUT_SECONDS = 60


def _ffmpeg_install_hint() -> str:
    """Sugestão de instalação do ffmpeg conforme o sistema operacional."""
    if sys.platform == "win32":
        return "Instale com: winget install Gyan.FFmpeg"
    if sys.platform == "darwin":
        return "Instale com: brew install ffmpeg"
    return "Instale com: sudo apt install ffmpeg (ou o gerenciador da sua distro)"


def validate_ffmpeg() -> bool:
    """Verifica se o ffmpeg está disponível no PATH."""
    try:
        subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            check=True,
            encoding="utf-8",
            errors="replace",
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def get_duration(file_path: Path) -> float:
    """Retorna a duração do arquivo em segundos usando ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        return float(result.stdout.strip())
    except (subprocess.CalledProcessError, ValueError) as e:
        logger.warning("Não foi possível obter duração de %s: %s", file_path, e)
        return 0.0


def audio_channels(file_path: Path) -> int:
    """Quantos canais a primeira trilha de áudio do arquivo tem.

    Serve para não prometer diarização onde ela não existe: um arquivo mono
    duplicado em dois canais tem a mesma energia dos dois lados, e o
    whisper.cpp responde "?" em cada trecho — o que viraria "Sobreposição"
    escrito ao lado de toda fala da reunião. Melhor não marcar nada.

    Devolve 0 quando não dá para saber (arquivo sem áudio, ffprobe ausente).
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-select_streams", "a:0",
                "-show_entries", "stream=channels",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
            timeout=PROBE_TIMEOUT_SECONDS,
        )
        return int((result.stdout or "0").strip().splitlines()[0])
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        return 0
    except (ValueError, IndexError):
        return 0


def extract_audio(video_path: Path, config: Settings) -> Path:
    """Extrai áudio WAV 16kHz do vídeo para transcrição com Whisper.

    Mono por padrão. Com ``whisper_diarize`` ligado, sai em estéreo: é a
    separação entre os canais que permite ao whisper.cpp dizer de qual fonte
    veio cada fala — o microfone de um lado, o som do sistema do outro. Rebaixar
    para mono aqui apagaria essa informação antes de a transcrição começar, e
    não há como recuperá-la depois.

    Gravação que já é mono continua mono mesmo com a opção ligada: duplicar o
    canal daria dois lados idênticos, e o whisper responderia "?" em toda fala
    — uma marcação inútil ao lado de cada linha da reunião.

    Args:
        video_path: Caminho do arquivo de vídeo.
        config: Configurações do sistema.

    Returns:
        Caminho do arquivo WAV extraído.

    Raises:
        RuntimeError: Se o ffmpeg não estiver instalado ou a extração falhar.
    """
    if not validate_ffmpeg():
        raise RuntimeError(
            f"ffmpeg não encontrado no PATH. {_ffmpeg_install_hint()}"
        )

    # Nome do WAV inclui um hash curto do caminho completo do vídeo. Assim
    # dois vídeos de mesmo nome (em pastas diferentes) processados em paralelo
    # não colidem no mesmo arquivo temporário.
    # O nome base é reduzido a ASCII porque o whisper-cli não abre caminhos
    # acentuados no Windows (recebe argv na code page ANSI); o hash mantém a
    # unicidade mesmo quando dois nomes diferentes achatam para o mesmo slug.
    path_hash = hashlib.sha256(str(video_path).encode("utf-8")).hexdigest()[:8]
    output_path = config.temp_path / f"{ascii_slug(video_path.stem)}.{path_hash}.wav"
    config.temp_path.mkdir(parents=True, exist_ok=True)

    # Estéreo só quando a gravação de fato tem dois lados para separar.
    channels = "2" if config.whisper_diarize and audio_channels(video_path) >= 2 else "1"
    logger.info(
        "Extraindo áudio de %s (%s)...",
        video_path.name,
        "estéreo, para separar quem fala" if channels == "2" else "mono",
    )

    try:
        subprocess.run(
            [
                "ffmpeg",
                "-i", str(video_path),
                "-vn",                  # sem vídeo
                "-acodec", "pcm_s16le", # WAV PCM 16-bit
                "-ar", "16000",         # 16kHz (padrão Whisper)
                "-ac", channels,        # mono, ou estéreo para a diarização
                "-y",                   # sobrescrever se existir
                str(output_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
            timeout=config.ffmpeg_timeout,
        )
    except subprocess.TimeoutExpired as e:
        # Sem timeout, um vídeo corrompido travaria o worker indefinidamente.
        output_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"ffmpeg excedeu o tempo limite ({config.ffmpeg_timeout:.0f}s) "
            f"em {video_path.name}. Arquivo possivelmente corrompido."
        ) from e
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Falha ao extrair áudio: {e.stderr}"
        ) from e

    logger.info("Áudio extraído: %s (%.1f MB)", output_path.name, output_path.stat().st_size / 1_048_576)
    return output_path

"""Ponto de entrada do motor de transcrição.

Uso:
    python -m meeting_processor transcribe <arquivo> [--output-dir ...]

É o que o app desktop chama para cada gravação. Também serve de linha de
comando avulsa, para transcrever um arquivo sem abrir o app.
"""

import argparse
import logging
import sys
import time
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TextIO

from .config import Settings, load_config


def setup_logging(level: str, stream: TextIO | None = None) -> None:
    """Configura logging para console e arquivo (com rotação).

    ``stream`` permite mandar o console para stderr: no modo ``--json`` o
    stdout carrega só os eventos JSONL e não pode ser poluído por log.
    """
    log_format = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    date_format = "%Y-%m-%d %H:%M:%S"

    handlers: list[logging.Handler] = [logging.StreamHandler(stream or sys.stdout)]
    try:
        # Rotação: evita que o log cresça indefinidamente (5 MB x 3 backups).
        handlers.append(
            RotatingFileHandler(
                "meeting_processor.log",
                maxBytes=5_000_000,
                backupCount=3,
                encoding="utf-8",
            )
        )
    except OSError:
        # Diretório de trabalho somente-leitura (ex.: container com volume ro):
        # segue só com o console em vez de abortar o processamento.
        pass

    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format=log_format,
        datefmt=date_format,
        handlers=handlers,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Transcreve gravacoes de reuniao com o Whisper",
    )
    subparsers = parser.add_subparsers(dest="command")

    tr = subparsers.add_parser(
        "transcribe",
        help="So transcreve um video e grava os arquivos numa pasta de saida",
    )
    tr.add_argument("file", type=str, help="Caminho do arquivo de video")
    tr.add_argument(
        "--output-dir",
        type=str,
        default="",
        help="Pasta de saida (padrao: a pasta do proprio video)",
    )
    tr.add_argument(
        "--formats",
        type=str,
        default="md,txt",
        help="Formatos separados por virgula: md, txt (padrao: md,txt)",
    )
    tr.add_argument(
        "--name",
        type=str,
        default="",
        help="Nome da reuniao (vira o nome da pasta). Padrao: nome do arquivo",
    )
    tr.add_argument(
        "--recorded-at",
        type=str,
        default="",
        help=(
            "Data e hora em que a reuniao comecou, em ISO 8601 local "
            "(ex.: 2026-09-16T14:30:00). Padrao: o que o proprio arquivo disser"
        ),
    )
    tr.add_argument("--model", type=str, default="", help="Modelo do Whisper (ex.: small)")
    tr.add_argument("--language", type=str, default="", help="Idioma do audio (ex.: pt)")
    tr.add_argument(
        "--json",
        action="store_true",
        help="Emite eventos de progresso em JSONL no stdout (para o app desktop)",
    )
    return parser


def _recording_start(raw: str) -> datetime | None:
    """Momento em que a gravacao comecou, informado por quem chamou.

    O app passa este valor quando ele mesmo gravou a reuniao: ali a hora certa
    e a do inicio da gravacao, e nao a que o arquivo carrega. O arquivo so
    ganha data quando e fechado — no fim da reuniao —, e numa reuniao de uma
    hora isso e uma hora de diferenca. Valor ilegivel nao derruba a
    transcricao: cai no que o arquivo disser, como antes.
    """
    texto = (raw or "").strip()
    if not texto:
        return None
    try:
        return datetime.fromisoformat(texto)
    except ValueError:
        logging.getLogger(__name__).warning(
            "--recorded-at ignorado: %r nao e uma data ISO 8601", texto
        )
        return None


def _run_transcribe(args: argparse.Namespace, config: Settings) -> int:
    """Transcreve um vídeo e grava os arquivos na pasta de saída.

    Caminho curto e independente do vault: áudio -> Whisper -> arquivos.
    """
    from .audio import extract_audio
    from .events import EventEmitter
    from .media_info import probe_media, to_utc_iso
    from .transcriber import WhisperTranscriber
    from .transcript_export import FORMATS, export

    events = EventEmitter(enabled=args.json)
    logger = logging.getLogger(__name__)

    video_path = Path(args.file).expanduser()
    if not video_path.exists():
        message = f"Arquivo nao encontrado: {video_path}"
        logger.error(message)
        events.error(message)
        return 1

    formats = [f.strip().lower() for f in args.formats.split(",") if f.strip()]
    invalid = [f for f in formats if f not in FORMATS]
    if not formats or invalid:
        message = (
            f"Formato invalido: {', '.join(invalid) or '(vazio)'}. "
            f"Validos: {', '.join(FORMATS)}."
        )
        logger.error(message)
        events.error(message)
        return 1

    output_dir = Path(args.output_dir).expanduser() if args.output_dir else video_path.parent

    # Overrides pontuais desta execução (a UI escolhe o modelo).
    if args.model:
        config.whisper_model = args.model
    if args.language:
        config.whisper_language = args.language

    events.start(str(video_path), str(output_dir))
    started = time.time()
    audio_path: Path | None = None

    try:
        # Data da gravação vem do próprio vídeo — é quando a reunião aconteceu,
        # não quando ela foi transcrita.
        media = probe_media(video_path)
        # O inicio informado manda: quem gravou sabe a hora melhor do que o
        # arquivo, que so e datado quando a reuniao ja acabou.
        inicio = _recording_start(getattr(args, "recorded_at", ""))
        recorded_at = inicio or media.recorded_at
        date_source = (
            "gravacao" if inicio else ("arquivo" if media.date_from_filesystem else "video")
        )
        events.stage(
            "audio",
            "Extraindo audio",
            0,
            f"Gravado em {recorded_at.strftime('%d/%m/%Y %H:%M')}",
        )
        logger.info("Extraindo audio de %s...", video_path.name)
        audio_path = extract_audio(video_path, config)
        events.stage("audio", "Extraindo audio", 100, f"{audio_path.stat().st_size / 1_048_576:.1f} MB")

        # Com whisper.cpp o que vale é o arquivo .bin, não o nome do modelo.
        model_label = (
            Path(config.whisper_model_path).stem.replace("ggml-", "")
            if config.whisper_model_path
            else config.whisper_model
        )
        events.stage("transcription", "Transcrevendo", 0, f"Modelo: {model_label}")

        def on_progress(pct: int, detail: str = "") -> None:
            events.stage("transcription", "Transcrevendo", pct, detail)

        transcriber = WhisperTranscriber(config)
        transcript = transcriber.transcribe(audio_path, progress_callback=on_progress)

        events.stage("export", "Gravando arquivos", 0, str(output_dir))
        written = export(
            transcript,
            output_dir,
            video_path.name,
            formats,
            name=args.name,
            metadata={
                "recorded_at": to_utc_iso(recorded_at),
                "recorded_at_local": recorded_at,
                "date_source": date_source,
                "video_duration_seconds": round(media.duration, 2),
                "model": model_label,
            },
        )
        events.stage("export", "Gravando arquivos", 100, f"{len(written)} arquivo(s)")

        elapsed = time.time() - started
        events.done(
            files=[str(p) for p in written],
            segments=len(transcript.segments),
            duration=transcript.duration,
            elapsed=elapsed,
        )
        if not args.json:
            print("\nTranscricao concluida!")
            for path in written:
                print(f"  {path}")
            print(f"  Segmentos: {len(transcript.segments)}")
            print(f"  Tempo: {elapsed:.1f}s")
        logger.info("Transcricao concluida em %.1fs", elapsed)
        return 0

    except Exception as e:
        logger.exception("Erro ao transcrever %s", video_path.name)
        events.error(str(e))
        return 1

    finally:
        if config.cleanup_temp and audio_path is not None and audio_path.exists():
            audio_path.unlink()


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command != "transcribe":
        parser.print_help()
        sys.exit(2)

    config = load_config()
    # No modo --json o stdout é reservado aos eventos; o log vai para stderr.
    setup_logging(config.log_level, stream=sys.stderr if args.json else sys.stdout)
    sys.exit(_run_transcribe(args, config))


if __name__ == "__main__":
    main()

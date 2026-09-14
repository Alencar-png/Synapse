"""Exportação da transcrição para arquivos avulsos, fora do vault.

Usado pelo comando ``transcribe`` (e pelo app desktop), que grava numa pasta
escolhida pelo usuário em vez da estrutura do Obsidian.
"""

from __future__ import annotations

import json
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

from .models import SPEAKER_LABELS, SPEAKER_MIC, SPEAKER_SYSTEM, Transcript, speaker_label
from .utils import atomic_write_text, format_duration, format_timestamp

# Formatos suportados, na ordem em que são gravados.
FORMATS = ("md", "txt")

# Metadados estruturados da reunião, lidos pelo app desktop.
METADATA_FILE = "meeting.json"

# Caracteres proibidos em nome de arquivo no Windows (e problemáticos no resto).
_INVALID_CHARS = '<>:"/\\|?*'

# Extensões descartadas do nome da reunião. A lista é fechada de propósito:
# cortar tudo depois do último ponto transformava o nome "Daily - IRM -
# 2026-08-19 às 10.18.33" em "... às 10.18", comendo o final do que o usuário
# escreveu — o ponto ali era da hora, não de uma extensão.
_MEDIA_EXTENSIONS = frozenset((
    "mkv", "mp4", "mov", "webm", "avi", "m4v", "wmv", "flv",
    "mp3", "wav", "m4a", "aac", "ogg", "flac",
    "md", "txt", "json",
))


def safe_stem(name: str) -> str:
    """Transforma o nome do vídeo num nome de arquivo seguro.

    Descarta qualquer diretório no caminho (nos dois separadores, para o nome
    vindo de outro SO — o container é Linux e a UI é Windows) e a extensão,
    quando ela é de um formato conhecido.

    O nome é normalizado para NFC porque gravações do macOS chegam com os
    acentos decompostos (``a`` + acento combinante). O NTFS guarda os dois
    como nomes distintos, e ferramentas que normalizam para NFC ao escrever
    (o Claude Code, entre elas) acabam criando um arquivo que o programa que
    pediu a escrita não consegue mais encontrar.
    """
    base = unicodedata.normalize("NFC", name).replace("\\", "/").rsplit("/", 1)[-1]
    head, ponto, tail = base.rpartition(".")
    stem = head if ponto and tail.lower() in _MEDIA_EXTENSIONS else base
    for ch in _INVALID_CHARS:
        stem = stem.replace(ch, "-")
    stem = " ".join(stem.split())  # colapsa espaços e quebras
    return stem[:120] or "transcricao"


def unique_path(directory: Path, stem: str, suffix: str) -> Path:
    """Devolve um caminho livre em ``directory``, numerando se já existir.

    Evita sobrescrever silenciosamente a transcrição de um vídeo homônimo
    processado antes.
    """
    candidate = directory / f"{stem}.{suffix}"
    counter = 2
    while candidate.exists():
        candidate = directory / f"{stem} ({counter}).{suffix}"
        counter += 1
    return candidate


def to_markdown(
    transcript: Transcript,
    title: str,
    source_file: str = "",
    recorded_at: datetime | None = None,
) -> str:
    """Transcrição em Markdown com timestamps (mesmo formato do vault)."""
    lines = [f"# {title}", ""]
    if recorded_at is not None:
        lines.append(f"**Gravado em:** {recorded_at.strftime('%d/%m/%Y às %H:%M')}  ")
    lines.extend([
        f"**Duracao:** {format_duration(transcript.duration)}  ",
        f"**Idioma:** {transcript.language}  ",
    ])
    if source_file:
        lines.append(f"**Arquivo:** {source_file}  ")
    if transcript.has_speakers:
        lines.append(
            "**Falantes:** separados pelo canal de áudio — "
            f"*{SPEAKER_LABELS[SPEAKER_MIC]}* é o microfone desta máquina, "
            f"*{SPEAKER_LABELS[SPEAKER_SYSTEM]}* é o som que veio da chamada.  "
        )
    lines.extend(["", "---", ""])
    for seg in transcript.segments:
        quem = speaker_label(seg.speaker)
        # O falante entra antes do texto e depois do tempo, como numa peça: é
        # onde quem lê procura, e é a forma que o modelo entende sem explicação
        # quando a transcrição vira análise.
        marca = format_timestamp(seg.start)
        prefixo = f"**[{marca}] {quem}:**" if quem else f"**[{marca}]**"
        lines.append(f"{prefixo} {seg.text}  ")
    return "\n".join(lines) + "\n"


def to_txt(transcript: Transcript) -> str:
    """Transcrição em texto corrido, uma fala por linha e sem marcação."""
    if transcript.segments:
        linhas = []
        for seg in transcript.segments:
            quem = speaker_label(seg.speaker)
            linhas.append(f"{quem}: {seg.text}" if quem else seg.text)
        return "\n".join(linhas) + "\n"
    return (transcript.full_text or "") + "\n"


def meeting_dir(output_dir: Path, source_file: str) -> Path:
    """Pasta da reunião dentro de ``output_dir``, com nome livre de colisão.

    Cada reunião fica numa pasta própria — transcrição e documentos gerados
    depois (tarefas, resumo) moram juntos, em vez de se misturarem com os de
    outras reuniões numa pasta só.
    """
    output_dir = Path(output_dir)
    stem = safe_stem(source_file)

    candidate = output_dir / stem
    counter = 2
    while candidate.exists():
        candidate = output_dir / f"{stem} ({counter})"
        counter += 1
    return candidate


def export(
    transcript: Transcript,
    output_dir: Path,
    source_file: str,
    formats: tuple[str, ...] | list[str] = FORMATS,
    name: str = "",
    metadata: dict[str, Any] | None = None,
) -> list[Path]:
    """Grava a transcrição numa pasta própria dentro de ``output_dir``.

    Todos os formatos compartilham o nome da pasta, para os arquivos da mesma
    reunião nunca ficarem descasados. Junto vai um ``meeting.json`` com os
    metadados — data da gravação, duração, modelo — que a interface lê sem
    precisar interpretar o Markdown.

    Args:
        name: nome escolhido para a reunião. Vazio usa o nome do arquivo.
        metadata: campos extras gravados no ``meeting.json``.

    Returns:
        Caminhos dos arquivos gravados, na ordem de ``formats``.
    """
    invalid = [f for f in formats if f not in FORMATS]
    if invalid:
        raise ValueError(
            f"Formato não suportado: {invalid[0]!r}. Válidos: {', '.join(FORMATS)}."
        )

    target = meeting_dir(output_dir, name or source_file)
    target.mkdir(parents=True, exist_ok=True)
    folder = target.name

    meta = dict(metadata or {})
    recorded_at = meta.get("recorded_at_local")
    recorded_dt = None
    if isinstance(recorded_at, datetime):
        recorded_dt = recorded_at
        meta["recorded_at_local"] = recorded_at.strftime("%Y-%m-%d %H:%M:%S")

    written: list[Path] = []
    for fmt in formats:
        path = target / f"{folder}.{fmt}"
        content = (
            to_markdown(transcript, folder, source_file, recorded_dt)
            if fmt == "md"
            else to_txt(transcript)
        )
        atomic_write_text(path, content)
        written.append(path)

    meta.update({
        "name": folder,
        "source_file": source_file,
        "duration_seconds": round(transcript.duration, 2),
        "segments": len(transcript.segments),
        "language": transcript.language,
        "transcribed_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "files": [p.name for p in written],
    })
    atomic_write_text(
        target / METADATA_FILE,
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
    )

    return written

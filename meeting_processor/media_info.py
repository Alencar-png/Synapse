"""Metadados do arquivo de mídia (data da gravação e duração).

A data em que a reunião aconteceu é uma informação do vídeo, não do momento
em que ele foi transcrito — por isso vem do próprio arquivo.
"""

from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

# Tags de data usadas pelos gravadores mais comuns (OBS, celulares, câmeras).
_DATE_TAGS = ("creation_time", "com.apple.quicktime.creationdate", "date")

# Ler metadados é instantâneo; um minuto só existe para o caso de o arquivo
# estar num disco de rede que parou de responder.
PROBE_TIMEOUT_SECONDS = 60


@dataclass(frozen=True)
class MediaInfo:
    """Duração em segundos e quando a gravação foi feita."""

    duration: float
    recorded_at: datetime
    # True quando a data veio do arquivo em disco, não das tags do vídeo.
    date_from_filesystem: bool


def _parse_date(raw: str) -> datetime | None:
    """Converte a data do ffprobe (normalmente ISO em UTC) para hora local."""
    text = (raw or "").strip().replace("Z", "+00:00")
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        return parsed.astimezone().replace(tzinfo=None)
    return parsed


def probe_media(path: Path) -> MediaInfo:
    """Lê duração e data de gravação com ffprobe.

    Cai para a data de modificação do arquivo quando o vídeo não traz a tag —
    gravações reencodadas e alguns formatos perdem essa informação.
    """
    path = Path(path)
    duration = 0.0
    recorded: datetime | None = None

    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-show_entries", "format=duration:format_tags",
                "-of", "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
            timeout=PROBE_TIMEOUT_SECONDS,
        )
        data = json.loads(result.stdout or "{}").get("format", {})
        duration = float(data.get("duration") or 0.0)
        tags = {k.lower(): v for k, v in (data.get("tags") or {}).items()}
        for tag in _DATE_TAGS:
            if tag in tags:
                recorded = _parse_date(tags[tag])
                if recorded:
                    break
    except (subprocess.SubprocessError, ValueError, json.JSONDecodeError, OSError):
        logger.debug("ffprobe nao retornou metadados de %s", path.name, exc_info=True)

    if recorded is None:
        try:
            recorded = datetime.fromtimestamp(path.stat().st_mtime)
        except OSError:
            recorded = datetime.now()
        return MediaInfo(duration=duration, recorded_at=recorded, date_from_filesystem=True)

    return MediaInfo(duration=duration, recorded_at=recorded, date_from_filesystem=False)


def to_utc_iso(moment: datetime) -> str:
    """ISO 8601 em UTC — formato estável para guardar em arquivo."""
    return moment.astimezone(UTC).isoformat(timespec="seconds")

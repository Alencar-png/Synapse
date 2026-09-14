"""Limpeza das alucinações típicas do Whisper na transcrição.

Em trechos de silêncio ou ruído o Whisper inventa texto — e inventa sempre o
mesmo: "Tchau." quinze vezes seguidas enquanto a sala espera gente entrar, um
"Obrigado." solto no segundo zero antes de alguém falar, "Legendas pela
comunidade Amara.org". O VAD (detecção de voz) evita a maior parte disso
antes de o modelo ver o áudio; o que passa, esta etapa apanha depois.

Duas regras, ambas conservadoras para não apagar fala real:

- **Repetição em série**: três ou mais segmentos consecutivos com o mesmo
  texto viram um só. Duas repetições ficam — "Tchau. Tchau." no fim de uma
  reunião é gente se despedindo.
- **Frase-fantasma isolada**: um segmento cujo texto é uma alucinação
  conhecida e que está cercado de silêncio (nada por vários segundos antes e
  depois, ou nas pontas da gravação) é removido. A mesma frase no meio de
  uma conversa fica.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass

from .models import TranscriptSegment

logger = logging.getLogger(__name__)

# Quantos segmentos iguais em sequência configuram alucinação.
REPEAT_THRESHOLD = 3

# Silêncio mínimo em volta de uma frase-fantasma para ela ser descartada.
ISOLATION_GAP_SECONDS = 5.0

# Frases que o Whisper produz do nada em áudio sem fala. Comparadas depois de
# normalizar (minúsculas, sem acento, sem pontuação).
KNOWN_HALLUCINATIONS = frozenset(
    {
        "obrigado",
        "obrigada",
        "tchau",
        "tchau tchau",
        "ate mais",
        "ate a proxima",
        "legendas pela comunidade amaraorg",
        "legendas pela comunidade amara org",
        "amaraorg",
        "amara org",
        "inscreva se no canal",
        "inscrevase no canal",
        "obrigado por assistir",
        "musica",
        "aplausos",
    }
)

_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize(text: str) -> str:
    """Forma canônica para comparar segmentos: minúsculo, sem acento nem pontuação."""
    sem_acento = unicodedata.normalize("NFKD", text)
    sem_acento = "".join(ch for ch in sem_acento if not unicodedata.combining(ch))
    return " ".join(_PUNCT_RE.sub(" ", sem_acento.lower()).split())


@dataclass(frozen=True)
class CleanupReport:
    """O que a limpeza fez, para o log e para a interface."""

    repeats_removed: int = 0
    phantoms_removed: int = 0

    @property
    def total(self) -> int:
        return self.repeats_removed + self.phantoms_removed

    def describe(self) -> str:
        partes = []
        if self.repeats_removed:
            partes.append(f"{self.repeats_removed} repetição(ões)")
        if self.phantoms_removed:
            partes.append(f"{self.phantoms_removed} frase(s)-fantasma")
        return f"limpeza: {' e '.join(partes)} removida(s)" if partes else ""


def collapse_repeats(
    segments: list[TranscriptSegment], threshold: int = REPEAT_THRESHOLD
) -> tuple[list[TranscriptSegment], int]:
    """Reduz séries de ``threshold`` ou mais segmentos iguais a um só.

    O segmento que fica é o primeiro da série, com o fim estendido até o fim
    da série — o intervalo de tempo continua coberto.
    """
    saida: list[TranscriptSegment] = []
    removidos = 0
    i = 0
    while i < len(segments):
        chave = normalize(segments[i].text)
        j = i + 1
        while j < len(segments) and normalize(segments[j].text) == chave:
            j += 1
        tamanho = j - i
        if chave and tamanho >= threshold:
            primeiro = segments[i]
            saida.append(primeiro.model_copy(update={"end": max(primeiro.end, segments[j - 1].end)}))
            removidos += tamanho - 1
        else:
            saida.extend(segments[i:j])
        i = j
    return saida, removidos


def drop_isolated_phantoms(
    segments: list[TranscriptSegment], gap: float = ISOLATION_GAP_SECONDS
) -> tuple[list[TranscriptSegment], int]:
    """Remove frases-fantasma conhecidas cercadas de silêncio.

    "Cercada" quer dizer: nenhum outro segmento a menos de ``gap`` segundos
    antes **e** depois (ou a borda da gravação). Assim "Obrigado." dito no
    meio da conversa fica; "Obrigado." sozinho em trinta segundos de nada sai.
    """
    saida: list[TranscriptSegment] = []
    removidos = 0
    for idx, seg in enumerate(segments):
        if normalize(seg.text) in KNOWN_HALLUCINATIONS:
            antes = segments[idx - 1].end if idx > 0 else None
            depois = segments[idx + 1].start if idx + 1 < len(segments) else None
            isolado_antes = antes is None or seg.start - antes >= gap
            isolado_depois = depois is None or depois - seg.end >= gap
            if isolado_antes and isolado_depois:
                removidos += 1
                continue
        saida.append(seg)
    return saida, removidos


def drop_useless_speakers(
    segments: list[TranscriptSegment],
) -> tuple[list[TranscriptSegment], bool]:
    """Apaga a marcação de falante quando ela não separou nada.

    A diarização compara a energia dos dois canais. Quando eles trazem a mesma
    coisa — um arquivo estéreo cujas fontes já vieram somadas nos dois lados, o
    caso de uma gravação do OBS com faixa de áudio única — a comparação empata
    em todo trecho e o whisper responde ``?`` sempre.

    Ter dois canais, portanto, não garante que haja dois lados. O sinal de que
    houve separação de verdade é algum trecho atribuído a um lado; sem nenhum,
    a marcação inteira é ruído e sai. "Sobreposição" escrito ao lado de cada
    linha da reunião é pior do que linha nenhuma marcada.

    Devolve os segmentos e se a marcação foi descartada.
    """
    if not any(seg.speaker for seg in segments):
        return segments, False
    if any(seg.speaker in ("0", "1") for seg in segments):
        return segments, False
    return [seg.model_copy(update={"speaker": ""}) for seg in segments], True


def clean_segments(segments: list[TranscriptSegment]) -> tuple[list[TranscriptSegment], CleanupReport]:
    """Aplica as duas regras, na ordem: repetições primeiro, fantasmas depois.

    A ordem importa: uma série de quinze "Tchau." vira um "Tchau." isolado —
    e aí a segunda regra o reconhece e remove.
    """
    sem_repeticao, repeats = collapse_repeats(segments)
    limpo, phantoms = drop_isolated_phantoms(sem_repeticao)
    final, sem_falantes = drop_useless_speakers(limpo)
    if sem_falantes:
        logger.info(
            "Diarização sem resultado: os dois canais trazem o mesmo áudio. "
            "Transcrição sem marcação de falante."
        )
    return final, CleanupReport(repeats_removed=repeats, phantoms_removed=phantoms)

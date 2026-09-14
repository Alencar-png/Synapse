"""Modelos de dados da transcrição."""

from pydantic import BaseModel

# Quem falou, quando a diarização por canal está ligada.
#
# O whisper.cpp compara a energia dos dois canais do áudio em cada trecho e
# devolve "0" (esquerda), "1" (direita) ou "?" (empate — as duas fontes falando
# juntas, ou silêncio nas duas). O app grava o microfone à esquerda e o som do
# sistema à direita, então "0" é quem está na máquina e "1" é o resto da sala.
SPEAKER_MIC = "0"
SPEAKER_SYSTEM = "1"
SPEAKER_UNKNOWN = "?"

# Como cada um aparece na transcrição escrita.
SPEAKER_LABELS = {
    SPEAKER_MIC: "Você",
    SPEAKER_SYSTEM: "Participantes",
    SPEAKER_UNKNOWN: "Sobreposição",
}


def speaker_label(speaker: str) -> str:
    """Nome legível do falante, ou string vazia quando não houve diarização."""
    return SPEAKER_LABELS.get(speaker or "", "")


class TranscriptSegment(BaseModel):
    start: float
    end: float
    text: str
    # Vazio quando a transcrição rodou sem diarização, que é o padrão.
    speaker: str = ""


class Transcript(BaseModel):
    segments: list[TranscriptSegment]
    full_text: str
    language: str
    duration: float

    @property
    def has_speakers(self) -> bool:
        """Se algum trecho foi atribuído a uma fonte de áudio."""
        return any(s.speaker for s in self.segments)

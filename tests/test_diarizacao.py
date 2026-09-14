"""Quem falou: a separação por canal de áudio, do comando à transcrição escrita.

O whisper.cpp não identifica pessoas — ele compara a energia dos dois canais e
diz de qual lado veio cada trecho. O app grava o microfone à esquerda e o som
da chamada à direita, e é isso que transforma um detalhe técnico em "eu disse"
contra "eles disseram".

A cadeia toda depende de duas coisas que não dão erro quando faltam: o áudio
precisa chegar em estéreo (mono não tem lados) e o comando precisa levar
``--diarize``. Sem uma delas a transcrição sai normal, só sem falante nenhum —
por isso as duas são afirmadas aqui.
"""

from __future__ import annotations

from pathlib import Path

from meeting_processor.cleanup import clean_segments, drop_useless_speakers
from meeting_processor.models import (
    SPEAKER_MIC,
    SPEAKER_SYSTEM,
    SPEAKER_UNKNOWN,
    Transcript,
    TranscriptSegment,
    speaker_label,
)
from meeting_processor.transcriber import build_cpp_command
from meeting_processor.transcript_export import to_markdown, to_txt

CLI = Path("C:/app/.whisper-cpp/whisper-cli.exe")
MODELO = Path("C:/app/.models/ggml-large-v3.bin")
AUDIO = Path("C:/tmp/reuniao.wav")


def comando(config, **kwargs):
    base = {"cli": CLI, "model": MODELO, "audio_path": AUDIO, "threads": 12, "device": "auto"}
    return build_cpp_command(config=config, **{**base, **kwargs})


class TestComandoDoWhisper:
    def test_sem_diarizacao_o_comando_nao_leva_a_flag(self, tmp_config):
        assert "--diarize" not in comando(tmp_config)

    def test_com_diarizacao_a_flag_entra(self, tmp_config):
        assert "--diarize" in comando(tmp_config, diarize=True)

    def test_o_essencial_esta_sempre_la(self, tmp_config):
        cmd = comando(tmp_config)
        assert cmd[0] == str(CLI)
        assert cmd[cmd.index("-m") + 1] == str(MODELO)
        assert cmd[cmd.index("-f") + 1] == str(AUDIO)
        assert cmd[cmd.index("-l") + 1] == tmp_config.whisper_language
        assert "-oj" in cmd
        # Sem -t explícito o whisper.cpp usa 4 threads em qualquer CPU.
        assert cmd[cmd.index("-t") + 1] == "12"

    def test_device_cpu_desliga_a_gpu(self, tmp_config):
        assert "--no-gpu" in comando(tmp_config, device="cpu")
        assert "--no-gpu" not in comando(tmp_config, device="auto")

    def test_vad_entra_com_o_modelo_silero(self, tmp_config):
        silero = Path("C:/app/.models/ggml-silero-v5.1.2.bin")
        cmd = comando(tmp_config, vad_model=silero)
        assert cmd[cmd.index("--vad-model") + 1] == str(silero)

    def test_vad_e_diarizacao_convivem(self, tmp_config):
        # Os tempos que o whisper devolve são sempre os do áudio original,
        # então o falante continua casando com o trecho certo.
        cmd = comando(
            tmp_config, diarize=True, vad_model=Path("C:/app/.models/ggml-silero-v5.1.2.bin")
        )
        assert "--diarize" in cmd
        assert "--vad" in cmd

    def test_progresso_so_quando_alguem_escuta(self, tmp_config):
        assert "--print-progress" in comando(tmp_config, with_progress=True)
        assert "--print-progress" not in comando(tmp_config, with_progress=False)


class TestExtracaoDeAudio:
    """O ffmpeg precisa parar de rebaixar o áudio para mono."""

    @staticmethod
    def _canais(config, monkeypatch, canais_na_origem: int = 2) -> str:
        """Roda extract_audio com o ffmpeg de mentira e devolve o `-ac` usado."""
        from meeting_processor import audio

        capturado: dict[str, list[str]] = {}

        def fake_run(cmd, **kwargs):
            capturado["cmd"] = cmd
            # O ffmpeg de verdade deixa o arquivo no disco, e extract_audio
            # mede o tamanho dele no fim.
            Path(cmd[-1]).write_bytes(b"\0" * 64)
            return type("R", (), {"stderr": "", "stdout": "", "returncode": 0})()

        monkeypatch.setattr(audio, "validate_ffmpeg", lambda: True)
        monkeypatch.setattr(audio, "audio_channels", lambda _p: canais_na_origem)
        monkeypatch.setattr(audio.subprocess, "run", fake_run)

        audio.extract_audio(Path("C:/videos/reuniao.mp4"), config)
        cmd = capturado["cmd"]
        return cmd[cmd.index("-ac") + 1]

    def test_padrao_continua_mono(self, tmp_config, monkeypatch):
        assert self._canais(tmp_config, monkeypatch) == "1"

    def test_com_diarizacao_sai_estereo(self, tmp_config, monkeypatch):
        config = tmp_config.model_copy(update={"whisper_diarize": True})
        assert self._canais(config, monkeypatch) == "2"

    def test_origem_mono_nao_vira_estereo_artificial(self, tmp_config, monkeypatch):
        # Duplicar um canal daria dois lados idênticos: o whisper responderia
        # "?" em toda fala, e a transcrição sairia marcada de inútil.
        config = tmp_config.model_copy(update={"whisper_diarize": True})
        assert self._canais(config, monkeypatch, canais_na_origem=1) == "1"


class TestTranscricaoEscrita:
    @staticmethod
    def _com_falantes() -> Transcript:
        segments = [
            TranscriptSegment(start=0.0, end=3.0, text="Bom dia, pessoal.", speaker=SPEAKER_MIC),
            TranscriptSegment(
                start=3.0, end=8.0, text="Fica pronto na sexta.", speaker=SPEAKER_SYSTEM
            ),
            TranscriptSegment(start=8.0, end=9.0, text="Isso.", speaker=SPEAKER_UNKNOWN),
        ]
        return Transcript(
            segments=segments,
            full_text=" ".join(s.text for s in segments),
            language="pt",
            duration=9.0,
        )

    def test_markdown_nomeia_quem_falou(self):
        texto = to_markdown(self._com_falantes(), "Reunião")
        assert "Você:** Bom dia, pessoal." in texto
        assert "Participantes:** Fica pronto na sexta." in texto
        # O cabeçalho explica de onde vem a separação: sem isso, "Você" e
        # "Participantes" parecem nomes que alguém escolheu.
        assert "canal de áudio" in texto

    def test_txt_nomeia_quem_falou(self):
        assert to_txt(self._com_falantes()).startswith("Você: Bom dia, pessoal.")

    def test_sem_diarizacao_nada_muda(self, sample_transcript):
        texto = to_markdown(sample_transcript, "Reunião")
        assert "Falantes:" not in texto
        assert ":**" not in texto.split("---")[1]
        assert to_txt(sample_transcript).startswith("Bom dia a todos.")

    def test_has_speakers_so_vale_quando_ha_marcacao(self, sample_transcript):
        assert sample_transcript.has_speakers is False
        assert self._com_falantes().has_speakers is True

    def test_rotulo_desconhecido_nao_inventa_nome(self):
        assert speaker_label("") == ""
        assert speaker_label("7") == ""
        assert speaker_label(SPEAKER_UNKNOWN) == "Sobreposição"


class TestMarcacaoInutil:
    """Dois canais não garantem dois lados.

    O caso real: uma gravação do OBS com faixa de áudio única sai em estéreo,
    mas com o microfone e o som da máquina já somados nos dois lados. A
    comparação de energia empata em todo trecho, o whisper responde "?" sempre,
    e a transcrição sairia com "Sobreposição" ao lado de cada linha.
    """

    @staticmethod
    def _seg(texto, speaker, i=0):
        return TranscriptSegment(start=i * 2.0, end=i * 2.0 + 1.5, text=texto, speaker=speaker)

    def test_so_interrogacao_perde_a_marcacao(self):
        segments = [
            self._seg("Bom dia.", SPEAKER_UNKNOWN, 0),
            self._seg("Tudo certo.", SPEAKER_UNKNOWN, 1),
        ]
        limpos, descartou = drop_useless_speakers(segments)
        assert descartou is True
        assert all(s.speaker == "" for s in limpos)
        # O texto e os tempos ficam intactos: só a marcação sai.
        assert [s.text for s in limpos] == ["Bom dia.", "Tudo certo."]

    def test_um_lado_identificado_preserva_tudo(self):
        segments = [
            self._seg("Bom dia.", SPEAKER_MIC, 0),
            self._seg("(falando junto)", SPEAKER_UNKNOWN, 1),
        ]
        limpos, descartou = drop_useless_speakers(segments)
        assert descartou is False
        assert limpos[0].speaker == SPEAKER_MIC
        # "?" no meio de uma conversa separada é informação legítima.
        assert limpos[1].speaker == SPEAKER_UNKNOWN

    def test_transcricao_sem_diarizacao_passa_intacta(self):
        segments = [self._seg("Bom dia.", "", 0)]
        limpos, descartou = drop_useless_speakers(segments)
        assert descartou is False
        assert limpos[0].speaker == ""

    def test_a_limpeza_completa_aplica_a_regra(self):
        segments = [
            self._seg("Bom dia.", SPEAKER_UNKNOWN, 0),
            self._seg("Vamos começar.", SPEAKER_UNKNOWN, 1),
        ]
        limpos, _ = clean_segments(segments)
        assert all(s.speaker == "" for s in limpos)

"""Testes da transcrição: escolha de modelo e diagnóstico de erro do whisper.cpp."""

from pathlib import Path

from meeting_processor.transcriber import (
    model_rank,
    resolve_whisper_model,
    summarize_cli_error,
)

# stderr real do whisper.cpp: o relatório do device Vulkan vem antes do erro.
STDERR_VULKAN = "\n".join(
    [
        "ggml_vulkan: Found 1 Vulkan devices:",
        "ggml_vulkan: 0 = AMD Radeon RX 9060 XT (AMD proprietary driver) | uma: 0 | fp16: 1",
        r"error: input file not found 'C:\tmp\Gravacao.wav'",
        "error: no input files specified",
        "",
        "usage: whisper-cli.exe [options] file0 file1 ...",
    ]
)


def test_summarize_mostra_o_erro_e_nao_o_preambulo_da_gpu():
    resumo = summarize_cli_error(STDERR_VULKAN)
    assert "input file not found" in resumo
    assert "Vulkan devices" not in resumo


def test_summarize_cai_para_as_ultimas_linhas_sem_marcador_de_erro():
    resumo = summarize_cli_error("linha um\nlinha dois\nlinha tres\nlinha quatro")
    assert "linha quatro" in resumo
    assert "linha um" not in resumo


def test_summarize_com_stderr_vazio():
    assert summarize_cli_error("   \n  ") == "sem saída de erro"


def test_summarize_respeita_o_limite():
    resumo = summarize_cli_error("error: " + "x" * 500, limit=50)
    assert len(resumo) == 53  # 50 + "..."
    assert resumo.endswith("...")


class TestEscolhaDoModelo:
    """Qual .bin o motor pega quando a config não aponta nenhum.

    A resposta errada é silenciosa: a transcrição sai igual, só com mais erro
    de nome e de número. Ordem alfabética põe ``large-v3-turbo`` na frente de
    ``large-v3`` (o hífen vem antes do ponto), e é justamente o contrário do
    que se quer.
    """

    @staticmethod
    def _criar(models_dir, nome, mb=1):
        models_dir.mkdir(parents=True, exist_ok=True)
        (models_dir / nome).write_bytes(b"\0" * (mb * 1024 * 1024))

    def test_prefere_large_v3_ao_turbo(self, tmp_config):
        models = Path(tmp_config.project_root) / ".models"
        self._criar(models, "ggml-large-v3-turbo.bin", mb=2)
        self._criar(models, "ggml-large-v3.bin", mb=4)

        assert resolve_whisper_model(tmp_config).name == "ggml-large-v3.bin"

    def test_ignora_o_modelo_de_vad(self, tmp_config):
        models = Path(tmp_config.project_root) / ".models"
        self._criar(models, "ggml-silero-v5.1.2.bin")
        self._criar(models, "ggml-small.bin")

        assert resolve_whisper_model(tmp_config).name == "ggml-small.bin"

    def test_caminho_explicito_na_config_vence_a_preferencia(self, tmp_path, tmp_config):
        models = Path(tmp_config.project_root) / ".models"
        self._criar(models, "ggml-large-v3.bin")
        escolhido = tmp_path / "meu-modelo.bin"
        escolhido.write_bytes(b"\0")

        config = tmp_config.model_copy(update={"whisper_model_path": str(escolhido)})
        assert resolve_whisper_model(config) == escolhido

    def test_sem_modelo_nenhum_devolve_none(self, tmp_config):
        assert resolve_whisper_model(tmp_config) is None

    def test_rank_ordena_do_mais_fiel_ao_mais_leve(self):
        assert model_rank("ggml-large-v3.bin") < model_rank("ggml-large-v3-turbo.bin")
        assert model_rank("ggml-large-v3-turbo.bin") < model_rank("ggml-medium.bin")
        assert model_rank("ggml-medium.bin") < model_rank("ggml-tiny.bin")
        assert model_rank("ggml-tiny.bin") < model_rank("modelo-caseiro.bin")

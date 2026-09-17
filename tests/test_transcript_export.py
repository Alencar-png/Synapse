"""Testes da exportação de transcrição para pasta avulsa (comando transcribe)."""

from __future__ import annotations

import unicodedata

import pytest

from meeting_processor.transcript_export import export, safe_stem, to_markdown, to_txt


def test_safe_stem_remove_caracteres_invalidos():
    assert safe_stem('call: cliente | "2026".mp4') == "call- cliente - -2026-"


def test_safe_stem_descarta_o_diretorio_do_caminho():
    assert safe_stem(r"C:\Users\ana\Videos\reuniao.mkv") == "reuniao"
    assert safe_stem("/data/videos/reuniao.mkv") == "reuniao"


def test_safe_stem_usa_fallback_quando_nome_fica_vazio():
    assert safe_stem("///.mp4") == "transcricao"


def test_markdown_traz_timestamps_e_metadados(sample_transcript):
    md = to_markdown(sample_transcript, "reuniao", source_file="reuniao.mp4")

    assert md.startswith("# reuniao")
    assert "**Duracao:** 00:00:20" in md
    assert "**Arquivo:** reuniao.mp4" in md
    assert "**[00:00]** Bom dia a todos." in md
    assert "**[00:12]** A Ana fica responsavel pela API." in md


def test_txt_tem_so_o_texto(sample_transcript):
    txt = to_txt(sample_transcript)

    assert "[00:00]" not in txt
    assert txt.splitlines() == [
        "Bom dia a todos.",
        "Vamos falar do projeto.",
        "A Ana fica responsavel pela API.",
    ]


def test_export_cria_pasta_da_reuniao_com_md_e_txt(tmp_path, sample_transcript):
    written = export(sample_transcript, tmp_path / "saida", "reuniao.mp4", ["md", "txt"])

    pasta = tmp_path / "saida" / "reuniao"
    assert [p.parent for p in written] == [pasta, pasta]
    assert [p.name for p in written] == ["reuniao.md", "reuniao.txt"]
    assert all(p.exists() for p in written)
    assert "Bom dia a todos." in written[0].read_text(encoding="utf-8")


def test_export_nao_sobrescreve_reuniao_existente(tmp_path, sample_transcript):
    export(sample_transcript, tmp_path, "reuniao.mp4", ["md", "txt"])
    segunda = export(sample_transcript, tmp_path, "reuniao.mp4", ["md", "txt"])

    # A segunda reunião ganha pasta própria; a primeira fica intacta.
    assert segunda[0].parent.name == "reuniao (2)"
    assert [p.name for p in segunda] == ["reuniao (2).md", "reuniao (2).txt"]
    assert (tmp_path / "reuniao" / "reuniao.md").exists()


def test_export_cria_a_pasta_de_saida(tmp_path, sample_transcript):
    destino = tmp_path / "nova" / "pasta"

    export(sample_transcript, destino, "reuniao.mp4", ["txt"])

    assert (destino / "reuniao" / "reuniao.txt").exists()


def test_export_rejeita_formato_desconhecido(tmp_path, sample_transcript):
    with pytest.raises(ValueError, match="Formato não suportado"):
        export(sample_transcript, tmp_path, "reuniao.mp4", ["pdf"])


def test_safe_stem_compoe_acentos_decompostos():
    """Gravações do macOS chegam em NFD; o disco precisa receber NFC.

    Sem isso, o nome no disco fica com o acento separado da letra, e qualquer
    ferramenta que normalize ao gravar (o Claude Code, por exemplo) cria um
    arquivo que o app não encontra mais.
    """
    decomposto = unicodedata.normalize("NFD", "Daily - IRM - 2026-08-19 às 10.18")
    stem = safe_stem(decomposto)

    assert stem == unicodedata.normalize("NFC", "Daily - IRM - 2026-08-19 às 10.18")
    # A comparação acima passaria se as duas formas fossem iguais; não são.
    assert stem != decomposto
    assert stem == unicodedata.normalize("NFC", stem)


def test_export_grava_pasta_e_arquivos_em_nfc(tmp_path, sample_transcript):
    """A pasta e os arquivos da reunião nascem compostos, não decompostos."""
    nome = unicodedata.normalize("NFD", "Reunião às 10h")
    escritos = export(sample_transcript, tmp_path, "video.mp4", ("md",), name=nome)

    pasta = escritos[0].parent
    assert pasta.name == unicodedata.normalize("NFC", "Reunião às 10h")
    assert escritos[0].name == unicodedata.normalize("NFC", "Reunião às 10h.md")
    # E o arquivo é encontrável pelo caminho composto — o que o app usa.
    assert (tmp_path / "Reunião às 10h" / "Reunião às 10h.md").exists()


def test_safe_stem_preserva_ponto_que_nao_e_extensao():
    """O ponto da hora não é extensão: cortá-lo comia o final do nome."""
    assert safe_stem("Daily - IRM - 2026-08-19 as 10.18.33") == (
        "Daily - IRM - 2026-08-19 as 10.18.33"
    )
    assert safe_stem("v1.2 do produto") == "v1.2 do produto"


def test_safe_stem_ainda_remove_extensao_de_midia():
    assert safe_stem("Gravacao de Tela as 10.18.33.mov") == "Gravacao de Tela as 10.18.33"
    assert safe_stem("reuniao.MKV") == "reuniao"


def test_recording_start_le_iso_local_e_ignora_lixo():
    """O app informa quando a gravação começou; o que não for data é ignorado.

    Uma data ilegível não pode derrubar a transcrição: o pipeline volta a ler
    a data do próprio arquivo, que é o comportamento de sempre.
    """
    from datetime import datetime

    from meeting_processor.__main__ import _recording_start

    assert _recording_start("2026-09-16T14:30:00") == datetime(2026, 9, 16, 14, 30)
    assert _recording_start("  2026-09-16T14:30:00  ") == datetime(2026, 9, 16, 14, 30)
    assert _recording_start("") is None
    assert _recording_start("ontem de tarde") is None
    assert _recording_start(None) is None

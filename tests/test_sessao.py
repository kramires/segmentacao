import numpy as np
import pytest

from segmentacao.sessao import LIMITE_DESFAZER, Sessao


def _segmentar_falso(img, caixas, pontos):
    """Marca o interior das caixas e um quadrado 5x5 em cada ponto positivo."""
    m = np.zeros(img.shape[:2], dtype=bool)
    for x1, y1, x2, y2 in caixas:
        m[int(y1) : int(y2), int(x1) : int(x2)] = True
    for x, y, rotulo in pontos:
        if rotulo:
            m[int(y) - 2 : int(y) + 3, int(x) - 2 : int(x) + 3] = True
    return m


@pytest.fixture
def sessao():
    return Sessao(np.zeros((100, 200, 3), dtype=np.uint8))


def test_sessao_nova_esta_vazia(sessao):
    assert sessao.vazia
    assert not sessao.mascara().any()


def test_caixa_e_normalizada_e_limitada(sessao):
    sessao.aplicar({"tipo": "caixa", "x1": 500, "y1": 60, "x2": 150, "y2": -10}, _segmentar_falso)
    assert sessao.caixas == [[150.0, 0.0, 199.0, 60.0]]
    assert sessao.mascara()[30, 170] == 255
    assert sessao.versao == 1


def test_caixa_degenerada_e_ignorada(sessao):
    sessao.aplicar({"tipo": "caixa", "x1": 10, "y1": 10, "x2": 10.5, "y2": 40}, _segmentar_falso)
    assert sessao.vazia and sessao.versao == 0 and not sessao.historico


def test_pincel_e_borracha_tem_a_ultima_palavra(sessao):
    sessao.aplicar({"tipo": "caixa", "x1": 20, "y1": 20, "x2": 80, "y2": 80}, _segmentar_falso)
    sessao.aplicar(
        {"tipo": "traco", "modo": "mais", "raio": 5, "pts": [[120, 50], [160, 50]]},
        _segmentar_falso,
    )
    sessao.aplicar({"tipo": "traco", "modo": "menos", "raio": 5, "pts": [[50, 50]]}, None)
    m = sessao.mascara()
    assert m[50, 140] == 255, "o traço do pincel entra na seleção"
    assert m[50, 50] == 0, "a borracha abre um furo no que o modelo marcou"
    assert m[25, 25] == 255, "o resto da caixa continua selecionado"
    # Pintar de novo por cima da borracha volta a incluir.
    sessao.aplicar({"tipo": "traco", "modo": "mais", "raio": 5, "pts": [[50, 50]]}, None)
    assert sessao.mascara()[50, 50] == 255


def test_pintura_sobrevive_a_novo_ponto(sessao):
    sessao.aplicar({"tipo": "traco", "modo": "mais", "raio": 4, "pts": [[30, 30]]}, None)
    sessao.aplicar({"tipo": "ponto", "x": 150, "y": 60, "rotulo": 1}, _segmentar_falso)
    m = sessao.mascara()
    assert m[30, 30] == 255 and m[60, 150] == 255


def test_desfazer_volta_um_passo_de_cada_vez(sessao):
    sessao.aplicar({"tipo": "caixa", "x1": 20, "y1": 20, "x2": 80, "y2": 80}, _segmentar_falso)
    sessao.aplicar({"tipo": "traco", "modo": "menos", "raio": 5, "pts": [[50, 50]]}, None)
    assert sessao.mascara()[50, 50] == 0
    sessao.aplicar({"tipo": "desfazer"}, None)
    assert sessao.mascara()[50, 50] == 255
    sessao.aplicar({"tipo": "desfazer"}, None)
    assert sessao.vazia and not sessao.mascara().any()
    sessao.aplicar({"tipo": "desfazer"}, None)  # sem histórico: não quebra


def test_limpar_pode_ser_desfeito(sessao):
    sessao.aplicar({"tipo": "ponto", "x": 50, "y": 50, "rotulo": 1}, _segmentar_falso)
    sessao.aplicar({"tipo": "limpar"}, None)
    assert sessao.vazia
    sessao.aplicar({"tipo": "desfazer"}, None)
    assert sessao.pontos == [[50.0, 50.0, 1]] and sessao.mascara()[50, 50] == 255


def test_historico_tem_limite(sessao):
    for i in range(LIMITE_DESFAZER + 10):
        sessao.aplicar({"tipo": "traco", "modo": "mais", "raio": 2, "pts": [[i, 10]]}, None)
    assert len(sessao.historico) == LIMITE_DESFAZER


def test_expandir_aumenta_a_mascara(sessao):
    sessao.aplicar({"tipo": "caixa", "x1": 50, "y1": 30, "x2": 100, "y2": 60}, _segmentar_falso)
    antes = int((sessao.mascara() > 0).sum())
    sessao.expandir = 5
    assert (sessao.mascara() > 0).sum() > antes
    assert sessao.mascara()[27, 75] == 255


def test_acao_desconhecida(sessao):
    with pytest.raises(ValueError):
        sessao.aplicar({"tipo": "explodir"}, None)

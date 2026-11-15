import numpy as np

from segmentacao import operacoes as ops


def _mascara_retangulo(altura, largura, x1, y1, x2, y2):
    m = np.zeros((altura, largura), dtype=np.uint8)
    m[y1:y2, x1:x2] = 255
    return m


def _pinta_verde(img, masc):
    """Inpaint falso: pinta de verde onde a máscara manda, mantém o resto."""
    saida = img.copy()
    saida[masc > 0] = (0, 255, 0)
    return saida


def test_para_rgb_achata_transparencia_em_branco():
    rgba = np.zeros((2, 2, 4), dtype=np.uint8)
    rgba[0, 0] = (10, 20, 30, 255)
    rgb = ops.para_rgb(rgba)
    assert rgb.shape == (2, 2, 3)
    assert tuple(rgb[0, 0]) == (10, 20, 30)
    assert tuple(rgb[1, 1]) == (255, 255, 255)


def test_para_rgb_aceita_cinza():
    assert ops.para_rgb(np.full((3, 4), 7, dtype=np.uint8)).shape == (3, 4, 3)


def test_recortar_apara_ao_objeto():
    img = np.full((100, 200, 3), 90, dtype=np.uint8)
    recorte = ops.recortar(img, _mascara_retangulo(100, 200, 30, 20, 90, 60), suavizar=0)
    assert recorte.shape == (40, 60, 4)
    assert recorte[..., 3].min() == 255


def test_recortar_mascara_vazia():
    img = np.zeros((10, 10, 3), dtype=np.uint8)
    assert ops.recortar(img, np.zeros((10, 10), dtype=np.uint8)) is None


def test_remover_troca_o_objeto_e_preserva_o_resto():
    img = np.full((300, 400, 3), 200, dtype=np.uint8)
    img[100:150, 150:220] = (255, 0, 0)
    saida = ops.remover(img, _mascara_retangulo(300, 400, 150, 100, 220, 150), _pinta_verde)
    assert tuple(saida[125, 185]) == (0, 255, 0)
    assert not (saida[..., 0] == 255).any(), "sobrou pedaço do objeto"
    assert tuple(saida[10, 10]) == (200, 200, 200)
    assert tuple(saida[290, 390]) == (200, 200, 200)
    assert tuple(img[125, 185]) == (255, 0, 0), "a entrada não pode ser alterada"


def test_remover_reduz_imagem_grande_antes_do_modelo():
    tamanhos = []

    def espia(img, masc):
        tamanhos.append(img.shape[:2])
        assert img.shape[:2] == masc.shape
        return _pinta_verde(img, masc)

    img = np.full((2000, 3000, 3), 50, dtype=np.uint8)
    masc = _mascara_retangulo(2000, 3000, 500, 400, 2300, 1500)
    saida = ops.remover(img, masc, espia, lado_max=512)
    assert max(tamanhos[0]) <= 512
    assert saida.shape == img.shape
    assert tuple(saida[900, 1400]) == (0, 255, 0)
    # Borda da máscara original também precisa estar coberta após a redução.
    assert tuple(saida[400, 500]) == (0, 255, 0)

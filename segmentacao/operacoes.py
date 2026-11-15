"""Operações de imagem puras (numpy/OpenCV), sem dependência dos modelos.

Convenções: imagens são ``uint8`` em RGB (ou RGBA quando dito), máscaras são
``uint8`` com 0 (fundo) e 255 (objeto), caixas são ``(x1, y1, x2, y2)``.
"""

from collections.abc import Callable

import cv2
import numpy as np

Inpaint = Callable[[np.ndarray, np.ndarray], np.ndarray]


def para_rgb(img) -> np.ndarray:
    """Converte qualquer entrada (cinza, RGB, RGBA, PIL) em RGB uint8 contíguo.

    Transparência é achatada sobre fundo branco.
    """
    arr = np.asarray(img)
    if arr.dtype != np.uint8:
        arr = np.clip(arr, 0, 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    elif arr.shape[2] == 4:
        alfa = arr[..., 3:4].astype(np.float32) / 255.0
        arr = (arr[..., :3] * alfa + 255.0 * (1.0 - alfa)).round().astype(np.uint8)
    elif arr.shape[2] == 1:
        arr = np.repeat(arr, 3, axis=2)
    return np.ascontiguousarray(arr[..., :3])


def _nucleo(raio: int) -> np.ndarray:
    lado = 2 * max(1, int(raio)) + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (lado, lado))


def expandir_mascara(mascara: np.ndarray, raio: int) -> np.ndarray:
    """Dilata a máscara em ``raio`` pixels; raio negativo encolhe, 0 só binariza."""
    binaria = np.where(mascara > 127, 255, 0).astype(np.uint8)
    if raio == 0:
        return binaria
    operacao = cv2.dilate if raio > 0 else cv2.erode
    return operacao(binaria, _nucleo(abs(raio)))


def caixa_da_mascara(mascara: np.ndarray) -> tuple[int, int, int, int] | None:
    """Menor caixa ``(x1, y1, x2, y2)`` que contém a máscara, ou ``None`` se vazia."""
    ys, xs = np.nonzero(mascara)
    if xs.size == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _alfa(mascara: np.ndarray, suavizar: int) -> np.ndarray:
    """Alfa uint8 com a borda antisserrilhada em ``suavizar`` pixels."""
    alfa = np.where(mascara > 127, 255, 0).astype(np.uint8)
    if suavizar > 0:
        k = 2 * suavizar + 1
        # Erodir antes de borrar evita vazar um halo do fundo para fora do objeto.
        alfa = cv2.GaussianBlur(cv2.erode(alfa, _nucleo(suavizar)), (k, k), 0)
    return alfa


def recortar(img_rgb: np.ndarray, mascara: np.ndarray, suavizar: int = 1) -> np.ndarray | None:
    """Devolve o objeto em RGBA, já aparado ao seu contorno."""
    caixa = caixa_da_mascara(mascara > 127)
    if caixa is None:
        return None
    x1, y1, x2, y2 = caixa
    return np.dstack([img_rgb[y1:y2, x1:x2], _alfa(mascara, suavizar)[y1:y2, x1:x2]])


def trocar_fundo(
    img_rgb: np.ndarray,
    mascara: np.ndarray,
    cor: tuple[int, int, int] | None = None,
    suavizar: int = 1,
) -> np.ndarray:
    """Mantém o objeto e troca o fundo: cor sólida, ou o próprio fundo desfocado se ``cor`` é None.

    O resultado tem o tamanho da imagem original.
    """
    alfa = (_alfa(mascara, suavizar).astype(np.float32) / 255.0)[..., None]
    if cor is not None:
        fundo = np.empty_like(img_rgb, dtype=np.float32)
        fundo[:] = cor
    else:
        # Desfoque só com pixels do fundo: sem isso o objeto "vaza" um halo colorido.
        sigma = max(3.0, 0.012 * max(img_rgb.shape[:2]))
        peso = (expandir_mascara(mascara, round(sigma / 2)) == 0).astype(np.float32)[..., None]
        soma = cv2.GaussianBlur(img_rgb.astype(np.float32) * peso, (0, 0), sigma)
        norma = cv2.GaussianBlur(peso, (0, 0), sigma)[..., None]
        geral = cv2.GaussianBlur(img_rgb.astype(np.float32), (0, 0), sigma)
        fundo = np.where(norma > 1e-3, soma / np.maximum(norma, 1e-3), geral)
    saida = img_rgb.astype(np.float32) * alfa + fundo * (1.0 - alfa)
    return np.clip(saida, 0, 255).round().astype(np.uint8)


def remover(
    img_rgb: np.ndarray,
    mascara: np.ndarray,
    inpaint: Inpaint,
    expandir: int | None = None,
    lado_max: int = 1024,
) -> np.ndarray:
    """Apaga a região da máscara e reconstrói o fundo com ``inpaint``.

    Só a vizinhança do objeto é enviada ao modelo (reduzida a ``lado_max`` se
    preciso), e o resultado volta misturado apenas dentro da máscara expandida.
    Assim o resto da foto fica intacto e imagens grandes não estouram a memória.
    """
    altura, largura = mascara.shape[:2]
    if expandir is None:
        # Cobre sombras e o halo de borda; proporcional ao tamanho da imagem.
        expandir = max(4, round(0.006 * max(altura, largura)))
    alvo = expandir_mascara(mascara, expandir)
    caixa = caixa_da_mascara(alvo)
    if caixa is None:
        return img_rgb.copy()

    x1, y1, x2, y2 = caixa
    margem = max(64, (max(x2 - x1, y2 - y1)) // 2)
    x1, y1 = max(0, x1 - margem), max(0, y1 - margem)
    x2, y2 = min(largura, x2 + margem), min(altura, y2 + margem)
    trecho, alvo_trecho = img_rgb[y1:y2, x1:x2], alvo[y1:y2, x1:x2]
    th, tw = alvo_trecho.shape

    escala = min(1.0, lado_max / max(th, tw))
    if escala < 1.0:
        tam = (max(8, round(tw * escala)), max(8, round(th * escala)))
        entrada = cv2.resize(trecho, tam, interpolation=cv2.INTER_AREA)
        # INTER_AREA + limiar baixo garante que a máscara reduzida ainda cobre tudo.
        masc = cv2.resize(alvo_trecho, tam, interpolation=cv2.INTER_AREA)
        masc = np.where(masc > 0, 255, 0).astype(np.uint8)
    else:
        entrada, masc = trecho, alvo_trecho

    preenchido = inpaint(np.ascontiguousarray(entrada), masc)
    if escala < 1.0:
        preenchido = cv2.resize(preenchido, (tw, th), interpolation=cv2.INTER_CUBIC)

    # Mistura com transição curta, totalmente opaca sobre toda a área apagada.
    pena = max(2, expandir // 2)
    k = 2 * pena + 1
    peso = cv2.GaussianBlur(cv2.dilate(alvo_trecho, _nucleo(pena)), (k, k), 0)
    peso = (peso.astype(np.float32) / 255.0)[..., None]

    saida = img_rgb.copy()
    saida[y1:y2, x1:x2] = (preenchido * peso + trecho * (1.0 - peso)).round().astype(np.uint8)
    return saida

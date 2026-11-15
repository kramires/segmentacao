import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from segmentacao import servidor


def _png(largura=120, altura=80, modo="RGB"):
    buf = io.BytesIO()
    Image.new(modo, (largura, altura), (200, 50, 50, 255)[: len(modo)]).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture
def cliente(monkeypatch):
    """API com modelos falsos: a caixa vira a máscara e o inpaint pinta de verde."""

    def segmentar(img, caixas, pontos):
        m = np.zeros(img.shape[:2], dtype=bool)
        for x1, y1, x2, y2 in caixas:
            m[int(y1) : int(y2), int(x1) : int(x2)] = True
        return m

    def inpaint(img, masc):
        saida = img.copy()
        saida[masc > 0] = (0, 255, 0)
        return saida

    monkeypatch.setattr(servidor.segmentador, "mascara", segmentar)
    monkeypatch.setattr(servidor.segmentador, "preparar", lambda img: None)
    monkeypatch.setattr(servidor, "inpainter", inpaint)
    servidor._sessoes.clear()
    return TestClient(servidor.app)


def _abrir(cliente, **kw):
    r = cliente.post("/api/sessoes", files={"arquivo": ("a.png", _png(**kw), "image/png")})
    assert r.status_code == 200
    return r.json()


def _imagem(resposta):
    return np.asarray(Image.open(io.BytesIO(resposta.content)))


def test_pagina_e_arquivos_estaticos(cliente):
    assert "Segmentação" in cliente.get("/").text
    assert cliente.get("/web/app.js").status_code == 200


def test_fluxo_remover(cliente):
    s = _abrir(cliente)
    assert (s["largura"], s["altura"], s["mascara"]) == (120, 80, None)
    base = f"/api/sessoes/{s['id']}"
    assert cliente.post(f"{base}/remover").status_code == 400  # nada selecionado

    s = cliente.post(
        f"{base}/acao", json={"tipo": "caixa", "x1": 40, "y1": 20, "x2": 80, "y2": 60}
    ).json()
    assert s["caixas"] == [[40.0, 20.0, 80.0, 60.0]] and s["pode_desfazer"]
    mascara = _imagem(cliente.get(s["mascara"]))
    assert mascara.shape == (80, 120, 4)
    assert mascara[40, 60, 3] == 255 and mascara[5, 5, 3] == 0

    url = cliente.post(f"{base}/remover").json()["url"]
    saida = _imagem(cliente.get(url))
    assert tuple(saida[40, 60]) == (0, 255, 0)
    assert tuple(saida[2, 2]) == (200, 50, 50)

    nova = cliente.post(f"{base}/continuar").json()
    assert nova["id"] != s["id"] and nova["mascara"] is None


def test_fluxo_recortar(cliente):
    s = _abrir(cliente, modo="RGBA")  # transparência não pode quebrar
    base = f"/api/sessoes/{s['id']}"
    cliente.post(f"{base}/acao", json={"tipo": "caixa", "x1": 10, "y1": 10, "x2": 50, "y2": 40})
    r = cliente.post(f"{base}/recortar", json={"suavizar": 0}).json()
    assert (r["largura"], r["altura"]) == (40, 30)
    assert _imagem(cliente.get(r["url"])).shape == (30, 40, 4)


def test_expandir_muda_a_url_da_mascara(cliente):
    s = _abrir(cliente)
    base = f"/api/sessoes/{s['id']}"
    a = cliente.post(
        f"{base}/acao", json={"tipo": "caixa", "x1": 40, "y1": 20, "x2": 80, "y2": 60}
    ).json()
    b = cliente.post(f"{base}/expandir", json={"px": 6}).json()
    assert b["expandir"] == 6 and a["mascara"] != b["mascara"]
    assert _imagem(cliente.get(b["mascara"]))[17, 60, 3] == 255


def test_erros(cliente):
    assert cliente.post("/api/sessoes/naoexiste/acao", json={"tipo": "limpar"}).status_code == 404
    r = cliente.post("/api/sessoes", files={"arquivo": ("a.txt", b"oi", "text/plain")})
    assert r.status_code == 400
    s = _abrir(cliente)
    assert (
        cliente.post(f"/api/sessoes/{s['id']}/acao", json={"tipo": "explodir"}).status_code == 400
    )
    assert cliente.get("/api/exemplos/../pyproject.toml").status_code == 404


def test_sessoes_antigas_sao_descartadas(cliente):
    ids = [_abrir(cliente)["id"] for _ in range(servidor.MAX_SESSOES + 1)]
    assert cliente.get(f"/api/sessoes/{ids[0]}/imagem").status_code == 404
    assert cliente.get(f"/api/sessoes/{ids[-1]}/imagem").status_code == 200

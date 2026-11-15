"""Servidor local: serve a página (HTML + Spectra) e expõe os modelos por uma API pequena."""

import io
import threading
import webbrowser
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

from . import operacoes as ops
from .modelos import RAIZ, inpainter, segmentador
from .sessao import Sessao

WEB = Path(__file__).resolve().parent / "web"
DESIGN_SYSTEM = RAIZ / "spectra-design-system"
EXEMPLOS = RAIZ / "imagens"
EXTENSOES = {".jpg", ".jpeg", ".png", ".webp"}
LADO_MAXIMO = 4096  # imagens maiores são reduzidas ao entrar
MAX_SESSOES = 4  # cada sessão guarda a imagem inteira na memória
COR_MASCARA = (153, 211, 52)  # emerald-400 em BGR

app = FastAPI(title="Segmentação")
_sessoes: OrderedDict[str, Sessao] = OrderedDict()
_trava = threading.Lock()


# ---------- sessões ----------


def _nova_sessao(img_rgb: np.ndarray, fundo: BackgroundTasks) -> dict:
    s = Sessao(img_rgb)
    with _trava:
        _sessoes[s.id] = s
        while len(_sessoes) > MAX_SESSOES:
            _sessoes.popitem(last=False)
    fundo.add_task(segmentador.preparar, s.img)
    return _estado(s)


def _sessao(sid: str) -> Sessao:
    with _trava:
        s = _sessoes.get(sid)
        if s is not None:
            _sessoes.move_to_end(sid)
    if s is None:
        raise HTTPException(404, "Sessão expirada. Envie a imagem de novo.")
    return s


def _estado(s: Sessao) -> dict:
    base = f"/api/sessoes/{s.id}"
    return {
        "id": s.id,
        "versao": s.versao,
        "largura": s.largura,
        "altura": s.altura,
        "imagem": f"{base}/imagem",
        "mascara": None if s.vazia else f"{base}/mascara?v={s.versao}-{s.expandir}",
        "caixas": s.caixas,
        "pontos": s.pontos,
        "pode_desfazer": bool(s.historico),
        "expandir": s.expandir,
    }


def _ler_imagem(dados: bytes) -> np.ndarray:
    try:
        pil = ImageOps.exif_transpose(Image.open(io.BytesIO(dados)))
        pil.load()
    except Exception as erro:
        raise HTTPException(400, "Não consegui abrir esse arquivo como imagem.") from erro
    if max(pil.size) > LADO_MAXIMO:
        pil.thumbnail((LADO_MAXIMO, LADO_MAXIMO), Image.LANCZOS)
    if pil.mode not in ("RGB", "RGBA", "L"):
        pil = pil.convert("RGBA" if "transparency" in pil.info else "RGB")
    return ops.para_rgb(pil)


def _png(arr: np.ndarray, compressao: int = 3) -> Response:
    conv = cv2.COLOR_RGBA2BGRA if arr.shape[2] == 4 else cv2.COLOR_RGB2BGR
    _, buf = cv2.imencode(
        ".png", cv2.cvtColor(arr, conv), [cv2.IMWRITE_PNG_COMPRESSION, compressao]
    )
    return Response(buf.tobytes(), media_type="image/png", headers={"Cache-Control": "no-store"})


# ---------- API ----------


class Acao(BaseModel):
    tipo: str
    x: float | None = None
    y: float | None = None
    rotulo: int | None = None
    x1: float | None = None
    y1: float | None = None
    x2: float | None = None
    y2: float | None = None
    modo: str | None = None
    raio: float | None = None
    pts: list[list[float]] | None = None


class Expandir(BaseModel):
    px: int


class Recortar(BaseModel):
    suavizar: int = 1


@app.get("/api/exemplos")
def exemplos() -> list[str]:
    if not EXEMPLOS.is_dir():
        return []
    return sorted(p.name for p in EXEMPLOS.iterdir() if p.suffix.lower() in EXTENSOES)


@app.get("/api/exemplos/{nome}")
def exemplo(nome: str):
    if nome not in exemplos():
        raise HTTPException(404, "Exemplo não encontrado.")
    return FileResponse(EXEMPLOS / nome)


@app.post("/api/sessoes")
async def criar_sessao(arquivo: UploadFile, fundo: BackgroundTasks) -> dict:
    return _nova_sessao(_ler_imagem(await arquivo.read()), fundo)


@app.post("/api/sessoes/exemplo/{nome}")
def criar_de_exemplo(nome: str, fundo: BackgroundTasks) -> dict:
    if nome not in exemplos():
        raise HTTPException(404, "Exemplo não encontrado.")
    return _nova_sessao(_ler_imagem((EXEMPLOS / nome).read_bytes()), fundo)


@app.get("/api/sessoes/{sid}/imagem")
def imagem(sid: str):
    s = _sessao(sid)
    if "jpeg" not in s.saidas:
        _, buf = cv2.imencode(
            ".jpg", cv2.cvtColor(s.img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 95]
        )
        s.saidas["jpeg"] = buf.tobytes()
    return Response(s.saidas["jpeg"], media_type="image/jpeg")


@app.get("/api/sessoes/{sid}/mascara")
def mascara(sid: str):
    s = _sessao(sid)
    m = s.mascara()
    bgra = np.zeros((*m.shape, 4), dtype=np.uint8)
    bgra[m > 0] = (*COR_MASCARA, 255)
    _, buf = cv2.imencode(".png", bgra, [cv2.IMWRITE_PNG_COMPRESSION, 1])
    return Response(buf.tobytes(), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/sessoes/{sid}/acao")
def acao(sid: str, corpo: Acao) -> dict:
    s = _sessao(sid)
    try:
        s.aplicar(corpo.model_dump(exclude_none=True), segmentador.mascara)
    except (KeyError, ValueError) as erro:
        raise HTTPException(400, f"Ação inválida: {erro}") from erro
    return _estado(s)


@app.post("/api/sessoes/{sid}/expandir")
def expandir(sid: str, corpo: Expandir) -> dict:
    s = _sessao(sid)
    s.expandir = int(np.clip(corpo.px, 0, 80))
    return _estado(s)


def _mascara_ou_erro(s: Sessao) -> np.ndarray:
    m = s.mascara()
    if not m.any():
        raise HTTPException(400, "Nada selecionado ainda. Marque o objeto na imagem.")
    return m


@app.post("/api/sessoes/{sid}/remover")
def remover(sid: str) -> dict:
    s = _sessao(sid)
    # A expansão automática cobre sombra e halo; a do usuário já está na máscara.
    s.saidas["resultado"] = ops.remover(s.img, _mascara_ou_erro(s), inpainter)
    return {"url": f"/api/sessoes/{sid}/resultado?v={s.versao}-{s.expandir}"}


@app.get("/api/sessoes/{sid}/resultado")
def resultado(sid: str):
    s = _sessao(sid)
    if "resultado" not in s.saidas:
        raise HTTPException(404, "Ainda não há resultado.")
    return _png(s.saidas["resultado"])


@app.post("/api/sessoes/{sid}/recortar")
def recortar(sid: str, corpo: Recortar) -> dict:
    s = _sessao(sid)
    rec = ops.recortar(s.img, _mascara_ou_erro(s), suavizar=int(np.clip(corpo.suavizar, 0, 8)))
    s.saidas["recorte"] = rec
    return {
        "url": f"/api/sessoes/{sid}/recorte?v={s.versao}-{s.expandir}-{corpo.suavizar}",
        "largura": rec.shape[1],
        "altura": rec.shape[0],
    }


@app.get("/api/sessoes/{sid}/recorte")
def recorte(sid: str):
    s = _sessao(sid)
    if "recorte" not in s.saidas:
        raise HTTPException(404, "Ainda não há recorte.")
    return _png(s.saidas["recorte"])


@app.post("/api/sessoes/{sid}/continuar")
def continuar(sid: str, fundo: BackgroundTasks) -> dict:
    s = _sessao(sid)
    if "resultado" not in s.saidas:
        raise HTTPException(404, "Ainda não há resultado para continuar.")
    return _nova_sessao(s.saidas["resultado"], fundo)


# ---------- página ----------


@app.get("/")
def pagina():
    return FileResponse(WEB / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/ds", StaticFiles(directory=DESIGN_SYSTEM, check_dir=False), name="ds")
app.mount("/web", StaticFiles(directory=WEB), name="web")


def main():
    import uvicorn

    porta = 7860
    threading.Timer(1.0, webbrowser.open, [f"http://127.0.0.1:{porta}"]).start()
    uvicorn.run(app, host="127.0.0.1", port=porta, log_level="warning")


if __name__ == "__main__":
    main()

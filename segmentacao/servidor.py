"""Servidor local: serve a página (HTML + Spectra) e expõe os modelos por uma API pequena."""

import io
import threading
import uuid
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
from .modelos import RAIZ, destacador, inpainter, refinador, segmentador
from .sessao import Sessao

WEB = Path(__file__).resolve().parent / "web"
DESIGN_SYSTEM = RAIZ / "spectra-design-system"
EXEMPLOS = RAIZ / "imagens"
EXTENSOES = {".jpg", ".jpeg", ".png", ".webp"}
LADO_MAXIMO = 4096  # imagens maiores são reduzidas ao entrar
MAX_SESSOES = 4  # cada sessão guarda a imagem inteira na memória
MAX_RESULTADOS = 8  # tamanho da linha do tempo
COR_MASCARA = (153, 211, 52)  # emerald-400 em BGR
# Lado máximo da região enviada ao LaMa: mais pixels, mais detalhe e mais tempo.
QUALIDADES = {"rapida": 1024, "alta": 1536}

app = FastAPI(title="Segmentação")
_sessoes: OrderedDict[str, Sessao] = OrderedDict()
_resultados: OrderedDict[str, dict] = OrderedDict()
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
        "imagem": f"{base}/imagem?v={s.versao_img}",
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


FORMATOS = {
    "png": (".png", "image/png", [cv2.IMWRITE_PNG_COMPRESSION, 3]),
    "webp": (".webp", "image/webp", [cv2.IMWRITE_WEBP_QUALITY, 95]),
    "jpeg": (".jpg", "image/jpeg", [cv2.IMWRITE_JPEG_QUALITY, 95]),
}


def _codificar(arr: np.ndarray, formato: str = "png", lado: int = 0) -> Response:
    if formato not in FORMATOS:
        raise HTTPException(400, "Formato desconhecido. Use png, webp ou jpeg.")
    extensao, tipo, opcoes = FORMATOS[formato]
    if formato == "jpeg":
        arr = ops.para_rgb(arr)  # JPEG não tem transparência: fundo branco
    if 0 < lado < max(arr.shape[:2]):
        escala = lado / max(arr.shape[:2])
        tam = (max(1, round(arr.shape[1] * escala)), max(1, round(arr.shape[0] * escala)))
        arr = cv2.resize(arr, tam, interpolation=cv2.INTER_AREA)
    conv = cv2.COLOR_RGBA2BGRA if arr.shape[2] == 4 else cv2.COLOR_RGB2BGR
    _, buf = cv2.imencode(extensao, cv2.cvtColor(arr, conv), opcoes)
    return Response(buf.tobytes(), media_type=tipo, headers={"Cache-Control": "no-store"})


# ---------- linha do tempo de resultados ----------


def _guardar_resultado(arr: np.ndarray, antes: np.ndarray, tipo: str, nome: str) -> dict:
    """Registra um resultado. ``antes`` é só uma referência à imagem de origem, sem cópia."""
    rid = uuid.uuid4().hex[:12]
    with _trava:
        _resultados[rid] = {"arr": arr, "antes": antes, "tipo": tipo, "nome": nome}
        while len(_resultados) > MAX_RESULTADOS:
            _resultados.popitem(last=False)
    base = f"/api/resultados/{rid}"
    return {
        "id": rid,
        "tipo": tipo,  # "quadro" (imagem inteira) ou "recorte" (objeto com transparência)
        "nome": nome,
        "url": base,
        "antes": f"{base}/antes",
        "largura": arr.shape[1],
        "altura": arr.shape[0],
    }


def _resultado(rid: str) -> dict:
    with _trava:
        r = _resultados.get(rid)
    if r is None:
        raise HTTPException(404, "Esse resultado já saiu da linha do tempo.")
    return r


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


class Remover(BaseModel):
    qualidade: str = "rapida"


class Recortar(BaseModel):
    suavizar: int = 1
    fundo: str = "transparente"  # transparente | cor | desfoque
    cor: str = "#ffffff"
    refinar: bool = False  # recalcula a borda com matting (cabelo, pelos)


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
def acao(sid: str, corpo: Acao, fundo: BackgroundTasks) -> dict:
    s = _sessao(sid)
    antes = s.img
    try:
        s.aplicar(
            corpo.model_dump(exclude_none=True),
            segmentador.mascara,
            destacador.mascara,
            inpainter,
        )
    except (KeyError, ValueError) as erro:
        raise HTTPException(400, f"Ação inválida: {erro}") from erro
    if s.img is not antes:
        # A imagem mudou (borracha mágica ou desfazer): recodifica já para o próximo clique.
        fundo.add_task(segmentador.preparar, s.img)
    return _estado(s)


@app.post("/api/sessoes/{sid}/expandir")
def expandir(sid: str, corpo: Expandir) -> dict:
    s = _sessao(sid)
    s.expandir = int(np.clip(corpo.px, -80, 80))
    return _estado(s)


def _mascara_ou_erro(s: Sessao) -> np.ndarray:
    m = s.mascara()
    if not m.any():
        raise HTTPException(400, "Nada selecionado ainda. Marque o objeto na imagem.")
    return m


@app.post("/api/sessoes/{sid}/remover")
def remover(sid: str, corpo: Remover | None = None) -> dict:
    s = _sessao(sid)
    qualidade = corpo.qualidade if corpo else "rapida"
    if qualidade not in QUALIDADES:
        raise HTTPException(400, "Qualidade desconhecida. Use rapida ou alta.")
    # A expansão automática cobre sombra e halo; a do usuário já está na máscara.
    saida = ops.remover(s.img, _mascara_ou_erro(s), inpainter, lado_max=QUALIDADES[qualidade])
    return _guardar_resultado(saida, s.img, "quadro", "removido")


def _cor(texto: str) -> tuple[int, int, int]:
    texto = texto.lstrip("#")
    try:
        if len(texto) != 6:
            raise ValueError
        return tuple(int(texto[i : i + 2], 16) for i in (0, 2, 4))
    except ValueError as erro:
        raise HTTPException(400, "Cor inválida. Use o formato #rrggbb.") from erro


@app.post("/api/sessoes/{sid}/recortar")
def recortar(sid: str, corpo: Recortar) -> dict:
    s = _sessao(sid)
    if corpo.fundo not in ("transparente", "cor", "desfoque"):
        raise HTTPException(400, "Fundo desconhecido.")
    cor = _cor(corpo.cor) if corpo.fundo == "cor" else None
    m = _mascara_ou_erro(s)
    suavizar = int(np.clip(corpo.suavizar, 0, 8))
    alfa = refinador.alfa(s.img, m) if corpo.refinar else None
    if corpo.fundo == "transparente":
        rec = ops.recortar(s.img, m, suavizar=suavizar, alfa=alfa)
        return _guardar_resultado(rec, s.img, "recorte", "recorte")
    # Imagem inteira com o fundo trocado: um "quadro", como a remoção.
    saida = ops.trocar_fundo(s.img, m, cor=cor, suavizar=suavizar, alfa=alfa)
    return _guardar_resultado(saida, s.img, "quadro", "fundo-trocado")


@app.get("/api/resultados/{rid}")
def resultado(rid: str, formato: str = "png", lado: int = 0):
    return _codificar(_resultado(rid)["arr"], formato, lado)


@app.get("/api/resultados/{rid}/antes")
def resultado_antes(rid: str):
    return _codificar(_resultado(rid)["antes"], "jpeg")


@app.post("/api/resultados/{rid}/continuar")
def continuar(rid: str, fundo: BackgroundTasks) -> dict:
    r = _resultado(rid)
    if r["tipo"] != "quadro":
        raise HTTPException(400, "Só dá para continuar editando a partir de uma imagem inteira.")
    return _nova_sessao(r["arr"], fundo)


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

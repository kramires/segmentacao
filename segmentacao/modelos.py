"""Carga sob demanda dos modelos (SAM 2.1 e LaMa) e cache da imagem codificada."""

import hashlib
import os
import threading
from pathlib import Path

# Algumas operações ainda não existem em MPS; cai para CPU só nelas.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import numpy as np
import torch

RAIZ = Path(__file__).resolve().parent.parent
PASTA_PESOS = RAIZ / "checkpoints"

SAM_ID = os.environ.get("SEGMENTACAO_SAM", "facebook/sam2.1-hiera-small")
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
LAMA_SHA256 = "344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9"


def dispositivo() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class Segmentador:
    """SAM 2.1 com prompt por caixas.

    Codificar a imagem é a etapa cara; ela é feita uma vez por imagem e
    reaproveitada enquanto a mesma imagem continuar sendo usada.
    """

    def __init__(self, modelo_id: str = SAM_ID):
        self.modelo_id = modelo_id
        self._preditor = None
        self._chave = None
        self._trava = threading.Lock()

    def _carregar(self):
        if self._preditor is None:
            from sam2.sam2_image_predictor import SAM2ImagePredictor

            self._preditor = SAM2ImagePredictor.from_pretrained(
                self.modelo_id, device=str(dispositivo())
            )
        return self._preditor

    def _codificar(self, img_rgb: np.ndarray):
        """Garante que ``img_rgb`` é a imagem codificada no preditor (chamar com a trava)."""
        chave = (img_rgb.shape, hashlib.blake2b(img_rgb.tobytes(), digest_size=16).digest())
        preditor = self._carregar()
        if chave != self._chave:
            self._chave = None
            preditor.set_image(img_rgb)
            self._chave = chave
        return preditor

    def preparar(self, img_rgb: np.ndarray) -> None:
        """Codifica a imagem com antecedência, para o primeiro clique sair na hora."""
        with self._trava, torch.inference_mode():
            self._codificar(img_rgb)

    def mascara(self, img_rgb: np.ndarray, caixas=(), pontos=()) -> np.ndarray:
        """Máscara booleana da seleção.

        ``caixas`` é ``(N, 4)``; ``pontos`` é uma lista de ``(x, y, rotulo)`` com
        rótulo 1 (incluir) ou 0 (excluir). Cada caixa é um objeto, refinado pelos
        pontos que caem dentro dela. Pontos positivos fora de qualquer caixa formam
        mais um objeto, junto com todos os negativos.
        """
        altura, largura = img_rgb.shape[:2]
        caixas = np.asarray(caixas, dtype=np.float32).reshape(-1, 4)
        pts = np.array([p[:2] for p in pontos], dtype=np.float32).reshape(-1, 2)
        rot = np.array([p[2] for p in pontos], dtype=np.int32)
        unida = np.zeros((altura, largura), dtype=bool)
        if len(caixas) == 0 and not (rot == 1).any():
            return unida
        with self._trava, torch.inference_mode():
            preditor = self._codificar(img_rgb)
            usados = np.zeros(len(pts), dtype=bool)
            for cx in caixas:
                dentro = (
                    (pts[:, 0] >= cx[0]) & (pts[:, 0] <= cx[2])
                    & (pts[:, 1] >= cx[1]) & (pts[:, 1] <= cx[3])
                )  # fmt: skip
                usados |= dentro
                extra = {}
                if dentro.any():
                    extra = {"point_coords": pts[dentro], "point_labels": rot[dentro]}
                m, _, _ = preditor.predict(box=cx, multimask_output=False, **extra)
                unida |= m[0] > 0
            soltos = (rot == 1) & ~usados
            if soltos.any():
                sel = soltos | (rot == 0)
                # Um clique sozinho é ambíguo: pede 3 hipóteses e fica com a melhor.
                varias = int(sel.sum()) == 1
                m, notas, _ = preditor.predict(
                    point_coords=pts[sel], point_labels=rot[sel], multimask_output=varias
                )
                unida |= m[int(np.argmax(notas))] > 0
        return unida


class Inpainter:
    """LaMa (big-lama, TorchScript): reconstrói o fundo sob a máscara."""

    def __init__(self, caminho: Path = PASTA_PESOS / "big-lama.pt"):
        self.caminho = caminho
        self._modelo = None
        self._disp = torch.device("cpu")
        self._trava = threading.Lock()

    def _baixar(self):
        self.caminho.parent.mkdir(parents=True, exist_ok=True)
        parcial = self.caminho.with_suffix(".parcial")
        torch.hub.download_url_to_file(LAMA_URL, str(parcial), progress=True)
        soma = hashlib.sha256(parcial.read_bytes()).hexdigest()
        if soma != LAMA_SHA256:
            parcial.unlink()
            raise RuntimeError(f"Arquivo do LaMa não confere (sha256 {soma}).")
        parcial.rename(self.caminho)

    def _carregar(self):
        if self._modelo is None:
            if not self.caminho.exists():
                self._baixar()
            self._modelo = torch.jit.load(str(self.caminho), map_location="cpu").eval()
            self._mover(dispositivo())
        return self._modelo

    def _mover(self, disp: torch.device):
        self._modelo.to(disp)
        self._disp = disp

    def _inferir(self, img: np.ndarray, masc: np.ndarray) -> np.ndarray:
        x = torch.from_numpy(img).permute(2, 0, 1)[None].float().div(255).to(self._disp)
        m = torch.from_numpy(masc)[None, None].float().div(255).round().to(self._disp)
        y = self._modelo(x, m)
        return y[0].permute(1, 2, 0).clamp(0, 1).mul(255).round().byte().cpu().numpy()

    def __call__(self, img_rgb: np.ndarray, mascara: np.ndarray) -> np.ndarray:
        altura, largura = mascara.shape
        # A rede exige lados múltiplos de 8.
        ph, pw = (-altura) % 8, (-largura) % 8
        img = np.pad(img_rgb, ((0, ph), (0, pw), (0, 0)), mode="symmetric")
        masc = np.pad(mascara, ((0, ph), (0, pw)), mode="symmetric")
        with self._trava, torch.inference_mode():
            self._carregar()
            try:
                saida = self._inferir(img, masc)
            except RuntimeError:
                if self._disp.type == "cpu":
                    raise
                # Operação sem suporte ou falta de memória na GPU: refaz em CPU.
                self._mover(torch.device("cpu"))
                saida = self._inferir(img, masc)
        return saida[:altura, :largura]


segmentador = Segmentador()
inpainter = Inpainter()

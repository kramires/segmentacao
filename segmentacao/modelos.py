"""Carga sob demanda dos modelos (SAM 2.1 e LaMa) e cache da imagem codificada."""

import hashlib
import os
import threading
from pathlib import Path

# Algumas operações ainda não existem em MPS; cai para CPU só nelas.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import cv2
import numpy as np
import torch

RAIZ = Path(__file__).resolve().parent.parent
PASTA_PESOS = RAIZ / "checkpoints"

SAM_ID = os.environ.get("SEGMENTACAO_SAM", "facebook/sam2.1-hiera-small")
LAMA_URL = "https://github.com/Sanster/models/releases/download/add_big_lama/big-lama.pt"
U2NETP_URL = "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
U2NETP_SHA256 = "309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8"
LAMA_SHA256 = "344c77bbcb158f17dd143070d1e789f38a66c04202311ae3a258ef66667a9ea9"


def dispositivo() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _baixar(url: str, caminho: Path, sha256: str) -> None:
    """Baixa um peso para ``caminho`` (se ainda não existir) e confere o hash."""
    if caminho.exists():
        return
    caminho.parent.mkdir(parents=True, exist_ok=True)
    parcial = caminho.with_suffix(".parcial")
    torch.hub.download_url_to_file(url, str(parcial), progress=True)
    soma = hashlib.sha256(parcial.read_bytes()).hexdigest()
    if soma != sha256:
        parcial.unlink()
        raise RuntimeError(f"O arquivo {caminho.name} não confere (sha256 {soma}).")
    parcial.rename(caminho)


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


class Destacador:
    """Encontra o assunto principal da foto sem nenhuma marcação.

    Um modelo de saliência pequeno (U2-Net-p, 320 px) só localiza os objetos;
    a borda fina vem do SAM, que já está com a imagem codificada. É bem mais
    leve que um modelo de recorte de alta resolução e responde em ~1 s.
    """

    MAX_OBJETOS = 12
    _MEDIA = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    _DESVIO = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def __init__(self, segmentador: Segmentador, caminho: Path = PASTA_PESOS / "u2netp.onnx"):
        self.segmentador = segmentador
        self.caminho = caminho
        self._sessao = None
        self._trava = threading.Lock()

    def _saliencia(self, img_rgb: np.ndarray) -> np.ndarray:
        """Mapa 0..1 no tamanho da imagem."""
        with self._trava:
            if self._sessao is None:
                import onnxruntime as ort

                _baixar(U2NETP_URL, self.caminho, U2NETP_SHA256)
                self._sessao = ort.InferenceSession(
                    str(self.caminho), providers=["CPUExecutionProvider"]
                )
            x = cv2.resize(img_rgb, (320, 320), interpolation=cv2.INTER_AREA).astype(np.float32)
            x = (x / max(float(x.max()), 1e-6) - self._MEDIA) / self._DESVIO
            entrada = self._sessao.get_inputs()[0].name
            y = self._sessao.run(None, {entrada: x.transpose(2, 0, 1)[None]})[0][0, 0]
        y = (y - y.min()) / max(float(y.max() - y.min()), 1e-6)
        altura, largura = img_rgb.shape[:2]
        return cv2.resize(y, (largura, altura), interpolation=cv2.INTER_LINEAR)

    def mascara(self, img_rgb: np.ndarray) -> np.ndarray:
        """Máscara booleana do(s) assunto(s) da imagem."""
        altura, largura = img_rgb.shape[:2]
        grosseira = (self._saliencia(img_rgb) > 0.5).astype(np.uint8)
        _, rotulos, est, _ = cv2.connectedComponentsWithStats(grosseira, 8)
        areas = est[1:, cv2.CC_STAT_AREA]
        if len(areas) == 0:
            return np.zeros((altura, largura), dtype=bool)
        # Descarta respingos: pedaços minúsculos frente à imagem ou ao maior objeto.
        minimo = max(0.002 * altura * largura, 0.05 * areas.max())
        escolhidos = [i + 1 for i in np.argsort(-areas) if areas[i] >= minimo][: self.MAX_OBJETOS]
        caixas, pontos = [], []
        for i in escolhidos:
            x, y, w, h = (int(v) for v in est[i, :4])
            folga_x, folga_y = 0.02 * w, 0.02 * h
            caixas.append(
                [
                    max(0, x - folga_x),
                    max(0, y - folga_y),
                    min(largura - 1, x + w + folga_x),
                    min(altura - 1, y + h + folga_y),
                ]
            )
            # Ponto mais "de dentro" do objeto: ajuda o SAM a não pegar o fundo da caixa.
            dist = cv2.distanceTransform((rotulos == i).astype(np.uint8), cv2.DIST_L2, 3)
            py, px = np.unravel_index(int(dist.argmax()), dist.shape)
            pontos.append([float(px), float(py), 1])
        fina = self.segmentador.mascara(img_rgb, caixas, pontos)
        # O miolo da saliência tapa furos que o SAM às vezes deixa em estampas e reflexos.
        raio = max(2, round(0.015 * max(altura, largura)))
        nucleo = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * raio + 1, 2 * raio + 1))
        miolo = cv2.erode(np.isin(rotulos, escolhidos).astype(np.uint8), nucleo)
        return fina | (miolo > 0)


class Inpainter:
    """LaMa (big-lama, TorchScript): reconstrói o fundo sob a máscara."""

    def __init__(self, caminho: Path = PASTA_PESOS / "big-lama.pt"):
        self.caminho = caminho
        self._modelo = None
        self._disp = torch.device("cpu")
        self._trava = threading.Lock()

    def _carregar(self):
        if self._modelo is None:
            _baixar(LAMA_URL, self.caminho, LAMA_SHA256)
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
destacador = Destacador(segmentador)
inpainter = Inpainter()

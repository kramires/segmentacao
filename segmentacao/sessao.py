"""Estado de uma edição: imagem, seleção (caixas, pontos, pintura) e desfazer."""

import uuid
from collections.abc import Callable
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import operacoes as ops

Segmentar = Callable[[np.ndarray, list, list], np.ndarray]
Destacar = Callable[[np.ndarray], np.ndarray]
LIMITE_DESFAZER = 15


@dataclass
class Sessao:
    img: np.ndarray
    caixas: list = field(default_factory=list)
    pontos: list = field(default_factory=list)
    # Pintura manual: tem a última palavra sobre o que o modelo sugeriu.
    mais: np.ndarray | None = None
    menos: np.ndarray | None = None
    sam: np.ndarray | None = None
    expandir: int = 0
    versao: int = 0
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    historico: list = field(default_factory=list, repr=False)
    saidas: dict = field(default_factory=dict, repr=False)

    @property
    def altura(self) -> int:
        return self.img.shape[0]

    @property
    def largura(self) -> int:
        return self.img.shape[1]

    def _guardar(self):
        copia = lambda m: None if m is None else m.copy()
        self.historico.append(
            (list(self.caixas), list(self.pontos), copia(self.mais), copia(self.menos), self.sam)
        )
        del self.historico[:-LIMITE_DESFAZER]

    def _dentro(self, x, y) -> tuple[float, float]:
        return (
            float(np.clip(x, 0, self.largura - 1)),
            float(np.clip(y, 0, self.altura - 1)),
        )

    def aplicar(
        self, acao: dict, segmentar: Segmentar | None, destacar: Destacar | None = None
    ) -> None:
        """Aplica uma ação vinda do editor e atualiza a máscara."""
        tipo = acao.get("tipo")
        if tipo == "desfazer":
            if self.historico:
                self.caixas, self.pontos, self.mais, self.menos, self.sam = self.historico.pop()
        elif tipo == "limpar":
            self._guardar()
            self.caixas, self.pontos, self.mais, self.menos, self.sam = [], [], None, None, None
        elif tipo == "caixa":
            x1, y1 = self._dentro(acao["x1"], acao["y1"])
            x2, y2 = self._dentro(acao["x2"], acao["y2"])
            x1, x2, y1, y2 = min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)
            if x2 - x1 < 2 or y2 - y1 < 2:
                return
            self._guardar()
            self.caixas.append([x1, y1, x2, y2])
            self.sam = segmentar(self.img, self.caixas, self.pontos)
        elif tipo == "ponto":
            self._guardar()
            self.pontos.append([*self._dentro(acao["x"], acao["y"]), 1 if acao["rotulo"] else 0])
            self.sam = segmentar(self.img, self.caixas, self.pontos)
        elif tipo == "traco":
            pts = np.asarray(acao["pts"], dtype=np.float32).reshape(-1, 2)
            if len(pts) == 0:
                return
            self._guardar()
            self._pintar(pts, float(acao["raio"]), incluir=acao["modo"] == "mais")
        elif tipo == "assunto":
            achado = destacar(self.img)
            if not achado.any():
                raise ValueError("não encontrei um assunto claro nessa imagem")
            self._guardar()
            self._garantir_pintura()
            self.mais |= achado
            self.menos &= ~achado
        elif tipo == "inverter":
            atual = self._base()
            self._guardar()
            # A seleção invertida deixa de corresponder às caixas e pontos: vira pintura.
            self.caixas, self.pontos, self.sam = [], [], None
            self.mais, self.menos = ~atual, np.zeros_like(atual)
        else:
            raise ValueError(f"Ação desconhecida: {tipo!r}")
        self.versao += 1

    def _pintar(self, pts: np.ndarray, raio: float, incluir: bool):
        raio = max(1, round(raio))
        pts = pts.round().astype(np.int32)
        traco = np.zeros((self.altura, self.largura), dtype=np.uint8)
        if len(pts) > 1:
            cv2.polylines(traco, [pts.reshape(-1, 1, 2)], False, 255, thickness=2 * raio)
        for p in (pts[0], pts[-1]):
            cv2.circle(traco, (int(p[0]), int(p[1])), raio, 255, -1)
        traco = traco > 0
        self._garantir_pintura()
        alvo, outro = (self.mais, self.menos) if incluir else (self.menos, self.mais)
        alvo |= traco
        outro &= ~traco

    def _garantir_pintura(self):
        if self.mais is None:
            self.mais = np.zeros((self.altura, self.largura), dtype=bool)
            self.menos = np.zeros((self.altura, self.largura), dtype=bool)

    def _base(self) -> np.ndarray:
        """Seleção booleana antes do ajuste de borda: modelo + pintura − borracha."""
        m = np.zeros((self.altura, self.largura), dtype=bool) if self.sam is None else self.sam
        if self.mais is not None:
            m = (m | self.mais) & ~self.menos
        return m

    def mascara(self) -> np.ndarray:
        """Máscara final (uint8 0/255), com a borda expandida ou encolhida."""
        return ops.expandir_mascara(self._base().astype(np.uint8) * 255, self.expandir)

    @property
    def vazia(self) -> bool:
        return not (self.caixas or self.pontos or (self.mais is not None and self.mais.any()))

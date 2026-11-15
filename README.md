# Segmentação

App local para segmentar objetos em fotos e, a partir da seleção, **remover**, **recortar** ou **colar** em outro fundo.

- Segmentação: SAM 2.1 (Hiera Small), baixado do Hugging Face na primeira execução.
- Remoção: LaMa (big-lama), baixado para `checkpoints/` na primeira execução.

## Rodar

```bash
uv run segmentacao
```

Imagens colocadas na pasta `imagens/` (não versionada) aparecem como exemplos na tela inicial.

## Testes

```bash
uv run pytest
```

## Estrutura

| Arquivo | Papel |
|---|---|
| `segmentacao/web/index.html`, `app.js` | Página: editor com zoom, pontos, pincel e colagem |
| `segmentacao/servidor.py` | Servidor FastAPI: serve a página e expõe os modelos |
| `segmentacao/sessao.py` | Estado de uma edição (caixas, pontos, pintura, desfazer) |
| `segmentacao/modelos.py` | Carga sob demanda do SAM 2.1 e do LaMa, com cache da imagem codificada |
| `segmentacao/operacoes.py` | Operações de imagem puras (máscara, recorte, remoção) |
| `spectra-design-system/` | Design system: a página usa o Tailwind, a configuração e a fonte daqui |

## Atalhos do editor

| Tecla | Ação |
|---|---|
| Roda do mouse / pinça | Zoom no ponto do cursor |
| Espaço + arrastar | Mover a imagem |
| `M` `C` `A` `S` `P` `E` | Mover, Caixa, Ponto +, Ponto −, Pincel, Borracha |
| `[` `]` | Tamanho do pincel |
| `0` / `1` | Ajustar à tela / tamanho real |
| `⌘Z` | Desfazer |

Para trocar o modelo de segmentação, defina `SEGMENTACAO_SAM` (ex.: `facebook/sam2.1-hiera-base-plus`).

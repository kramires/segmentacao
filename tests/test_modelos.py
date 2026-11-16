from segmentacao import modelos


def test_todos_os_modelos_compartilham_a_mesma_trava():
    """Dois modelos na GPU ao mesmo tempo travam o servidor no MPS; a trava única impede."""
    for modelo in (modelos.segmentador, modelos.destacador, modelos.inpainter, modelos.refinador):
        assert modelo._trava is modelos.TRAVA_GPU

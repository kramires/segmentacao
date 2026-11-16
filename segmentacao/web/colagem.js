'use strict';
// Colagem: um fundo e várias camadas (recortes), cada uma com posição, tamanho,
// rotação, espelho, sombra e ajuste de cor. Tudo roda no navegador; o arquivo final
// é composto na resolução total do fundo.
// Usa de app.js: $, $$, COR, E, avisar, carregarImagem, ajustarCanvas.

const C = {
  fundo: null,
  camadas: [],      // de trás para a frente
  sel: null,        // id da camada selecionada
  vista: 1, tx: 0, ty: 0,
  arrasto: null,
  estatFundo: null, // cores médias do fundo, para o "combinar cor"
  seq: 0,
};
const telaC = $('#tela-colagem');
const ALCA = 11;           // raio de toque das alças, em px de tela
const FORCA_COR = 0.7;     // no máximo, a camada anda 70% do caminho até as cores do fundo

const camadaSel = () => C.camadas.find((c) => c.id === C.sel) || null;
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- camadas ----------

function posicionarInicial(c) {
  const largura = C.fundo ? C.fundo.width : c.img.width * 2;
  const altura = C.fundo ? C.fundo.height : c.img.height * 2;
  c.escala = Math.min(1, 0.5 * largura / c.img.width, 0.5 * altura / c.img.height);
  // Cada camada nova entra um pouco deslocada, para não cobrir exatamente a anterior.
  const passo = (C.camadas.indexOf(c) % 6) * 0.03;
  c.x = largura * (0.5 + passo);
  c.y = altura * (0.5 + passo);
}

async function adicionarCamada(url, nome) {
  try {
    const img = await carregarImagem(url);
    const c = {
      id: ++C.seq, nome: nome || 'Camada ' + C.seq, img, pintada: img, estat: null,
      x: 0, y: 0, escala: 1, rot: 0, espelho: false, sombra: 0, cor: 0,
    };
    C.camadas.push(c);
    posicionarInicial(c);
    C.sel = c.id;
    atualizarColagem();
  } catch (erro) {
    avisar(erro.message);
  }
}

function duplicarCamada(c) {
  const copia = { ...c, id: ++C.seq, nome: c.nome + ' (cópia)' };
  const passo = 0.04 * (C.fundo ? C.fundo.width : c.img.width);
  copia.x += passo; copia.y += passo;
  C.camadas.splice(C.camadas.indexOf(c) + 1, 0, copia);
  C.sel = copia.id;
  atualizarColagem();
}

function removerCamada(c) {
  C.camadas = C.camadas.filter((x) => x !== c);
  if (C.sel === c.id) C.sel = C.camadas.length ? C.camadas[C.camadas.length - 1].id : null;
  atualizarColagem();
}

function moverNaOrdem(c, delta) {
  const i = C.camadas.indexOf(c), j = limitar(i + delta, 0, C.camadas.length - 1);
  if (i === j) return;
  C.camadas.splice(i, 1);
  C.camadas.splice(j, 0, c);
  atualizarColagem();
}

// ---------- combinar cor ----------

/** Média e desvio de cada canal, ponderados pela transparência (amostra 64×64). */
function estatisticas(fonte) {
  const n = 64, tela = document.createElement('canvas');
  tela.width = n; tela.height = n;
  const g = tela.getContext('2d', { willReadFrequently: true });
  g.drawImage(fonte, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data;
  const soma = [0, 0, 0], quad = [0, 0, 0];
  let peso = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    if (!a) continue;
    peso += a;
    for (let k = 0; k < 3; k++) { soma[k] += a * d[i + k]; quad[k] += a * d[i + k] * d[i + k]; }
  }
  peso = Math.max(peso, 1e-6);
  const media = soma.map((s) => s / peso);
  const desvio = quad.map((q, k) => Math.sqrt(Math.max(q / peso - media[k] * media[k], 1)));
  return { media, desvio };
}

/** Refaz a versão "pintada" da camada: suas cores puxadas na direção das do fundo. */
function repintar(c) {
  if (!c.cor || !C.estatFundo) { c.pintada = c.img; return; }
  if (!c.estat) c.estat = estatisticas(c.img);
  const tela = document.createElement('canvas');
  tela.width = c.img.width; tela.height = c.img.height;
  const g = tela.getContext('2d', { willReadFrequently: true });
  g.drawImage(c.img, 0, 0);
  const dados = g.getImageData(0, 0, tela.width, tela.height), d = dados.data;
  const t = c.cor * FORCA_COR, mc = c.estat.media, mf = C.estatFundo.media;
  // O contraste só é ajustado dentro de um limite, para a camada não ficar lavada nem estourada.
  const ganho = [0, 1, 2].map((k) => limitar(C.estatFundo.desvio[k] / c.estat.desvio[k], 0.6, 1.6));
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    for (let k = 0; k < 3; k++) {
      const alvo = (d[i + k] - mc[k]) * ganho[k] + mf[k];
      d[i + k] += (alvo - d[i + k]) * t;
    }
  }
  g.putImageData(dados, 0, 0);
  c.pintada = tela;
}

// ---------- desenho ----------

/** Desenha fundo e camadas. ``k`` = px de canvas por px do fundo (a sombra não segue a transformação). */
function comporColagem(g, k) {
  g.imageSmoothingQuality = 'high';
  g.drawImage(C.fundo, 0, 0);
  for (const c of C.camadas) {
    g.save();
    g.translate(c.x, c.y);
    g.rotate(c.rot);
    g.scale(c.escala * (c.espelho ? -1 : 1), c.escala);
    if (c.sombra > 0) {
      const ref = Math.max(c.img.width, c.img.height) * c.escala * k;
      g.shadowColor = 'rgba(0, 0, 0, ' + (0.65 * c.sombra).toFixed(3) + ')';
      g.shadowBlur = ref * 0.06;
      g.shadowOffsetX = ref * 0.025;
      g.shadowOffsetY = ref * 0.045;
    }
    g.drawImage(c.pintada, -c.img.width / 2, -c.img.height / 2);
    g.restore();
  }
}

/** Ponto local da camada (px do recorte × escala, a partir do centro) → px de tela. */
function localParaTela(c, lx, ly) {
  const cos = Math.cos(c.rot), sin = Math.sin(c.rot);
  return [
    (c.x + lx * cos - ly * sin) * C.vista + C.tx,
    (c.y + lx * sin + ly * cos) * C.vista + C.ty,
  ];
}

function alcas(c) {
  const mw = c.img.width * c.escala / 2, mh = c.img.height * c.escala / 2;
  return {
    cantos: [[-mw, -mh], [mw, -mh], [mw, mh], [-mw, mh]].map(([x, y]) => localParaTela(c, x, y)),
    escala: localParaTela(c, mw, mh),
    topo: localParaTela(c, 0, -mh),
    girar: localParaTela(c, 0, -mh - 28 / C.vista),
  };
}

function desenharColagem() {
  const [largura, altura] = ajustarCanvas(telaC);
  const g = telaC.getContext('2d');
  const d = window.devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, telaC.width, telaC.height);
  if (!C.fundo || !largura) return;
  C.vista = Math.min(largura / C.fundo.width, altura / C.fundo.height) * 0.94;
  C.tx = (largura - C.fundo.width * C.vista) / 2;
  C.ty = (altura - C.fundo.height * C.vista) / 2;
  g.setTransform(d * C.vista, 0, 0, d * C.vista, d * C.tx, d * C.ty);
  // As camadas podem sair do fundo durante a edição, mas o que sobra não entra no arquivo.
  g.save();
  g.beginPath(); g.rect(0, 0, C.fundo.width, C.fundo.height); g.clip();
  comporColagem(g, d * C.vista);
  g.restore();

  const c = camadaSel();
  if (!c) return;
  const a = alcas(c);
  g.setTransform(d, 0, 0, d, 0, 0);
  g.lineWidth = 1.5; g.strokeStyle = COR; g.setLineDash([6, 4]);
  g.beginPath();
  a.cantos.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath(); g.stroke();
  g.setLineDash([]);
  g.beginPath(); g.moveTo(a.topo[0], a.topo[1]); g.lineTo(a.girar[0], a.girar[1]); g.stroke();
  for (const [x, y] of [a.escala, a.girar]) {
    g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2);
    g.fillStyle = '#0a1814'; g.fill();
    g.lineWidth = 2; g.strokeStyle = COR; g.stroke();
  }
}

// ---------- painel ----------

function botaoPilula(texto, aoClicar, titulo) {
  const b = document.createElement('button');
  b.className = 'w-7 h-7 rounded-full hover:bg-white/10 text-forest-300 hover:text-white transition-colors text-sm leading-none';
  b.textContent = texto;
  b.title = titulo;
  b.addEventListener('click', (ev) => { ev.stopPropagation(); aoClicar(); });
  return b;
}

function atualizarColagem() {
  $('#vazio-colagem').classList.toggle('hidden', !!C.fundo);
  $('#msg-colagem').textContent = 'Escolha a imagem de fundo';
  const pronta = !!(C.fundo && C.camadas.length);
  $('#btn-baixar-colagem').disabled = !pronta;
  $('#btn-copiar-colagem').disabled = !pronta;

  // Recortes da linha do tempo, prontos para virar camada.
  const recortes = E.historia.filter((r) => r.tipo === 'recorte');
  $('#sem-recorte').classList.toggle('hidden', recortes.length > 0);
  $('#recortes-disponiveis').replaceChildren(...recortes.map((r) => {
    const b = document.createElement('button');
    b.className = 'xadrez shrink-0 w-16 h-16 rounded-xl overflow-hidden border border-white/10 hover:border-emerald-500/30 hover:scale-105 transition-all duration-300';
    b.title = 'Adicionar como camada';
    b.innerHTML = '<img src="' + r.url + '?lado=140" class="w-full h-full object-contain" alt="">';
    b.addEventListener('click', () => adicionarCamada(r.url));
    return b;
  }));

  // Lista de camadas: a da frente aparece em cima, como nos editores de imagem.
  $('#titulo-camadas').classList.toggle('hidden', !C.camadas.length);
  $('#lista-camadas').replaceChildren(...[...C.camadas].reverse().map((c) => {
    const linha = document.createElement('div');
    const ativa = c.id === C.sel;
    linha.className = 'flex items-center gap-3 p-2 rounded-2xl border cursor-pointer transition-colors duration-300 '
      + (ativa ? 'bg-forest-800 border-white/5' : 'border-transparent hover:bg-white/5');
    const mini = document.createElement('img');
    mini.src = c.img.src;
    mini.className = 'xadrez w-10 h-10 rounded-lg object-contain';
    mini.alt = '';
    const nome = document.createElement('span');
    nome.className = 'flex-1 text-sm truncate ' + (ativa ? 'text-white' : 'text-forest-300');
    nome.textContent = c.nome;
    linha.append(
      mini, nome,
      botaoPilula('↑', () => moverNaOrdem(c, +1), 'Trazer para a frente'),
      botaoPilula('↓', () => moverNaOrdem(c, -1), 'Mandar para trás'),
      botaoPilula('×', () => removerCamada(c), 'Remover camada'),
    );
    linha.addEventListener('click', () => { C.sel = c.id; atualizarColagem(); });
    return linha;
  }));

  const c = camadaSel();
  $('#controles-camada').classList.toggle('hidden', !c);
  if (c) {
    const graus = Math.round(c.rot * 180 / Math.PI);
    $('#escala').value = Math.round(c.escala * 100);
    $('#escala-valor').textContent = Math.round(c.escala * 100) + '%';
    $('#girar').value = graus;
    $('#girar-valor').textContent = graus + '°';
    $('#sombra').value = Math.round(c.sombra * 100);
    $('#sombra-valor').textContent = Math.round(c.sombra * 100) + '%';
    $('#cor-camada').value = Math.round(c.cor * 100);
    $('#cor-camada-valor').textContent = Math.round(c.cor * 100) + '%';
    $('#btn-espelhar').setAttribute('aria-pressed', String(c.espelho));
  }
  desenharColagem();
}

/** Liga um controle deslizante a uma propriedade da camada selecionada. */
function ligarControle(seletor, aplicar) {
  $(seletor).addEventListener('input', (ev) => {
    const c = camadaSel();
    if (!c) return;
    aplicar(c, +ev.target.value);
    atualizarColagem();
  });
}
ligarControle('#escala', (c, v) => { c.escala = limitar(v / 100, 0.02, 4); });
ligarControle('#girar', (c, v) => { c.rot = v * Math.PI / 180; });
ligarControle('#sombra', (c, v) => { c.sombra = v / 100; });
ligarControle('#cor-camada', (c, v) => { c.cor = v / 100; repintar(c); });
$('#btn-espelhar').addEventListener('click', () => {
  const c = camadaSel();
  if (c) { c.espelho = !c.espelho; atualizarColagem(); }
});
$('#btn-duplicar').addEventListener('click', () => { const c = camadaSel(); if (c) duplicarCamada(c); });

// ---------- fundo e entrada ----------

async function definirFundo(arquivo) {
  if (!arquivo || !arquivo.type.startsWith('image/')) return avisar('Esse arquivo não é uma imagem.');
  try {
    const novo = await carregarImagem(URL.createObjectURL(arquivo));
    if (C.fundo) {
      // Trocar o fundo mantém a arrumação: posições e tamanhos acompanham a nova proporção.
      const fx = novo.width / C.fundo.width, fy = novo.height / C.fundo.height;
      for (const c of C.camadas) { c.x *= fx; c.y *= fy; c.escala *= Math.min(fx, fy); }
      C.fundo = novo;
    } else {
      C.fundo = novo;
      C.camadas.forEach(posicionarInicial);
    }
    C.estatFundo = estatisticas(novo);
    C.camadas.forEach(repintar);
    atualizarColagem();
  } catch (erro) {
    avisar(erro.message);
  }
}

$('#btn-fundo').addEventListener('click', () => $('#arquivo-fundo').click());
$('#btn-trocar-fundo').addEventListener('click', () => $('#arquivo-fundo').click());
$('#arquivo-fundo').addEventListener('change', (ev) => { definirFundo(ev.target.files[0]); ev.target.value = ''; });
$('#palco-colagem').addEventListener('dragover', (ev) => ev.preventDefault());
$('#palco-colagem').addEventListener('drop', (ev) => { ev.preventDefault(); definirFundo(ev.dataTransfer.files[0]); });
$('#btn-add-imagem').addEventListener('click', () => $('#arquivo-camada').click());
$('#arquivo-camada').addEventListener('change', (ev) => {
  const arquivo = ev.target.files[0];
  ev.target.value = '';
  if (!arquivo || !arquivo.type.startsWith('image/')) return;
  adicionarCamada(URL.createObjectURL(arquivo), arquivo.name.replace(/\.[^.]+$/, ''));
});

// ---------- ponteiro ----------

const pontoColagem = (ev) => {
  const r = telaC.getBoundingClientRect();
  return {
    tela: [ev.clientX - r.left, ev.clientY - r.top],
    x: (ev.clientX - r.left - C.tx) / C.vista,
    y: (ev.clientY - r.top - C.ty) / C.vista,
  };
};

function camadaEm(x, y) {
  for (let i = C.camadas.length - 1; i >= 0; i--) {
    const c = C.camadas[i];
    const dx = x - c.x, dy = y - c.y, cos = Math.cos(-c.rot), sin = Math.sin(-c.rot);
    const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
    if (Math.abs(lx) <= c.img.width * c.escala / 2 && Math.abs(ly) <= c.img.height * c.escala / 2) return c;
  }
  return null;
}

telaC.addEventListener('pointerdown', (ev) => {
  if (!C.fundo) return;
  telaC.setPointerCapture(ev.pointerId);
  const p = pontoColagem(ev);
  const perto = (alvo) => Math.hypot(p.tela[0] - alvo[0], p.tela[1] - alvo[1]) <= ALCA;
  const sel = camadaSel();
  if (sel) {
    const a = alcas(sel);
    if (perto(a.escala)) {
      C.arrasto = { tipo: 'escala', c: sel, d0: Math.hypot(p.x - sel.x, p.y - sel.y), e0: sel.escala };
      return;
    }
    if (perto(a.girar)) {
      C.arrasto = { tipo: 'girar', c: sel, a0: Math.atan2(p.y - sel.y, p.x - sel.x) - sel.rot };
      return;
    }
  }
  const c = camadaEm(p.x, p.y);
  C.sel = c ? c.id : null;
  C.arrasto = c ? { tipo: 'mover', c, dx: p.x - c.x, dy: p.y - c.y } : null;
  atualizarColagem();
});

telaC.addEventListener('pointermove', (ev) => {
  const a = C.arrasto;
  if (!a) return;
  const p = pontoColagem(ev);
  if (a.tipo === 'mover') {
    a.c.x = p.x - a.dx; a.c.y = p.y - a.dy;
  } else if (a.tipo === 'escala') {
    a.c.escala = limitar(a.e0 * Math.hypot(p.x - a.c.x, p.y - a.c.y) / Math.max(a.d0, 1), 0.02, 4);
  } else {
    let rot = Math.atan2(p.y - a.c.y, p.x - a.c.x) - a.a0;
    // Encaixa de 90 em 90 graus quando chega perto; Alt desliga o encaixe.
    const quarto = Math.PI / 2, perto = Math.round(rot / quarto) * quarto;
    if (!ev.altKey && Math.abs(rot - perto) < 0.05) rot = perto;
    a.c.rot = Math.atan2(Math.sin(rot), Math.cos(rot)); // mantém entre −180° e 180°
  }
  atualizarColagem();
});

const soltarColagem = () => { C.arrasto = null; };
telaC.addEventListener('pointerup', soltarColagem);
telaC.addEventListener('pointercancel', soltarColagem);
telaC.addEventListener('wheel', (ev) => {
  const c = camadaSel();
  if (!c) return;
  ev.preventDefault();
  c.escala = limitar(c.escala * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0018)), 0.02, 4);
  atualizarColagem();
}, { passive: false });

window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea') || $('#vista-colagem').classList.contains('hidden')) return;
  const c = camadaSel();
  if (c && (ev.key === 'Delete' || ev.key === 'Backspace')) { ev.preventDefault(); removerCamada(c); }
});

// ---------- saída ----------

function renderizarColagem() {
  // A composição final é feita na resolução total do fundo, sem perda.
  const saida = document.createElement('canvas');
  saida.width = C.fundo.width; saida.height = C.fundo.height;
  comporColagem(saida.getContext('2d'), 1);
  return new Promise((ok) => saida.toBlob(ok, 'image/png'));
}

$('#btn-baixar-colagem').addEventListener('click', async () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await renderizarColagem());
  link.download = 'colagem.png';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});

$('#btn-copiar-colagem').addEventListener('click', async () => {
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': renderizarColagem() })]);
    avisar('Colagem copiada.');
  } catch {
    avisar('Não consegui copiar. Use o botão Baixar.');
  }
});

new ResizeObserver(desenharColagem).observe($('#palco-colagem'));

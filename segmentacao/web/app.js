'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const COR = 'rgb(52, 211, 153)'; // emerald-400

// ---------- utilidades ----------

async function api(url, opcoes) {
  const r = await fetch(url, opcoes);
  if (!r.ok) {
    let detalhe = 'Algo deu errado. Tente de novo.';
    try { detalhe = (await r.json()).detail || detalhe; } catch { /* resposta sem JSON */ }
    throw new Error(detalhe);
  }
  return r.json();
}
const enviarJSON = (url, corpo) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(corpo || {}),
});

function carregarImagem(url) {
  return new Promise((ok, falha) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => falha(new Error('Não consegui carregar a imagem.'));
    img.src = url;
  });
}

let relogioAviso;
function avisar(texto) {
  const el = $('#aviso');
  el.textContent = texto;
  el.classList.remove('hidden');
  clearTimeout(relogioAviso);
  relogioAviso = setTimeout(() => el.classList.add('hidden'), 4500);
}

let ocupados = 0;
function ocupado(delta, texto) {
  ocupados = Math.max(0, ocupados + delta);
  $('#status-texto').textContent = ocupados ? (texto || 'Calculando') : 'Pronto';
  $('#status-ponto').classList.toggle('animate-pulse', ocupados > 0);
}

/** Ajusta o tamanho interno do canvas ao tamanho na tela; devolve [largura, altura] em CSS px. */
function ajustarCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  const w = Math.round(r.width * d), h = Math.round(r.height * d);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return [r.width, r.height];
}

// ---------- editor ----------

const E = {
  sessao: null,          // estado devolvido pelo servidor
  img: null,
  mascara: document.createElement('canvas'), // seleção em resolução total
  temMascara: false,
  verMascara: true,
  escala: 1, tx: 0, ty: 0,
  ferramenta: 'mais',
  raioTela: 18,          // raio do pincel em px de tela: dar zoom = pincel mais fino
  arrasto: null,
  cursor: null,
  espaco: false,
  operacao: 'remover',
  fila: Promise.resolve(),
  pedidoMascara: 0,
  ultimoRecorte: null,
};
const tela = $('#tela');

const DICAS = {
  mover: 'Arraste para mover · roda do mouse para zoom',
  caixa: 'Arraste um retângulo ao redor do objeto · espaço + arrastar move',
  mais: 'Clique no objeto para incluir · clique direito exclui · arrastar move',
  menos: 'Clique numa área para tirá-la da seleção · arrastar move',
  pincel: 'Pinte para incluir na seleção · dê zoom para um traço mais fino · [ e ] mudam o tamanho',
  borracha: 'Pinte para tirar da seleção · dê zoom para um traço mais fino · [ e ] mudam o tamanho',
};

function escolherFerramenta(nome) {
  E.ferramenta = nome;
  $$('#ferramentas [data-ferramenta]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.ferramenta === nome)));
  const pintando = nome === 'pincel' || nome === 'borracha';
  $('#grupo-pincel').classList.toggle('invisible', !pintando); // reserva o espaço: a tela não pula
  $('#dica').textContent = E.sessao ? DICAS[nome] : '';
  tela.style.cursor = nome === 'mover' ? 'grab' : pintando ? 'none' : 'crosshair';
  desenhar();
}

function paraImagem(ev) {
  const r = tela.getBoundingClientRect();
  return [(ev.clientX - r.left - E.tx) / E.escala, (ev.clientY - r.top - E.ty) / E.escala];
}
const paraTela = (x, y) => [x * E.escala + E.tx, y * E.escala + E.ty];

function encaixar() {
  if (!E.sessao) return;
  const r = tela.getBoundingClientRect();
  if (!r.width) return;
  E.escala = Math.min(r.width / E.sessao.largura, r.height / E.sessao.altura) * 0.94;
  E.tx = (r.width - E.sessao.largura * E.escala) / 2;
  E.ty = (r.height - E.sessao.altura * E.escala) / 2;
  desenhar();
}

function zoomEm(fator, cx, cy) {
  if (!E.sessao) return;
  const r = tela.getBoundingClientRect();
  if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
  const minima = Math.min(r.width / E.sessao.largura, r.height / E.sessao.altura) * 0.3;
  const nova = Math.min(48, Math.max(minima, E.escala * fator));
  const f = nova / E.escala;
  E.tx = cx - (cx - E.tx) * f;
  E.ty = cy - (cy - E.ty) * f;
  E.escala = nova;
  desenhar();
}

function desenhar() {
  const [largura, altura] = ajustarCanvas(tela);
  const g = tela.getContext('2d');
  const d = window.devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, tela.width, tela.height);
  if (!E.img) return;

  g.setTransform(d * E.escala, 0, 0, d * E.escala, d * E.tx, d * E.ty);
  g.imageSmoothingEnabled = E.escala < 3; // perto o bastante, mostra os pixels reais
  g.drawImage(E.img, 0, 0);
  if (E.temMascara && E.verMascara) {
    g.globalAlpha = 0.5;
    g.drawImage(E.mascara, 0, 0);
    g.globalAlpha = 1;
  }

  // Marcações em coordenadas de tela, para manter a espessura com qualquer zoom.
  g.setTransform(d, 0, 0, d, 0, 0);
  const caixas = [...E.sessao.caixas];
  if (E.arrasto && E.arrasto.tipo === 'caixa') caixas.push([...E.arrasto.p0, ...E.arrasto.p1]);
  g.lineWidth = 1.5;
  for (const [x1, y1, x2, y2] of caixas) {
    const [a, b] = paraTela(Math.min(x1, x2), Math.min(y1, y2));
    const [c, e] = paraTela(Math.max(x1, x2), Math.max(y1, y2));
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(a + 1, b + 1, c - a, e - b);
    g.strokeStyle = COR; g.strokeRect(a, b, c - a, e - b);
  }
  for (const [x, y, rotulo] of E.sessao.pontos) {
    const [a, b] = paraTela(x, y);
    g.beginPath(); g.arc(a, b, 6, 0, Math.PI * 2);
    g.fillStyle = rotulo ? COR : '#f87171'; g.fill();
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.stroke();
  }
  if (E.cursor && (E.ferramenta === 'pincel' || E.ferramenta === 'borracha') && !E.espaco) {
    g.beginPath(); g.arc(E.cursor[0], E.cursor[1], E.raioTela, 0, Math.PI * 2);
    g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
    g.beginPath(); g.arc(E.cursor[0], E.cursor[1], E.raioTela - 1, 0, Math.PI * 2);
    g.strokeStyle = E.ferramenta === 'pincel' ? COR : '#fff'; g.stroke();
  }
  $('#zoom-valor').textContent = Math.round(E.escala * 100) + '%';
  void largura; void altura;
}

/** Desenha o traço na cópia local da máscara, para o retorno ser imediato. */
function pintarLocal(de, para, raio, incluir) {
  if (!E.temMascara) {
    E.mascara.width = E.sessao.largura; E.mascara.height = E.sessao.altura;
    E.temMascara = true;
  }
  const g = E.mascara.getContext('2d');
  g.globalCompositeOperation = incluir ? 'source-over' : 'destination-out';
  g.strokeStyle = COR; g.fillStyle = COR;
  g.lineWidth = raio * 2; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(de[0], de[1]); g.lineTo(para[0], para[1]); g.stroke();
  g.beginPath(); g.arc(para[0], para[1], raio, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'source-over';
}

async function aplicarEstado(estado, imagemNova) {
  E.sessao = estado;
  if (imagemNova) {
    E.img = await carregarImagem(estado.imagem);
    E.temMascara = false;
    mostrarEditor(true);
    encaixar();
  }
  $('#btn-desfazer').disabled = !estado.pode_desfazer;
  $('#btn-processar').disabled = !estado.mascara;
  const pedido = ++E.pedidoMascara;
  if (!estado.mascara) {
    E.temMascara = false;
  } else {
    const m = await carregarImagem(estado.mascara);
    if (pedido !== E.pedidoMascara) return; // chegou uma versão mais nova
    E.mascara.width = estado.largura; E.mascara.height = estado.altura;
    E.mascara.getContext('2d').drawImage(m, 0, 0);
    E.temMascara = true;
  }
  desenhar();
}

/** Ações vão em fila: a ordem dos cliques é a ordem em que o servidor as aplica. */
function acao(corpo) {
  if (!E.sessao) return;
  const id = E.sessao.id;
  ocupado(+1);
  E.fila = E.fila
    .then(() => enviarJSON(`/api/sessoes/${id}/acao`, corpo))
    .then((estado) => { if (E.sessao && E.sessao.id === id) return aplicarEstado(estado, false); })
    .catch((erro) => avisar(erro.message))
    .finally(() => ocupado(-1));
}

function mostrarEditor(comImagem) {
  $('#vazio').classList.toggle('hidden', comImagem);
  for (const sel of ['#zoom', '#ver-mascara']) {
    $(sel).classList.toggle('hidden', !comImagem);
    $(sel).classList.toggle('flex', comImagem);
  }
  $('#btn-trocar').classList.toggle('hidden', !comImagem);
  $('#dica').textContent = comImagem ? DICAS[E.ferramenta] : '';
  if (!comImagem) $('#cartao-resultado').classList.add('hidden');
}

async function abrirSessao(pedido) {
  ocupado(+1, 'Abrindo imagem');
  try {
    const estado = await pedido;
    $('#cartao-resultado').classList.add('hidden');
    await aplicarEstado(estado, true);
  } catch (erro) {
    avisar(erro.message);
  } finally {
    ocupado(-1);
  }
}

function enviarArquivo(arquivo) {
  if (!arquivo || !arquivo.type.startsWith('image/')) return avisar('Esse arquivo não é uma imagem.');
  const dados = new FormData();
  dados.append('arquivo', arquivo);
  return abrirSessao(api('/api/sessoes', { method: 'POST', body: dados }));
}

// --- ponteiro ---

tela.addEventListener('pointerdown', (ev) => {
  if (!E.sessao) return;
  tela.setPointerCapture(ev.pointerId);
  const p = paraImagem(ev);
  const mover = ev.button === 1 || E.espaco || E.ferramenta === 'mover';
  const f = E.ferramenta;
  if (mover) {
    E.arrasto = { tipo: 'mover', x: ev.clientX, y: ev.clientY, tx: E.tx, ty: E.ty };
  } else if (f === 'caixa' && ev.button === 0) {
    E.arrasto = { tipo: 'caixa', p0: p, p1: p };
  } else if (f === 'mais' || f === 'menos') {
    const positivo = (f === 'mais') !== (ev.button === 2 || ev.altKey);
    E.arrasto = { tipo: 'clique', x: ev.clientX, y: ev.clientY, tx: E.tx, ty: E.ty, p, positivo, moveu: false };
  } else if ((f === 'pincel' || f === 'borracha') && ev.button === 0) {
    const raio = E.raioTela / E.escala;
    E.arrasto = { tipo: 'traco', incluir: f === 'pincel', raio, pts: [p] };
    pintarLocal(p, p, raio, f === 'pincel');
  }
  desenhar();
});

tela.addEventListener('pointermove', (ev) => {
  const r = tela.getBoundingClientRect();
  E.cursor = [ev.clientX - r.left, ev.clientY - r.top];
  const a = E.arrasto;
  if (a) {
    if (a.tipo === 'clique' && Math.hypot(ev.clientX - a.x, ev.clientY - a.y) > 4) a.moveu = true;
    if (a.tipo === 'mover' || (a.tipo === 'clique' && a.moveu)) {
      E.tx = a.tx + ev.clientX - a.x; E.ty = a.ty + ev.clientY - a.y;
    } else if (a.tipo === 'caixa') {
      a.p1 = paraImagem(ev);
    } else if (a.tipo === 'traco') {
      const p = paraImagem(ev), ultimo = a.pts[a.pts.length - 1];
      if (Math.hypot(p[0] - ultimo[0], p[1] - ultimo[1]) * E.escala >= 1.5) {
        pintarLocal(ultimo, p, a.raio, a.incluir);
        a.pts.push(p);
      }
    }
  }
  desenhar();
});

function soltar() {
  const a = E.arrasto;
  E.arrasto = null;
  if (!a) return;
  if (a.tipo === 'caixa') {
    const [x1, y1] = a.p0, [x2, y2] = a.p1;
    if (Math.abs(x2 - x1) * E.escala > 5 && Math.abs(y2 - y1) * E.escala > 5) {
      acao({ tipo: 'caixa', x1, y1, x2, y2 });
    }
  } else if (a.tipo === 'clique' && !a.moveu) {
    const [x, y] = a.p;
    if (x >= 0 && y >= 0 && x < E.sessao.largura && y < E.sessao.altura) {
      E.sessao.pontos.push([x, y, a.positivo ? 1 : 0]); // aparece na hora
      acao({ tipo: 'ponto', x, y, rotulo: a.positivo ? 1 : 0 });
    }
  } else if (a.tipo === 'traco') {
    const pts = a.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    acao({ tipo: 'traco', modo: a.incluir ? 'mais' : 'menos', raio: a.raio, pts });
  }
  desenhar();
}
tela.addEventListener('pointerup', soltar);
tela.addEventListener('pointercancel', soltar);
tela.addEventListener('pointerleave', () => { E.cursor = null; desenhar(); });
tela.addEventListener('contextmenu', (ev) => ev.preventDefault());
tela.addEventListener('wheel', (ev) => {
  if (!E.sessao) return;
  ev.preventDefault();
  const r = tela.getBoundingClientRect();
  // Pinça no trackpad chega como roda + ctrl, com deltas pequenos: reage mais forte.
  const passo = ev.ctrlKey ? 0.012 : 0.0018;
  zoomEm(Math.exp(-ev.deltaY * passo), ev.clientX - r.left, ev.clientY - r.top);
}, { passive: false });

// --- barra, atalhos e painel ---

$('#ferramentas').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-ferramenta]');
  if (b) escolherFerramenta(b.dataset.ferramenta);
});
$('#zoom').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-zoom]');
  if (!b) return;
  if (b.dataset.zoom === '0') encaixar();
  else if (b.dataset.zoom === '1') zoomEm(1 / E.escala);
  else zoomEm(b.dataset.zoom === '+' ? 1.4 : 1 / 1.4);
});
$('#raio').addEventListener('input', (ev) => { E.raioTela = +ev.target.value; desenhar(); });
$('#chk-mascara').addEventListener('change', (ev) => { E.verMascara = ev.target.checked; desenhar(); });
$('#btn-desfazer').addEventListener('click', () => acao({ tipo: 'desfazer' }));
$('#btn-limpar').addEventListener('click', () => acao({ tipo: 'limpar' }));

const ATALHOS = { m: 'mover', c: 'caixa', a: 'mais', s: 'menos', p: 'pincel', e: 'borracha' };
window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea') || $('#vista-editor').classList.contains('hidden')) return;
  const k = ev.key.toLowerCase();
  if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); acao({ tipo: 'desfazer' }); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.code === 'Space') { ev.preventDefault(); E.espaco = true; tela.style.cursor = 'grab'; desenhar(); }
  else if (ATALHOS[k]) escolherFerramenta(ATALHOS[k]);
  else if (k === '0') encaixar();
  else if (k === '1') zoomEm(1 / E.escala);
  else if (k === '+' || k === '=') zoomEm(1.4);
  else if (k === '-') zoomEm(1 / 1.4);
  else if (k === '[' || k === ']') {
    E.raioTela = Math.min(120, Math.max(2, Math.round(E.raioTela * (k === ']' ? 1.25 : 0.8))));
    $('#raio').value = E.raioTela; desenhar();
  }
});
window.addEventListener('keyup', (ev) => {
  if (ev.code === 'Space' && E.espaco) { E.espaco = false; escolherFerramenta(E.ferramenta); }
});

$('#operacoes').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-operacao]');
  if (!b) return;
  E.operacao = b.dataset.operacao;
  $$('#operacoes [data-operacao]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  const recortar = E.operacao === 'recortar';
  $('#grupo-suavizar').classList.toggle('hidden', !recortar);
  $('#grupo-suavizar').classList.toggle('block', recortar);
});

let relogioExpandir;
$('#expandir').addEventListener('input', (ev) => {
  const px = +ev.target.value;
  $('#expandir-valor').textContent = px + ' px';
  clearTimeout(relogioExpandir);
  relogioExpandir = setTimeout(() => {
    if (!E.sessao) return;
    const id = E.sessao.id;
    E.fila = E.fila
      .then(() => enviarJSON(`/api/sessoes/${id}/expandir`, { px }))
      .then((estado) => { if (E.sessao && E.sessao.id === id) return aplicarEstado(estado, false); })
      .catch((erro) => avisar(erro.message));
  }, 150);
});
$('#suavizar').addEventListener('input', (ev) => { $('#suavizar-valor').textContent = ev.target.value + ' px'; });

function posicionarComparador() {
  const v = +$('#cmp-range').value;
  $('#cmp-antes').style.clipPath = `inset(0 ${100 - v}% 0 0)`;
  $('#cmp-linha').style.left = v + '%';
}
$('#cmp-range').addEventListener('input', posicionarComparador);

$('#btn-processar').addEventListener('click', async () => {
  if (!E.sessao) return;
  const id = E.sessao.id, remover = E.operacao === 'remover';
  const botao = $('#btn-processar');
  botao.disabled = true;
  ocupado(+1, remover ? 'Removendo' : 'Recortando');
  try {
    await E.fila; // garante que a última marcação já foi aplicada
    const r = remover
      ? await enviarJSON(`/api/sessoes/${id}/remover`)
      : await enviarJSON(`/api/sessoes/${id}/recortar`, { suavizar: +$('#suavizar').value });
    if (remover) {
      $('#cmp-antes').src = E.sessao.imagem;
      $('#cmp-depois').src = r.url;
      $('#cmp-range').value = 50; posicionarComparador();
      $('#btn-seguir').textContent = 'Continuar editando';
      $('#resultado-tag').textContent = 'REMOVIDO';
    } else {
      $('#img-recorte').src = r.url;
      E.ultimoRecorte = r;
      C.recorte = null; // a colagem recarrega o recorte novo
      $('#btn-seguir').textContent = 'Usar na colagem';
      $('#resultado-tag').textContent = `${r.largura}×${r.altura}`;
    }
    $('#comparador').classList.toggle('hidden', !remover);
    $('#quadro-recorte').classList.toggle('hidden', remover);
    $('#btn-baixar').href = r.url;
    $('#btn-baixar').download = remover ? 'removido.png' : 'recorte.png';
    $('#btn-seguir').dataset.modo = E.operacao;
    $('#cartao-resultado').classList.remove('hidden');
  } catch (erro) {
    avisar(erro.message);
  } finally {
    ocupado(-1);
    botao.disabled = !(E.sessao && E.sessao.mascara);
  }
});

$('#btn-seguir').addEventListener('click', (ev) => {
  if (ev.currentTarget.dataset.modo === 'recortar') return mostrarVista('colagem');
  abrirSessao(enviarJSON(`/api/sessoes/${E.sessao.id}/continuar`));
});

$('#btn-trocar').addEventListener('click', () => {
  E.sessao = null; E.img = null; E.temMascara = false;
  $('#btn-processar').disabled = true;
  $('#expandir').value = 0; $('#expandir-valor').textContent = '0 px';
  mostrarEditor(false);
  desenhar();
});

// --- entrada de imagens ---

$('#btn-enviar').addEventListener('click', () => $('#arquivo').click());
$('#arquivo').addEventListener('change', (ev) => { enviarArquivo(ev.target.files[0]); ev.target.value = ''; });
$('#palco').addEventListener('dragover', (ev) => ev.preventDefault());
$('#palco').addEventListener('drop', (ev) => { ev.preventDefault(); enviarArquivo(ev.dataTransfer.files[0]); });
window.addEventListener('paste', (ev) => {
  const arquivo = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (!arquivo) return;
  if ($('#vista-editor').classList.contains('hidden')) definirFundo(arquivo);
  else enviarArquivo(arquivo);
});

async function listarExemplos() {
  try {
    const nomes = await api('/api/exemplos');
    for (const nome of nomes) {
      const b = document.createElement('button');
      b.className = 'w-20 h-14 rounded-xl overflow-hidden border border-white/10 hover:border-emerald-500/30 hover:scale-105 transition-all duration-300';
      b.title = nome;
      b.innerHTML = `<img src="/api/exemplos/${encodeURIComponent(nome)}" class="w-full h-full object-cover" alt="">`;
      b.addEventListener('click', () =>
        abrirSessao(enviarJSON(`/api/sessoes/exemplo/${encodeURIComponent(nome)}`)));
      $('#exemplos').appendChild(b);
    }
  } catch { /* sem exemplos, segue sem a fileira */ }
}

// ---------- colagem ----------

const C = { fundo: null, recorte: null, x: 0, y: 0, escala: 1, vista: 1, tx: 0, ty: 0, arrasto: null };
const telaC = $('#tela-colagem');

function desenharColagem() {
  const [largura, altura] = ajustarCanvas(telaC);
  const g = telaC.getContext('2d');
  const d = window.devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, telaC.width, telaC.height);
  if (!C.fundo || !largura) return;
  C.vista = Math.min(largura / C.fundo.width, altura / C.fundo.height) * 0.96;
  C.tx = (largura - C.fundo.width * C.vista) / 2;
  C.ty = (altura - C.fundo.height * C.vista) / 2;
  g.setTransform(d * C.vista, 0, 0, d * C.vista, d * C.tx, d * C.ty);
  comporColagem(g);
  if (C.recorte) {
    g.lineWidth = 1 / C.vista; g.strokeStyle = COR; g.setLineDash([6 / C.vista, 4 / C.vista]);
    g.strokeRect(C.x, C.y, C.recorte.width * C.escala, C.recorte.height * C.escala);
    g.setLineDash([]);
  }
}

function comporColagem(g) {
  g.imageSmoothingQuality = 'high';
  g.drawImage(C.fundo, 0, 0);
  if (C.recorte) g.drawImage(C.recorte, C.x, C.y, C.recorte.width * C.escala, C.recorte.height * C.escala);
}

function definirEscala(nova) {
  if (!C.recorte) return;
  nova = Math.min(3, Math.max(0.05, nova));
  // Mantém o centro do recorte no lugar ao redimensionar.
  C.x += C.recorte.width * (C.escala - nova) / 2;
  C.y += C.recorte.height * (C.escala - nova) / 2;
  C.escala = nova;
  $('#escala').value = Math.round(nova * 100);
  $('#escala-valor').textContent = Math.round(nova * 100) + '%';
  desenharColagem();
}

function centralizarRecorte() {
  if (!C.fundo || !C.recorte) return;
  const cabe = Math.min(1, 0.5 * C.fundo.width / C.recorte.width, 0.5 * C.fundo.height / C.recorte.height);
  C.escala = cabe;
  C.x = (C.fundo.width - C.recorte.width * cabe) / 2;
  C.y = (C.fundo.height - C.recorte.height * cabe) / 2;
  definirEscala(cabe);
}

async function atualizarColagem() {
  if (E.ultimoRecorte && !C.recorte) {
    C.recorte = await carregarImagem(E.ultimoRecorte.url);
    $('#mini-recorte').src = E.ultimoRecorte.url;
    centralizarRecorte();
  }
  $('#mini-recorte').classList.toggle('hidden', !C.recorte);
  $('#sem-recorte').classList.toggle('hidden', !!C.recorte);
  $('#vazio-colagem').classList.toggle('hidden', !!C.fundo);
  $('#msg-colagem').textContent = 'Escolha a imagem de fundo';
  $('#btn-baixar-colagem').disabled = !(C.fundo && C.recorte);
  desenharColagem();
}

async function definirFundo(arquivo) {
  if (!arquivo || !arquivo.type.startsWith('image/')) return avisar('Esse arquivo não é uma imagem.');
  try {
    C.fundo = await carregarImagem(URL.createObjectURL(arquivo));
    centralizarRecorte();
    atualizarColagem();
  } catch (erro) { avisar(erro.message); }
}

const pontoColagem = (ev) => {
  const r = telaC.getBoundingClientRect();
  return [(ev.clientX - r.left - C.tx) / C.vista, (ev.clientY - r.top - C.ty) / C.vista];
};
telaC.addEventListener('pointerdown', (ev) => {
  if (!C.fundo || !C.recorte) return;
  telaC.setPointerCapture(ev.pointerId);
  const [x, y] = pontoColagem(ev);
  C.arrasto = { dx: x - C.x, dy: y - C.y };
});
telaC.addEventListener('pointermove', (ev) => {
  if (!C.arrasto) return;
  const [x, y] = pontoColagem(ev);
  C.x = x - C.arrasto.dx; C.y = y - C.arrasto.dy;
  desenharColagem();
});
telaC.addEventListener('pointerup', () => { C.arrasto = null; });
telaC.addEventListener('wheel', (ev) => {
  if (!C.recorte) return;
  ev.preventDefault();
  definirEscala(C.escala * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0018)));
}, { passive: false });
$('#escala').addEventListener('input', (ev) => definirEscala(+ev.target.value / 100));
$('#btn-fundo').addEventListener('click', () => $('#arquivo-fundo').click());
$('#btn-trocar-fundo').addEventListener('click', () => $('#arquivo-fundo').click());
$('#arquivo-fundo').addEventListener('change', (ev) => { definirFundo(ev.target.files[0]); ev.target.value = ''; });
$('#palco-colagem').addEventListener('dragover', (ev) => ev.preventDefault());
$('#palco-colagem').addEventListener('drop', (ev) => { ev.preventDefault(); definirFundo(ev.dataTransfer.files[0]); });

$('#btn-baixar-colagem').addEventListener('click', () => {
  // A composição final é feita na resolução total do fundo, sem perda.
  const saida = document.createElement('canvas');
  saida.width = C.fundo.width; saida.height = C.fundo.height;
  comporColagem(saida.getContext('2d'));
  saida.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'colagem.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }, 'image/png');
});

// ---------- navegação ----------

function mostrarVista(nome) {
  $('#vista-editor').classList.toggle('hidden', nome !== 'editor');
  $('#vista-colagem').classList.toggle('hidden', nome !== 'colagem');
  $$('.nav').forEach((b) => {
    const ativa = b.dataset.vista === nome;
    b.classList.toggle('text-white', ativa);
    b.classList.toggle('text-white/70', !ativa);
  });
  if (nome === 'colagem') atualizarColagem(); else desenhar();
}
$$('.nav').forEach((b) => b.addEventListener('click', () => mostrarVista(b.dataset.vista)));

new ResizeObserver(() => { desenhar(); desenharColagem(); }).observe(document.body);
escolherFerramenta('mais');
listarExemplos();

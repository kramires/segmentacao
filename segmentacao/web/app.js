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
  fundo: 'transparente',
  qualidade: 'rapida',
  resultado: null,       // resultado em exibição, para baixar, copiar e continuar
  historia: [],          // linha do tempo: resultados mais recentes primeiro
  pendentes: [],         // traços da borracha mágica aguardando o servidor
  urlImagem: null,
  fila: Promise.resolve(),
  pedidoMascara: 0,
};
const tela = $('#tela');
const PINCEIS = ['pincel', 'borracha', 'apagar']; // ferramentas que pintam um traço
const ROSA = 'rgba(248, 113, 113, 0.55)';         // traço da borracha mágica

const DICAS = {
  mover: 'Arraste para mover · roda do mouse para zoom',
  caixa: 'Arraste um retângulo ao redor do objeto · espaço + arrastar move',
  mais: 'Clique no objeto para incluir · clique direito exclui · arrastar move',
  menos: 'Clique numa área para tirá-la da seleção · arrastar move',
  pincel: 'Pinte para incluir na seleção · dê zoom para um traço mais fino · [ e ] mudam o tamanho',
  borracha: 'Pinte para tirar da seleção · dê zoom para um traço mais fino · [ e ] mudam o tamanho',
  apagar: 'Pinte por cima de algo para apagá-lo da foto na hora, sem selecionar · ⌘Z desfaz',
};

function escolherFerramenta(nome) {
  E.ferramenta = nome;
  $$('#ferramentas [data-ferramenta]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.ferramenta === nome)));
  const pintando = PINCEIS.includes(nome);
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

  // Traços da borracha mágica: o que está sendo pintado e o que o servidor ainda processa.
  const apagando = [...E.pendentes];
  if (E.arrasto && E.arrasto.apagar) apagando.push(E.arrasto);
  g.strokeStyle = ROSA; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const t of apagando) {
    g.lineWidth = t.raio * 2;
    g.beginPath(); g.moveTo(t.pts[0][0], t.pts[0][1]);
    for (const p of t.pts) g.lineTo(p[0], p[1]);
    g.stroke();
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
  if (E.cursor && PINCEIS.includes(E.ferramenta) && !E.espaco) {
    g.beginPath(); g.arc(E.cursor[0], E.cursor[1], E.raioTela, 0, Math.PI * 2);
    g.lineWidth = 1; g.strokeStyle = '#000'; g.stroke();
    g.beginPath(); g.arc(E.cursor[0], E.cursor[1], E.raioTela - 1, 0, Math.PI * 2);
    g.strokeStyle = { pincel: COR, apagar: '#f87171' }[E.ferramenta] || '#fff'; g.stroke();
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
  if (imagemNova || estado.imagem !== E.urlImagem) {
    // A URL também muda quando a borracha mágica edita a foto: recarrega sem mexer no zoom.
    E.img = await carregarImagem(estado.imagem);
    E.urlImagem = estado.imagem;
  }
  if (imagemNova) {
    E.temMascara = false;
    mostrarEditor(true);
    encaixar();
  }
  $('#btn-desfazer').disabled = !estado.pode_desfazer;
  $('#btn-assunto').disabled = false;
  $('#btn-inverter').disabled = false;
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
function acao(corpo, texto) {
  if (!E.sessao) return Promise.resolve();
  const id = E.sessao.id;
  ocupado(+1, texto);
  E.fila = E.fila
    .then(() => enviarJSON(`/api/sessoes/${id}/acao`, corpo))
    .then((estado) => { if (E.sessao && E.sessao.id === id) return aplicarEstado(estado, false); })
    .catch((erro) => avisar(erro.message))
    .finally(() => ocupado(-1));
  return E.fila;
}

function mostrarEditor(comImagem) {
  $('#vazio').classList.toggle('hidden', comImagem);
  for (const sel of ['#zoom', '#ver-mascara']) {
    $(sel).classList.toggle('hidden', !comImagem);
    $(sel).classList.toggle('flex', comImagem);
  }
  $('#btn-trocar').classList.toggle('hidden', !comImagem);
  $('#dica').textContent = comImagem ? DICAS[E.ferramenta] : '';
}

async function abrirSessao(pedido) {
  ocupado(+1, 'Abrindo imagem');
  try {
    const estado = await pedido;
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
  } else if (PINCEIS.includes(f) && ev.button === 0) {
    const raio = E.raioTela / E.escala;
    E.arrasto = { tipo: 'traco', incluir: f === 'pincel', apagar: f === 'apagar', raio, pts: [p] };
    if (!E.arrasto.apagar) pintarLocal(p, p, raio, f === 'pincel');
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
        if (!a.apagar) pintarLocal(ultimo, p, a.raio, a.incluir);
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
    if (a.apagar) {
      // O traço fica visível em rosa até a foto reconstruída chegar.
      E.pendentes.push(a);
      acao({ tipo: 'apagar', raio: a.raio, pts }, 'Apagando').finally(() => {
        E.pendentes = E.pendentes.filter((t) => t !== a);
        desenhar();
      });
    } else {
      acao({ tipo: 'traco', modo: a.incluir ? 'mais' : 'menos', raio: a.raio, pts });
    }
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
$('#btn-assunto').addEventListener('click', () => acao({ tipo: 'assunto' }, 'Procurando assunto'));
$('#btn-inverter').addEventListener('click', () => acao({ tipo: 'inverter' }));

const ATALHOS = { m: 'mover', c: 'caixa', a: 'mais', s: 'menos', p: 'pincel', e: 'borracha', x: 'apagar' };
window.addEventListener('keydown', (ev) => {
  if (ev.target.matches('input, textarea') || $('#vista-editor').classList.contains('hidden')) return;
  const k = ev.key.toLowerCase();
  if ((ev.metaKey || ev.ctrlKey) && k === 'z') { ev.preventDefault(); acao({ tipo: 'desfazer' }); return; }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.code === 'Space') { ev.preventDefault(); E.espaco = true; tela.style.cursor = 'grab'; desenhar(); }
  else if (ATALHOS[k]) escolherFerramenta(ATALHOS[k]);
  else if (k === 'i') acao({ tipo: 'inverter' });
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
  $('#grupo-recorte').classList.toggle('hidden', !recortar);
  $('#grupo-remover').classList.toggle('hidden', recortar);
});

$('#fundos').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-fundo]');
  if (!b) return;
  E.fundo = b.dataset.fundo;
  $$('#fundos [data-fundo]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#cor-fundo').classList.toggle('hidden', E.fundo !== 'cor');
});

let relogioExpandir;
$('#expandir').addEventListener('input', (ev) => {
  const px = +ev.target.value;
  $('#expandir-valor').textContent = (px > 0 ? '+' : '') + px + ' px';
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

function atualizarDownload() {
  if (!E.resultado) return;
  const formato = $('#formato').value;
  $('#btn-baixar').href = E.resultado.url + '?formato=' + formato;
  $('#btn-baixar').download = E.resultado.nome + '.' + (formato === 'jpeg' ? 'jpg' : formato);
}
$('#formato').addEventListener('change', atualizarDownload);

$('#btn-copiar').addEventListener('click', async () => {
  if (!E.resultado) return;
  try {
    // A área de transferência só aceita PNG; a promessa mantém o gesto do clique válido no Safari.
    const png = fetch(E.resultado.url).then((r) => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    avisar('Imagem copiada.');
  } catch {
    avisar('Não consegui copiar. Use o botão Baixar.');
  }
});

const ROTULOS = { removido: 'REMOVIDO', 'fundo-trocado': 'FUNDO TROCADO' };

/** Mostra um resultado da linha do tempo: comparador para imagem inteira, xadrez para recorte. */
function mostrarResultado(r) {
  // "quadro" = imagem inteira (remoção ou fundo trocado); senão é o recorte transparente.
  const quadro = r.tipo === 'quadro';
  if (quadro) {
    $('#cmp-antes').src = r.antes;
    $('#cmp-depois').src = r.url;
    $('#cmp-range').value = 50; posicionarComparador();
    $('#btn-seguir').textContent = 'Continuar editando';
    $('#resultado-tag').textContent = ROTULOS[r.nome] || '';
  } else {
    $('#img-recorte').src = r.url;
    $('#btn-seguir').textContent = 'Usar na colagem';
    $('#resultado-tag').textContent = `${r.largura}×${r.altura}`;
  }
  $('#comparador').classList.toggle('hidden', !quadro);
  $('#quadro-recorte').classList.toggle('hidden', quadro);
  E.resultado = r;
  atualizarDownload();
  $('#btn-seguir').dataset.modo = quadro ? 'continuar' : 'colagem';
  $('#cartao-resultado').classList.remove('hidden');

  const faixa = $('#historia');
  faixa.replaceChildren(...E.historia.map((item) => {
    const b = document.createElement('button');
    const atual = item.id === r.id;
    b.className = 'xadrez shrink-0 w-14 h-14 rounded-xl overflow-hidden border transition-all duration-300 '
      + (atual ? 'border-emerald-400' : 'border-white/10 opacity-60 hover:opacity-100');
    b.title = ROTULOS[item.nome] ? ROTULOS[item.nome].toLowerCase() : 'recorte';
    const img = document.createElement('img');
    img.src = item.url + '?lado=120';
    img.className = 'w-full h-full object-cover';
    img.alt = '';
    b.appendChild(img);
    b.addEventListener('click', () => mostrarResultado(item));
    return b;
  }));
  faixa.classList.toggle('hidden', E.historia.length < 2);
}

$('#qualidades').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-qualidade]');
  if (!b) return;
  E.qualidade = b.dataset.qualidade;
  $$('#qualidades [data-qualidade]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
});

$('#btn-processar').addEventListener('click', async () => {
  if (!E.sessao) return;
  const id = E.sessao.id, remover = E.operacao === 'remover';
  const botao = $('#btn-processar');
  botao.disabled = true;
  ocupado(+1, remover ? 'Removendo' : 'Recortando');
  try {
    await E.fila; // garante que a última marcação já foi aplicada
    const r = remover
      ? await enviarJSON(`/api/sessoes/${id}/remover`, { qualidade: E.qualidade })
      : await enviarJSON(`/api/sessoes/${id}/recortar`, {
        suavizar: +$('#suavizar').value, fundo: E.fundo, cor: $('#cor-fundo').value,
        refinar: $('#refinar').checked,
      });
    // Entra no começo da linha do tempo; o servidor guarda o mesmo número de resultados.
    E.historia.unshift(r);
    E.historia.length = Math.min(E.historia.length, 8);
    mostrarResultado(r);
  } catch (erro) {
    avisar(erro.message);
  } finally {
    ocupado(-1);
    botao.disabled = !(E.sessao && E.sessao.mascara);
  }
});

$('#btn-seguir').addEventListener('click', (ev) => {
  if (ev.currentTarget.dataset.modo === 'colagem') {
    // O recorte em exibição entra como uma camada nova na colagem.
    return adicionarCamada(E.resultado.url).then(() => mostrarVista('colagem'));
  }
  abrirSessao(enviarJSON(`${E.resultado.url}/continuar`));
});

$('#btn-trocar').addEventListener('click', () => {
  E.sessao = null; E.img = null; E.temMascara = false; E.urlImagem = null;
  $('#btn-processar').disabled = true;
  $('#btn-assunto').disabled = true; $('#btn-inverter').disabled = true;
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

new ResizeObserver(desenhar).observe($('#palco'));
escolherFerramenta('mais');
listarExemplos();

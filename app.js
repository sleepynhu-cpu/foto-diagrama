// Foto → Diagrama: lê texto de fotos (OCR), organiza em itens e exporta só texto (.js / .json).
const $ = s => document.querySelector(s);
const CHAVE = 'diagramas-v1';

// ---------- armazenamento (somente texto, no navegador) ----------
function carregar() {
  try { return JSON.parse(localStorage.getItem(CHAVE)) || []; } catch { return []; }
}
function gravar(lista) {
  try { localStorage.setItem(CHAVE, JSON.stringify(lista)); return true; }
  catch { aviso('Não consegui salvar no navegador. Exporte o .json como backup.'); return false; }
}
let diagramas = carregar();
let fotos = [];        // apenas nesta sessão, para o OCR
let editandoId = null;

function aviso(msg) {
  const el = $('#aviso');
  el.textContent = msg;
  el.classList.add('visivel');
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => el.classList.remove('visivel'), 2500);
}

// ---------- abas ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => abrirAba(b.dataset.tab));
function abrirAba(nome) {
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('ativo', b.dataset.tab === nome));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('ativo', t.id === 'tab-' + nome));
  if (nome === 'biblioteca') renderLista();
  if (nome === 'comparar') renderGrupos();
}

// ---------- fotos ----------
$('#f-camera').onchange = e => addFotos(e.target.files);
$('#f-galeria').onchange = e => addFotos(e.target.files);
// Cada foto guarda: giro (múltiplos de 90°), inclinacao (graus, para endireitar), recorte (0..1, na foto já girada),
// ajustada (já passou pela tela de recorte), lida (já foi lida) e estado (texto mostrado na miniatura).
function addFotos(arquivos) {
  const antes = fotos.length;
  for (const f of arquivos) fotos.push({ url: URL.createObjectURL(f), arquivo: f, giro: 0, inclinacao: 0, recorte: null, ajustada: false, lida: false, estado: '' });
  $('#f-camera').value = $('#f-galeria').value = ''; // permite escolher o mesmo arquivo de novo
  renderFotos();
  // já abre o recorte (é o que mais melhora a leitura); com várias fotos, uma depois da outra
  if (fotos.length > antes) abrirRecorte(antes);
}
function renderFotos() {
  const box = $('#fotos');
  box.innerHTML = '';
  fotos.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'foto';
    const selo = f.estado ? `<span class="selo${f.estado.startsWith('✔') ? ' ok' : ''}">${esc(f.estado)}</span>`
      : f.ajustada ? '<span class="selo">✂ ajustada</span>' : '<span class="selo alerta">toque p/ recortar</span>';
    d.innerHTML = `<img src="${f.url}" title="Toque para recortar/girar">${selo}<button title="Remover">✕</button>`;
    d.querySelector('img').onclick = () => abrirRecorte(i);
    d.querySelector('button').onclick = () => { URL.revokeObjectURL(f.url); fotos.splice(i, 1); renderFotos(); };
    box.appendChild(d);
  });
}

// Desenha a imagem girada (giro em 90° + inclinação fina), com fundo branco nos cantos.
function girar(img, giro, inclinacao, escala = 1) {
  const rad = (giro * 90 + inclinacao) * Math.PI / 180;
  const w = img.width * escala, h = img.height * escala;
  const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
  const c = document.createElement('canvas');
  c.width = Math.round(w * cos + h * sin);
  c.height = Math.round(w * sin + h * cos);
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.translate(c.width / 2, c.height / 2);
  x.rotate(rad);
  x.drawImage(img, -w / 2, -h / 2, w, h);
  return c;
}

// Gira, recorta e amplia: o texto fica com ~30-40 px de altura, que é onde o Tesseract lê melhor.
async function prepararImagem(foto) {
  const img = await createImageBitmap(foto.arquivo);
  const girada = girar(img, foto.giro || 0, foto.inclinacao || 0);
  const r = foto.recorte || { x: 0, y: 0, w: 1, h: 1 };
  const sx = r.x * girada.width, sy = r.y * girada.height, sw = r.w * girada.width, sh = r.h * girada.height;
  const escala = Math.min(4, Math.max(1, 2200 / Math.max(sw, sh)));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * escala);
  c.height = Math.round(sh * escala);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(girada, sx, sy, sw, sh, 0, 0, c.width, c.height);
  if (foto.inclinacao) return c; // a pessoa já endireitou na mão
  const angulo = detectarInclinacao(c);
  return Math.abs(angulo) >= 0.5 ? girar(c, 0, angulo) : c;
}

// Acha o ângulo em que as linhas de texto ficam mais "retas": testa ângulos e vê qual
// concentra os pixels escuros em menos faixas horizontais (perfil de projeção).
function detectarInclinacao(src) {
  const esc = Math.min(1, 600 / src.width);
  const w = Math.round(src.width * esc), h = Math.round(src.height * esc);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(src, 0, 0, w, h);
  const p = x.getImageData(0, 0, w, h).data;
  let media = 0;
  for (let i = 0; i < p.length; i += 4) media += p[i];
  media /= w * h;
  // Só contornos de traços escuros (pixel escuro com vizinho claro na horizontal): assim áreas
  // grandes escuras, como o fundo nas bordas da foto, não contam. Pula a margem de 3%.
  const escuros = [];
  const lim = media * 0.7, mx = Math.round(w * 0.03) + 2, my = Math.round(h * 0.03);
  const v = (xx, yy) => p[(yy * w + xx) * 4];
  for (let yy = my; yy < h - my; yy++)
    for (let xx = mx; xx < w - mx; xx++)
      if (v(xx, yy) < lim && (v(xx - 2, yy) >= lim || v(xx + 2, yy) >= lim)) escuros.push(xx - w / 2, yy - h / 2);
  if (escuros.length < 100) return 0;
  let melhor = 0, melhorNota = -1;
  const faixas = new Float64Array(h * 2);
  for (let ang = -15; ang <= 15; ang += 0.5) {
    const r = ang * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
    faixas.fill(0);
    for (let i = 0; i < escuros.length; i += 2) {
      const yr = Math.round(escuros[i] * sin + escuros[i + 1] * cos + h);
      if (yr >= 0 && yr < faixas.length) faixas[yr]++;
    }
    let nota = 0;
    for (const f of faixas) nota += f * f;
    if (nota > melhorNota) { melhorNota = nota; melhor = ang; }
  }
  return melhor;
}

// Preto e branco com limiar local (média da vizinhança): aguenta reflexo e sombra na mesma foto.
function binarizar(src) {
  const w = src.width, h = src.height;
  const dados = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const p = dados.data;
  // imagem integral para calcular a média de cada janela rapidamente
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let soma = 0;
    for (let x = 0; x < w; x++) {
      soma += p[(y * w + x) * 4];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + soma;
    }
  }
  const raio = Math.max(8, Math.round(Math.min(w, h) / 40));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - raio), y1 = Math.min(h, y + raio + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - raio), x1 = Math.min(w, x + raio + 1);
      const area = (x1 - x0) * (y1 - y0);
      const s = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const i = (y * w + x) * 4;
      // 0.78: mais agressivo que isso engrossa as letras e elas grudam (medido nas fotos de teste)
      const v = p[i] * area < s * 0.78 ? 0 : 255;
      p[i] = p[i + 1] = p[i + 2] = v;
    }
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(dados, 0, 0);
  return c;
}

// ---------- recortar / girar ----------
const rec = { indice: -1, img: null, girada: null, escala: 1, sel: null, inicio: null };
async function abrirRecorte(i) {
  const f = fotos[i];
  if (!f) return;
  rec.indice = i;
  const bmp = await createImageBitmap(f.arquivo);
  rec.escala = Math.min(1, 1400 / Math.max(bmp.width, bmp.height)); // prévia leve
  rec.img = bmp;
  rec.giro = f.giro;
  $('#r-incl').value = f.inclinacao;
  rec.sel = f.recorte ? { ...f.recorte } : null;
  $('#recorte').hidden = false;
  document.body.style.overflow = 'hidden';
  desenharRecorte();
}
function desenharRecorte() {
  rec.girada = girar(rec.img, rec.giro, Number($('#r-incl').value), rec.escala);
  const cv = $('#r-canvas');
  cv.width = rec.girada.width;
  cv.height = rec.girada.height;
  const x = cv.getContext('2d');
  x.drawImage(rec.girada, 0, 0);
  // linhas-guia para ajudar a endireitar
  x.strokeStyle = 'rgba(31,111,235,.35)';
  x.lineWidth = Math.max(1, cv.width / 600);
  for (let k = 1; k < 8; k++) { x.beginPath(); x.moveTo(0, cv.height * k / 8); x.lineTo(cv.width, cv.height * k / 8); x.stroke(); }
  if (rec.sel) {
    const s = rec.sel;
    x.fillStyle = 'rgba(0,0,0,.55)';
    x.fillRect(0, 0, cv.width, s.y * cv.height);
    x.fillRect(0, (s.y + s.h) * cv.height, cv.width, cv.height);
    x.fillRect(0, s.y * cv.height, s.x * cv.width, s.h * cv.height);
    x.fillRect((s.x + s.w) * cv.width, s.y * cv.height, cv.width, s.h * cv.height);
    x.strokeStyle = '#1f6feb';
    x.lineWidth = Math.max(2, cv.width / 300);
    x.strokeRect(s.x * cv.width, s.y * cv.height, s.w * cv.width, s.h * cv.height);
  }
}
function pontoNoCanvas(e) {
  const r = $('#r-canvas').getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
$('#r-canvas').addEventListener('pointerdown', e => {
  e.preventDefault();
  try { $('#r-canvas').setPointerCapture(e.pointerId); } catch {}
  rec.inicio = pontoNoCanvas(e);
});
$('#r-canvas').addEventListener('pointermove', e => {
  if (!rec.inicio) return;
  const p = pontoNoCanvas(e), a = rec.inicio;
  rec.sel = { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
  desenharRecorte();
});
$('#r-canvas').addEventListener('pointerup', () => {
  rec.inicio = null;
  if (rec.sel && (rec.sel.w < 0.03 || rec.sel.h < 0.03)) { rec.sel = null; desenharRecorte(); }
});
$('#r-girar-esq').onclick = () => { rec.giro = (rec.giro + 3) % 4; rec.sel = null; desenharRecorte(); };
$('#r-girar-dir').onclick = () => { rec.giro = (rec.giro + 1) % 4; rec.sel = null; desenharRecorte(); };
$('#r-incl').oninput = () => { rec.sel = null; desenharRecorte(); };
// Ao confirmar: a foto entra na fila de leitura (se "ler automaticamente" estiver ligado).
// proxima: já abre a câmera de novo para a próxima foto, enquanto esta é lida em segundo plano.
function fecharRecorte(salvar, inteira = false, proxima = false) {
  const f = fotos[rec.indice];
  if (salvar && f) {
    const mudou = f.giro !== rec.giro || f.inclinacao !== Number($('#r-incl').value) || JSON.stringify(f.recorte) !== JSON.stringify(inteira ? null : rec.sel);
    f.giro = rec.giro;
    f.inclinacao = Number($('#r-incl').value);
    f.recorte = inteira ? null : rec.sel;
    f.ajustada = true;
    if (mudou) f.lida = false; // recortou de novo: lê de novo
  }
  $('#recorte').hidden = true;
  document.body.style.overflow = '';
  rec.img?.close?.();
  rec.img = null;
  renderFotos();
  if (salvar && f && !f.lida && $('#f-auto').checked) enfileirarLeitura(f);
  if (proxima) { $('#f-camera').click(); return; }
  // fotos da galeria escolhidas juntas: abre o recorte da próxima que ainda não foi ajustada
  const seguinte = fotos.findIndex(x => !x.ajustada && !x.lida);
  if (salvar && seguinte >= 0) abrirRecorte(seguinte);
}
$('#r-ok').onclick = () => fecharRecorte(true);
$('#r-proxima').onclick = () => fecharRecorte(true, false, true);
$('#r-tudo').onclick = () => fecharRecorte(true, true);
$('#r-cancelar').onclick = () => fecharRecorte(false);

// O worker é criado uma vez só; criar já baixa (e guarda) o leitor e o idioma para uso offline.
let workerPromise = null;
function obterWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('por+eng', 1, {
      logger: m => { if (m.status === 'recognizing text') $('#progresso').textContent = `Lendo… ${Math.round(m.progress * 100)}%`; }
    }).then(async w => {
      await w.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

// Linha que começa com um código tipo FB1, F12, SB 3, R1.
const RE_CODIGO = /^([A-Za-z]{1,4})\s?[-.]?\s?([\dOolI]{1,3}[a-z]?)(?![A-Za-z])/;
const temCodigo = t => { const m = t.trim().match(RE_CODIGO); return !!m && /\d/.test(m[2]); };

// Lê uma imagem num modo (psm) e devolve as linhas com a confiança de cada uma.
async function lerLinhas(worker, img, psm) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(img, {}, { blocks: true, text: true });
  const linhas = (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines))
    .map(l => ({ texto: l.text.replace(/\s+/g, ' ').trim(), conf: l.confidence }))
    .filter(l => l.texto);
  return linhas.length ? linhas : data.text.split('\n').map(t => ({ texto: t.trim(), conf: data.confidence })).filter(l => l.texto);
}

// Fica com o que parece texto de verdade: linhas com código, ou linhas lidas com boa confiança.
function filtrarLinhas(linhas, manterDuvidosas) {
  return linhas.filter(l => {
    if ((l.texto.match(/[A-Za-zÀ-ú0-9]/g) || []).length < 2) return false;
    if (manterDuvidosas) return true;
    return temCodigo(l.texto) ? l.conf >= 30 : l.conf >= 65;
  });
}
// Nota de uma leitura = quantos fusíveis completos ela rende (código certo + amperagem), mais um pouco pela confiança.
function pontuar(linhas) {
  const itens = parseTexto(linhas.map(l => l.texto).join('\n'));
  const nota = itens.reduce((s, i) => s + (i.amperagem ? (i.obs ? 6 : 10) : 3), 0);
  return nota + (linhas.length ? linhas.reduce((s, l) => s + l.conf, 0) / linhas.length / 20 : 0);
}

// Automático: tenta cinza e preto-e-branco em modos diferentes e fica com a leitura que achou mais códigos.
async function lerFoto(worker, foto, modo, manterDuvidosas, progresso) {
  const cinza = await prepararImagem(foto);
  const tentativas = modo === 'auto'
    ? [['4', () => binarizar(cinza)], ['6', () => cinza], ['11', () => binarizar(cinza)]]
    : [[modo, () => cinza]];
  let melhor = null;
  for (let t = 0; t < tentativas.length; t++) {
    progresso(t + 1, tentativas.length);
    const [psm, img] = tentativas[t];
    const linhas = filtrarLinhas(await lerLinhas(worker, img(), psm), manterDuvidosas);
    const nota = pontuar(linhas);
    if (!melhor || nota > melhor.nota) melhor = { nota, linhas };
  }
  return melhor.linhas.map(l => l.texto).join('\n');
}

// Fila: as fotos são lidas uma de cada vez, em segundo plano; cada uma já joga os itens na tabela.
let fila = Promise.resolve();
let naFila = 0;
function atualizarProgresso() {
  $('#progresso').textContent = naFila ? `Lendo… ${naFila} foto${naFila > 1 ? 's' : ''} na fila` : '';
}
function enfileirarLeitura(foto) {
  if (!window.Tesseract) return aviso('OCR não carregou. Abra o app uma vez com internet.');
  if (foto.estado.startsWith('⏳')) return;
  foto.estado = '⏳ na fila';
  naFila++;
  renderFotos();
  atualizarProgresso();
  fila = fila.then(async () => {
    if (!fotos.includes(foto)) return; // removida enquanto esperava
    try {
      foto.estado = '⏳ lendo';
      renderFotos();
      const worker = await obterWorker();
      const txt = await lerFoto(worker, foto, $('#f-modo').value, $('#f-duvidosas').checked, (t, n) => {
        foto.estado = n > 1 ? `⏳ lendo ${t}/${n}` : '⏳ lendo';
        renderFotos();
      });
      acrescentarTexto(txt);
      const n = txt.trim() ? converterTexto(txt) : 0;
      foto.lida = true;
      foto.estado = n ? `✔ ${n} itens` : '⚠ nada lido';
    } catch (e) {
      console.error(e);
      foto.estado = '⚠ erro';
    } finally {
      naFila--;
      renderFotos();
      atualizarProgresso();
    }
  });
}

$('#b-ler').onclick = () => {
  const faltam = fotos.filter(f => !f.lida);
  if (!faltam.length) return aviso(fotos.length ? 'Todas as fotos já foram lidas. Toque numa foto para recortar e ler de novo.' : 'Adicione uma foto primeiro.');
  faltam.forEach(enfileirarLeitura);
};

// ---------- texto → itens ----------
// Aceita linhas como "FB1 Fusível principal 40A", "F12 - Ar condicionado (10A)", "SB 3: Buzina 15 A",
// tabela "F1 10 Luz de freio", e texto vindo coluna por coluna (Google Lens): todos os códigos, depois
// as amperagens, depois as descrições.
const AMPS_PADRAO = [1, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 70, 80, 100, 125, 150, 175, 200];
// Código colado ou com hífen/ponto: F1, FB12, SB-3. Com espaço ("Fo 75") é ruído do leitor, não código.
const RE_LINHA_CODIGO = /^([A-Za-z]{1,3})[-.]?([\dOolIi]{1,3}[a-z]?)(?![A-Za-z0-9])\s*[-–—:.=)]*\s*(.*)$/;
const RE_SO_AMP = /^([\dSsOo]{1,3}(?:[.,]\d)?)\s?A?$/i;
const RE_CABECALHO = /^(n[ºo°.]?|n[uú]mero|fus[ií]ve(l|is)|amp\.?|amperagem|a|fun[cç][aã]o|descri[cç][aã]o|circuito|item|c[oó]digo|nome|prote[cç][aã]o|aplica[cç][aã]o|-)$/i;

// O leitor troca letras por números parecidos: S→5, O→0, l/I→1. "75" (que não existe) vira 7.5.
function normalizarAmp(v) {
  const s = String(v).replace(',', '.').replace(/[Ss]/g, '5').replace(/[Oo]/g, '0').replace(/[lIi|]/g, '1');
  let n = Number(s);
  if (!isFinite(n) || n <= 0) return '';
  if (!AMPS_PADRAO.includes(n) && AMPS_PADRAO.includes(n / 10)) n = n / 10;
  return String(n);
}
const numeroCodigo = s => s.replace(/[Oo]/g, '0').replace(/[lIi]/g, '1');
const limparDescricao = s => s.replace(/\s+/g, ' ').replace(/^[-–—:.,;\s]+|[-–—:.,;\s]+$/g, '');
const ehCabecalho = l => l.split(/[\s/]+/).every(t => RE_CABECALHO.test(t));

// Separa amperagem e descrição do resto da linha.
function separarAmp(resto) {
  const a = resto.match(/\(?\b([\dSsOo]{1,3}(?:[.,]\d)?)\s?[Aa]\b\)?/)              // "10A", "SA", "75a", "(15 A)"
    || resto.match(/^([\dOoSs]{1,3}(?:[.,]\d)?)\s+(?=\D)/);                        // tabela: "10 Luz de freio", "4O …"
  if (a && /\d|^[Ss]$/.test(a[1])) {
    const amperagem = normalizarAmp(a[1]);
    if (amperagem) return { amperagem, descricao: limparDescricao(resto.replace(a[0], ' ')) };
  }
  return { amperagem: '', descricao: limparDescricao(resto) };
}

function parseTexto(txt) {
  const linhas = txt.split(/\r?\n/).map(l => l.replace(/[|_[\]{}]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(l => l && !ehCabecalho(l));
  return corrigirSequencia(porColunas(linhas) || porLinhas(linhas));
}

// aprox: o número veio de letras trocadas ("Fi" → F1, "Fo" → F0); a sequência pode corrigir depois.
function lerCodigo(linha) {
  const m = linha.match(RE_LINHA_CODIGO);
  if (!m || !/\d/.test(numeroCodigo(m[2]))) return null;
  return { codigo: (m[1] + numeroCodigo(m[2])).toUpperCase(), resto: m[3], aprox: !/^\d+[a-z]?$/.test(m[2]) };
}

// Uma linha por fusível: "F1 10A Luz de freio".
function porLinhas(linhas) {
  const itens = [];
  for (const linha of linhas) {
    const c = lerCodigo(linha);
    if (c && c.aprox) { itens.push({ codigo: null, bruto: c.codigo, palpite: c.codigo, ...separarAmp(c.resto), obs: '' }); continue; }
    if (c) { itens.push({ codigo: c.codigo, ...separarAmp(c.resto), obs: '' }); continue; }
    // começa com algo curto parecido com código e logo depois vem uma amperagem: "Fa 10 Farol", "FS 10A …"
    const q = linha.match(/^([A-Za-z][A-Za-z0-9é]{0,3})\s+(\S.*)$/);
    if (q && /^[\dSsOo]{1,3}([.,]\d)?\s?A?\b/.test(q[2]) && /\d/.test(q[2].split(' ')[0] + q[2].split(' ')[1])) {
      itens.push({ codigo: null, bruto: q[1], ...separarAmp(q[2]), obs: '' });
      continue;
    }
    // senão é continuação da descrição anterior (descrição quebrada em duas linhas)
    if (itens.length) itens[itens.length - 1].descricao = limparDescricao(itens[itens.length - 1].descricao + ' ' + linha);
  }
  return itens;
}

// Texto coluna por coluna: separa códigos, amperagens e descrições e junta pela ordem.
function porColunas(linhas) {
  const codigos = [], amps = [], descs = [];
  let comTexto = 0;
  for (const l of linhas) {
    const c = lerCodigo(l);
    if (c && !c.resto) codigos.push(c.codigo);
    else if (c && RE_SO_AMP.test(c.resto)) { codigos.push(c.codigo); amps.push(normalizarAmp(c.resto.replace(/a$/i, ''))); }
    else if (c) comTexto++;
    else if (RE_SO_AMP.test(l) && /\d|^[Ss]A?$/i.test(l)) amps.push(normalizarAmp(l.replace(/a$/i, '')));
    else descs.push(l);
  }
  if (codigos.length < 3 || comTexto >= codigos.length) return null;
  const conferir = amps.length !== codigos.length || descs.length !== codigos.length;
  return codigos.map((codigo, i) => ({
    codigo,
    amperagem: amps[i] || '',
    descricao: limparDescricao(descs[i] || ''),
    obs: conferir ? 'conferir (colunas com tamanhos diferentes)' : ''
  }));
}

// Códigos ilegíveis ("Fa", "FS") são deduzidos pelos vizinhos: entre F3 e F5 só pode ser F4.
function corrigirSequencia(itens) {
  const partes = c => { const m = c && c.match(/^([A-Z]+)(\d+)$/); return m ? { p: m[1], n: Number(m[2]) } : null; };
  const res = [];
  itens.forEach((it, i) => {
    if (it.codigo) return res.push(it);
    // o anterior já corrigido ajuda o próximo: "Fa", "FS" seguidos viram F4, F5
    const ant = partes(res.at(-1)?.codigo);
    const prox = partes(itens.slice(i + 1).find(x => x.codigo)?.codigo);
    const { bruto, palpite, ...resto } = it;
    const esperado = ant ? ant.p + (ant.n + 1) : prox ? prox.p + (prox.n - 1) : null;
    if (ant && prox && ant.p === prox.p && prox.n - ant.n === 2) res.push({ ...resto, codigo: esperado });
    else if (palpite && palpite === esperado) res.push({ ...resto, codigo: palpite });
    else if (palpite) res.push({ ...resto, codigo: palpite, obs: 'conferir código' });
    else if (esperado && bruto.toUpperCase().startsWith((ant || prox).p)) res.push({ ...resto, codigo: esperado, obs: 'conferir código' });
    else res.push({ ...resto, codigo: bruto.toUpperCase() + '?', obs: 'conferir código' });
  });
  return res;
}

// Converte o texto e junta com a tabela: código novo entra no fim; código que já existe é atualizado
// (assim dá para corrigir o texto e converter de novo), mantendo a posição na caixa.
// texto: só o trecho novo (foto recém-lida, texto colado); sem ele, converte a caixa de texto toda.
function converterTexto(texto = $('#f-texto').value) {
  const novos = parseTexto(texto);
  if (!novos.length) { aviso('Não achei linhas com código (ex: FB1, F12).'); return 0; }
  const itens = lerTabela().filter(i => i.codigo || i.descricao);
  let adicionados = 0, atualizados = 0;
  for (const n of novos) {
    const ex = itens.find(i => i.codigo === n.codigo);
    if (!ex) { itens.push(n); adicionados++; }
    else if (ex.descricao !== n.descricao || ex.amperagem !== n.amperagem) {
      Object.assign(ex, { descricao: n.descricao, amperagem: n.amperagem, obs: n.obs || ex.obs });
      atualizados++;
    }
  }
  renderTabela(itens);
  const duvidas = novos.filter(n => n.obs).length;
  aviso(`${adicionados} adicionados` + (atualizados ? `, ${atualizados} atualizados` : '') + (duvidas ? ` · ${duvidas} para conferir` : ''));
  return novos.length;
}
$('#b-converter').onclick = () => converterTexto();

function acrescentarTexto(txt) {
  const atual = $('#f-texto').value.trim();
  $('#f-texto').value = (atual ? atual + '\n' : '') + txt.trim();
}
$('#b-colar').onclick = async () => {
  try {
    const txt = await navigator.clipboard.readText();
    if (!txt.trim()) return aviso('A área de transferência está vazia.');
    acrescentarTexto(txt);
    converterTexto(txt);
  } catch {
    $('#f-texto').focus();
    aviso('Toque e segure na caixa de texto e escolha Colar.');
  }
};

// Texto compartilhado de outro app (Google Lens → Compartilhar → Diagramas) chega como ?texto=…
function receberCompartilhado() {
  const q = new URLSearchParams(location.search);
  const txt = [q.get('titulo'), q.get('texto'), q.get('link')].filter(Boolean).join('\n');
  if (!txt.trim()) return;
  history.replaceState(null, '', location.pathname); // limpa a URL para não repetir ao recarregar
  abrirAba('novo');
  acrescentarTexto(txt);
  converterTexto(txt);
  $('#f-texto').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ---------- tabela de itens ----------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function linhaTabela(i = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input data-c="codigo" value="${esc(i.codigo)}"></td>
    <td><input data-c="descricao" value="${esc(i.descricao)}"></td>
    <td><input data-c="amperagem" value="${esc(i.amperagem)}" inputmode="decimal"></td>
    <td><input data-c="obs" value="${esc(i.obs)}"></td>
    <td><button class="perigo" title="Remover">✕</button></td>`;
  if (i.posicao) tr.dataset.pos = JSON.stringify(i.posicao);
  tr.querySelector('button').onclick = () => { tr.remove(); renderPosicoes(); };
  return tr;
}
function renderTabela(itens) {
  const tb = $('#tabela-itens tbody');
  tb.innerHTML = '';
  itens.forEach(i => tb.appendChild(linhaTabela(i)));
  renderPosicoes();
}
function lerTabela() {
  return [...document.querySelectorAll('#tabela-itens tbody tr')].map(tr => {
    const o = {};
    tr.querySelectorAll('input').forEach(inp => o[inp.dataset.c] = inp.value.trim());
    o.codigo = o.codigo.toUpperCase().replace(/\s+/g, '');
    if (tr.dataset.pos) o.posicao = JSON.parse(tr.dataset.pos);
    return o;
  });
}
$('#b-add-linha').onclick = () => $('#tabela-itens tbody').appendChild(linhaTabela());
$('#tabela-itens tbody').addEventListener('change', () => renderPosicoes());

// ---------- salvar / editar ----------
const CAMPOS = ['marca', 'modelo', 'ano', 'versao', 'tipo', 'local', 'fonte', 'notas'];
$('#b-salvar').onclick = () => {
  const d = { id: editandoId || crypto.randomUUID() };
  CAMPOS.forEach(c => d[c] = $('#f-' + c).value.trim());
  d.ano = d.ano ? Number(d.ano) : null;
  d.itens = lerTabela().filter(i => i.codigo || i.descricao);
  d.layout = d.itens.some(i => i.posicao) ? lerLayout() : null;
  if (!d.modelo || !d.ano) return aviso('Preencha pelo menos modelo e ano.');
  if (!d.itens.length) return aviso('Não há itens para salvar.');
  const antigo = diagramas.find(x => x.id === d.id);
  d.criadoEm = antigo?.criadoEm || new Date().toISOString();
  d.atualizadoEm = new Date().toISOString();
  diagramas = antigo ? diagramas.map(x => x.id === d.id ? d : x) : [...diagramas, d];
  if (gravar(diagramas)) {
    aviso(`Salvo: ${d.modelo} ${d.ano} (${d.itens.length} itens)`);
    limparForm();
    if (fixado()) $('#f-ano').value = proximoAno(d.ano) ?? '';
  }
};

// Com o veículo fixado, marca/modelo/tipo/local continuam preenchidos; só o ano (e versão) mudam.
const FIXOS = ['marca', 'modelo', 'tipo', 'local'];
function limparForm() {
  editandoId = null;
  $('#titulo-form').textContent = 'Novo diagrama';
  CAMPOS.forEach(c => { if (!(fixado() && FIXOS.includes(c))) $('#f-' + c).value = c === 'tipo' ? 'Caixa de fusíveis' : ''; });
  $('#f-texto').value = '';
  fotos.forEach(f => URL.revokeObjectURL(f.url));
  fotos = [];
  renderFotos();
  definirLayout(null);
  $('#p-preview').innerHTML = '';
  renderTabela([]);
  $('#progresso').textContent = '';
  atualizarSugestoes();
  renderAnosVeiculo();
}
$('#b-limpar').onclick = () => limparForm();

// ---------- veículo fixado + passo de anos ----------
const CHAVE_PREFS = 'prefs-v1';
const fixado = () => $('#f-fixar').checked;
function salvarPrefs() {
  const p = { fixar: fixado(), passo: $('#f-passo').value, direcao: $('#f-direcao').value, veiculo: {} };
  FIXOS.forEach(c => p.veiculo[c] = $('#f-' + c).value);
  try { localStorage.setItem(CHAVE_PREFS, JSON.stringify(p)); } catch {}
}
function carregarPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(CHAVE_PREFS)); } catch {}
  if (!p) return;
  $('#f-passo').value = p.passo || 5;
  $('#f-direcao').value = p.direcao || '-1';
  $('#f-fixar').checked = !!p.fixar;
  if (p.fixar) FIXOS.forEach(c => { if (p.veiculo?.[c]) $('#f-' + c).value = p.veiculo[c]; });
}
function aoMudarVeiculo() {
  document.body.classList.toggle('fixado', fixado());
  salvarPrefs();
  renderAnosVeiculo();
}
['#f-fixar', '#f-passo', '#f-direcao'].forEach(s => $(s).addEventListener('change', aoMudarVeiculo));
FIXOS.forEach(c => $('#f-' + c).addEventListener('input', aoMudarVeiculo));
$('#f-ano').addEventListener('input', renderAnosVeiculo);

const veiculoDoForm = () => Object.fromEntries(FIXOS.map(c => [c, $('#f-' + c).value]));
const anosDoGrupo = k => [...new Set(diagramas.filter(d => chaveGrupo(d) === k).map(d => d.ano))].sort((a, b) => a - b);

// Próximo ano seguindo o passo e a direção, pulando anos já salvos.
function proximoAno(base) {
  const passo = Math.max(1, Number($('#f-passo').value) || 5);
  const dir = Number($('#f-direcao').value) || -1;
  const salvos = new Set(anosDoGrupo(chaveGrupo(veiculoDoForm())));
  for (let ano = base + passo * dir; ano >= 1950 && ano <= new Date().getFullYear() + 1; ano += passo * dir) {
    if (!salvos.has(ano)) return ano;
  }
  return null;
}

// Entre dois anos salvos com diferença, sugere o ano do meio (busca binária até achar o ano exato da mudança).
function lacunas(k) {
  const lista = diagramas.filter(d => chaveGrupo(d) === k).sort((a, b) => (a.ano || 0) - (b.ano || 0));
  const difs = contarDiferencas(lista);
  const res = [];
  for (let i = 1; i < lista.length; i++) {
    const a = lista[i - 1].ano, b = lista[i].ano;
    if (difs[i] && b - a > 1) res.push({ de: a, ate: b, meio: Math.floor((a + b) / 2), difs: difs[i] });
    if (difs[i] && b - a === 1) res.push({ de: a, ate: b, achou: true, difs: difs[i] });
  }
  return res;
}

function renderAnosVeiculo() {
  const box = $('#anos-veiculo');
  const v = veiculoDoForm();
  if (!v.modelo) { box.innerHTML = ''; return; }
  const k = chaveGrupo(v);
  const anos = anosDoGrupo(k);
  if (!anos.length) { box.innerHTML = `Nenhum ano salvo ainda para ${esc(v.modelo)}.`; return; }
  const gaps = lacunas(k);
  const sugerir = gaps.filter(g => !g.achou);
  const achados = gaps.filter(g => g.achou);
  const anoAtual = Number($('#f-ano').value);
  box.innerHTML = `
    <div class="anos">Já salvos: ${anos.map(a => `<span>${a}</span>`).join('')}</div>
    ${sugerir.length ? `<div class="anos">Mudou no meio, fotografe: ${sugerir.map(g =>
      `<button class="secundario" data-ano="${g.meio}" title="${g.difs} diferença(s) entre ${g.de} e ${g.ate}">${g.meio}</button>`).join('')}</div>` : ''}
    ${achados.map(g => `<div>✔ Mudança encontrada exatamente de ${g.de} para ${g.ate}.</div>`).join('')}
    ${anoAtual && anos.includes(anoAtual) && !editandoId ? `<div>⚠ ${anoAtual} já está salvo.</div>` : ''}`;
  box.querySelectorAll('[data-ano]').forEach(b => b.onclick = () => { $('#f-ano').value = b.dataset.ano; renderAnosVeiculo(); });
}

// Abre o formulário já com o veículo do grupo e o ano sugerido (usado pela aba Comparar).
function novoParaAno(d, ano) {
  limparForm();
  FIXOS.forEach(c => $('#f-' + c).value = d[c] ?? '');
  $('#f-ano').value = ano;
  aoMudarVeiculo();
  abrirAba('novo');
}

function editar(id) {
  const d = diagramas.find(x => x.id === id);
  if (!d) return;
  limparForm();
  editandoId = id;
  CAMPOS.forEach(c => $('#f-' + c).value = d[c] ?? '');
  definirLayout(d.layout);
  renderTabela(d.itens);
  $('#titulo-form').textContent = `Editando: ${d.modelo} ${d.ano}`;
  renderAnosVeiculo();
  abrirAba('novo');
}

// "Duplicar para outro ano": começa com os mesmos itens, você só corrige o que mudou.
function duplicar(id) {
  const d = diagramas.find(x => x.id === id);
  if (!d) return;
  limparForm();
  CAMPOS.forEach(c => $('#f-' + c).value = c === 'ano' ? '' : (d[c] ?? ''));
  definirLayout(d.layout);
  renderTabela(d.itens);
  $('#f-ano').value = proximoAno(d.ano) ?? '';
  $('#titulo-form').textContent = `Novo (copiado de ${d.modelo} ${d.ano})`;
  renderAnosVeiculo();
  abrirAba('novo');
  $('#f-ano').focus();
}

function excluir(id) {
  const d = diagramas.find(x => x.id === id);
  if (!d || !confirm(`Excluir ${d.modelo} ${d.ano}?`)) return;
  diagramas = diagramas.filter(x => x.id !== id);
  gravar(diagramas);
  renderLista();
}

function atualizarSugestoes() {
  const preencher = (id, campo) => {
    const vals = [...new Set(diagramas.map(d => d[campo]).filter(Boolean))].sort();
    $(id).innerHTML = vals.map(v => `<option value="${esc(v)}">`).join('');
  };
  preencher('#lista-marcas', 'marca');
  preencher('#lista-modelos', 'modelo');
  preencher('#lista-locais', 'local');
}

// ---------- posições na caixa ----------
// Cada item guarda posicao: { linha, coluna, largura, altura } (contando a partir de 1, em células da grade).
// O diagrama guarda layout: { linhas, colunas }.
let selCodigo = null;    // código escolhido para colocar
let selColocado = null;  // fusível já colocado que está selecionado

function lerLayout() {
  const lim = v => Math.min(30, Math.max(1, Number(v) || 1));
  return { linhas: lim($('#p-linhas').value), colunas: lim($('#p-colunas').value) };
}
function definirLayout(l) {
  $('#p-linhas').value = l?.linhas || 4;
  $('#p-colunas').value = l?.colunas || 6;
  selCodigo = selColocado = null;
}
['#p-linhas', '#p-colunas'].forEach(s => $(s).addEventListener('input', () => renderPosicoes()));

function trDoCodigo(codigo) {
  return [...document.querySelectorAll('#tabela-itens tbody tr')]
    .find(tr => tr.querySelector('[data-c=codigo]').value.toUpperCase().replace(/\s+/g, '') === codigo);
}
function definirPos(codigo, pos) {
  const tr = trDoCodigo(codigo);
  if (!tr) return;
  if (pos) tr.dataset.pos = JSON.stringify(pos); else delete tr.dataset.pos;
}

// Células ocupadas ("linha,coluna"), ignorando um código (útil ao mover/redimensionar ele mesmo).
function ocupadas(itens, exceto) {
  const s = new Set();
  for (const i of itens) {
    if (!i.posicao || i.codigo === exceto) continue;
    const p = i.posicao;
    for (let l = p.linha; l < p.linha + p.altura; l++)
      for (let c = p.coluna; c < p.coluna + p.largura; c++) s.add(l + ',' + c);
  }
  return s;
}
function cabe(itens, codigo, p) {
  const L = lerLayout();
  if (p.linha < 1 || p.coluna < 1 || p.largura < 1 || p.altura < 1) return false;
  if (p.linha + p.altura - 1 > L.linhas || p.coluna + p.largura - 1 > L.colunas) return false;
  const occ = ocupadas(itens, codigo);
  for (let l = p.linha; l < p.linha + p.altura; l++)
    for (let c = p.coluna; c < p.coluna + p.largura; c++) if (occ.has(l + ',' + c)) return false;
  return true;
}

// Cores padrão de fusível lâmina (mini/ATO) por amperagem.
const CORES_AMP = {
  '1': '#111111', '2': '#9e9e9e', '3': '#8e44ad', '4': '#f48fb1', '5': '#d2b48c', '7.5': '#8d6e63',
  '10': '#e53935', '15': '#1e88e5', '20': '#fdd835', '25': '#f5f5f5', '30': '#43a047', '35': '#26c6da', '40': '#fb8c00'
};
const ESCURAS = new Set(['#111111', '#8e44ad', '#8d6e63', '#e53935', '#1e88e5', '#43a047']);
function corItem(i) {
  const fundo = CORES_AMP[String(Number(i.amperagem))] || '#cfd8dc';
  return { fundo, texto: ESCURAS.has(fundo) ? '#ffffff' : '#111111' };
}

function renderPosicoes() {
  const itens = lerTabela().filter(i => i.codigo);
  const L = lerLayout();
  // descarta posições que ficaram fora da grade ao diminuir linhas/colunas
  for (const i of itens) {
    if (i.posicao && (i.posicao.linha + i.posicao.altura - 1 > L.linhas || i.posicao.coluna + i.posicao.largura - 1 > L.colunas)) {
      definirPos(i.codigo, null);
      delete i.posicao;
    }
  }
  if (selColocado && !itens.some(i => i.codigo === selColocado && i.posicao)) selColocado = null;

  // códigos ainda sem posição
  const soltos = itens.filter(i => !i.posicao);
  if (selCodigo && !soltos.some(i => i.codigo === selCodigo)) selCodigo = null;
  const box = $('#p-codigos');
  box.innerHTML = (soltos.length ? 'Colocar: ' : (itens.length ? '✔ Todos posicionados ' : 'Adicione itens primeiro ')) +
    soltos.map(i => `<button class="secundario${i.codigo === selCodigo ? ' sel' : ''}" data-cod="${esc(i.codigo)}">${esc(i.codigo)}</button>`).join('') +
    ' <button class="secundario" data-outro>+ Outro (relé…)</button>';
  box.querySelectorAll('[data-cod]').forEach(b => b.onclick = () => {
    selCodigo = selCodigo === b.dataset.cod ? null : b.dataset.cod;
    selColocado = null;
    renderPosicoes();
  });
  box.querySelector('[data-outro]').onclick = () => {
    const codigo = (prompt('Código (ex: R1, J5):') || '').toUpperCase().replace(/\s+/g, '');
    if (!codigo) return;
    if (trDoCodigo(codigo)) return aviso(`${codigo} já existe na lista.`);
    const descricao = prompt('O que é?') || '';
    $('#tabela-itens tbody').appendChild(linhaTabela({ codigo, descricao, amperagem: '', obs: '' }));
    selCodigo = codigo;
    renderPosicoes();
  };

  // controles do fusível selecionado
  const sel = $('#p-sel');
  const atual = itens.find(i => i.codigo === selColocado);
  if (atual) {
    sel.innerHTML = `<strong>${esc(atual.codigo)}</strong>
      Largura <button class="secundario" data-r="largura,-1">−</button><button class="secundario" data-r="largura,1">+</button>
      Altura <button class="secundario" data-r="altura,-1">−</button><button class="secundario" data-r="altura,1">+</button>
      <button class="perigo" data-tirar>Tirar</button>
      <span class="dica">ou toque num espaço vazio para mover</span>`;
    sel.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
      const [campo, delta] = b.dataset.r.split(',');
      const p = { ...atual.posicao, [campo]: atual.posicao[campo] + Number(delta) };
      if (!cabe(itens, atual.codigo, p)) return aviso('Não cabe aí.');
      definirPos(atual.codigo, p);
      renderPosicoes();
    });
    sel.querySelector('[data-tirar]').onclick = () => { definirPos(atual.codigo, null); selColocado = null; renderPosicoes(); };
  } else {
    sel.innerHTML = '';
  }

  // grade
  const grade = $('#p-grade');
  grade.style.gridTemplateColumns = `repeat(${L.colunas}, 64px)`;
  grade.style.gridTemplateRows = `repeat(${L.linhas}, 52px)`;
  grade.innerHTML = '';
  const occ = ocupadas(itens);
  for (let l = 1; l <= L.linhas; l++) {
    for (let c = 1; c <= L.colunas; c++) {
      if (occ.has(l + ',' + c)) continue;
      const b = document.createElement('button');
      b.className = 'vazio';
      b.style.gridArea = `${l} / ${c}`;
      b.title = `Linha ${l}, coluna ${c}`;
      b.onclick = () => clicarVazio(itens, l, c);
      grade.appendChild(b);
    }
  }
  for (const i of itens.filter(i => i.posicao)) {
    const p = i.posicao;
    const cor = corItem(i);
    const d = document.createElement('div');
    d.className = 'fus' + (i.codigo === selColocado ? ' sel' : '');
    d.style.gridArea = `${p.linha} / ${p.coluna} / span ${p.altura} / span ${p.largura}`;
    d.style.background = cor.fundo;
    d.style.color = cor.texto;
    d.title = `${i.codigo} ${i.descricao}`;
    d.innerHTML = `<b>${esc(i.codigo)}</b>${i.amperagem ? esc(i.amperagem) + 'A ' : ''}${esc(i.descricao)}`;
    d.onclick = () => { selColocado = selColocado === i.codigo ? null : i.codigo; selCodigo = null; renderPosicoes(); };
    grade.appendChild(d);
  }
}

function clicarVazio(itens, linha, coluna) {
  if (selCodigo) {
    definirPos(selCodigo, { linha, coluna, largura: 1, altura: 1 });
    // seleciona automaticamente o próximo código sem posição, para ir tocando em sequência
    const idx = itens.findIndex(i => i.codigo === selCodigo);
    const prox = itens.slice(idx + 1).concat(itens.slice(0, idx)).find(i => !i.posicao && i.codigo !== selCodigo);
    selCodigo = prox ? prox.codigo : null;
  } else if (selColocado) {
    const atual = itens.find(i => i.codigo === selColocado);
    const p = { ...atual.posicao, linha, coluna };
    if (!cabe(itens, atual.codigo, p)) return aviso('Não cabe aí.');
    definirPos(atual.codigo, p);
  } else {
    return aviso('Escolha um código primeiro.');
  }
  renderPosicoes();
}

$('#p-ref').onclick = () => {
  const img = $('#p-foto');
  if (!img.hidden) { img.hidden = true; $('#p-ref').textContent = 'Mostrar foto'; return; }
  if (!fotos.length) return aviso('Nenhuma foto nesta sessão.');
  img.src = fotos[fotos.length - 1].url;
  img.hidden = false;
  $('#p-ref').textContent = 'Esconder foto';
};

// ---------- imagem SVG ----------
const escXml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// Quebra o texto em até `max` linhas de `n` caracteres.
function quebrar(txt, n, max) {
  const linhas = [];
  let atual = '';
  for (const p of String(txt || '').split(' ')) {
    if ((atual + ' ' + p).trim().length > n && atual) { linhas.push(atual); atual = p; }
    else atual = (atual + ' ' + p).trim();
  }
  if (atual) linhas.push(atual);
  if (linhas.length > max) { linhas.length = max; linhas[max - 1] = linhas[max - 1].slice(0, n - 1) + '…'; }
  return linhas.map(l => l.length > n ? l.slice(0, n - 1) + '…' : l);
}

function gerarSVG(d) {
  const L = d.layout;
  const W = 96, H = 68, G = 6, M = 16, T = 44;
  const larg = M * 2 + L.colunas * W + (L.colunas - 1) * G;
  const alt = T + M + L.linhas * H + (L.linhas - 1) * G;
  const titulo = [d.marca, d.modelo, d.ano, d.versao].filter(Boolean).join(' ');
  const sub = [d.tipo, d.local].filter(Boolean).join(' — ');
  const blocos = d.itens.filter(i => i.posicao).map(i => {
    const p = i.posicao;
    const x = M + (p.coluna - 1) * (W + G), y = T + (p.linha - 1) * (H + G);
    const w = p.largura * W + (p.largura - 1) * G, h = p.altura * H + (p.altura - 1) * G;
    const cor = corItem(i);
    const desc = quebrar(i.descricao, Math.floor((w - 8) / 5.6), Math.max(1, Math.floor((h - 34) / 12)));
    return `  <g class="fusivel" data-codigo="${escXml(i.codigo)}" data-amperagem="${escXml(i.amperagem)}">
    <title>${escXml(`${i.codigo} ${i.amperagem ? i.amperagem + 'A ' : ''}${i.descricao}`)}</title>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${cor.fundo}" stroke="#333" stroke-width="1.5"/>
    <text x="${x + 6}" y="${y + 17}" font-size="14" font-weight="700" fill="${cor.texto}">${escXml(i.codigo)}</text>
    ${i.amperagem ? `<text x="${x + w - 6}" y="${y + 17}" font-size="12" text-anchor="end" fill="${cor.texto}">${escXml(i.amperagem)}A</text>` : ''}
    ${desc.map((t, n) => `<text x="${x + 6}" y="${y + 33 + n * 12}" font-size="10" fill="${cor.texto}">${escXml(t)}</text>`).join('\n    ')}
  </g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${larg}" height="${alt}" viewBox="0 0 ${larg} ${alt}" font-family="Arial, Helvetica, sans-serif">
  <rect width="${larg}" height="${alt}" fill="#ffffff"/>
  <text x="${M}" y="20" font-size="15" font-weight="700" fill="#111">${escXml(titulo)}</text>
  <text x="${M}" y="36" font-size="11" fill="#555">${escXml(sub)}</text>
  <rect x="${M - 4}" y="${T - 4}" width="${larg - 2 * M + 8}" height="${alt - T - M + 8}" rx="8" fill="#eceff1" stroke="#90a4ae"/>
${blocos.join('\n')}
</svg>
`;
}

function nomeArquivo(d) {
  return [d.modelo, d.ano, d.tipo, d.local].filter(Boolean).map(s => normalizar(s).replace(/[^a-z0-9]+/g, '-')).join('_') + '.svg';
}
function diagramaDoForm() {
  const d = {};
  CAMPOS.forEach(c => d[c] = $('#f-' + c).value.trim());
  d.itens = lerTabela().filter(i => i.codigo);
  d.layout = lerLayout();
  return d;
}
$('#p-svg').onclick = () => {
  const d = diagramaDoForm();
  if (!d.itens.some(i => i.posicao)) return aviso('Posicione pelo menos um fusível.');
  $('#p-preview').innerHTML = gerarSVG(d);
};
$('#p-baixar').onclick = () => {
  const d = diagramaDoForm();
  if (!d.itens.some(i => i.posicao)) return aviso('Posicione pelo menos um fusível.');
  baixar(nomeArquivo(d), gerarSVG(d), 'image/svg+xml');
};

// ---------- biblioteca ----------
const chaveGrupo = d => [d.marca, d.modelo, d.tipo, d.local].map(s => normalizar(s)).join('|');
const nomeGrupo = d => [d.marca, d.modelo].filter(Boolean).join(' ') + ` — ${d.tipo}` + (d.local ? ` (${d.local})` : '');
function normalizar(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

$('#busca').oninput = () => renderLista();
function renderLista() {
  const q = normalizar($('#busca').value);
  const filtrados = diagramas.filter(d => !q || normalizar(JSON.stringify(d)).includes(q));
  const grupos = {};
  filtrados.forEach(d => (grupos[chaveGrupo(d)] ??= []).push(d));
  const box = $('#lista');
  box.innerHTML = filtrados.length ? '' : '<p class="dica">Nada salvo ainda.</p>';
  Object.values(grupos).forEach(lista => {
    lista.sort((a, b) => (b.ano || 0) - (a.ano || 0));
    const g = document.createElement('div');
    g.className = 'grupo';
    g.innerHTML = `<h3>${esc(nomeGrupo(lista[0]))}</h3>`;
    lista.forEach(d => {
      const c = document.createElement('div');
      c.className = 'cartao';
      c.innerHTML = `
        <div class="info"><strong>${d.ano}</strong> ${esc(d.versao)}
          <small>${d.itens.length} itens${d.fonte ? ' · ' + esc(d.fonte) : ''}</small></div>
        <div class="acoes">
          ${d.layout ? '<button class="secundario" data-a="svg" title="Baixar imagem das posições">SVG</button>' : ''}
          <button class="secundario" data-a="editar">Editar</button>
          <button class="secundario" data-a="duplicar" title="Copiar itens para outro ano">Outro ano</button>
          <button class="perigo" data-a="excluir">Excluir</button>
        </div>`;
      c.querySelector('[data-a=svg]')?.addEventListener('click', () => baixar(nomeArquivo(d), gerarSVG(d), 'image/svg+xml'));
      c.querySelector('[data-a=editar]').onclick = () => editar(d.id);
      c.querySelector('[data-a=duplicar]').onclick = () => duplicar(d.id);
      c.querySelector('[data-a=excluir]').onclick = () => excluir(d.id);
      g.appendChild(c);
    });
    box.appendChild(g);
  });
}

// ---------- exportar / importar (só texto) ----------
function ordenados() {
  return [...diagramas].sort((a, b) => chaveGrupo(a).localeCompare(chaveGrupo(b)) || (a.ano || 0) - (b.ano || 0));
}
function limpo(d) {
  const { marca, modelo, ano, versao, tipo, local, fonte, notas, layout = null, itens } = d;
  return { marca, modelo, ano, versao, tipo, local, fonte, notas, layout, itens };
}
function baixar(nome, conteudo, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#b-exp-js').onclick = () => {
  if (!diagramas.length) return aviso('Nada para exportar.');
  const js = `// Gerado por Foto → Diagrama em ${new Date().toLocaleString('pt-BR')}\n` +
    `export const diagramas = ${JSON.stringify(ordenados().map(limpo), null, 2)};\n\nexport default diagramas;\n`;
  baixar('diagramas.js', js, 'text/javascript');
};
$('#b-exp-json').onclick = () => {
  if (!diagramas.length) return aviso('Nada para exportar.');
  baixar('diagramas.json', JSON.stringify(ordenados().map(limpo), null, 2), 'application/json');
};
$('#f-importar').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const lista = JSON.parse(await f.text());
    if (!Array.isArray(lista)) throw new Error('formato inválido');
    let n = 0;
    for (const d of lista) {
      if (!d.modelo || !Array.isArray(d.itens)) continue;
      const repetido = diagramas.some(x => chaveGrupo(x) === chaveGrupo(d) && x.ano === d.ano && (x.versao || '') === (d.versao || ''));
      if (repetido) continue;
      diagramas.push({ ...d, id: crypto.randomUUID(), criadoEm: new Date().toISOString() });
      n++;
    }
    gravar(diagramas);
    renderLista();
    aviso(`${n} diagramas importados`);
  } catch (err) {
    aviso('Não consegui importar: ' + err.message);
  }
  e.target.value = '';
};

// ---------- comparar anos ----------
function renderGrupos() {
  const grupos = {};
  diagramas.forEach(d => (grupos[chaveGrupo(d)] ??= []).push(d));
  const sel = $('#c-grupo');
  const atual = sel.value;
  sel.innerHTML = Object.entries(grupos)
    .map(([k, l]) => `<option value="${esc(k)}">${esc(nomeGrupo(l[0]))} · ${l.length} anos</option>`).join('');
  if (atual && grupos[atual]) sel.value = atual;
  renderMatriz();
}
$('#c-grupo').onchange = renderMatriz;
$('#c-so-mudancas').onchange = renderMatriz;

const ordemCodigo = (a, b) => a.localeCompare(b, 'pt', { numeric: true });
const assinatura = i => i ? normalizar(i.descricao) + '|' + (i.amperagem || '') : null;

const posTxt = p => p ? `L${p.linha} C${p.coluna}` + (p.largura > 1 || p.altura > 1 ? ` (${p.largura}×${p.altura})` : '') : '';

// Mudou descrição/amperagem, ou mudou de lugar (só conta posição se os dois anos tiverem posição).
function difere(a, b) {
  if (!a || !b) return !!a !== !!b;
  if (assinatura(a) !== assinatura(b)) return true;
  return !!(a.posicao && b.posicao) && posTxt(a.posicao) !== posTxt(b.posicao);
}

// Quantas diferenças cada diagrama tem em relação ao anterior da lista (posição 0 = sempre 0).
function contarDiferencas(lista) {
  const mapas = lista.map(d => Object.fromEntries(d.itens.map(i => [i.codigo, i])));
  const codigos = new Set(lista.flatMap(d => d.itens.map(i => i.codigo)));
  return mapas.map((m, col) => col === 0 ? 0 : [...codigos].filter(c => difere(m[c], mapas[col - 1][c])).length);
}

function renderMatriz() {
  const k = $('#c-grupo').value;
  const tabela = $('#c-matriz');
  const resumo = $('#c-resumo');
  const lista = diagramas.filter(d => chaveGrupo(d) === k)
    .sort((a, b) => (a.ano || 0) - (b.ano || 0) || (a.versao || '').localeCompare(b.versao || ''));
  if (!lista.length) { tabela.innerHTML = ''; resumo.innerHTML = '<p class="dica">Salve pelo menos um diagrama.</p>'; return; }

  const mapas = lista.map(d => Object.fromEntries(d.itens.map(i => [i.codigo, i])));
  const codigos = [...new Set(lista.flatMap(d => d.itens.map(i => i.codigo)))].sort(ordemCodigo);
  const mudancas = lista.map(() => 0);
  const soMudancas = $('#c-so-mudancas').checked;

  let html = '<thead><tr><th>Código</th>' +
    lista.map(d => `<th>${d.ano}${d.versao ? `<br><small>${esc(d.versao)}</small>` : ''}</th>`).join('') + '</tr></thead><tbody>';
  for (const cod of codigos) {
    let teveMudanca = false;
    const celulas = lista.map((d, col) => {
      const item = mapas[col][cod];
      const ant = col > 0 ? mapas[col - 1][cod] : undefined;
      let cls = '';
      if (col > 0) {
        if (item && !ant) cls = 'novo';
        else if (!item && ant) cls = 'removido';
        else if (item && ant && difere(item, ant)) cls = 'mudou';
      }
      if (cls) { teveMudanca = true; mudancas[col]++; }
      if (!item) return `<td class="${cls}">${cls ? '<small>(não existe)</small>' : '—'}</td>`;
      return `<td class="${cls}">${esc(item.descricao)}${item.amperagem ? ` <small>${esc(item.amperagem)}A</small>` : ''}` +
        `${item.posicao ? `<br><small>📍 ${posTxt(item.posicao)}</small>` : ''}${item.obs ? `<br><small>${esc(item.obs)}</small>` : ''}</td>`;
    });
    if (soMudancas && !teveMudanca) continue;
    html += `<tr><td>${esc(cod)}</td>${celulas.join('')}</tr>`;
  }
  tabela.innerHTML = html + '</tbody>';

  const linhas = lista.slice(1).map((d, i) => {
    const n = mudancas[i + 1];
    const a = lista[i].ano, b = d.ano;
    let extra = '';
    if (n && b - a > 1) extra = ` <button class="secundario" data-ano="${Math.floor((a + b) / 2)}">📷 Fotografar ${Math.floor((a + b) / 2)}</button>`;
    else if (n && b - a === 1) extra = ' ✔ ano exato da mudança';
    return `<li>${a} → ${b}: ${n ? `<strong>${n} diferença${n > 1 ? 's' : ''}</strong>${extra}` : 'igual'}</li>`;
  });
  resumo.innerHTML = linhas.length ? `<ul>${linhas.join('')}</ul>` : '<p class="dica">Adicione outro ano para comparar.</p>';
  resumo.querySelectorAll('[data-ano]').forEach(b => b.onclick = () => novoParaAno(lista[0], Number(b.dataset.ano)));
}

// ---------- modo offline ----------
// Registra o service worker e, com internet, já deixa o leitor de texto baixado para usar sem sinal.
async function prepararOffline() {
  const st = $('#status-offline');
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    navigator.storage?.persist?.(); // pede para o navegador não apagar os dados salvos
    if (!window.Tesseract) { st.textContent = '⚠ sem leitor (abra com internet)'; return; }
    st.textContent = '⏳ preparando offline…';
    await obterWorker();
    st.textContent = '✔ funciona offline';
  } catch (e) {
    console.error(e);
    st.textContent = navigator.onLine ? '' : '⚠ abra com internet uma vez';
  }
}
window.addEventListener('load', () => setTimeout(prepararOffline, 500));

carregarPrefs();
document.body.classList.toggle('fixado', fixado());
atualizarSugestoes();
renderAnosVeiculo();
renderPosicoes();
receberCompartilhado();

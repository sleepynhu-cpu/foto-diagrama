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
function addFotos(arquivos) {
  for (const f of arquivos) fotos.push({ url: URL.createObjectURL(f), arquivo: f });
  renderFotos();
}
function renderFotos() {
  const box = $('#fotos');
  box.innerHTML = '';
  fotos.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'foto';
    d.innerHTML = `<img src="${f.url}"><button title="Remover">✕</button>`;
    d.querySelector('button').onclick = () => { URL.revokeObjectURL(f.url); fotos.splice(i, 1); renderFotos(); };
    box.appendChild(d);
  });
}

// Escala de cinza + ampliação melhora bastante a leitura do Tesseract.
async function prepararImagem(arquivo) {
  const img = await createImageBitmap(arquivo);
  const escala = Math.min(3, Math.max(1, 2000 / Math.max(img.width, img.height)));
  const c = document.createElement('canvas');
  c.width = img.width * escala;
  c.height = img.height * escala;
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// O worker é criado uma vez só; criar já baixa (e guarda) o leitor e o idioma para uso offline.
let workerPromise = null;
function obterWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('por+eng', 1, {
      logger: m => { if (m.status === 'recognizing text') $('#progresso').textContent = `Lendo… ${Math.round(m.progress * 100)}%`; }
    }).then(async w => {
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    });
    workerPromise.catch(() => { workerPromise = null; });
  }
  return workerPromise;
}

$('#b-ler').onclick = async () => {
  if (!fotos.length) return aviso('Adicione uma foto primeiro.');
  if (!window.Tesseract) return aviso('OCR não carregou. Abra o app uma vez com internet.');
  const botao = $('#b-ler');
  const prog = $('#progresso');
  botao.disabled = true;
  try {
    prog.textContent = 'Preparando o leitor…';
    const worker = await obterWorker();
    const textos = [];
    for (let i = 0; i < fotos.length; i++) {
      prog.textContent = `Foto ${i + 1}/${fotos.length}…`;
      const { data } = await worker.recognize(await prepararImagem(fotos[i].arquivo));
      textos.push(data.text.trim());
    }
    const atual = $('#f-texto').value.trim();
    $('#f-texto').value = (atual ? atual + '\n' : '') + textos.join('\n');
    prog.textContent = 'Pronto. Confira o texto e clique em Converter.';
  } catch (e) {
    console.error(e);
    prog.textContent = 'Erro ao ler: ' + e.message;
  } finally {
    botao.disabled = false;
  }
};

// ---------- texto → itens ----------
// Aceita linhas como "FB1 Fusível principal 40A", "F12 - Ar condicionado (10A)", "SB 3: Buzina 15 A".
// O OCR costuma trocar 1 por l/I e 0 por O nos números; corrigimos no código.
function parseTexto(txt) {
  const itens = [];
  for (const bruta of txt.split(/\r?\n/)) {
    const linha = bruta.replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!linha) continue;
    const m = linha.match(/^([A-Za-z]{1,4})\s?[-.]?\s?([\dOolI]{1,3}[a-z]?)(?![A-Za-z])\s*[-–—:.=)]*\s*(.*)$/);
    if (!m || !/\d/.test(m[2])) {
      // linha sem código: provavelmente continuação da descrição anterior
      if (itens.length) itens[itens.length - 1].descricao += ' ' + linha;
      continue;
    }
    const num = m[2].replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
    let resto = m[3];
    let amperagem = '';
    const a = resto.match(/\(?\b(\d{1,3}(?:[.,]\d)?)\s?A\b\)?/i);
    if (a) { amperagem = a[1].replace(',', '.'); resto = resto.replace(a[0], ' '); }
    itens.push({
      codigo: (m[1] + num).toUpperCase(),
      descricao: resto.replace(/\s+/g, ' ').replace(/^[-–—:.\s]+|[-–—:.\s]+$/g, ''),
      amperagem,
      obs: ''
    });
  }
  return itens;
}

$('#b-converter').onclick = () => {
  const novos = parseTexto($('#f-texto').value);
  if (!novos.length) return aviso('Não achei linhas com código (ex: FB1, F12).');
  const existentes = lerTabela().filter(i => i.codigo || i.descricao);
  const codigos = new Set(existentes.map(i => i.codigo));
  const somar = novos.filter(i => !codigos.has(i.codigo));
  renderTabela([...existentes, ...somar]);
  aviso(`${somar.length} itens adicionados` + (novos.length > somar.length ? ` (${novos.length - somar.length} códigos repetidos ignorados)` : ''));
};

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
    await navigator.serviceWorker.register('sw.js');
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

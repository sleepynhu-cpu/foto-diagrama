// Service worker: deixa o app (e o leitor de texto) funcionando sem internet.
// - Arquivos do próprio site: tenta a rede primeiro (pega atualizações); sem rede, usa a cópia guardada.
// - Arquivos do CDN (Tesseract, com versão fixa na URL): usa a cópia guardada; só baixa se não tiver.
const CACHE = 'foto-diagrama-v1';
const APP = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(chaves => Promise.all(chaves.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function redePrimeiro(req) {
  const cache = await caches.open(CACHE);
  try {
    // com sinal fraco, não fica esperando para sempre
    const resp = await Promise.race([
      fetch(req),
      new Promise((_, falha) => setTimeout(() => falha(new Error('timeout')), 4000))
    ]);
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch (err) {
    const guardado = await cache.match(req, { ignoreSearch: true });
    if (guardado) return guardado;
    throw err;
  }
}

async function cachePrimeiro(req) {
  const cache = await caches.open(CACHE);
  const guardado = await cache.match(req);
  if (guardado) return guardado;
  const resp = await fetch(req);
  if (resp.ok || resp.type === 'opaque') cache.put(req, resp.clone());
  return resp;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(redePrimeiro(req));
  else if (url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com') e.respondWith(cachePrimeiro(req));
});

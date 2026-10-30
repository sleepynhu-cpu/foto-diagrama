// Service worker: deixa o app (e o leitor de texto) funcionando sem internet.
// - Arquivos do próprio site: tenta a rede primeiro (pega atualizações); sem rede, usa a cópia guardada.
// - Arquivos do CDN (Tesseract, com versão fixa na URL): usa a cópia guardada; só baixa se não tiver.
//   Ficam num cache separado que não é apagado quando o app muda de versão.
const CACHE = 'foto-diagrama-v2';
const CACHE_CDN = 'foto-diagrama-cdn';
const APP = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const CDN = ['https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(APP.map(u => new Request(u, { cache: 'reload' })))),
    caches.open(CACHE_CDN).then(c => c.addAll(CDN))
  ]).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(chaves => Promise.all(chaves.filter(k => k !== CACHE && k !== CACHE_CDN).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function redePrimeiro(req) {
  const cache = await caches.open(CACHE);
  try {
    // no-cache: sempre confere com o servidor se há versão nova (o GitHub manda guardar por 10 min);
    // com sinal fraco, desiste em 4 s e usa a cópia guardada
    const resp = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
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
  const cache = await caches.open(CACHE_CDN);
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

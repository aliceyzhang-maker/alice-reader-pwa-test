const cacheName='alice-pwa-validation-4';
const shell=['./','./index.html','./style.css','./manifest.webmanifest','./icon.png','./app.mjs',
 './store.mjs','./store-worker.mjs','./matching.mjs','./infer-worker.mjs','./vendor/hash.mjs','./vendor/align.mjs','./vendor/media.mjs',
 ...['view.js','epub.js','epubcfi.js','progress.js','paginator.js','overlayer.js','fixed-layout.js','uri-template.js','text-walker.js','search.js',
 'vendor/zip.js'].map(s=>'./vendor/foliate/'+s)];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(shell)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 for(const name of await caches.keys()) {
  if(name.startsWith('alice-pwa-validation-')&&name!==cacheName) {
   const previous=await caches.open(name);
   const current=await caches.open(cacheName);
   for(const request of await previous.keys()) {
    if(/\.(onnx|wasm)$/.test(request.url)) {
     const asset=await previous.match(request);
     if(asset) await current.put(request,asset).catch(()=>{});
    }
   }
   await caches.delete(name);
  }
 }
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);
 if(url.origin!==self.location.origin||event.request.method!=='GET'||event.request.headers.has('Range')) return;
 event.respondWith((async()=>{
  const cache=await caches.open(cacheName);
  const cached=await cache.match(event.request);
  if(cached) return cached;
  try {
   const response=await fetch(event.request);
   if(response.ok) await cache.put(event.request,response.clone()).catch(()=>{});
   return response;
  } catch(error) {
   if(event.request.mode==='navigate') return (await cache.match('./'))||Response.error();
   throw error;
  }
 })());
});

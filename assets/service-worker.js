const CACHE_NAME='scansafe-pwa-v22-evacuation-operations';
const APP_SHELL=[
  './user-portal.html',
  './my-information.html',
  './user-room.html',
  './user-needs.html',
  './user-notifications.html',
  './user-messages.html',
  './profile.html',
  './assets/style.css',
  './assets/app.js',
  './assets/barcode-viewer.js',
  './assets/needs-requests.js',
  './assets/evacuation-operations.js',
  './assets/evacuation-operations.css',
  './assets/app-promo.js',
  './assets/app-promo.css',
  './assets/scansafe-app-promo-portrait.png',
  './assets/scansafe-app-promo-landscape.png',
  './assets/scanner-camera.js',
  './assets/scanner.js',
  './assets/vendor/html5-qrcode.min.js',
  './assets/vendor/quagga2.min.js',
  './assets/vendor/JsBarcode.all.min.js',
  './assets/supabase-bridge.js',
  './assets/logo.svg',
  './assets/icons.svg',
  './assets/barangay-abangan-norte-seal.png',
  './assets/floor-plan-light.png',
  './assets/app-icon-192.png',
  './assets/app-icon-512.png',
  './manifest.webmanifest'
];

self.addEventListener('install', event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(APP_SHELL))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k.startsWith('scansafe-') && k!==CACHE_NAME).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', event=>{
  const req=event.request;
  if(req.method!=='GET') return;

  const url=new URL(req.url);
  if(url.origin!==self.location.origin) return;

  // Backend configuration must always come from the network.
  // This prevents an old Supabase URL/key from being served by the PWA cache.
  if(url.pathname.endsWith('/assets/supabase-config.js')){
    event.respondWith(
      fetch(req,{cache:'no-store'}).catch(()=>new Response(
        "window.SCANSafeSupabaseConfig={url:'',anonKey:''};",
        {headers:{'Content-Type':'application/javascript; charset=utf-8'}}
      ))
    );
    return;
  }

  // Shared app code must revalidate even when a previous PWA installed it.
  if(/\.(?:js|css)$/.test(url.pathname)){
    event.respondWith(
      fetch(req,{cache:'no-cache'}).then(res=>{
        if(res.ok){
          const copy=res.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.put(req,copy)));
        }
        return res;
      }).catch(()=>caches.match(req).then(cached=>cached||Response.error()))
    );
    return;
  }

  if(req.mode==='navigate'){
    event.respondWith(
      fetch(req)
        .then(res=>{
          const copy=res.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
          return res;
        })
        .catch(()=>caches.match(req).then(r=>r||new Response('ScanSafe is offline. Reconnect and reload.',{status:503,headers:{'Content-Type':'text/plain'}})))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached=>{
      if(cached) return cached;
      return fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(req,copy));
        return res;
      });
    })
  );
});

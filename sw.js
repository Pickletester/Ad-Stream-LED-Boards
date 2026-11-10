/* LevelUp ad player: offline copy of the page and the ads.
   - Page and ads.json: network first (so changes still arrive); saved copy if
     the network fails or takes over 4 seconds.
   - Ad images: saved copy first, so a slow or dead connection never matters.
     Once a saved image is 6 hours old the network is asked first (4 second
     limit, saved copy as the fallback), so replacing a file under the same
     name reaches the boards on their next reload.
   - Saved images that are no longer listed in ads.json are removed.
   - Video (range requests) and anything on another site: untouched. */
var CACHE = "levelup-ads-v1";
var PRECACHE = ["./", "index.html", "ads/ads.json"];
var TIMEOUT_MS = 4000;
var MEDIA_REFRESH_MS = 6 * 60 * 60 * 1000;

self.addEventListener("install", function(e){
  e.waitUntil(
    caches.open(CACHE).then(function(c){
      return Promise.all(PRECACHE.map(function(u){
        var abs = new URL(u, self.location.href);
        return fetch(abs.href).then(function(r){
          if(r && r.ok) return c.put(abs.origin + abs.pathname, r);
        })["catch"](function(){});
      }));
    }).then(function(){ if(self.skipWaiting) return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k.indexOf("levelup-ads-") === 0 && k !== CACHE) return caches["delete"](k);
      }));
    }).then(function(){ if(self.clients && self.clients.claim) return self.clients.claim(); })
  );
});

function networkFirst(req, key, onFresh){
  return caches.open(CACHE).then(function(c){
    return new Promise(function(resolve){
      var done = false;
      var timer = setTimeout(function(){
        c.match(key).then(function(hit){ if(hit && !done){ done = true; resolve(hit); } });
      }, TIMEOUT_MS);
      fetch(req).then(function(res){
        clearTimeout(timer);
        if(res && res.ok){
          try{ c.put(key, res.clone()); }catch(e){}
          if(onFresh){ try{ onFresh(res.clone(), c); }catch(e){} }
        }
        if(!done){ done = true; resolve(res); }
      })["catch"](function(){
        clearTimeout(timer);
        c.match(key).then(function(hit){
          if(!done){ done = true; resolve(hit || Response.error()); }
        });
      });
    });
  });
}

// Download an ad and save it with the time it was saved.
function fetchAndSaveMedia(req, key, c){
  return fetch(req).then(function(res){
    if(!res || !res.ok) return res;
    var type = res.headers.get("Content-Type") || "";
    return res.clone().blob().then(function(b){
      return c.put(key, new Response(b, { status: 200, headers: { "Content-Type": type, "X-Saved-At": String(Date.now()) } }));
    }).then(function(){ return res; }, function(){ return res; });
  });
}

function mediaCacheFirst(e, key){
  return caches.open(CACHE).then(function(c){
    return c.match(key).then(function(hit){
      if(!hit) return fetchAndSaveMedia(e.request, key, c);
      var savedAt = Number(hit.headers.get("X-Saved-At") || 0);
      if(Date.now() - savedAt <= MEDIA_REFRESH_MS) return hit;
      // Saved copy is over 6 hours old: ask the network for the current file
      // first, so an image replaced under the same name shows up straight away.
      // If the network fails or takes over 4 seconds, use the saved copy.
      return new Promise(function(resolve){
        var done = false;
        var timer = setTimeout(function(){ if(!done){ done = true; resolve(hit); } }, TIMEOUT_MS);
        var p = fetchAndSaveMedia(e.request, key, c).then(function(res){
          clearTimeout(timer);
          if(!done){ done = true; resolve(res && res.ok ? res : hit); }
        }, function(){
          clearTimeout(timer);
          if(!done){ done = true; resolve(hit); }
        });
        e.waitUntil(p);   // a slow download still finishes and is saved for next time
      });
    });
  });
}

// Remove saved ads that ads.json no longer mentions.
function pruneMedia(res, c){
  return res.json().then(function(data){
    var keep = {}, ads = (data && data.ads) || [];
    for(var i = 0; i < ads.length; i++){
      var a = ads[i];
      if(a.file) keep[a.file] = true;
      var files = a.files || [];
      for(var j = 0; j < files.length; j++){
        var m = files[j];
        keep[typeof m === "string" ? m : m.file] = true;
      }
    }
    return c.keys().then(function(reqs){
      return Promise.all(reqs.map(function(r){
        var u = new URL(r.url), at = u.pathname.lastIndexOf("/ads/");
        if(at < 0) return;
        var name;
        try{ name = decodeURIComponent(u.pathname.slice(at + 5)); }catch(err){ return; }
        if(name === "ads.json" || keep[name]) return;
        return c["delete"](r);
      }));
    });
  })["catch"](function(){});
}

self.addEventListener("fetch", function(e){
  var req = e.request;
  if(req.method !== "GET") return;
  if(req.headers.get("range")) return;              // video: leave to the browser
  var url;
  try{ url = new URL(req.url); }catch(err){ return; }
  if(url.origin !== self.location.origin) return;
  var key = url.origin + url.pathname;
  var isAdsJson = /\/ads\/ads\.json$/.test(url.pathname);
  if(url.pathname.indexOf("/ads/") >= 0 && !isAdsJson){
    if(/\.(mp4|webm)$/i.test(url.pathname)) return; // video: leave to the browser
    e.respondWith(mediaCacheFirst(e, key));
    return;
  }
  e.respondWith(networkFirst(req, key, isAdsJson ? function(res, c){ e.waitUntil(pruneMedia(res, c)); } : null));
});

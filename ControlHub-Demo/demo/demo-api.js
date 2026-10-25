/*
 * ControlHub-Demo: ersetzt den Server im Browser (24.10.2026).
 * - fetch('/api/…') beantwortet aus aufgezeichneten Daten (window.DEMO_DATA.fixtures); Änderungen bleiben im Speicher
 *   dieses Tabs (Kacheln, Kachel-Editor, Profile …), nichts geht an einen Server.
 * - io() liefert eine nachgebaute Socket-Verbindung: Startstand (Karte, Felder, Kurs, Planer) und die aufgezeichneten
 *   Spieldaten in Schleife.
 * Wird VOR allen Skripten der App geladen (statt /socket.io/socket.io.js). Die App selbst bleibt unverändert.
 */
(function () {
  // Browser-Speicher nur im Speicher dieses Tabs: Die Demo merkt sich nichts, und eingebettete Ansichten beeinflussen sich
  // nicht gegenseitig (sonst startete z. B. die GPS-Ansicht in einem Menü, das man vorher in einer anderen geöffnet hatte)
  function MemStorage() { var m = {}; return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; }, clear: function () { m = {}; },
    key: function (i) { return Object.keys(m)[i] || null; }, get length() { return Object.keys(m).length; } }; }
  try { Object.defineProperty(window, 'localStorage', { value: MemStorage(), configurable: true }); } catch (e) { /* egal */ }
  try { Object.defineProperty(window, 'sessionStorage', { value: MemStorage(), configurable: true }); } catch (e) { /* egal */ }
  var D = window.DEMO_DATA || { fixtures: {}, socket: [] };
  var store = {};
  Object.keys(D.fixtures).forEach(function (k) { store[k] = D.fixtures[k]; });
  var parse = function (s) { try { return JSON.parse(s); } catch (e) { return null; } };
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  var listeners = {};   // Socket-Ereignisse, die die Demo selbst auslöst (z. B. kacheln-changed)

  function resp(obj, status) {
    var body = typeof obj === 'string' ? obj : JSON.stringify(obj);
    return Promise.resolve(new Response(body, { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }
  function getStored(path, search) { return store['GET ' + path + (search || '')] || store['GET ' + path]; }

  // Gezielte Schreibwege, damit Änderungen beim nächsten Laden sichtbar bleiben
  function write(method, path, body) {
    var m;
    if (method === 'PUT' && path === '/api/kacheln' && body && body.config) {
      store['GET /api/kacheln'] = JSON.stringify({ success: true, config: body.config });
      emitLocal('kacheln-changed', body.config);
      return { success: true, config: body.config };
    }
    var sm = parse(store['GET /api/steuerungsmenues']);
    if ((m = path.match(/^\/api\/steuerungsmenue\/([^/]+)\/inhalt$/)) && method === 'PUT' && sm) {
      var p = (sm.pages || []).find(function (x) { return x.id === m[1]; });
      if (p) { Object.keys(body || {}).forEach(function (k) { p[k] = body[k]; }); store['GET /api/steuerungsmenues'] = JSON.stringify(sm); return { success: true, page: p }; }
    }
    if ((m = path.match(/^\/api\/steuerungsmenue\/([^/]+)\/name$/)) && sm) {
      var q = (sm.pages || []).find(function (x) { return x.id === m[1]; });
      if (q && body) { q.name = body.name || q.name; store['GET /api/steuerungsmenues'] = JSON.stringify(sm); return { success: true, page: q }; }
    }
    if (method === 'POST' && /^\/api\/steuerungsmenue\/(create|create-from-template)$/.test(path) && sm) {
      var tpl = body && body.templateId ? (sm.pages || []).find(function (x) { return x.id === 'sm-v-' + body.templateId; }) : null;
      var page = JSON.parse(JSON.stringify(tpl || { buttons: [], graphics: [], texts: [], displays: [], embeds: [], gridSize: 2.5, fineGridSize: 0.5 }));
      page.id = 'sm-demo-' + Date.now().toString(36); page.name = (body && body.name) || 'Neue Kachel';
      sm.pages.push(page); store['GET /api/steuerungsmenues'] = JSON.stringify(sm);
      return { success: true, page: page, id: page.id };
    }
    return null;
  }

  window.fetch = function (input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var u; try { u = new URL(url, location.href); } catch (e) { return realFetch(input, init); }
    var i = u.pathname.indexOf('/api/');
    if (i < 0) return realFetch ? realFetch(input, init) : resp({}, 404);
    var path = u.pathname.slice(i), method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    if (method === 'GET') {
      var b = getStored(path, u.search);
      return resp(b != null ? b : { success: true });
    }
    var body = typeof init.body === 'string' ? parse(init.body) : null;
    var r = write(method, path, body);
    if (r) return resp(r);
    return resp(Object.assign({ success: true, demo: true }, body && typeof body === 'object' && !Array.isArray(body) ? body : {}));
  };

  // ---------- nachgebaute Socket-Verbindung ----------
  var sockets = [];
  function emitLocal(ev, data) { sockets.forEach(function (s) { s._fire(ev, data); }); }
  function FakeSocket() {
    this.connected = true; this.id = 'demo'; this._h = {}; this._any = [];
    var self = this; sockets.push(this);
    setTimeout(function () { self._fire('connect'); self._start(); }, 30);
  }
  FakeSocket.prototype.on = function (ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; };
  FakeSocket.prototype.once = FakeSocket.prototype.on;
  FakeSocket.prototype.off = function (ev, fn) { if (!fn) delete this._h[ev]; else this._h[ev] = (this._h[ev] || []).filter(function (f) { return f !== fn; }); return this; };
  FakeSocket.prototype.removeListener = FakeSocket.prototype.off;
  FakeSocket.prototype.onAny = function (fn) { this._any.push(fn); return this; };
  FakeSocket.prototype.emit = function () { return this; };   // Aktionen der Oberfläche gehen in der Demo nirgendwohin
  FakeSocket.prototype.close = FakeSocket.prototype.disconnect = function () { this.connected = false; clearTimeout(this._t); return this; };
  FakeSocket.prototype.connect = function () { return this; };
  FakeSocket.prototype._fire = function (ev, data) {
    (this._h[ev] || []).slice().forEach(function (f) { try { f(data); } catch (e) { console.error(e); } });
    this._any.forEach(function (f) { try { f(ev, data); } catch (e) { /* egal */ } });
  };
  FakeSocket.prototype._start = function () {
    var self = this, rec = D.socket || [];
    var start = rec.filter(function (x) { return x[1] !== 'telemetry-update'; });
    var live = rec.filter(function (x) { return x[1] === 'telemetry-update'; });
    // GPS-Szenario (demo-gps-sim.js, ?szenario=gps): Karte, Spuren, Gerät und Fläche kommen aus der Simulation
    if (window.DEMO_SIM && window.DEMO_SIM.aktiv) {
      start.filter(function (x) { return !/^(telemetry-map|telemetry-world|telemetry-course-update|flaeche)$/.test(x[1]); })
        .forEach(function (x) { self._fire(x[1], x[2]); });
      setTimeout(function () { start.forEach(function (x) { if (x[1] === 'status') self._fire(x[1], x[2]); }); }, 1500);
      window.DEMO_SIM.start(self, rec);
      return;
    }
    start.forEach(function (x) { self._fire(x[1], x[2]); });
    // Verbindungsstatus nach dem Laden noch einmal senden: die App hängt ihren Empfänger erst später an
    setTimeout(function () { start.forEach(function (x) { if (x[1] === 'status') self._fire(x[1], x[2]); }); }, 1500);
    if (!live.length) return;
    var i = 0;
    (function next() {
      if (!self.connected) return;
      var cur = live[i], nxt = live[(i + 1) % live.length];
      self._fire('telemetry-update', cur[2]);
      var dt = nxt[0] - cur[0]; if (!(dt > 0 && dt < 2000)) dt = 250;
      i = (i + 1) % live.length;
      self._t = setTimeout(next, dt);
    })();
  };
  window.io = function () { return new FakeSocket(); };

  // ---------- Steuerung per Adresse: ?kachel=<id> öffnet den Kachel-Editor, ?einrichten=1 „Seite bearbeiten“ ----------
  var params = new URLSearchParams(location.search);
  // Arbeitsplaner direkt öffnen (?planer=fruchtfolge|felder) -- über die Bedienung, wie ein Mensch es täte
  function openPlaner(reiter) {
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var menu = Array.prototype.find.call(document.querySelectorAll('button'), function (b) { return /Menü/.test(b.textContent); });
    if (!menu) return;
    menu.click();
    wait(400).then(function () {
      var k = Array.prototype.filter.call(document.querySelectorAll('*'), function (e) { return e.offsetParent && /^Arbeitsplaner/.test(e.textContent.trim()) && /Planer-Satz/.test(e.textContent); })
        .sort(function (a, b) { return a.textContent.length - b.textContent.length; });
      if (k[0]) k[0].click();
      return wait(900);
    }).then(function () {
      var re = reiter === 'felder' ? /^Felder$/ : /^Fruchtfolge$/;
      var t = Array.prototype.find.call(document.querySelectorAll('button,[role=tab],a'), function (e) { return e.offsetParent && re.test(e.textContent.trim()); });
      if (t) t.click();
    });
  }
  window.addEventListener('load', function () {
    var tries = 0;
    (function go() {
      tries++;
      var k = params.get('kachel');
      if (k && window.kachelEditor && window.steuerungsmenues && window.steuerungsmenues.pages && window.steuerungsmenues.pages.length) { window.kachelEditor.open(k); return; }
      if (params.get('einrichten') && window.tilePages && window.tilePages.config && (window.tilePages.config.pages || []).length && document.querySelector('.tile')) { setTimeout(function () { window.tilePages.edit(true); }, 300); return; }
      if (params.get('planer') && window.app && document.querySelector('.tile')) { openPlaner(params.get('planer')); return; }
      // GPS-Szenario: Karte als Vollbild, Norden oben, ganzes Feld im Blick
      if (params.get('szenario') === 'gps' && window.dashboardMapView && document.querySelector('.tile')) {
        if (window.tilePages.goTo && window.tilePages.config && (window.tilePages.config.pages || []).length) window.tilePages.goTo(window.tilePages.config.pages[0].id, true);
        var titel = Array.prototype.filter.call(document.querySelectorAll('.tile *'), function (e) { return e.offsetParent && e.children.length === 0 && /^karte$/i.test(e.textContent.trim()); })[0];
        if (!titel) { if (tries < 40) setTimeout(go, 150); return; }
        titel.click();
        setTimeout(function () {
          var m = window.dashboardMapView; m.ansichtVorgabe = { tilt: false, headingUp: false }; m.setzeVorgabe(true);
          // Nur die Karte zeigen (Hendrik 25.10.2026): ohne Kopfleiste und Menü, damit man nicht von der Karte wegklicken kann
          var st = document.createElement('style');
          st.textContent = 'body{visibility:hidden;overflow:hidden}' +
            '#dashboard-map-fullscreen-target{visibility:visible;position:fixed!important;inset:0!important;z-index:2147483000;margin:0!important;padding:14px!important;box-sizing:border-box;border-radius:0!important;background:#14181d}' +
            '#dashboard-map-fullscreen-target *{visibility:inherit}';
          document.head.appendChild(st);
          setTimeout(function () { if (m.resize) m.resize(); }, 50);
        }, 600);
        return;
      }
      if ((k || params.get('einrichten') || params.get('planer') || params.get('szenario')) && tries < 40) setTimeout(go, 150);
    })();
  });
})();

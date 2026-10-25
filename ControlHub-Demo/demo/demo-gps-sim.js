/*
 * ControlHub-Demo: GPS-Szenario für die Landingpage (25.10.2026, Hendrik: „Pflanzenschutzspritze mit 30 m, schräge
 * Vorgewende, Überlappung und Teilbreitenschaltung zeigen, in der Ansicht wie im Programm, auch in 3D“).
 * Aktiv mit ?szenario=gps. Statt der aufgezeichneten Spieldaten rechnet diese Datei eine Feldspritze im Browser und schickt
 * der echten Karte dieselben Ereignisse wie der Server: telemetry-map (Feld), telemetry-course-update (Spuren),
 * telemetry-update (Fahrzeug, Gerät mit Teilbreiten, GPS) und flaeche (bearbeitete Fläche, doppelt bearbeitet).
 * Einstellungen kommen per postMessage von der Seite: { gpsSim: { breite, bahnen, teilbreiten, tempo, tilt, neu } }.
 *
 * Koordinaten wie im Spiel: x, z in Metern; Gerät relativ zum Fahrzeug [längs, quer], längs + = vorn, quer + = links.
 */
(function () {
  if (!/[?&]szenario=gps\b/.test(location.search)) return;

  var CFG = { breite: 30, bahnen: 1, teilbreiten: true, tempo: 8 };
  var FELD_B = 330, FELD_L = 210, SCHRAEG = 0.36, SCHRAEG_U = 0.24;   // Trapez: links 210 m, rechts länger; oben ca. 20°, unten ca. 13° schräg
  var ZELLE = 0.5, KZ = 128;                            // Raster der bearbeiteten Fläche wie der Server
  var N_TB = 10;                                        // Teilbreiten (fest, 5 je Seite)
  var BOOM = -3.6;                                      // Balken hinter dem Fahrzeug (längs)
  var KMH = 12;                                         // angezeigtes Tempo

  // ---------- Geometrie ----------
  var feld = [[0, 0], [FELD_B, -FELD_B * SCHRAEG], [FELD_B, FELD_L + FELD_B * SCHRAEG_U], [0, FELD_L]];   // im Uhrzeigersinn auf der Karte
  function inset(poly, d) {   // konvexes Vieleck um d nach innen versetzen (Schnitt der verschobenen Kanten)
    var n = poly.length, lines = [], i;
    var cx = 0, cz = 0; poly.forEach(function (p) { cx += p[0] / n; cz += p[1] / n; });
    for (i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      var nx = -dz / l, nz = dx / l;
      if ((cx - a[0]) * nx + (cz - a[1]) * nz < 0) { nx = -nx; nz = -nz; }   // Normale nach innen
      lines.push({ p: [a[0] + nx * d, a[1] + nz * d], v: [dx, dz] });
    }
    var out = [];
    for (i = 0; i < n; i++) {
      var L1 = lines[(i + n - 1) % n], L2 = lines[i];
      var det = L1.v[0] * L2.v[1] - L1.v[1] * L2.v[0];
      var t = ((L2.p[0] - L1.p[0]) * L2.v[1] - (L2.p[1] - L1.p[1]) * L2.v[0]) / det;
      out.push([L1.p[0] + L1.v[0] * t, L1.p[1] + L1.v[1] * t]);
    }
    return out;
  }
  function inPoly(poly, x, z) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  // z der Kante zwischen zwei Ecken bei x (für die Spuren: obere und untere Kante des inneren Vielecks)
  function kanteZ(a, b, x) { return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); }
  // Abstand vom Punkt in Fahrtrichtung bis zum Rand des Vielecks (von innen), null = nicht drin
  function abstandBisRand(poly, x, z, fx, fz) {
    if (!inPoly(poly, x, z)) return null;
    var best = null;
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length], ex = b[0] - a[0], ez = b[1] - a[1];
      var det = fx * ez - fz * ex; if (Math.abs(det) < 1e-9) continue;
      var t = ((a[0] - x) * ez - (a[1] - z) * ex) / det, u = ((a[0] - x) * fz - (a[1] - z) * fx) / det;
      if (t > 0 && u >= 0 && u <= 1 && (best == null || t < best)) best = t;
    }
    return best;
  }

  // ---------- Weg: Spuren im Innenfeld mit Wenden im Vorgewende, danach die Vorgewende-Runden ----------
  var weg, segmente, innen, H;
  function baue() {
    var W = CFG.breite;
    H = CFG.bahnen * W;
    innen = inset(feld, H);
    var x0 = innen[0][0], x1 = innen[1][0];
    var n = Math.ceil((x1 - x0) / W - 0.05);
    var r = W / 2, pts = [], segs = [], i, k;
    function linie(a, b, art, seg) { var l = Math.hypot(b[0] - a[0], b[1] - a[1]), m = Math.max(1, Math.ceil(l / 0.5)); for (var j = (pts.length ? 1 : 0); j <= m; j++) pts.push({ x: a[0] + (b[0] - a[0]) * j / m, z: a[1] + (b[1] - a[1]) * j / m, art: art, seg: seg }); }
    function bogen(cx, cz, rad, a0, a1, art) { var m = Math.max(6, Math.ceil(Math.abs(a1 - a0) * rad / 0.5)); for (var j = 1; j <= m; j++) { var a = a0 + (a1 - a0) * j / m; pts.push({ x: cx + Math.cos(a) * rad, z: cz + Math.sin(a) * rad, art: art, seg: 0 }); } }
    var spurX = [];
    for (k = 0; k < n; k++) spurX.push(x0 + W / 2 + k * W);
    var oben = function (x) { return kanteZ(innen[0], innen[1], x); }, unten = function (x) { return kanteZ(innen[3], innen[2], x); };
    // Wendepunkte: so weit ins Vorgewende, dass der Bogen (Radius W/2) bei beiden Spuren hinter der Linie liegt
    for (k = 0; k < n; k++) {
      var x = spurX[k], hoch = k % 2 === 0;   // gerade Spuren fahren nach oben (z kleiner)
      var zUnten = k === 0 ? unten(x) + 4 : null;
      var xn = spurX[k + 1];
      var zO = Math.min(oben(x), xn != null ? oben(xn) : oben(x)) - Math.min(H * 0.35, 6);
      var zU = Math.max(unten(x), xn != null ? unten(xn) : unten(x)) + Math.min(H * 0.35, 6);
      segs.push({ segmentId: k + 1, length: unten(x) - oben(x), isHeadlandSegment: false, lineGroupIndex: 1, positions: [[x, oben(x)], [x, unten(x)]] });
      if (k === 0) linie([x, zUnten], [x, zO], 'spur', k + 1);
      else linie([x, hoch ? zU : zO], [x, hoch ? zO : zU], 'spur', k + 1);
      if (xn == null) break;
      if (hoch) bogen((x + xn) / 2, zO, r, Math.PI, 2 * Math.PI, 'wende');
      else bogen((x + xn) / 2, zU, r, Math.PI, 0, 'wende');
    }
    // Vorgewende: eine Runde je Bahn, von außen nach innen, mit halber Breite Abstand zum Feldrand
    for (i = 0; i < CFG.bahnen; i++) {
      var ring = inset(feld, W / 2 + i * W), id = n + 1 + i;
      segs.push({ segmentId: id, length: 0, isHeadlandSegment: true, lineGroupIndex: 2, positions: ring.concat([ring[0]]) });
      var start = ring[3];
      linie([pts[pts.length - 1].x, pts[pts.length - 1].z], start, 'wende', 0);
      [3, 0, 1, 2, 3].reduce(function (a, b) { linie(ring[a], ring[b], 'runde', id); return b; });
    }
    weg = pts; segmente = segs;
  }

  // ---------- Fläche: Zählraster je Zelle (wie oft, wann zuletzt) ----------
  var GX0 = -10, GZ0 = -FELD_B * SCHRAEG - 10, GW, GH, anz, zuletzt, schmutz;
  function rasterNeu() {
    GW = Math.ceil((FELD_B + 20) / ZELLE); GH = Math.ceil((FELD_L + FELD_B * SCHRAEG_U - GZ0 + 10) / ZELLE);
    anz = new Uint8Array(GW * GH); zuletzt = new Float32Array(GW * GH); schmutz = {};
  }
  function male(quad, t) {   // Viereck (Weltkoordinaten) einfärben; doppelt = schon von einer früheren Fahrt
    var xs = quad.map(function (p) { return p[0]; }), zs = quad.map(function (p) { return p[1]; });
    var c0 = Math.max(0, Math.floor((Math.min.apply(0, xs) - GX0) / ZELLE)), c1 = Math.min(GW - 1, Math.floor((Math.max.apply(0, xs) - GX0) / ZELLE));
    var r0 = Math.max(0, Math.floor((Math.min.apply(0, zs) - GZ0) / ZELLE)), r1 = Math.min(GH - 1, Math.floor((Math.max.apply(0, zs) - GZ0) / ZELLE));
    for (var r = r0; r <= r1; r++) for (var c = c0; c <= c1; c++) {
      var x = GX0 + (c + 0.5) * ZELLE, z = GZ0 + (r + 0.5) * ZELLE;
      if (!inPoly(quad, x, z) || !inPoly(feld, x, z)) continue;
      var i = r * GW + c;
      if (anz[i] === 0) anz[i] = 1;
      else if (anz[i] === 1 && t - zuletzt[i] > 3) anz[i] = 2;
      else { zuletzt[i] = t; continue; }
      zuletzt[i] = t;
      var gc = Math.floor(x / ZELLE), gr = Math.floor(z / ZELLE);
      schmutz[Math.floor(gc / KZ) + ',' + Math.floor(gr / KZ)] = 1;
    }
  }
  function bedeckt(x, z) { var c = Math.floor((x - GX0) / ZELLE), r = Math.floor((z - GZ0) / ZELLE); return c >= 0 && r >= 0 && c < GW && r < GH && anz[r * GW + c] > 0; }
  function kachel(key) {   // Bits einer Kachel wie server/flaeche.js: i = Zeile * n + Spalte, Bit (i & 7) in Byte i >> 3
    var kx = +key.split(',')[0], kz = +key.split(',')[1], b1 = new Uint8Array(KZ * KZ / 8), b2 = new Uint8Array(KZ * KZ / 8), any2 = false;
    for (var rr = 0; rr < KZ; rr++) for (var cc = 0; cc < KZ; cc++) {
      var x = (kx * KZ + cc + 0.5) * ZELLE, z = (kz * KZ + rr + 0.5) * ZELLE;
      var c = Math.floor((x - GX0) / ZELLE), r = Math.floor((z - GZ0) / ZELLE);
      if (c < 0 || r < 0 || c >= GW || r >= GH) continue;
      var v = anz[r * GW + c], i = rr * KZ + cc;
      if (v) b1[i >> 3] |= 1 << (i & 7);
      if (v > 1) { b2[i >> 3] |= 1 << (i & 7); any2 = true; }
    }
    var b64 = function (a) { var s = ''; for (var j = 0; j < a.length; j++) s += String.fromCharCode(a[j]); return btoa(s); };
    return { bits: b64(b1), doppelt: any2 ? b64(b2) : null };
  }
  function flaecheSenden(sock, voll) {
    var tiles = {}, dop = {};
    Object.keys(schmutz).forEach(function (k) { var t = kachel(k); tiles[k] = t.bits; if (t.doppelt) dop[k] = t.doppelt; });
    schmutz = {};
    sock._fire('flaeche', { fahrzeug: 'name:Traktor 240 PS', zelleM: ZELLE, kachelZ: KZ, voll: !!voll, tiles: tiles, doppelt: dop });
  }

  // ---------- Lauf ----------
  var sock = null, vorlage = null, pos = 0, t = 0, timer = null, letzteEnden = null, flTimer = 0, pause = 0;
  function rel(F, along, across) { return [F.x + F.fx * along + F.fz * across, F.z + F.fz * along - F.fx * across]; }
  function teilbreiten(F, art) {
    var W = CFG.breite, half = W / 2, ec = W / N_TB, an = [], i;
    var zone = art === 'runde' ? feld : innen;
    var arbeitet = art !== 'wende';
    var mitte = rel(F, BOOM, 0), ganz = arbeitet && inPoly(zone, mitte[0], mitte[1]);
    for (i = 0; i < N_TB; i++) {
      var q = half - (i + 0.5) * ec;   // von links nach rechts
      var p = rel(F, BOOM, q);
      if (!arbeitet) { an.push(false); continue; }
      if (CFG.teilbreiten) an.push(inPoly(zone, p[0], p[1]) && inPoly(feld, p[0], p[1]) && !bedecktVoraus(F, q));
      else an.push(ganz);
    }
    return an;
  }
  function bedecktVoraus(F, q) {   // schon bearbeitet? (ein Stück vor dem Balken prüfen, sonst schaltet er sich selbst ab)
    var p = rel(F, BOOM + 1.2, q);
    return bedeckt(p[0], p[1]);
  }
  function schritt() {
    var dt = 1 / 25, v = KMH / 3.6 * CFG.tempo;
    if (pause > 0) { pause -= dt; if (pause <= 0) neuStart(); return; }
    // in Teilschritten von höchstens 0,5 m rechnen, sonst entstehen bei hohem Zeitraffer Lücken an den Spurenden
    var n = Math.max(1, Math.ceil(v * dt / 0.5)), F, a, an;
    for (var s = 0; s < n; s++) {
      t += dt / n;
      pos += v * dt / n / 0.5;
      if (pos >= weg.length - 2) { pause = 3; flaecheSenden(sock); return; }
      var i = Math.floor(pos), f = pos - i, b;
      a = weg[i]; b = weg[i + 1];
      var x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
      var c = weg[Math.min(weg.length - 1, i + 3)], p0 = weg[Math.max(0, i - 3)];
      var fx = c.x - p0.x, fz = c.z - p0.z, fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
      F = { x: x, z: z, fx: fx, fz: fz };
      an = teilbreiten(F, a.art);
      // Fläche malen: je eingeschaltete Teilbreite das Stück seit dem letzten Teilschritt
      var W = CFG.breite, half = W / 2, ec = W / N_TB, enden = [];
      for (var k = 0; k <= N_TB; k++) enden.push(rel(F, BOOM, half - k * ec));
      if (letzteEnden) for (k = 0; k < N_TB; k++) if (an[k]) male([letzteEnden[k], letzteEnden[k + 1], enden[k + 1], enden[k]], t);
      letzteEnden = enden;
    }
    flTimer += dt; if (flTimer > 0.2) { flTimer = 0; flaecheSenden(sock); }
    sock._fire('telemetry-update', frame(F, a, an));
  }
  function frame(F, a, an) {
    var W = CFG.breite, half = W / 2, ec = W / N_TB, d = JSON.parse(JSON.stringify(vorlage || {}));
    var liste = [], anL = 0, anR = 0;
    for (var i = 0; i < N_TB; i++) {
      var links = i < N_TB / 2, nr = links ? N_TB / 2 - i : i - N_TB / 2 + 1, kante = nr * ec;
      liste.push({ side: links ? 'L' : 'R', on: an[i], abs: kante });
    }
    an.slice(0, N_TB / 2).forEach(function (o) { if (o) anL++; });
    an.slice(N_TB / 2).forEach(function (o) { if (o) anR++; });
    var irgendwas = an.some(Boolean);
    // Balken über die volle Breite (wie Handwerte im GPS-Menü): so sitzen die Kästchen fest, auch wenn die Automatik
    // einzelne Teilbreiten mitten im Balken abschaltet; der Zustand kommt je Kästchen aus sections.liste
    var areasVoll = [{ type: 'SPRAYER', corners: [[BOOM + 0.3, half], [BOOM + 0.3, -half], [BOOM - 0.3, -half], [BOOM - 0.3, half]] }];
    var unit = { name: 'Feldspritze ' + W + ' m', kind: 'sprayer', side: 'rear', depth: 1, selected: true, lowered: true, on: irgendwas,
      unfolded: true, folding: false, canFold: true, canLower: true, canTurnOn: true, pto: 540, width: W, workMode: -1, workModes: [],
      fills: [{ name: 'Pflanzenschutzmittel', type: 'HERBICIDE', level: 3200, capacity: 4000 }], attach: 'mounted',
      pose: { along: BOOM, across: 0, angle: 0 }, joint: { along: -1.6, across: 0 }, areas: areasVoll, tip: 0,
      sections: { aktiv: true, mitte: null, links: { an: anL, max: N_TB / 2 }, rechts: { an: anR, max: N_TB / 2 }, liste: liste }, pfSek: null };
    var mitte = rel(F, BOOM, 0);
    var vg = a.art === 'spur' ? abstandBisRand(innen, mitte[0], mitte[1], F.fx, F.fz) : null;
    d.available = true; d.posX = F.x; d.posZ = F.z; d.fwdX = F.fx; d.fwdZ = F.fz; d.speed = KMH; d.vehicleName = 'Traktor 240 PS';
    d.vehicleId = 'demo-spritze'; d.inVehicle = true; d.units = [unit]; d.workWidth = W; d.pfWorkWidth = W; d.impLow = 1; d.impOn = irgendwas ? 1 : 0;
    d.courseSegIdx = a.seg || 0; d.steerOn = a.art !== 'wende'; d.steerOnField = true;
    d.base = Object.assign({}, d.base || {}, { speedKmh: KMH, turn: null });
    var ecken = [rel(F, BOOM + 0.3, half), rel(F, BOOM + 0.3, -half), rel(F, BOOM - 0.3, -half), rel(F, BOOM - 0.3, half)];
    d.gps = { device: unit.name, unit: unit.name, source: 'hand', manual: true, corners: ecken, automatik: true, armed: false, state: a.art === 'spur' ? 'work' : 'headland',
      headland: H, overlap: 50, headlandAheadM: vg, fieldEdgeAheadM: null, geraete: {}, act: { exit: true, entry: true }, ton: { exit: true, entry: true }, versatz: { exit: 0, entry: 0 } };
    d.teilbreiten = null;
    return d;
  }
  function neuStart() {
    var m = window.dashboardMapView, ansicht = m ? { tilt: m.tilt, headingUp: m.headingUp, zoom: m.zoomFactor, pan: m.pan && { x: m.pan.x, y: m.pan.y } } : null;
    baue(); rasterNeu(); pos = 0; t = 0; letzteEnden = null; pause = 0;
    // Ansicht so lassen, wie der Besucher sie eingestellt hat (Hendrik 25.10.2026)
    if (ansicht) setTimeout(function () {
      if (!!m.tilt !== !!ansicht.tilt) m.setTilt(ansicht.tilt);
      m.headingUp = ansicht.headingUp; m.zoomFactor = ansicht.zoom; if (ansicht.pan) m.pan = ansicht.pan;
    }, 0);
    sock._fire('telemetry-map', { session: 'demo', name: 'Demokarte', size: 2048, rev: Date.now() % 100000, myFarm: 1, savegame: { index: 1, name: 'Demo', dir: 'savegame1', mapId: 'demo', multiplayer: false },
      farms: [{ id: 1, name: 'Mein Hof', color: '#4a9c2e' }], fields: [{ id: 12, owner: 1, area: 7.2, pts: feld, x: null, z: null }], fruits: [] });
    sock._fire('telemetry-world', { rev: Date.now() % 100000, entities: [] });
    sock._fire('telemetry-course-update', { boundary: feld, segments: segmente, implementWidth: CFG.breite, workDirection: -1, rowSpacing: -1, numHeadlands: CFG.bahnen });
    flaecheSenden(sock, true);
  }

  window.DEMO_SIM = {
    aktiv: true,
    _col: function (x) { var c = Math.floor((x - GX0) / ZELLE), out = []; var prev = -1; for (var r = 0; r < GH; r++) { var v = anz[r * GW + c]; if (v !== prev) { out.push((GZ0 + r * ZELLE).toFixed(1) + ':' + v); prev = v; } } return { col: out.join(' '), innen: innen, weg0: weg.slice(0, 3) }; },
    _dbg: function (z) { var r = Math.floor((z - GZ0) / ZELLE), out = ''; for (var c = 0; c < GW; c += 4) out += anz[r * GW + c]; return { pos: pos, n: weg.length, row: out }; },
    start: function (s, rec) {
      sock = s;
      vorlage = (rec || []).filter(function (x) { return x[1] === 'telemetry-update'; }).map(function (x) { return x[2]; })[0] || {};
      neuStart();
      timer = setInterval(schritt, 40);
      // Draufsicht (Norden oben): ganzes Feld fest im Bild statt Kamera am Fahrzeug; 3D und „Fahrtrichtung oben“ wie im Programm
      (function patch() {
        var m = window.dashboardMapView;
        if (!m || !m.worldToCanvas) return setTimeout(patch, 200);
        var cx = FELD_B / 2, cz = (FELD_L + FELD_B * SCHRAEG_U - FELD_B * SCHRAEG) / 2, w2c = m.worldToCanvas, c2w = m.canvasToWorld;
        m.worldToCanvas = function (x, z) {
          if (this.isHeadingUp()) return w2c.call(this, x, z);
          var sc = this.getScale();
          return { x: this.cssWidth / 2 + (x - cx) * sc + this.pan.x, y: this.anchorY() + (z - cz) * sc + this.pan.y };
        };
        m.canvasToWorld = function (sx, sy) {
          if (this.isHeadingUp()) return c2w.call(this, sx, sy);
          var sc = this.getScale();
          return { x: cx + (sx - this.cssWidth / 2 - this.pan.x) / sc, z: cz + (sy - this.anchorY() - this.pan.y) / sc };
        };
      })();
    },
    set: function (o) {
      var neu = false;
      ['breite', 'bahnen', 'teilbreiten', 'tempo'].forEach(function (k) { if (o[k] != null && o[k] !== CFG[k]) { CFG[k] = o[k]; if (k !== 'tempo') neu = true; } });
      if (o.tilt != null && window.dashboardMapView) { var m = window.dashboardMapView; m.setTilt(!!o.tilt); m.zoomFactor = o.tilt ? 3 : 1; m.pan = { x: 0, y: 0 }; }
      if ((neu || o.neu) && sock) neuStart();
    }
  };
  window.addEventListener('message', function (e) { if (e.data && e.data.gpsSim) window.DEMO_SIM.set(e.data.gpsSim); });
})();

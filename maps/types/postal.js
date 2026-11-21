// Postal codes: GeoNames postal code points (CC BY 4.0), built by scripts/build_postal.py into one gzipped file
// per country and 5-degree cell under data/maps/postal/. At globe view countries are coloured by how their codes are
// written; zoomed in, the files for the cells in view are loaded and each code is a dot at its estimated centre.

const DATA = new URL('../../data/maps/postal/', import.meta.url);
// The same country maps app.js draws (already in the browser cache), so the fills line up with its borders.
const MAP_HI = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
const MAP_LO = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
const OSM = { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 };
const fade = (k, a, b) => Math.max(0, Math.min(1, (Math.log(k) - Math.log(a)) / (Math.log(b) - Math.log(a))));

const K_DOTS = 10;     // codes load and show from here (a country the size of France fills the window)
const K_LABELS = 60;   // code labels from here (a city fills the window)
const K_PLACES = 600;  // place names beside the codes from here
const NEAR_KM = 50;
const MAX_LOADED = 80;  // files kept in memory (a file is one country's codes in one 5-degree cell)
const RAD = Math.PI / 180;
import { MAP_FONT as FONT } from '../fonts.js';

const KINDS = [
  ['d4', '3 or 4 digits'], ['d5', '5 digits'], ['d6', '6 digits'], ['d7', '7 or more digits'], ['alnum', 'Letters and digits']
];
// Green to blue (ColorBrewer YlGnBu), darker on the light theme and lighter on the dark one as codes get longer;
// orange (Okabe-Ito) for codes with letters. The palest step is kept clear of the sea colour. Colour-blind safe.
const COLORS = {
  light: { d4: '#a1dab4', d5: '#41b6c4', d6: '#2c7fb8', d7: '#253494', alnum: '#e69f00', dot: '#a3127f' },
  dark: { d4: '#24584f', d5: '#2b8798', d6: '#4fa6d8', d7: '#b4cff5', alnum: '#d69324', dot: '#f27ad0' }
};
const isDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let names = null;
const countryName = cc => { try { names ||= new Intl.DisplayNames(['en'], { type: 'region' }); return names.of(cc) || cc; } catch { return cc; } };

let index = null, indexReady = null, indexFailed = false, world = null, lastK = 1, lastPick = null;
let cells = [];              // [5-degree cell centre [lon, lat], file keys 'CC-cell'] for every cell with a dot
const loaded = new Map();    // file key -> parsed file (or a Promise while loading)
const failed = new Map();    // file key -> when it last failed
let failedNames = '';        // countries with a failed file in view, for the legend
const ccOf = key => key.split('-')[0];
const RETRY_MS = 5000;
const HALF_CELL = 0.062;     // half the diagonal of a 5-degree cell, in radians (at most)
const NO_HITS = { x: [], y: [], d: [], i: [], n: 0 };
let hits = NO_HITS;          // dots drawn in the last frame: screen x, y, country file, row; n = dots in view
let refresh = () => {};

// ---------- data ----------

async function fetchText(url) {
  const buf = new Uint8Array(await fetch(url).then(r => { if (!r.ok) throw new Error(`${url} returned ${r.status}`); return r.arrayBuffer(); }));
  // A host that sends the .gz with Content-Encoding has already unzipped it.
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return new TextDecoder().decode(buf);
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

// The file format is described in scripts/build_postal.py.
function parse(cc, text) {
  const ls = text.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  const a1 = ls[0].split('\t'), a2 = ls[1].split('\t'), n = ls.length - 2;
  const d = { cc, a1, a2, n, code: new Array(n), place: new Array(n), extra: new Array(n),
    lat: new Float64Array(n), lon: new Float64Array(n), i1: new Uint16Array(n), i2: new Uint16Array(n), acc: new Uint8Array(n),
    // Unit vectors, so drawing projects a point with a few multiplications instead of trigonometry.
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), used: performance.now() };
  let la = 0, lo = 0, place = '', i1 = 0, i2 = 0, acc = 0;
  for (let j = 0; j < n; j++) {
    const f = ls[j + 2].split('\t');
    place = f[1] || place;
    la += +f[2]; lo += +f[3];
    if (f[4]) i1 = +f[4];
    if (f[5]) i2 = +f[5];
    if (f[7]) acc = +f[7];
    d.code[j] = f[0]; d.place[j] = place; d.extra[j] = f[6] || '';
    d.lat[j] = la / 1000; d.lon[j] = lo / 1000; d.i1[j] = i1; d.i2[j] = i2; d.acc[j] = acc;
    const p = (la / 1000) * RAD, l = (lo / 1000) * RAD;
    d.x[j] = Math.cos(p) * Math.cos(l); d.y[j] = Math.cos(p) * Math.sin(l); d.z[j] = Math.sin(p);
  }
  return d;
}

function load(cc, draw) { // cc: a file key, 'CC-cell'
  // A file that just failed is not asked for again at once (each failure refreshes an open panel, which asks again).
  if (!loaded.has(cc) && performance.now() - failed.get(cc) < RETRY_MS) return Promise.reject(new Error(`${cc} failed just now`));
  if (!loaded.has(cc)) {
    loaded.set(cc, fetchText(new URL(`${cc}.tsv.gz`, DATA)).then(t => {
      const d = parse(ccOf(cc), t);
      loaded.set(cc, d);
      if (failed.delete(cc)) refresh(); // the legend stops naming it
      draw?.();
      return d;
    }).catch(e => {
      console.warn(e);
      loaded.delete(cc);
      failed.set(cc, performance.now());
      refresh();
      throw e;
    }));
    // Keep memory in check: forget the countries drawn longest ago, if they have been out of view for a while.
    const old = [...loaded].filter(([, d]) => !(d instanceof Promise) && d.used < performance.now() - 10000).sort((a, b) => a[1].used - b[1].used);
    for (let j = 0; loaded.size > MAX_LOADED && j < old.length; j++) loaded.delete(old[j][0]);
  }
  return Promise.resolve(loaded.get(cc));
}

// Files of the 5-degree cells that meets the cap of radius r (radians) around a point,
// and, given `api`, whose corners' screen box meets the window (the cap's circle reaches past a wide window's corners).
function filesWithin(at, r, api) {
  const out = new Set();
  for (const [c, ccs] of cells) {
    if (d3.geoDistance(at, c) >= r + HALF_CELL) continue;
    if (api) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [dx, dy] of [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5], [0, -2.5], [0, 2.5], [-2.5, 0], [2.5, 0]]) {
        const [x, y] = api.proj([c[0] + dx, c[1] + dy]);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      if (x1 < 0 || y1 < 0 || x0 > api.w || y0 > api.h) continue;
    }
    for (const cc of ccs) out.add(cc);
  }
  return [...out];
}

function shapes(topo) {
  const caps = pts => {
    const c = pts[Math.floor(pts.length / 2)];
    let r = 0;
    for (const p of pts) r = Math.max(r, d3.geoDistance(c, p));
    return { c, r };
  };
  const obj = topo.objects.countries;
  const kindOf = g => index.countries[index.ids[g.id]]?.kind;
  // Countries of one kind are merged, so shared borders drop out and a frame projects far fewer points.
  const fills = KINDS.flatMap(([kind]) => topojson.merge(topo, obj.geometries.filter(g => kindOf(g) === kind)).coordinates
    .map(p => ({ kind, f: { type: 'Polygon', coordinates: p }, cap: caps(p.flat()) })));
  const lines = topojson.mesh(topo, obj, (a, b) => a !== b && !!(kindOf(a) || kindOf(b))).coordinates.map(l => ({ l, cap: caps(l) }));
  return { fills, lines };
}

// ---------- drawing ----------

// The visible cap's angular radius: the horizon, or less when the window shows only part of the globe.
function viewRadius(api) {
  const [tx, ty] = api.proj.translate(), s = api.proj.scale();
  const corner = Math.max(Math.hypot(tx, ty), Math.hypot(api.w - tx, ty), Math.hypot(tx, api.h - ty), Math.hypot(api.w - tx, api.h - ty));
  return corner >= s ? Math.PI / 2 : Math.asin(corner / s);
}

function drawFills(api, alpha, R) {
  const { ctx, center, projected, paint } = api;
  const w = api.moving && world.lo ? world.lo : world.hi;
  const seen = cap => d3.geoDistance(center, cap.c) - cap.r < R + 0.01;
  const cs = COLORS[api.dark ? 'dark' : 'light'];
  const groups = new Map();
  for (const x of w.fills) {
    if (!seen(x.cap)) continue;
    if (!groups.has(x.kind)) groups.set(x.kind, []);
    groups.get(x.kind).push(x.f);
  }
  ctx.globalAlpha = alpha;
  // Projected once per view (see the app's projected()), so a hover redraw at rest projects nothing.
  for (const [kind, fs] of groups) { ctx.fillStyle = cs[kind]; paint(projected(`postal:${kind}`, () => fs), 'fill'); }
  // The fills cover the app's borders, so they are drawn again on top.
  ctx.strokeStyle = api.C.border; ctx.lineWidth = 0.6;
  paint(projected('postal:lines', () => ({ type: 'MultiLineString', coordinates: w.lines.filter(x => seen(x.cap)).map(x => x.l) })), 'stroke');
  ctx.globalAlpha = 1;
}

function drawDots(api, R) {
  const { ctx, proj, k, w, h } = api;
  const [clon, clat] = api.center;
  // Files load once the globe stops, so zooming in through a wide view does not fetch all of it.
  if (!api.moving) {
    const want = filesWithin(api.center, R, api);
    for (const cc of want) if (!loaded.has(cc)) load(cc, api.draw).catch(() => {}); // failures show in the legend
    // The legend names only failed files still in view; it is redrawn when that list changes.
    const names = [...new Set(want.filter(cc => failed.has(cc)).map(ccOf))].map(countryName).join(', ');
    if (names !== failedNames) { failedNames = names; refresh(); }
  }

  // The orthographic projection is linear in a point's unit vector: screen = translate + A · v,
  // and A's columns are where the three axes land. A point faces the viewer when v · centre > 0.
  const [tx, ty] = proj.translate();
  const axis = p => { const q = proj(p); return [q[0] - tx, q[1] - ty]; };
  const [ax, ay] = axis([0, 0]), [bx, by] = axis([90, 0]), [cx, cy] = axis([0, 90]);
  const vx = Math.cos(clat * RAD) * Math.cos(clon * RAD), vy = Math.cos(clat * RAD) * Math.sin(clon * RAD), vz = Math.sin(clat * RAD);
  // While the globe moves, a thinned sample (about 8,000 dots) keeps frames quick.
  const step = api.moving ? Math.max(1, Math.ceil(hits.n / 8000)) : 1;
  const H = { x: [], y: [], d: [], i: [], n: 0 };
  for (const d of loaded.values()) {
    if (d instanceof Promise) continue;
    const X = d.x, Y = d.y, Z = d.z;
    let any = false;
    for (let i = 0; i < d.n; i += step) {
      if (X[i] * vx + Y[i] * vy + Z[i] * vz < 0.02) continue;
      const sx = tx + ax * X[i] + bx * Y[i] + cx * Z[i], sy = ty + ay * X[i] + by * Y[i] + cy * Z[i];
      if (sx < -8 || sy < -8 || sx > w + 8 || sy > h + 8) continue;
      H.x.push(sx); H.y.push(sy); H.d.push(d); H.i.push(i);
      any = true;
    }
    if (any) d.used = performance.now();
  }
  H.n = H.x.length * step;
  hits = H;
  if (!H.x.length) return;
  const r = Math.max(1, Math.min(4, 1 + 0.6 * Math.log2(k / 12)));
  const many = H.x.length > 4000;
  const shape = (x, y, s) => { if (many) ctx.rect(x - s, y - s, 2 * s, 2 * s); else { ctx.moveTo(x + s, y); ctx.arc(x, y, s, 0, 2 * Math.PI); } };
  // A halo only where dots are sparse enough to tell apart.
  if (!many) {
    ctx.beginPath();
    for (let j = 0; j < H.x.length; j++) shape(H.x[j], H.y[j], r + 1);
    ctx.fillStyle = api.C.halo; ctx.fill();
  }
  ctx.beginPath();
  for (let j = 0; j < H.x.length; j++) shape(H.x[j], H.y[j], r);
  ctx.fillStyle = COLORS[api.dark ? 'dark' : 'light'].dot; ctx.fill();

  if (k >= K_LABELS && !api.moving) drawLabels(api, r);
}

// Codes nearest the middle of the window are labelled first; a label that would overlap another is skipped.
function drawLabels(api, r) {
  const { ctx, w, h, k } = api;
  const cx = w / 2, cy = h / 2;
  const dist = j => (hits.x[j] - cx) ** 2 + (hits.y[j] - cy) ** 2;
  const order = hits.x.map((_, j) => j).sort((a, b) => dist(a) - dist(b));
  const rows = new Map(); // 8px bands -> [x0, x1] spans taken
  const free = (x0, x1, y0, y1) => {
    for (let b = Math.floor(y0 / 8); b <= Math.floor(y1 / 8); b++) for (const [a, z] of rows.get(b) || []) if (x0 < z && x1 > a) return false;
    return true;
  };
  const take = (x0, x1, y0, y1) => { for (let b = Math.floor(y0 / 8); b <= Math.floor(y1 / 8); b++) { if (!rows.has(b)) rows.set(b, []); rows.get(b).push([x0, x1]); } };
  ctx.font = `500 11px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.5;
  let placed = 0;
  for (const j of order) {
    if (placed >= 350) break;
    const x = hits.x[j], y = hits.y[j], d = hits.d[j], i = hits.i[j];
    const text = k >= K_PLACES ? `${d.code[i]} ${d.place[i]}` : d.code[i];
    const tw = ctx.measureText(text).width, x0 = x + r + 3, x1 = x0 + tw + 2;
    if (!free(x0, x1, y - 7, y + 7)) continue;
    take(x0, x1, y - 7, y + 7);
    ctx.strokeStyle = api.C.halo; ctx.strokeText(text, x0, y);
    ctx.fillStyle = api.C.text; ctx.fillText(text, x0, y);
    placed++;
  }
}

// ---------- clicks ----------

function codeRows(d, i) {
  const c = index.countries[d.cc], ex = d.extra[i];
  const rows = [];
  if (c.grouped) {
    const [n, first, last] = ex.split(' ');
    rows.push(['Codes in this group', `${(+n).toLocaleString('en')}, from ${esc(first)} to ${esc(last)}`]);
  } else rows.push(['Postal code', esc(d.code[i])]);
  const others = c.grouped ? 0 : +ex || 0;
  rows.push([c.grouped ? 'Main place' : 'Place', esc(d.place[i]) + (others ? ` and ${others} other place${others > 1 ? 's' : ''}` : '')]);
  if (d.a1[d.i1[i]]) rows.push(['State or region', esc(d.a1[d.i1[i]])]);
  if (d.a2[d.i2[i]]) rows.push(['County or district', esc(d.a2[d.i2[i]])]);
  rows.push(['Usual format', !c.fmt ? `No national postal codes; GeoNames codes here look like ${esc(c.gfmt)}, as in ${esc(c.ex)}`
    : `${esc(c.fmt)} (9 stands for a digit, A for a letter)${c.gfmt ? `; GeoNames has only ${esc(c.gfmt)}` : ''}, as in ${esc(c.ex)}`]);
  const a = d.acc[i];
  // GeoNames accuracy: 1 estimated, 4 from the GeoNames place, 6 centroid of addresses or shape.
  const how = a >= 6 ? 'centroid of its addresses or area' : a >= 4 ? 'position of the GeoNames place it belongs to' : a >= 1 ? 'estimate' : 'position with no accuracy given';
  const scale = a ? ` (GeoNames accuracy ${a}, scale 1 to 6)` : '';
  rows.push(['Position', c.grouped ? `Median of the positions of its codes${a ? ` (best GeoNames accuracy ${a}, scale 1 to 6)` : ''}`
    : `A point, not the code's area: ${how}${scale}`]);
  if (c.partial) rows.push(['Coverage', esc(c.partial)]);
  if (c.grouped) rows.push(['Coverage', esc(c.grouped)]);
  return rows;
}

async function nearest(at) {
  const [lon, lat] = at;
  if (!index) await indexReady?.catch(() => {});
  if (!index) return [['Postal codes', 'Did not load. Try again in a moment.']];
  const ccs = filesWithin(at, NEAR_KM / 6371);
  if (!ccs.length) return [['Postal codes', `GeoNames has no postal codes within about ${NEAR_KM} km of here.`]];
  const got = await Promise.allSettled(ccs.map(cc => load(cc)));
  const ds = got.filter(g => g.status === 'fulfilled').map(g => g.value);
  const missing = [...new Set(ccs.filter((_, j) => got[j].status === 'rejected').map(ccOf))].map(countryName);
  const note = missing.length ? [['Did not load', `Codes for ${esc(missing.join(', '))}. Try again in a moment.`]] : [];
  if (!ds.length) return [['Postal codes', 'Did not load. Try again in a moment.']];
  // A click on a dot lists the codes around it, without the dot itself (app.js may round the point slightly).
  const fromDot = lastPick && Math.abs(lastPick.at[0] - lon) < 1e-6 && Math.abs(lastPick.at[1] - lat) < 1e-6;
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), best = [];
  for (const d of ds) {
    for (let i = 0; i < d.n; i++) {
      if (fromDot && lastPick.d === d && lastPick.i === i) continue;
      const km = Math.hypot((((d.lon[i] - lon + 540) % 360) - 180) * kx, (d.lat[i] - lat) * 110.57);
      if (km > NEAR_KM || (best.length === 5 && km >= best[4][0])) continue;
      best.push([km, d, i]);
      best.sort((a, b) => a[0] - b[0]);
      if (best.length > 5) best.pop();
    }
  }
  if (!best.length) return [['Postal codes', `None within ${NEAR_KM} km in GeoNames.`], ...note];
  const mixed = new Set(best.map(b => b[1].cc)).size > 1;
  const list = best.map(([km, d, i]) =>
    `${esc(d.code[i])} ${esc(d.place[i])}${mixed ? ` (${esc(countryName(d.cc))})` : ''}: ${km < 10 ? km.toFixed(1) : Math.round(km)} km`).join('<br>');
  return [[fromDot ? 'Other codes nearby' : 'Nearest codes', list],
    ['Distances', 'Straight line to each code\'s estimated centre'], ...note];
}

// ---------- legend ----------

function legend() {
  const cs = COLORS[isDark() ? 'dark' : 'light'];
  const items = [...KINDS.map(([id, label]) => `<li><i style="--c:${cs[id]}"></i>${label}</li>`),
    '<li><i style="--c:var(--land)"></i>No codes in the data</li>',
    `<li><i style="--c:${cs.dot}"></i>A code's estimated centre</li>`];
  return `<ul class="swatches">${items.join('')}</ul>
    ${indexFailed ? '<p class="note keep">The list of postal code files did not load. Choose the map again to retry.</p>' : ''}
    ${failedNames ? `<p class="note keep">Codes for ${esc(failedNames)} did not load. Moving or clicking the map tries again.</p>` : ''}`;
}

export default {
  id: 'postal', name: 'Postal codes', group: 'Countries and borders',
  // A getter, so the download date shows once the file list has loaded (the load refreshes the credit line).
  get credit() {
    return `Postal codes: <a href="https://www.geonames.org/">GeoNames</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)${index ? `, downloaded ${esc(index.built)}` : ''}. Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>. Detail: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`;
  },
  onMap: ({ k }) => (k < 4 ? '' : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'), // the OSM tiles from k = 4
  ownsColour: true,
  darkTiles: true,
  layers: ({ k }) => { lastK = k; return k < 4 ? [] : [{ src: OSM, opacity: fade(k, 4, 7) }]; },
  vector: 'full',
  // Zoomed in, a click away from a dot lists the nearest codes; at globe view it opens the country.
  get click() { return lastK >= K_DOTS ? 'point' : 'country'; },
  query: nearest,
  legend,
  overlay: {
    async load(api) {
      refresh = api.refresh;
      indexFailed = false;
      indexReady = fetch(new URL('index.json', DATA)).then(r => { if (!r.ok) throw new Error(`postal index returned ${r.status}`); return r.json(); });
      let ix;
      try { ix = await indexReady; } catch (e) { indexFailed = true; refresh(); throw e; }
      const byCell = new Map();
      for (const [cc, c] of Object.entries(ix.countries)) for (const cell of c.cells) { if (!byCell.has(cell)) byCell.set(cell, []); byCell.get(cell).push(`${cc}-${cell}`); }
      cells = [...byCell].map(([cell, ccs]) => [[(cell % 72) * 5 - 177.5, Math.floor(cell / 72) * 5 - 87.5], ccs]);
      index = ix;
      // Without the country maps the dots still work; only the globe-view colouring is lost.
      const get = u => fetch(u).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const [hi, lo] = await Promise.all([get(MAP_HI), get(MAP_LO)]);
      if (hi) world = { hi: shapes(hi), lo: lo ? shapes(lo) : null };
      queueMicrotask(refresh); // the legend can now name the partial countries
    },
    draw(api) {
      lastK = api.k;
      const R = viewRadius(api);
      // The colouring fades out as the dots come in.
      const a = 1 - fade(api.k, 5, K_DOTS);
      if (a > 0 && world) drawFills(api, a, R);
      if (api.k >= K_DOTS) drawDots(api, R);
      else { hits = NO_HITS; if (failedNames) { failedNames = ''; refresh(); } }
    },
    pick(x, y) {
      let best = -1, bd = 10;
      for (let j = 0; j < hits.x.length; j++) {
        const dd = Math.hypot(hits.x[j] - x, hits.y[j] - y);
        if (dd < bd) { bd = dd; best = j; }
      }
      if (best < 0) return null;
      const d = hits.d[best], i = hits.i[best];
      const at = [d.lon[i], d.lat[i]];
      lastPick = { d, i, at };
      return { title: d.code[i], sub: `${d.place[i]}, ${countryName(d.cc)}`, at, rows: codeRows(d, i) };
    }
  }
};

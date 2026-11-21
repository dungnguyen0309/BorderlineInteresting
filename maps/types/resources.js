/* global d3, topojson */
// Resources: three views picked under the map type menu.
//   rents     natural resource rents by country, % of GDP, 2021 or the latest year since 2015 (World Bank WDI), drawn from world-atlas shapes
//   plants    power plants by fuel and capacity (WRI Global Power Plant Database v1.3.0, about 2019)
//   minerals  USGS MRDS deposit reports as live WMS tiles, with GetFeatureInfo on click
// Data built by scripts/build_resources.py into data/maps/resources/.

const DIR = new URL('../../data/maps/resources/', import.meta.url).href;
const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/';
const WMS = 'https://mrdata.usgs.gov/services/mrds?service=WMS&version=1.1.1&layers=mrds&styles=&srs=EPSG:3857';
const OSM = { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 };
const D2R = Math.PI / 180, R_MERC = 6378137, HALF = Math.PI * R_MERC;

const VIEWS = [
  ['rents', 'Resource rents by country'],
  ['plants', 'Power plants by fuel'],
  ['minerals', 'Mineral deposit reports']
];
const RENTS = ['Total', 'Oil', 'Natural gas', 'Coal', 'Minerals', 'Forests'];
const STEPS = [1, 2.5, 5, 10, 20, 40]; // % of GDP
// Fuel groups: Okabe-Ito colours (colour-blind safe); coal and hydro change with the theme to stay visible.
const FUELS = [
  ['Coal', ['Coal'], '#2b2b2b', '#d9d9d9'],
  ['Gas', ['Gas'], '#e69f00'],
  ['Oil', ['Oil', 'Petcoke'], '#d55e00'],
  ['Nuclear', ['Nuclear'], '#cc79a7'],
  ['Hydro', ['Hydro'], '#0072b2', '#4ea3dc'],
  ['Wind', ['Wind'], '#56b4e9', '#9ed3f2'],
  ['Solar', ['Solar'], '#f0e442'],
  ['Bioenergy', ['Biomass', 'Waste'], '#009e73'],
  ['Other', ['Geothermal', 'Storage', 'Wave and Tidal', 'Cogeneration', 'Other'], '#999999']
];
// MRDS symbols, recoloured from the service's red, green, blue and black (light theme, dark theme).
const MRDS = [
  ['Mine, past or present', true, '#d55e00', '#f08a4b'],
  ['Prospect or occurrence', false, '#009e73', '#3fc19a'],
  ['Processing plant', true, '#0072b2', '#5aa9e6'],
  ['Status unknown', false, '#1b2026', '#e7eaee']
];

let view = 'rents', rent = 0, AC = { land: '#f7f6f1', hatch: 'rgba(27,32,38,0.42)' }, API = null; // AC: the app's live theme colours, from setup
const data = {};
const NODATA = 'nodata';
const fade = (k, a, b) => Math.max(0, Math.min(1, (Math.log(k) - Math.log(a)) / (Math.log(b) - Math.log(a))));
const json = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); });
// Loads a part once; a failure is forgotten so the next use retries.
const once = (key, f) => (data[key] ??= f().catch(e => { delete data[key]; throw e; }));
const inBox = ([[w, s], [e, n]], [x, y]) => y >= s && y <= n && (w <= e ? x >= w && x <= e : x >= w || x <= e);
const num = v => (v === 0 ? '0' : v < 1 ? v.toFixed(2) : v.toFixed(1));

// ---------- shapes drawn into Web Mercator tiles ----------
// Country colours and land are drawn into map tiles once, so turning the globe moves textures on the GPU
// instead of re-projecting every border each frame. The app then draws only the borders over them.

const atlas = res => once('atlas' + res, () => json(`${ATLAS}countries-${res}.json`));
// [coarse, detailed] lists of { geo, box, id }: world-atlas 110m for the whole globe, 50m closer in.
// Land is one shape for the whole world, so it is split into its islands and continents, which tiles can skip.
const pieces = f => (f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c })) : [f]);
const polygons = (key, object, split) => once(key, () => Promise.all([atlas('110m'), atlas('50m')]).then(ts => ts.map(t =>
  topojson.feature(t, t.objects[object]).features.flatMap(f => (split ? pieces(f) : [f]).map(g => ({ geo: g, box: d3.geoBounds(g), id: f.id }))))));
const loadLand = () => polygons('land', 'land', true);
const loadCountries = () => polygons('countries', 'countries', false);

const mercLat = t => Math.atan(Math.sinh(Math.PI * (1 - 2 * t))) / D2R;
// Paints the shapes that touch tile t, one fill per colour; colour(item) returns null to leave a shape out.
// Country edges are resampled along great circles as the app's borders are (some straight borders are one long
// edge); coastlines have dense vertices, so land skips it (`resample` 0), which halves the cost.
function paintTile(t, [lo, hi], colour, resample = 0.5) {
  const size = 256, n = 2 ** t.z, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const proj = d3.geoMercator().scale(size * n / (2 * Math.PI)).translate([size * n / 2 - t.x * size, size * n / 2 - t.y * size])
    .clipExtent([[-1, -1], [size + 1, size + 1]]).precision(resample);
  const w = t.x / n * 360 - 180, e = w + 360 / n, N = mercLat(t.y / n), S = mercLat((t.y + 1) / n);
  const path = d3.geoPath(proj, g), groups = new Map();
  for (const it of t.z <= 2 ? lo : hi) {
    const [[a, s], [b, nn]] = it.box;
    if (s > N || nn < S || (a <= b && (a > e || b < w))) continue;
    const col = colour(it);
    if (!col) continue;
    if (!groups.has(col)) groups.set(col, []);
    groups.get(col).push(it.geo);
  }
  for (const [col, geos] of groups) {
    g.beginPath(); for (const geo of geos) path(geo);
    g.fillStyle = col === NODATA ? AC.land : col; g.fill();
    if (col === NODATA) { g.fillStyle = g.createPattern(dotTile(), 'repeat'); g.fill(); }
  }
  return c;
}
// No data: the app's own dot pattern (as in its legend), so it cannot pass for the palest class.
function dotTile() {
  const c = document.createElement('canvas');
  c.width = c.height = 5;
  const g = c.getContext('2d');
  g.fillStyle = AC.hatch; g.beginPath(); g.arc(2.5, 2.5, 0.85, 0, 2 * Math.PI); g.fill();
  return c;
}
// A close tile takes 10 to 40 ms to paint, and a drag can reveal several at once: they are painted one per frame,
// each just after a frame is drawn, so the globe keeps turning smoothly while they fill in.
let painting = Promise.resolve();
function nextFrame(f) {
  const p = painting.then(() => new Promise(ok => requestAnimationFrame(() => setTimeout(ok)))).then(f);
  painting = p.catch(() => {});
  return p;
}
const tileSrc = (id, load) => ({ id, maxZoom: 9, url: (z, x, y) => `${z}/${x}/${y}`, load: (u, t) => nextFrame(() => load(t)) });
const landSrc = dark => tileSrc(`resources-land-${dark ? 'dark' : 'light'}`, t => loadLand().then(L => paintTile(t, L, () => AC.land, 0)));

function rentColours(dark) {
  // Light: pale to dark blue-green. Dark: dim to bright (viridis). Both read in order for colour-blind viewers.
  return dark ? d3.quantize(t => d3.interpolateViridis(0.1 + t * 0.9), STEPS.length + 1)
    : d3.quantize(t => d3.interpolateYlGnBu(0.1 + t * 0.9), STEPS.length + 1);
}
const step = v => { const i = STEPS.findIndex(s => v < s); return i < 0 ? STEPS.length : i; };
const loadRents = () => once('rents', () => json(DIR + 'rents.json').then(R => (data.rentsReady = R)));
// One tile source per theme and rent, made when first shown.
const rentSrcs = new Map();
function rentSrc(dark, r) {
  const id = `resources-rents-${dark ? 'dark' : 'light'}-${r}`;
  if (!rentSrcs.has(id)) {
    const cols = rentColours(dark);
    rentSrcs.set(id, tileSrc(id, t => Promise.all([loadRents(), loadCountries()]).then(([R, P]) =>
      paintTile(t, P, it => { const v = R.countries[it.id]?.[r]; return v == null ? NODATA : cols[step(v)]; }))));
  }
  return rentSrcs.get(id);
}

async function rentsAt(at) {
  const [R, [, hi]] = await Promise.all([loadRents(), loadCountries()]);
  const f = hi.find(f => inBox(f.box, at) && d3.geoContains(f.geo, at));
  if (!f) return [];
  const v = R.countries[f.id]; // six rents, then the year they are from
  if (!v) return [['Resource rents', `No data from ${R.first} to ${R.year}`]];
  return [
    ...RENTS.map((name, i) => [i ? `${name} rents` : 'Total resource rents', v[i] == null ? 'No data' : `${num(v[i])}% of GDP`]),
    ['Year', v[6] < R.year ? `${v[6]}, the latest year with data for this country (most countries: ${R.year})` : `${R.year}, the latest the World Bank has published`]
  ];
}

// ---------- power plants ----------

const loadPlants = () => once('plants', () => json(DIR + 'plants.json').then(p => {
  const n = p.lon.length, group = p.fuels.map(f => FUELS.findIndex(g => g[1].includes(f)));
  const P = {
    n, fuels: p.fuels, fuel: Uint8Array.from(p.fuel), mw: Float32Array.from(p.mw), lon: Float64Array.from(p.lon), lat: Float64Array.from(p.lat),
    group: Uint8Array.from(p.fuel, f => (group[f] < 0 ? FUELS.length - 1 : group[f])),
    cosLat: new Float64Array(n), sinLat: new Float64Array(n), cosLon: new Float64Array(n), sinLon: new Float64Array(n),
    count: FUELS.map(() => 0), gw: FUELS.map(() => 0)
  };
  for (let i = 0; i < n; i++) {
    const a = p.lat[i] * D2R, b = p.lon[i] * D2R;
    P.cosLat[i] = Math.cos(a); P.sinLat[i] = Math.sin(a); P.cosLon[i] = Math.cos(b); P.sinLon[i] = Math.sin(b);
    P.count[P.group[i]]++; P.gw[P.group[i]] += p.mw[i] / 1000;
  }
  data.plantsReady = P;
  return P;
}));
const loadInfo = () => once('info', () => json(DIR + 'plants-info.json').then(I => (data.infoReady = I)));

// Screen position of every plant on the near side, written into xs/ys (NaN when hidden). The orthographic
// projection written out (as in engine.js), so 35,000 points cost no allocations per frame.
let xs = new Float32Array(0), ys = new Float32Array(0), placedFor = '';
function placePlants(P, api) {
  if (xs.length < P.n) { xs = new Float32Array(P.n); ys = new Float32Array(P.n); }
  const [rl, rp, rg = 0] = api.proj.rotate(), s = api.proj.scale(), [tx, ty] = api.proj.translate();
  // Hover picks between frames reuse the last placement.
  const key = `${rl},${rp},${rg},${s},${tx},${ty},${api.w},${api.h}`;
  if (key === placedFor) return;
  placedFor = key;
  const cd = Math.cos(rl * D2R), sd = Math.sin(rl * D2R), cp = Math.cos(rp * D2R), sp = Math.sin(rp * D2R), cg = Math.cos(rg * D2R), sg = Math.sin(rg * D2R);
  for (let i = 0; i < P.n; i++) {
    const cl = P.cosLon[i] * cd - P.sinLon[i] * sd, sl = P.sinLon[i] * cd + P.cosLon[i] * sd;
    const X = cl * P.cosLat[i], Y = sl * P.cosLat[i], Z = P.sinLat[i];
    const kk = Z * cp + X * sp;
    if (X * cp - Z * sp <= 0) { xs[i] = NaN; continue; }
    const x = tx + s * (Y * cg - kk * sg), y = ty - s * (kk * cg + Y * sg);
    if (x < -20 || y < -20 || x > api.w + 20 || y > api.h + 20) { xs[i] = NaN; continue; }
    xs[i] = x; ys[i] = y;
  }
}
// Dot radius in CSS pixels: area follows capacity, and dots grow slowly as the globe is zoomed in.
const radius = (mw, k) => Math.min(18, Math.sqrt(mw) * 0.085 * Math.pow(k, 0.4));

function drawPlants(api) {
  const P = data.plantsReady;
  if (!P) return;
  placePlants(P, api);
  const { ctx, k, dark, moving } = api;
  const dots = FUELS.map(() => new Path2D()), specks = FUELS.map(() => new Path2D());
  for (let i = 0; i < P.n; i++) {
    const x = xs[i];
    if (Number.isNaN(x)) continue;
    const r = radius(P.mw[i], k), g = P.group[i];
    if (r < 1.3) { if (!moving) specks[g].rect(x - 0.9, ys[i] - 0.9, 1.8, 1.8); continue; } // specks wait for the globe to stop
    dots[g].moveTo(x + r, ys[i]); dots[g].arc(x, ys[i], r, 0, 2 * Math.PI);
  }
  ctx.lineWidth = 0.6;
  ctx.strokeStyle = dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)';
  FUELS.forEach((f, g) => {
    ctx.fillStyle = (dark && f[3]) || f[2];
    ctx.fill(specks[g]);
    ctx.globalAlpha = 0.85; ctx.fill(dots[g]); ctx.globalAlpha = 1;
    if (!moving) ctx.stroke(dots[g]);
  });
}

function pickPlant(x, y, api) {
  const P = data.plantsReady;
  if (!P) return null;
  placePlants(P, api);
  let best = -1, bd = Infinity;
  for (let i = 0; i < P.n; i++) {
    if (Number.isNaN(xs[i])) continue;
    const d = Math.hypot(xs[i] - x, ys[i] - y);
    if (d < Math.max(6, radius(P.mw[i], api.k) + 2) && d < bd) { bd = d; best = i; }
  }
  if (best < 0) return null;
  loadInfo().catch(() => {}); // names are fetched on the first hover, so they are usually there by the click
  const I = data.infoReady, fuel = P.fuels[P.fuel[best]], more = site(P, P.lon[best], P.lat[best]).length - 1;
  return {
    title: I ? I.name[best] : `${fuel} power plant`,
    sub: `${fuel}, ${P.mw[best].toLocaleString('en')} MW${more ? `; ${more} more ${more > 1 ? 'plants' : 'plant'} at this site` : ''}`,
    at: [P.lon[best], P.lat[best]], rows: []
  };
}
// Every plant at exactly this position (up to 14 share one), largest first as the data is sorted by capacity.
function site(P, lon, lat) {
  const out = [];
  for (let j = 0; j < P.n; j++) if (Math.abs(P.lon[j] - lon) < 1e-6 && Math.abs(P.lat[j] - lat) < 1e-6) out.push(j);
  return out;
}

async function plantAt(at, api) {
  const [P, I] = await Promise.all([loadPlants(), loadInfo()]);
  const [i, ...others] = site(P, at[0], at[1]);
  if (i == null) return [];
  const e = api.esc, y = I.year[i], mw = j => `${P.mw[j].toLocaleString('en')} MW`;
  const rows = [
    ['Plant', e(I.name[i])],
    ['Fuel', e(P.fuels[P.fuel[i]])],
    ['Capacity', `${mw(i)}${I.capyear[i] ? ` (as of ${I.capyear[i]})` : ''}`],
    // A fractional year in the source is the capacity-weighted average of the units' opening years.
    ['Commissioned', !y ? 'Not recorded' : Number.isInteger(y) ? String(y) : `${Math.round(y)} (average of its units' years, weighted by capacity)`],
    ['Owner', I.owners[I.owner[i]] ? e(I.owners[I.owner[i]]) : 'Not recorded'],
    ['Data source', e(I.sources[I.source[i]] || 'Not recorded')],
    ['Database id', `${e(I.id[i])} (${e(I.country[i])})`]
  ];
  if (others.length) rows.push(['Also at this site', others.map(j => `${e(I.name[j])}, ${e(P.fuels[P.fuel[j]])}, ${mw(j)}`).join('<br>')]);
  return rows;
}

// ---------- mineral deposits (USGS MRDS) ----------

function bbox3857(z, x, y) {
  const s = 2 * HALF / 2 ** z;
  return [-HALF + x * s, HALF - (y + 1) * s, -HALF + (x + 1) * s, HALF - y * s].join(',');
}
// The service draws red, green, blue and black symbols; they are swapped for colour-blind safe ones per theme.
function recolour(img, dark, z) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  const cols = MRDS.map(m => d3.rgb(dark ? m[3] : m[2]));
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const [r, gg, b] = [px[i], px[i + 1], px[i + 2]];
    const col = r > gg + 40 && r > b + 40 ? cols[0] : gg > r + 40 && gg > b + 40 ? cols[1] : b > r + 40 && b > gg + 40 ? cols[2] : cols[3];
    px[i] = col.r; px[i + 1] = col.g; px[i + 2] = col.b;
  }
  g.putImageData(d, 0, 0);
  // Zoomed out the service draws each report as one pixel: thicken to 2 px so they can be seen.
  if (z <= 5) { g.drawImage(c, 1, 0); g.drawImage(c, 0, 1); }
  return c;
}
// The service is live, not a copy, and at times takes 30 s or more per map, or fails. Each tile load gives up after
// TIMEOUT so it frees its place in the map's tile queue; three failures in a row mark the service down.
const TIMEOUT = 10000;
let mrdsTry = 0, mrdsFails = 0;
const onResources = () => API && document.getElementById('mapType')?.value === 'resources';
function mrdsFailed(n) {
  if (++mrdsFails < 3 || n !== mrdsTry || data.mrds !== 'ok') return;
  data.mrds = 'down';
  if (onResources()) API.refresh();
}
// A live map service, not a tile cache: 512 px tiles halve the number of requests.
const mrdsSrc = (dark, n) => ({
  id: `resources-mrds-${dark ? 'dark' : 'light'}-${n}`, tileSize: 512, maxZoom: 15,
  url: (z, x, y) => `${WMS}&request=GetMap&bbox=${bbox3857(z, x, y)}&width=512&height=512&format=image/png&transparent=true`,
  load: (url, t) => fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
    .then(r => { if (!r.ok) throw new Error(`MRDS tile ${r.status}`); return r.blob(); })
    .then(b => createImageBitmap(b))
    .then(img => { mrdsFails = 0; const c = recolour(img, dark, t.z); img.close(); return c; },
      e => { mrdsFailed(n); throw e; })
});
const SRC = { land: [landSrc(false), landSrc(true)], mrds: null };
// One small map request before any tiles: while the service is down, its tiles would hold every tile load for
// TIMEOUT each. New tile source ids per try, so tiles that failed before are asked for again.
function checkMrds() {
  if (data.mrds) return;
  const n = ++mrdsTry;
  data.mrds = 'checking'; mrdsFails = 0;
  SRC.mrds = [mrdsSrc(false, n), mrdsSrc(true, n)];
  fetch(`${WMS}&request=GetMap&bbox=${bbox3857(10, 190, 390)}&width=8&height=8&format=image/png&transparent=true`, { signal: AbortSignal.timeout(TIMEOUT) })
    .then(r => { if (!r.ok) throw new Error(r.status); return 'ok'; })
    .catch(() => 'down')
    .then(s => { if (n !== mrdsTry) return; data.mrds = s; if (onResources()) API.refresh(); });
}

const loadCodes = () => once('codes', () => json(DIR + 'mrds-codes.json'));
async function depositsAt(at, api) {
  const lat = Math.max(-85, Math.min(85, at[1]));
  const x = R_MERC * at[0] * D2R, y = R_MERC * Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2));
  // Mercator metres per CSS pixel at this zoom; a query pixel is 2 screen pixels, so the service's own
  // few-pixel tolerance covers a click that is slightly off a symbol.
  const mpx = R_MERC / api.proj.scale() / Math.cos(lat * D2R), q = mpx * 2, MAX = 100;
  const url = `${WMS}&request=GetFeatureInfo&query_layers=mrds&bbox=${[x - 50 * q, y - 50 * q, x + 50 * q, y + 50 * q].join(',')}` +
    '&width=101&height=101&x=50&y=50&info_format=application/vnd.ogc.gml&feature_count=' + MAX;
  let xml, codes;
  try {
    [xml, codes] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(12000) }).then(r => { if (!r.ok) throw new Error(r.status); return r.text(); }),
      loadCodes().catch(() => ({}))
    ]);
  } catch {
    return [['Deposit reports', 'The USGS service did not answer. Try again in a moment.']];
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const val = (el, tag) => el.getElementsByTagName(tag)[0]?.textContent.trim() || '';
  const all = [...doc.getElementsByTagName('*')].filter(el => el.localName.endsWith('_feature'));
  const found = all.map(el => {
    const [fx, fy] = val(el, 'gml:coordinates').split(/[ ,]/).map(Number);
    return { el, d: Math.hypot(fx - x, fy - y) / mpx };
  }).filter(f => f.d <= 14).sort((a, b) => a.d - b.d);
  const e = api.esc;
  if (!found.length) return [['Deposit reports', 'None at this point. Click on a symbol; zoom in to separate them.']];
  const f = found[0].el, id = val(f, 'dep_id'), link = val(f, 'url');
  const goods = val(f, 'code_list').split(/\s+/).filter(Boolean).map(c => codes[c] || c);
  const rows = [
    ['Deposit', e(val(f, 'site_name') || 'Unnamed')],
    ['Status', e(val(f, 'dev_stat') || 'Unknown')],
    ['Commodities', goods.length ? e(goods.join(', ')) : 'Not recorded'],
    ['Record', link.startsWith('https://mrdata.usgs.gov/') ? `<a href="${e(link)}" target="_blank" rel="noopener">MRDS ${e(id)}</a>` : e(id)]
  ];
  if (found.length > 1) {
    const more = found.slice(1, 5).map(o => e(val(o.el, 'site_name') || 'Unnamed')).join(', ');
    rows.push(['Nearby', `${more}${all.length >= MAX ? ' and many more (zoom in to separate them)' : found.length > 5 ? ` and ${found.length - 5} more` : ''}`]);
  }
  return rows;
}

// ---------- the map type ----------

function need() {
  return view === 'rents' ? Promise.all([loadRents(), loadCountries()])
    : view === 'plants' ? Promise.all([loadPlants(), loadLand()]) : Promise.all([loadLand(), loadCodes()]);
}

// Loads what the chosen view needs; a failure is said in the legend, with a button to try again.
function changed() {
  const v = view;
  data.err = null;
  if (data.mrds === 'down') data.mrds = null; // asks the USGS service again
  API.refresh();
  need().then(() => { if (onResources()) API.refresh(); },
    e => { console.warn(e); if (view === v) data.err = v; if (onResources()) API.refresh(); });
}
document.addEventListener('click', e => { if (e.target.closest?.('#resRetry')) changed(); });
const retry = text => `<p class="note keep">${text} <button type="button" id="resRetry">Try again</button></p>`;

function swatches(rows, cls = '') {
  return `<ul class="swatches${cls}">${rows.map(([c, t, hollow]) => (c === NODATA ? `<li><i class="nodata"></i>${t}</li>`
    : `<li><i style="--c:${hollow ? 'transparent' : c}${hollow ? `;outline:2px solid ${c};outline-offset:-2px` : ''}"></i>${t}</li>`)).join('')}</ul>`;
}

export default {
  id: 'resources', name: 'Resources', group: 'Economy',
  // The rents view colours the countries itself; power plants and deposits are drawn over plain land.
  get ownsColour() { return view === 'rents'; },
  credit: '<a href="https://datacatalog.worldbank.org/search/dataset/0037712">World Bank WDI</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>) · ' +
    '<a href="https://github.com/wri/global-power-plant-database">WRI Global Power Plant Database 1.3.0</a> (CC BY 4.0) · ' +
    '<a href="https://mrdata.usgs.gov/mrds/">USGS MRDS</a> · <a href="https://www.naturalearthdata.com/">Natural Earth</a> · ' +
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  // OSM tiles fade in from k 40; the corner is only rewritten on refresh, so the credit stays at every zoom.
  onMap: ({ k }) => (k < 40 ? '' : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'), // OSM tiles from k = 40

  layers({ k, dark }) {
    // Past k 40 the app draws no borders over tiles, so OpenStreetMap fades in for borders, places and roads.
    const i = dark ? 1 : 0, osm = { src: OSM, opacity: k < 40 ? 0 : fade(k, 40, 80) };
    if (view === 'rents') return [osm, { src: rentSrc(dark, rent), opacity: 1 - 0.5 * osm.opacity }];
    if (view === 'plants') return [{ src: SRC.land[i] }, osm];
    checkMrds();
    return [{ src: SRC.land[i] }, osm, ...(data.mrds === 'ok' ? [{ src: SRC.mrds[i] }] : [])];
  },
  vector: 'lines',
  get click() { return view === 'plants' ? 'country' : 'point'; },

  setup(api) {
    AC = api.C; API = api;
    if (data.mrds === 'down') data.mrds = null; // choosing the map again asks the USGS service again
    const t = api.tools;
    t.style.marginBottom = '14px';
    t.innerHTML = `<label for="resView" class="field">Show</label><select id="resView">${VIEWS.map(([v, n]) => `<option value="${v}"${v === view ? ' selected' : ''}>${n}</option>`).join('')}</select>` +
      `<div id="resRentRow"${view === 'rents' ? '' : ' hidden'}><label for="resRent" class="field" style="margin-top:10px">Rents from</label><select id="resRent">${RENTS.map((n, i) => `<option value="${i}"${i === rent ? ' selected' : ''}>${i ? n : 'All resources (total)'}</option>`).join('')}</select></div>`;
    t.querySelector('#resView').addEventListener('change', e => {
      view = e.target.value;
      t.querySelector('#resRentRow').hidden = view !== 'rents';
      changed();
    });
    t.querySelector('#resRent').addEventListener('change', e => { rent = +e.target.value; api.refresh(); });
  },

  query(at, api) {
    return view === 'rents' ? rentsAt(at) : view === 'plants' ? plantAt(at, api) : depositsAt(at, api);
  },

  legend() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const failed = data.err === view ? retry('The data for this view did not load.') : '';
    if (view === 'rents') {
      const R = data.rentsReady || { first: 2015, year: 2021 }, cols = rentColours(dark); // years as last built, until rents.json loads
      const rows = cols.map((c, i) => [c, i === 0 ? `Under ${STEPS[0]}%` : i === STEPS.length ? `${STEPS[i - 1]}% and over` : `${STEPS[i - 1]} to ${STEPS[i]}%`]).reverse();
      return `<p>${rent ? RENTS[rent] : 'Total natural resource'} rents, % of GDP, ${R.year}</p>` + failed +
        swatches([...rows, [NODATA, `No data from ${R.first} to ${R.year}`]], ' ord');
    }
    if (view === 'plants') {
      const P = data.plantsReady;
      return failed + swatches(FUELS.map((f, g) => [(dark && f[3]) || f[2], P ? `${f[0]}, ${Math.round(P.gw[g]).toLocaleString('en')} GW` : f[0]])) +
        '<p class="note keep">Dot area shows capacity in megawatts (MW); the smallest plants are specks.</p>';
    }
    return (failed || (data.mrds === 'down' ? retry('The USGS deposit map service is not answering right now, so no deposits can be drawn.') : '')) +
      swatches(MRDS.map(([t, solid, l, d]) => [dark ? d : l, t, !solid]));
  },

  overlay: {
    load: () => need(),
    draw(api) { if (view === 'plants') drawPlants(api); },
    pick: (x, y, api) => (view === 'plants' ? pickPlant(x, y, api) : null)
  }
};

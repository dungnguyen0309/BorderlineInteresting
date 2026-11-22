/* global d3, topojson */
import { tileLayer } from './maps/engine.js';
import { MAP_TYPES, GROUP_ORDER, mapType, loadType, label } from './maps/types.js';
import { elevationAt } from './maps/relief.js';
import { drawFlags } from './maps/flags.js';
import { MAP_FONT, MAP_FACES, CAPS_TRACKING, textWidth } from './maps/fonts.js';

const $ = s => document.querySelector(s);

if (!window.d3 || !window.topojson) {
  failLoad('The map library did not load.');
  throw new Error('d3 or topojson-client missing');
}

const MAP_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
// Drawn while the globe moves (drag, zoom, flights): about a tenth of the points, so frames stay smooth.
// The detailed map comes back as soon as the globe stops.
const MAP_URL_LO = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
// Zoomed in, the 1:50m corners show, so the 1:10m map (3.7 MB) is loaded the first time a view needs it.
const MAP_URL_HI = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json';
const EARTH_KM = 6371;
// The map shown on entry and in links without ?map=.
const DEFAULT_MAP = 'reference';
const HOME = [60, 22];
const INCOMES = ['Low income', 'Lower middle income', 'Upper middle income', 'High income'];
// Figures are shaded in one yellow-brown band, clear of the blue sea for colour-blind readers too. Each ramp is
// checked against the land it sits on (dataviz validate_palette.js --ordinal): one hue, lightness rising in even
// steps, the faintest step at 2:1 or more on the land. Seven stops, so seven classes are exactly these colours.
const RAMPS = {
  light: d3.piecewise(d3.interpolateLab, ['#ccaa6c', '#c0934f', '#b37c31', '#a76406', '#915213', '#7a4117', '#623217']),
  // Dark land: more is more colour here too, from a dim brown-grey near the land to a saturated amber (never a pale
  // cream, which would read as paper or no data), lightness still rising in even steps.
  dark: d3.piecewise(d3.interpolateLab, ['#6a5a4c', '#876b4b', '#a27d4c', '#bb904e', '#d3a44f', '#eaba50', '#ffd152'])
};
// Names on a coloured country take dark or light ink, whichever stands out more from the fill, with a halo of the
// other: the ramps run from pale to deep brown, so no one ink reads on every class.
const INKS = [{ text: '#241c16', halo: 'rgba(255, 250, 240, 0.8)' }, { text: '#fffaf0', halo: 'rgba(36, 28, 22, 0.8)' }];
const lum = c => { const { r, g, b } = d3.rgb(c); return [r, g, b].map(v => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
const inkCache = new Map();
const inkOn = fill => {
  if (!inkCache.has(fill)) { const l = lum(fill); inkCache.set(fill, (l + 0.05) / (lum(INKS[0].text) + 0.05) >= (lum(INKS[1].text) + 0.05) / (l + 0.05) ? INKS[0] : INKS[1]); }
  return inkCache.get(fill);
};
// Map lettering in the printed-globe style on every map type (maps/fonts.js).
const LABEL_FONT = MAP_FONT;
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
// Read at each use, so a change of the setting applies without a reload.
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const still = () => motionQuery.matches;
// The durations of --dur-0, --dur-1 and --dur-2 in style.css (exits, feedback, routine changes), and its --ease-out.
const DUR_0 = 120, DUR_1 = 150, DUR_2 = 200, EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';
// A section or tab that opens settles in from 4px below (with reduced motion it only fades in): short enough not
// to slow a reader who switches quickly.
const enter = els => { for (const el of els) el.animate(still() ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: DUR_1, easing: EASE }); };
const coarse = matchMedia('(pointer: coarse)').matches;
const PICK_RADIUS = coarse ? 20 : 11;
const FLY = 500; // the shortest flight and a re-centre: quick enough not to feel like waiting
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const STATUS = {
  un: 'UN member', observer: 'UN observer state', defacto: 'Partly recognised state',
  dependent: 'Dependent territory', special: 'Special status'
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Accents, apostrophes and full stops are ignored, other punctuation counts as a space ("Cote d'Ivoire" = "cote divoire").
const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/['’.]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const big = v => d3.format('.3~s')(v).replace('G', 'B');
// Shares under 1% keep two significant figures (0.032%), so small fuel shares don't all read 0.0%.
const pct = v => (v && Math.abs(v) < 1 ? d3.format('.2~r')(v) : d3.format('.1~f')(v)) + '%';
const FMT = {
  count: big,
  usd: v => '$' + (Math.abs(v) < 1e5 ? d3.format(',.0f')(v) : big(v)),
  pct,
  years: v => d3.format('.1~f')(v) + ' years'
};
const km = v => (v < 10 ? d3.format('.1~r')(v) : d3.format(',')(Math.round(v / 10) * 10)) + ' km';
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
// Two significant figures, so legend breaks read as $27,000 rather than $27,104.
const nice = v => { if (!v) return 0; const p = 10 ** (Math.floor(Math.log10(Math.abs(v))) - 1); return +(Math.round(v / p) * p).toPrecision(2); };
const polyArea = ring => { const a = d3.geoArea({ type: 'Polygon', coordinates: ring }); return a > 2 * Math.PI ? 4 * Math.PI - a : a; };

const canvas = $('#globe');
const ctx = canvas.getContext('2d');
const proj = d3.geoOrthographic().clipAngle(90).precision(0.4).rotate([-HOME[0], -HOME[1]]);
const path = d3.geoPath(proj, ctx);
const graticule = d3.geoGraticule10();
// Map tiles (relief, streets, imagery) are drawn with WebGL on a canvas under the globe's own canvas.
const tiles = tileLayer($('#tiles'), { onChange: () => draw() });
const SPHERE = { type: 'Sphere' };

const S = {
  k: 1, base: 300, w: 0, h: 0, dpr: 1, sel: null, hover: null, mode: 'none', tab: 'overview',
  layers: new Set(), returnFocus: null, index: [], flying: false, listSort: 'value',
  scope: 'all', ghost: null, anti: null, hits: [], cur: 0, map: DEFAULT_MAP
};
const C = {};
// The light theme's colours, kept in dark mode for a globe drawn light in both themes (map types with paper).
const CP = {};
let topo, info, hot, blocs, features, borders, coast, bordersLo, coastLo, byArea, contested, hatch, hatchPaper, dots, dotsPaper;
const byIso = new Map(), byKey = new Map(), hotById = new Map(), layerById = new Map(), blocById = new Map();
let scales = {}, ranks = {};

// ---------- data ----------

async function load() {
  const get = u => fetch(u).then(r => { if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); });
  // The light map is optional: if it fails, the detailed one is drawn while moving too.
  const lightMap = fetch(MAP_URL_LO).then(r => (r.ok ? r.json() : null)).catch(() => null);
  // Name positions, one per shape of MAP_URL in its order; optional too: without them names go on the centroid.
  const labelData = fetch('data/labels.json').then(r => (r.ok ? r.json() : null)).catch(() => null);
  [topo, info, hot, blocs] = await Promise.all([MAP_URL, 'data/countries.json', 'data/hotspots.json', 'data/blocs.json'].map(get));
  const lab = await labelData;

  // The preparation yields to input every 40 ms (as loadHi does), so no one task holds the page for long on a slow phone.
  let since = performance.now();
  const breathe = async () => { if (performance.now() - since > 40) { await new Promise(r => setTimeout(r)); since = performance.now(); } };
  await breathe();
  const obj = topo.objects.countries;
  const nb = topojson.neighbors(obj.geometries);
  features = topojson.feature(topo, obj).features;
  const labels = lab?.map === MAP_URL && lab.labels?.length === features.length ? lab.labels : null;
  const keepLarger = (map, k, f) => { if (k && (!map.has(k) || map.get(k).area < f.area)) map.set(k, f); };
  for (const [i, f] of features.entries()) {
    await breathe();
    f.i = i;
    f.key = f.id ?? f.properties.name;
    f.d = info.countries[f.key] || { name: f.properties.name };
    f.geom = obj.geometries[i];
    f.nb = nb[i];
    f.bounds = d3.geoBounds(f);
    f.area = d3.geoArea(f);
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const areas = polys.map(polyArea), mi = d3.maxIndex(areas), main = polys[mi], mainArea = areas[mi];
    // The anchor frames the view; the label point (data/labels.json, built by scripts/build_labels.py) places the name.
    f.anchor = d3.geoCentroid({ type: 'Polygon', coordinates: main });
    f.label = labels?.[i] || f.anchor;
    // The view fits the "core": large polygons near the main one (both North and South Island, not French Guiana).
    f.core = {
      type: 'MultiPolygon',
      coordinates: polys.filter((q, i) => areas[i] >= 0.1 * mainArea && d3.geoDistance(d3.geoCentroid({ type: 'Polygon', coordinates: q }), f.anchor) < 0.52)
    };
    f.coreAt = d3.geoCentroid(f.core);
    // Two map shapes can share a code (Australia and Ashmore Is.); keep the larger one.
    keepLarger(byIso, f.d.iso3, f);
    keepLarger(byKey, f.key, f);
  }
  byArea = [...features].sort((a, b) => b.area - a.area);
  await breathe();
  for (const f of features) { f.cap = capOf(flatPoints(f.geometry)); await breathe(); }
  borders = topojson.mesh(topo, obj, (a, b) => a !== b);
  await breathe();
  coast = topojson.mesh(topo, obj, (a, b) => a === b);
  await breathe();

  // Light versions for motion: each shape's 1:110m counterpart (matched by code, or name where there is none);
  // small islands missing from 1:110m keep their detailed shape, which is cheap anyway.
  const lo = await lightMap;
  if (lo) {
    const lobj = lo.objects.countries;
    await breathe();
    const byLoKey = new Map(topojson.feature(lo, lobj).features.map(g => [g.id ?? g.properties.name, g]));
    const used = new Set();
    for (const f of byArea) {
      const g = byLoKey.get(f.key);
      // Two detailed shapes can share a code (Australia and Ashmore Is.): the larger takes the light shape, the other is skipped.
      f.lo = g && !used.has(g) ? g : g ? null : f;
      if (g) used.add(g);
    }
    bordersLo = topojson.mesh(lo, lobj, (a, b) => a !== b);
    await breathe();
    coastLo = topojson.mesh(lo, lobj, (a, b) => a === b);
  } else {
    for (const f of features) f.lo = f;
    bordersLo = borders; coastLo = coast;
  }

  hot.layers.forEach(l => { layerById.set(l.id, l); if (l.on) S.layers.add(l.id); });
  S.layers.add('contested');
  hot.items.forEach(it => hotById.set(it.id, it));
  for (const b of blocs.blocs) {
    b.role = new Map();
    for (const iso of [...b.members, ...(b.also || [])]) b.role.set(iso, 'member');
    for (const iso of b.partners || []) b.role.set(iso, 'partner');
    blocById.set(b.id, b);
  }
  contested = hot.contested.map(contestedShape).filter(Boolean);
}

// A contested area is a whole map shape, the parts of the holder's shape that contain its points,
// or an outline clipped to land (Western Sahara is split between Morocco's shape and its own).
function contestedShape(c) {
  let geo = null;
  if (c.outline) {
    geo = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [c.outline] } };
    c.clip = [byIso.get(c.holder), byKey.get(c.feature)].filter(Boolean);
  } else if (c.feature) geo = byKey.get(c.feature) || null;
  else {
    const f = byIso.get(c.holder);
    const polys = !f ? [] : f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const hit = polys.filter(p => c.points.some(pt => d3.geoContains({ type: 'Polygon', coordinates: p }, pt)));
    if (hit.length) geo = { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: hit } };
  }
  return geo ? Object.assign(c, { geo, bounds: d3.geoBounds(geo) }) : null;
}
const contestText = a => a.note || `Held by ${a.held}; claimed by ${a.claimed}.`;

// Coastline = arcs used by this country only; land border = arcs it shares with a neighbour.
function edges(f) {
  if (!f.edges) {
    const obj = topo.objects.countries, g = f.geom;
    const len = m => d3.geoLength(m) * EARTH_KM;
    f.edges = {
      coast: len(topojson.mesh(topo, obj, (a, b) => a === b && a === g)),
      land: len(topojson.mesh(topo, obj, (a, b) => a !== b && (a === g || b === g)))
    };
  }
  return f.edges;
}

// The "UN members" filter keeps the 192 UN members that have a shape at this map scale (Tuvalu has none).
const inScope = f => S.scope === 'all' || f.d.status === 'un';
function valuesFor(m, sovOnly = false) {
  const out = [];
  for (const f of byIso.values()) { const v = f.d.v?.[m]; if (v && inScope(f) && (!sovOnly || f.d.sov)) out.push([f.key, v[0]]); }
  return out;
}
// The data colours for the globe shown: the light ones on a map that is light in both themes, else the theme's.
// A colouring is drawn as in light mode too, so more is darker on every map type and in both themes.
const lightGlobe = () => !!mapType(S.map).paper || colourMode() !== 'none';
const paperGlobe = () => darkQuery.matches && lightGlobe();
const pal = () => (paperGlobe() ? CP : C);
const darkLand = () => darkQuery.matches && !paperGlobe();
const colors = n => d3.quantize(darkLand() ? RAMPS.dark : RAMPS.light, n);
function scale(m) {
  const key = m + darkLand();
  if (!scales[key]) {
    const vals = valuesFor(m).map(d => d[1]);
    const th = [...new Set(d3.scaleQuantile(vals, d3.range(7)).quantiles().map(nice))];
    scales[key] = d3.scaleThreshold(th, colors(th.length + 1));
  }
  return scales[key];
}
// Ranks are among sovereign states (or UN members, under that filter); territories show their value without a rank.
function rank(m, key) {
  if (!ranks[m]) {
    const sorted = valuesFor(m, true).sort((a, b) => b[1] - a[1]);
    // Equal values share a rank (1, 2, 2, 4), so a tie never reads as one country beating another.
    const at = new Map(), tied = new Set();
    let r = 0;
    sorted.forEach((d, i) => {
      if (i && d[1] === sorted[i - 1][1]) { tied.add(d[0]); tied.add(sorted[i - 1][0]); } else r = i + 1;
      at.set(d[0], r);
    });
    ranks[m] = { n: sorted.length, at, tied };
  }
  return [ranks[m].at.get(key), ranks[m].n, ranks[m].tied.has(key)];
}

// ---------- drawing ----------

function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const paper = getComputedStyle($('#paper'));
  for (const k of ['ocean', 'land', 'land-hover', 'border', 'coast', 'grid', 'text', 'muted', 'halo', 'edge', 'hatch', 'sel', 'member', 'partner', 's1', 's2', 'out', 'ghost', 'accent']) {
    C[k] = cs.getPropertyValue('--' + k).trim();
    CP[k] = paper.getPropertyValue('--' + k).trim();
  }
  scales = {};
  makePatterns();
  if (features) { renderLegend(); renderLayers(); draw(); }
}

// Hatching (contested areas) and dots (no data), drawn at device resolution so they stay sharp on 2x and 3x screens.
let patternDpr = 0;
function makePatterns() {
  const dpr = S.dpr || 1;
  const tile = (size, paint) => {
    const c = document.createElement('canvas');
    c.width = c.height = size * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    paint(g);
    const p = ctx.createPattern(c, 'repeat');
    p.setTransform(new DOMMatrix().scale(1 / dpr));
    return p;
  };
  const hatchTile = col => tile(6, g => {
    g.strokeStyle = col; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 6); g.lineTo(6, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(5, 7); g.lineTo(7, 5); g.stroke();
  });
  hatch = hatchTile(C.hatch); hatchPaper = hatchTile(CP.hatch);
  const dotTile = col => tile(5, g => { g.fillStyle = col; g.beginPath(); g.arc(2.5, 2.5, 0.85, 0, 2 * Math.PI); g.fill(); });
  dots = dotTile(C.hatch); dotsPaper = dotTile(CP.hatch);
  patternDpr = dpr;
}

let queued = false;
function draw() {
  // A flight paints in its own tick (frame), which clears the flag, so this frame is then skipped.
  if (!queued && features) { queued = true; requestAnimationFrame(() => { if (queued) render(); }); }
}

const center = () => { const r = proj.rotate(); return [-r[0], -r[1]]; };
// Angles as dot products of unit vectors (d3.geoDistance is several times slower, and a frame makes thousands of these tests).
const RAD = Math.PI / 180, FRONT = Math.sin(0.02);
const unitVec = ([lon, lat]) => { const c = Math.cos(lat * RAD); return [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
let atC = null, atU = null; // the last centre asked about and its vector (one per frame)
// Under 90 degrees less 0.02 from the centre: in front of the horizon.
const visible = (p, c) => { if (c !== atC) { atC = c; atU = unitVec(c); } return dot(unitVec(p), atU) > FRONT; };
const shownItems = () => hot.items.filter(it => S.layers.has(it.layer) || S.sel?.obj === it);
const isCapital = f => f.d.sov && f.d.capitalAt && byIso.get(f.d.iso3) === f;
// The colouring shown: none on a map type that colours the countries itself. S.mode keeps the choice for the next map.
const colourMode = () => (mapType(S.map).ownsColour ? 'none' : S.mode);
// Hot spots step back (small, grey, major names only) under a colouring and on a map type that is itself data.
const quietHot = () => colourMode() !== 'none' || !!mapType(S.map).dataMap;

// A group: one fill for members, a second for partners and for places in it through a member, neutral land for the rest.
function fillFor() {
  const m = colourMode(), P = pal();
  let base = () => P.land;
  if (m === 'income') { const cs = colors(4); base = f => cs[INCOMES.indexOf(f.d.income)] || P.land; }
  else if (info.indicators[m]) { const sc = scale(m); base = f => { const v = f.d.v?.[m]; return v ? sc(v[0]) : P.land; }; }
  else if (blocById.has(m)) {
    const b = blocById.get(m), also = new Set(b.also || []);
    base = f => (also.has(f.d.iso3) ? P.partner : { member: P.member, partner: P.partner }[b.role.get(f.d.iso3)] || P.land);
  }
  const hov = S.hover?.kind === 'country' ? S.hover.obj : null;
  return f => (!inScope(f) ? P.out : f === hov && base(f) === P.land ? P['land-hover'] : base(f));
}
// Countries with no value under a data colouring get a dot pattern on top, so a gap never reads as the lowest class.
function missingFor() {
  const m = colourMode();
  if (info.indicators[m]) return f => inScope(f) && !f.d.v?.[m];
  if (m === 'income') return f => inScope(f) && !INCOMES.includes(f.d.income);
  return () => false;
}

// True-size outline: every part of the country, small islands included, except parts more than 6,500 km
// from its main body (French Guiana for France); the card names how much of the area that leaves out.
const FAR = 6500 / EARTH_KM;
// `light` gives the same shape from the 1:110m map, drawn while the globe moves.
function ghostShape(f, light = false) {
  const key = light && f.lo && f.lo !== f ? 'ghostLo' : 'ghost';
  if (!f[key]) {
    const geom = key === 'ghostLo' ? f.lo.geometry : f.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    const near = [], far = [];
    for (const p of polys) {
      const a = polyArea(p);
      (d3.geoDistance(d3.geoCentroid({ type: 'Polygon', coordinates: p }), f.anchor) > FAR ? far : near).push([p, a]);
    }
    const total = d3.sum([...near, ...far], x => x[1]);
    f[key] = { geo: { type: 'MultiPolygon', coordinates: near.map(x => x[0]) }, farShare: total ? d3.sum(far, x => x[1]) / total : 0 };
  }
  return f[key];
}

// Moves a shape so `from` lands on `to`, keeping its true size and north at the top (as on thetruesize.com).
function moveShape(geo, from, to) {
  const r0 = d3.geoRotation([-from[0], -from[1]]), r1 = d3.geoRotation([-to[0], -to[1]]);
  const walk = c => (typeof c[0] === 'number' ? r1.invert(r0(c)) : c.map(walk));
  return { type: geo.type, coordinates: walk(geo.coordinates) };
}
// Mercator draws areas 1/cos²(latitude) times too large.
const mercator = lat => 1 / Math.cos((lat * Math.PI) / 180) ** 2;
const latText = lat => `${Math.abs(lat).toFixed(0)}° ${lat >= 0 ? 'N' : 'S'}`;
const antipode = ([lng, lat]) => [lng > 0 ? lng - 180 : lng + 180, -lat];

// `geo` is a GeoJSON object, or a Path2D already projected (see projected()).
function stroke(geo, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  if (geo instanceof Path2D) ctx.stroke(geo); else { ctx.beginPath(); path(geo); ctx.stroke(); }
}

// At rest each projected shape is kept as a Path2D for as long as the view stays the same, so a hover, a selection
// or a live feed's redraw fills and strokes it again without projecting a single point (the slow part of a frame).
// While the globe moves every frame has a new view, so the plain GeoJSON comes back and is drawn directly.
// `make` returns a GeoJSON object or a list of them.
// The Flags map keeps them while moving too (projKeep), for that frame only: each country's fill is also its flag's clip.
const projCache = new Map();
let projView = '', projKeep = false;
function projected(key, make) {
  if (S.moving && !projKeep) return make();
  let p = projCache.get(key);
  if (!p) {
    p = new Path2D(); path.context(p);
    const g = make();
    for (const x of Array.isArray(g) ? g : [g]) trace(x, p);
    path.context(ctx);
    projCache.set(key, p);
  }
  return p;
}
// Fills or clips with what projected() returned: a Path2D at rest, GeoJSON (or a list) while moving.
function paint(x, op) {
  if (x instanceof Path2D) return ctx[op](x);
  ctx.beginPath(); for (const g of Array.isArray(x) ? x : [x]) trace(g); ctx[op]();
}

// Polygons and lines drawn without d3's clipping and stream, which are most of a frame on a phone. The orthographic view
// is linear on the unit sphere, so a point costs a few multiplications.
// At rest only shapes wholly inside the clip circle (polygons: what of them is in the window) are drawn so, and only when no edge bends by more than a tenth of
// a pixel on screen: d3's resampling would add no points there, so the drawing is the same. Everything else goes to d3.
// While the globe moves (no resampling then, precision 0) shapes across the horizon are drawn this way too: a point past
// the horizon goes to the nearest point of the rim, which fills the visible part of a polygon exactly when the polygon
// cannot hold the point opposite the view. That is certain for polygons inside a 45-degree cap; d3 draws the few larger
// ones (Russia, Canada, Antarctica). A line lifts the pen past the horizon. An edge across the horizon ends at the rim
// a little early, which a moving frame can afford.
const unit = new WeakMap(); // ring or line -> points as x, y, z, a bounding cap (centre c, radius r), longest edge bend b
function unitOf(l) {
  let u = unit.get(l);
  if (!u) {
    const v = new Float64Array(l.length * 3);
    let sx = 0, sy = 0, sz = 0, lo = 1, edge = 1;
    l.forEach(([lon, lat], i) => {
      const c = Math.cos(lat * RAD);
      sx += v[3 * i] = c * Math.cos(lon * RAD); sy += v[3 * i + 1] = c * Math.sin(lon * RAD); sz += v[3 * i + 2] = Math.sin(lat * RAD);
      if (i) edge = Math.min(edge, v[3 * i] * v[3 * i - 3] + v[3 * i + 1] * v[3 * i - 2] + v[3 * i + 2] * v[3 * i - 1]);
    });
    const n = Math.hypot(sx, sy, sz) || 1, c = [sx / n, sy / n, sz / n];
    for (let i = 0; i < v.length; i += 3) lo = Math.min(lo, c[0] * v[i] + c[1] * v[i + 1] + c[2] * v[i + 2]);
    // An edge of angle t bows at most scale * t * t / 8 pixels from its chord; b is t * t / 8.
    unit.set(l, u = { v, c, r: n < 1e-9 ? Math.PI : Math.acos(lo), b: Math.acos(Math.max(-1, edge)) ** 2 / 8 });
  }
  return u;
}
let fast = null; // set by render() for frames at the 1:110m and 1:50m levels, and for moving 1:10m frames
function fastView([lon, lat], clip) {
  const [tx, ty] = proj.translate(), [ax, ay] = proj([0, 0]), [bx, by] = proj([90, 0]), [zx, zy] = proj([0, 90]), c = Math.cos(lat * RAD);
  return {
    m: [ax - tx, bx - tx, zx - tx, ay - ty, by - ty, zy - ty], t: [tx, ty], k: proj.scale(), rim: S.moving,
    n: [c * Math.cos(lon * RAD), c * Math.sin(lon * RAD), Math.sin(lat * RAD)], clip: clip * RAD - 0.001, cr: Math.cos(clip * RAD)
  };
}
// Adds a GeoJSON object to `out` (the canvas, or a Path2D that d3's path is also writing to).
function trace(g, out = ctx) {
  if (g.type === 'Feature') g = g.geometry;
  const t = g.type, polys = t === 'Polygon' ? [g.coordinates] : t === 'MultiPolygon' ? g.coordinates : null;
  const lines = !polys && (t === 'LineString' ? [g.coordinates] : t === 'MultiLineString' ? g.coordinates : null);
  if (!fast || !(polys || lines)) return path(g);
  const [a, b, d, e, f, h] = fast.m, [tx, ty] = fast.t, [nx, ny, nz] = fast.n, k = fast.k, rest = [], cf = Math.cos(fast.clip);
  // At rest a polygon is drawn here when every point is inside the clip circle (the cap test below is only a quick yes).
  // A narrower clip than the horizon lies 24 px past the window (render), so then it only has to be on the near side:
  // what d3 would cut off at the clip circle is off screen either way.
  const lim = fast.clip < 1.56 ? 0 : cf, cr = fast.cr;
  const within = rs => rs.every(r => { const v = unitOf(r).v; for (let i = 0; i < v.length; i += 3) if (nx * v[i] + ny * v[i + 1] + nz * v[i + 2] <= lim) return false; return true; });
  // At rest a line is cut where it crosses the clip circle, at the point d3's clipCircle intersect() finds (with the
  // view's centre for its [1, 0, 0]), so a dash pattern starts where it did. i is the point inside, j the one outside.
  const cut = (v, i, j) => {
    const px = v[i], py = v[i + 1], pz = v[i + 2], qx = v[j], qy = v[j + 1], qz = v[j + 2];
    const mx = py * qz - pz * qy, my = pz * qx - px * qz, mz = px * qy - py * qx, mm = mx * mx + my * my + mz * mz, nm = nx * mx + ny * my + nz * mz, det = mm - nm * nm;
    let X = px, Y = py, Z = pz;
    if (det) {
      const c1 = cr * mm / det, c2 = -cr * nm / det, Ax = nx * c1 + mx * c2, Ay = ny * c1 + my * c2, Az = nz * c1 + mz * c2;
      const ux = ny * mz - nz * my, uy = nz * mx - nx * mz, uz = nx * my - ny * mx, w = Ax * ux + Ay * uy + Az * uz, uu = ux * ux + uy * uy + uz * uz;
      const s = (-w - Math.sqrt(Math.max(0, w * w - uu * (Ax * Ax + Ay * Ay + Az * Az - 1)))) / uu;
      X = Ax + ux * s; Y = Ay + uy * s; Z = Az + uz * s;
    }
    return [tx + a * X + b * Y + d * Z, ty + e * X + f * Y + h * Z];
  };
  const emit = (v, ring) => {
    let down = false, wasFar = false, was = false;
    for (let i = 0, n = ring ? v.length - 3 : v.length; i < n; i += 3) { // a ring's closing point, as d3 does, is closePath
      const X = v[i], Y = v[i + 1], Z = v[i + 2], z = nx * X + ny * Y + nz * Z;
      let x = a * X + b * Y + d * Z, y = e * X + f * Y + h * Z;
      if (!ring && !fast.rim) {
        const inside = z > cr;
        if (i && inside !== was) { const [qx, qy] = inside ? cut(v, i, i - 3) : cut(v, i - 3, i); if (inside) out.moveTo(qx, qy); else out.lineTo(qx, qy); }
        if (inside) { if (i) out.lineTo(tx + x, ty + y); else out.moveTo(tx + x, ty + y); }
        was = inside;
        continue;
      }
      if (z < 0) { if (!ring) { down = false; continue; } const q = k / (Math.hypot(x, y) || 1); x *= q; y *= q; }
      // A line's step between two points outside the clip circle is off screen: the pen lifts (a dashed parallel at
      // city zoom would otherwise be dashed for millions of pixels).
      const far = !ring && z < cf;
      if (down && !(far && wasFar)) out.lineTo(tx + x, ty + y); else { out.moveTo(tx + x, ty + y); down = true; }
      wasFar = far;
    }
    if (ring && down) out.closePath();
  };
  const draw = p => { if (polys) for (const r of p) emit(unitOf(r).v, true); else emit(unitOf(p).v, false); };
  const smooth = p => (polys ? p.every(r => k * unitOf(r).b < 0.1) : k * unitOf(p).b < 0.1);
  for (const p of polys || lines) {
    const u = unitOf(polys ? p[0] : p);
    if (!u.v.length) continue;
    const away = Math.acos(Math.max(-1, Math.min(1, nx * u.c[0] + ny * u.c[1] + nz * u.c[2]))); // the cap's centre from the view's
    if (away - u.r >= Math.PI / 2) continue; // wholly past the horizon
    if (fast.rim ? !polys || u.r <= Math.PI / 4 : away + u.r < fast.clip && smooth(p)) draw(p);
    else rest.push(p);
  }
  if (fast.rim) { if (rest.length) path(polys ? { type: 'MultiPolygon', coordinates: rest } : { type: 'MultiLineString', coordinates: rest }); return; }
  // At rest the shapes left come after the others, in the order d3 drew them before, each drawn here when it can be.
  for (const p of rest) if (smooth(p) && (!polys || within(p))) draw(p); else path({ type: polys ? 'Polygon' : 'LineString', coordinates: p });
}

// P: the palette for the ground under the marker (pal()).
function marker(shape, x, y, r, color, P) {
  ctx.beginPath();
  if (shape === 'diamond') { const d = r * 1.3; ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath(); }
  else if (shape === 'square' || shape === 'squareOpen') ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  else if (shape === 'triangle') { ctx.moveTo(x, y - r * 1.3); ctx.lineTo(x + r * 1.2, y + r * 0.9); ctx.lineTo(x - r * 1.2, y + r * 0.9); ctx.closePath(); }
  else ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 4; ctx.strokeStyle = P.halo; ctx.stroke();
  if (shape === 'ring' || shape === 'squareOpen') { ctx.lineWidth = 2.2; ctx.strokeStyle = color; ctx.stroke(); }
  else { ctx.fillStyle = color; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = P.edge; ctx.stroke(); }
}

function fillContested(a) {
  ctx.save();
  if (a.clip) paint(projected(a.clip, () => a.clip), 'clip');
  ctx.fillStyle = paperGlobe() ? hatchPaper : hatch; paint(projected(a.geo, () => a.geo), 'fill');
  ctx.restore();
}

// Culling. Each shape and each border or coast line carries a bounding cap (centre and angular radius);
// a frame draws only those that overlap the visible cap, so the far side of the globe and anything outside
// the window when zoomed in cost nothing.
function capOf(points) {
  const c = points[Math.floor(points.length / 2)], [x, y, z] = unitVec(c);
  let lo = 1; // the least cosine of the angle from c, as visible() works it out
  for (const [lon, lat] of points) { const k = Math.cos(lat * RAD); lo = Math.min(lo, k * (x * Math.cos(lon * RAD) + y * Math.sin(lon * RAD)) + z * Math.sin(lat * RAD)); }
  return { c, r: Math.acos(Math.max(-1, lo)) };
}
const flatPoints = g => (g.type === 'Polygon' ? g.coordinates.flat() : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : g.coordinates.flat());
// Splits a mesh into its lines, each with a cap (computed once and kept on the mesh).
function* lineChunks(mesh) {
  for (const l of mesh.coordinates) for (let i = 0; i < l.length - 1; i += 255) { const s = l.slice(i, i + 256); yield { l: s, cap: capOf(s) }; }
}
function meshLines(mesh) {
  return (mesh.lines ||= [...lineChunks(mesh)]);
}
function visibleLines(mesh, seen) {
  return { type: 'MultiLineString', coordinates: meshLines(mesh).filter(x => seen(x.cap)).map(x => x.l) };
}
// The visible cap's angular radius: the horizon, or less when the window shows only part of the globe.
function viewRadius(pad = 0) {
  const [tx, ty] = proj.translate(), k = proj.scale();
  const corner = pad + Math.max(Math.hypot(tx, ty), Math.hypot(S.w - tx, ty), Math.hypot(tx, S.h - ty), Math.hypot(S.w - tx, S.h - ty));
  return corner >= k ? Math.PI / 2 : Math.asin(corner / k);
}
const capUnit = new WeakMap(); // cap -> its centre's vector and the cosine and sine of its radius (caps do not change)
function inView(c) {
  const R = viewRadius() + 0.01, n = unitVec(c), cR = Math.cos(R), sR = Math.sin(R);
  // distance(c, cap) - r < R, that is cos(distance) > cos(R + r)
  return cap => {
    if (!cap || R + cap.r >= Math.PI) return true;
    let u = capUnit.get(cap);
    if (!u) capUnit.set(cap, u = [...unitVec(cap.c), Math.cos(cap.r), Math.sin(cap.r)]);
    return dot(n, u) > cR * u[3] - sR * u[4];
  };
}

// Which map the shapes come from, by how large a degree is on screen (the projection's scale, pixels per radian):
// 1:110m only while the globe moves zoomed out, 1:50m for the whole globe at rest and for moving middle views,
// 1:10m once 1:50m corners would show (scale 2600 at rest: about a pixel). Each map is generalised for roughly the scale where it takes over.
function detail(moving) {
  const s = proj.scale();
  if (moving) return s < 1500 ? 'lo' : s < 4000 ? 'mid' : 'hi';
  return s < 2600 ? 'mid' : 'hi';
}
// A shape's polygons, each with its own cap, so a frame draws only the islands and coasts on screen.
const partsOf = g => (g.geometry.type === 'Polygon' ? [g.geometry.coordinates] : g.geometry.coordinates).map(c => ({ c, cap: capOf(c.flat()) }));
function partShape(parts, seen) {
  const ps = parts.filter(p => seen(p.cap));
  return ps.length ? { type: 'MultiPolygon', coordinates: ps.map(p => p.c) } : null;
}
// The 1:10m map: each 1:50m shape gets its 1:10m counterpart (same code and name, else same code). Shapes only the
// 1:10m map has (Gibraltar, Tuvalu, Baikonur, Akrotiri, reefs) are drawn as plain land with no data.
let hiMap = null, hiLoad = null;
function loadHi() {
  // The preparation yields to input every 40 ms, so the first deep zoom does not freeze the page.
  let since = performance.now();
  const breathe = async () => { if (performance.now() - since > 40) { await new Promise(r => setTimeout(r)); since = performance.now(); } };
  hiLoad ||= fetch(MAP_URL_HI).then(r => (r.ok ? r.json() : Promise.reject(new Error(`${MAP_URL_HI} returned ${r.status}`)))).then(async t => {
    const obj = t.objects.countries;
    const gs = topojson.feature(t, obj).features;
    const key = g => g.id ?? g.properties.name, used = new Set(), byKeyHi = d3.group(gs, key);
    await breathe();
    for (const f of byArea) {
      const same = byKeyHi.get(f.key) || [];
      const g = same.find(x => !used.has(x) && x.properties.name === f.properties.name) || same.find(x => !used.has(x));
      if (g) { used.add(g); f.hi = partsOf(g); }
      await breathe();
    }
    const missed = features.filter(f => !f.hi).map(f => f.properties.name);
    if (missed.length) console.warn('No 1:10m shape for', missed.join(', '));
    const extras = [];
    for (const g of gs) if (!used.has(g)) { extras.push(partsOf(g)); await breathe(); }
    // The meshes' line caps are worked out here too, not in the first detailed frame.
    const borders = topojson.mesh(t, obj, (a, b) => a !== b); await breathe();
    const coast = topojson.mesh(t, obj, (a, b) => a === b); await breathe();
    for (const m of [borders, coast]) { const ls = []; for (const x of lineChunks(m)) { ls.push(x); await breathe(); } m.lines = ls; }
    hiMap = { extras, borders, coast };
    // A point opened before the 1:10m map arrived (from a link) may lie on an island only it has.
    const o = S.sel?.kind === 'point' && S.sel.obj;
    if (o && !o.country && (o.country = countryAt(o.at))) renderInfo();
    draw();
  }).catch(e => {
    console.warn('The 1:10m map did not load; the 1:50m map stays.', e);
    setTimeout(() => { hiLoad = null; }, 60000); // a later deep zoom tries again
  });
}

// While the globe moves (drag, zoom, flight, arrow keys) frames use a lighter map and coarser resampling;
// 140 ms after the last movement the detailed map is drawn again.
let idleTimer = 0;
function moving() {
  // While the app starts, every frame is drawn at full detail and resolution: the first globe anyone sees is sharp.
  if (S.booting) { S.moving = false; return; }
  S.moving = true;
  clearTimeout(idleTimer);
  if (S.gesture) return; // no full-detail redraw until the finger or button is released
  idleTimer = setTimeout(() => { S.moving = false; draw(); }, 140);
}

// Tiles still loading mark the globe busy (after 400 ms, so a fast connection never flashes it); tiles that failed
// and are being tried again get a line in the status box. The DOM is touched only when either state changes.
let busyTimer = 0, tilesFailed = false;
const TILE_FAIL = 'Some map tiles did not load. Trying again.';
function tileState({ loading = 0, failed = 0 } = {}) {
  if (loading && !busyTimer && !canvas.hasAttribute('aria-busy')) busyTimer = setTimeout(() => { busyTimer = 0; canvas.setAttribute('aria-busy', 'true'); }, 400);
  else if (!loading && (busyTimer || canvas.hasAttribute('aria-busy'))) { clearTimeout(busyTimer); busyTimer = 0; canvas.removeAttribute('aria-busy'); }
  if (!!failed === tilesFailed) return;
  tilesFailed = !!failed;
  const st = $('#status');
  if (failed && !st.textContent) st.textContent = TILE_FAIL;
  else if (!failed && st.textContent === TILE_FAIL) st.textContent = '';
}

// The sea colour under the tiles, as 0-1 RGBA for WebGL.
function seaColour() {
  const c = d3.rgb(pal().ocean);
  return [c.r / 255, c.g / 255, c.b / 255, 1];
}
// What overlays (earthquakes, plate boundaries, time zones and so on) get to draw and pick with.
function overlayApi(c) {
  return {
    ctx, proj, path, k: S.k, w: S.w, h: S.h, dpr: S.dpr, center: c, visible: p => visible(p, c),
    // dark and C follow the ground: a paper globe (and any colouring) is light in both themes.
    dark: darkQuery.matches && !paperGlobe(), C: pal(), moving: S.moving, draw, esc, fmt: { big, pct, km, FMT },
    // The open point's position, so a map type can mark its own marker there (Airports: the plane in the accent).
    sel: S.sel?.kind === 'point' ? S.sel.obj.at : null,
    // A finger is moving the globe on a touch screen: slower phones get lighter frames (see render).
    lite: S.moving && coarse,
    // Shapes projected once per view (a Path2D at rest), and how to fill, stroke or clip with one;
    // seen(cap) says whether a bounding cap ({c: [lon, lat], r: radians}) can be on screen.
    projected, paint, seen: inView(c), onFace,
    // Where a map type puts its own controls (a period, a layer, a species), and how it asks for a redraw of the
    // legend, the open point panel and the globe after one changes.
    tools: $('#mapTools'), refresh: refreshMapType
  };
}
// Flags: each country's ISO 3166 code comes with the atlas, which is loaded on first use.
function flagItems(seen, shape) {
  if (!atlas) { loadAtlas().then(draw); return []; }
  return features.filter(f => f.d.iso3 && seen(f.cap) && shape(f)).map(f => ({
    // At rest its own cache key: the fills' Path2D is projected at a narrower clip angle, which can differ by a pixel.
    shape: projected(S.moving ? f : 'flag' + f.i, () => shape(f)), core: f.core, a2: atlas.countries[f.d.iso3]?.a2?.toLowerCase()
  }));
}
// A flag's box: the screen bounds of the country's core, by the fast projection (see trace). At rest only for cores
// wholly on the near side whose edges bend less than a tenth of a pixel, where d3's bounds come out the same; the rest
// go to d3. While moving a point past the horizon goes to the rim.
function flagBounds(c) {
  const { m: [a, b, d, e, f, h], t: [tx, ty], n: [nx, ny, nz], k } = fastView(c, 90), rim = S.moving;
  // At rest the boxes are kept with the view's Path2Ds, so a hover redraw finds them.
  if (!rim) return core => { let r = projCache.get(core); if (!r) projCache.set(core, r = box(core)); return r; };
  return box;
  function box(core) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of core.coordinates) {
      const u = unitOf(p[0]), v = u.v;
      const away = Math.acos(Math.max(-1, Math.min(1, nx * u.c[0] + ny * u.c[1] + nz * u.c[2])));
      if (away - u.r >= Math.PI / 2) continue; // wholly past the horizon
      if (!rim && (away + u.r >= Math.PI / 2 - 0.001 || k * u.b >= 0.1)) return path.bounds(core);
      for (let i = 0; i < v.length; i += 3) {
        const X = v[i], Y = v[i + 1], Z = v[i + 2];
        let x = a * X + b * Y + d * Z, y = e * X + f * Y + h * Z;
        if (nx * X + ny * Y + nz * Z < 0) { const q = k / (Math.hypot(x, y) || 1); x *= q; y *= q; }
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return [[tx + x0, ty + y0], [tx + x1, ty + y1]];
  }
}

// Projects a shape once and strokes it once per pass ([colour, width]), e.g. a halo then the line.
function outline(geo, passes) {
  const p = geo instanceof Path2D ? geo : null;
  if (!p) { ctx.beginPath(); path(geo); }
  ctx.lineJoin = 'round';
  for (const [color, width] of passes) { ctx.strokeStyle = color; ctx.lineWidth = width; if (p) ctx.stroke(p); else ctx.stroke(); }
}

function render() {
  queued = false;
  const c = center();
  const lod = detail(S.moving), lo = lod === 'lo';
  if (lod === 'hi' && !hiMap) loadHi();
  const hi = lod === 'hi' && !!hiMap;
  // Skip shapes that cannot be on screen (past the horizon, or outside the window when zoomed in).
  const seen = inView(c);
  const shape = f => (lo ? f.lo : hi && f.hi ? partShape(f.hi, seen) : f);
  const B = lo ? bordersLo : hi ? hiMap.borders : borders, K = lo ? coastLo : hi ? hiMap.coast : coast;
  // While moving, no resampling between a shape's own points (they are close enough at every zoom); at rest, fine curves.
  proj.precision(S.moving ? 0 : 0.4);
  // Zoomed in, shapes are clipped to the visible circle before they are projected, so the parts of a large country
  // off screen cost nothing (the clip edge lies past the window's corners; at least 2 degrees, where the clip stays exact).
  const clip = Math.max(2, viewRadius(24) * 180 / Math.PI);
  proj.clipAngle(clip);
  // At 1:10m only while moving: d3 would stream every point of a country's main ring (France's) through clipping.
  fast = lod !== 'hi' || S.moving ? fastView(c, clip) : null;
  const view = [proj.rotate(), proj.scale(), proj.translate(), S.w, S.h, lod, !!hiMap].join();
  if (S.moving || view !== projView) { projCache.clear(); projView = view; }
  // A finger moving the globe on a touch screen: at most two canvas pixels per CSS pixel (under half the pixels of a
  // 3x phone) until the globe stops; the frame at rest is drawn at the screen's full resolution. Patterns keep their
  // size either way.
  const dpr = S.moving && coarse ? Math.min(S.dpr, 2) : S.dpr;
  if (canvas.width !== Math.floor(S.w * dpr)) { canvas.width = S.w * dpr; canvas.height = S.h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S.w, S.h);

  const mt = mapType(S.map), dark = darkQuery.matches;
  const stack = tiles ? mt.layers({ k: S.k, dark }).filter(l => l.opacity !== 0) : [];
  writeCredit();
  const raster = stack.length > 0;
  tileState(tiles?.render(stack, { rotate: proj.rotate(), scale: proj.scale(), translate: proj.translate(), sea: raster ? seaColour() : null }));
  // A colouring makes the map thematic: every country is filled opaque (the data, or flat neutral land), so one class
  // is one colour on every map type. Otherwise fills go only where the map type is the country map itself, and
  // borders until the tiles' own borders are detailed enough.
  const thematic = colourMode() !== 'none';
  const fillAlpha = thematic ? 1 : raster ? (mt.vector === 'full' ? Math.max(0, 1 - stack[0].opacity) : 0) : mt.paint ? 0 : 1;
  const drawLines = mt.vector !== 'none' && (!raster || S.k < 40);
  const api = overlayApi(c);
  const fill = fillFor(), missing = missingFor(), P = pal();

  // A map type may paint the sea and the countries in its own style (the Reference globe does); under a colouring
  // it fills the countries with the app's colours (fill), under its own borders and lettering.
  const painted = !raster && !!mt.paint;
  // fillShape: the lighter 1:110m fills while the globe moves at country zoom (see quickFill below).
  const quickFill = S.moving && lod === 'mid' && proj.scale() < 3000;
  projKeep = !!mt.flags && !quickFill; // with quickFill a fill's shape is not the country's shape
  if (painted) mt.paint({ ...api, features, shape, fillShape: f => (quickFill ? f.lo : shape(f)), seen, inScope, fill: thematic ? fill : null, out: P.out, borders: projected(B, () => visibleLines(B, seen)), coast: projected(K, () => visibleLines(K, seen)) });
  else if (!raster) { ctx.fillStyle = P.ocean; paint(projected(SPHERE, () => SPHERE), 'fill'); stroke(projected(graticule, () => graticule), P.grid, 0.5); }

  // Countries are filled in one path per colour (a dozen fills, not one per country); no-data dots in one more.
  // While the globe moves at country zoom (a 1:50m frame), the fills come from the 1:110m map, which has a tenth of
  // the points: projecting and clipping every point of every filled shape is most of a moving frame. The borders and
  // coasts stay 1:50m, and the detailed fills come back when the globe stops.
  const groups = new Map(), gaps = [];
  const add = (col, g) => { if (!groups.has(col)) groups.set(col, []); groups.get(col).push(g); };
  for (const f of features) {
    if (!seen(f.cap)) continue;
    const g = quickFill ? f.lo : shape(f);
    if (!g) continue;
    const p = projected(f, () => g);
    if (!painted) add(fill(f), p); // a painted map has filled them already
    if (missing(f)) gaps.push(p);
  }
  if (hi) for (const parts of hiMap.extras) { const g = partShape(parts, seen); if (g) add(S.scope === 'all' ? P.land : P.out, projected(parts, () => g)); }
  if (fillAlpha > 0) {
    // One path per colour, so neighbours of the same colour show no seam between them.
    const joined = ps => { if (!(ps[0] instanceof Path2D)) return ps; const j = new Path2D(); for (const p of ps) j.addPath(p); return j; };
    ctx.globalAlpha = fillAlpha;
    for (const [col, ps] of groups) { ctx.fillStyle = col; paint(joined(ps), 'fill'); }
    if (gaps.length) { ctx.fillStyle = paperGlobe() ? dotsPaper : dots; paint(joined(gaps), 'fill'); }
    ctx.globalAlpha = 1;
  }
  // Flags are fitted to the whole country, not to the part on screen: at rest the projection opens to the whole near
  // side. While moving the boxes need no d3 (flagBounds), so the clip shapes keep the narrow clip, cheaper at city zoom.
  if (mt.flags) {
    const narrow = fast;
    if (!S.moving) { proj.clipAngle(90); if (fast) fast = fastView(c, 90); }
    drawFlags(ctx, flagItems(seen, shape), flagBounds(c), x => paint(x, 'clip'), draw, S.moving);
    proj.clipAngle(clip); fast = narrow;
  }
  if (S.layers.has('contested') && (!raster || S.k < 40)) contested.forEach(fillContested);
  if (drawLines) {
    // Over tiles the borders get a light halo, so they read on dark relief and pale streets alike.
    // Projected once for both passes over tiles (halo, then line).
    const bl = projected(B, () => visibleLines(B, seen));
    if (raster) outline(bl, [[P.halo, 2], [P.border, 0.8]]); else stroke(bl, P.border, 0.5);
    if (!raster) stroke(projected(K, () => visibleLines(K, seen)), P.coast, 0.6);
  }
  if (mt.overlay?.ready) mt.overlay.draw(api);

  const sel = S.sel, hov = S.hover;
  const line = f => { const g = shape(f) || f; return projected(f, () => g); };
  if (sel?.kind === 'hot') for (const iso of sel.obj.countries) { const f = byIso.get(iso); if (f) stroke(line(f), P.muted, 1.2); }
  // A marker that stands for a contested area (Crimea) marks that area too when it is the keyboard target.
  const area = hov?.contested || (hov?.strong && hov.kind === 'hot' && contested.find(a => a.hot === hov.obj.id));
  if (area) {
    if (!area.clip) { if (hov.strong) outline(area.geo, [[P.halo, 4.5], [P.sel, 2]]); else stroke(area.geo, P.muted, 1.4); }
  }
  else if (hov?.kind === 'country' && hov.obj !== sel?.obj) {
    // A ranked-list row or the keyboard target gets the selection weight. A mouse hover is lighter: the plain land's
    // hover tint (on painted maps, colourings and tiles a veil of the ink, which shades any fill the same way) and a
    // haloed outline.
    const g = line(hov.obj);
    if (hov.strong) outline(g, [[P.halo, 4.5], [P.sel, 2]]);
    else {
      if (painted || raster || fill(hov.obj) !== P['land-hover']) { ctx.globalAlpha = 0.07; ctx.fillStyle = P.text; paint(g, 'fill'); ctx.globalAlpha = 1; }
      outline(g, [[P.halo, 3], [P.muted, 1.4]]);
    }
  }
  if (sel?.kind === 'country') outline(line(sel.obj), [[P.halo, 5], [P.sel, 2]]);
  if (sel?.kind === 'compare') {
    for (const [f, col] of [[sel.obj.a, P.s1], [sel.obj.b, P.s2]]) if (f) outline(line(f), [[P.halo, 5], [col, 2.5]]);
  }
  // True-size outline: always drawn at the middle of the view, so turning the globe slides land under it.
  if (S.ghost) {
    // Projected once, then filled and stroked twice from the same path.
    ctx.beginPath(); path(moveShape(ghostShape(S.ghost.f, lo).geo, S.ghost.f.anchor, c));
    ctx.fillStyle = P.ghost; ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4; ctx.strokeStyle = P.halo; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = P.s1; ctx.stroke();
    ghostReadout(c);
  }

  // Dashed lines are cut to the window first: zoomed in, the 2-degree clip leaves millions of pixels of dashes off screen.
  proj.clipExtent([[-8, -8], [S.w + 8, S.h + 8]]);
  ctx.setLineDash([6, 4]);
  for (const it of shownItems()) {
    if (!it.line) continue;
    const on = sel?.obj === it || hov?.obj === it;
    stroke({ type: 'LineString', coordinates: it.line }, layerById.get(it.layer).color, on ? 3 : 1.75);
  }
  ctx.setLineDash([]);
  proj.clipExtent(null); // flags fit to path.bounds(), which needs the whole shape

  if (S.layers.has('capitals') && !mt.drawsCapitals) {
    // On a data or group fill a capital takes the ink a name takes there (inkOn), so it shows on the deepest classes too.
    const plainLand = new Set([P.land, P['land-hover'], P.out]);
    for (const f of features) {
      if (!isCapital(f) || !visible(f.d.capitalAt, c)) continue;
      const [x, y] = proj(f.d.capitalAt), col = thematic && fill(f);
      ctx.fillStyle = col && !plainLand.has(col) ? inkOn(col).text : P.text;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }

  const quiet = quietHot();
  for (const it of shownItems()) {
    if (!visible(it.at, c)) continue;
    const [x, y] = proj(it.at);
    const on = sel?.obj === it || hov?.obj === it;
    const layer = layerById.get(it.layer);
    // Under a colouring or on a data map the markers step back (smaller, grey, shape only), so their hues never read as data.
    marker(layer.shape, x, y, on ? 6.5 : quiet ? 3.5 : 4.5, quiet && !on ? P.muted : layer.color, P);
    if (sel?.obj === it) { ctx.beginPath(); ctx.arc(x, y, 11, 0, 2 * Math.PI); ctx.lineWidth = 1.5; ctx.strokeStyle = P.sel; ctx.stroke(); }
  }
  if (S.anti && visible(S.anti.at, c)) { const [x, y] = proj(S.anti.at); marker('diamond', x, y, 6, P.s2, P); }
  if (sel?.kind === 'point' && visible(sel.obj.at, c)) {
    const [x, y] = proj(sel.obj.at);
    if (mt.drawSel && mt.overlay?.ready) mt.drawSel(api); // the map type's own marker for the open point, over the hot spots
    // Round a picked marker (an airport's plane) the ring stands clear of it, as a hot spot's does.
    ctx.beginPath(); ctx.arc(x, y, sel.obj.feature ? 12 : 7, 0, 2 * Math.PI);
    ctx.lineWidth = 4.5; ctx.strokeStyle = P.halo; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = P.sel; ctx.stroke();
  }

  drawLabels(c);
  // Keyboard focus on the globe: a crosshair, drawn last so nothing covers it, marks the point Enter opens.
  if (S.kbd) {
    const [x, y] = proj.translate();
    ctx.beginPath();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { ctx.moveTo(x + dx * 4, y + dy * 4); ctx.lineTo(x + dx * 12, y + dy * 12); }
    ctx.lineCap = 'round';
    ctx.lineWidth = 4.5; ctx.strokeStyle = P.halo; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = P.sel; ctx.stroke();
    ctx.lineCap = 'butt';
  }
  stroke(SPHERE, P.coast, 1);
  dimPaper();
  fast = null;
}
// A paper globe in the dark theme is toned down 8% in the canvas itself. A CSS filter did the same, but Safari on
// iPhone drew the filtered canvas at a lower resolution, so the globe looked soft until something redrew it.
function dimPaper(on = paperGlobe()) {
  if (!on) return;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

// A label box [x0, y0, x1, y1] lies wholly on the globe's face, so no name runs past the limb onto the page.
function onFace(b) {
  const [cx, cy] = proj.translate(), r = proj.scale();
  return [[b[0], b[1]], [b[2], b[1]], [b[0], b[3]], [b[2], b[3]]].every(([x, y]) => Math.hypot(x - cx, y - cy) <= r);
}

const landOf = new WeakMap(); // hot spot -> the country it is in (or null at sea), for its name's ink
function drawLabels(c) {
  const boxes = [];
  // A map drawn light in both themes names in the light theme's colours, or in its own ink (the Atlas).
  const P = pal(), ink = mapType(S.map).ink || P;
  const zb = shown($('.zoom')); if (zb) boxes.push([zb.left - 4, zb.top - 4, zb.right + 4, zb.bottom + 4]); // no lettering under the zoom buttons
  // No name over a hot-spot marker. The box stops 3px below its centre, so the marker's own name, just under it, still fits.
  for (const it of shownItems()) if (visible(it.at, c)) { const [x, y] = proj(it.at); boxes.push([x - 6, y - 6, x + 6, y + 3]); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  // Under a colouring, a name on a country filled with a data or group colour takes the ink for that fill (inkOn);
  // names on plain land and the sea keep the map's own.
  const fill = colourMode() !== 'none' && fillFor(), plainLand = new Set([P.land, P['land-hover'], P.out]);
  const inkOf = f => { const col = fill && f && fill(f); return col && !plainLand.has(col) ? inkOn(col) : null; };
  const place = (text, x, y, font, color, force, spacing = 0, on = null) => {
    const half = textWidth(ctx, font, spacing, text) / 2 + 2;
    const b = [x - half, y - 8, x + half, y + 8];
    if (force || (b[0] >= 4 && b[2] <= S.w - 4 && onFace(b) && !boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]))) {
      boxes.push(b);
      ctx.font = font; ctx.letterSpacing = `${spacing}px`;
      ctx.lineWidth = on ? 3 : 2.5; ctx.strokeStyle = on ? on.halo : ink.halo; ctx.strokeText(text, x, y);
      ctx.fillStyle = on ? on.text : color; ctx.fillText(text, x, y);
      ctx.letterSpacing = '0px';
    }
  };
  // Country names in spaced capitals and water in italic, as on printed globes.
  const caps = (name, size) => [name.toUpperCase(), size * CAPS_TRACKING];
  // Under a colouring or on a data map, hot-spot names step back with their markers: major ones only, smaller and lighter.
  const quiet = quietHot();
  const hotFont = (it, small) => `${it.layer === 'chokepoint' ? 'italic ' : ''}${small ? '500 11.5px' : '600 13px'} ${LABEL_FONT}`;
  const hotLabel = (it, force) => {
    if (!visible(it.at, c)) return;
    const [x, y] = proj(it.at), small = quiet && !force;
    if (!landOf.has(it)) landOf.set(it, countryAt(it.at)); // hot spots do not move: the country under one is looked up once
    place(it.name, x, y + (small ? 12 : 15), hotFont(it, small), small && ink === P ? P.muted : ink.text, force, 0, inkOf(landOf.get(it)));
  };

  // Keyboard target: its name (or "At sea") under the crosshair, placed first so nothing hides it.
  // Its own name is that label, so the selection's label is skipped when the two are the same.
  const kt = S.kbd && S.hover?.obj;
  if (S.kbd) {
    const [x, y] = proj.translate(), h = S.hover;
    boxes.push([x - 13, y - 13, x + 13, y + 13]);
    place(pickName(h), x, y + 24, `600 13px ${LABEL_FONT}`, ink.text, true, 0, inkOf(h?.kind === 'country' && h.obj));
  }
  if (S.sel?.kind === 'hot' && S.sel.obj !== kt) hotLabel(S.sel.obj, true);
  if (S.sel?.kind === 'country' && S.sel.obj !== kt && visible(S.sel.obj.label, c)) {
    const [x, y] = proj(S.sel.obj.label);
    place(S.sel.obj.d.name.toUpperCase(), x, y, `600 14px ${LABEL_FONT}`, ink.text, true, 14 * CAPS_TRACKING, inkOf(S.sel.obj));
  }
  if (S.sel?.kind === 'compare') {
    for (const f of [S.sel.obj.a, S.sel.obj.b]) {
      if (!f || f === kt || !visible(f.label, c)) continue;
      const [x, y] = proj(f.label);
      place(f.d.name.toUpperCase(), x, y, `600 14px ${LABEL_FONT}`, ink.text, true, 14 * CAPS_TRACKING, inkOf(f));
    }
  }
  if (S.anti && visible(S.anti.at, c)) {
    const [x, y] = proj(S.anti.at);
    place(`Antipode of ${S.anti.name}`, x, y + 17, `italic 500 13px ${LABEL_FONT}`, ink.text, true, 0, inkOf(countryAt(S.anti.at)));
  }
  const mt = mapType(S.map);
  // A map type's data labels (time zone offsets) take their places first; country names then fit round them.
  // Many small ones (Airports' codes) come after the names instead (namesFirst), so the countries stay named.
  const own = mt.placeLabels && mt.overlay?.ready && (() => mt.placeLabels({ ...overlayApi(c), boxes }));
  if (own && !mt.namesFirst) own();
  // Country names come before hot-spot names, which take the room left (the markers still show every hot spot).
  // A map type with its own lettering (the Reference globe) names countries and cities itself.
  const plain = !mt.labels && mt.countryLabels !== false;
  if (mt.labels) { if (mt.overlay?.ready) mt.labels({ ...overlayApi(c), boxes, byArea, inkOf }); }
  else if (plain) {
    for (const f of byArea) {
      if (f.area * S.k * S.k < 0.02) break;
      if (!visible(f.label, c)) continue;
      const [x, y] = proj(f.label);
      const [text, sp] = caps(f.d.name, 11);
      place(text, x, y, `600 11px ${LABEL_FONT}`, P.muted, false, sp, inkOf(f));
    }
  }
  if (own && mt.namesFirst) own();
  const items = shownItems();
  for (const it of items) if (it.major) hotLabel(it);
  if (S.k >= 1.8 && !quiet) for (const it of items) if (!it.major) hotLabel(it);
  if (plain && S.layers.has('capitals') && S.k >= 4) {
    for (const f of byArea) {
      if (!isCapital(f) || !visible(f.d.capitalAt, c)) continue;
      const [x, y] = proj(f.d.capitalAt);
      place(f.d.capital, x, y + 11, `italic 500 12px ${LABEL_FONT}`, ink.text, false, 0, inkOf(f));
    }
  }
}

// ---------- layout ----------

// While a panel slides (the phone sheet, a panel's entrance) its box is read without the transform, where it is going.
const shown = el => {
  if (el.hidden || !el.getClientRects().length) return null;
  return el.getAnimations().length ? new DOMRect(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight) : el.getBoundingClientRect();
};
const narrow = () => S.w <= 720;

// The part of the screen not covered by panels; the globe is centred and fitted there.
function freeRect() {
  let l = 0, t = 0, r = S.w, b = S.h;
  const ctl = shown($('#controls')), inf = shown($('#info')), leg = shown($('#legendCard')), card = shown($('#ghostCard'));
  if (narrow()) {
    const barBottom = $('.bar').getBoundingClientRect().bottom;
    const top = Math.max(barBottom, ctl ? ctl.bottom : 0) + 8;
    t = top;
    // The zoom column is a slim strip at the edge, so it does not limit the globe's band; the true-size
    // card does, since the outline is always drawn at the band's centre.
    for (const e of [inf, leg, card]) if (e) b = Math.min(b, e.top - 8);
    // The globe sits above the zoom column when the whole globe fits there, so the buttons stay off it.
    const zm = shown($('.zoom'));
    if (zm && zm.top - 8 - t >= 2 * S.base + 16) b = Math.min(b, zm.top - 8);
    if (b - t < 120) t = barBottom + 8; // an open panel would leave too little room: let the globe run under it
    // Still too little (short screens, tall sheet): centre a 120px band on the strip that is actually uncovered.
    if (b - t < 120) { const mid = (top + b) / 2; t = mid - 60; b = mid + 60; }
    // From 600px wide (foldables) a globe that still reaches down to the zoom column ends left of it (fitBase sizes it).
    if (zm && S.w >= 600 && (t + b) / 2 + S.base > zm.top) { l = 8; r = zm.left - 8; }
  } else {
    if (inf && !document.body.classList.contains('ctl-fold')) r = inf.left;
    const zm = shown($('.zoom'));
    // The left column (controls above, legend below) is cleared either sideways or above and below,
    // whichever leaves the larger square.
    const left = [ctl, leg].filter(Boolean);
    if (left.length) {
      const side = { l: Math.max(...left.map(e => e.right)), t: 0, b: S.h };
      const stack = { l: 0, t: ctl ? ctl.bottom + 8 : 0, b: leg ? leg.top - 8 : S.h };
      const fit = o => Math.min(r - o.l, o.b - o.t);
      const o = fit(side) >= fit(stack) ? side : stack;
      ({ l, t, b } = o);
      // Stacked (portrait tablets): the key fills only the left column, so the globe may reach below its top edge on
      // the right while it stays clear of the key's top-right corner and of the zoom row. R solves R + sqrt(R² - dx²) = D.
      const top = t + 16, dx = (l + r) / 2 - leg?.right - 8, D = leg?.top - 8 - top;
      if (o === stack && leg && dx > 0 && D > 0) {
        const R = Math.min((r - l) / 2 - 40, (D * D + dx * dx) / (2 * D), ((zm ? zm.top - 8 : S.h) - 16 - top) / 2);
        if (R > (b - t) / 2 - 16) b = top + 2 * R + 16;
      }
    }
    // Short landscape screens stand the zoom buttons as a column between the controls and the panel (style.css): keep the globe, the hint and the true-size card clear of it.
    if (inf && zm && zm.height > zm.width && zm.left > l && zm.left < r) r = zm.left - 8;
    // Keep the true-size outline (drawn at the centre) clear of its card on short windows.
    if (card && card.left < r && card.right > l) b = Math.min(b, card.top - 8);
  }
  return { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t };
}

// Where the true-size card (and the hint, when it has no room under the controls) sits along the bottom:
// the globe's band, or beside the legend.
function bottomBand() {
  const fr = freeRect(), leg = shown($('#legendCard'));
  if (narrow() || !leg) return fr;
  // Right of the legend when that leaves room for the true-size card (300px); otherwise the globe's band.
  const r = fr.x + fr.w / 2;
  return r - leg.right >= 300 ? { x: (leg.right + r) / 2, w: r - leg.right } : fr;
}
let cardH = 52;
// layoutChrome's values go on the elements that use them: one changed on :root restyles every element on the page,
// an open list's thousand rows included. A new style.css rule that uses one of them needs its selector added here.
const VARS = { '--dock': '#controls, .zoom, #hint, #ghostCard, #attrib', '--legend-h': '#controls', '--hint-top': '#hint', '--free-x': '#hint, #ghostCard', '--free-w': '#hint, #ghostCard' };
const setVar = (name, v) => { for (const e of document.querySelectorAll(VARS[name])) e.style.setProperty(name, v); };
function layoutChrome() {
  document.body.classList.toggle('has-info', !$('#info').hidden);
  document.body.classList.toggle('ctl-open', narrow() && !!$('#controls details[open]'));
  // Mid widths: an open control section and the side panel cannot both fit beside the globe, so the panel folds to its title bar.
  document.body.classList.toggle('ctl-fold', !narrow() && S.h > 500 && !$('#info').hidden && !!$('#controls details[open]') && S.w - 306 - 388 < 360);
  let dock = 0;
  if (narrow()) for (const e of [shown($('#info')), shown($('#legendCard'))]) if (e) dock = Math.max(dock, S.h - e.top);
  setVar('--dock', dock + 'px');
  // Phones: hide the zoom column when it would climb into the search bar or controls (tall sheet,
  // 200% zoom, landscape). Pinch, the wheel and the + and − keys still zoom.
  const ctlBottom = $('#controls').getBoundingClientRect().bottom;
  // Four 44px buttons, 8px apart; two (+ and −) while the sheet is open (style.css).
  document.body.classList.toggle('no-zoom', narrow() && S.h - dock - 12 - ($('#info').hidden ? 200 : 96) < ctlBottom + 8);
  // The true-size card is hidden where it has no room: on phones when too little of the globe would show above it,
  // elsewhere when the globe's free width is under 300px (phone landscape with a panel open).
  // The panel's Hide true size and the live region still work.
  cardH = $('#ghostCard').offsetHeight || cardH; // 0 while hidden: keep the last measured height
  let noCard;
  if (narrow()) noCard = S.h - dock - 8 - cardH - 8 < ctlBottom + 8 + 120; // the outline needs a 120px band above the card
  else { document.body.classList.add('no-ghostcard'); noCard = bottomBand().w < 300; }
  document.body.classList.toggle('no-ghostcard', noCard);
  // Desktop: a long key (Geologic) also takes the ground the controls card leaves free above it. Measured
  // from the card's content, not its box, which the key itself squeezes.
  const ctl = $('#controls'), need = ctl.getBoundingClientRect().top + [...ctl.children].reduce((s, e) => s + e.scrollHeight, 2);
  // With the Map section open its controls come first: the key, which scrolls, then gives up room down to a quarter.
  const floor = $('#mapPanel').open ? 0.25 : 0.44;
  $('#legendCard').style.maxHeight = narrow() ? '' : Math.max(Math.min(S.h - 221, floor * S.h), S.h - 28 - need) + 'px';
  keyMore();
  const leg = shown($('#legendCard'));
  // The legend under the column takes from its height.
  setVar('--legend-h', !narrow() && leg ? leg.height + 12 + 'px' : '0px');
  // Desktop: the hint goes in the free ground under the controls card, off the globe, when two lines fit there.
  const ctlBox = $('#controls').getBoundingClientRect();
  document.body.classList.toggle('hint-col', !narrow() && (leg ? leg.top : S.h - 16) - ctlBox.bottom - 16 >= 48);
  setVar('--hint-top', ctlBox.bottom + 8 + 'px');
  // Phones: no hint where it would sit on the globe (Help has the gestures).
  const hb = narrow() && shown($('#hint'));
  if (hb) {
    const fr = freeRect(), dx = Math.max(hb.left - fr.x, 0, fr.x - hb.right), dy = Math.max(hb.top - fr.y, 0, fr.y - hb.bottom);
    document.body.classList.toggle('hint-off', Math.hypot(dx, dy) < S.base * S.k);
  }
  const band = bottomBand();
  setVar('--free-x', band.x + 'px');
  setVar('--free-w', band.w + 'px');
  fitSections();
}

// Desktop: when the legend or a newly opened section makes the controls card overflow, keep only the
// section opened last, so every header stays in view.
let lastOpened = null;
function fitSections() {
  const ctl = $('#controls');
  if (narrow()) return;
  const open = [...ctl.querySelectorAll('details[open]')];
  // Sections shrink into inner scrollers before the card itself overflows, so test the sections.
  if (open.length < 2 || open.every(d => d.scrollHeight <= d.clientHeight + 1)) return;
  const keep = open.includes(lastOpened) ? lastOpened : open[0];
  for (const d of open) if (d !== keep) d.open = false;
}

// Phones and short screens fold the map's key (see renderLegend), and so do mid widths while a panel is open,
// so the key leaves the narrow map column to the globe. So does a key taller than 40% of the screen where the globe
// sits above the cards (portrait tablets): set by renderLegend, cleared when the map type or the window changes.
const foldKey = () => narrow() || S.h <= 500 || (S.w <= 1100 && !!S.sel) || S.tallKey;
const stacked = () => S.w - 322 < 0.84 * Math.min(S.w, S.h); // the globe cannot sit beside the 290px column
// At k = 1 the whole globe fits the free area beside or between the cards, 16px clear above and below and 40px
// at the sides, so names near the edge of the globe stay on screen.
// shortcut: measured with no panel open; a link that opens a panel on entry keeps the plain size until the next resize.
const fitBase = () => {
  if (narrow()) { S.base = Math.min(S.base, freeRect().w / 2); proj.scale(S.base * S.k); return; } // the foldable's band left of the zoom column
  if (!$('#info').hidden) return;
  const fr = freeRect(); S.base = Math.min(S.base, fr.w / 2 - 40, fr.h / 2 - 16); proj.scale(S.base * S.k); };
const baseSize = () => Math.min(narrow() ? S.w * 0.46 : stacked() ? S.w / 2 - 40 : S.w * 0.42, S.h * 0.42);
// The globe's sea and rim, drawn at once so the screen is not empty while the map data loads; render() takes over.
function drawSphere() {
  S.w = innerWidth; S.h = innerHeight; S.dpr = Math.min(devicePixelRatio || 1, 3);
  canvas.width = S.w * S.dpr; canvas.height = S.h * S.dpr;
  canvas.style.width = S.w + 'px'; canvas.style.height = S.h + 'px';
  S.base = baseSize(); fitBase();
  const q = new URLSearchParams(location.search), fr = freeRect(), mt = mapType(q.get('map') || DEFAULT_MAP);
  const light = !!mt.paper || (!mt.ownsColour && !!q.get('colour')), P = darkQuery.matches && light ? CP : C;
  document.body.classList.toggle('paper-globe', light);
  proj.translate([fr.x, fr.y]).scale(S.base);
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  ctx.beginPath(); path(SPHERE);
  ctx.fillStyle = mt.sea || P.ocean; ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = P.coast; ctx.stroke();
  dimPaper(darkQuery.matches && light);
}
// Safari on iPhone can report the window's size or pixel density before they are final, and fires no resize until
// the toolbar moves (a first touch). Measured again when the app has settled, and whenever the visual viewport changes.
const remeasure = () => { if (innerWidth !== S.w || innerHeight !== S.h || Math.min(devicePixelRatio || 1, 3) !== S.dpr) { resize(); draw(); } };
// ?debug: the numbers that decide how sharp the globe is, for a device the app cannot be tested on directly.
function debugBox() {
  const box = document.createElement('pre');
  box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9;margin:0;padding:6px 8px;font:12px/1.4 monospace;background:rgba(0,0,0,.75);color:#fff;pointer-events:none';
  document.body.append(box);
  const show = () => { const v = window.visualViewport; box.textContent = `dpr ${devicePixelRatio} (used ${S.dpr})
window ${innerWidth}x${innerHeight} (used ${S.w}x${S.h})
canvas ${canvas.width}x${canvas.height} css ${canvas.clientWidth}x${canvas.clientHeight}
viewport scale ${v ? v.scale.toFixed(2) : '?'}
moving ${!!S.moving} booting ${!!S.booting} flying ${!!S.flying}
filter ${getComputedStyle(canvas).filter}`; };
  show(); setInterval(show, 500);
}
function resize() {
  const wasNarrow = narrow(), wasFold = foldKey(), wasWide = S.w >= 1180, wasShort = S.h <= 500;
  S.w = innerWidth; S.h = innerHeight;
  S.tallKey = false; // measured again for the new size (renderLegend)
  S.dpr = Math.min(devicePixelRatio || 1, 3); // 3x phones: at 2x the globe looked soft
  if (S.dpr !== patternDpr) makePatterns();
  // Narrowing to phone width with a panel open: close the control sections, as select() does on phones,
  // so the sheet is not squeezed to its title bar.
  if (!wasNarrow && narrow()) {
    if (S.sel) for (const d of $('#controls').querySelectorAll('details[open]')) d.open = false;
    else { const o = $('#controls details[open]'); if (o) arrangeSections(o); } // phone order: open section last
  }
  if (S.sel && wasWide && S.w < 1180) for (const d of $('#controls').querySelectorAll('details[open]')) d.open = false; // the rule select() applies
  if ((wasFold !== foldKey() || wasNarrow !== narrow() || wasShort !== S.h <= 500) && features) renderLegend();
  setPlaceholder();
  canvas.width = S.w * S.dpr; canvas.height = S.h * S.dpr;
  canvas.style.width = S.w + 'px'; canvas.style.height = S.h + 'px';
  tiles?.resize(S.w, S.h, S.dpr);
  S.base = baseSize(); // stacked: fitBase sizes it to the free area
  layoutChrome();
  $('#info').style.minHeight = ''; // kept from the last tab change (setTab), which may not fit the new window
  tabStrip();
  fitBase();
  zoomLimit(); // the Photographic limit follows the globe's size
  const fr = freeRect();
  proj.translate([fr.x, fr.y]).scale(S.base * S.k);
  if (d3.active(canvas) && !S.flying) frame(); // a running re-centre would keep writing its old target
  draw();
}

// ---------- interaction ----------

const inBounds = ([[w, s], [e, n]], [x, y]) =>
  y >= s - 0.01 && y <= n + 0.01 && (w <= e ? x >= w - 0.01 && x <= e + 0.01 : x >= w || x <= e);

function pick(x, y) {
  const c = center();
  let best = null, bd = PICK_RADIUS;
  for (const it of shownItems()) {
    if (!visible(it.at, c)) continue;
    const [px, py] = proj(it.at);
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = it; }
  }
  if (best) return { kind: 'hot', obj: best };
  const mt = mapType(S.map);
  const feat = mt.overlay?.ready && mt.overlay.pick?.(x, y, overlayApi(c));
  if (feat) return { kind: 'feature', obj: feat };
  const [cx, cy] = proj.translate();
  if (Math.hypot(x - cx, y - cy) > proj.scale()) return null;
  const ll = proj.invert([x, y]);
  if (!ll || Number.isNaN(ll[0])) return null;
  if (mt.click === 'point') return { kind: 'here', obj: { at: ll, country: countryAt(ll) } };
  if (S.layers.has('contested')) {
    const a = contested.find(a => inBounds(a.bounds, ll) && d3.geoContains(a.geo, ll) && (!a.clip || a.clip.some(f => d3.geoContains(f, ll))));
    if (a?.feature) return { kind: 'country', obj: byKey.get(a.feature), contested: a };
    if (a) return a.hot ? { kind: 'hot', obj: hotById.get(a.hot), contested: a } : { kind: 'country', obj: byIso.get(a.holder), contested: a };
  }
  const f = features.find(f => inBounds(f.bounds, ll) && d3.geoContains(f, ll));
  return f ? { kind: 'country', obj: f } : null;
}

let last = d3.zoomIdentity;
const clampLat = v => Math.max(-89, Math.min(89, v));
const zoom = d3.zoom()
  .scaleExtent([0.8, 30000]) // from the whole globe to a street; each map type sets its own limit (zoomLimit)
  .clickDistance(4)
  .duration(still() ? 0 : DUR_2)
  // A flight's transition brings its own scale curve (frame); every other zoom transition takes d3's.
  .interpolate((a, b) => { const h = hop; hop = null; return h ? t => [a[0], a[1], a[2] * h.k0 / h.kAt(t)] : d3.interpolateZoom(a, b); })
  // A drag or pinch held still for a moment must not draw the detailed map mid-gesture (a long frame on slow phones).
  // The wheel has no release, so it keeps the 140 ms idle redraw.
  .on('start', e => { if (e.sourceEvent && e.sourceEvent.type !== 'wheel') S.gesture = true; })
  .on('end', () => { if (S.gesture) { S.gesture = false; if (S.moving) moving(); } })
  .on('zoom', e => {
    moving();
    const t = e.transform;
    // Panning turns the globe; a change in scale only zooms.
    if (e.sourceEvent && t.k === last.k) {
      const r = proj.rotate(), deg = 180 / Math.PI / proj.scale();
      proj.rotate([r[0] + (t.x - last.x) * deg, clampLat(r[1] - (t.y - last.y) * deg), r[2]]);
    }
    S.k = t.k;
    proj.scale(S.base * t.k);
    last = t;
    zoomButtons();
    hideTip();
    draw();
  });

motionQuery.addEventListener('change', () => zoom.duration(still() ? 0 : DUR_2));
const zoomBy = f => { hop = null; d3.select(canvas).transition().duration(still() ? 0 : DUR_2).call(zoom.scaleBy, f); };
// Each map type zooms in only as far as its images have detail: its maxK (a number, or worked out from the globe's
// size), else 30000, about a street. Called when the map type or the globe's size changes.
function zoomLimit() {
  const m = mapType(S.map).maxK, max = (typeof m === 'function' ? m({ base: S.base, dpr: S.dpr }) : m) || 30000;
  zoom.scaleExtent([0.8, max]);
  if (S.k > max) d3.select(canvas).call(zoom.scaleTo, max);
  zoomButtons();
}
// + and − say when they are at the limit (aria-disabled, not disabled, so keyboard focus stays on the button).
function zoomButtons() {
  const [lo, hi] = zoom.scaleExtent();
  for (const [id, off] of [['#zin', S.k >= hi * 0.999], ['#zout', S.k <= lo * 1.001]]) if ($(id).getAttribute('aria-disabled') !== String(off)) $(id).setAttribute('aria-disabled', off);
}

// Turn, zoom and re-centre the globe in one move. Any drag, scroll or arrow key interrupts it.
// A move pulls out and back in on van Wijk and Nuij's path (d3.interpolateZoom), worked in radians of arc and of view
// radius and never further out than the whole globe (k 1), so a long flight shows both ends on the way. It takes
// 400 ms and 3 ms a degree, from 500 to 1000 ms. With reduced motion the globe cuts to the new view.
let hop = null; // the flight's scale curve, taken by the zoom's tween when the flight starts (zoom.interpolate)
function frame({ at, k } = {}) {
  hop = null;
  const fr = freeRect();
  // A re-centre with nowhere to go (the webfont arrived but nothing moved) would only redraw the whole map twice.
  const [tx, ty] = proj.translate();
  if (!at && !k && !d3.active(canvas) && Math.abs(tx - fr.x) < 0.5 && Math.abs(ty - fr.y) < 0.5) return;
  const [lo, hi] = zoom.scaleExtent(), r0 = proj.rotate(), k0 = S.k, k1 = Math.max(lo, Math.min(hi, k || k0));
  let turn = null, along = t => t, dur = FLY;
  if (at) {
    const r1 = [-at[0], -at[1], 0];
    r1[0] = r0[0] + ((((r1[0] - r0[0]) % 360) + 540) % 360) - 180;
    turn = d3.interpolate(r0, r1);
    const arc = d3.geoDistance(center(), at), view = s => Math.min(fr.w, fr.h) / 2 / (S.base * s);
    const zp = d3.interpolateZoom([0, 0, view(k0)], [arc, 0, view(k1)]), floor = Math.min(1, k0, k1);
    if (arc > 1e-6) along = t => (t >= 1 ? 1 : zp(t)[0] / arc);
    hop = { k0, kAt: t => (t >= 1 ? k1 : Math.max(floor, view(1) / zp(t)[2])) };
    dur = Math.min(1000, Math.max(FLY, 400 + (3 * arc) / RAD));
  }
  const move = d3.interpolate(proj.translate(), [fr.x, fr.y]);
  const tr = d3.select(canvas).transition().duration(still() || S.booting ? 0 : dur).ease(d3.easeCubicInOut)
    .tween('frame', () => t => { if (turn) proj.rotate(turn(along(t))); proj.translate(move(t)); moving(); });
  if (at || k) tr.call(zoom.scaleTo, k1); else hop = null;
  // Drawn in the tick itself, after the zoom's tween has set the scale, so the globe moves in the frame the panel changes.
  tr.tween('paint', () => () => { if (features) render(); });
  if (at || k) {
    S.flying = true;
    // If a panel or the webfont changed size mid-flight, settle into the new free area.
    const landed = () => { S.flying = false; if (S.late) { S.late = false; if (S.sel) renderInfo(); } };
    tr.on('end.fly', () => {
      landed();
      const now = freeRect();
      if (Math.abs(now.x - fr.x) > 1 || Math.abs(now.y - fr.y) > 1) frame();
    }).on('interrupt.fly', landed);
  }
}

// The centre of the smallest cap round some points, so a group's far members sit at the same distance from the
// middle (the centroid leant NATO towards its 30 European members). Badoiu and Clarkson: ever smaller steps
// towards the farthest point.
function capCentre(pts) {
  const vs = pts.map(unitVec);
  let c = vs[0];
  for (let i = 1; i < 1000; i++) {
    const p = vs.reduce((a, v) => (dot(v, c) < dot(a, c) ? v : a)), m = c.map((x, j) => x + (p[j] - x) / (i + 1)), n = Math.hypot(...m);
    c = m.map(x => x / n);
  }
  return [Math.atan2(c[1], c[0]) / RAD, Math.asin(c[2]) / RAD];
}
{ const [lon, lat] = capCentre([[-77, 39], [33, 39], [0, 50]]); console.assert(Math.abs(lon + 22) < 2 && Math.abs(lat - 54.7) < 1, 'capCentre'); }

function fitK(geo, anchor) {
  const fr = freeRect();
  const [[w, s], [e, n]] = d3.geoBounds(geo);
  const r = Math.max(...[[w, s], [e, n], [w, n], [e, s]].map(p => d3.geoDistance(p, anchor)));
  const k = (0.42 * Math.min(fr.w, fr.h)) / (S.base * Math.sin(Math.min(Math.max(r, 0.02), 1.3)));
  return Math.max(1, Math.min(12, k));
}

function view(kind, obj) {
  if (kind === 'country') return { at: obj.coreAt, k: fitK(obj.core, obj.coreAt) };
  if (kind === 'compare') {
    if (!obj.b) return view('country', obj.a);
    const at = d3.geoCentroid({ type: 'MultiPoint', coordinates: [obj.a.coreAt, obj.b.coreAt] });
    return { at, k: fitK({ type: 'GeometryCollection', geometries: [obj.a.core, obj.b.core] }, at) };
  }
  if (obj.line) { const g = { type: 'LineString', coordinates: obj.line }, at = d3.geoCentroid(g); return { at, k: fitK(g, at) }; }
  // A point on land opens close in; one at sea stays far enough out to show the coasts round it.
  return { at: obj.at, k: Math.max(S.k, obj.feature?.k || (kind === 'point' && obj.country ? 8 : 3)) };
}

function urlFor(hash) {
  const q = new URLSearchParams();
  if (S.mode !== 'none') q.set('colour', S.mode);
  if (S.scope === 'un') q.set('countries', 'un');
  if (S.map !== DEFAULT_MAP) q.set('map', S.map);
  // The map type's own settings (a day, a period), so a link or a reload shows the same map.
  for (const [k, v] of Object.entries(mapType(S.map).params?.() || {})) if (v != null) q.set(k, v);
  // @ and , stay readable, so a point's link reads #@24.0000,45.0000 (fromUrl decodes either form).
  return location.pathname + (q.size ? '?' + q : '') + (hash ? '#' + encodeURIComponent(hash).replace(/%40/g, '@').replace(/%2C/g, ',') : '');
}
const isoOf = f => f.d.iso3 || f.key;
const hashFor = (kind, obj) => (!obj ? '' : kind === 'list' ? 'list' : kind === 'country' ? isoOf(obj)
  : kind === 'compare' ? ['compare', isoOf(obj.a), obj.b && isoOf(obj.b)].filter(Boolean).join('-') : obj.id);

// fly: fit the item; push: add a history entry; focus: move focus to the panel title.
function select(kind, obj, { fly = false, push = true, focus = false, state = null } = {}) {
  // Under the UN filter a non-member cannot be the second country (it may arrive from a link).
  if (kind === 'compare' && obj.b && !inScope(obj.b)) obj = { a: obj.a, b: null };
  const prev = S.sel?.obj;
  // Read before the panel re-renders: only a close from inside the panel sends focus back to the opener.
  const fromPanel = $('#info').contains(document.activeElement) || document.activeElement === document.body;
  if (obj && !S.sel && document.activeElement !== document.body) S.returnFocus = document.activeElement;
  const wasFold = foldKey();
  S.sel = obj ? { kind, obj } : null;
  if (S.hover?.strong && kind !== 'list' && !S.kbd) S.hover = null; // a list row's mark ends with the list
  if (obj !== prev) S.anti = null;
  if (obj) { $('#status').textContent = ''; $('#q').value = ''; closeResults(); }
  if (kind === 'hot' && obj && !S.layers.has(obj.layer)) setLayer(obj.layer, true);
  // A list opened from a country's rank keeps its way back in the history entry, so Back and Forward restore it;
  // a country opened from the list is marked { fromList } by its caller.
  const own = state ?? (kind === 'list' && obj?.from ? { from: isoOf(obj.from), rank: obj.rank } : null);
  const url = urlFor(hashFor(kind, obj));
  // No new entry when the address would not change (picking the same second country again). A new selection
  // replacing the entry gets its own state; a redraw or a Back/Forward keeps what the entry already holds.
  if (push && obj !== prev && url !== location.pathname + location.search + location.hash) history.pushState(own, '', url);
  else history.replaceState(push && obj !== prev ? own : { ...(history.state || {}), ...(own || {}) }, '', url);
  // Phones and mid-size screens can't show the open control sections next to the info panel.
  if (obj && (narrow() || S.w < 1180)) for (const d of $('#controls').querySelectorAll('details[open]')) d.open = false;
  renderInfo();
  if (wasFold !== foldKey()) renderLegend();
  layoutChrome();
  if (!obj || kind === 'list' || (kind === 'point' && !fly)) frame();
  else frame(fly || kind === 'compare' ? view(kind, obj) : { at: kind === 'country' ? obj.anchor : obj.at });
  if (obj && focus) $('#infoTitle')?.focus({ preventScroll: true });
  if (!obj && prev && !fromPanel) S.returnFocus = null;
  if (!obj && prev && fromPanel) {
    let back = S.returnFocus && document.contains(S.returnFocus) ? S.returnFocus : canvas;
    // On touch screens, focusing the search box would pop up the keyboard.
    if (coarse && back.matches('input, textarea')) back = canvas;
    const section = back.closest('details');
    if (section && !section.open) section.open = true;
    back.focus({ preventScroll: true });
    S.returnFocus = null;
  }
  draw();
}

function setLayer(id, on) {
  if (on) S.layers.add(id); else S.layers.delete(id);
  const box = document.querySelector(`#placeList input[value="${id}"]`);
  if (box) box.checked = on;
  syncPlaces();
  renderLegend(); // the key's Hot spots block lists the layers shown
  draw();
}

// Hot spots: every layer of markers and lines from hotspots.json, plus contested areas (not capitals).
const placeLayers = () => [...hot.layers.map(l => l.id), 'contested'];
const placesShown = () => placeLayers().filter(id => S.layers.has(id));
// Hot spots (the header switch and the eye button): hides whatever is shown, and brings back the same layers.
function toggleHot() {
  const on = placesShown();
  if (on.length) { S.placesWere = on; for (const id of on) setLayer(id, false); }
  else for (const id of S.placesWere || placeLayers()) setLayer(id, true);
}
// The header switch and the eye button follow the layers: on while any place is shown (their name stays, the state is the tick).
function syncPlaces() {
  const n = placesShown().length, btn = $('#placesBtn'), hotAll = $('#hotAll');
  if (hotAll) hotAll.checked = n > 0;
  if (btn) {
    btn.setAttribute('aria-pressed', String(n > 0));
    btn.title = n > 0 ? 'Hide hot spots' : 'Show hot spots';
  }
  // The Places tab says how many of its layers are hidden (bases, ports and capitals start hidden), so it shows there is more.
  const off = [...document.querySelectorAll('#placeList .lyr:not([hidden]) label')].filter(l => !l.querySelector('input').checked)
    .map(l => l.textContent.slice(0, -l.querySelector('.count').textContent.length));
  $('#placesOff').textContent = off.length ? ` ${off.length} hidden` : '';
  $('#placesOff').parentElement.title = off.length ? `Hidden: ${off.join(', ')}` : '';
}

function setScope(v) {
  S.scope = v === 'un' ? 'un' : 'all';
  for (const r of document.querySelectorAll('input[name="scope"]')) r.checked = r.value === S.scope;
  scales = {}; ranks = {};
  history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj)));
  renderLegend();
  if (S.sel?.kind === 'compare' && S.sel.obj.b && !inScope(S.sel.obj.b)) select('compare', { a: S.sel.obj.a, b: null }, { push: false });
  else if (S.sel && S.sel.kind !== 'hot') renderInfo();
  if (document.activeElement === $('#q')) showResults();
  layoutChrome();
  draw();
}

function setMode(m, { turn = false } = {}) {
  const was = S.mode, name = k => [...$('#mode').options, ...$('#group').options].find(o => o.value === k)?.text;
  S.mode = m;
  document.body.classList.toggle('paper-globe', lightGlobe());
  // One colouring at a time: a group shows in Or show a group, anything else in Colour by figure; the other select goes
  // back to None, and the live region says so, since a screen reader on one select does not hear the other change.
  $('#mode').value = blocById.has(m) ? 'none' : m;
  $('#group').value = blocById.has(m) ? m : 'none';
  if (was !== 'none' && m !== 'none' && blocById.has(was) !== blocById.has(m)) $('#mapSays').textContent = `${name(m)} replaces ${name(was)}.`;
  history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj)));
  renderLegend();
  if (S.sel?.kind === 'list' && m === 'none') { if (S.sel.obj.from) closePanel(); else select(null); }
  else if (S.sel?.kind === 'country' || S.sel?.kind === 'list') renderInfo();
  layoutChrome();
  // The legend shrinks the controls card; keep the select the user is on in view.
  const a = document.activeElement;
  if (a === $('#mode') || a === $('#group')) a.scrollIntoView({ block: 'nearest' });
  const b = blocById.get(m);
  if (turn && b && !S.sel) {
    // The globe turns and zooms to fit the members. Groups spread round the world (AUKUS) carry their own view
    // centre; the centroid would sit in the Arctic.
    const fs = [...b.members, ...(b.also || [])].map(iso => byIso.get(iso)).filter(Boolean);
    const at = b.at || capCentre(fs.map(f => f.anchor));
    frame({ at, k: fitK({ type: 'GeometryCollection', geometries: fs.map(f => f.core) }, at) });
  } else frame();
  draw();
}

// What the current colouring says about a country: its figure and year, income group or role in the bloc.
function modeLine(f) {
  const m = colourMode(), d = f.d;
  if (m === 'none' || !d.iso3 || !inScope(f)) return '';
  if (info.indicators[m]) {
    // The figure and its rank, so the colour is never the only way to read it.
    const v = d.v?.[m], [r, n, tie] = rank(m, f.key);
    return !v ? 'No data' : `${FMT[info.indicators[m].fmt](v[0])}, ${v[1]}${r ? `, ${tie ? 'joint ' : ''}${ordinal(r)} of ${n}` : ''}`;
  }
  if (m === 'income') return d.income || 'Not classified';
  const b = blocById.get(m), role = b?.role.get(d.iso3);
  return !role ? '' : (b.also || []).includes(d.iso3) ? 'Through a member' : role === 'member' ? 'Member' : b.partnerRole;
}

const tip = $('#tip');
function showTip(p, x, y) {
  const comparing = S.sel?.kind === 'compare' && p.kind === 'country' && p.obj !== S.sel.obj.a;
  // While comparing, say why a click here will leave the comparison instead of filling it.
  const why = comparing && !compareTarget(p.kind, p.obj) ? (!p.obj.d.iso3 ? 'No figures to compare' : 'Not a UN member') : '';
  if (compareTarget(p.kind, p.obj)) tip.innerHTML = `${esc(p.obj.d.name)}<small>Click to compare with ${esc(S.sel.obj.a.d.name)}</small>`;
  else if (p.contested) tip.innerHTML = `${esc(p.contested.name)}<small>${esc(why || contestText(p.contested))}</small>`;
  else if (p.kind === 'hot') tip.innerHTML = `${esc(p.obj.name)}<small>${esc(layerById.get(p.obj.layer).name)}</small>`;
  else if (p.kind === 'feature') tip.innerHTML = `${esc(p.obj.title)}${p.obj.sub ? `<small>${esc(p.obj.sub)}</small>` : ''}`;
  else if (p.kind === 'here') tip.innerHTML = `${esc(pickName(p))}<small>${latLonText(p.obj.at)}</small>`;
  else if (why || modeLine(p.obj)) tip.innerHTML = `${esc(p.obj.d.name)}<small>${esc(why || modeLine(p.obj))}</small>`;
  else tip.textContent = p.obj.d.name;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.transform = `translate(${Math.min(x + 14, S.w - r.width - 8)}px, ${Math.min(y + 14, S.h - r.height - 8)}px)`;
}
function hideTip() { tip.hidden = true; }
// The name of whatever is under the pointer or the keyboard crosshair.
function pickName(p) {
  if (!p) return 'At sea';
  if (p.contested) return p.contested.name;
  if (p.kind === 'hot') return p.obj.name;
  if (p.kind === 'feature') return p.obj.title;
  if (p.kind === 'here') return p.obj.country?.d.name || 'At sea';
  return p.obj.d.name;
}

function hideHint() {
  const h = $('#hint');
  if (h.hidden || h.classList.contains('gone')) return;
  h.classList.add('gone');
  setTimeout(() => { h.hidden = true; }, 300);
}

// ---------- search ----------

function buildIndex() {
  const add = (names, kind, obj) => { for (const n of names) if (n) S.index.push({ n: norm(n), raw: n, kind, obj }); };
  for (const f of byIso.values()) add([f.d.name, f.d.iso3, ...(f.d.alt || [])], 'country', f);
  for (const f of features) if (!f.d.iso3) add([f.d.name, f.key], 'country', f);
  for (const it of hot.items) add([it.name, ...(it.alt || [])], 'hot', it);
  for (const b of blocs.blocs) add([b.name, b.full, b.label], 'bloc', b);
  for (const t of MAP_TYPES) add([label(t)], 'map', t);
}

// The shown map type's own places (mt.places: Airports' names and IATA codes), searched only while it is shown;
// indexed once per list the type hands back.
const placeIndex = new WeakMap();
function mapPlaces() {
  const list = mapType(S.map).places?.();
  if (!list?.length) return [];
  if (!placeIndex.has(list)) placeIndex.set(list, list.flatMap(f => f.names.filter(Boolean).map(n => ({ n: norm(n), raw: n, kind: 'feature', obj: f }))));
  return placeIndex.get(list);
}

const nameOf = e => (e.kind === 'country' ? e.obj.d.name : e.kind === 'map' ? label(e.obj) : e.kind === 'feature' ? e.obj.title : e.obj.name);

// Edit distance that counts a swapped pair as one typo ("Germnay"), giving up past `max`.
function near(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row.push(v);
      low = Math.min(low, v);
    }
    if (low > max) return false;
    prev2 = prev; prev = row;
  }
  return prev[b.length] <= max;
}

// 0 exact, 1 starts with, 2 a word starts with, 3 contains, 4 one or two typos; null for no match.
function matchScore(n, q, typos = true) {
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(' ' + q)) return 2;
  if (q.length >= 3 && n.includes(q)) return 3;
  if (typos && q.length >= 4 && near(n.length > q.length + 2 ? n.slice(0, q.length) : n, q, q.length >= 8 ? 2 : 1)) return 4;
  return null;
}

// Best match per country or place. An alias that matched better than the shown name comes back as a note
// ("Eswatini" found by "Swaziland").
function search(text) {
  const q = norm(text);
  if (!q) return { hits: [], hidden: 0 };
  const best = new Map();
  for (const e of S.index.concat(mapPlaces())) {
    // A map's thousands of places take typos only after a right first letter, so typing stays quick.
    const s = matchScore(e.n, q, e.kind !== 'feature' || e.n[0] === q[0]);
    // Very short queries match only from the start of a word, so "bur" does not dig into native-language names.
    if (s === null || (q.length < 4 && s > 2)) continue;
    const own = e.n === norm(nameOf(e));
    const key = s * 2 + (own ? 0 : 1);
    const prev = best.get(e.obj);
    if (!prev || key < prev.key) best.set(e.obj, { kind: e.kind, obj: e.obj, key, note: own ? '' : e.raw });
  }
  // On an exact tie a place beats a country ("Falkland Islands / Malvinas" is the dispute); otherwise countries first.
  let all = [...best.values()].sort((a, b) => a.key - b.key
    || (a.key === 0 ? (b.kind === 'hot') - (a.kind === 'hot') : (a.kind === 'hot') - (b.kind === 'hot'))
    || (a.obj.rank || 0) - (b.obj.rank || 0) // a map's places in its own order (Airports: the busiest first)
    || nameOf(a).localeCompare(nameOf(b)));
  // Loose matches (inside a word, or a typo) only when nothing matches from the start of a word:
  // "congo" should not bring up Mongolia once Congo itself is found.
  if (all.some(h => h.key <= 5)) all = all.filter(h => h.key <= 5);
  const hits = all.filter(h => h.kind !== 'country' || inScope(h.obj));
  return { hits: hits.slice(0, 8), hidden: all.length - hits.length };
}

const resultsEl = () => $('#results');
function closeResults() {
  resultsEl().hidden = true;
  $('#q').setAttribute('aria-expanded', 'false');
  $('#q').removeAttribute('aria-activedescendant');
}

// The one UN member with no shape on the 1:50m map.
const TUVALU = 'Tuvalu is too small to draw at this map scale, so it has no page here.';
const isTuvalu = text => { const t = text.trim().toLowerCase(); return t === 'tv' || (t.length >= 3 && ['tuvalu', 'funafuti', 'ellice islands'].some(n => n.startsWith(t) || t.startsWith(n))); };
function showResults() {
  const q = $('#q'), list = resultsEl(), status = $('#status');
  const { hits, hidden } = search(q.value);
  S.hits = hits; S.cur = 0;
  status.textContent = !q.value.trim() ? ''
    : !hits.length && isTuvalu(q.value) ? TUVALU
    : !hits.length ? `Nothing called "${q.value.trim()}"${hidden ? ` among UN members; ${hidden} ${hidden === 1 ? 'match is' : 'matches are'} outside that filter` : ''}. Try a country, a former name such as Burma, an ISO code such as VNM, or a place such as Suez.`
    : hidden ? `${hidden === 1 ? '1 more match is not a UN member' : `${hidden} more matches are not UN members`}. Set Countries to All to see ${hidden === 1 ? 'it' : 'them'}.` : '';
  if (!hits.length) return closeResults();
  list.innerHTML = hits.map((h, i) => {
    // UN members show their region; anything else shows its status, which is the more useful fact there.
    const kind = h.kind === 'bloc' ? 'Group' : h.kind === 'map' ? 'Map type' : h.kind === 'hot' ? layerById.get(h.obj.layer).name
      : h.kind === 'feature' ? h.obj.kind
      : compareTarget(h.kind, h.obj) ? `Compare with ${S.sel.obj.a.d.name}`
      : h.obj.d.status === 'un' ? h.obj.d.region || 'UN member' : STATUS[h.obj.d.status] || 'Map area';
    return `<li role="option" id="opt-${i}" data-i="${i}" aria-selected="${i === 0}">
      <span class="on">${esc(nameOf(h))}${h.note ? ` <small>${esc(h.note)}</small>` : ''}</span><span class="ok">${esc(kind)}</span></li>`;
  }).join('') + (hidden ? `<li class="more" aria-hidden="true">${esc(status.textContent)}</li>` : '');
  list.hidden = false;
  q.setAttribute('aria-expanded', 'true');
  q.setAttribute('aria-activedescendant', 'opt-0');
}

function moveResult(step) {
  if (resultsEl().hidden) return showResults();
  S.cur = (S.cur + step + S.hits.length) % S.hits.length;
  for (const li of resultsEl().children) li.setAttribute('aria-selected', +li.dataset.i === S.cur);
  $('#q').setAttribute('aria-activedescendant', 'opt-' + S.cur);
  $('#opt-' + S.cur)?.scrollIntoView({ block: 'nearest' });
}

function openResult(i = S.cur) {
  const h = S.hits[i], b = h && compareTarget(h.kind, h.obj);
  if (b && b === S.sel.obj.b) { $('#q').value = ''; closeResults(); $('#infoTitle')?.focus(); }
  else if (b) select('compare', { a: S.sel.obj.a, b }, { focus: true });
  // A group colours the map by its members; a map type switches the map.
  else if (h?.kind === 'bloc') { $('#q').value = ''; closeResults(); setMode(h.obj.id, { turn: true }); }
  else if (h?.kind === 'map') { $('#q').value = ''; closeResults(); setMapType(h.obj.id); }
  else if (h?.kind === 'feature') choose(h, { fly: true, focus: true }); // a map's own place opens as if clicked
  else if (h) select(h.kind, h.obj, { fly: true, focus: true });
  else if ($('#q').value.trim()) showResults();
}

// ---------- panels ----------

const SHAPE_SVG = {
  circle: c => `<circle cx="7" cy="7" r="4.6" fill="${c}"/>`,
  diamond: c => `<path d="M7 1.4 12.6 7 7 12.6 1.4 7Z" fill="${c}"/>`,
  square: c => `<rect x="2.6" y="2.6" width="8.8" height="8.8" fill="${c}"/>`,
  triangle: c => `<path d="M7 1.6 12.7 11.8H1.3Z" fill="${c}"/>`,
  ring: c => `<circle cx="7" cy="7" r="4.2" fill="none" stroke="${c}" stroke-width="2.2"/>`,
  squareOpen: c => `<rect x="3" y="3" width="8" height="8" fill="none" stroke="${c}" stroke-width="2.2"/>`
};
function shapeIcon(layerId, color) {
  const l = layerById.get(layerId);
  const filled = !['ring', 'squareOpen'].includes(l.shape);
  return `<svg class="mk" viewBox="0 0 14 14" aria-hidden="true"${filled ? ` stroke="${C.edge}" stroke-width="0.8"` : ''}>${SHAPE_SVG[l.shape](color || l.color)}</svg>`;
}
// A hot-spot layer's symbol (Places and the map key): a marker shape, or the hatch of contested areas. uid keeps the
// hatch's clip id unique while both show it; color stands in for the layer's own (grey under a colouring).
function placeIcon(id, uid = '', color) {
  if (id !== 'contested') return shapeIcon(id, color);
  return `<svg class="mk" viewBox="0 0 14 14" aria-hidden="true"><clipPath id="hatchClip${uid}"><rect x="1" y="1" width="12" height="12" rx="2"/></clipPath><g clip-path="url(#hatchClip${uid})" stroke="${C.hatch}" stroke-width="1"><path d="M-2 6 6-2M-2 11 11-2M-2 16 16-2M3 16 16 3M8 16 16 8"/></g><rect x="1" y="1" width="12" height="12" rx="2" fill="none" stroke="${C.border}" stroke-width="0.8"/></svg>`;
}
// The map key's Hot spots block: the layers shown, each with its Places symbol and count; empty while none is shown.
function hotKey() {
  const grey = quietHot() ? C.muted : null; // as the globe draws them under a colouring or on a data map (render)
  const rows = placesShown().map(id => {
    const l = layerById.get(id), n = l ? hot.items.filter(it => it.layer === id).length : contested.length;
    return `<li>${placeIcon(id, 'Key', grey)}${esc(l ? l.name : 'Contested areas')}<span class="count">${n}</span></li>`;
  });
  return rows.length ? `<div class="hotkey"><p><strong>Hot spots</strong></p><ul class="swatches">${rows.join('')}</ul></div>` : '';
}

function countryButton(f) {
  return f ? `<button type="button" data-f="${f.i}">${esc(f.d.name)}</button>` : '';
}
function hotButton(it) {
  return `<button type="button" data-hot="${esc(it.id)}">${shapeIcon(it.layer)}${esc(it.name)}</button>`;
}

const TABS = [
  ['overview', 'Overview'], ['people', 'People'], ['economy', 'Economy'], ['institutions', 'Institutions'],
  ['security', 'Security'], ['religion', 'Religion'], ['divisions', 'Divisions'], ['geography', 'Geography']
];

// Names, codes, trends, age pyramid and economy mix: data/atlas.json, fetched the first time it is needed.
let atlas = null, atlasLoad = null;
function loadAtlas() {
  atlasLoad ||= fetch('data/atlas.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .catch(() => ({ countries: {}, years: [0, 0], failed: true }))
    .then(a => { atlas = a; if (S.sel?.kind === 'country' || S.sel?.kind === 'compare') lateRender(); });
  return atlasLoad;
}

// ---------- charts (SVG strings; hover is handled in bind) ----------

const CW = 336;
const CHARTS = new Map();
let chartN = 0;
const times = v => d3.format('.2~r')(v) + '×';

// Every chart's numbers as a table behind a disclosure, for screen readers and for anyone who wants exact figures.
function figuresTable(head, rows) {
  return `<details class="figs"><summary>Show figures</summary>
    <table class="rank"><thead><tr>${head.map((h, i) => `<th scope="col"${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((v, i) => (i ? `<td class="num">${v}</td>` : `<th scope="row">${v}</th>`)).join('')}</tr>`).join('')}</tbody></table>
  </details>`;
}

// One or two yearly series on a shared axis. series: [{ name, cls, values }] aligned to atlas.years.
// Pointer, touch (tap or drag) and the arrow keys all move the year shown under the chart.
// opts.start: the year of values[0] (default: the atlas's first year); opts.zero: false fits the axis to the data;
// opts.tickFmt: a coarser format for the axis ticks only (the readout and the table keep fmt); opts.gaps: the line
// breaks at a year with no value instead of joining across it, and a year with no neighbour is a dot (arms transfers).
function trendChart(series, fmt, label, measure, opts = {}) {
  const y0 = opts.start ?? atlas.years[0];
  const lines = series.map(s => ({ ...s, pts: (s.values || []).map((v, i) => [y0 + i, v]).filter(p => p[1] != null) }))
    .filter(s => s.pts.length > 1);
  if (!lines.length) return '<p class="empty">No data</p>';
  const H = 150, m = { l: 48, r: 10, t: 10, b: 22 };
  const pts = lines.flatMap(s => s.pts);
  const x = d3.scaleLinear(d3.extent(pts, p => p[0]), [m.l, CW - m.r]);
  const [vlo, vhi] = d3.extent(pts, p => p[1]);
  const y = d3.scaleLinear(opts.zero === false ? [vlo - (vhi - vlo) * 0.1, vhi + (vhi - vlo) * 0.1] : [0, vhi], [H - m.b, m.t]).nice(4);
  const line = d3.line(p => x(p[0]), p => y(p[1])).defined(p => p[1] != null);
  const id = 'c' + chartN++;
  const years = [...new Set(pts.map(p => p[0]))].sort((a, b) => b - a);
  CHARTS.set(id, { lines, x, y, fmt, year: null, years });
  const yt = y.ticks(4).map(t => `<line class="gl" x1="${m.l}" x2="${CW - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t)}" dy="0.32em" text-anchor="end">${(opts.tickFmt || fmt)(t)}</text>`).join('');
  const xt = x.ticks(5).map(t => `<text x="${x(t)}" y="${H - 5}" text-anchor="middle">${t}</text>`).join('');
  const cell = (s, yr) => { const p = s.pts.find(q => q[0] === yr); return p ? fmt(p[1]) : '–'; };
  const [lo, hi] = x.domain();
  // The year cursor is a slider, so screen readers switch to focus mode and pass the arrow keys through.
  return `<figure class="chart" aria-label="${esc(label)}">
    <svg viewBox="0 0 ${CW} ${H}" data-chart="${id}" tabindex="0" role="slider" aria-label="${esc(label)}, year"
      aria-valuemin="${lo}" aria-valuemax="${hi}" aria-valuenow="${hi}" aria-valuetext="${esc(readoutText(id))}">
      ${yt}${xt}<line class="axis" x1="${m.l}" x2="${CW - m.r}" y1="${y(y.domain()[0])}" y2="${y(y.domain()[0])}"/>
      ${lines.map(s => `<path class="ln ${s.cls}" d="${line(opts.gaps ? s.values.map((v, i) => [y0 + i, v]) : s.pts)}"/>`).join('')}
      ${opts.gaps ? lines.flatMap(s => s.values.flatMap((v, i) => (v != null && s.values[i - 1] == null && s.values[i + 1] == null ? [`<circle class="pt ${s.cls}" r="2.5" cx="${x(y0 + i)}" cy="${y(v)}"/>`] : []))).join('') : ''}
      <line class="cur" y1="${m.t}" y2="${H - m.b}" hidden/>
      ${lines.map((s, i) => `<circle class="dot ${s.cls}" r="3.5" data-s="${i}" hidden/>`).join('')}
    </svg>
    <figcaption aria-hidden="true">${readout(id)}</figcaption>
  </figure>
  ${figuresTable(['Year', ...(lines.length > 1 ? lines.map(s => s.name) : [measure || lines[0].name])], years.map(yr => [yr, ...lines.map(s => cell(s, yr))]))}`;
}
// Plain text of the readout, for the slider's aria-valuetext ("2025: 64.7M", or both countries in compare).
function readoutText(id, year) {
  const c = CHARTS.get(id);
  const yr = year ?? d3.max(c.lines, s => s.pts.at(-1)[0]);
  const vals = c.lines.map(s => { const p = s.pts.find(q => q[0] === yr); return `${c.lines.length > 1 ? s.name + ' ' : ''}${p ? c.fmt(p[1]) : 'no data'}`; });
  return `${yr}: ${vals.join(', ')}`;
}
// Shows one year on a trend chart; null goes back to the latest year. The year snaps to one with data (height has a
// value every second birth year); dir, from the arrow keys, takes the next such year that way.
function showYear(svg, year, dir = 0) {
  const id = svg.dataset.chart, c = CHARTS.get(id);
  if (!c) return;
  const hi = c.x.domain()[1];
  const near = () => c.years.reduce((a, b) => (Math.abs(b - year) < Math.abs(a - year) ? b : a));
  const next = year == null ? null : (dir > 0 ? d3.min(c.years, y => (y >= year ? y : undefined)) : dir < 0 ? d3.max(c.years, y => (y <= year ? y : undefined)) : undefined) ?? near();
  if (next === c.year) return; // no DOM work, and no repeated announcement, within the same year
  c.year = next;
  svg.setAttribute('aria-valuenow', c.year ?? hi);
  svg.setAttribute('aria-valuetext', readoutText(id, c.year ?? undefined));
  const cur = svg.querySelector('.cur');
  cur.toggleAttribute('hidden', c.year == null);
  if (c.year != null) { cur.setAttribute('x1', c.x(c.year)); cur.setAttribute('x2', c.x(c.year)); }
  for (const dot of svg.querySelectorAll('.dot')) {
    const p = c.year == null ? null : c.lines[+dot.dataset.s].pts.find(q => q[0] === c.year);
    dot.toggleAttribute('hidden', !p);
    if (p) { dot.setAttribute('cx', c.x(p[0])); dot.setAttribute('cy', c.y(p[1])); }
  }
  svg.parentNode.querySelector('figcaption').innerHTML = readout(id, c.year);
}
const yearAt = (svg, clientX) => {
  const c = CHARTS.get(svg.dataset.chart), r = svg.getBoundingClientRect();
  return c.x.invert(((clientX - r.left) * CW) / r.width);
};
// At rest (year null) only the series names, as the key of a two-line chart: the latest values sit in the rows above.
// Values and the year show while a pointer, tap or arrow key is on a year.
function readout(id, year = null) {
  const c = CHARTS.get(id);
  const two = c.lines.length > 1;
  return c.lines.map(s => {
    const p = year != null && s.pts.find(q => q[0] === year);
    return year == null && !two ? '' : `<span>${two ? `<i class="sw ${s.cls}"></i>${esc(s.name)} ` : ''}${year == null ? '' : p ? c.fmt(p[1]) : '–'}</span>`;
  }).join('') + (year == null ? '' : `<span class="yr">${year}</span>`);
}

const AGES = ['0–4', '5–9', '10–14', '15–19', '20–24', '25–29', '30–34', '35–39', '40–44', '45–49',
  '50–54', '55–59', '60–64', '65–69', '70–74', '75–79', '80+'];
function pyramidChart(rows, year) {
  const r = rows.map((x, i) => [AGES[i], x[0], x[1]]).reverse();
  const lab = 38, half = (CW - lab) / 2 - 2, mid = lab + half + 2, H = r.length * 12 + 18;
  const max = Math.ceil(d3.max(r, x => Math.max(x[1], x[2])));
  const w = v => (v / max) * half;
  const bars = r.map(([age, m, f], i) => `<g><title>${age}: men ${pct(m)}, women ${pct(f)}</title>
    <text x="0" y="${i * 12 + 5}" dy="0.32em">${age}</text>
    <rect class="s1" x="${mid - 1 - w(m)}" y="${i * 12}" width="${w(m)}" height="10" rx="1.5"/>
    <rect class="s2" x="${mid + 1}" y="${i * 12}" width="${w(f)}" height="10" rx="1.5"/></g>`).join('');
  const by = r.length * 12 + 12;
  return `<figure class="chart">
    <svg viewBox="0 0 ${CW} ${H}" role="img" aria-label="Population by age and sex, ${year}">${bars}
      <text x="${lab}" y="${by}">${max}%</text><text x="${mid}" y="${by}" text-anchor="middle">0</text><text x="${CW}" y="${by}" text-anchor="end">${max}%</text>
    </svg>
    <figcaption><span><i class="sw s1"></i>Men</span><span><i class="sw s2"></i>Women</span><span class="yr">share of each sex, ${year}</span></figcaption>
  </figure>
  ${figuresTable(['Age', 'Men', 'Women'], [...r].reverse().map(([age, m, f]) => [age, pct(m), pct(f)]))}`;
}

// A 100% bar for shares that should add up to 100; the gap to 100 is shown in grey.
function mixBar(items, rest, label) {
  // Colours follow the category (Renewables is always the third colour), so a zero share never shifts them.
  const parts = items.map((i, k) => [i[0], i[1], 's' + (k + 1)]).filter(p => p[1] > 0);
  if (!parts.length) return '<p class="empty">No data</p>';
  const sum = d3.sum(parts, p => p[1]);
  if (sum < 99.5) parts.push([rest, 100 - sum, 'so']);
  const total = Math.max(100, sum);
  let x = 0;
  const segs = parts.map(([n, v, cls]) => {
    const w = (v / total) * CW;
    const s = `<rect class="${cls}" x="${x}" y="0" width="${Math.max(0.5, w - 2)}" height="14" rx="2"><title>${esc(n)}: ${pct(v)}</title></rect>`;
    x += w;
    return s;
  }).join('');
  return `<svg class="mix" viewBox="0 0 ${CW} 14" role="img" aria-label="${esc(label)}">${segs}</svg>
    <ul class="mixkey">${parts.map(([n, v, cls]) => `<li><i class="sw ${cls}"></i>${esc(n)}<span class="bv">${pct(v)}</span></li>`).join('')}</ul>`;
}

// Overview, institutions, religion and divisions live in their own file, fetched the first time a country opens.
// Photos of each country (nature, culture, cities, getting around) from Wikimedia Commons, chosen through
// Wikidata by scripts/build_photos.py; fetched while idle (prefetchPhotos) and read the first time a panel needs them.
let photos = null, photosLoad = null;
// The idle prefetch (see start) only fetches the text, at low priority; it is read into objects when a panel first
// needs it, so the entry screen does not pay for parsing 1.5 MB.
let photoText = null;
const prefetchPhotos = () => { if (!photosLoad) photoText ||= fetch('data/photos.json', { priority: 'low' }).then(r => (r.ok ? r.text() : null)).catch(() => null); };
function loadPhotos() {
  photosLoad ||= (photoText || Promise.resolve(null))
    .then(t => t ?? fetch('data/photos.json').then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status)))))
    .then(t => JSON.parse(t))
    .catch(() => { photosLoad = photoText = null; return { countries: {}, failed: true }; }) // the next country opened asks again
    .then(p => { photos = p; if (S.sel?.kind === 'country') lateRender(); });
  return photosLoad;
}
const PHOTO_GROUPS = [['nature', 'Nature'], ['culture', 'Culture'], ['cities', 'Cities'], ['transport', 'Getting around']];
// caption: only the historical plates keep a line under them (who drew them, and when); the button already says
// it, so the line is hidden from screen readers. Thumbnails are Commons' 330px step (sharp at 3x in a 107px slot);
// the lightbox asks for 1280px.
// A string caption is used as the line itself (Security's "Su-30MK2 · Fighter aircraft").
function photoButton(iso, g, i, p, label, caption = false) {
  const tag = caption ? 'figure' : 'div';
  return `<${tag} class="photo"><button type="button" data-photo="${iso}|${g}|${i}" aria-label="${esc(`${label}: ${p.title}. Open the photo`)}" title="${esc(p.title)}">
      <img src="${esc(p.img.replace(/\/\d+px-/, '/330px-'))}" alt="" loading="lazy" decoding="async" width="${p.w}" height="${p.h}"></button>
    ${caption ? `<figcaption aria-hidden="true">${esc(caption === true ? `${label}: ${p.title}` : caption)}</figcaption>` : ''}</${tag}>`;
}
// Six photos (two rows), the first of each group leading, then the rest behind "Show all".
function photosHTML(d) {
  // After a failed load, a newly opened country (not a redraw of this one) asks again.
  if (!photos || (photos.failed && lastShown !== S.sel?.obj)) loadPhotos();
  if (!photos) return '';
  if (photos.failed) return '<p class="empty">Photos did not load. Open the country again to retry.</p>';
  const set = photos.countries[d.iso3];
  if (!set) return '';
  const groups = PHOTO_GROUPS.filter(([g]) => set[g]?.length);
  if (!groups.length) return '';
  const order = [...groups.map(([g]) => [g, 0]), ...groups.flatMap(([g]) => set[g].slice(1).map((p, i) => [g, i + 1]))];
  const label = Object.fromEntries(PHOTO_GROUPS);
  return `<h3>Photos</h3>${capped(order.map(([g, i]) => photoButton(d.iso3, g, i, set[g][i], label[g])), 6, 'div', 'photos', 'photos')}`;
}
// The flag and the coat of arms (or emblem, or seal) at the head of Overview, from scripts/build_symbols.py. Loaded with
// the first country opened; a failed load leaves them out.
let symbols = null, symbolsLoad = null;
function symbolsHTML(d) {
  symbolsLoad ||= fetch('data/symbols.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .catch(() => ({ countries: {} }))
    .then(s => { symbols = s; if (S.sel?.kind === 'country') lateRender(); });
  const set = symbols?.countries[d.iso3];
  if (!set?.length) return '';
  return `<div class="symbols">${set.map((p, i) => `<figure class="${p.kind === 'Flag' ? 'flag' : 'arms'}">
    <button type="button" data-photo="${d.iso3}|symbols|${i}" aria-label="${esc(p.title)}. Open the image" title="${esc(p.title)}">
    <img src="${esc(p.img.replace(/\/\d+px-/, '/330px-'))}" alt="" decoding="async" width="${p.w}" height="${p.h}"></button>
    <figcaption aria-hidden="true">${esc(p.kind)}</figcaption></figure>`).join('')}</div>`;
}
function openPhoto(key) {
  const [iso, g, i] = key.split('|');
  const p = iso === 'map' ? mapType(S.map).photo?.(+i) // a map type's own photos (Airports)
    : g === 'people' ? peopleData?.photos?.countries?.[iso]?.[+i]
    : g === 'history' ? peopleData?.history?.regions?.[iso]?.images?.[+i]
    : g === 'symbols' ? symbols?.countries[iso]?.[+i]
    : g === 'forces' || g === 'equip' ? secPhotos?.countries[iso]?.[g === 'forces' ? 'forces' : 'equipment']?.[+i]
    : photos?.countries[iso]?.[g]?.[+i];
  if (!p) return;
  const box = $('#lightbox'), old = box.querySelector('img'), img = new Image(); // a new element never paints the previous photo
  // Sized from the record before any bytes arrive, so the dialog does not jump: 1072 is the dialog's 1100px less its
  // padding, 0.76 the 76vh cap in style.css. The caption beside it names the photo, so the image has no alt of its own.
  // A flag or an emblem is line art: it stays within 480 by 440px (the dialog then takes its width, style.css).
  const ratio = p.w && p.h ? p.w / p.h : 4 / 3, sym = g === 'symbols';
  img.style.width = Math.min(sym ? Math.min(480, 440 * ratio) : 1072, innerWidth * 0.94 - 28, innerHeight * 0.76 * ratio) + 'px';
  box.classList.toggle('sym', sym);
  img.style.aspectRatio = String(ratio);
  img.alt = '';
  if (g === 'symbols' && p.kind !== 'Flag') img.className = 'arms'; // a paper ground in dark mode (style.css)
  img.src = p.img.replace(/\/\d+px-/, '/1280px-');
  // The panel's 330px thumbnail (already loaded) stands in under the photo, which fades in over it once it arrives.
  box.querySelector('.pic').style.backgroundImage = `url("${p.img.replace(/\/\d+px-/, '/330px-')}")`;
  if (!img.complete) { img.classList.add('wait'); img.addEventListener('load', () => img.classList.remove('wait'), { once: true }); }
  old.replaceWith(img);
  box.querySelector('.cap').textContent = p.caption || (g === 'forces' || g === 'equip' ? `${p.title} (${p.kind})` : p.title);
  box.querySelector('.credit').innerHTML = `${p.author ? esc(p.author) + ', ' : ''}${esc(p.licence)}, via <a href="${esc(p.page)}" target="_blank" rel="noopener">Wikimedia Commons</a>`;
  box.showModal();
}

// The People tab's wider picture, built by scripts/build_height.py, build_people_groups.py,
// build_people_photos.py and build_history.py; any file may be missing, and its section is then left out.
// A file that is not there (404) is left out quietly; one that failed to load is said, and asked for again with the
// next country opened.
let peopleData = null, peopleLoad = null;
const FAILED = { failed: true };
function loadPeople() {
  peopleLoad ||= Promise.all(['height', 'ethnic', 'blood', 'photos', 'history'].map(n =>
    fetch(`data/people/${n}.json`).then(r => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(r.status)))).catch(() => FAILED)))
    .then(got => {
      const [height, ethnic, blood, photos, history] = got.map(x => (x === FAILED ? null : x));
      peopleData = { height, ethnic, blood, photos, history, failed: got.includes(FAILED) };
      if (peopleData.failed) peopleLoad = null;
      if (S.sel?.kind === 'country') lateRender();
    });
  return peopleLoad;
}
const qual = q => ({ '<': 'under ', '>': 'over ', '~': 'about ' })[q] || '';
// A right-aligned column that mixes whole and one-decimal shares gives the whole ones an invisible ".0" (style.css),
// so the units digits line up; the text itself still reads "44%".
const pctIn = vals => {
  const dec = vals.some(v => v != null && /\.\d%$/.test(pct(v))); // one decimal (shares under 1% keep two figures)
  return v => { const s = pct(v); return dec && !s.includes('.') ? s + '<span class="pad" aria-hidden="true"></span>' : s; };
};
// Named groups by size; residual rows ("Other", "Unspecified", "Other/none/unspecified") go last, whatever their share.
// "Other Christian" or "Other Arab" names a group, so it keeps its place by size.
const REST = new Set('other unspecified unknown none not stated no answer or and unaffiliated stateless unavailable foreign religion religions smaller ethnic groups'.split(' '));
const rest = n => /^(other|unspecified|unknown|not stated|none[ /](or )?unspecified)\b/i.test(n) && n.toLowerCase().split(/[\s/,]+/).every(w => REST.has(w));
console.assert(rest('Other') && rest('Other/none/unspecified') && rest('None or unspecified') && !rest('Other Christian') && !rest('None')
  && pctIn([37.4, 44])(44).includes('pad') && !pctIn([30, 44])(44).includes('pad') && pctIn([0.032, 5])(5) === '5%', 'residual rows and padded shares');
const shareBars = items => {
  const f = pctIn(items.map(x => x[1]));
  return `<ul class="bars">${[...items].sort((a, b) => rest(a[0]) - rest(b[0]) || b[1] - a[1]).map(([name, pc, q]) => `
  <li><span class="bl">${esc(name).replace(/\//g, '/​')}</span><span class="bt"><i style="width:${Math.min(100, pc)}%"></i></span><span class="bv">${qual(q)}${f(pc)}</span></li>`).join('')}</ul>`;
};
const srcLink = (text, url) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

function heightHTML(d) {
  const H = peopleData.height, h = H?.countries?.[d.iso3];
  if (!h || !(h.men?.length || h.women?.length)) return '';
  const f1 = d3.format('.1f'), cm = v => f1(v) + ' cm';
  const row = (label, s) => {
    const p = s?.at(-1);
    return p && [label, `${cm(p[1])} <span class="yr">born ${p[0]}${p[2] != null ? `, 95%&nbsp;interval ${f1(p[2])} to ${f1(p[3])}` : ''}</span>`];
  };
  const start = d3.min([h.men?.[0]?.[0], h.women?.[0]?.[0]].filter(v => v != null));
  const end = d3.max([h.men?.at(-1)?.[0], h.women?.at(-1)?.[0]].filter(v => v != null));
  const align = s => { const out = Array(end - start + 1).fill(null); for (const [yr, v] of s || []) out[yr - start] = v; return out; };
  const series = [{ name: 'Men', cls: 's1', values: align(h.men) }, { name: 'Women', cls: 's2', values: align(h.women) }];
  // Folded, like Names and codes; the method behind the estimates is in Sources.
  return `<details class="sect"><summary>Height</summary>${dl([row('Men', h.men), row('Women', h.women)].filter(Boolean))}
    ${trendChart(series, cm, `Mean adult height in ${d.name} by year of birth`, 'Height', { start, zero: false, tickFmt: v => d3.format('.0f')(v) + ' cm' })}
    <p class="note">Modelled estimates by year of birth, latest cohort born ${end}.${esc(studiesLine(d, h.studies))}</p></details>`;
}
function studiesLine(d, s) {
  if (!s) return '';
  const n = v => (v === 1 ? '1 study' : `${v} studies`);
  if (!s.men && !s.women) return ` No measurements from ${d.name} itself: its estimates are borrowed from other countries, mostly in the same region.`;
  if (!s.men || !s.women) return ` Measured data for ${d.name}: ${n(s.men || s.women)} of ${s.men ? 'men' : 'women'}, none of ${s.men ? 'women' : 'men'}.`;
  return ` Measured data for ${d.name}: ${n(s.men)} of men, ${s.women} of women.`;
}

function ethnicHTML(d) {
  const E = peopleData.ethnic, r = E?.countries?.[d.iso3];
  if (!r) return '';
  const body = r.items && d3.sum(r.items, x => x[1]) >= 85 ? shareBars(r.items) : `<p>${esc(r.text)}</p>`;
  const notes = [
    r.basis && `Counted by ${r.basis}${r.basis === 'ancestry' ? '' : ', not by ethnic group'}.`,
    r.multi && 'People could give more than one origin, so the shares add up to more than 100%.',
    r.note && !(r.basis && /^data represent/i.test(r.note)) && cap(r.note).replace(/([^.!?)])$/, '$1.'),
    r.dated_terms && "Some group names are the source's own wording and are dated.",
    r.year && `${r.year} estimate.`,
  ].filter(Boolean);
  return `<h3>Ethnic groups</h3>${body}<p class="note">${esc(notes.join(' '))}</p>`;
}

function bloodHTML(d) {
  const B = peopleData.blood, r = B?.countries?.[d.iso3];
  if (!r) return '';
  const G = ['O', 'A', 'B', 'AB'], sum = g => (r[g + '+'] == null && r[g + '-'] == null ? null : (r[g + '+'] || 0) + (r[g + '-'] || 0));
  // Each column lines up its own figures.
  const col = vals => { const p = pctIn(vals); return v => (v == null ? '–' : p(v)); };
  const pos = col(G.map(g => r[g + '+'])), neg = col(G.map(g => r[g + '-'])), all = col(G.map(sum));
  const rows = G.map(g => `<tr><th scope="row">${g}</th><td class="num">${pos(r[g + '+'])}</td><td class="num">${neg(r[g + '-'])}</td>
    <td class="num">${all(sum(g))}</td></tr>`).join('');
  // Folded, like Height; which countries are shown, and why, is in Sources.
  return `<details class="sect"><summary>Blood groups</summary>
    <table class="rank blood"><thead><tr><th scope="col">Group</th><th scope="col" class="num">Rh+</th><th scope="col" class="num">Rh−</th><th scope="col" class="num">All</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="note">${r.year ? `${esc(r.year)}. ` : ''}${esc(cap(r.sample || 'share of people as the publisher states it'))}.${r.note ? ` ${esc(cap(r.note))}.` : ''}</p></details>`;
}

const LIFE = { festival: 'Festival', dress: 'Dress', dance: 'Dance', market: 'Market', food: 'Food' };
function peoplePhotosHTML(d) {
  const list = peopleData.photos?.countries?.[d.iso3];
  if (!list?.length) return '';
  return `<h3>People and daily life</h3><div class="photos">${list.map((p, i) => photoButton(d.iso3, 'people', i, p, LIFE[p.what] || 'Daily life')).join('')}</div>`;
}

// Racial typology as it was taught about a century ago, kept apart and folded, and introduced as discredited.
// Only the old books' own plates and maps are shown, never photos of people living now.
// The works the regions' texts cite are listed in Sources.
function historyHTML(d) {
  const Hs = peopleData.history, key = Hs?.countries?.[d.iso3], r = key && Hs.regions?.[key];
  if (!r) return '';
  return `<details class="sect history"><summary>Phenotypes: a historical view</summary>
    <p class="warn"><strong>These classifications are shown as history of science. They have been shown to be wrong.</strong></p>
    ${Hs.note ? `<p>${esc(Hs.note)}</p>` : ''}
    <h4>${esc(r.title)}</h4><p>${esc(r.text)}</p>
    ${r.images?.length ? `<div class="photos">${r.images.map((p, i) => photoButton(key, 'history', i, p, [p.author, p.year].filter(Boolean).join(', ') || 'Historical plate', true)).join('')}</div>` : ''}
  </details>`;
}

function peopleExtras(d) {
  if (!peopleData || (peopleData.failed && lastShown !== S.sel?.obj)) loadPeople(); // a redraw does not ask again
  if (!peopleData) return '';
  return heightHTML(d) + ethnicHTML(d) + bloodHTML(d) + peoplePhotosHTML(d) + historyHTML(d) + (peopleData.failed ? NOT_LOADED : '');
}

let profiles = null, profilesLoad = null;
function loadProfiles() {
  profilesLoad ||= fetch('data/profiles.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .catch(() => ({ countries: {}, failed: true }))
    .then(p => { profiles = p; if (S.sel?.kind === 'country') lateRender(); });
  return profilesLoad;
}

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
function profilePanels(d) {
  if (!profiles) {
    loadProfiles();
    const wait = '<p class="empty">Loading…</p>';
    return { overview: wait, institutions: wait, religion: wait, divisions: wait };
  }
  const p = profiles.countries[d.iso3] || {};
  const none = what => `<p class="empty">${profiles.failed ? 'This section did not load. Reload the page to try again.' : `No ${what} for ${esc(d.name)} in the sources used here.`}</p>`;
  const dl = rows => `<dl class="facts">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;

  const overview = p.overview
    ? `<p class="lede">${esc(p.overview)}</p>`
    : none('summary');

  const i = p.inst || {};
  const instRows = [];
  if (i.gov) instRows.push(['System', i.gov]);
  else if (i.form) instRows.push(['System', cap(i.form.join(', '))]);
  for (const [title, name] of i.leaders || []) instRows.push([title, name]);
  if (!i.leaders) {
    const same = i.hos && i.hog && i.hos.join() === i.hog.join();
    if (i.hos) instRows.push([same ? 'Head of state and government' : 'Head of state', i.hos.join(', ')]);
    if (i.hog && !same) instRows.push(['Head of government', i.hog.join(', ')]);
  }
  // System and leaders also lead the Overview; Institutions adds the legislature.
  const leaders = instRows.length ? dl(instRows) : '';
  if (i.leg) instRows.push(['Legislature', i.leg.join(', ')]);
  for (const [house, name] of i.houses || []) instRows.push([house, name]);
  const institutions = instRows.length ? dl(instRows) : none('institutions');

  const r = p.religion;
  let religion = none('religion figures');
  if (r) {
    // Bars only when the shares cover most people; a partial list would draw a minority as the whole picture.
    const bars = r.items && d3.sum(r.items, x => x[1]) >= 85 ? shareBars(r.items) : `<p>${esc(r.text)}</p>`;
    religion = `${bars}${r.note ? `<p class="note">${esc(cap(r.note).replace(/([^.!?)])$/, '$1.'))}</p>` : ''}${r.year ? `
      <p class="note">${r.year} estimate.</p>` : ''}`;
  }

  const v = p.div;
  const divisions = v
    ? `${dl([['First-level divisions', String(v.n)], ...(v.type ? [['Most common type', cap(v.type)]] : [])])}
       <ul class="divlist">${v.names.slice().sort(new Intl.Collator('en').compare).map(n => `<li>${esc(n)}</li>`).join('')}</ul>`
    : none('division list');

  return { overview, leaders, institutions, religion, divisions };
}

const lngText = lng => `${Math.abs(lng).toFixed(0)}° ${lng >= 0 ? 'E' : 'W'}`;
// Hemispheres from every part of the country (overseas ones too), not from one centre point: Ecuador is north
// and south, Britain east and west, France north and south (Réunion), Kiribati all four.
// The 1:50m map has no shapes for these countries' islands south of the equator (Addu, Annobón, Ilhéu das Rolas).
const ALSO_SOUTH = new Set(['MDV', 'GNQ', 'STP']);
function hemispheres(f) {
  const [[w, s], [e, n]] = f.bounds;
  const ns = (s < 0 || ALSO_SOUTH.has(f.d.iso3)) && n > 0 ? 'Northern and Southern' : n <= 0 ? 'Southern' : 'Northern';
  // world-atlas cuts shapes at the antimeridian, so a bound at ±180 also means the 180th meridian is crossed.
  const dateline = w > e || w <= -179.99 || e >= 179.99;
  const ew = dateline || (w < 0 && e > 0) ? 'Eastern and Western' : e <= 0 ? 'Western' : 'Eastern';
  return `${ns}; ${ew}${dateline ? ', across the 180th meridian' : ''}`;
}
// While true size is on, every panel other than that country's own says so and offers to hide it, since the
// outline stays at the middle of the globe whatever is opened next (that is how one country is laid over another).
// style.css shows the line only where the true-size card, with its Done button, is hidden.
const ghostLine = obj => (S.ghost && S.ghost.f !== obj
  ? `<p class="ghostline">Showing ${esc(S.ghost.f.d.name)} at true size. <button type="button" class="rk" data-ghostoff="1">Hide</button></p>` : '');
// A list that shows its first `n` items and a "Show all" button for the rest (the button toggles .capped).
// `key` names the list so renderInfo can keep it open across redraws.
function capped(items, n, tag, cls, key) {
  if (items.length <= n) return `<${tag} class="${cls}">${items.join('')}</${tag}>`;
  const label = `Show all ${items.length}`;
  return `<${tag} class="${cls} capped cap${n}">${items.join('')}</${tag}><button type="button" class="link more" data-more="${label}" data-key="${key}" aria-expanded="false">${label}</button>`;
}
const areaNum = v => (v < 10 ? d3.format(',.2~f')(v) : d3.format(',')(Math.round(v)));
const areaText = v => areaNum(v) + ' km²'; // never breaks before the unit
// Fact list; rows without a value are left out.
const dl = rows => `<dl class="facts">${rows.filter(r => r[1] != null && r[1] !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

// A map area that a country holds (Siachen Glacier) is part of the dispute, not a neighbour of anyone.
const neighbours = f => f.nb.map(i => features[i]).filter(g => g.d.iso3 || !contested.some(c => c.feature === g.key && c.holder))
  .sort((a, b) => a.d.name.localeCompare(b.d.name));
const NOT_LOADED = '<p class="empty">This section did not load. Reload the page to try again.</p>';
// " since 1990": the first year any of the series has a value (many start after the data's first year).
const sinceFrom = (y0, ...series) => {
  const i = d3.min(series.filter(Boolean), v => { const k = v.findIndex(x => x != null); return k < 0 ? undefined : k; });
  return i == null ? '' : ` since ${y0 + i}`;
};
const sinceYear = (...series) => sinceFrom(atlas.years[0], ...series);

// A group chip: it colours the map by that group's membership (Overview's Groups, Security's alliances).
function groupChip(b, iso) {
  const role = b.role.get(iso) === 'partner' ? ` · ${b.partnerRole}` : '';
  const on = S.mode === b.id;
  return `<button type="button" class="group" data-mode="${b.id}" aria-pressed="${on}" title="${on ? 'Stop colouring the map' : `Colour the map by ${esc(b.name)} membership`}"><span class="sw" aria-hidden="true"></span>${esc(b.name)}${esc(role)}</button>`;
}

// The Security tab's Factbook text, nuclear status and their sources: data/security.json from
// scripts/build_security.py, fetched with the first country opened. The figures come from atlas.json (mil).
let security = null, securityLoad = null;
function loadSecurity() {
  securityLoad ||= fetch('data/security.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .catch(() => ({ countries: {}, nuclear: null, sources: [], failed: true }))
    .then(s => { security = s; if (S.sel?.kind === 'country') lateRender(); });
  return securityLoad;
}
// Photos of the armed forces and of equipment in service: data/security-photos.json from
// scripts/build_military_photos.py, fetched the first time the Security tab is shown; a failed load leaves them out.
let secPhotos = null, secPhotosLoad = null;
function loadSecPhotos() {
  secPhotosLoad ||= fetch('data/security-photos.json')
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .catch(() => ({ countries: {} }))
    .then(p => { secPhotos = p; if (S.sel?.kind === 'country') lateRender(); });
}
// A two-column grid with a caption under each photo, six shown, then "Show all".
const secPhotoGrid = (iso, g, list, key) => capped(list.map((p, i) => photoButton(iso, g, i, p, p.kind, `${p.title} · ${p.kind}`)), 6, 'div', 'photos secphotos', key);
const OWNER = { USA: 'US', RUS: 'Russian' };
const longDate = s => new Date(s + 'T00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Nuclear weapons held or hosted, and the NPT and TPNW. Treaty rows only for UN members and observers, the
// states build_security.py gives an NPT status.
function nuclearRows(iso) {
  const N = security?.nuclear;
  if (!N || !iso) return [];
  const armed = N.armed.find(x => x.iso === iso), host = N.hosts.find(x => x.iso === iso);
  const adj = host && (OWNER[host.owner] || host.owner);
  const weapons = [
    armed && `An estimated ${d3.format(',')(armed.warheads)} warheads <span class="yr">${esc(N.warheadsAsOf)}${armed.firstTest ? ` · first test ${armed.firstTest}` : ''}</span>`,
    host?.status === 'hosts' && `Hosts ${adj} weapons`,
    host?.status === 'possibly' && `Possibly hosts ${adj} weapons`,
    host?.status === 'claimed' && `${adj} weapons said to be deployed here, not confirmed <span class="yr">${esc(N.warheadsAsOf)}</span>`,
    N.sharing.includes(iso) && 'Takes part in NATO nuclear sharing',
    N.sharingContingency.includes(iso) && 'Takes part in NATO nuclear sharing on a contingency basis'
  ].filter(Boolean);
  const npt = N.npt.parties.includes(iso) ? 'Party' : N.npt.nonParties.includes(iso) ? 'Not a party'
    : N.npt.withdrew[iso] ? `Announced its withdrawal on ${longDate(N.npt.withdrew[iso])}` : null;
  const tpnw = npt && `${N.tpnw.parties.includes(iso) ? 'Party' : N.tpnw.signatories.includes(iso) ? 'Signed, not ratified' : 'Not a party'} <span class="yr">as of ${longDate(N.tpnw.asOf)}</span>`;
  return [['Weapons', weapons.join('<br>')], ['Non-Proliferation Treaty', npt], ['Ban treaty (TPNW)', tpnw]];
}
const FACTBOOK = [['forces', 'Forces'], ['personnel', 'Personnel'], ['equipment', 'Equipment'], ['service', 'Service'], ['deploy', 'Deployments']];
const sentence = s => cap(s).replace(/[^.!?)]$|[^.!?]\)$/, '$&.'); // "(VV)" gets its full stop, "(see above.)" does not
// The Security tab: spending, armed forces and arms trade (World Bank, from SIPRI and IISS), nuclear status,
// alliances, bases and hot spots, then the Factbook's own text, folded.
function securityHTML(d, a, ind) {
  if (!security) loadSecurity();
  if (!atlas || !security) return '<p class="empty">Loading…</p>';
  const iso = d.iso3, y0 = atlas.milYears?.[0] ?? 1990, m = a.mil || {};
  const last = s => { for (let i = (s?.length || 0) - 1; i >= 0; i--) if (s[i] != null) return [s[i], y0 + i]; return null; };
  const yv = (p, fmt) => p && `${fmt(p[0])} <span class="yr">${p[1]}</span>`;
  const xv = (k, fmt) => yv(a.x?.[k], fmt);
  const num = d3.format(',');
  const tiv = v => (v === 0 ? 'under 0.5' : num(v)) + ' million TIV'; // SIPRI's 0 stands for under half a million
  const out = [];

  const spend = [
    d.v?.mil && ind('mil'),
    ['In current US$', yv(last(m.usd), v => '$' + big(v * 1e6))],
    ['Share of government spending', xv('milGov', pct)]
  ].filter(r => r?.[1]);
  if (spend.length) out.push(dl(spend));
  // An all-zero series (Costa Rica, Iceland) has no line worth drawing; the rows above already say 0%.
  if (d3.max(m.gdp || []) > 0) {
    const since = sinceFrom(y0, m.gdp);
    out.push(`<h3>Military spending${since}, % of GDP</h3>${trendChart([{ name: d.name, cls: 's1', values: m.gdp }], pct, `Military spending of ${d.name}${since}, % of GDP`, 'Share of GDP', { start: y0, gaps: true })}`);
  }
  // A latest personnel figure of 0 follows years of real counts (Libya, Palestine): a gap in the estimates, not zero forces.
  const pers = last(m.pers);
  const forces = [['Personnel', pers?.[0] ? yv(pers, num) : null], ['Share of labour force', a.x?.milLab?.[0] ? xv('milLab', pct) : null]];
  if (S.tab === 'security') loadSecPhotos();
  const pics = secPhotos?.countries[iso] || {};
  const forcePics = pics.forces?.length ? secPhotoGrid(iso, 'forces', pics.forces, 'secForces') : '';
  if (forces.some(r => r[1]) || forcePics) out.push(`<h3>Armed forces</h3>${forces.some(r => r[1]) ? dl(forces) : ''}${forcePics}`);
  const trade = [['Imports', yv(last(m.imp), tiv)], ['Exports', yv(last(m.exp), tiv)]];
  if (trade.some(r => r[1])) {
    const lines = [{ name: 'Imports', cls: 's1', values: m.imp }, { name: 'Exports', cls: 's2', values: m.exp }];
    const since = sinceFrom(y0, m.imp, m.exp);
    // A trend needs ten years of transfers in one direction; a few scattered years read better as the rows alone.
    const chart = d3.max([...(m.imp || []), ...(m.exp || [])]) > 0 && d3.max([m.imp, m.exp], v => (v || []).filter(x => x != null).length) >= 10
      ? trendChart(lines, v => (v === 0 ? 'under 0.5' : num(v)) + 'M', `Arms imports and exports of ${d.name}${since}, million TIV`, 'Million TIV', { start: y0, tickFmt: num, gaps: true }) : '';
    out.push(`<h3>Arms trade${chart ? since : ''}</h3>${dl(trade)}${chart}<p class="note">TIV is SIPRI's trend-indicator value: it measures the volume of arms transferred, not what was paid.</p>`);
  }
  // A type's photo is often of another country's aircraft or ship, so the note says so.
  if (pics.equipment?.length) out.push(`<h3>Equipment in service</h3>${secPhotoGrid(iso, 'equip', pics.equipment, 'secEquip')}<p class="note">Each photo shows the type, not always this country's own.</p>`);
  const nuclear = nuclearRows(iso).filter(r => r[1]);
  if (nuclear.length) out.push(`<h3>Nuclear status</h3>${dl(nuclear)}`);

  const allied = kind => blocs.blocs.filter(b => b.security === kind && b.role.has(iso)).map(b => groupChip(b, iso));
  const alliances = [['Mutual defence', allied('defence')], ['Security cooperation', allied('partnership')]].filter(r => r[1].length);
  // Chip groups under small headings, not in a fact list: the value column is too narrow for a row of chips.
  if (alliances.length) out.push(`<h3>Alliances</h3>${alliances.map(([k, c]) => `<h4>${k}</h4><div class="chips">${c.join('')}</div>`).join('')}`);

  const bases = hot.items.filter(it => it.layer === 'base');
  const spots = [
    ['Bases it hosts', bases.filter(it => it.host === iso), 'secHosts'],
    ['Bases it operates', bases.filter(it => it.host !== iso && it.operator?.includes(iso)), 'secOps'],
    ['Conflicts and disputes', hot.items.filter(it => (it.layer === 'conflict' || it.layer === 'dispute') && it.countries.includes(iso)), 'secHot']
  ].filter(r => iso && r[1].length);
  if (spots.length) out.push(`<h3>Bases and hot spots</h3>${spots.map(([k, items, key]) => `<h4>${k}</h4>${capped(items.map(hotButton), 6, 'div', 'chips', key)}`).join('')}`);

  const fb = security.countries[iso] || {};
  const text = FACTBOOK.filter(([k]) => fb[k]).map(([k, label]) => {
    const e = fb[k], notes = [...(e.notes || []).map(sentence), e.year && `As of ${e.year}.`].filter(Boolean);
    return `<h4>${label}</h4><p>${esc(sentence(e.text)).replace(/\n/g, '<br>')}</p>${notes.length ? `<p class="note">${esc(notes.join(' '))}</p>` : ''}`;
  });
  // Folded like Height in People; opened when it is all there is (Greenland: "no regular military forces").
  if (text.length) out.push(`<details class="sect"${out.length ? '' : ' open'}><summary>Forces and service</summary>${text.join('')}</details>`);

  const failed = atlas.failed || security.failed ? NOT_LOADED : '';
  return out.length ? out.join('') + failed : failed || `<p class="empty">No security figures for ${esc(d.name)} in the sources used here.</p>`;
}
function countryHTML(f) {
  // "Region, income" with each part kept whole, so a narrow panel breaks at the comma, never inside
  // "upper middle income". Status gets its own line, only when it is not plain UN membership.
  const d = f.d;
  const sub = [d.region && `${d.region} (UN region)`, d.income && (d.region ? d.income[0].toLowerCase() + d.income.slice(1) : d.income)]
    .filter(Boolean).map(s => `<span class="nowrap">${esc(s)}</span>`).join(', ');
  // Map areas without a country record (Somaliland, Northern Cyprus) that the contested layer covers are named as such.
  const status = d.status ? d.status !== 'un' && STATUS[d.status] : contested.some(c => c.feature === f.key) && 'Disputed area';
  if (!atlas) loadAtlas();
  const a = atlas?.countries[d.iso3] || {};
  const wait = '<p class="empty">Loading…</p>';

  // A World Bank indicator row: value, year, and a rank that opens the ranked list.
  const ind = k => {
    const v = d.v?.[k], spec = info.indicators[k];
    if (!v) return [spec.name, '<span class="yr">No data</span>'];
    const value = spec.fmt === 'pct' ? pct(v[0]) + spec.note.slice(1) : FMT[spec.fmt](v[0]);
    const [r, n, tie] = rank(k, f.key);
    return [spec.name, `${value} <span class="yr">${v[1]}${r ? ` · <button type="button" class="rk" data-rank="${k}" title="Open the ranking">${tie ? 'joint ' : ''}${ordinal(r)} of ${n}</button>` : ''}</span>`];
  };
  const xv = (k, fmt, unit = '') => { const v = a.x?.[k]; return v ? `${fmt(v[0])}${unit} <span class="yr">${v[1]}</span>` : null; };
  const n1 = v => d3.format('.1~f')(v);

  const caps = a.caps
    ? a.caps.map(c => `${esc(c.name)} <span class="yr">${esc(c.type)}</span>${c.note ? `<br><span class="yr">${esc(c.note)}</span>` : ''}`).join('<br>')
    : d.capital && esc(d.capital);
  const names = [
    ['Official name', a.official && esc(a.official)],
    ['Native names', a.native?.length ? capped(a.native.map(([l, nm]) => `<li>${esc(nm)} <span class="yr">${esc(l)}</span></li>`), 3, 'ul', 'plain native', 'native') : null],
    ['Also called', a.also && esc(a.also.join(', '))],
    ['Demonym', a.demonym && esc(a.demonym)],
    [a.caps?.length > 1 ? 'Capitals' : 'Capital', caps],
    ['Status', esc(STATUS[d.status] || 'Map area')],
    ['Languages', a.lang && esc(a.lang.join(', '))],
    ['Currency', a.cur && a.cur.map(([c, nm, s]) => `${esc(nm)} <span class="yr">${esc(c)}${s ? ' ' + esc(s) : ''}</span>`).join('<br>')],
    ['ISO codes', a.a2 && `${esc(a.a2)} · ${esc(d.iso3)}${a.num ? ' · ' + esc(a.num) : ''}`],
    ['Olympic code', a.ioc && esc(a.ioc)],
    ['Calling code', a.call && esc(a.call.join(', '))],
    ['Internet domain', a.tld && esc(a.tld.join(', '))],
    ['Drives on the', a.drive]
  ];

  const years = atlas?.years || [];
  // Life expectancy in one row: the total with its rank, then men and women (their year only when it differs).
  const life = ind('life'), [lm, lf] = [a.x?.lifeM, a.x?.lifeF];
  if (lm || lf) {
    const sexYear = (lm || lf)[1], lifeYear = d.v?.life?.[1];
    life[1] += `<br><span class="yr">${[lm && `men ${n1(lm[0])}`, lf && `women ${n1(lf[0])}`].filter(Boolean).join(' · ')}${sexYear !== lifeYear ? `, ${sexYear}` : ''}</span>`;
  }
  const people = [
    ind('pop'),
    ['Growth', xv('growth', pct, ' a year')],
    ['Urban', xv('urban', pct)],
    life,
    ['Fertility', xv('fert', v => d3.format('.2~f')(v), ' births per woman')],
    ['Births', xv('birth', n1, ' per 1,000 people')],
    ['Deaths', xv('death', n1, ' per 1,000 people')],
    ['Infant deaths', xv('infant', n1, ' per 1,000 births')]
  ];
  const economy = [
    ind('gdp'), ind('gdppc'),
    ['GDP at PPP', xv('ppp', v => '$' + big(v))],
    ['GDP growth', xv('gdpGrowth', pct)],
    ['Inflation', xv('infl', pct)],
    ['Unemployment', xv('unemp', pct)],
    ind('mil'), ind('fuel'),
    ['Internet use', xv('net', pct, ' of people')],
    ['Gini index', xv('gini', n1)]
  ];
  const noFigures = !d.v ? `<p class="note">The World Bank publishes no figures for ${esc(d.name)}.</p>` : '';
  // 100% bars use only a year every share has (built by build_atlas.py); without one, the shares are
  // listed separately, each with its own year, so figures from different years are never added up.
  const mix = (key, labels, keys, rest, label) => {
    const m = a[key];
    if (m) return { year: m[0], html: mixBar(labels.map((l, i) => [l, m[i + 1]]), rest, label) };
    const rows = labels.map((l, i) => [l, xv(keys[i], pct)]).filter(r => r[1]);
    return { year: null, html: rows.length ? dl(rows) : '<p class="empty">No data</p>' };
  };
  const sector = mix('sec', ['Agriculture', 'Industry', 'Services'], ['agri', 'ind', 'serv'], 'Taxes and other', 'Share of GDP by sector');
  const power = mix('elec', ['Fossil fuels', 'Nuclear', 'Renewables'], ['fossil', 'nuc', 'ren'], 'Other or not reported', 'Electricity by source');

  // Places with no World Bank figures at all (Antarctica, Somaliland) get the one sentence, not a run of "No data".
  const bare = !d.v && !a.x && !a.pop && !a.gdp;
  // atlas.json failed: keep the figures that came with the map, and say the rest did not load (not "No data").
  const extras = d.iso3 ? peopleExtras(d) : '';
  const peoplePanel = !atlas ? wait : atlas.failed ? `${noFigures}${d.v ? dl(people) : ''}${NOT_LOADED}${extras}` : bare ? (noFigures || (extras ? '' : '<p class="empty">No figures in the sources used here.</p>')) + extras : `${noFigures}${dl(people)}
    <h3>Population${sinceYear(a.pop)}</h3>${trendChart([{ name: d.name, cls: 's1', values: a.pop }], big, `Population of ${d.name}${sinceYear(a.pop)}`, 'Population')}
    <h3>Age and sex</h3>${a.pyr ? pyramidChart(a.pyr, a.pyrYear) : '<p class="empty">No data</p>'}${extras}`;
  const economyPanel = !atlas ? wait : atlas.failed ? `${noFigures}${d.v ? dl(economy) : ''}${NOT_LOADED}` : bare ? (noFigures || '<p class="empty">No figures in the sources used here.</p>') : `${noFigures}${dl(economy)}
    <h3>GDP${sinceYear(a.gdp)}, current US$</h3>${trendChart([{ name: d.name, cls: 's1', values: a.gdp?.map(v => (v == null ? null : v * 1e6)) }], v => '$' + big(v), `GDP of ${d.name}${sinceYear(a.gdp)}`, 'GDP')}
    <h3>Economy by sector${sector.year ? `, ${sector.year}` : ''}</h3>${sector.html}
    <h3>Electricity by source${power.year ? `, ${power.year}` : ''}</h3>${power.html}
    <p class="note">Renewables include hydropower.</p>`;

  const e = edges(f);
  const landlocked = d.landlocked ?? e.coast === 0;
  const ap = antipode(f.anchor);
  const apOn = features.find(g => inBounds(g.bounds, ap) && d3.geoContains(g, ap));
  const antiOn = S.anti?.name === d.name;
  const geo = [
    ['Area', d.area ? areaText(d.area) : null],
    ['Hemispheres', hemispheres(f)],
    ['Sea access', atlas?.failed && landlocked ? null : landlocked ? (a.doubly ? 'Doubly landlocked: every neighbour is landlocked too' : 'Landlocked') + (e.coast > 50 ? `; ${km(e.coast)} of shore on inland seas` : '') : `${km(e.coast)} of coastline`],
    ['Land borders', e.land > 0 ? `${km(e.land)} with ${neighbours(f).length} ${neighbours(f).length === 1 ? 'neighbour' : 'neighbours'}` : 'None'],
    ['Antipode', `${latText(ap[1])}, ${lngText(ap[0])}, ${apOn ? `in ${esc(apOn.d.name)}` : 'in the ocean'}
      <br><button type="button" class="rk" data-anti="${f.i}" aria-pressed="${antiOn}">${antiOn ? `Back to ${esc(d.name)}` : 'Show on the globe'}</button>`],
    ['Forest cover', xv('forest', pct, ' of land')],
    ['CO₂ per person', xv('co2', n1, ' tonnes')]
  ].filter(r => r[1]);
  for (const a of contested) {
    if (a.feature === f.key) geo.push(['Status', esc(contestText(a))]);
    else {
      if (d.iso3 && a.holder === d.iso3) geo.push(['Holds', esc(a.note ? `${a.name}. ${a.note}` : `${a.name}, claimed by ${a.claimed}`)]);
      if (d.iso3 && a.claimant === d.iso3) geo.push(['Claims', esc(`${a.name}, held by ${a.held}`)]);
    }
  }
  const lengthsNote = contested.find(a => a.lengthsNote && (a.feature === f.key || (d.iso3 && a.holder === d.iso3)))?.lengthsNote;
  const nbs = neighbours(f);

  const groups = blocs.blocs.filter(b => b.role.has(d.iso3)).map(b => groupChip(b, d.iso3));
  const places = hot.items.filter(it => it.countries.includes(d.iso3));

  // Disputes this country is party to that no visible place chip already covers (Serbia's claim on Kosovo,
  // Somalia's on Somaliland); Crimea, Taiwan and Kashmir are left to their chips. Only the first six chips
  // count, since the rest sit behind "Show all".
  const chipped = new Set(places.slice(0, 6));
  const disputes = [];
  for (const c of contested) {
    if (c.hot && chipped.has(hotById.get(c.hot))) continue;
    if (c.feature === f.key) disputes.push(esc(contestText(c)));
    else {
      if (d.iso3 && c.holder === d.iso3) disputes.push(`Holds ${esc(c.name)}${c.claimed ? `, claimed by ${esc(c.claimed)}` : ''}`);
      if (d.iso3 && c.claimant === d.iso3) disputes.push(`Claims ${esc(c.name)}, held by ${esc(c.held)}`);
    }
  }

  const prof = profilePanels(d);
  const links = (groups.length ? `<h3>Groups</h3><div class="chips">${groups.join('')}</div>` : '') +
    (places.length ? `<h3>Places on the map</h3>${capped(places.map(hotButton), 6, 'div', 'chips', 'places')}` : '') +
    (disputes.length ? `<h3>Disputes</h3><ul class="plain lines">${disputes.map(t => `<li>${t}</li>`).join('')}</ul>` : '');
  // Overview order: summary and key facts, leaders and system, groups and places, photos, then the other names and codes.
  const KEY_FACTS = ['Official name', 'Capital', 'Capitals', 'Languages', 'Currency'];
  const facts = names.filter(r => KEY_FACTS.includes(r[0]) && r[1]), codes = names.filter(r => !KEY_FACTS.includes(r[0]));
  // No "Names and codes" heading over a section holding only the status.
  const hasNames = codes.some(r => r[1] && r[0] !== 'Status');
  const panels = {
    overview: symbolsHTML(d) + prof.overview + (facts.length ? `<h3>Key facts</h3>${dl(facts)}` : '') +
      (prof.leaders ? `<h3>Leaders and system</h3>${prof.leaders}` : '') + links + photosHTML(d) +
      (atlas?.failed ? NOT_LOADED : atlas && hasNames ? `<details class="sect"><summary>Names and codes</summary>${dl(codes)}</details>` : ''),
    people: peoplePanel,
    economy: economyPanel,
    institutions: prof.institutions,
    security: securityHTML(d, a, ind),
    religion: prof.religion,
    divisions: prof.divisions,
    geography: `${dl(geo)}${atlas?.failed ? NOT_LOADED : ''}<p class="note">Lengths are measured on a 1:50m map and usually come out shorter than official figures.${lengthsNote ? ' ' + esc(lengthsNote) : ''}</p>
      ${nbs.length ? `<h3>Neighbours</h3><div class="chips">${nbs.map(countryButton).join('')}</div>` : ''}`
  };

  // The key figures as one line under the subtitle; People and Economy give their years.
  const keyline = [d.capital && esc(d.capital), d.v?.pop && `${big(d.v.pop[0])} people`, d.v?.gdppc && `${FMT.usd(d.v.gdppc[0])} per person`].filter(Boolean).join(' · ');
  return `
    ${history.state?.fromList ? '<p class="backrow"><button type="button" class="rk" data-back="1">Back to the list</button></p>' : ''}
    <h2 id="infoTitle" tabindex="-1">${esc(d.name)}</h2>
    ${sub || status ? `<p class="sub">${sub}${sub && status ? '<br>' : ''}${status ? esc(status) : ''}</p>` : ''}
    ${keyline ? `<p class="keyline">${keyline}</p>` : ''}
    ${ghostLine(f)}
    <div class="acts">
      ${d.iso3 ? `<button type="button" data-compare="${f.i}">Compare</button>` : ''}
      <button type="button" data-ghost="${f.i}" aria-pressed="${S.ghost?.f === f}">${S.ghost?.f === f ? 'Hide true size' : 'True size'}</button>
    </div>
    <div class="tabs" role="tablist" aria-label="Country details">${TAB_EDGE(-1)}
      ${TABS.map(([id, label]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${S.tab === id}" tabindex="${S.tab === id ? 0 : -1}"><span>${label}${/^\s*<p class="(?:empty|note)">(?!Loading)[^<]*<\/p>\s*$/.test(panels[id]) ? '<span class="sr">, nothing to show</span>' : ''}</span></button>`).join('')}${TAB_EDGE(1)}
    </div>
    ${TABS.map(([id]) => `<div role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" tabindex="0"${S.tab === id ? '' : ' hidden'}>${panels[id]}</div>`).join('')}`;
}

// A point on the map: what the current map type says there, its height or depth, and the country it is in.
// Four decimals (about 11 m), five (about 1 m) once a pixel is under about 10 m, so neighbouring houses differ.
const decimals = () => (S.k > 2000 ? 5 : 4);
const latLonText = ([lon, lat]) => `${Math.abs(lat).toFixed(decimals())}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(decimals())}° ${lon >= 0 ? 'E' : 'W'}`;
// The 1:10m shapes once loaded (1:50m drops small islands such as Manhattan), then the 1:50m ones.
const inHi = (f, ll) => f.hi?.some(p => d3.geoDistance(p.cap.c, ll) <= p.cap.r && d3.geoContains({ type: 'Polygon', coordinates: p.c }, ll));
const countryAt = ll => (hiMap && features.find(f => inHi(f, ll))) || features.find(f => inBounds(f.bounds, ll) && d3.geoContains(f, ll)) || null;
function pointAt(at, country, feature = null) {
  const lon = ((at[0] + 540) % 360) - 180, lat = Math.max(-90, Math.min(90, at[1]));
  return { at: [lon, lat], country, feature, id: `@${lat.toFixed(decimals())},${lon.toFixed(decimals())}`, rows: null, map: null };
}
// Reads the map at the point once per map type; the panel re-renders when the answers arrive.
function readPoint(o) {
  const mt = mapType(S.map);
  if (o.map === mt.id) return;
  o.map = mt.id; o.rows = null; o.more = '';
  // A map type may name what stands at the point (Airports: the airport), so a click beside its marker or a link
  // opens it as a picked feature: its title, and its own position in the address. The reads below wait for it.
  const named = !mt.featureAt ? Promise.resolve() : Promise.resolve().then(() => mt.featureAt(o.at)).catch(() => null).then(f => {
    if (o.map !== mt.id || !f) return;
    const p = pointAt(f.at, o.country);
    Object.assign(o, { at: p.at, id: p.id, feature: { ...o.feature, ...f, rows: o.feature?.rows || [] } });
    if (S.sel?.obj !== o) return;
    history.replaceState(history.state, '', urlFor(hashFor('point', o)));
    renderInfo(); draw();
  });
  const height = named.then(() => elevationAt(o.at[0], o.at[1]))
    // Under a clicked quake, volcano or airport the row names the ground, so it is not read as the feature's own height or depth.
    .then(m => [[o.feature ? (m < 0 ? 'Sea floor below' : 'Ground below') : m < 0 ? 'Depth' : 'Height', m < 0 ? `${(-m).toLocaleString('en')} m below sea level` : `${m.toLocaleString('en')} m above sea level`]])
    .catch(() => []);
  const here = named.then(() => (mt.query ? mt.query(o.at, overlayApi(center())) : []))
    .catch(e => { console.warn(e); return [['Map data', 'Did not load. Try again in a moment.']]; });
  // A map type may add slower parts under the facts (Airports: the view from above, photos, a summary).
  if (mt.more) named.then(() => mt.more(o.at, overlayApi(center()))).catch(e => { console.warn(e); return ''; })
    .then(m => { if (o.map !== mt.id || !m) return; o.more = m; if (S.sel?.obj === o && o.rows) renderInfo(); });
  // The map's facts show as soon as they are read; the height row keeps its line until the terrain tile comes, so
  // nothing under it moves then.
  here.then(a => {
    if (o.map !== mt.id || o.rows) return;
    o.rows = [...(a || []), [o.feature ? 'Ground below' : 'Height', 'Reading…']];
    if (S.sel?.obj === o) renderInfo();
  });
  Promise.all([here, height]).then(([a, b]) => {
    if (o.map !== mt.id) return;
    o.rows = [...(a || []), ...b];
    if (S.sel?.obj === o) renderInfo();
  });
}
function pointHTML(o) {
  readPoint(o);
  const f = o.feature;
  const rows = [...(f?.rows || []), ...(o.rows || [])];
  return `
    <h2 id="infoTitle" tabindex="-1">${f ? esc(f.title) : latLonText(o.at)}</h2>
    <p class="sub">${f ? `${f.sub ? esc(f.sub) + '<br>' : ''}${latLonText(o.at)}` : o.country ? `In ${esc(o.country.d.name)}` : 'At sea'}</p>
    ${ghostLine(null)}
    ${rows.length ? dl(rows) : ''}${o.rows ? o.more || '' : '<p class="empty">Reading the map here…</p>'}
    ${o.country && o.country.d.iso3 ? `<div class="chips"><button type="button" data-f="${o.country.i}">Open ${esc(o.country.d.name)}</button></div>` : ''}`;
}

// Head-to-head: two countries' figures side by side, their trends on shared axes, and their areas.
// Each getter returns [value, year] (area has no year), so the table can show how current each figure is.
const XY = (f, k) => atlas?.countries[f.d.iso3]?.x?.[k];
const CMP_ROWS = [
  ['Population', f => f.d.v?.pop, big],
  ['Area, km²', f => (f.d.area ? [f.d.area, null] : null), v => areaNum(v)], // units in the labels: two 8-digit areas do not fit a phone
  ['GDP', f => f.d.v?.gdp, v => '$' + big(v)],
  ['GDP per person', f => f.d.v?.gdppc, FMT.usd],
  ['Life expectancy, years', f => f.d.v?.life, v => d3.format('.1~f')(v)],
  ['Fertility', f => XY(f, 'fert'), v => d3.format('.2~f')(v)],
  ['Urban', f => XY(f, 'urban'), pct],
  ['Unemployment', f => XY(f, 'unemp'), pct],
  ['Inflation', f => XY(f, 'infl'), pct],
  ['Military spending, % of GDP', f => f.d.v?.mil, v => d3.format('.1~f')(v)],
  ['Internet use', f => XY(f, 'net'), pct],
  ['Forest cover', f => XY(f, 'forest'), pct],
  ['CO₂ per person, t', f => XY(f, 'co2'), v => d3.format('.1~f')(v)]
];


function compareHTML(o) {
  if (!atlas) loadAtlas();
  const A = o.a, B = o.b;
  const opts = [...byIso.values()].filter(f => f !== A && f.d.iso3 && inScope(f)).sort((p, q) => p.d.name.localeCompare(q.d.name))
    .map(f => `<option value="${f.d.iso3}"${f === B ? ' selected' : ''}>${esc(f.d.name)}</option>`).join('');
  const head = `
    <h2 id="infoTitle" tabindex="-1">${B ? `${esc(A.d.name)} and ${esc(B.d.name)}` : `Compare ${esc(A.d.name)}`}</h2>
    <p class="sub"><button type="button" class="link" data-f="${A.i}">Back to ${esc(A.d.name)}</button></p>
    ${ghostLine(null)}
    <label for="cmpB" class="field">With</label>
    ${B ? '' : `<p class="note hint-line">Or ${coarse ? 'tap' : 'click'} a country on the globe, or search for it.</p>`}
    <div class="pick"><select id="cmpB"><option value="">Choose a country</option>${opts}</select>
      ${B ? '<button type="button" data-swap="1">Swap</button>' : ''}</div>`;
  if (!B) return head;
  if (!atlas) return head + '<p class="empty">Loading…</p>';

  let stale = false;
  // The year most figures share is said once, in the corner; a cell prints its year only when it differs.
  const year = d3.mode(CMP_ROWS.flatMap(([, get]) => [get(A)?.[1], get(B)?.[1]]));
  const rows = CMP_ROWS.map(([label, get, fmt]) => {
    const [va, ya] = get(A) || [], [vb, yb] = get(B) || [];
    if (va == null && vb == null) return '';
    const max = Math.max(Math.abs(va ?? 0), Math.abs(vb ?? 0)) || 1;
    // Years more than two apart are not a fair head-to-head: show both years and no bars.
    const apart = ya && yb && Math.abs(ya - yb) > 2;
    // A negative value (inflation) gets no bars either, since a bar's length cannot show direction;
    // nor does a row with one figure missing, where a lone full bar would compare nothing.
    const both = va != null && vb != null, bars = both && !(va < 0 || vb < 0) && !apart;
    stale ||= both && !bars;
    // Each value carries its own bar, scaled to the larger of the two, so the bars read as magnitudes.
    const cell = (v, y, cls) => `<td class="num">${v == null ? '–' : `${fmt(v)}${y && (y !== year || apart) ? ` <span class="yr${apart ? ' apart' : ''}">${y}</span>` : ''}${bars && v ? `<span class="vb"><i class="${cls}" style="width:${Math.max(2, (v / max) * 100)}%"></i></span>` : ''}`}</td>`;
    return `<tr><th scope="row">${esc(label)}</th>${cell(va, ya, 's1')}${cell(vb, yb, 's2')}</tr>`;
  }).join('');
  const ratio = A.d.area && B.d.area ? A.d.area / B.d.area : null;
  // Percentages up to "about twice", then "N times" from the figure that would round to 2.
  const n = v => d3.format(',.2~r')(v);
  const sized = r => (Math.abs(r - 1) < 0.005 ? `${esc(A.d.name)} and ${esc(B.d.name)} are about the same size.`
    : r >= 1.995 ? `${esc(A.d.name)} is ${n(r)} times the size of ${esc(B.d.name)}.`
    : r <= 1 / 1.995 ? `${esc(B.d.name)} is ${n(1 / r)} times the size of ${esc(A.d.name)}.`
    : `${esc(A.d.name)} is ${n(Math.abs(r - 1) * 100)}% ${r > 1 ? 'larger' : 'smaller'} than ${esc(B.d.name)}.`);
  const a = atlas.countries[A.d.iso3] || {}, b = atlas.countries[B.d.iso3] || {};
  const gdp = v => (v == null ? null : v * 1e6);
  return head + `
    <table class="rank cmp">
      ${year ? `<caption class="yr">${year}, unless a cell shows another year</caption>` : ''}
      <thead><tr><th scope="col"><span class="sr">Measure</span></th>
        <th scope="col" class="num"><i class="sw s1"></i>${esc(A.d.name)}</th>
        <th scope="col" class="num"><i class="sw s2"></i>${esc(B.d.name)}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${stale ? '<p class="note">Rows with both figures but no bars compare years more than two apart, or include a negative value.</p>' : ''}
    ${ratio ? `<p>${sized(ratio)}</p>
      <div class="chips"><button type="button" data-over="${B.i}">Lay ${esc(A.d.name)} over ${esc(B.d.name)}</button></div>` : ''}
    ${atlas.failed ? NOT_LOADED : `<h3>Population${sinceYear(a.pop, b.pop)}</h3>
    ${trendChart([{ name: A.d.name, cls: 's1', values: a.pop }, { name: B.d.name, cls: 's2', values: b.pop }], big, `Population of ${A.d.name} and ${B.d.name}${sinceYear(a.pop, b.pop)}`)}
    <h3>GDP${sinceYear(a.gdp, b.gdp)}, current US$</h3>
    ${trendChart([{ name: A.d.name, cls: 's1', values: a.gdp?.map(gdp) }, { name: B.d.name, cls: 's2', values: b.gdp?.map(gdp) }], v => '$' + big(v), `GDP of ${A.d.name} and ${B.d.name}${sinceYear(a.gdp, b.gdp)}`)}`}`;
}

function hotHTML(it) {
  const layer = layerById.get(it.layer);
  return `
    <p class="kind">${shapeIcon(it.layer)}${esc(layer.name)}</p>
    <h2 id="infoTitle" tabindex="-1">${esc(it.name)}</h2>
    ${it.asOf ? `<p class="sub">As of ${esc(it.asOf)}</p>` : ''}
    ${ghostLine(null)}
    <p>${esc(it.text)}</p>
    <h3>Countries involved</h3>
    <div class="chips">${it.countries.map(iso => countryButton(byIso.get(iso))).join('')}</div>`;
}

// The map colours as a sortable table: the same data without relying on colour, and a ranking to scan.
function listHTML(o) {
  const m = S.mode, all = [...byIso.values()].filter(inScope);
  let title, head, rows;
  if (info.indicators[m]) {
    const ind = info.indicators[m];
    title = ind.name; head = ind.note || 'Value';
    const fmt = ind.fmt === 'usd' ? x => '$' + d3.format(',.0f')(x) : FMT[ind.fmt]; // one style down the column
    rows = all.filter(f => f.d.v?.[m]).map(f => ({ f, v: f.d.v[m][0], label: fmt(f.d.v[m][0]), sub: f.d.v[m][1], rank: rank(m, f.key)[0], tie: rank(m, f.key)[2] }));
  } else if (m === 'income') {
    title = 'Income group'; head = 'Group';
    rows = all.filter(f => f.d.income).map(f => ({ f, v: INCOMES.indexOf(f.d.income), label: f.d.income }));
  } else {
    const b = blocById.get(m);
    title = b.name; head = 'Status';
    const also = new Set(b.also || []);
    rows = [...b.role].map(([iso, role]) => ({ f: byIso.get(iso), role, iso })).filter(r => r.f && r.f.d.iso3 && inScope(r.f))
      .map(({ f, role, iso }) => ({ f, v: role === 'member' && !also.has(iso) ? 1 : 0, label: also.has(iso) ? 'Through a member' : role === 'member' ? 'Member' : b.partnerRole }));
  }
  const isData = !!info.indicators[m];
  const sort = o.sort === 'asc' && !isData ? 'value' : o.sort || 'value';
  const byName = sort === 'name', ranked = isData && !byName, dir = sort === 'asc' ? -1 : 1;
  rows.sort(byName ? (a, b) => a.f.d.name.localeCompare(b.f.d.name) : (a, b) => dir * (b.v - a.v) || a.f.d.name.localeCompare(b.f.d.name));
  const who = S.scope === 'un' ? 'UN members' : 'countries and territories';
  const counted = isData || m === 'income' ? `${rows.length} of ${all.length} ${who} have ${isData ? 'data' : 'a World Bank income group'}` : `${rows.length} ${who}`;
  // The year most rows share goes in the column header; a row prints its year only when it differs.
  const year = d3.mode(rows.map(r => r.sub));
  const sorts = isData ? [['value', 'Highest first'], ['asc', 'Lowest first'], ['name', 'By name']] : [['value', 'By group'], ['name', 'By name']];
  // Each row carries its colour on the map, so the list doubles as a key to it.
  const fill = colourMode() === 'none' ? null : fillFor();
  const sw = f => (fill ? `<i class="sw" style="background:${fill(f)}" aria-hidden="true"></i>` : '');
  return `
    ${o.from ? `<p class="backrow"><button type="button" class="rk" data-back="1">Back to ${esc(o.from.d.name)}</button><span class="what">${esc(title)}${year ? `, ${year}` : ''}</span></p>` : ''}
    <h2 id="infoTitle" tabindex="-1">${esc(title)}, by country</h2>
    ${ghostLine(null)}
    <p class="sub">${counted}${isData && rows.some(r => !r.rank) ? `. Ranks count the ${rank(m, '')[1]} ${S.scope === 'un' ? 'UN members' : 'sovereign states'} with data.` : ''}</p>
    <div class="bars2">
      <div class="sortbar" role="group" aria-label="Sort the list">
        ${sorts.map(([k, t]) => `<button type="button" data-sort="${k}" aria-pressed="${sort === k}">${t}</button>`).join('')}
      </div>
      <div class="sortbar" role="group" aria-label="Countries">
        <button type="button" data-scope="all" aria-pressed="${S.scope === 'all'}">All</button>
        <button type="button" data-scope="un" aria-pressed="${S.scope === 'un'}">UN members</button>
      </div>
    </div>
    <table class="rank" aria-labelledby="infoTitle">
      <thead><tr>${ranked ? '<th scope="col" class="num">Rank</th>' : ''}<th scope="col">Country</th><th scope="col" class="num">${esc(head)}${year ? `, ${year}` : ''}</th></tr></thead>
      <tbody>${rows.map(r => `<tr${o.focus && r.f.d.iso3 === o.focus ? ' class="hl" id="rowFocus"' : ''}>${ranked ? `<td class="num">${r.rank ? r.rank + (r.tie ? '=' : '') : '–'}</td>` : ''}
        <td><button type="button" class="link" data-f="${r.f.i}">${esc(r.f.d.name)}</button></td>
        <td class="num">${sw(r.f)}${esc(r.label)}${r.sub && r.sub !== year ? ` <span class="yr">${r.sub}</span>` : ''}</td></tr>`).join('')}</tbody>
    </table>`;
}

// While comparing, the search box picks the second country. Phones get the short forms, which fit at 360px.
function setPlaceholder() {
  $('#q').placeholder = S.sel?.kind === 'compare' ? (narrow() ? 'Compare with…' : `Compare ${S.sel.obj.a.d.name} with…`)
    : S.w < 330 ? 'Search' : narrow() ? 'Country or place' : 'Find a country or place';
}

// Data that arrives during a flight fills the panel when the globe lands: re-rendering it mid-flight drops frames on phones.
const lateRender = () => { if (S.flying) S.late = true; else renderInfo(); };
let lastShown = null;
function renderInfo() {
  const box = $('#info');
  box.classList.toggle('country', S.sel?.kind === 'country' || S.sel?.kind === 'compare');
  setPlaceholder();
  if (!S.sel) {
    // The phone sheet slides away: a copy of it does, as the panel itself goes at once and the globe takes the room.
    if (!box.hidden && narrow() && !still()) {
      const copy = box.cloneNode(true);
      copy.inert = true; copy.setAttribute('aria-hidden', 'true');
      // shortcut: the copy keeps the ids so the panel's id-based styles still apply; it comes after the panel, so
      // getElementById and label references find the real one, and it is gone in 120 ms. A class-based panel style would end that.
      box.after(copy); copy.scrollTop = box.scrollTop;
      copy.animate([{ transform: 'none' }, { transform: 'translateY(100%)' }], { duration: DUR_0, easing: 'ease-in' }).onfinish = () => copy.remove();
    }
    box.hidden = true;
    box.classList.remove('tall');
    $('#grab').setAttribute('aria-expanded', 'false');
    lastShown = null;
    document.title = 'Borderline Interesting';
    return;
  }
  // Re-rendering replaces the panel's buttons; keep keyboard focus on the same control.
  const a = document.activeElement;
  const data = ['mode', 'sort', 'scope', 'anti', 'ghost', 'over', 'key', 'back', 'rank', 'f'].find(k => a.dataset?.[k]);
  const was = box.contains(a) && a !== $('#close')
    ? (data ? `[data-${data}="${a.dataset[data]}"]` : a.id ? '#' + a.id : '#infoTitle') : null;
  const k = S.sel.kind;
  // Redrawing the same country, comparison or place (a group chip, true size, a late data load) keeps its
  // scroll position, expanded lists and open sections. A new item, or a re-sorted list, starts at the top.
  const keep = S.sel.obj === lastShown && k !== 'list' ? {
    scroll: box.scrollTop,
    more: [...box.querySelectorAll('button.more[aria-expanded="true"]')].map(b => b.dataset.key),
    open: [...box.querySelectorAll('#infoBody details')].map(d => d.open)
  } : null;
  if (!keep) box.style.minHeight = ''; // a new item starts at its own height (setTab)
  CHARTS.clear();
  $('#infoBody').innerHTML = k === 'country' ? countryHTML(S.sel.obj) : k === 'list' ? listHTML(S.sel.obj)
    : k === 'compare' ? compareHTML(S.sel.obj) : k === 'point' ? pointHTML(S.sel.obj) : hotHTML(S.sel.obj);
  document.title = `${$('#infoTitle').textContent} - Borderline Interesting`; // history, bookmarks and open tabs can be told apart
  if (box.hidden) {
    box.hidden = false;
    // Opening: the phone sheet rises from the bottom edge, the side panel settles in as a tab does.
    if (narrow() && !still()) box.animate([{ transform: 'translateY(100%)' }, { transform: 'none' }], { duration: DUR_2, easing: EASE });
    else enter([box]);
  }
  tabStrip();
  if (keep) {
    for (const key of keep.more) {
      const b = $(`#infoBody button.more[data-key="${key}"]`);
      if (b) { b.previousElementSibling.classList.remove('capped'); b.setAttribute('aria-expanded', 'true'); b.textContent = 'Show fewer'; }
    }
    const ds = box.querySelectorAll('#infoBody details');
    if (ds.length === keep.open.length) ds.forEach((d, i) => { d.open = keep.open[i]; });
    box.scrollTop = keep.scroll;
  } else {
    box.scrollTop = 0;
    $('#rowFocus')?.scrollIntoView({ block: 'center' });
  }
  lastShown = S.sel.obj;
  if (was) ($('#infoBody ' + was) || $('#infoTitle'))?.focus({ preventScroll: true });
  writeCredit(); // a type's onMap can follow the panel (Airports: EOX's credit while a view from above is in it)
}

function setTab(id, focus) {
  const changed = id !== S.tab;
  S.tab = id;
  if (id === 'security') loadSecPhotos(); // redraws the panel when the photos arrive
  // Beside the globe the panel keeps the tallest height it has had for this country, so it does not jump between tabs.
  // (The phone sheet has a set height.)
  const box = $('#info');
  if (!narrow()) box.style.minHeight = box.offsetHeight + 'px';
  for (const [t] of TABS) {
    const tab = $(`#tab-${t}`), panel = $(`#panel-${t}`);
    if (!tab) return;
    tab.setAttribute('aria-selected', t === id);
    tab.tabIndex = t === id ? 0 : -1;
    panel.hidden = t !== id;
  }
  // A new tab starts at its top: if the panel was scrolled past the (pinned) tab row, bring the new
  // section's first rows up to just under it rather than leaving them hidden behind it.
  const tabs = box.querySelector('.tabs'), panel = $(`#panel-${id}`);
  if (tabs && panel) {
    const under = panel.getBoundingClientRect().top - tabs.getBoundingClientRect().bottom;
    if (under < 0) box.scrollTop += under - 12;
  }
  const tab = $(`#tab-${id}`);
  if (focus) tab.focus({ preventScroll: true });
  if (changed && panel) enter([panel]);
  tabStrip(true);
}
// The tab row is one strip that scrolls sideways when the eight tabs do not fit: the chosen tab goes to the middle,
// so its neighbours show on both sides, and a fade marks each edge with more tabs beyond it.
function tabStrip(smooth) {
  const t = $('#info .tabs'), tab = t?.querySelector('[aria-selected="true"]');
  if (!t) return;
  if (tab) t.scrollTo({ left: tab.offsetLeft - (t.clientWidth - tab.offsetWidth) / 2, behavior: smooth && !still() ? 'smooth' : 'instant' });
  tabEdges(t);
}
// The ends of the strip: a fade with a chevron, shown while more tabs lie that way; a click scrolls the strip.
const TAB_EDGE = dir => `<span class="edge" data-edge="${dir}" aria-hidden="true"><svg viewBox="0 0 10 10"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
function tabEdges(t) {
  t.classList.toggle('more-l', t.scrollLeft > 1);
  t.classList.toggle('more-r', t.scrollLeft < t.scrollWidth - t.clientWidth - 1);
}

// A rank badge opens the ranked list for that figure, scrolled to the country it came from.
function openRanking(k) {
  const from = S.sel?.kind === 'country' ? S.sel.obj : null;
  setMode(k);
  select('list', { id: 'list', sort: 'value', focus: from?.d.iso3, from, rank: k }, { focus: true });
}
// Close and Escape: a list opened from a country's rank goes back to that country, on the same rank.
function closePanel() {
  // A country opened from the ranked list goes back to the list, on the row it came from.
  if (S.sel?.kind === 'country' && history.state?.fromList) { history.back(); return; }
  const o = S.sel?.kind === 'list' ? S.sel.obj : null;
  if (!o?.from) return select(null);
  // The list's history entry sits right after its country's, so step back to it rather than stacking a copy;
  // popstate then puts focus on the rank link.
  if (history.state?.from === isoOf(o.from)) { S.backRank = o.rank; history.back(); return; }
  select('country', o.from, { fly: true });
  ($(`#infoBody [data-rank="${o.rank}"]`) || $('#infoTitle'))?.focus();
}
// A pick from the globe (click or Enter): while comparing, an eligible country becomes the second one.
function choose(p, opts = {}) {
  if (p?.kind === 'here' || p?.kind === 'feature') {
    const o = p.kind === 'here' ? pointAt(p.obj.at, p.obj.country) : pointAt(p.obj.at, countryAt(p.obj.at), p.obj);
    return select('point', o, opts);
  }
  const b = compareTarget(p?.kind, p?.obj);
  if (b) { if (b !== S.sel.obj.b) select('compare', { a: S.sel.obj.a, b }, opts); }
  else {
    // Touch has no tooltip: say why the tapped country opened on its own instead of joining the comparison.
    const why = S.sel?.kind === 'compare' && p?.kind === 'country' && p.obj !== S.sel.obj.a
      ? (!p.obj.d.iso3 ? 'has no figures to compare' : 'is not a UN member, so the UN members filter leaves it out of comparisons') : '';
    select(p?.kind, p?.obj, opts);
    if (why) $('#status').textContent = `${p.obj.d.name} ${why}.`; // select() clears the status line
  }
}
// While comparing, a country picked on the globe or in search becomes the second country.
const compareTarget = (kind, obj) =>
  S.sel?.kind === 'compare' && kind === 'country' && obj?.d.iso3 && obj !== S.sel.obj.a && inScope(obj) ? obj : null;

// True size: the outline stays in the middle of the view while the globe turns under it.
function startGhost(f, over) {
  // Remember the button that started it; the panel re-renders, so keep a selector rather than the element.
  const from = document.activeElement?.dataset || {};
  S.ghost = { f, lat: null, back: from.ghost ? `[data-ghost="${from.ghost}"]` : from.over ? `[data-over="${from.over}"]` : null };
  $('#ghostCard').hidden = false;
  hideHint();
  reRender();
  ghostReadout(center()); // fill the card first, so the globe's free band is measured with its real height
  if (narrow() && $('#info').classList.contains('tall')) { $('#info').classList.remove('tall'); $('#grab').setAttribute('aria-expanded', 'false'); } // the outline and card need the half-height sheet
  layoutChrome();
  // Zoom to fit the whole outline (Alaska and Hawaii too); moved, it keeps its distances, so the same zoom fits over another country.
  frame({ at: (over || f).coreAt, k: Math.min(S.k, fitK(ghostShape(f).geo, f.anchor)) });
  draw();
}
// Every panel shows or drops the true-size line; the panel keeps its scroll (lists otherwise start at the top).
function reRender() { if (!S.sel) return; const st = $('#info').scrollTop; renderInfo(); $('#info').scrollTop = st; }
function toggleGhost(f) { if (S.ghost?.f === f) endGhost(); else startGhost(f); }
let ghostTimer = 0;
function endGhost() {
  const back = S.ghost?.back;
  S.ghost = null;
  clearTimeout(ghostTimer);
  $('#ghostSay').textContent = '';
  $('#ghostCard').hidden = true;
  reRender();
  layoutChrome();
  if (!S.flying) frame(); // the card no longer limits the globe's band
  draw();
  // Back to the button that started it if this panel has it; otherwise focus stays in the panel, or goes to the globe.
  const t = back && $('#infoBody ' + back);
  if (t) t.focus({ preventScroll: true });
  else if (!$('#info').contains(document.activeElement)) canvas.focus({ preventScroll: true });
}
function ghostReadout(c) {
  const lat = Math.round(c[1]);
  if (S.ghost.lat === lat) return;
  S.ghost.lat = lat;
  const f = S.ghost.f, home = f.anchor[1], far = ghostShape(f).farShare;
  const x = v => d3.format('.2r')(mercator(v));
  // Full sentence on wide screens; phones and short screens get one line (style.css swaps them).
  // At its own latitude the two factors are the same, so say it once.
  const atHome = Math.round(home) === lat;
  const merc = atHome ? `A Mercator map would show it at ${x(lat)} times its true area here, at its own latitude (${latText(lat)}).`
    : `A Mercator map would show it at ${x(home)} times its true area at home (${latText(home)}) and ${x(lat)} times here (${latText(lat)}).`;
  const farNote = far > 0.005 ? ` Parts more than 6,500 km from its main body (${pct(far * 100)} of its area) are left out.` : '';
  $('#ghostText').innerHTML = `<span class="full"><strong>${esc(f.d.name)} at true size.</strong> Turn the globe to slide it over other places.
    <span class="yr">${merc}${farNote}</span></span>
    <span class="short"><strong>${esc(f.d.name)} at true size.</strong> On a Mercator map: ${x(lat)}× its real area here${atHome ? '' : `, ${x(home)}× at home`}.${far > 0.005 ? ' Overseas parts not shown.' : ''}</span>`;
  // Screen readers hear one short line once the globe stops turning, not one per degree.
  clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => { $('#ghostSay').textContent = `${f.d.name}: here at ${latText(lat)}, a Mercator map would show it at ${x(lat)} times its true area.`; }, 800);
}

function toggleAnti(f) {
  if (S.anti?.name === f.d.name) { S.anti = null; frame(view('country', f)); }
  else { S.anti = { at: antipode(f.anchor), name: f.d.name }; frame({ at: S.anti.at, k: Math.max(S.k, 2) }); }
  renderInfo();
  draw();
}

// `style` sets the no-data swatch's land and dots (the colouring key passes the globe's own); `cls` 'ord' keeps a
// figure's classes in one column.
function swatches(rows, style = '', cls = '') {
  return `<ul class="swatches${cls ? ' ' + cls : ''}"${style}>${rows.map(([c, t]) => `<li><i${c ? ` style="--c:${c}"` : ' class="nodata"'}></i>${esc(t)}</li>`).join('')}</ul>`;
}

function renderLegend() {
  const m = colourMode(), el = $('#legendCard'), mt = mapType(S.map);
  const key = mt.legend?.({ mode: m }) || '', hk = hotKey(), name = esc(label(mt));
  // A live feed's state goes in the title, which shows even while the Map section (and its status line) is closed.
  const st = mt.state?.() || '', says = st ? ': ' + st : '';
  // On phones and short screens the map's key starts folded, so it does not cover a third of the globe; a tap opens it.
  // There a colouring's key goes in the same fold, named in its one-line bar.
  const open = el.querySelector('details.maplegend')?.open ? ' open' : '';
  const both = m !== 'none' && (narrow() || S.h <= 500);
  const modeName = m === 'income' ? 'Income group' : info.indicators[m]?.name || blocById.get(m)?.name;
  // The Hot spots block closes every form of the key (hk): after the map's symbols, and after a colouring's in the fold.
  const mapPart = both ? `<details class="maplegend"${open}><summary><span>${key ? `${name}${says ? says + ', and ' : ' and '}${esc(modeName)}${says ? '' : ' key'}` : `${esc(modeName)} key${says}`}${keyLine(m)}</span></summary>${key}${modeLegend(m)}${hk}</details>`
    : !key && !hk ? '' : foldKey()
    ? `<details class="maplegend"${open}><summary>${!key ? 'Hot spots key' : says ? name + says : `${name}${hk ? ' and hot spots' : ''} key`}</summary>${key}${hk}</details>`
    : `<div class="maplegend">${key ? `<p><strong>${name}${says}</strong></p>${key}` : ''}${hk}</div>`;
  // A redraw (a live feed's state, a new colouring) replaces the card; keyboard focus stays on the same fold or button.
  const a = document.activeElement;
  const back = !el.contains(a) ? null : a.id ? '#' + a.id : a.matches('summary') ? `details.${a.parentElement.classList[0]} > summary` : null;
  if (m === 'none' || both) { el.hidden = !mapPart; el.innerHTML = mapPart; }
  else { el.innerHTML = `${modeLegend(m)}${mapPart}`; el.hidden = false; } // the colouring first: a long map key scrolls below it
  if (back) el.querySelector(back)?.focus({ preventScroll: true });
  if (!foldKey() && (key || hk) && stacked() && el.offsetHeight > 0.4 * S.h) { S.tallKey = true; renderLegend(); }
}

// A key that scrolls fades at the bottom until it is scrolled to the end, so the Hot spots block below is not missed.
function keyMore() {
  const el = $('#legendCard');
  el.classList.toggle('more-b', el.scrollHeight - el.scrollTop - el.clientHeight > 1);
}

// The colouring's scale in one line, for the folded key's bar on phones. Hidden from screen readers: the full key is
// in the fold, and the summary keeps a short name.
function keyLine(m) {
  const P = pal(), ramp = cs => `<span class="ramp">${cs.map(c => `<i style="--c:${c}"></i>`).join('')}</span>`;
  let h;
  if (info.indicators[m]) {
    const sc = scale(m), th = sc.domain(), f = FMT[info.indicators[m].fmt];
    h = `Under ${esc(f(th[0]))} ${ramp(sc.range())} ${esc(f(th.at(-1)))} and over`;
  } else if (m === 'income') h = `${INCOMES[0]} ${ramp(colors(4))} ${INCOMES[3]}`;
  else {
    const b = blocById.get(m), other = b.also ? 'Through a member' : b.partners ? b.partnerLabel : '';
    h = `${ramp([P.member])} Members${other ? ` ${ramp([P.partner])} ${esc(other)}` : ''}`;
  }
  return `<span class="kline" aria-hidden="true">${h}</span>`;
}

// The key for the colouring (a figure or a group): its title, Show as list and Clear, and the colours.
function modeLegend(m) {
  const clear = '<span class="lbtns"><button type="button" id="listMode">Show as list</button><button type="button" id="clearMode">Clear</button></span>';
  const P = pal(), land = ` style="--land:${P.land};--hatch:${P.hatch}"`;
  let head, body;
  if (info.indicators[m]) {
    const ind = info.indicators[m], sc = scale(m), th = sc.domain(), cs = sc.range();
    const f = FMT[ind.fmt];
    const rows = cs.map((c, i) => [c,
      i === 0 ? `Under ${f(th[0])}` : i === cs.length - 1 ? `${f(th[i - 1])} and over` : `${f(th[i - 1])} to ${f(th[i])}`]);
    head = `<p><strong>${esc(ind.name)}</strong>${ind.note ? ` <span>${esc(ind.note)}</span>` : ''}</p>`;
    body = swatches([...rows.reverse(), ...(features.some(missingFor()) ? [[null, 'No data']] : []), ...(S.scope === 'un' ? [[P.out, 'Not a UN member']] : [])], land, 'ord');
  } else if (m === 'income') {
    const cs = colors(4);
    head = '<p><strong>Income group</strong> <span>World Bank</span></p>';
    body = swatches([...INCOMES.map((t, i) => [cs[i], t]).reverse(), ...(features.some(missingFor()) ? [[null, 'Not classified']] : []), ...(S.scope === 'un' ? [[P.out, 'Not a UN member']] : [])], land, 'ord');
  } else {
    const b = blocById.get(m);
    const rows = [[P.member, `Members (${b.members.length})`]];
    if (b.also) rows.push([P.partner, `Through a member (${b.also.length})`]);
    if (b.partners) rows.push([P.partner, `${b.partnerLabel} (${b.partners.length})`]);
    if (S.scope === 'un') rows.push([P.out, 'Not a UN member']);
    head = `<p><strong>${esc(b.name)}</strong> <span>${b.full !== b.name ? esc(b.full) + ', ' : ''}since ${b.since}</span></p>`;
    body = `<p class="ltext">${esc(b.text)}</p>${swatches(rows)}`;
  }
  return `<div class="lhead">${head}${clear}</div>${body}`;
}

// A map type's control changed: its legend, any open point panel and the globe follow.
function refreshMapType() {
  if (S.sel?.kind === 'feature') select(null, null);
  syncTypeControls();
  renderLegend();
  layoutChrome();
  if (S.sel?.kind === 'point') { S.sel.obj.map = null; renderInfo(); }
  writeCredit(); // a type's onMap can follow what is on screen (the Photographic view and zoom)
  history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj))); // the type's settings, in place
  draw();
}

// The corner holds only what a licence requires on the map itself (mt.onMap); every source is listed in Sources.
// Links open a new tab.
const blank = s => s.replaceAll('<a ', '<a target="_blank" rel="noopener" ');
// Run every frame (render), so a credit that depends on the zoom comes and goes with its tiles; the DOM is touched
// only when the text changes.
let creditShown = null;
function writeCredit() {
  const o = mapType(S.map).onMap, html = blank((typeof o === 'function' ? o({ k: S.k }) : o) || '');
  if (html !== creditShown) $('#attrib').innerHTML = creditShown = html;
}

// The Sources section: the fixed lists in index.html, then every map type's credit (the 14 modules loaded later hold
// theirs, so all are fetched the first time the section opens), each hot spot's sources and the historical books.
let sourcesLoad = null;
function renderSources() {
  if (!$('#hotSources').childElementCount) {
    const byName = [...hot.items].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    $('#hotSources').innerHTML = byName.filter(it => it.sources?.length).map(it => `<li><span class="src-name">${esc(it.name)}</span><ul class="plain">${
      it.sources.map(s => `<li>${srcLink(s.title, s.url)}, ${esc(s.publisher)}</li>`).join('')}</ul></li>`).join('');
  }
  if (!$('#securitySources').childElementCount) {
    loadSecurity().then(() => {
      $('#secAsOf').textContent = security.asOf || '';
      $('#securitySources').innerHTML = security.sources.length
        ? security.sources.map(s => `<li>${srcLink(s.title, s.url)}, ${esc(s.publisher)}${s.date ? `, ${esc(s.date)}` : ''}</li>`).join('')
        : '<li>This list did not load. Reload the page to try again.</li>';
    });
  }
  if (!peopleData?.history) { // asked again on the next opening after a failed load
    loadPeople().then(() => {
      const list = peopleData?.history?.sources || [];
      $('#historySources').innerHTML = list.length ? list.map(s => `<li>${srcLink([s.author, s.year, s.title].filter(Boolean).join(', '), s.url)}</li>`).join('')
        : `<li>${peopleData?.failed ? 'This list did not load. Close and open Sources to try again.' : 'Not available.'}</li>`;
    });
  }
  if (sourcesLoad) return;
  $('#mapSources').innerHTML = '<p class="note">Loading map sources…</p>';
  sourcesLoad = Promise.all(MAP_TYPES.map(t => loadType(t.id))).then(() => {
    // A credit that names what is on screen (a getter) may need its map shown first; it is then left out.
    // Some credits open with the map's own name, which the line above already gives.
    const credit = t => { try { return (t.credit || '').replace(`${t.name}: `, ''); } catch { return ''; } };
    $('#mapSources').innerHTML = GROUP_ORDER.map(g => `<h3 class="src-g">${esc(g)}</h3><ul class="sources">${MAP_TYPES.filter(t => t.group === g)
      .map(t => `<li><span class="src-name">${esc(label(t))}</span><br>${blank(credit(t)) || 'No outside sources'}</li>`).join('')}</ul>`).join('');
  }, e => {
    console.warn(e);
    sourcesLoad = null;
    $('#mapSources').innerHTML = '<p class="note">Map sources did not load. Close and open Sources to try again.</p>';
  });
}

// A type that colours the countries itself hides Colour by figure, Or show a group and their key (the choice comes back on the next
// map); one that draws its own capitals hides the Capitals layer.
function syncTypeControls() {
  const mt = mapType(S.map);
  for (const id of ['mode', 'group']) $('#' + id).hidden = $(`label[for="${id}"]`).hidden = !!mt.ownsColour;
  const cap = $('#placeList input[value="capitals"]')?.closest('.lyr');
  if (cap) cap.hidden = !!mt.drawsCapitals;
  document.body.classList.toggle('paper-globe', lightGlobe()); // toned down in dark mode (style.css)
  document.body.classList.toggle('dark-tiles', !!mt.darkTiles); // inverted in dark mode (style.css)
  syncPlaces();
}

// Switches the map type: tiles, overlays, legend, corner credit and the address.
function setMapType(id, { url = true } = {}) {
  // A map type's module comes the first time it is chosen; the switch happens when it arrives, unless another map
  // was chosen meanwhile.
  S.wantMap = id;
  if (mapType(id).later) {
    loadType(id).then(() => { if (S.wantMap === id) setMapType(id, { url }); }, e => {
      console.warn(e);
      if (S.wantMap !== id) return;
      $('#mapType').value = S.map;
      $('#mapAbout').textContent = 'That map did not load. Check your connection and choose it again.';
    });
    return;
  }
  // An earthquake, volcano or airport panel belongs to the map that drew it; a clicked point re-reads the new map.
  if (S.sel?.kind === 'point' && S.sel.obj.feature) select(null, null, { push: false });
  const mt = mapType(id);
  S.map = mt.id;
  S.tallKey = false; // measured again for this map's key (renderLegend)
  $('#mapType').value = mt.id;
  const noTiles = !tiles && mt.layers({ k: 30000, dark: false }).length;
  S.mapSet = true;
  $('#mapAbout').textContent = noTiles ? 'This browser cannot draw map tiles (WebGL is off), so only the country map is shown.' : '';
  const api = overlayApi(center());
  $('#mapTools').innerHTML = '';
  mt.setup?.(api);
  syncTypeControls();
  writeCredit(); // after setup, which can change what onMap names
  if (mt.overlay && !mt.overlay.loading) {
    mt.overlay.loading = Promise.resolve().then(() => mt.overlay.load(api)).then(() => { mt.overlay.ready = true; draw(); })
      .catch(e => {
        console.warn(e);
        mt.overlay.loading = null;
        if (S.map === mt.id) $('#mapAbout').textContent = 'That map did not load. Check your connection and choose it again.';
      });
  }
  renderLegend();
  layoutChrome();
  zoomLimit();
  if (url) history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj)));
  if (S.sel?.kind === 'point' || S.sel?.kind === 'list') renderInfo(); // a list's colours follow the new map's
  draw();
}

// Places: one row per layer (its tick shows it on the globe), each folding open to the list of its places.
function renderLayers() {
  const box = $('#placeList'), a = document.activeElement;
  // A theme change rebuilds the rows; keep the open lists, and keyboard focus on the control that had it.
  const open = new Set([...box.querySelectorAll('.fold[aria-expanded="true"]')].map(b => b.value));
  const was = !box.contains(a) ? null : a.dataset.hot ? `[data-hot="${a.dataset.hot}"]` : `${a.matches('input') ? 'input' : '.fold'}[value="${a.value}"]`;
  // items: the layer's places, for a list under its row (contested areas and capitals have none).
  const row = (id, icon, name, n, items) => {
    const label = `<label><input type="checkbox" value="${id}"${S.layers.has(id) ? ' checked' : ''}>${icon}${esc(name)}<span class="count">${n}</span></label>`;
    if (!items) return `<div class="lyr">${label}</div>`;
    const on = open.has(id);
    return `<div class="lyr">${label}<button type="button" class="fold" value="${id}" aria-expanded="${on}" aria-controls="pl-${id}" aria-label="${esc(name)} list"><svg class="chev" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
      <ul class="plist" id="pl-${id}"${on ? '' : ' hidden'}>${items.map(it => `<li><button type="button" data-hot="${esc(it.id)}">${esc(it.name)}</button></li>`).join('')}</ul>`;
  };
  box.innerHTML = hot.layers.map(l => { const items = hot.items.filter(it => it.layer === l.id); return row(l.id, placeIcon(l.id), l.name, items.length, items); }).join('') +
    row('contested', placeIcon('contested'), 'Contested areas', contested.length) +
    row('capitals', `<svg class="mk" viewBox="0 0 14 14" aria-hidden="true"><rect x="4.5" y="4.5" width="5" height="5" fill="${C.text}"/></svg>`, 'Capitals', features.filter(isCapital).length);
  syncTypeControls(); // and syncPlaces, once the Capitals row is shown or hidden
  if (was) box.querySelector(was)?.focus();
}

function buildControls() {
  renderLayers();
  $('#placeList').addEventListener('change', e => setLayer(e.target.value, e.target.checked));
  $('#placeList').addEventListener('click', e => {
    const b = e.target.closest('.fold');
    if (!b) return;
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', open);
    $('#pl-' + b.value).hidden = !open;
  });
  $('#placesBtn').addEventListener('click', toggleHot);
  $('#hotAll').addEventListener('change', toggleHot);

  const opt = (v, t) => `<option value="${v}">${esc(t)}</option>`;
  $('#mode').innerHTML = opt('none', 'None') + Object.entries(info.indicators).map(([k, i]) => opt(k, i.name)).join('') + opt('income', 'Income group');
  $('#group').innerHTML = opt('none', 'None') + blocs.blocs.map(b => opt(b.id, b.label || b.name)).join('');
  for (const id of ['mode', 'group']) $('#' + id).addEventListener('change', e => { hideHint(); mapChosen(); setMode(e.target.value, { turn: true }); });
  $('#mapType').innerHTML = GROUP_ORDER.map(g => `<optgroup label="${esc(g)}">${MAP_TYPES.filter(t => t.group === g)
    .map(t => opt(t.id, label(t))).join('')}</optgroup>`).join('');
  $('#mapType').addEventListener('change', e => { hideHint(); mapChosen(); setMapType(e.target.value); });

  const all = [...byIso.values()];
  $('#scopeAll').textContent = `All (${all.length})`;
  $('#scopeUn').textContent = `UN members (${all.filter(f => f.d.status === 'un').length})`;
  $('#scopeSet').addEventListener('change', e => { hideHint(); setScope(e.target.value); });
  for (const k of document.querySelectorAll('#qKey, .qk')) k.textContent = MAC ? '⌘K' : 'Ctrl K';

  $('#built').textContent = info.built;
  $('#asOf').textContent = hot.asOf;
  // S.w is not set yet at this point, so read the window directly. Short windows (phone landscape)
  // also start with the sections closed, so the one the user opens gets the room.
  // So do screens where the globe cannot sit beside the 290px column (portrait tablets, unfolded foldables): there
  // it sits above or below the cards at full size.
  if (innerWidth <= 720 || innerHeight <= 500 || innerWidth - 322 < 0.84 * Math.min(innerWidth, innerHeight)) $('#mapPanel').open = false;
  syncTabs();

  const hint = $('#hint');
  // The search box's own chip shows the shortcut, and Help keeps the touch gestures.
  // On point maps (Earthquakes and others) a click reads the map there; the address names the map at start.
  const what = mapType(new URLSearchParams(location.search).get('map') || S.map).click === 'point' ? 'the map or a marker' : 'a country or marker';
  hint.textContent = coarse ? `Tap ${what}.` : `Drag to turn, scroll to zoom, click ${what}.`;
  hint.hidden = false;
  setTimeout(hideHint, 12000);
}

// keepMode: on Back/Forward the colour stays as the user last chose it; only the selection follows history.
function fromUrl({ push = false, keepMode = false } = {}) {
  let h = ''; // read first: setMode rewrites the URL
  try { h = decodeURIComponent(location.hash.slice(1)); } catch { /* malformed hash: ignore it */ }
  const params = new URLSearchParams(location.search);
  const colour = params.get('colour');
  const mode = colour && (info.indicators[colour] || colour === 'income' || blocById.has(colour)) ? colour : 'none';
  const cmp = /^compare-([A-Z]{3})(?:-([A-Z]{3}))?$/i.exec(h);
  const at = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(h);
  const target = at && Math.abs(+at[1]) <= 90 && Math.abs(+at[2]) <= 180 ? ['point', pointAt([+at[2], +at[1]], countryAt([+at[2], +at[1]]))]
    : hotById.has(h) ? ['hot', hotById.get(h)]
    : cmp && byIso.has(cmp[1].toUpperCase()) ? ['compare', { a: byIso.get(cmp[1].toUpperCase()), b: byIso.get(cmp[2]?.toUpperCase()) !== byIso.get(cmp[1].toUpperCase()) ? byIso.get(cmp[2]?.toUpperCase()) || null : null }]
    : byIso.has(h.toUpperCase()) ? ['country', byIso.get(h.toUpperCase())]
    : byKey.has(h) ? ['country', byKey.get(h)] : null;
  if (!keepMode) {
    const scope = params.get('countries') === 'un' ? 'un' : 'all';
    if (scope !== S.scope) setScope(scope);
    const map = MAP_TYPES.some(t => t.id === params.get('map')) ? params.get('map') : DEFAULT_MAP;
    if (map !== S.map || !S.mapSet) setMapType(map, { url: false });
  }
  if (!keepMode && mode !== S.mode) setMode(mode, { turn: !target });
  // #list reopens the ranked list (Back from a country opened in it lands here), if a colouring is on.
  // A list opened from a country's rank keeps that link back in its history entry.
  const st = history.state;
  // A list entry from a rank whose colouring was cleared since (Clear, then Forward): restore that colouring.
  if (h === 'list' && S.mode === 'none' && st?.rank && info.indicators[st.rank]) setMode(st.rank);
  if (h === 'list' && S.mode !== 'none') {
    const from = st?.from ? byIso.get(st.from) || byKey.get(st.from) : null;
    // The row to centre: the country last opened from this list, else the country the rank link came from.
    select('list', { id: 'list', sort: from ? 'value' : S.listSort, from, rank: st?.rank, focus: st?.row || from?.d.iso3 }, { push });
  } else if (target) select(target[0], target[1], { fly: true, push });
  else if (S.sel) select(null, null, { push });
  // Drop anything in the address that matched nothing (?colour=bogus, #nonsense, #list with no colouring),
  // and say so, since the link's reader expected something to open.
  const tuv = /^tuv$/i.test(h) || (cmp && [cmp[1], cmp[2]].some(c => /^tuv$/i.test(c || '')));
  const second = cmp?.[2] && byIso.get(cmp[2].toUpperCase());
  if (tuv) $('#status').textContent = TUVALU;
  else if (h && h !== 'list' && !target) $('#status').textContent = `Nothing here is called #${h.length > 40 ? h.slice(0, 40) + '\u2026' : h}.`;
  else if (cmp?.[2] && target && !second) $('#status').textContent = `No country has the code ${cmp[2].toUpperCase()}.`;
  else if (second && target && !inScope(second)) $('#status').textContent = `${second.d.name} is not a UN member, so the UN members filter leaves it out.`;
  history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj)));
}

// Phones: choosing a map type or a colouring closes the Map section, so the globe shows the result; focus goes to the
// Map tab. Not after a key, where the arrow keys step through a select's options one change at a time.
// html.keyed also shows the panel title's focus ring only after a key, never after a tap or a link opened on load.
let keyed = false; // the last input was a key, not a pointer
addEventListener('keydown', () => { keyed = true; document.documentElement.classList.add('keyed'); }, true);
addEventListener('pointerdown', () => { keyed = false; document.documentElement.classList.remove('keyed'); }, true);
function mapChosen() {
  if (!narrow() || keyed || !$('#mapPanel').open) return;
  $('#mapPanel').open = false;
  syncTabs();
  layoutChrome(); // before the colouring fits a group to the free area
  $('.ctl-tabs [data-sec="mapPanel"]').focus({ preventScroll: true });
}

// The tab row over the control sections shows which one is open.
function syncTabs() {
  for (const b of document.querySelectorAll('.ctl-tabs button')) b.setAttribute('aria-expanded', String($('#' + b.dataset.sec).open));
}

// On phones only one control section is open at a time, and it moves below the collapsed ones
// so the visual order and the focus order stay the same.
const SECTION_ORDER = ['mapPanel', 'placesPanel', 'helpPanel', 'sourcesPanel'];
function arrangeSections(opened) {
  const ctl = $('#controls');
  // Short windows (phones, phone landscape) keep one section open at a time.
  if (opened?.open && (narrow() || S.h <= 500)) {
    for (const d of ctl.querySelectorAll('details[open]')) if (d !== opened) d.open = false;
  }
  // Elsewhere several can be open, but not so many that the card overflows (see fitSections).
  if (opened?.open) lastOpened = opened;
  fitSections();
  if (narrow() && opened?.open) {
    // Collapsed headers keep their order in the top row; the open section goes last and starts at its top.
    const focused = document.activeElement;
    for (const id of SECTION_ORDER) if (id !== opened.id) ctl.append($('#' + id));
    ctl.append(opened);
    ctl.scrollTop = 0;
    // Moving nodes drops focus; put it back on whatever had it (the summary or a list item).
    if (ctl.contains(focused)) focused.focus({ preventScroll: true });
  } else if (!ctl.querySelector('details[open]') || !narrow()) {
    const focused = document.activeElement;
    for (const id of SECTION_ORDER) ctl.append($('#' + id));
    if (ctl.contains(focused)) focused.focus();
  }
}

function bind() {
  d3.select(canvas).call(zoom);

  let moveQueued = false, mx = 0, my = 0;
  canvas.addEventListener('pointermove', e => {
    // The mouse ends keyboard mode, so the crosshair label never names the mouse's country.
    if (S.kbd) { S.kbd = false; S.hover = null; clearTimeout(sayTimer); draw(); }
    if (e.buttons) return;
    mx = e.clientX; my = e.clientY;
    if (moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      const p = pick(mx, my);
      if (p?.obj !== S.hover?.obj || p?.contested !== S.hover?.contested) { S.hover = p; draw(); }
      canvas.classList.toggle('pointer', !!p);
      if (p) showTip(p, mx, my); else hideTip();
    });
  });
  canvas.addEventListener('pointerleave', () => { if (!S.kbd) S.hover = null; hideTip(); draw(); });
  canvas.addEventListener('pointerdown', () => { hideHint(); if (!$('#status button')) $('#status').textContent = ''; });
  canvas.addEventListener('wheel', hideHint, { passive: true });
  canvas.addEventListener('click', e => choose(pick(e.clientX, e.clientY)));

  // Screen readers hear what is in the middle of the globe after keyboard turns.
  let sayTimer = 0;
  // Marks the target at the selection weight, so sighted keyboard users see what Enter will open.
  const target = () => { const [cx, cy] = proj.translate(), p = pick(cx, cy); S.hover = p && { ...p, strong: true }; return p; };
  const say = () => {
    const p = target();
    draw();
    $('#globeSays').textContent = p?.kind === 'country' && modeLine(p.obj) ? `${pickName(p)}, ${modeLine(p.obj)}` : pickName(p);
  };
  // Keyboard focus shows the crosshair and the target straight away, before any arrow key.
  canvas.addEventListener('focus', () => { if (canvas.matches(':focus-visible')) { S.kbd = true; say(); } });
  canvas.addEventListener('blur', () => { S.kbd = false; S.hover = null; draw(); });
  canvas.addEventListener('keydown', e => {
    hideHint();
    hideTip();
    if (!S.kbd) { S.kbd = true; target(); draw(); } // the first key after the mouse re-targets the middle
    const step = 8 / S.k, r = proj.rotate();
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      if (S.flying) d3.select(canvas).interrupt();
      proj.rotate([r[0] + d[0], clampLat(r[1] + d[1]), r[2]]);
      target();
      moving();
      draw();
      clearTimeout(sayTimer);
      sayTimer = setTimeout(say, 400);
    } else if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-') zoomBy(1 / 1.5);
    else if (e.key === 'Enter') {
      const [cx, cy] = proj.translate();
      const p = pick(cx, cy);
      if (p) choose(p, { focus: true }); else say();
    }
  });

  $('#zin').onclick = () => { hideHint(); zoomBy(1.5); };
  $('#zout').onclick = () => { hideHint(); zoomBy(1 / 1.5); };
  $('#reset').onclick = () => { hideHint(); frame({ at: HOME, k: 1 }); };
  new ResizeObserver(() => document.documentElement.style.setProperty('--attrib-h', $('#attrib').offsetHeight + 'px')).observe($('#attrib'));
  $('#close').onclick = closePanel;
  // The handle: a tap toggles half and tall; a drag up makes it tall, a drag down makes it half height
  // (or closes the panel when it already is).
  let grabFrom = null, grabDragged = false;
  // Half and tall: the sheet slides to its new top edge (a transform, so its contents are laid out once). Taller, it
  // grows at once and slides up from where it was; shorter, it slides down first and then shrinks.
  let sheetAnim = null;
  const setTall = on => {
    const box = $('#info'), apply = () => { box.classList.toggle('tall', on); $('#grab').setAttribute('aria-expanded', on); layoutChrome(); };
    sheetAnim?.cancel(); sheetAnim = null;
    if (on === box.classList.contains('tall')) return;
    if (still()) return apply();
    const top = box.getBoundingClientRect().top;
    box.classList.toggle('tall', on);
    const dy = box.getBoundingClientRect().top - top;
    if (on) { apply(); sheetAnim = box.animate([{ transform: `translateY(${-dy}px)` }, { transform: 'none' }], { duration: DUR_2, easing: EASE }); return; }
    box.classList.add('tall');
    const a = sheetAnim = box.animate([{ transform: 'none' }, { transform: `translateY(${dy}px)` }], { duration: DUR_2, easing: EASE, fill: 'forwards' });
    a.onfinish = () => { sheetAnim = null; apply(); a.cancel(); };
  };
  $('#grab').addEventListener('pointerdown', e => { grabFrom = e.clientY; grabDragged = false; $('#grab').setPointerCapture(e.pointerId); });
  $('#grab').addEventListener('pointermove', e => {
    if (grabFrom == null || grabDragged) return;
    const dy = e.clientY - grabFrom;
    if (Math.abs(dy) < 16) return;
    grabDragged = true;
    const tall = $('#info').classList.contains('tall');
    if (dy < 0) setTall(true); else if (tall) setTall(false); else closePanel();
  });
  // A touch drag sends no click, so the flag is cleared after any click this gesture makes.
  $('#grab').addEventListener('pointerup', e => {
    // A drag too short to act can end above the sheet, where the browser's click would land on the globe and close the panel.
    if (grabFrom != null && !grabDragged && Math.abs(e.clientY - grabFrom) > 4) {
      const eat = ev => { if ($('#grab').contains(ev.target)) return; ev.stopPropagation(); ev.preventDefault(); }; // the handle's own tap still counts
      addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', eat, true), 400);
    }
    grabFrom = null; setTimeout(() => { grabDragged = false; });
  });
  $('#grab').addEventListener('pointercancel', () => { grabFrom = null; });
  $('#grab').onclick = () => {
    if (grabDragged) { grabDragged = false; return; } // the drag already acted
    setTall(!$('#info').classList.contains('tall'));
  };

  // The photo viewer closes on a tap on the dimmed backdrop too (the click lands on the dialog itself, outside its box).
  const lb = $('#lightbox');
  lb.addEventListener('click', e => {
    const r = lb.getBoundingClientRect();
    if (e.target === lb && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) lb.close();
  });

  document.addEventListener('keydown', e => {
    if ($('#lightbox').open) return; // the dialog's own Esc closes only the photo and hands focus back
    const typing =e.target.matches('input:not([type=checkbox]):not([type=radio]), select, textarea, [contenteditable]');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    else if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    else if (e.key === 'Escape' && e.target.closest?.('#controls details[open]')) {
      const d = e.target.closest('details');
      d.open = false;
      $(`.ctl-tabs [data-sec="${d.id}"]`)?.focus();
    }
    else if (e.key === 'Escape' && S.ghost && e.target !== $('#q')) endGhost();
    else if (e.key === 'Escape' && S.sel && e.target !== $('#q')) closePanel();
  });

  // Chips and list buttons anywhere in the panels.
  document.addEventListener('click', e => {
    const b = e.target.closest('#info button, #controls button, #legendCard button, #ghostCard button');
    if (!b) return;
    const ds = b.dataset;
    if (ds.rank) return openRanking(ds.rank);
    if (ds.photo) return openPhoto(ds.photo);
    if (ds.compare) return select('compare', { a: features[+ds.compare], b: null }, { focus: true });
    if (ds.swap) return select('compare', { a: S.sel.obj.b, b: S.sel.obj.a }, { focus: true });
    if (ds.ghost) return toggleGhost(features[+ds.ghost]);
    if (ds.over) { startGhost(S.sel.obj.a, features[+ds.over]); return; }
    if (ds.anti) return toggleAnti(features[+ds.anti]);
    if (ds.scope) return setScope(ds.scope);
    if (ds.back) return closePanel();
    if (ds.ghostoff) return endGhost();
    // A country opened from the ranked list: remember the row in the list's history entry (so Back lands on it)
    // and mark the country's entry as coming from the list (so its panel offers the way back).
    if (ds.f && S.sel?.kind === 'list') {
      const f = features[+ds.f];
      history.replaceState({ ...(history.state || {}), row: isoOf(f) }, '', location.href);
      return select('country', f, { fly: true, focus: true, state: { fromList: true } });
    }
    if (ds.more) {
      // "Show all 20" under a capped list of chips or names.
      const open = !b.previousElementSibling.classList.toggle('capped');
      b.setAttribute('aria-expanded', open);
      b.textContent = open ? 'Show fewer' : ds.more;
      return;
    }
    if (b.id === 'ghostDone') return endGhost();
    if (b.id === 'clearMode') {
      hideHint();
      const m = blocById.has(S.mode) ? $('#group') : $('#mode');
      setMode('none');
      (m.checkVisibility() ? m : canvas).focus({ preventScroll: true });
    } else if (b.id === 'listMode') select('list', { id: 'list', sort: S.listSort }, { focus: true });
    else if (b.dataset.sort) { S.sel.obj.sort = S.listSort = b.dataset.sort; renderInfo(); }
    else if (b.dataset.f) select('country', features[+b.dataset.f], { fly: true, focus: true });
    else if (b.dataset.hot) select('hot', hotById.get(b.dataset.hot), { fly: true, focus: true });
    else if (b.dataset.mode) { hideHint(); setMode(S.mode === b.dataset.mode ? 'none' : b.dataset.mode); }
    else if (b.getAttribute('role') === 'tab') setTab(b.id.slice(4));
  });
  $('#infoBody').addEventListener('keydown', e => {
    if (e.target.getAttribute('role') !== 'tab') return;
    const ids = TABS.map(t => t[0]), i = ids.indexOf(S.tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setTab(ids[(next + ids.length) % ids.length], true);
  });

  // The tab strip: its edge fades follow its scroll, and a mouse wheel over it scrolls it sideways (until an end,
  // where the wheel goes back to scrolling the panel).
  $('#infoBody').addEventListener('scroll', e => { if (e.target.classList?.contains('tabs')) tabEdges(e.target); }, { capture: true, passive: true });
  $('#infoBody').addEventListener('click', e => {
    const g = e.target.closest?.('.tabs .edge');
    if (g) g.parentNode.scrollBy({ left: g.dataset.edge * g.parentNode.clientWidth * 0.6, behavior: still() ? 'instant' : 'smooth' });
  });
  $('#infoBody').addEventListener('wheel', e => {
    const t = e.target.closest?.('.tabs'), dy = e.deltaY;
    if (!t || Math.abs(e.deltaX) >= Math.abs(dy) || (dy < 0 ? t.scrollLeft <= 0 : t.scrollLeft >= t.scrollWidth - t.clientWidth - 1)) return;
    e.preventDefault();
    t.scrollBy({ left: dy, behavior: 'instant' });
  }, { passive: false });

  $('#infoBody').addEventListener('change', e => {
    if (e.target.id === 'cmpB') select('compare', { a: S.sel.obj.a, b: byIso.get(e.target.value) || null });
  });

  // Ranked list: hovering or focusing a row marks its country on the globe; keyboard focus also turns the
  // globe towards it when it is on the far side.
  const rowCountry = el => {
    const b = S.sel?.kind === 'list' && el.closest?.('table.rank tr')?.querySelector('button[data-f]');
    return b ? features[+b.dataset.f] : null;
  };
  const markRow = f => { if (S.hover?.obj !== f) { S.hover = f ? { kind: 'country', obj: f, strong: true } : null; draw(); } };
  $('#infoBody').addEventListener('pointerover', e => { const f = rowCountry(e.target); if (f) markRow(f); });
  $('#infoBody').addEventListener('pointerout', e => {
    if (rowCountry(e.target) && !rowCountry(e.relatedTarget || document.body)) markRow(null);
  });
  $('#infoBody').addEventListener('focusin', e => {
    const f = rowCountry(e.target);
    if (!f) return;
    markRow(f);
    if (e.target.matches(':focus-visible') && !visible(f.anchor, center())) frame({ at: f.anchor });
  });
  $('#infoBody').addEventListener('focusout', e => { if (rowCountry(e.target) && !rowCountry(e.relatedTarget || document.body)) markRow(null); });

  // Trend charts: hover, a tap or sideways drag, and the arrow keys all move the year shown under the chart.
  const chartAt = e => e.target.closest?.('svg[data-chart]');
  // Touch follows a drag only once it is clearly sideways, so a vertical swipe scrolls the sheet and
  // leaves the year alone.
  let touch = null;
  $('#infoBody').addEventListener('pointerdown', e => {
    const svg = chartAt(e);
    touch = svg && e.pointerType !== 'mouse' ? { svg, x: e.clientX, y: e.clientY, side: false } : null;
  });
  $('#infoBody').addEventListener('pointermove', e => {
    const svg = chartAt(e);
    if (!svg) return;
    if (e.pointerType === 'mouse') return showYear(svg, yearAt(svg, e.clientX));
    if (!touch || touch.svg !== svg || !e.buttons) return;
    const dx = Math.abs(e.clientX - touch.x), dy = Math.abs(e.clientY - touch.y);
    if (!touch.side && dx > 8 && dx > dy) touch.side = true;
    if (touch.side) showYear(svg, yearAt(svg, e.clientX));
  });
  for (const t of ['pointerup', 'pointercancel']) $('#infoBody').addEventListener(t, () => { touch = null; });
  // A tap sets the year on click, which the browser does not send after a scroll, so a vertical swipe
  // that starts on a chart scrolls the sheet without moving the year.
  $('#infoBody').addEventListener('click', e => { const svg = chartAt(e); if (svg) showYear(svg, yearAt(svg, e.clientX)); });
  // A mouse leaving resets to the latest year, unless the year was chosen from the keyboard;
  // after a tap the chosen year stays, since touch has no hover.
  $('#infoBody').addEventListener('pointerout', e => {
    const svg = chartAt(e);
    if (svg && e.pointerType === 'mouse' && !svg.contains(e.relatedTarget) && !svg.matches(':focus-visible')) showYear(svg, null);
  });
  $('#infoBody').addEventListener('keydown', e => {
    const svg = chartAt(e), c = svg && CHARTS.get(svg.dataset.chart);
    if (!c || e.altKey || e.ctrlKey || e.metaKey) return; // leave browser shortcuts (Alt+Left is Back) alone
    const [lo, hi] = c.x.domain(), now = c.year ?? hi;
    const to = { ArrowLeft: [now - 1, -1], ArrowRight: [now + 1, 1], PageDown: [now - 10, -1], PageUp: [now + 10, 1], Home: [lo, 1], End: [hi, -1] }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    showYear(svg, ...to);
  });

  const q = $('#q');
  q.addEventListener('input', showResults);
  q.addEventListener('focus', () => { if (q.value.trim()) showResults(); });
  q.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveResult(e.key === 'ArrowDown' ? 1 : -1); }
    else if (e.key === 'Enter') { e.preventDefault(); openResult(); }
    else if (e.key === 'Escape' && !resultsEl().hidden) { e.preventDefault(); closeResults(); }
  });
  // Keep focus in the box while an option is clicked.
  resultsEl().addEventListener('mousedown', e => e.preventDefault());
  resultsEl().addEventListener('click', e => { const li = e.target.closest('[data-i]'); if (li) openResult(+li.dataset.i); });
  q.addEventListener('blur', () => { closeResults(); if (!$('#status button')) $('#status').textContent = ''; });

  // Re-centre when a panel opens or closes, unless a flight already aims at the new free space.
  for (const b of document.querySelectorAll('.ctl-tabs button')) {
    b.addEventListener('click', () => {
      const d = $('#' + b.dataset.sec), open = !d.open;
      for (const o of $('#controls').querySelectorAll('details')) if (o !== d && o.open) o.open = false;
      d.open = open;
      if (open) enter([...d.children].filter(c => c.tagName !== 'SUMMARY'));
    });
  }
  for (const d of $('#controls').querySelectorAll('details')) {
    d.addEventListener('toggle', () => {
      if (d.open) hideHint(); // the start-up collapse on phones is not an interaction
      if (d.open && d.id === 'sourcesPanel') renderSources();
      syncTabs();
      arrangeSections(d);
      layoutChrome();
      if (!S.flying) frame();
    });
  }
  // The sheet's and the legend's heights change with their content, the webfont and the phone key's fold,
  // and a map's tools with their status lines; keep the dock, the controls card and the globe in step.
  const sizes = new ResizeObserver(() => { layoutChrome(); if (!S.flying) frame(); });
  sizes.observe($('#info'));
  sizes.observe($('#legendCard'));
  $('#legendCard').addEventListener('scroll', keyMore, { passive: true });
  sizes.observe($('#mapTools'));

  addEventListener('resize', resize);
  // A change of pixel density alone (a window moved to another screen) fires no resize event.
  const watchDpr = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  watchDpr();
  addEventListener('keydown', e => { if (e.ctrlKey || e.metaKey || !e.target.matches?.('input, textarea, select')) document.body.classList.add('keys'); }); // a key pressed outside a text field means a hardware keyboard
  addEventListener('popstate', () => {
    const inPanel = $('#info').contains(document.activeElement) || document.activeElement === document.body;
    // Leaving a list that was opened from a country's rank: land on that rank link, not the title.
    const left = S.sel?.kind === 'list' ? S.sel.obj : null;
    const rankBack = S.backRank || (left?.from && left.rank);
    S.backRank = null;
    fromUrl({ keepMode: true });
    history.replaceState(history.state, '', urlFor(hashFor(S.sel?.kind, S.sel?.obj)));
    const rankBtn = rankBack && S.sel?.kind === 'country' && S.sel.obj === left?.from && $(`#infoBody [data-rank="${rankBack}"]`);
    // Back to a list from a country opened in it: focus that country's row.
    const rowBtn = S.sel?.kind === 'list' && $('#rowFocus button');
    if (rankBtn) rankBtn.focus();
    else if (rowBtn && inPanel) rowBtn.focus({ preventScroll: true });
    else if (inPanel && S.sel) $('#infoTitle')?.focus({ preventScroll: true });
  });
  darkQuery.addEventListener('change', readTheme);
}

function failLoad(message) {
  const status = $('#status');
  status.innerHTML = `${message} Check your connection and <button type="button" id="retry">try again</button>.`;
  $('#retry').onclick = () => location.reload();
  $('#controls').hidden = true;
  $('.zoom').hidden = true;
}

async function start() {
  const debug = new URLSearchParams(location.search).has('debug'); // read before fromUrl rewrites the address
  // Start-up: placements snap (no glide) and draw at full detail, until the first input or a few seconds after load.
  S.booting = true;
  const booted = () => { S.booting = false; for (const t of ['pointerdown', 'keydown', 'wheel']) removeEventListener(t, booted, true); };
  for (const t of ['pointerdown', 'keydown', 'wheel']) addEventListener(t, booted, true);
  // A tab restored from the back-forward cache, or shown again, gets a fresh full-detail frame.
  addEventListener('pageshow', e => { if (e.persisted) { S.moving = false; remeasure(); draw(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !S.gesture) { S.moving = false; draw(); } });
  $('#status').textContent = 'Loading map…';
  readTheme();
  drawSphere();
  // A link to a map type other than the entry one: its module comes with the map data, so the first frame is that map.
  const linked = loadType(new URLSearchParams(location.search).get('map')).catch(() => {});
  try {
    await load();
    await linked;
  } catch (err) {
    console.error(err);
    failLoad('The map data did not load.');
    return;
  }
  $('#status').textContent = '';
  readTheme();
  buildControls();
  document.body.classList.remove('loading'); // the controls card stays hidden until it has its contents
  buildIndex();
  bind();
  // The empty globe was placed before the cards had their contents: it moves from there to its place (frame; a snap while the app starts).
  const early = proj.translate();
  resize();
  proj.translate(early);
  fromUrl();
  if (!S.flying) frame(); // a deep link's flight is scheduled, not yet active, so d3.active() would miss it
  fitBase(); // again: the legend is only rendered by now
  zoomLimit();
  if ($('#q').value && document.activeElement === $('#q')) showResults(); // text typed while the map was loading
  // The photo list (1.5 MB) is fetched while idle, so it rarely arrives after a country's panel opens.
  // Data Saver: photos load with the first panel instead.
  if (!navigator.connection?.saveData) (window.requestIdleCallback || (f => setTimeout(f, 1500)))(prefetchPhotos);
  // The webfont can change panel heights after the first layout.
  document.fonts?.ready.then(() => { layoutChrome(); if (!S.flying) frame(); draw(); setTimeout(() => { S.booting = false; remeasure(); }, 2500); });
  addEventListener('load', remeasure);
  window.visualViewport?.addEventListener('resize', remeasure);
  if (debug) debugBox();
  Promise.all(MAP_FACES.map(f => document.fonts?.load(f))).then(draw, () => {});
}

start();

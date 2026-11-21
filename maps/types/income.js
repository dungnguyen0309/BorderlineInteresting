// Income: GDP per person by first-level region (state, province, county), from Kummu, Kosonen and
// Masoumzadeh Sayyar (Zenodo 18429133, CC BY 4.0). scripts/build_income.py simplifies the admin-1 polygons
// into data/maps/income/adm1.topo.json (2.9 MB, loaded on first use). The regions are painted into lon/lat
// tiles once each, so dragging the globe only moves cached textures; the app's country borders go on top.
/* global d3, topojson */

const DATA_URL = new URL('../../data/maps/income/adm1.topo.json', import.meta.url);
// Antarctica has no figure; its outline (Natural Earth via world-atlas, already in the browser cache) is drawn as no data.
const LAND_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
// International dollars (PPP). The source says 2021 dollars, but its US figure for 1990 ($23,889) is the
// World Bank's current-price value, so the series is read as current prices.
const BREAKS = [5000, 10000, 20000, 35000, 50000, 65000, 80000];
// The app's own sequential ramp (ColorBrewer YlGnBu, colour-blind safe); in dark mode high values are bright.
const RAMPS = { light: t => d3.interpolateYlGnBu(0.12 + 0.78 * t), dark: t => d3.interpolateYlGnBu(0.88 - 0.7 * t) };
const NODATA = { light: '#c9c9c4', dark: '#4a4a48' };
const LINE = { light: 'rgba(255,255,255,0.6)', dark: 'rgba(0,0,0,0.45)' };
const darkNow = () => matchMedia('(prefers-color-scheme: dark)').matches;
const palette = dark => d3.quantize(RAMPS[dark ? 'dark' : 'light'], BREAKS.length + 1);
const classOf = v => d3.bisectRight(BREAKS, v);
// shortcut: 255 px tiles get no mipmaps (mipmaps smudged the South Pole with sea colour); back to 256 once the
// engine stops mipmapping 'geo' tiles near the poles.
const PX = 255;
const usd = v => '$' + Math.round(v).toLocaleString('en');

// gen names the tile sources; a retry after a failed load bumps it, because the engine never re-requests a
// tile that failed under the same source id.
let loading = null, D = null, gen = 0, failed = false;
const breathe = () => new Promise(ok => setTimeout(ok));
function load() {
  if (loading) return loading;
  if (failed) gen++;
  failed = false;
  loading = Promise.all([
    fetch(DATA_URL).then(r => { if (!r.ok) throw new Error(`income data ${r.status}`); return r.json(); }),
    fetch(LAND_URL).then(r => r.json()).catch(() => null)
  ]).then(async ([topo, land]) => {
    // Decoded in chunks with a pause between, so choosing the map does not freeze a drag for a second.
    const geoms = topo.objects.adm1.geometries, regions = [];
    for (let i = 0; i < geoms.length; i += 300) {
      await breathe();
      for (const f of topojson.feature(topo, { type: 'GeometryCollection', geometries: geoms.slice(i, i + 300) }).features) {
        let w = 180, s = 90, e = -180, n = -90;
        for (const poly of f.geometry.coordinates) for (const [x, y] of poly[0]) {
          if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
        }
        f.box = [w, s, e, n];
        f.cls = classOf(f.properties.v);
        regions.push(f);
      }
    }
    const ant = land && topojson.feature(land, land.objects.countries).features.find(f => f.id === '010');
    D = { regions, nations: topo.nations, years: topo.years, nodata: ant ? [ant.geometry] : [] };
  }).catch(e => { loading = null; failed = true; throw e; });
  return loading;
}

// ---------- tiles ----------

// Adds a polygon's rings to the path in tile pixels, dropping points closer than tol pixels.
function trace(g, coords, w, n, s, tol) {
  for (const ring of coords) {
    let lx = NaN, ly = NaN;
    for (let i = 0; i < ring.length; i++) {
      const x = (ring[i][0] - w) * s, y = (n - ring[i][1]) * s;
      if (i && Math.abs(x - lx) < tol && Math.abs(y - ly) < tol) continue;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
      lx = x; ly = y;
    }
    g.closePath();
  }
}

function paint({ z, x, y }, dark) {
  const span = 180 / 2 ** z, w = -180 + x * span, n = 90 - y * span, e = w + span, so = n - span, s = PX / span;
  const c = document.createElement('canvas');
  c.width = c.height = PX;
  const g = c.getContext('2d');
  const theme = dark ? 'dark' : 'light', cols = palette(dark), tol = z < 3 ? 1 : 0.5;
  const hit = D.regions.filter(f => f.box[0] <= e && f.box[2] >= w && f.box[1] <= n && f.box[3] >= so);
  if (so < -60) {
    // Spherical outline round the pole, so d3 draws it (an equirectangular projection fitted to the tile).
    const eq = d3.geoEquirectangular().scale(s * 180 / Math.PI).translate([-w * s, n * s]);
    g.beginPath();
    for (const geom of D.nodata) d3.geoPath(eq, g)(geom);
    g.fillStyle = NODATA[theme]; g.fill();
  }
  // One fill per colour class, then every region edge in one stroke.
  for (let k = 0; k < cols.length; k++) {
    g.beginPath();
    for (const f of hit) if (f.cls === k) for (const p of f.geometry.coordinates) trace(g, p, w, n, s, tol);
    g.fillStyle = cols[k]; g.fill('evenodd');
  }
  if (z >= 2) {
    g.beginPath();
    for (const f of hit) for (const p of f.geometry.coordinates) trace(g, p, w, n, s, tol);
    g.strokeStyle = LINE[theme]; g.lineWidth = z < 4 ? 0.4 : 0.8; g.lineJoin = 'round'; g.stroke();
  }
  return c;
}

// Tiles are painted one at a time, each in its own task, so a burst of new tiles never stalls a frame.
// They wait on the app's load (overlay.load); after a failure they fail at once instead of each fetching
// 2.9 MB again, until choosing the map again retries.
let queue = Promise.resolve();
function tile(t, dark) {
  const job = queue.then(() => loading || (failed ? Promise.reject(new Error('income data not loaded')) : load()))
    .then(breathe).then(() => paint(t, dark));
  queue = job.catch(() => {});
  return job;
}
const SOURCES = {};
const source = dark => SOURCES[`${dark}-${gen}`] ||= {
  id: `income-adm1-${dark ? 'dark' : 'light'}-${gen}`, scheme: 'geo', tileSize: 256, maxZoom: 10,
  url: (z, x, y) => `income:${gen}/${z}/${x}/${y}`, load: (url, t) => tile(t, dark)
};

// ---------- picking ----------

function inRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const regionAt = ([x, y]) => D.regions.find(f => f.box[0] <= x && f.box[2] >= x && f.box[1] <= y && f.box[3] >= y &&
  f.geometry.coordinates.some(p => inRing(p[0], x, y) && !p.slice(1).some(h => inRing(h, x, y))));

function rows(f) {
  const { n: name, c, sub, v, a } = f.properties, nat = D.nations[c] || {}, [y0, y1] = D.years;
  const out = [[`GDP per person, ${y1}`, `${usd(v)} (international dollars, PPP, current prices)`]];
  if (a) {
    const ch = v / a - 1;
    out.push([`In ${y0}`, usd(a)], [`Change since ${y0}`, `${ch >= 0 ? '+' : ''}${Math.round(ch * 100)}% in current dollars, not adjusted for inflation`]);
  }
  if (sub && nat.v) {
    // The gap to the national figure is free of inflation, so it is the fairer comparison over time.
    const gap = (r, yr) => { const d = r - 1; return `${Math.abs(Math.round(d * 100))}% ${d >= 0 ? 'above' : 'below'} in ${yr}`; };
    out.push([`${nat.n || c}, ${y1}`, `${usd(nat.v)} national figure`],
      ['Against the national figure', gap(v / nat.v, y1) + (a && nat.a ? `; ${gap(a / nat.a, y0)}` : '')]);
  }
  out.push(['Sub-national data', sub
    ? (nat.rep ? `Reported for ${nat.rep}; other years are the authors' estimates` : 'Reported by the country; years not listed')
    : 'None reported, so the whole country shows its national figure']);
  return out;
}

export default {
  id: 'income', name: 'GDP per person by region', group: 'Economy',
  ownsColour: true,
  credit: 'GDP per person: <a href="https://doi.org/10.5281/zenodo.18429133">Kummu, Kosonen and Masoumzadeh Sayyar</a>, ' +
    '<a href="https://doi.org/10.1038/s41597-025-04487-x">Scientific Data 12: 178 (2025)</a>, ' +
    '<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>; regions simplified to about 3 km for this map',
  layers: ({ dark }) => [{ src: source(dark) }],
  vector: 'lines', click: 'country',
  legend() {
    const dark = darkNow(), cols = palette(dark), n = v => v.toLocaleString('en');
    const labels = cols.map((_, i) => (i === 0 ? `Under $${n(BREAKS[0])}` : i === cols.length - 1 ? `$${n(BREAKS[i - 1])} and over` : `$${n(BREAKS[i - 1])}–${n(BREAKS[i])}`));
    return `<ul class="swatches ord">${cols.map((c, i) => `<li><i style="--c:${c}"></i>${labels[i]}</li>`).reverse().join('')}` +
      `<li><i style="--c:${NODATA[dark ? 'dark' : 'light']}"></i>No data (Antarctica)</li></ul>` +
      '<p class="note keep">GDP per person in 2024, international dollars at purchasing power parity (PPP), current prices.</p>';
  },
  overlay: {
    load,
    draw() {}, // everything is in the tiles
    pick(x, y, api) {
      const [cx, cy] = api.proj.translate();
      if (Math.hypot(x - cx, y - cy) > api.proj.scale()) return null;
      const at = api.proj.invert([x, y]);
      const f = at && regionAt(at);
      if (!f) return null;
      const { n: name, c, sub, v } = f.properties;
      const country = D.nations[c]?.n || c;
      // The rows come from query(), so a shared #@lat,lon link shows them too.
      return { title: name, sub: `${sub ? `Region of ${country}` : 'Whole country (no regional figures)'}, ${usd(v)} in ${D.years[1]}`, at, rows: [] };
    }
  },
  async query(at) {
    await load();
    const f = regionAt(at);
    if (!f) return [];
    return [...(f.properties.sub ? [['Region', f.properties.n]] : []), ...rows(f)];
  }
};

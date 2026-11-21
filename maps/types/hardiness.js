/* global d3, topojson */
// Plant hardiness zones (USDA method) from the 1991-2020 average of each year's lowest temperature (ERA5 TNn,
// 0.25 degree, via the World Bank Climate Change Knowledge Portal). scripts/build_hardiness.py turns it into
// zones.png (colours, sea masked, 5760 x 2880 lon/lat, 4 pixels per grid cell) and tnn.png (the temperature per
// cell, for clicks). Tiles are cut from zones.png in the browser, so the globe can zoom without new files.

const DATA = new URL('../../data/maps/hardiness/', import.meta.url);
const W = 5760, H = 2880, COLS = 1440, ROWS = 721, STEP = 0.25;

// Class 0 is colder than 1a, 1-26 are 1a-13b, 27 is warmer than 13b. RdYlBu (ColorBrewer), cold to warm.
// The build script reads this list, so the image and the legend always match.
const PALETTE = [
  '#313695', '#384da0', '#4065ac', '#4a7bb7', '#5c90c2', '#6da5cd', '#80b7d6', '#95c7df', '#a9d7e8', '#bde2ee',
  '#d0ebf4', '#e2f4f4', '#eef8df', '#f9fdca', '#fff9b6', '#feeea5', '#fee293', '#fed182', '#fdbf71', '#fdac60',
  '#f99455', '#f67b4a', '#f0643f', '#e54d34', '#da372a', '#ca2427', '#b81226', '#a50026'
];

// Same arithmetic as the build script: a zone is 10 °F wide from -60 °F, halves a and b are 5 °F.
const classOf = c => Math.max(0, Math.min(27, Math.floor((c * 9 / 5 + 32 + 60) / 5) + 1));
const nameOf = k => (k === 0 ? 'Below 1a' : k === 27 ? 'Above 13b' : `${Math.ceil(k / 2)}${k % 2 ? 'a' : 'b'}`);
const neg = v => String(v).replace('-', '−');
const degC = f => neg(((f - 32) * 5 / 9).toFixed(1));
// A zone's range as [°C, °F] text.
function rangeOf(k) {
  const lo = -65 + 5 * k, hi = lo + 5;
  if (k === 0) return [`under ${degC(-60)} °C`, `under ${neg(-60)} °F`];
  if (k === 27) return [`from ${degC(70)} °C`, 'from 70 °F'];
  return [`${degC(lo)} to ${degC(hi)} °C`, `${neg(lo)} to ${neg(hi)} °F`];
}

function loadImage(name) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`hardiness ${name}`));
    img.src = new URL(name, DATA).href;
  });
}
const wait = ms => new Promise(ok => setTimeout(ok, ms));
async function loadRetry(name) {
  for (const ms of [2000, 6000]) { try { return await loadImage(name); } catch { await wait(ms); } }
  return loadImage(name);
}
let zones = null, grid = null, API = null, failed = false, gen = 0;
// The engine never asks again for a tile that failed, so after a failure the source gets a new id once the image
// loads: every tile is then requested afresh. Until then the legend says the map did not load.
const zonesImage = () => zones || (zones = loadRetry('zones.png').then(img => {
  if (failed) { failed = false; source = makeSource(++gen); API?.refresh(); }
  return img;
}, e => { zones = null; if (!failed) { failed = true; API?.refresh(); } throw e; }));
const tnnGrid = () => grid || (grid = loadImage('tnn.png').then(img => {
  const c = document.createElement('canvas'); c.width = COLS; c.height = ROWS;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, COLS, ROWS).data;
}).catch(e => { grid = null; throw e; }));

// Each tile is cut from the one image: smoothed when shrunk, sharp when enlarged so grid cells stay square.
const makeSource = n => ({
  id: `hardiness${n}`, scheme: 'geo', tileSize: 256, maxZoom: 8, url: (z, x, y) => `hardiness/${n}/${z}/${x}/${y}`,
  async load(url, t) {
    const img = await zonesImage(), s = H / 2 ** t.z;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = s > 256;
    g.drawImage(img, t.x * s, t.y * s, s, s, 0, 0, 256, 256);
    return c;
  }
});
let source = makeSource(0);

let probe = null;
// Land in the drawn map (the same coast the colours stop at) within r pixels of this point (1 px = 0.0625°)?
function landNear(img, lon, lat, r) {
  probe ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const n = 2 * r + 1;
  probe.canvas.width = probe.canvas.height = n;
  const x = Math.min(W - 1, Math.floor((lon + 180) / 360 * W)), y = Math.min(H - 1, Math.floor((90 - lat) / 180 * H));
  probe.drawImage(img, x - r, y - r, n, n, 0, 0, n, n);
  const d = probe.getImageData(0, 0, n, n).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 128) return true;
  return false;
}

// Country borders past k 40, where the app stops drawing them over tiles: 28 km cells alone show no geography.
// The same 1:50m atlas the app loads (so usually from the browser cache), fetched the first time it is needed.
// shortcut: duplicates the app's border stroke; drop this once app.js keeps borders for types that ask (keepLines).
const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
let lines = null, linesLoading = false;
function loadBorders(api) {
  linesLoading = true;
  fetch(ATLAS).then(r => r.json()).then(t => {
    const m = topojson.mesh(t, t.objects.countries, (a, b) => a !== b);
    lines = m.coordinates.map(l => {
      const c = d3.geoCentroid({ type: 'MultiPoint', coordinates: l });
      return { l, c, r: d3.max(l, p => d3.geoDistance(c, p)) };
    });
    api.draw();
  }).catch(() => { linesLoading = false; });
}
const overlay = {
  load: () => {},
  draw(api) {
    if (api.k < 40) return;
    if (!lines) { if (!linesLoading) loadBorders(api); return; }
    const [tx, ty] = api.proj.translate(), s = api.proj.scale();
    const corner = Math.max(Math.hypot(tx, ty), Math.hypot(api.w - tx, ty), Math.hypot(tx, api.h - ty), Math.hypot(api.w - tx, api.h - ty));
    const R = corner >= s ? Math.PI / 2 : Math.asin(corner / s);
    const seen = lines.filter(x => d3.geoDistance(api.center, x.c) - x.r < R + 0.01).map(x => x.l);
    if (!seen.length) return;
    const { ctx } = api;
    ctx.beginPath(); api.path({ type: 'MultiLineString', coordinates: seen });
    ctx.lineJoin = 'round';
    ctx.strokeStyle = api.C.halo; ctx.lineWidth = 2; ctx.stroke();
    ctx.strokeStyle = api.C.border; ctx.lineWidth = 0.8; ctx.stroke();
  }
};

const fmtLat = v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'N' : 'S'}`, fmtLon = v => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'E' : 'W'}`;

// The key: one cell per class, colder to warmer, zone numbers under each pair, °C where 1a starts and 13b ends.
function ramp() {
  const cells = PALETTE.map((c, k) => `<rect x="${k * 10}" y="13" width="10" height="11" fill="${c}"/>`).join('');
  const nums = PALETTE.slice(0, 13).map((_, i) => `<text x="${(i + 1) * 20}" y="37" text-anchor="middle">${i + 1}</text>`).join('');
  return `<svg width="100%" viewBox="0 0 280 40" style="display:block;max-width:280px;margin-bottom:6px" font-size="11" fill="currentColor" role="img" aria-label="Zones 1 to 13, from ${degC(-60)} °C to ${degC(70)} °C">
    <text x="10" y="9">${degC(-60)} °C</text><text x="270" y="9" text-anchor="end">${degC(70)} °C</text>
    <path d="M10 10V24M270 10V24" stroke="currentColor" stroke-width="0.8"/>${cells}${nums}</svg>`;
}

export default {
  id: 'hardiness', name: 'Plant hardiness zones', group: 'Weather and life',
  credit: 'Zones computed from ERA5 TNn 1991–2020 via the <a href="https://climateknowledgeportal.worldbank.org/">World Bank Climate Change Knowledge Portal</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>); contains modified Copernicus Climate Change Service information 2026. Coast: <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
  layers: () => [{ src: source }],
  vector: 'lines', click: 'point', overlay, ownsColour: true,
  setup(api) { API = api; },
  async query([lon, lat]) {
    let d, img;
    try { [d, img] = await Promise.all([tnnGrid(), zonesImage()]); }
    catch { return [['Hardiness zone', 'The zone data did not load. Try again in a moment.']]; }
    // The 1:50m coast is generalised, so harbour towns can fall just outside it: accept land within 2 px (0.125°).
    const off = !landNear(img, lon, lat, 0);
    if (off && !landNear(img, lon, lat, 2)) return [['Hardiness zone', 'None: zones are shown for land only.']];
    const col = Math.round((lon + 180) / STEP) % COLS, row = Math.max(0, Math.min(ROWS - 1, Math.round((90 - lat) / STEP)));
    const p = (row * COLS + col) * 4, v = d[p] * 256 + d[p + 1];
    if (!v) return [['Hardiness zone', 'No data for this grid cell.']];
    const c = (v - 1000) / 10, k = classOf(c);
    return [
      ['Hardiness zone', nameOf(k)],
      ['Zone range', `coldest night ${rangeOf(k)[0]} (${rangeOf(k)[1]})`],
      ['Coldest night, 1991–2020 average', `${neg(c.toFixed(1))} °C (${neg((c * 9 / 5 + 32).toFixed(1))} °F)`],
      ['Grid cell', `0.25° (about 28 km) centred on ${fmtLat(90 - row * STEP)}, ${fmtLon(col * STEP - 180)}; modelled (ERA5 reanalysis)`],
      ...(off ? [['Note', 'This point is just off the simplified coastline drawn here; the value is for the grid cell it falls in.']] : [])
    ];
  },
  legend: () => `${failed ? '<p class="note keep">The zone map did not load. Move the map or reload the page to try again.</p>' : ''}${ramp()}
    <p>Zone halves: a colder, b warmer</p>`
};

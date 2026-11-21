// Volcanic hazard: every Holocene volcano in the Smithsonian GVP's Volcanoes of the World, coloured by its last
// known eruption or by its GAR15 hazard class. GVP has no CORS, so scripts/build_volcanoes.py snapshots it
// (with the GAR15 join and GVP's population counts) into one 220 KB file, loaded the first time the map is shown.
/* global d3 */

const DATA = new URL('../../data/maps/volcanoes/volcanoes.json', import.meta.url);
import { MAP_FONT } from '../fonts.js';
const LABEL_FONT = `italic 500 13px ${MAP_FONT}`;
const GVP_PAGE = n => `https://volcano.si.edu/volcano.cfm?vn=${n}`;

// Ordered classes, oldest or lowest first (drawn first, so recent and high sit on top). c: null = no value, drawn hollow.
// Both use ColorBrewer YlOrRd (only one shows at a time), which reads in order by lightness alone and keeps
// Class III clear of the violet Military bases triangles.
const PERIODS = [
  { c: null, label: 'No dated eruption', test: y => y == null },
  { c: '#fecc5c', label: 'Before 1500', test: y => y < 1500 },
  { c: '#fd8d3c', label: '1500 to 1899', test: y => y < 1900 },
  { c: '#f03b20', label: '1900 to 1963', test: y => y < 1964 },
  { c: '#bd0026', label: '1964 or later', test: () => true }
];
const HAZARDS = [
  { c: null, label: 'Not in the GAR15 list', test: h => h == null },
  { c: null, label: 'Not classified', test: h => h === 0 },
  { c: '#fed976', label: 'Class I (lowest)', test: h => h === 1 },
  { c: '#fd8d3c', label: 'Class II', test: h => h === 2 },
  { c: '#bd0026', label: 'Class III (highest)', test: h => h === 3 }
];
// Unit vector of [lon, lat], for a cheap horizon test (dot product with the view centre).
const xyz = ([lo, la]) => {
  const l = lo * Math.PI / 180, p = la * Math.PI / 180, c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
};
const LIM = Math.sin(0.02); // same as the app's visible(): geoDistance < PI/2 - 0.02
const facing = api => { const [x, y, z] = xyz(api.center); return v => v.u[0] * x + v.u[1] * y + v.u[2] * z > LIM; };
const EVIDENCE = {
  'Eruption Observed': 'An eruption was seen and recorded',
  'Eruption Dated': 'An eruption has been dated by scientific methods',
  'Evidence Credible': 'Holocene activity is likely but no eruption is dated',
  'Evidence Uncertain': 'Holocene activity is uncertain',
  'Unrest / Holocene': 'Unrest in the Holocene, no confirmed eruption'
};

let volcanoes = [], meta = null, mode = 'last';
const classes = () => (mode === 'last' ? PERIODS : HAZARDS);
const classOf = v => classes().findIndex(k => k.test(mode === 'last' ? v.last : v.vhi));

const yearText = y => (y < 0 ? `${(-y).toLocaleString('en')} BCE` : y < 1000 ? `${y} CE` : String(y));
const num = n => n.toLocaleString('en');

let loading = null;
function load() {
  loading ||= fetch(DATA).then(r => { if (!r.ok) throw new Error(`volcanoes ${r.status}`); return r.json(); }).then(d => {
    meta = d;
    volcanoes = d.rows.map(r => Object.fromEntries(d.cols.map((c, i) => [c, r[i]])));
    for (const v of volcanoes) { v.at = [v.lon, v.lat]; v.u = xyz(v.at); }
    // Newest eruptions last, so they are drawn on top and win label space.
    volcanoes.sort((a, b) => (a.last ?? -1e5) - (b.last ?? -1e5));
  });
  loading.catch(() => { loading = null; });
  return loading;
}

// An upward triangle centred on (x, y), s pixels tall.
function tri(ctx, x, y, s) {
  ctx.moveTo(x, y - s * 0.6);
  ctx.lineTo(x + s * 0.58, y + s * 0.4);
  ctx.lineTo(x - s * 0.58, y + s * 0.4);
  ctx.closePath();
}
const sizeAt = k => Math.min(14, 6 + 1.6 * Math.log2(Math.max(1, k)));

function draw(api) {
  const { ctx, proj, C } = api, s = sizeAt(api.k), ks = classes();
  const shown = [], groups = ks.map(() => []), seen = facing(api);
  for (const v of volcanoes) {
    if (!seen(v)) continue;
    const [x, y] = proj(v.at);
    if (x < -s || y < -s || x > api.w + s || y > api.h + s) continue;
    groups[classOf(v)].push([x, y]);
    shown.push([v, x, y]);
  }
  ctx.lineJoin = 'round';
  groups.forEach((pts, i) => {
    if (!pts.length) return;
    ctx.beginPath();
    for (const [x, y] of pts) tri(ctx, x, y, s);
    if (ks[i].c) { ctx.fillStyle = ks[i].c; ctx.fill(); ctx.lineWidth = 0.8; ctx.strokeStyle = C.text; ctx.stroke(); }
    else { ctx.fillStyle = C.land; ctx.fill(); ctx.lineWidth = 1.3; ctx.strokeStyle = C.muted; ctx.stroke(); }
  });

  // Names once a region fills the window; newest eruptions first, none that would overlap.
  if (api.k < 8 || api.moving) return;
  const boxes = [];
  ctx.font = LABEL_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (let i = shown.length - 1; i >= 0 && boxes.length < 150; i--) {
    const [v, x, y] = shown[i], tx = x + s * 0.7, w = ctx.measureText(v.name).width;
    const b = [tx - 2, y - 8, tx + w + 2, y + 8];
    if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
    boxes.push(b);
    ctx.lineWidth = 2.5; ctx.strokeStyle = C.halo; ctx.strokeText(v.name, tx, y);
    ctx.fillStyle = C.text; ctx.fillText(v.name, tx, y);
  }
}

function rowsFor(v, esc) {
  // The name first: a volcano reopened from a shared address gets only these rows, under the country's name.
  const rows = [['Volcano', `${esc(v.name)} <span class="yr">GVP volcano ${v.n}</span>`],
    ['Country', esc(v.country)], ['Type', esc(v.type || 'Not recorded')]];
  if (v.elev != null) rows.push(['Summit', `${num(Math.abs(v.elev))} m ${v.elev < 0 ? 'below' : 'above'} sea level <span class="yr">highest point; the height below is the terrain model at the clicked spot</span>`]);
  rows.push(['Last known eruption', v.last == null ? 'No dated eruption' : yearText(v.last)]);
  if (EVIDENCE[v.evidence]) rows.push(['Evidence', EVIDENCE[v.evidence]]);
  if (v.setting) rows.push(['Tectonic setting', esc(v.setting)]);
  if (v.rock) rows.push(['Main rock type', esc(v.rock)]);
  const vhi = v.vhi == null ? 'Not in the GAR15 list'
    : v.vhi ? ['Class I, the lowest of three', 'Class II, the middle of three', 'Class III, the highest of three'][v.vhi - 1]
      : 'Not classified: too little eruption history to score it. This does not mean the volcano is safe.';
  rows.push(['Hazard index', `${vhi}<br><span class="yr">GAR15 (2015). Use it to compare volcanoes; for safety, follow the local volcano observatory.</span>`]);
  if (v.pei) rows.push(['Population exposure', `${v.pei} on a scale of 1 (few people nearby) to 7 (most) <span class="yr">GAR15 (2015)</span>`]);
  if (v.p10 != null) {
    rows.push(['People living within', `10 km: ${num(v.p10)}<br>30 km: ${num(v.p30)}<br>100 km: ${num(v.p100)}<br><span class="yr">GVP estimate; the year of the population data is not stated</span>`]);
  }
  rows.push(['More', `<a href="${GVP_PAGE(v.n)}" target="_blank" rel="noopener">GVP page for ${esc(v.name)}</a>: eruption history, photos, reports`]);
  return rows;
}

function pick(x, y, api) {
  let best = null, bd = Math.max(10, sizeAt(api.k));
  const seen = facing(api);
  for (const v of volcanoes) {
    if (!seen(v)) continue;
    const [px, py] = api.proj(v.at), d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = v; }
  }
  if (!best) return null;
  // Its rows come from query(), so a volcano reopened from the address shows them too.
  return { title: best.name, sub: `${best.type || 'Volcano'}, ${best.country}`, at: best.at, rows: [] };
}

// On a volcano: its details. Anywhere else: the nearest one and how far it is.
async function query(at, api) {
  try { await load(); } catch { return [['Volcanoes', 'The volcano data did not load. Try again in a moment.']]; }
  let best = null, bd = Infinity;
  for (const v of volcanoes) { const d = d3.geoDistance(at, v.at); if (d < bd) { bd = d; best = v; } }
  const km = bd * 6371;
  if (km < 0.5) return rowsFor(best, api.esc);
  return [['Nearest Holocene volcano', `${api.esc(best.name)}, ${api.esc(best.country)}: ${num(Math.round(km))} km away`]];
}

function legend() {
  const counts = classes().map(() => 0);
  for (const v of volcanoes) counts[classOf(v)]++;
  const n = i => (volcanoes.length ? ` (${num(counts[i])})` : '');
  const items = classes().map((k, i) => `<li><i style="--c:${k.c || 'var(--land)'}"></i>${k.label}${n(i)}</li>`).reverse().join('');
  return `<ul class="swatches">${items}</ul>`;
}

function setup(api) {
  api.tools.innerHTML = `<fieldset class="seg"><legend>Colour volcanoes by</legend>
    <label><input type="radio" name="volcColour" value="last"${mode === 'last' ? ' checked' : ''}><span>Last eruption</span></label>
    <label><input type="radio" name="volcColour" value="vhi"${mode === 'vhi' ? ' checked' : ''}><span>Hazard index</span></label></fieldset>`;
  api.tools.querySelector('fieldset').addEventListener('change', e => { mode = e.target.value; api.refresh(); });
}

export default {
  id: 'volcanoes', name: 'Volcanic hazard', group: 'Earth science', dataMap: true,
  // A getter, so Sources shows the copy date once the data has loaded.
  get credit() {
    return `Volcanoes: Global Volcanism Program, <a href="https://doi.org/10.5479/si.GVP.VOTW5-2026.5.4">Volcanoes of the World v. 5.4.0</a> (7 Aug 2026${meta ? `, copied ${meta.fetched}` : ''}), Smithsonian Institution, for personal, educational and non-commercial use (<a href="https://volcano.si.edu/gvp_termsofuse.cfm">terms</a>). Hazard index and population exposure: GVM and IAVCEI for UNISDR <a href="https://data.humdata.org/dataset/a60ac839-920d-435a-bf7d-25855602699d">GAR15</a> (2015), free for non-commercial use`;
  },
  layers: () => [], vector: 'full', click: 'point',
  query, legend, setup,
  overlay: { load: api => load().then(() => api.refresh()), draw, pick }
};

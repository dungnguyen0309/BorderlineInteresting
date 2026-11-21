// Species distribution: where records of one chosen species (or genus, family…) have been made, from GBIF.
// Counts per hexagon come as raster tiles from the GBIF Maps API (EPSG:4326, which drapes on the 'geo' grid);
// the species picker, the record counts and the click details come from the GBIF species and occurrence APIs.
// Everything is keyless and sent with CORS, so nothing is built or stored here.

const API = 'https://api.gbif.org/v1';
const BACKBONE = 'd7dddbf4-2cf0-4f39-9b2a-bb099caae36c'; // the GBIF Backbone Taxonomy
const D2R = Math.PI / 180;
const HEX_PER_TILE = 32; // 512 px tiles, so a hexagon is about 16 px across on screen at any zoom

// Record types. "Living specimens" are zoo, aquarium and botanic garden holdings, so they are left out by default.
const BASIS = {
  PRESERVED_SPECIMEN: 'Museum or herbarium specimen', FOSSIL_SPECIMEN: 'Fossil', LIVING_SPECIMEN: 'Zoo or garden specimen',
  OBSERVATION: 'Observation', HUMAN_OBSERVATION: 'Observation by a person', MACHINE_OBSERVATION: 'Camera trap or sensor',
  MATERIAL_SAMPLE: 'Sample (for example DNA)', LITERATURE: 'Published literature', MATERIAL_CITATION: 'Cited specimen',
  OCCURRENCE: 'Record (type not given)', UNKNOWN: 'Record (type unknown)'
};
const FILTERS = [
  { id: 'wild', name: 'All except fossils, zoos, gardens', basis: Object.keys(BASIS).filter(b => b !== 'FOSSIL_SPECIMEN' && b !== 'LIVING_SPECIMEN') },
  { id: 'all', name: 'All records', basis: [] },
  { id: 'people', name: 'Observations by people', basis: ['HUMAN_OBSERVATION'] },
  { id: 'specimens', name: 'Museum and herbarium records', basis: ['PRESERVED_SPECIMEN'] },
  { id: 'machines', name: 'Camera traps and sensors', basis: ['MACHINE_OBSERVATION'] },
  { id: 'fossils', name: 'Fossils', basis: ['FOSSIL_SPECIMEN'] }
];
// The classic.poly ramp, with the class limits GBIF documents for it (records per hexagon).
const RAMP = [['#ffff00', '1 to 10'], ['#ffcc00', '11 to 100'], ['#ff9900', '101 to 1,000'], ['#ff6600', '1,001 to 10,000'],
  ['#d60a00', '10,001 to 100,000'], ['#c2002d', 'More than 100,000']];

const S = {
  sp: { key: 5219243, sci: 'Vulpes vulpes', common: 'Red fox', rank: 'SPECIES' },
  filter: 'wild', info: null, api: null, results: [], seq: 0
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Number(n).toLocaleString('en');
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const basisQuery = () => FILTERS.find(f => f.id === S.filter).basis.map(b => `&basisOfRecord=${b}`).join('');
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// Tile sources, one per species, filter and pixel density (the engine caches tiles by source id).
const hi = () => (globalThis.devicePixelRatio || 1) >= 1.5;
const sources = new Map();
function source(id, url) {
  if (!sources.has(id)) sources.set(id, { id, scheme: 'geo', tileSize: hi() ? 1024 : 512, maxZoom: 14, url, load });
  return sources.get(id);
}
// A tile with no records comes back as 204 No Content: draw it as empty, so a coarser tile does not stand in.
const blank = document.createElement('canvas');
blank.width = blank.height = 1;
async function load(url) {
  const r = await fetch(url).catch(() => null);
  if (r?.status === 204) return blank;
  if (!r?.ok) {
    // Say so in the legend when record tiles fail, so an empty map is not read as "no records".
    if (url.includes('/v2/map/') && !S.tileFail) { S.tileFail = true; S.api?.refresh(); }
    throw new Error(`tile ${r?.status ?? 'network error'}`);
  }
  return createImageBitmap(await r.blob());
}
function densitySource() {
  const r = hi() ? '@2x' : '@1x', q = `taxonKey=${S.sp.key}${basisQuery()}`;
  return source(`gbif-${S.sp.key}-${S.filter}${r}`, (z, x, y) =>
    `https://api.gbif.org/v2/map/occurrence/density/${z}/${x}/${y}${r}.png?srs=EPSG:4326&bin=hex&hexPerTile=${HEX_PER_TILE}&style=classic.poly&${q}`);
}
// Dark bases keep the yellow classes readable; at city zoom (k 300 and up) a dark style with roads and place names.
const baseSource = (dark, k) => {
  const style = k >= 300 ? 'gbif-tuatara' : dark ? 'gbif-dark' : 'gbif-middle', r = hi() ? '@2x' : '@1x';
  return source(`gbif-base-${style}${r}`, (z, x, y) => `https://tile.gbif.org/4326/omt/${z}/${x}/${y}${r}.png?style=${style}`);
};

// How many records the current species and filter have, and from which years (for the legend).
// The occurrence API, not the map's capabilities.json, which ignores basisOfRecord.
async function loadInfo() {
  const seq = ++S.seq;
  S.info = null;
  S.tileFail = false;
  try {
    const d = await getJSON(`${API}/occurrence/search?taxonKey=${S.sp.key}${basisQuery()}&occurrenceStatus=PRESENT&hasCoordinate=true&hasGeospatialIssue=false&limit=0&facet=year&facetLimit=1000`);
    const ys = (d.facets[0]?.counts || []).map(c => +c.name);
    if (seq === S.seq) S.info = { total: d.count, minYear: ys.length ? Math.min(...ys) : null, maxYear: ys.length ? Math.max(...ys) : null };
  } catch (e) { console.warn(e); if (seq === S.seq) S.info = { failed: true }; }
  if (seq === S.seq) S.api?.refresh();
}

// ---------- species picker ----------

// Common-name hits are many and loosely ranked by GBIF, so they are ordered by how many records each species has.
async function findSpecies(q) {
  const enc = encodeURIComponent(q);
  const [s1, s2] = await Promise.allSettled([
    getJSON(`${API}/species/suggest?datasetKey=${BACKBONE}&limit=8&q=${enc}`),
    getJSON(`${API}/species/search?datasetKey=${BACKBONE}&status=ACCEPTED&rank=SPECIES&qField=VERNACULAR&limit=40&q=${enc}`)
  ]);
  if (s1.status === 'rejected' && s2.status === 'rejected') throw s1.reason;
  const sug = s1.value || [], ver = s2.value || { results: [] };
  let common = [];
  if (ver.results.length) {
    const f = await getJSON(`${API}/occurrence/search?limit=0&facet=speciesKey&facetLimit=6&${ver.results.map(r => `speciesKey=${r.key}`).join('&')}`)
      .catch(() => ({ facets: [] }));
    const counts = new Map((f.facets[0]?.counts || []).map(c => [+c.name, c.count]));
    const word = q.toLowerCase();
    common = ver.results.filter(r => counts.has(r.key)).map(r => {
      const names = (r.vernacularNames || []).filter(v => v.language === 'eng').map(v => v.vernacularName);
      return { key: r.key, sci: r.canonicalName, rank: r.rank, common: cap(names.find(n => n.toLowerCase().includes(word)) || names[0]), n: counts.get(r.key) };
    }).sort((a, b) => b.n - a.n);
  }
  // suggest matches loosely (a virus class for "red deer"), so keep names that contain the first word typed.
  const first = q.toLowerCase().split(/\s+/)[0];
  const sci = sug.filter(r => r.status === 'ACCEPTED' && r.canonicalName?.toLowerCase().includes(first)).map(r => ({ key: r.key, sci: r.canonicalName, rank: r.rank, group: r.class || r.kingdom }));
  const seen = new Set();
  return [...common, ...sci].filter(r => !seen.has(r.key) && seen.add(r.key)).slice(0, 5);
}

const rankName = r => (r && r !== 'SPECIES' ? cap(r.toLowerCase()) : '');
function resultHTML(r, i) {
  const what = [r.common ? `<i>${esc(r.sci)}</i>` : '', rankName(r.rank), r.group, r.n ? `${num(r.n)} records` : ''].filter(Boolean).join(', ');
  return `<li><button type="button" data-i="${i}" style="width:100%;text-align:left">${r.common ? esc(r.common) : `<i>${esc(r.sci)}</i>`}${what ? `<br><small style="color:var(--muted)">${what}</small>` : ''}</button></li>`;
}

// The species shown is named in the key's count line; under the search only its page link stays.
function nowHTML() {
  const sp = S.sp, label = sp.common ? esc(sp.common) : `<i>${esc(sp.sci)}</i>`;
  return `<a href="https://www.gbif.org/species/${sp.key}" target="_blank" rel="noopener">${label} on GBIF</a>`;
}

async function choose(r, root) {
  S.sp = { key: r.key, sci: r.sci, common: r.common, rank: r.rank };
  root.querySelector('#spQ').value = '';
  root.querySelector('#spList').innerHTML = '';
  root.querySelector('#spMsg').textContent = '';
  root.querySelector('#spNow').innerHTML = nowHTML();
  loadInfo();
  S.api?.refresh();
  // A pick from the scientific list has no common name yet: GBIF's preferred English one, when it has one.
  if (!r.common) {
    const d = await getJSON(`${API}/species/${r.key}`).catch(() => null);
    if (d?.vernacularName && S.sp.key === r.key) { S.sp.common = cap(d.vernacularName); root.querySelector('#spNow').innerHTML = nowHTML(); S.api?.refresh(); }
  }
}

function setup(api) {
  S.api = api;
  const root = api.tools;
  const box = 'width:100%;box-sizing:border-box;padding:0 8px;color:inherit;background:var(--panel);border:1px solid var(--field);border-radius:6px';
  root.innerHTML = `
    <label for="spQ" class="field" style="margin-top:10px">Species</label>
    <input id="spQ" type="search" autocomplete="off" spellcheck="false" placeholder="Common or scientific name" aria-describedby="spNow" style="${box}">
    <p id="spMsg" class="note" role="status" style="margin:4px 0 0"></p>
    <ul id="spList" aria-label="Matching species" style="list-style:none;margin:4px 0 0;padding:0;display:grid;gap:4px"></ul>
    <p id="spNow" class="note">${nowHTML()}</p>
    <label for="spBasis" class="field" style="margin-top:10px">Records</label>
    <select id="spBasis">${FILTERS.map(f => `<option value="${f.id}"${f.id === S.filter ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`;
  const input = root.querySelector('#spQ'), list = root.querySelector('#spList'), msg = root.querySelector('#spMsg');
  let timer = 0, ask = 0;
  // shortcut: scrolls the list into the Map card, which shared layoutChrome caps in height; upgrade if that card learns to grow.
  const show = rs => { S.results = rs; list.innerHTML = rs.map(resultHTML).join(''); list.lastElementChild?.scrollIntoView({ block: 'nearest' }); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { show([]); msg.textContent = q ? 'Type at least 3 letters.' : ''; return; }
    timer = setTimeout(async () => {
      const mine = ++ask;
      msg.textContent = 'Searching…';
      try {
        const rs = await findSpecies(q);
        if (mine !== ask) return;
        show(rs);
        msg.textContent = rs.length ? `${rs.length} ${rs.length === 1 ? 'match' : 'matches'}. Choose one to map it.` : 'No species found with that name.';
      } catch (e) { console.warn(e); if (mine === ask) msg.textContent = 'The species search did not respond. Try again.'; }
    }, 300);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && S.results.length) { e.preventDefault(); choose(S.results[0], root); }
    else if (e.key === 'ArrowDown' && S.results.length) { e.preventDefault(); list.querySelector('button')?.focus(); }
    else if (e.key === 'Escape' && (input.value || S.results.length)) { e.stopPropagation(); input.value = ''; show([]); msg.textContent = ''; }
  });
  list.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) choose(S.results[+b.dataset.i], root); });
  list.addEventListener('keydown', e => {
    const bs = [...list.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i < bs.length - 1) { e.preventDefault(); bs[i + 1].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (i > 0 ? bs[i - 1] : input).focus(); }
    else if (e.key === 'Escape') { e.stopPropagation(); input.focus(); }
  });
  root.querySelector('#spBasis').addEventListener('change', e => { S.filter = e.target.value; loadInfo(); api.refresh(); });
  if (!S.info) loadInfo();
}

// ---------- legend ----------

function legend() {
  const i = S.info, f = FILTERS.find(x => x.id === S.filter);
  const name = S.sp.common ? `${esc(S.sp.common)} (<i>${esc(S.sp.sci)}</i>)` : `<i>${esc(S.sp.sci)}</i>`;
  const what = rankName(S.sp.rank) ? `${rankName(S.sp.rank)} ${name}` : name;
  const total = !i ? `${what}: counting records…` : i.failed ? `${what}: the record count did not load.`
    : i.total ? `${what}: ${num(i.total)} records with map coordinates, ${i.minYear ?? '?'} to ${i.maxYear ?? '?'}. ${esc(f.name)}.`
      : `${what}: no records with map coordinates for this filter (${esc(f.name.toLowerCase())}).`;
  // GBIF draws hexagons at 90% opacity, so the swatches match.
  return `<p class="note keep">${total}</p>
    <p>Records per hexagon</p>
    <ul class="swatches ord">${RAMP.slice().reverse().map(([c, t]) => `<li><i style="--c:${c};opacity:.9"></i>${t}</li>`).join('')}</ul>
    ${S.tileFail ? '<p class="note keep">The record tiles did not load, so places with records may show no hexagons. Try again in a moment.</p>' : ''}`;
}

// ---------- click: records near a point ----------

const datasets = new Map();
const datasetTitle = key => {
  if (!datasets.has(key)) datasets.set(key, getJSON(`${API}/dataset/${key}`).then(d => d.title).catch(() => null));
  return datasets.get(key);
};
const span = d => (d >= 1 ? `${num(Math.round(d))} km` : `${num(Math.round(d * 1000))} m`);

async function query([lon, lat], api) {
  const sp = S.sp;
  // A box about 20 screen pixels across, so a click covers roughly one hexagon at any zoom.
  const h = Math.min(3, Math.max(0.0005, 10 * 180 / (Math.PI * api.proj.scale())));
  const w = Math.min(180, h / Math.max(0.05, Math.cos(lat * D2R)));
  // shortcut: the box is clipped at the 180° meridian rather than split in two; fine away from Fiji and the Bering Strait.
  const [W, E, S_, N] = [Math.max(-180, lon - w), Math.min(180, lon + w), Math.max(-90, lat - h), Math.min(90, lat + h)].map(v => +v.toFixed(5));
  const where = `taxonKey=${sp.key}${basisQuery()}&occurrenceStatus=PRESENT&hasCoordinate=true&hasGeospatialIssue=false&decimalLatitude=${S_},${N}&decimalLongitude=${W},${E}`;
  const across = span(2 * h * 111.32);
  const wkt = `POLYGON((${W} ${S_},${E} ${S_},${E} ${N},${W} ${N},${W} ${S_}))`;
  const site = `https://www.gbif.org/occurrence/search?taxon_key=${sp.key}&occurrence_status=present&geometry=${encodeURIComponent(wkt)}${FILTERS.find(f => f.id === S.filter).basis.map(b => `&basis_of_record=${b}`).join('')}`;
  const name = sp.common || sp.sci;
  let head;
  try { head = await getJSON(`${API}/occurrence/search?${where}&limit=0&facet=year&facetLimit=1000`); }
  catch (e) { console.warn(e); return [['Records', 'GBIF did not respond, so the records here did not load. Try again in a moment.']]; }
  const rows = [['Records here', head.count ? `${num(head.count)} of ${esc(name)} in a box about ${across} across` : `None of ${esc(name)} in a box about ${across} across, with the current filter`]];
  if (!head.count) return rows;
  const years = (head.facets[0]?.counts || []).map(c => [+c.name, c.count]).sort((a, b) => b[0] - a[0]);
  if (years.length) rows.push(['Years', `${years.at(-1)[0]} to ${years[0][0]}${years.reduce((s, y) => s + y[1], 0) < head.count ? ' (some records have no year)' : ''}`]);
  // The most recent years that hold at least five records, then the newest five records in them.
  let from = years[0]?.[0], got = 0;
  for (const [y, n] of years) { from = y; got += n; if (got >= 5) break; }
  try {
    const recs = await getJSON(`${API}/occurrence/search?${where}&limit=50${years.length ? `&year=${from},${years[0][0]}` : ''}`);
    const latest = recs.results.sort((a, b) => String(b.eventDate || b.year || '').localeCompare(String(a.eventDate || a.year || ''))).slice(0, 5);
    const titles = await Promise.all(latest.map(r => (r.datasetName ? r.datasetName : datasetTitle(r.datasetKey))));
    latest.forEach((r, i) => {
      const date = r.eventDate ? String(r.eventDate).slice(0, 10) : r.year ? String(r.year) : 'No date';
      rows.push([date, `<a href="https://www.gbif.org/occurrence/${r.key}" target="_blank" rel="noopener">${esc(BASIS[r.basisOfRecord] || r.basisOfRecord)}</a>, ${esc(titles[i] || 'unnamed dataset')}`]);
    });
  } catch (e) { console.warn(e); rows.push(['Latest records', 'Did not load. Try again in a moment.']); }
  rows.push(['On GBIF', `<a href="${site}" target="_blank" rel="noopener">All ${num(head.count)} records here</a>`]);
  return rows;
}

export default {
  id: 'species', name: 'Species distribution', group: 'Weather and life', dataMap: true,
  ownsColour: true,
  credit: 'Occurrence records: <a href="https://www.gbif.org">GBIF.org</a> and its data publishers, each record under CC0 1.0, CC BY 4.0 or CC BY-NC 4.0 (<a href="https://www.gbif.org/terms">terms</a>). Base map: <a href="https://tile.gbif.org/ui/">GBIF</a>, © <a href="https://openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  onMap: '© <a href="https://www.openmaptiles.org/copyright">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  layers: ({ dark, k }) => [{ src: baseSource(dark, k) }, { src: densitySource() }],
  vector: 'lines', click: 'point', setup, legend, query
};

// Time zones: one area per IANA zone (timezone-boundary-builder 2026f, built from OpenStreetMap, simplified by
// scripts/build_timezones.py). Offsets, daylight saving and local times come from the browser's own time-zone
// data (Intl), so the colours follow clock changes without a rebuild.
// The zones are painted into map tiles in the browser (lon/lat tiles, cached and draped by the engine), so dragging
// costs nothing extra; only the offset labels are drawn per frame. The sea is left plain, with the 15° bands of
// nautical time as dashed lines.

const DATA = name => new URL(`../../data/maps/timezones/${name}`, import.meta.url);
const HI_Z = 5; // tiles from this level (11° and smaller) use the finer file, fetched on first need
const HI_K = 4; // labels follow the finer file from about this zoom
const TILE = 256;
const DAY = 864e5;

// ---- Offsets from the browser's time-zone data --------------------------------------------------------------
const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) {
    let f = null;
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }); } catch { /* zone unknown to this browser */ }
    fmts.set(tz, f);
  }
  return fmts.get(tz);
}
// Minutes ahead of UTC at time t, or null when the browser does not know the zone.
function offsetAt(tz, t) {
  const f = fmt(tz);
  if (!f) return null;
  const s = f.formatToParts(t).find(p => p.type === 'timeZoneName').value; // "GMT", "GMT+05:30", "GMT-03:00"
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(s);
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}
const offText = m => {
  if (m == null) return 'Unknown';
  const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
  return `UTC${m < 0 ? '−' : '+'}${h}${mm ? ':' + String(mm).padStart(2, '0') : ''}`;
};
// Stepped by the hour from UTC−12 to UTC+14: the hue moves along the range, and whole hours alternate light and
// dark so neighbouring zones stay apart without relying on hue alone. Half hours are strong, quarter hours nearly
// grey, both at a middle lightness that also alternates by hour (neighbours at least 14 CIELAB ΔE apart).
function colour(m, dark) {
  if (m == null) return dark ? '#5a5a5a' : '#c4c4c4';
  const h = m / 60, whole = Math.floor(h), hue = 15 + ((h + 12) / 26) * 300;
  if (h === whole) return d3.hcl(hue, 38, dark ? (whole % 2 ? 31 : 45) : (whole % 2 ? 66 : 83)).formatHex();
  const odd = Math.abs(whole) % 2 ? 5 : -5;
  return d3.hcl(hue, (m % 60 + 60) % 60 === 30 ? 52 : 16, (dark ? 34 : 72) + odd).formatHex();
}

// ---- Data --------------------------------------------------------------------------------------------------
let lo = null, hi = null, hiLoading = null, offs = new Map(), stamp = 0, version = 0;

// Planar lon/lat box [west, south, east, north] of a list of points.
function boxOf(pts) {
  const b = [180, 90, -180, -90];
  for (const [x, y] of pts) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  return b;
}
// Mesh lines cut into short runs, so a tile only draws the runs that cross it.
const runs = mesh => mesh.coordinates.flatMap(l => d3.range(0, l.length - 1, 100).map(i => l.slice(i, i + 101)))
  .map(l => ({ l, box: boxOf(l) }));

function prep(topo) {
  const obj = topo.objects.zones;
  const feats = topojson.feature(topo, obj).features.filter(f => f.geometry).map(f =>
    Object.assign(f, { tz: f.properties.tzid, label: [f.properties.lx, f.properties.ly], area: d3.geoArea(f) }));
  feats.sort((a, b) => b.area - a.area); // big zones claim label space first
  const polys = feats.flatMap(f => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates)
    .map(p => ({ tz: f.tz, geo: { type: 'Polygon', coordinates: p }, box: boxOf(p[0]) })));
  return { topo, obj, feats, polys, coast: runs(topojson.mesh(topo, obj, (a, b) => a === b)), meshAt: -1 };
}
// Borders split by whether the clock changes across them; rebuilt only when an offset changes.
function borders(set) {
  if (set.meshAt !== version) {
    const off = g => offs.get(g.properties.tzid);
    set.diff = runs(topojson.mesh(set.topo, set.obj, (a, b) => a !== b && off(a) !== off(b)));
    set.same = runs(topojson.mesh(set.topo, set.obj, (a, b) => a !== b && off(a) === off(b)));
    set.meshAt = version;
  }
  return set;
}
// Offsets are read again once a minute, so a clock change shows up without a reload.
function updateOffsets() {
  const now = Date.now();
  if (now - stamp < 60e3 || !lo) return;
  stamp = now;
  let changed = false;
  for (const f of lo.feats) {
    const m = offsetAt(f.tz, now);
    if (offs.get(f.tz) !== m) { offs.set(f.tz, m); changed = true; }
  }
  if (changed) version++;
}

async function getJSON(name) {
  const r = await fetch(DATA(name));
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json();
}
// The finer file, once; on failure the light one stands in and a retry waits a minute.
let hiFailedAt = -Infinity, loadFailed = false;
function loadHi() {
  if (!hiLoading && Date.now() - hiFailedAt < 60e3) return Promise.resolve(lo);
  hiLoading ||= getJSON('zones-hi.json').then(t => (hi = prep(t))).catch(e => {
    if (hiFailedAt === -Infinity) console.warn(e);
    hiFailedAt = Date.now(); hiLoading = null; return lo;
  });
  return hiLoading;
}

// Every zone at a point, from the most detailed file loaded (the source overlaps a few on purpose, e.g. Ürümqi time).
function zonesAt([lon, lat]) {
  const set = hi || lo;
  if (!set) return [];
  const tzs = new Set(set.polys.filter(({ box: b, geo }) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3] && d3.geoContains(geo, [lon, lat])).map(p => p.tz));
  return [...tzs].map(tz => set.feats.find(f => f.tz === tz));
}
const zoneAt = at => zonesAt(at)[0] ?? null;

// Nautical time: 15° bands centred on each hour's meridian; the band at 180° is split by the date line.
const nauticalHours = lon => Math.max(-12, Math.min(12, Math.round(lon / 15)));
let seaLabels = null;
// A spot in open sea for each band's label, found once against the light file.
function findSeaLabels() {
  seaLabels = [];
  for (let n = -12; n <= 12; n++) {
    const lon = n === 12 ? 176 : n === -12 ? -176 : n * 15;
    const lat = [0, -12, 12, -24, 24, -36, 36, -48, 48].find(y => !zoneAt([lon, y]));
    if (lat != null) seaLabels.push({ at: [lon, lat], text: offText(n * 60) });
  }
}

// ---- Tiles -------------------------------------------------------------------------------------------------
// Lon/lat tiles: a straight grid, so a tile is the zones drawn flat, clipped to its box.
async function renderTile({ z, x, y }, dark, C) {
  await new Promise(r => setTimeout(r)); // one tile per task, so frames keep coming while a view fills in
  const set = borders(z >= HI_Z ? await loadHi() : lo);
  const w = 180 / 2 ** z, west = -180 + x * w, north = 90 - y * w, s = TILE / w;
  const c = document.createElement('canvas'); c.width = c.height = TILE;
  const g = c.getContext('2d');
  const path = d3.geoPath(d3.geoIdentity().reflectY(true).scale(s).translate([-west * s, north * s]).clipExtent([[-2, -2], [TILE + 2, TILE + 2]]), g);
  const hit = b => b[0] <= west + w && b[2] >= west && b[1] <= north && b[3] >= north - w;
  const px = lon => (lon - west) * s;
  g.lineJoin = 'round';

  // Sea: nautical band edges (dashed) and the date line, under the land.
  g.beginPath();
  for (let e = -172.5; e < 180; e += 15) if (e >= west - 1 && e <= west + w + 1) { g.moveTo(px(e), 0); g.lineTo(px(e), TILE); }
  g.setLineDash([4, 4]); g.strokeStyle = C.coast; g.lineWidth = 0.8; g.stroke(); g.setLineDash([]);
  if (west + w >= 179.9) { g.beginPath(); g.moveTo(TILE - 0.5, 0); g.lineTo(TILE - 0.5, TILE); g.strokeStyle = C.muted; g.stroke(); }
  if (west <= -179.9) { g.beginPath(); g.moveTo(0.5, 0); g.lineTo(0.5, TILE); g.strokeStyle = C.muted; g.stroke(); }

  // Land: one fill per offset, then borders: faint where two IANA zones keep the same time now, firm where the
  // clock changes, and the coast.
  for (const [m, ps] of d3.group(set.polys.filter(p => hit(p.box)), p => offs.get(p.tz))) {
    g.beginPath(); for (const p of ps) path(p.geo);
    g.fillStyle = colour(m, dark); g.fill();
  }
  const stroke = (ls, color, width, alpha = 1) => {
    g.beginPath(); path({ type: 'MultiLineString', coordinates: ls.filter(r => hit(r.box)).map(r => r.l) });
    g.globalAlpha = alpha; g.strokeStyle = color; g.lineWidth = width; g.stroke(); g.globalAlpha = 1;
  };
  if (z >= 3) stroke(set.same, C.border, 0.6, 0.5);
  stroke(set.coast, C.coast, 0.6);
  stroke(set.diff, C.border, z >= HI_Z ? 1.4 : 1);
  return c;
}
// One source per colour scheme and offset state, so a clock change or a theme switch paints fresh tiles.
const sources = new Map();
function source(dark) {
  const id = `timezones-${version}-${dark ? 'dark' : 'light'}`;
  if (!sources.has(id)) {
    // The tiles take their line colours from the page's own palette at the time they are painted.
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(`--${n}`).trim();
    const C = { muted: v('muted') || '#777', border: v('border') || '#555', coast: v('coast') || '#555' };
    sources.set(id, { id, scheme: 'geo', tileSize: TILE, maxZoom: 12, url: (z, x, y) => `${id}/${z}/${x}/${y}`, load: (url, t) => renderTile(t, dark, C) });
  }
  return sources.get(id);
}

// ---- Labels ------------------------------------------------------------------------------------------------
// Offsets are set in the interface's sans (figures, not place names) and placed in the app's label pass, before
// the country names, sharing its boxes so nothing overlaps.
const LABEL_FONT = '"Plus Jakarta Sans", system-ui, sans-serif';
function draw(api) {
  const { ctx, k, C, moving, boxes } = api;
  if (!moving && String(api.center) !== String(here)) { here = api.center; tick(); } // the key's clock follows the view once it stops
  if (moving && k < HI_K) return; // labels wait until the globe stops
  const set = k >= HI_K && hi ? hi : lo;
  const scale2 = api.proj.scale() ** 2;
  let placed = 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  const place = (text, at, color, size, dy = 0) => {
    if (at[0] == null || !api.visible(at)) return;
    const [x, y0] = api.proj(at), y = y0 + dy;
    if (x < 0 || y < 0 || x > api.w || y > api.h) return;
    ctx.font = `600 ${size}px ${LABEL_FONT}`;
    const half = ctx.measureText(text).width / 2 + 3, b = [x - half, y - size * 0.7, x + half, y + size * 0.7];
    if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) return;
    boxes.push(b); placed++;
    ctx.lineWidth = 2.5; ctx.strokeStyle = C.halo; ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  };
  for (const f of set.feats) {
    if (f.area * scale2 < 2500) break; // sorted by area: the rest are too small to label at this zoom
    place(offText(offs.get(f.tz)), f.label, C.text, 11, -16); // just above a country name at the same spot
  }
  // Zoomed in inside one zone, with no label in view: name the zone at the middle of the view.
  if (!placed && !moving) {
    const z = zoneAt(api.center);
    if (z) place(`${z.tz.replace(/_/g, ' ')}, ${offText(offs.get(z.tz))}`, api.center, C.text, 13, -24); // clear of a point marker
  }
  for (const s of seaLabels || []) place(s.text, s.at, C.muted, 11);
}

// ---- Point readout -----------------------------------------------------------------------------------------
// The next clock change within 18 months: a day-by-day scan, then a binary search down to the minute.
function scanYear(tz, now) {
  const o0 = offsetAt(tz, now);
  let lowest = o0, highest = o0, next = null;
  for (let t = now + DAY; t < now + 548 * DAY; t += DAY) {
    const o = offsetAt(tz, t);
    if (t < now + 366 * DAY) { lowest = Math.min(lowest, o); highest = Math.max(highest, o); }
    if (!next && o !== o0) {
      let a = t - DAY, b = Math.ceil(t / 60e3) * 60e3; // b on a whole minute, so mid always falls strictly between
      while (b - a > 60e3) { const mid = Math.floor((a + b) / 2 / 60e3) * 60e3; if (offsetAt(tz, mid) === o0) a = mid; else b = mid; }
      next = { at: b, from: o0, to: o };
    }
  }
  return { now: o0, lowest, highest, next };
}
const timeText = (tz, t, opts = {}) => new Intl.DateTimeFormat('en-GB', {
  timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, ...opts
}).format(t);

// Open panels and the key show a running clock: one timer while any clock is on the page.
let ticking = 0, here = null;
function tick() {
  const els = document.querySelectorAll('[data-tz-clock]'), key = document.querySelector('[data-tz-here]');
  if (!els.length && !key) { clearInterval(ticking); ticking = 0; return; }
  for (const el of els) el.textContent = timeText(el.dataset.tzClock, Date.now(), { second: '2-digit' });
  if (key) key.textContent = hereText();
}
// The local time at the middle of the view, for the key: the zone there, or nautical time at sea.
function hereText() {
  if (!here) return '';
  const z = zoneAt(here), n = nauticalHours(here[0]);
  const tz = z ? z.tz : n === 0 ? 'Etc/GMT' : `Etc/GMT${n > 0 ? '-' : '+'}${Math.abs(n)}`; // Etc signs are reversed
  const m = offsetAt(tz, Date.now());
  if (m == null) return `${z.tz.replace(/_/g, ' ')}, not known to this browser`;
  return `${timeText(tz, Date.now(), { year: undefined })}, ${z ? z.tz.replace(/_/g, ' ') : 'nautical time'} (${offText(m)})`;
}
const clock = tz => {
  if (!ticking) ticking = setInterval(tick, 1000);
  return `<span data-tz-clock="${tz}">${timeText(tz, Date.now(), { second: '2-digit' })}</span>`;
};

async function query(at, api) {
  if (!lo) return [['Time zone', 'The time-zone areas did not load. Try again in a moment.']];
  if (!hi) await loadHi(); // the light outline can put border towns in the wrong zone
  const rough = hi ? [] : [['Note', 'The detailed zone outlines did not load, so near a border this answer may be wrong.']];
  const [z = null, ...also] = zonesAt(at);
  const now = Date.now();
  if (!z) {
    const n = nauticalHours(at[0]), etc = n === 0 ? 'Etc/GMT' : `Etc/GMT${n > 0 ? '-' : '+'}${Math.abs(n)}`; // Etc signs are reversed
    return [
      ['Time zone', `Nautical time ${offText(n * 60)} (outside any country's zones; ships often keep their port or flag time instead)`],
      ['Local time', clock(etc)],
      ['Daylight saving', 'Not used at sea'],
      ...rough
    ];
  }
  const s = scanYear(z.tz, now);
  if (s.now == null) return [['Time zone', `${api.esc(z.tz)}. This browser does not know this zone, so it cannot give its time.`]];
  const longName = new Intl.DateTimeFormat('en-GB', { timeZone: z.tz, timeZoneName: 'long' }).formatToParts(now).find(p => p.type === 'timeZoneName').value;
  const dst = s.lowest === s.highest ? 'Not used'
    : s.now > s.lowest ? `In effect (standard time is ${offText(s.lowest)})` : 'Not in effect now';
  let change = 'None in the next 18 months';
  if (s.next) {
    const d = s.next.to - s.next.from, hrs = Math.abs(d) / 60;
    const by = Math.abs(d) < 60 ? `${Math.abs(d)} minutes` : `${hrs === Math.floor(hrs) ? hrs : d3.format('.2~f')(hrs)} hour${hrs === 1 ? '' : 's'}`;
    // Said the usual way: the wall-clock time just before the change, and what it becomes.
    const before = timeText('UTC', s.next.at + s.next.from * 60e3), after = timeText(z.tz, s.next.at, { weekday: undefined, day: undefined, month: undefined, year: undefined });
    change = `${before} local time: clocks go ${d > 0 ? 'forward' : 'back'} ${by} to ${after} (${offText(s.next.to)})`;
  }
  return [
    ['Time zone', `${api.esc(z.tz)}<br>${api.esc(longName)}`],
    ['Local time', clock(z.tz)],
    ['UTC offset now', offText(s.now)],
    ['Daylight saving', dst],
    ['Next change', change],
    ...also.map(o => ['Also in use here', `${api.esc(o.tz)}, ${offText(offsetAt(o.tz, now))} now: ${clock(o.tz)}. The source gives this place a second zone, usually a local or unofficial time kept beside the official one.`]),
    ...rough
  ];
}

// ---- Legend ------------------------------------------------------------------------------------------------
// The key shows the lines.
const line = (style, dash = '') => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 8h14" style="${style}"${dash ? ` stroke-dasharray="${dash}"` : ''}/></svg>`;
function legend() {
  if (loadFailed) return '<p class="note keep">The time-zone areas did not load. Choose the map again to retry.</p>';
  if (!lo) return '<p class="note keep">Loading time zones…</p>';
  if (!ticking) ticking = setInterval(tick, 1000);
  return `<p class="note keep">Middle of the view: <span data-tz-here>${hereText()}</span></p>
    <ul class="swatches reflegend">
      <li>${line('stroke:var(--border);stroke-width:2.4')}Clock changes</li>
      <li>${line('stroke:var(--border);stroke-width:1.2')}Same time today</li>
      <li>${line('stroke:var(--coast);stroke-width:1.4', '3 2')}Nautical time band</li>
      <li>${line('stroke:var(--muted);stroke-width:1.4')}Date line at sea</li></ul>`;
}

export default {
  id: 'timezones', name: 'Time zones', group: 'Countries and borders',
  // The zones are derived from OpenStreetMap (ODbL), so its credit goes on the map (OSMF attribution guidelines).
  onMap: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  credit: 'Time zones: <a href="https://github.com/evansiroky/timezone-boundary-builder">timezone-boundary-builder</a> 2026f (November 2026), data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://opendatacommons.org/licenses/odbl/">ODbL</a>. Times: your browser\'s time-zone database',
  ownsColour: true,
  // The tiles hold the zones, borders and coast; the country layer stays off (vector 'none') to keep lines single.
  layers: ({ dark }) => { updateOffsets(); return lo ? [{ src: source(dark) }] : []; },
  vector: 'none', click: 'point',
  query, legend,
  overlay: {
    async load(api) {
      loadFailed = false;
      try { lo = prep(await getJSON('zones-lo.json')); } catch (e) { loadFailed = true; api.refresh(); throw e; }
      updateOffsets();
      findSeaLabels();
      api.refresh();
    },
    draw: () => {} // the labels are drawn in the app's label pass (placeLabels)
  },
  placeLabels: draw
};

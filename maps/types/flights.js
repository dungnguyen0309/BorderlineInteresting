// Flights (live): aircraft positions from the community ADS-B networks adsb.fi (first) and adsb.lol (fallback),
// read through the small proxy in scripts/serve.py, because neither feed sends a CORS header. Military aircraft
// and emergency squawks are read for the whole world; once the view is a region (under 250 nm from its centre to
// the farthest corner), all traffic around the centre too. Between reads each airborne aircraft is moved along its
// track at its ground speed. On a plain static host /live/... answers 404 and the map says it needs serve.py.
/* global d3 */
import { MAP_FONT } from '../fonts.js';

const LIVE = new URL('../../live/flights/', import.meta.url).href;
const NEAR_NM = 250;        // all traffic loads once the view is under this (the feeds' own limit for one read)
const LABEL_NM = 300;       // callsigns once the view is under this
const NEAR_EVERY = 10e3;    // all traffic near the centre: read again 10 s after the last answer
const WORLD_EVERY = 30e3;   // military and emergency lists: every 30 s (the proxy keeps answers for 10 s)
const RETRY = 30e3;
const MAX_DR = 60;          // seconds an aircraft is moved on from its last reported position
const STALE = 180e3;        // positions older than this are not drawn: a healthy feed stays under about 100 s
const NM_KM = 1.852, FT_M = 0.3048, EARTH_NM = 3440.065, D2R = Math.PI / 180;
const LABEL_FONT = `600 12px ${MAP_FONT}`;
const COARSE = matchMedia('(pointer: coarse)').matches;
// OpenStreetMap under a regional view, for airports and towns (same source as the Political map, so tiles are shared).
const OSM = { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 };
const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const fade = (k, a, b) => Math.max(0, Math.min(1, Math.log(k / a) / Math.log(b / a)));
const NO_PROXY = 'Live flights need the local server: run python scripts/serve.py in the hinterland folder and open http://127.0.0.1:8765/. This host serves static files only, so it cannot read the ADS-B feeds.';

// Altitude bands (barometric feet), low to high, in viridis: lightness alone gives the order, so they read for
// colour-blind readers too. Ground traffic is grey; no altitude reported is drawn as an outline only.
const BANDS = [
  { max: 5000, c: '#fde725', label: 'Under 5,000 ft' },
  { max: 15000, c: '#7ad151', label: '5,000 to 15,000 ft' },
  { max: 25000, c: '#22a884', label: '15,000 to 25,000 ft' },
  { max: 35000, c: '#2a788e', label: '25,000 to 35,000 ft' },
  { max: Infinity, c: '#414487', label: '35,000 ft and over' }
];
const GROUND = 5, NO_ALT = 6, GREY = '#8d949c';
const band = a => (a.alt === 'ground' ? GROUND : typeof a.alt !== 'number' ? NO_ALT : BANDS.findIndex(b => a.alt < b.max));
// The darkest band barely shows on the dark theme's land, so there it is one step lighter (as on the Earthquakes map).
const fillOf = (b, dark) => (b === GROUND ? GREY : b === NO_ALT ? null : dark && b === 4 ? '#5560b0' : BANDS[b].c);
const EMERGENCY_C = '#c51b7d';

// Glyphs in a 24-unit box, nose up. An airliner (straight wings) for most; a delta for military aircraft.
const CIVIL = 'M0-11C1.2-11 1.6-9.6 1.6-8V-3L11 2.5V5L1.6 2V7L4.5 9.5V11L0 10L-4.5 11V9.5L-1.6 7V2L-11 5V2.5L-1.6-3V-8C-1.6-9.6-1.2-11 0-11Z';
const MIL = 'M0-11L2-6V-2L10 6V8.5L2 6.5L3.5 9.5V11L0 10L-3.5 11V9.5L-2 6.5L-10 8.5V6L-2-2V-6Z';
const SHAPES = [CIVIL, MIL];
const DOT = 2; // shape index: direction not reported

const SQUAWKS = { 7500: 'unlawful interference (hijacking)', 7600: 'radio failure (lost communication)', 7700: 'general emergency' };
const EMERGENCY_FIELD = { general: 'general emergency', lifeguard: 'medical (lifeguard) flight', minfuel: 'minimum fuel', nordo: 'no radio', unlawful: 'unlawful interference', downed: 'aircraft down', reserved: 'reserved code' };
const HOW = {
  adsb_icao: 'ADS-B, broadcast by the aircraft', adsb_icao_nt: 'ADS-B from a non-transponder device', adsr_icao: 'ADS-R, ADS-B rebroadcast by a ground station',
  tisb_icao: 'TIS-B, ground radar track rebroadcast', tisb_trackfile: 'TIS-B, ground radar track rebroadcast', tisb_other: 'TIS-B, ground radar track rebroadcast',
  adsc: 'ADS-C, satellite position report', mlat: 'MLAT: worked out by receivers from signal timing, less exact', mode_s: 'Mode S only, position from another source',
  adsb_other: 'ADS-B, anonymised address', adsr_other: 'ADS-R, anonymised address', other: 'Other or unknown source'
};
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const num = n => Math.round(n).toLocaleString('en');
const pad = n => String(n).padStart(2, '0');
const hms = t => { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'} ago`;
}

// ---------- data ----------

let mode = 'all', noProxy = false, timer = 0, lastApi = null, statusEl = null, alertEl = null, showEl = null;
const feed = (path, name) => ({ path, name, data: null, error: '', busy: false, done: 0 });
const world = [feed('mil', 'military list'), ...['7500', '7600', '7700'].map(s => feed(`sqk/${s}`, `squawk ${s} list`))];
const near = feed(null, 'all traffic near the centre');

// One feed answer as the records the map uses; aircraft without a position are counted, not kept.
function prep(j, from) {
  const got = j.fetched * 1000, list = [];
  let missing = 0;
  for (const a of j.ac || []) {
    if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || !a.hex) { missing++; continue; }
    list.push({
      // '@' pads an unset callsign.
      hex: a.hex, call: (a.flight || '').replace(/@/g, '').trim(), r: a.r || '', t: a.t || '', desc: a.desc || '', op: a.ownOp || '',
      lat: a.lat, lon: a.lon, alt: a.alt_baro ?? null, gs: a.gs ?? null, trk: a.track ?? null,
      hdg: a.true_heading ?? a.mag_heading ?? null, sq: a.squawk || '', em: a.emergency && a.emergency !== 'none' ? a.emergency : '',
      mil: (a.dbFlags & 1) === 1 || from === 'military list', how: a.type || '', seen: a.seen_pos ?? a.seen ?? 0,
      pos: got - (a.seen_pos ?? a.seen ?? 0) * 1000, got, src: j.source, from
    });
  }
  return { list, missing, source: j.source, fetched: got };
}

function read(f, path = f.path, area = null) {
  f.busy = true;
  const first = f === near && !f.data; // the first traffic list also re-reads an open point panel, as on Shipping
  return fetch(LIVE + path, { signal: AbortSignal.timeout(60e3), cache: 'no-store' })
    .then(r => {
      // A static host has no /live/ route: a 404, or its own HTML page in place of JSON.
      if (r.status === 404 || !(r.headers.get('content-type') || '').includes('json')) { noProxy = true; throw new Error('no live proxy'); }
      if (!r.ok) throw new Error(r.status === 502 ? 'neither adsb.fi nor adsb.lol answered' : `server answered ${r.status}`);
      return r.json();
    })
    .then(j => { f.data = { ...prep(j, f.name), area }; f.error = ''; },
      e => { f.error = e.name === 'TimeoutError' ? 'no answer in 60 seconds' : e instanceof TypeError ? 'the local server did not answer' : e.message; })
    .finally(() => { f.busy = false; f.done = Date.now(); merged = {}; show(); first && f.data ? lastApi?.refresh() : lastApi?.draw(); });
}

// All aircraft to show, one per address (the newest position wins), emergencies last so they are drawn on top.
let merged = {};
// A lifeguard (medical priority) flight or a reserved code is not an emergency.
const isEmergency = a => !!SQUAWKS[a.sq] || (!!a.em && a.em !== 'lifeguard' && a.em !== 'reserved');
function current(withNear) {
  const key = withNear ? 'near' : 'world';
  if (!merged[key]) {
    const by = new Map();
    const add = d => {
      for (const a of d?.list || []) {
        const o = by.get(a.hex);
        if (!o) by.set(a.hex, a);
        else if (a.pos > o.pos) by.set(a.hex, { ...a, mil: a.mil || o.mil });
        else if (a.mil && !o.mil) by.set(a.hex, { ...o, mil: true });
      }
    };
    if (withNear) add(near.data);
    world.forEach(f => add(f.data));
    const list = [...by.values()];
    for (const a of list) a.rank = isEmergency(a) ? 2 : a.mil ? 1 : 0;
    merged[key] = list.sort((p, q) => p.rank - q.rank);
  }
  return merged[key];
}

// Where an aircraft is now: moved on from its last report along its track at its ground speed (dead reckoning),
// for up to MAX_DR seconds. [lon, lat, still moving?]
function place(a, now) {
  if (a.alt === 'ground' || !a.gs || a.trk == null) return [a.lon, a.lat, false];
  const dt = Math.min(MAX_DR, (now - a.pos) / 1000);
  if (dt <= 0) return [a.lon, a.lat, false];
  const d = a.gs * dt / 3600 / 60, r = a.trk * D2R; // nautical miles, as degrees of arc
  const lat = a.lat + d * Math.cos(r), lon = a.lon + d * Math.sin(r) / Math.max(0.01, Math.cos(a.lat * D2R));
  return [((lon + 540) % 360) - 180, Math.max(-90, Math.min(90, lat)), dt < MAX_DR];
}

// ---------- the view ----------

// Nautical miles from the centre of the view to its farthest corner (the horizon, 90°, on the whole globe).
function viewNm(api) {
  const [tx, ty] = api.proj.translate(), s = api.proj.scale();
  const corner = Math.max(Math.hypot(tx, ty), Math.hypot(api.w - tx, ty), Math.hypot(tx, api.h - ty), Math.hypot(api.w - tx, api.h - ty));
  return corner >= s ? 90 * 60 : Math.asin(corner / s) * EARTH_NM;
}
const nearView = api => mode === 'all' && !!api && viewNm(api) < NEAR_NM;

function gcNm(a, b) {
  const s1 = Math.sin((b[1] - a[1]) * D2R / 2), s2 = Math.sin((b[0] - a[0]) * D2R / 2);
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * s2 * s2)));
}

// Reads all traffic around the centre when the view is close enough: again after 10 s, or after a pan leaves the
// circle read (at most every 2 s, and only once the globe stops moving).
function wantNear(api) {
  if (noProxy || near.busy || !world[0].done || !nearView(api)) return;
  const R = viewNm(api), c = api.proj.invert(api.proj.translate());
  if (!c || Number.isNaN(c[0])) return;
  const area = near.data?.area, since = Date.now() - near.done;
  const covered = area && gcNm(c, area.c) + R <= area.nm + 1;
  if (near.error ? since < RETRY : covered ? since < NEAR_EVERY : since < 2e3) return;
  const nm = Math.min(NEAR_NM, Math.ceil(R * 1.25 / 10) * 10);
  const lat = Math.max(-89.9, Math.min(89.9, c[1])).toFixed(2), lon = (((c[0] + 540) % 360) - 180).toFixed(2);
  read(near, `point/${lat}/${lon}/${nm}`, { c: [+lon, +lat], nm });
}

// Runs once a second while this map is shown and the tab is visible: re-reads due feeds, keeps the feed ages
// true and moves aircraft on. Stops for good once another map type is chosen (setup starts it again).
function tick() {
  if (!statusEl?.isConnected || document.getElementById('mapType')?.value !== 'flights') { clearInterval(timer); timer = 0; return; }
  if (document.hidden) return;
  if (!noProxy) {
    // The military list goes first; the rest wait for its first answer, so a static host sees one 404, not four.
    for (const f of world) if (!f.busy && (f === world[0] || world[0].done) && Date.now() - f.done >= (f.error ? RETRY : WORLD_EVERY)) read(f);
    if (lastApi && !lastApi.moving) wantNear(lastApi);
  }
  show();
  if (moving && lastApi && viewNm(lastApi) < 2 * NEAR_NM) lastApi.draw(); // at the globe view a second's travel is under a pixel
}

// The feed's state, or which aircraft are drawn now, for the key's title (types.js), which shows while the Map
// section is closed. A change redraws the key, so the scope line in it follows the zoom.
const state = () => (noProxy || world[0].error ? 'did not load' : !world[0].data ? 'loading'
  : nearView(lastApi) ? 'all traffic near the centre' : 'military and emergencies only');
// The title already says what is drawn; this line says what changes it.
const scopeText = () => (nearView(lastApi) ? 'All traffic inside the dashed circle; military and emergencies elsewhere.'
  : mode === 'mil' ? 'Military only, as set in Aircraft shown.' : 'Zoom in to a region for all traffic.');
// The corner credit (types.js onMap): OpenStreetMap once its tiles fade in, and adsb.lol while a list drawn came from
// it. Both are under the ODbL, whose notice the OSMF's guidelines put on the map (osmfoundation.org/wiki/Licence/
// Attribution_Guidelines). adsb.fi's terms ask for a citation and a link, not on the map (github.com/adsbfi/opendata).
const cornerCredit = () => [(lastApi?.k || 1) > 10 && OSM_CREDIT,
  [near, ...world].some(f => f.data?.source === 'api.adsb.lol') && 'Flight data from <a href="https://adsb.lol/">adsb.lol</a> (<a href="https://opendatacommons.org/licenses/odbl/1.0/">ODbL</a>)'
].filter(Boolean).join('; ');
let lastState = '', lastCorner = '';
// Problems are said once in the app's live region (#mapSays); the visible line stays in the map's tools.
const say = t => { const el = document.getElementById('mapSays'); if (el && t) el.textContent = t; };
const setAlert = t => { if (alertEl.textContent !== t) { alertEl.textContent = t; say(t); } };

// The status line: what is shown, from where, how old; problems go to a separate line.
function show() {
  if (!statusEl?.isConnected) return;
  if (state() !== lastState || cornerCredit() !== lastCorner) { lastState = state(); lastCorner = cornerCredit(); lastApi?.refresh(); }
  if (noProxy) { statusEl.textContent = ''; setAlert(NO_PROXY); return; }
  const lines = [], mil = world[0];
  const more = d => (d.missing ? ` (${num(d.missing)} more without a position)` : '');
  // A list older than the drawing limit is not counted: none of its aircraft are on the map.
  const stale = d => Date.now() - d.fetched > STALE, age = d => ago(d.fetched).replace(/ ago$/, '');
  // "Aircraft shown" only matters inside the all-traffic range: outside it both settings show the same aircraft.
  const far = !lastApi || viewNm(lastApi) >= NEAR_NM;
  if (showEl && showEl.disabled !== far) showEl.disabled = far;
  if (far) lines.push(`Zoom in to a region, under ${num(NEAR_NM * NM_KM)} km from centre to edge, for all traffic.`);
  else if (mode === 'all') {
    if (near.data && stale(near.data)) lines.push(`No traffic near the centre shown: the last list is ${age(near.data)} old.`);
    else if (near.data) lines.push(`${num(near.data.list.length)} aircraft within ${num(near.data.area.nm * NM_KM)} km of the centre, read ${ago(near.data.fetched)}${more(near.data)}.`);
    else lines.push('Loading all traffic near the centre…');
  }
  if (mil.data && stale(mil.data)) lines.push(`No military aircraft shown: the last list is ${age(mil.data)} old.`);
  else if (mil.data) lines.push(`${num(mil.data.list.length)} military aircraft, read ${ago(mil.data.fetched)}${more(mil.data)}.`);
  else if (!mil.error) lines.push('Loading military aircraft…');
  if (world.slice(1).every(f => f.data)) {
    const n = current(false).filter(a => a.rank === 2 && Date.now() - a.pos <= STALE).length;
    lines.push(n ? `${n} aircraft signalling an emergency (ringed).` : 'No aircraft signalling an emergency.');
  }
  statusEl.textContent = lines.join(' ');
  const used = nearView(lastApi) ? [...world, near] : world, names = fs => [...new Set(fs.map(f => f.name.replace(/squawk \d+ list/, 'emergency lists')))].join(' and ');
  const bad = used.filter(f => f.error), old = used.filter(f => f.data && Date.now() - f.data.fetched > STALE);
  const text = [
    bad.length && `The ${names(bad)} did not load (${bad[0].error}). Trying again every 30 seconds${bad.some(f => f.data && !old.includes(f)) ? '; older data is shown with its age' : ''}.`,
    // No age here: the text stays the same while a feed is stale, so it is said once (the age is in the status line).
    old.length && `The ${names(old)} ${old.length > 1 ? 'are' : 'is'} more than 3 minutes old; positions that old are not drawn.`
  ].filter(Boolean).join(' ');
  setAlert(text);
}

// ---------- drawing ----------

// The globe's orthographic projection written out (as in engine.js and the Earthquakes map), for speed.
function projector(api) {
  const [rl, rp, rg = 0] = api.proj.rotate(), s = api.proj.scale(), [tx, ty] = api.proj.translate();
  const dl = rl * D2R, cp = Math.cos(rp * D2R), sp = Math.sin(rp * D2R), cg = Math.cos(rg * D2R), sg = Math.sin(rg * D2R);
  return (lon, lat) => {
    const l = lon * D2R + dl, cf = Math.cos(lat * D2R), Z = Math.sin(lat * D2R);
    const X = Math.cos(l) * cf, Y = Math.sin(l) * cf;
    if (X * cp - Z * sp <= 0) return null;
    const kk = Z * cp + X * sp;
    return [tx + s * (Y * cg - kk * sg), ty - s * (kk * cg + Y * sg)];
  };
}

// Glyph size in CSS pixels: 10 at the whole globe, up to 16 zoomed in.
const glyphSize = k => Math.round(Math.min(16, 10 + Math.log2(Math.max(1, k)) * 1.1));
const STEP = 10; // sprites are drawn for every 10° of heading

// Each glyph is drawn once per band, shape, 10° of heading, size and theme, then stamped in place.
const sprites = new Map(), paths = SHAPES.map(d => new Path2D(d));
function sprite(b, shape, deg, size, dark, dpr) {
  const q = shape === DOT ? 0 : ((Math.round(deg / STEP) % (360 / STEP)) + 360 / STEP) % (360 / STEP);
  const key = `${b}|${shape}|${q}|${size}|${dark}|${dpr}`;
  let c = sprites.get(key);
  if (!c) {
    if (sprites.size > 4000) sprites.clear();
    const side = Math.ceil(size * 1.1 + 4), fill = fillOf(b, dark);
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(side * dpr);
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, side * dpr / 2, side * dpr / 2);
    g.lineJoin = 'round';
    g.strokeStyle = fill ? (dark ? 'rgba(231,234,238,0.8)' : 'rgba(27,32,38,0.85)') : GREY;
    if (shape === DOT) { g.beginPath(); g.arc(0, 0, size * 0.28, 0, 2 * Math.PI); }
    g.rotate(q * STEP * D2R);
    g.scale(size / 24, size / 24);
    const p = shape === DOT ? undefined : paths[shape];
    g.lineWidth = (fill ? (shape === 1 ? 1.5 : 0.8) : 1.4) * 24 / size;
    if (fill) { g.fillStyle = fill; p ? g.fill(p) : g.fill(); }
    p ? g.stroke(p) : g.stroke();
    c.size = side; c.half = side / 2;
    sprites.set(key, c);
  }
  return c;
}

// A simple grid of placed boxes, so labels neither overlap each other nor cover other aircraft.
function grid(cell = 48) {
  const cells = new Map();
  const keys = b => { const out = []; for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[2] / cell); i++) for (let j = Math.floor(b[1] / cell); j <= Math.floor(b[3] / cell); j++) out.push(i * 1e5 + j); return out; };
  return {
    hit: b => keys(b).some(k => (cells.get(k) || []).some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])),
    add: b => keys(b).forEach(k => (cells.get(k) || cells.set(k, []).get(k)).push(b))
  };
}
const widths = new Map();
const labelOf = a => { const n = a.call || a.r; return a.rank === 2 ? `${n || a.hex.toUpperCase()} ${SQUAWKS[a.sq] ? a.sq : EMERGENCY_FIELD[a.em] || 'emergency'}` : n; };

let drawn = [], moving = false, lastPick = null;
function draw(api) {
  lastApi = api;
  drawn = [];
  if (noProxy) return;
  if (!api.moving) { wantNear(api); if (state() !== lastState || cornerCredit() !== lastCorner) setTimeout(show); } // a zoom across the range redraws the key and corner
  const R = viewNm(api), withNear = nearView(api) && !!near.data, list = current(withNear);
  const { ctx, w, h, dark, dpr, C } = api, at = projector(api), now = Date.now(), size = glyphSize(api.k);

  // The area all traffic was read for, dashed, cut to the window (zoomed in, the circle is mostly off screen).
  if (withNear) {
    api.proj.clipExtent([[-8, -8], [w + 8, h + 8]]);
    ctx.beginPath(); api.path(d3.geoCircle().center(near.data.area.c).radius(near.data.area.nm / 60)());
    api.proj.clipExtent(null);
    ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = C.muted; ctx.stroke(); ctx.setLineDash([]);
  }

  let still = false;
  for (const a of list) {
    if (now - a.pos > STALE) continue;
    const [lon, lat, dr] = place(a, now);
    const p = at(lon, lat);
    if (!p || p[0] < -size || p[1] < -size || p[0] > w + size || p[1] > h + size) continue;
    still ||= dr;
    const dir = a.trk ?? a.hdg;
    let deg = 0;
    if (dir != null) {
      // The heading on screen: north turns across an orthographic globe, so project a point a little ahead.
      const r = dir * D2R, q = at(lon + 0.01 * Math.sin(r) / Math.max(0.01, Math.cos(lat * D2R)), lat + 0.01 * Math.cos(r));
      deg = q ? Math.atan2(q[0] - p[0], p[1] - q[1]) / D2R : dir;
    }
    if (a.rank === 2) {
      ctx.beginPath(); ctx.arc(p[0], p[1], size * 0.8 + 2, 0, 2 * Math.PI);
      ctx.lineWidth = 4.5; ctx.strokeStyle = C.halo; ctx.stroke();
      ctx.lineWidth = 2.2; ctx.strokeStyle = EMERGENCY_C; ctx.stroke();
    }
    const s = sprite(band(a), dir == null ? DOT : a.mil ? 1 : 0, deg, size, dark, dpr);
    ctx.drawImage(s, p[0] - s.half, p[1] - s.half, s.size, s.size);
    drawn.push([a, p[0], p[1], lon, lat]);
  }
  moving = still;
  if (api.moving) return;

  // Callsigns: emergencies at any zoom, the rest once the view is a region; emergencies, then military, then
  // nearest the centre first, none overlapping another label or aircraft.
  const [cx, cy] = api.proj.translate(), half = size / 2;
  const cands = drawn.filter(d => (d[0].rank === 2 || R < LABEL_NM) && labelOf(d[0]));
  if (!cands.length) return;
  const g = grid();
  if (drawn.length < 4000) for (const d of drawn) g.add([d[1] - half, d[2] - half, d[1] + half, d[2] + half]);
  cands.sort((p, q) => q[0].rank - p[0].rank || Math.hypot(p[1] - cx, p[2] - cy) - Math.hypot(q[1] - cx, q[2] - cy));
  ctx.font = LABEL_FONT; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  let n = 0;
  for (const [a, x, y] of cands) {
    if (n >= 150) break;
    const text = labelOf(a);
    let tw = widths.get(text);
    if (tw == null) { tw = ctx.measureText(text).width; if (widths.size > 5000) widths.clear(); widths.set(text, tw); }
    const right = [x + half + 3, y - 7, x + half + 5 + tw, y + 7], left = [x - half - 5 - tw, y - 7, x - half - 3, y + 7];
    const b = !g.hit(right) ? right : !g.hit(left) ? left : null;
    if (!b) continue;
    g.add(b); n++;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3; ctx.strokeStyle = C.halo; ctx.strokeText(text, b[0] + 1, y);
    ctx.fillStyle = a.rank === 2 ? EMERGENCY_C : C.text; ctx.fillText(text, b[0] + 1, y);
  }
}

// ---------- reading ----------

const altText = a => (a.alt === 'ground' ? 'on the ground' : typeof a.alt === 'number' ? `${num(a.alt)} ft (${num(a.alt * FT_M)} m)` : 'altitude not reported');
const nameOf = a => a.call || a.r || a.hex.toUpperCase();
const kmText = d => (d < 10 ? `${d.toFixed(1)} km` : `${num(d)} km`);

// Aircraft address -> the object pick returns, kept (so hovering one aircraft does not redraw) and remade when a
// newer report comes in, or every 2 s while it is moved on.
const feats = new Map();
function feature(a, at, esc) {
  const key = `${a.pos}|${a.src}|${Math.floor(Date.now() / 2e3)}`;
  let f = feats.get(a.hex);
  if (f?.key === key) { f.at = at; return f; } // same object, so hovering does not redraw; where it is drawn now
  const dr = place(a, Date.now())[2], squawk = SQUAWKS[a.sq], age = (Date.now() - a.pos) / 1000;
  const dir = a.trk ?? a.hdg, dirName = a.trk != null ? 'direction over the ground' : 'heading (where the nose points)';
  // One fact per row: the title is the callsign when there is one, the sub line names the type and says military.
  const sq = ['Squawk', a.sq ? `${esc(a.sq)}${squawk ? `: ${squawk}. Set by the crew; it can be a mistake and is not a confirmed emergency` : ''}` : 'Not reported'];
  const rows = [
    ...(a.call ? [] : [['Callsign', 'Not broadcast']]),
    ['Registration', a.r ? esc(a.r) : 'Not known'],
    ['Aircraft', a.t ? esc(a.t) : 'Type code not known']
  ];
  if (a.op) rows.push(['Operator', esc(a.op)]);
  rows.push(
    ['Altitude', a.alt === 'ground' ? 'On the ground' : typeof a.alt === 'number' ? `${num(a.alt)} ft (${num(a.alt * FT_M)} m), barometric (from air pressure)` : 'Not reported'],
    ['Ground speed', a.gs == null ? 'Not reported' : `${num(a.gs)} kn (${num(a.gs * NM_KM)} km/h)`],
    ['Track', dir == null ? 'Not reported' : `${Math.round(dir) % 360}° (${COMPASS[Math.round(dir / 22.5) % 16]}), ${dirName}`],
    ...(squawk ? [sq] : [])
  );
  if (a.em) rows.push(['Emergency status', esc(EMERGENCY_FIELD[a.em] || a.em) + ', as broadcast by the aircraft']);
  // The feed's own fields, folded: the panel keeps a fold open across redraws.
  const feedRows = [
    ...(squawk ? [] : [sq]),
    ['Position from', esc(HOW[a.how] || a.how || 'Not stated')],
    ['ICAO address', esc(a.hex.toUpperCase())],
    ['Listed in', `${a.from[0].toUpperCase()}${a.from.slice(1)}${a.mil ? '; flagged as military in the network\'s aircraft database' : ''}`],
    ['Times', `Shown ${hms(Date.now())} UTC, last report ${hms(a.pos)} UTC, feed read ${hms(a.got)} UTC${dr ? '. Since then the marker is moved along its track at its ground speed (an estimate, for up to 60 seconds)' : ''}`]
  ];
  rows.push(
    ['Position age', `${age < 10 ? age.toFixed(1) : num(age)} s old`],
    ['Feed', `<details class="figs"><summary>Show details</summary>${feedRows.map(([k, v]) => `<span class="yr">${k}</span> ${v}`).join('<br>')}</details>`],
    ['More', /^[0-9a-f]{6}$/i.test(a.hex)
      ? `Track history and photos: <a href="https://globe.adsb.fi/?icao=${a.hex}" target="_blank" rel="noopener">globe.adsb.fi</a>, <a href="https://adsb.lol/?icao=${a.hex}" target="_blank" rel="noopener">adsb.lol</a>`
      : 'No ICAO address (a rebroadcast or anonymised track), so no link']
  );
  const kind = a.desc || a.t || 'Aircraft';
  f = { key, title: nameOf(a), sub: [a.mil ? `${kind}, military` : kind, a.op, squawk ? `squawking ${a.sq}` : isEmergency(a) && `broadcasting ${EMERGENCY_FIELD[a.em] || a.em}`].filter(Boolean).join(', '), at, rows };
  feats.set(a.hex, f);
  if (feats.size > 500) feats.delete(feats.keys().next().value);
  return f;
}

// While the first lists are still loading the answer waits for them (up to 30 s); the panel shows "Reading the map here…".
function query(at, api, tries = 0) {
  if (noProxy) return [['Flights', NO_PROXY]];
  const withNear = nearView(lastApi) && !!near.data, list = current(withNear);
  if (!list.length && !world[0].error && tries < 30) return new Promise(r => setTimeout(r, 1000)).then(() => query(at, api, tries + 1));
  if (!list.length) return [['Flights', world[0].error ? 'The live flight data did not load. Retrying every 30 seconds.' : 'Aircraft are still loading. Click again in a moment.']];
  const now = Date.now(), wrap = l => ((l + 540) % 360) - 180;
  // The clicked aircraft, known by its address: the app passes the pick's position on, normalised.
  const selfHex = lastPick && Math.abs(wrap(lastPick.at[0]) - wrap(at[0])) < 1e-6 && Math.abs(lastPick.at[1] - at[1]) < 1e-6 ? lastPick.hex : null;
  const shown = new Map(drawn.map(d => [d[0].hex, [d[3], d[4]]])); // measure from where aircraft are drawn
  let best = null, bd = Infinity, n = 0, self = false;
  for (const a of list) {
    if (now - a.pos > STALE) continue;
    if (a.hex === selfHex) { self = true; continue; }
    const d = gcNm(at, shown.get(a.hex) || place(a, now)) * NM_KM;
    if (d <= 50) n++;
    if (d < bd) { bd = d; best = a; }
  }
  const scope = withNear ? ''
    : mode === 'mil' ? ' Only military aircraft and emergency squawks are shown (Military only).'
      : nearView(lastApi) ? ' All traffic near the centre is still loading; click again in a moment.'
        : ' At this zoom only military aircraft and emergency squawks are loaded; zoom in to a region for all traffic.';
  const other = self ? 'Other aircraft' : 'Aircraft';
  return [
    // A click off an aircraft reads the traffic around the point, where other maps open the country.
    ...(self ? [] : [['Point search', 'Aircraft near where you clicked. Click an aircraft symbol for its own details.']]),
    [`Nearest ${other.toLowerCase()}`, best ? `${api.esc(nameOf(best))}${best.t ? ` (${api.esc(best.t)})` : ''}, ${kmText(bd)} away, ${altText(best)}` : 'None loaded'],
    [`${other} within 50 km`, `${num(n)} at ${hms(now)} UTC.${scope}`]
  ];
}

const icon = (d, fill, sw = 1.6, extra = '', stroke = 'currentColor') => `<svg width="18" height="18" viewBox="-13 -13 26 26" aria-hidden="true" style="flex:none">${extra}${d ? `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>` : ''}</svg>`;
function legend() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const bands = BANDS.map((b, i) => `<li>${icon(CIVIL, fillOf(i, dark))}${b.label}</li>`).reverse().join('');
  return `<p class="note keep">${scopeText()}</p>
    <p>Altitude in feet (1,000 ft is 305 m)</p>
    <ul class="swatches ord">${bands}
      <li>${icon(CIVIL, GREY)}On the ground</li>
      <li>${icon(CIVIL, 'none', 2, '', GREY)}Not reported</li></ul>
    <p>Symbols</p>
    <ul class="swatches">
      <li>${icon(CIVIL, fillOf(3, dark))}Aircraft</li>
      <li>${icon(MIL, fillOf(3, dark), 2.4)}Military</li>
      <li>${icon('', '', 0, `<circle r="5" fill="${fillOf(3, dark)}" stroke="currentColor" stroke-width="1.6"/>`)}No direction</li>
      <li>${icon(CIVIL, fillOf(3, dark), 1.6, `<circle r="12" fill="none" stroke="${EMERGENCY_C}" stroke-width="2.2"/>`)}Emergency</li>
      <li>${icon('', '', 0, '<circle r="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 3"/>')}Area read for all traffic</li></ul>`;
}

export default {
  id: 'flights', name: 'Flights', group: 'Live traffic', live: true,
  credit: `Flights: <a href="https://adsb.fi/">adsb.fi</a> open data, for personal, non-commercial use only (<a href="https://github.com/adsbfi/opendata/blob/main/README.md">terms</a>), with <a href="https://adsb.lol/">adsb.lol</a> as fallback (data under the <a href="https://opendatacommons.org/licenses/odbl/1.0/">ODbL 1.0</a>, <a href="https://www.adsb.lol/docs/privacy-license">terms</a>), both community ADS-B networks. Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>. Detail: ${OSM_CREDIT}`,
  get onMap() { return cornerCredit(); },
  // OpenStreetMap fades in as the view nears a region (all traffic loads at about k = 20 to 40), dimmer in the dark theme.
  layers: ({ k, dark }) => (k < 10 ? [] : [{ src: OSM, opacity: fade(k, 10, 20) * (dark ? 0.7 : 1) }]), vector: 'full', click: 'point',
  query, legend, state,
  // In the address: Military only (all traffic is the default).
  params: () => (mode === 'mil' ? { show: 'mil' } : {}),

  setup(api) {
    lastApi = api;
    const q = new URLSearchParams(location.search);
    if (q.get('map') === 'flights' && ['all', 'mil'].includes(q.get('show'))) mode = q.get('show');
    api.tools.innerHTML = `<label for="flShow" class="field">Aircraft shown</label>
      <select id="flShow"><option value="all"${mode === 'all' ? ' selected' : ''}>All traffic when zoomed in</option><option value="mil"${mode === 'mil' ? ' selected' : ''}>Military only</option></select>
      <p class="note" style="margin-bottom:12px"><span id="flStatus"></span> <span id="flAlert"></span></p>`;
    statusEl = api.tools.querySelector('#flStatus');
    alertEl = api.tools.querySelector('#flAlert');
    showEl = api.tools.querySelector('#flShow');
    showEl.addEventListener('change', e => { mode = e.target.value; show(); api.refresh(); });
    noProxy = false; // choosing the map again tries the server again
    for (const f of [...world, near]) if (f.error) f.done = 0;
    lastState = state(); lastCorner = cornerCredit(); // the app draws the key and corner after setup, so no refresh is needed
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    tick();
  },

  overlay: {
    load: () => {},
    draw,
    pick(x, y, api) {
      let best = null, bd = Math.max(glyphSize(api.k) * 0.6, COARSE ? 16 : 8);
      for (const d of drawn) { const dd = Math.hypot(d[1] - x, d[2] - y); if (dd <= bd) { bd = dd; best = d; } } // later (on top) wins ties
      lastPick = best && { hex: best[0].hex, at: [best[3], best[4]] };
      return best && feature(best[0], lastPick.at, api.esc);
    }
  }
};

// Self-checks: 360 kn due east for 10 s is 1 nm, 1/60° of longitude at the equator; bands and the view radius.
{
  const [lon, lat] = place({ lat: 0, lon: 0, alt: 30000, gs: 360, trk: 90, pos: 0 }, 10e3);
  console.assert(Math.abs(lon - 1 / 60) < 1e-9 && Math.abs(lat) < 1e-9, 'flights: dead reckoning');
  console.assert(band({ alt: 'ground' }) === GROUND && band({ alt: null }) === NO_ALT && band({ alt: 4999 }) === 0 && band({ alt: 41000 }) === 4, 'flights: bands');
  console.assert(Math.abs(gcNm([0, 0], [1, 0]) - 60.04) < 0.05, 'flights: distance');
  console.assert(prep({ fetched: 0, ac: [{ hex: 'abcdef', lat: 0, lon: 0, flight: '@@@@@@@@' }] }).list[0].call === '', 'flights: unset callsign');
  console.assert(isEmergency({ sq: '7700' }) && isEmergency({ em: 'minfuel' }) && !isEmergency({ sq: '1000', em: 'lifeguard' }), 'flights: emergencies');
}

// Earthquakes: the USGS real-time feeds (past day, week, month) fetched live, and every magnitude 6+ event since
// 1900 from a copy of the USGS catalogue made by scripts/build_earthquakes.py. Circles are sized by magnitude and
// coloured by depth; a click on one gives its details and a link to the USGS event page.

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const HISTORY = new URL('../../data/maps/earthquakes/m6-since-1900.json', import.meta.url).href;
const EVENT_PAGE = id => `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(id)}`;
const STALE_MS = 5 * 60e3; // the feeds change every minute; re-read them at most every five while shown

const PERIODS = [
  { id: '2.5_day', label: 'Past day, magnitude 2.5+' },
  { id: '4.5_day', label: 'Past day, magnitude 4.5+' },
  { id: '2.5_week', label: 'Past week, magnitude 2.5+' },
  { id: '4.5_week', label: 'Past week, magnitude 4.5+' },
  { id: '2.5_month', label: 'Past month, magnitude 2.5+' },
  { id: '4.5_month', label: 'Past month, magnitude 4.5+' },
  { id: 'significant_month', label: 'Past month, significant events' },
  { id: 'h6', label: 'Since 1900, magnitude 6+', min: 6 },
  { id: 'h7', label: 'Since 1900, magnitude 7+', min: 7 }
];
const periodOf = id => PERIODS.find(p => p.id === id);

// Depth classes (km below the surface) in viridis: lightness falls with depth, so they read without hue, and no
// red, which the conflict markers use.
const DEPTHS = [
  { c: '#fde725', label: 'Shallow, 0 to 70 km deep' },
  { c: '#21918c', label: 'Intermediate, 70 to 300 km' },
  { c: '#440154', label: 'Deep, 300 to about 700 km' }
];
// No recorded depth (null) counts as shallow, as most early events were; the legend says so.
const depthClass = d => (d == null || d < 70 ? 0 : d < 300 ? 1 : 2);
// In dark mode the darkest viridis step barely shows on the dark ocean, so the deep class moves one step lighter.
const colour = (cls, dark) => (dark && cls === 2 ? '#46327e' : DEPTHS[cls].c);

// Radius in CSS pixels at the whole-globe view; grows up to 3 times as the globe is zoomed in.
const radius = m => Math.max(1.8, 2 ** (m / 2 - 0.9));
const zoomScale = k => Math.min(3, Math.max(1, 1 + Math.log2(k) / 3));

let period = '4.5_month';
const sets = new Map(); // period id -> { list (by magnitude, largest first), generated, fetched } or { error }
const loading = new Map();
let history = null, timer = null;

function byMag(list) { return list.sort((a, b) => b.m - a.m); }

function fromFeed(json) {
  return byMag(json.features.filter(f => f.geometry && f.properties.mag != null).map(f => {
    const p = f.properties, [lon, lat, d] = f.geometry.coordinates;
    return { lon, lat, d: d ?? null, m: p.mag, mt: p.magType || '', t: p.time, id: f.id, place: p.place || '',
      status: p.status, type: p.type === 'earthquake' ? '' : p.type, tsunami: p.tsunami, alert: p.alert, felt: p.felt, url: p.url };
  }));
}

async function loadHistory() {
  if (!history) {
    history = fetch(HISTORY).then(r => { if (!r.ok) throw new Error(`history ${r.status}`); return r.json(); }).then(j => ({
      built: j.built,
      list: byMag(j.rows.map(([lon, lat, d, m, mt, t, id, place, status, type]) =>
        ({ lon, lat, d: d ?? null, m, mt, t: t * 1000, id, place, status, type })))
    }));
    history.catch(() => { history = null; });
  }
  return history;
}

// Loads one period (once, or again when a feed is stale); resolves to its set.
function load(id) {
  const have = sets.get(id);
  if (have?.list && (!have.fetched || Date.now() - have.fetched < STALE_MS)) return Promise.resolve(have);
  if (loading.has(id)) return loading.get(id);
  const p = periodOf(id);
  const job = (p.min
    ? loadHistory().then(h => ({ list: h.list.filter(e => e.m >= p.min), built: h.built }))
    : fetch(`${FEED}${id}.geojson`).then(r => { if (!r.ok) throw new Error(`feed ${r.status}`); return r.json(); })
      .then(j => ({ list: fromFeed(j), generated: j.metadata.generated, fetched: Date.now() })))
    .then(s => { sets.set(id, s); return s; },
      e => { console.warn(e); if (!have?.list) sets.set(id, { error: true }); return sets.get(id); })
    .finally(() => loading.delete(id));
  loading.set(id, job);
  return job;
}

const pad = n => String(n).padStart(2, '0');
const utc = t => { const d = new Date(t); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`; };
const yourTime = t => new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
function ago(t) {
  const min = Math.round((Date.now() - t) / 60e3);
  if (min < 1) return 'less than a minute ago';
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'} ago`;
  return `${Math.round(min / 60)} hours ago`;
}
const MAG_EXACT = {
  uk: 'scale unknown', mh: 'non-standard magnitude set by hand, scale not stated',
  mj: 'Japan Meteorological Agency magnitude', fa: 'felt-area magnitude, estimated from how widely it was felt',
  mfa: 'felt-area magnitude, estimated from how widely it was felt', mint: 'magnitude estimated from shaking intensity'
};
function magType(mt) {
  const s = (mt || '').toLowerCase();
  const name = MAG_EXACT[s] || (s.startsWith('mw') ? 'moment magnitude' : s.startsWith('mb') ? 'body-wave magnitude'
    : s.startsWith('ms') ? 'surface-wave magnitude' : s.startsWith('ml') ? 'local magnitude'
    : s.startsWith('md') ? 'duration magnitude' : '');
  return s ? `${s}${name ? ', ' + name : ''}` : 'scale not given';
}
const kind = e => (e.type ? e.type[0].toUpperCase() + e.type.slice(1) : 'Earthquake');

// One line on what is shown and how old it is.
const count = s => `${s.list.length.toLocaleString('en')} event${s.list.length === 1 ? '' : 's'}`;
function status() {
  const s = sets.get(period);
  if (!s || (!s.list && !s.error)) return 'Loading…';
  if (s.error) return 'The data did not load. Retrying every 30 seconds.';
  return s.built ? `${count(s)}, up to ${s.built}.` : `${count(s)}. Feed updated ${ago(s.generated)}.`;
}
// The status line lives in the key (it stays on screen with the Map section closed); the timer updates it in place.
const statusText = () => `${periodOf(period).label}: ${status()}`;
// Screen readers hear a new period's count once, and a failure once; never the "updated N minutes ago" ticking.
const say = t => { const el = document.getElementById('mapSays'); if (el) el.textContent = t; };

// The globe's orthographic projection written out (as in engine.js), for speed: an event's screen point, or null
// past the horizon. d3's own proj() per event is several times slower over 14,500 events.
const D2R = Math.PI / 180;
function projector(api) {
  const [rl, rp, rg = 0] = api.proj.rotate(), s = api.proj.scale(), [tx, ty] = api.proj.translate();
  const dl = rl * D2R, cp = Math.cos(rp * D2R), sp = Math.sin(rp * D2R), cg = Math.cos(rg * D2R), sg = Math.sin(rg * D2R);
  return e => {
    const l = e.lon * D2R + dl, cf = Math.cos(e.lat * D2R), Z = Math.sin(e.lat * D2R);
    const X = Math.cos(l) * cf, Y = Math.sin(l) * cf;
    if (X * cp - Z * sp <= 0) return null;
    const kk = Z * cp + X * sp;
    return [tx + s * (Y * cg - kk * sg), ty - s * (kk * cg + Y * sg)];
  };
}

// A filled, outlined circle drawn once per depth class, half-pixel radius and theme.
const sprites = new Map();
function sprite(cls, r, dark, dpr) {
  const rq = Math.round(r * 2) / 2, key = `${cls}|${rq}|${dark}|${dpr}`;
  let c = sprites.get(key);
  if (!c) {
    const size = Math.ceil((rq + 1) * 2);
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(size * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.beginPath(); g.arc(size / 2, size / 2, rq, 0, 2 * Math.PI);
    g.globalAlpha = 0.85; g.fillStyle = colour(cls, dark); g.fill();
    g.globalAlpha = 1; g.lineWidth = 1; g.strokeStyle = dark ? 'rgba(255,255,255,0.6)' : 'rgba(30,30,30,0.55)'; g.stroke();
    c.size = size; c.half = size / 2;
    sprites.set(key, c);
  }
  return c;
}

// Event key -> the object pick returns (kept, so hovering one event does not redraw). The key holds the fields a
// re-read feed can revise, so a revised event gets fresh rows.
const features = new Map();
function feature(e, esc) {
  const key = `${e.id}|${e.m}|${e.d}|${e.status}|${e.alert}|${e.felt}`;
  if (!features.has(key)) {
    const depth = DEPTHS[depthClass(e.d)].label.split(',')[0].toLowerCase();
    const recent = Date.now() - e.t < 90 * 864e5;
    const rows = [
      ['Magnitude', `${e.m.toFixed(1)} (${esc(magType(e.mt))})`],
      ['Focal depth', e.d == null ? 'Not recorded' : `${Math.round(e.d).toLocaleString('en')} km below the surface, ${depth}`],
      ['Time', utc(e.t)],
      ['Your time', esc(yourTime(e.t))],
      ['Review', e.status === 'reviewed' ? 'Reviewed by a seismologist'
        : recent ? 'Automatic solution, may still change' : 'Not marked as reviewed in the USGS catalogue']
    ];
    if (e.alert) rows.push(['Impact alert', `${esc(e.alert[0].toUpperCase() + e.alert.slice(1))} (USGS PAGER estimate of deaths and losses)`]);
    if (e.tsunami) rows.push(['Tsunami flag', 'Large ocean event: check NOAA tsunami messages. The flag does not mean a tsunami happened.']);
    if (e.felt) rows.push(['Felt reports', `${e.felt.toLocaleString('en')} people reported it to USGS "Did You Feel It?"`]);
    rows.push(['Event page', `<a href="${esc(e.url || EVENT_PAGE(e.id))}" target="_blank" rel="noopener">USGS event ${esc(e.id)}</a>`]);
    features.set(key, { title: `M ${e.m.toFixed(1)} ${kind(e).toLowerCase()}`, sub: e.place || 'Place not named', at: [e.lon, e.lat], rows });
    if (features.size > 2000) features.delete(features.keys().next().value);
  }
  return features.get(key);
}

// Great-circle distance in km.
function km(a, b) {
  const r = Math.PI / 180, s1 = Math.sin((b[1] - a[1]) * r / 2), s2 = Math.sin((b[0] - a[0]) * r / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * s2 * s2)));
}

function legendSizes() {
  const ms = [3, 5, 7, 9], w = 30;
  const circles = ms.map((m, i) => {
    const r = radius(m), x = i * w + w / 2;
    return `<circle cx="${x}" cy="12" r="${r}" fill="none" stroke="currentColor"/><text x="${x}" y="34" text-anchor="middle">${m}</text>`;
  }).join('');
  return `<svg width="${ms.length * w}" height="40" viewBox="0 0 ${ms.length * w} 40" font-size="11" fill="currentColor" role="img" aria-label="Circle sizes for magnitude 3, 5, 7 and 9">${circles}</svg>`;
}

export default {
  id: 'earthquakes', name: 'Earthquakes', group: 'Earth science', live: true, dataMap: true,
  credit: 'Earthquakes: <a href="https://earthquake.usgs.gov/earthquakes/feed/">U.S. Geological Survey</a>, ANSS ComCat (public domain); events before 1976 mostly <a href="https://www.isc.ac.uk/iscgem/">ISC-GEM catalogue</a> (International Seismological Centre and GEM Foundation, <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>). Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
  layers: () => [], vector: 'full', click: 'point',

  // In the address when it is not the default period.
  params: () => (period === '4.5_month' ? {} : { period }),

  setup(api) {
    const q = new URLSearchParams(location.search);
    if (q.get('map') === 'earthquakes' && periodOf(q.get('period'))) period = q.get('period');
    const opts = PERIODS.map(p => `<option value="${p.id}"${p.id === period ? ' selected' : ''}>${p.label}</option>`).join('');
    api.tools.innerHTML = `<label for="eqPeriod" class="field">Earthquakes shown</label><select id="eqPeriod" style="margin-bottom:12px">${opts}</select>`;
    const sel = api.tools.querySelector('#eqPeriod');
    let failSaid = false;
    const show = () => {
      const line = document.getElementById('eqStatus');
      if (line) line.textContent = statusText();
      const bad = !!sets.get(period)?.error;
      if (bad && !failSaid) say(status());
      failSaid = bad;
    };
    const choose = id => {
      period = id;
      if (sets.get(id)?.error) sets.delete(id);
      show(); api.refresh();
      load(id).then(s => { if (period === id) { show(); api.refresh(); if (s?.list) say(`${periodOf(id).label}: ${count(s)}.`); } });
    };
    sel.addEventListener('change', () => choose(sel.value));
    show();
    if (!sets.get(period)?.list) load(period).then(() => { show(); api.refresh(); });
    clearInterval(timer);
    // Keeps "updated N minutes ago" true, and re-reads a stale feed while this map is shown.
    timer = setInterval(() => {
      if (!sel.isConnected) { clearInterval(timer); return; }
      const s = sets.get(period);
      if ((s?.error || (s?.fetched && Date.now() - s.fetched > STALE_MS)) && !loading.has(period)) {
        if (s.error) sets.delete(period); // load() skips a period marked failed; clearing it allows the retry
        load(period).then(() => { show(); api.refresh(); });
      }
      show();
    }, 30e3);
  },

  legend({ mode } = {}) {
    // Under a colouring the globe is light in both themes (app.js), so the key shows the light ground's deep class.
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && (!mode || mode === 'none');
    return `<p class="note keep" id="eqStatus">${statusText()}</p>
      <ul class="swatches ord">${DEPTHS.map((d, i) => `<li><i style="--c:${colour(i, dark)}"></i>${d.label}</li>`).join('')}</ul>
      <p>Magnitude</p>${legendSizes()}`;
  },

  async query(at, api) {
    const s = await load(period);
    if (!s?.list) return [['Earthquakes', 'The earthquake data did not load. Try again in a moment.']];
    let n = 0, top = null;
    for (const e of s.list) if (km(at, [e.lon, e.lat]) <= 300) { n++; if (!top) top = e; } // list is largest first
    const label = periodOf(period).label.toLowerCase();
    // A clicked event passes its own position on (normalised by the app); when it is the largest, the panel already is.
    const self = top && Math.abs(((top.lon - at[0] + 540) % 360) - 180) < 1e-6 && Math.abs(top.lat - at[1]) < 1e-6;
    return [['Within 300 km', n
      ? `${n.toLocaleString('en')} event${n === 1 ? '' : 's'} (${label}).${self ? '' : ` Largest: M ${top.m.toFixed(1)}, ${utc(top.t).slice(0, 10)}, ${top.place ? api.esc(top.place) : 'place not named'}.`}`
      : `No events (${label}).`]];
  },

  overlay: {
    // Ready at once: each period loads on its own and reports failures in the status line, not here.
    load: () => { load(period); },

    // Each circle is a pre-drawn image (filled and outlined) stamped in place. While the globe moves with
    // thousands of events, plain squares in one path per depth class stand in: several times cheaper.
    draw(api) {
      const list = sets.get(period)?.list;
      if (!list?.length) return;
      const { ctx, w, h, k, dark, dpr } = api, at = projector(api), zs = zoomScale(k);
      const quick = api.moving && list.length > 3000, squares = quick && [new Path2D(), new Path2D(), new Path2D()];
      for (const e of list) {
        const p = at(e);
        if (!p) continue;
        const r = radius(e.m) * zs;
        if (p[0] < -r || p[1] < -r || p[0] > w + r || p[1] > h + r) continue;
        if (quick) { const q = r * 0.85; squares[depthClass(e.d)].rect(p[0] - q, p[1] - q, 2 * q, 2 * q); continue; }
        const s = sprite(depthClass(e.d), r, dark, dpr);
        ctx.drawImage(s, p[0] - s.half, p[1] - s.half, s.size, s.size);
      }
      if (quick) {
        ctx.globalAlpha = 0.85;
        squares.forEach((sq, i) => { ctx.fillStyle = colour(i, dark); ctx.fill(sq); });
        ctx.globalAlpha = 1;
      }
    },

    pick(x, y, api) {
      const list = sets.get(period)?.list;
      if (!list) return null;
      const at = projector(api), zs = zoomScale(api.k);
      let best = null, bd = Infinity;
      for (const e of list) {
        const p = at(e);
        if (!p) continue;
        const d = Math.hypot(p[0] - x, p[1] - y);
        // Inside the circle (or within a few pixels of a small one); the nearest centre wins, ties to the smaller.
        if (d <= Math.max(radius(e.m) * zs, 5) + 1 && d <= bd) { bd = d; best = e; }
      }
      return best && feature(best, api.esc);
    }
  }
};

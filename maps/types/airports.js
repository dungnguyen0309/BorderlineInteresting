// Airports: every open airport with an IATA code, from OurAirports, with Wikidata's facts, copied by
// scripts/build_airports.py. The globe draws a plane for each (large ones at every zoom, medium and small ones as
// the view closes in) and their IATA codes in the app's label pass. A click opens the airport: its facts, then a
// Sentinel-2 view from above, its Commons photos and the start of its Wikipedia article, fetched on the click.

const BASE = new URL('../../data/maps/airports/', import.meta.url);
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const EOX = (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/${z}/${y}/${x}.jpg`;
const BY_NC_SA = '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>';
// EOX asks for this wording wherever the mosaic is shown (cloudless.eox.at/documentation/license), as on the Photographic map.
const S2_ON_MAP = '<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)';
const LABEL_FONT = '600 11px "Plus Jakarta Sans", system-ui, sans-serif'; // codes, not place names: the interface's sans

// Tiers by OurAirports' class: H (heliport) and W (seaplane base) are kept only with scheduled flights, drawn as small.
const TIER = { L: 0, M: 1, S: 2, H: 2, W: 2 };
const TYPE = { L: 'Large airport', M: 'Medium airport', S: 'Small airport', H: 'Heliport', W: 'Seaplane base' };
// From what zoom (k) each tier is drawn and named, and its plane's size in CSS pixels at that zoom (it grows a little
// after). Codes wait for more room than planes, so a region's country names keep their place.
const FROM_K = [0, 5, 14];
const NAMED_K = [0, 8, 20];
const SIZE = [13, 10, 8];
// On a small globe (a phone's, about 200 px across at k 1 against 360 on a desktop) the planes are up to 30% smaller,
// so a continent's large airports do not pile up.
const sizeAt = (tier, { k, proj }) => SIZE[tier] * Math.min(1.35, 1 + Math.log2(Math.max(1, k / Math.max(1, FROM_K[tier]))) / 12)
  * Math.max(0.7, Math.min(1, proj.scale() / k / 360));
// A plane seen from above, nose up, on a 24-unit square.
const PLANE = 'M12 1.5c.9 0 1.5 1 1.5 2.2V9l8 4.6v2l-8-2.2v4.8l2.6 2v1.6l-4.1-1.1-4.1 1.1v-1.6l2.6-2v-4.8l-8 2.2v-2l8-4.6V3.7c0-1.2.6-2.2 1.5-2.2z';

let airports = [], built = null, loadFailed = false, loading = null, placeList = null;
function load() {
  loading ||= fetch(new URL('markers.json', BASE)).then(r => (r.ok ? r.json() : Promise.reject(new Error(`airports ${r.status}`)))).then(d => {
    built = d.built;
    airports = d.iata.map((iata, i) => ({ iata, name: d.name[i], lon: d.lon[i], lat: d.lat[i], t: d.t[i], tier: TIER[d.t[i]], p: d.p?.[i] || 0 }));
    // Label order: large first, the busiest of each class first, so they win the space.
    airports.sort((a, b) => a.tier - b.tier || b.p - a.p);
    airports.forEach((a, i) => { a.rank = i; });
    loadFailed = false;
  });
  loading.catch(() => { loading = null; loadFailed = true; });
  return loading;
}
const chunks = new Map(); // first letter of the code -> Promise of { IATA: details }
const known = new Map(); // first letter -> its chunk once loaded, so a hover can name the city without waiting
function details(iata) {
  const l = iata[0];
  if (!chunks.has(l)) {
    chunks.set(l, fetch(new URL(`details/${l}.json`, BASE)).then(r => (r.ok ? r.json() : Promise.reject(new Error(`airport details ${r.status}`))))
      .then(c => { known.set(l, c); return c; }));
    chunks.get(l).catch(() => chunks.delete(l));
  }
  return chunks.get(l).then(c => c[iata] || {});
}

// The airport as the app's panel, tooltip and search take a feature: titled by its name, with its code and city
// under it once its details have loaded. Kept per airport, so hovering one does not redraw the globe.
const features = new Map();
function featureOf(a) {
  const d = known.get(a.iata[0])?.[a.iata], place = [d?.city, d?.country].filter(Boolean).join(', ');
  const sub = place ? `${a.iata} · ${place}` : a.iata;
  let f = features.get(a.iata);
  // k: a search opens it close enough for its code to show
  if (f?.sub !== sub) features.set(a.iata, f = { title: a.name, sub, at: [a.lon, a.lat], rows: [], names: [a.name, a.iata], kind: TYPE[a.t], rank: a.rank, k: Math.max(8, NAMED_K[a.tier]) });
  return f;
}

// The globe's orthographic projection written out (as in earthquakes.js), for speed: a point's screen position, or
// null past the horizon.
const D2R = Math.PI / 180;
function projector(api) {
  const [rl, rp, rg = 0] = api.proj.rotate(), s = api.proj.scale(), [tx, ty] = api.proj.translate();
  const dl = rl * D2R, cp = Math.cos(rp * D2R), sp = Math.sin(rp * D2R), cg = Math.cos(rg * D2R), sg = Math.sin(rg * D2R);
  return a => {
    const l = a.lon * D2R + dl, cf = Math.cos(a.lat * D2R), Z = Math.sin(a.lat * D2R);
    const X = Math.cos(l) * cf, Y = Math.sin(l) * cf;
    if (X * cp - Z * sp <= 0) return null;
    const kk = Z * cp + X * sp;
    return [tx + s * (Y * cg - kk * sg), ty - s * (kk * cg + Y * sg)];
  };
}

// A plane drawn once per size, colour, theme and screen density: the halo (a wide stroke), then the plane.
const sprites = new Map();
const plane = new Path2D(PLANE);
function sprite(size, C, dpr, ink = C.text) {
  const sq = Math.round(size * 2) / 2, key = `${sq}|${ink}|${C.halo}|${dpr}`;
  let c = sprites.get(key);
  if (!c) {
    const box = sq + 4;
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(box * dpr);
    const g = c.getContext('2d'), u = sq / 24;
    g.scale(dpr, dpr); g.translate(2, 2); g.scale(u, u);
    g.lineJoin = 'round'; g.lineWidth = 3 / u; g.strokeStyle = C.halo; g.stroke(plane);
    g.fillStyle = ink; g.fill(plane);
    c.box = box; c.half = box / 2;
    sprites.set(key, c);
    if (sprites.size > 60) sprites.delete(sprites.keys().next().value);
  }
  return c;
}

// The airports drawn at this zoom, with their screen positions; small ones first, so large ones sit on top.
function shown(api) {
  const at = projector(api), out = [], { w, h, k } = api;
  for (let i = airports.length - 1; i >= 0; i--) {
    const a = airports[i];
    if (k < FROM_K[a.tier]) continue;
    const p = at(a);
    if (!p || p[0] < -10 || p[1] < -10 || p[0] > w + 10 || p[1] > h + 10) continue;
    out.push([a, p[0], p[1]]);
  }
  return out;
}

function draw(api) {
  const { ctx, k, C, dpr } = api;
  if (api.lite) {
    // A finger turning the globe on a phone: each plane is a dot, all in one path (as earthquakes.js does), so the
    // frame stays within budget; the planes come back when the globe stops.
    const dots = new Path2D();
    for (const [a, x, y] of shown(api)) { const r = sizeAt(a.tier, api) / 5; dots.rect(x - r, y - r, 2 * r, 2 * r); }
    ctx.fillStyle = C.text; ctx.fill(dots);
    return;
  }
  // The open airport is left for drawSel, which the app calls with its ring, over the hot spots.
  for (const [a, x, y] of shown(api)) {
    if (isOpen(a, api)) continue;
    const s = sprite(sizeAt(a.tier, api), C, dpr);
    ctx.drawImage(s, x - s.half, y - s.half, s.box, s.box);
  }
}
const isOpen = (a, api) => api.sel && Math.abs(a.lon - api.sel[0]) < 1e-6 && Math.abs(a.lat - api.sel[1]) < 1e-6;
// The open airport: a larger plane in the accent, so no neighbour or hot spot covers it.
function drawSel(api) {
  const open = shown(api).find(([a]) => isOpen(a, api));
  if (!open) return;
  const [a, x, y] = open, s = sprite(sizeAt(a.tier, api) * 1.3, api.C, api.dpr, api.C.accent);
  api.ctx.drawImage(s, x - s.half, y - s.half, s.box, s.box);
}

// IATA codes, right of each plane, placed in the app's label pass after the country names (namesFirst) and sharing
// its boxes, so nothing overlaps. Each box covers the plane too, so a hot-spot name does not sit on one.
const widths = new Map();
function placeLabels(api) {
  const { ctx, k, C, boxes } = api;
  if (api.lite) return; // the codes wait until a finger lets the globe go
  const list = shown(api).reverse(); // large and busiest first
  const cap = api.moving ? 120 : k < 2 ? 150 : 400; // the whole globe: the busiest 150 at most, so countries keep names
  ctx.font = LABEL_FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  let placed = 0;
  const label = (a, tx, y) => { ctx.lineWidth = 2.5; ctx.strokeStyle = C.halo; ctx.strokeText(a.iata, tx, y); ctx.fillStyle = C.text; ctx.fillText(a.iata, tx, y); };
  // The open airport is always named, right of the app's ring (12px), and no other code goes inside the ring.
  const open = list.find(([a]) => isOpen(a, api));
  if (open) { const [a, x, y] = open; boxes.push([x - 14, y - 14, x + 14, y + 14]); label(a, x + 16, y); boxes.push([x + 14, y - 7, x + 18 + ctx.measureText(a.iata).width, y + 7]); }
  for (const [a, x, y] of list) {
    if (placed >= cap) break;
    if (open && a === open[0]) continue;
    if (k < NAMED_K[a.tier]) continue;
    let tw = widths.get(a.iata);
    if (tw == null) widths.set(a.iata, tw = ctx.measureText(a.iata).width);
    const r = sizeAt(a.tier, api) / 2, tx = x + r + 2;
    const b = [x - r - 1, y - 7, tx + tw + 2, y + 7];
    if (boxes.some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])) continue;
    boxes.push(b); placed++;
    label(a, tx, y);
  }
}

function pick(x, y, api) {
  let best = null, bd = Infinity;
  for (const [a, px, py] of shown(api)) {
    const d = Math.hypot(px - x, py - y);
    if (d <= Math.max(6, sizeAt(a.tier, api) / 2 + 2) && d < bd) { bd = d; best = a; }
  }
  // Its rows come from query(), so an airport reopened from the address shows them too.
  return best && featureOf(best);
}

// ---- Panel ------------------------------------------------------------------------------------------------
const num = n => n.toLocaleString('en');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dateText = d => { const [y, m, day] = d.split('-'); return [day && +day, m && MONTHS[+m - 1], y].filter(Boolean).join(' '); };
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const link = (href, text, esc) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const wikiTitle = u => { try { return decodeURIComponent(new URL(u).pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' '); } catch { return 'Article'; } };
const km = (a, b) => {
  const s1 = Math.sin((b[1] - a[1]) * D2R / 2), s2 = Math.sin((b[0] - a[0]) * D2R / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * s2 * s2)));
};
// The airport at a clicked point (within half a kilometre), or the nearest one and how far it is.
function nearest(at) {
  let best = null, bd = Infinity;
  for (const a of airports) { const d = km(at, [a.lon, a.lat]); if (d < bd) { bd = d; best = a; } }
  return [best, bd];
}
// The airport at a point, for the panel's title (a click beside the plane, or a link to the airport's position).
async function featureAt(at) {
  await load();
  const [a, dist] = nearest(at);
  if (!a || dist >= 0.5) return null;
  await details(a.iata).catch(() => null);
  return featureOf(a);
}

function rowsFor(a, d, esc) {
  // The name, code, city and country are the panel's title and subtitle (featureAt).
  const rows = d.icao ? [['ICAO code', esc(d.icao)]] : [];
  rows.push(['Type', `${TYPE[a.t]}${d.sched ? ', scheduled flights' : ', no scheduled flights'}`]);
  if (d.elev != null) rows.push(['Elevation', `${num(Math.abs(d.elev))} m ${d.elev < 0 ? 'below' : 'above'} sea level`]);
  if (d.rw) {
    const [n, len, surf] = d.rw;
    rows.push(['Runways', [`${n}`, len ? `longest ${num(len)} m` : '', surf.join(', ')].filter(Boolean).join('; ')]);
  }
  if (d.open) rows.push(['Opened', dateText(d.open)]);
  if (d.op) rows.push(['Operator', esc(d.op.join(', '))]);
  if (d.pax) rows.push(['Passengers', `${num(d.pax[0])} <span class="yr">in ${d.pax[1]}</span>`]);
  if (d.hubs) rows.push(['Hub for', esc(d.hubs.join(', '))]);
  if (d.web) rows.push(['Website', link(d.web, host(d.web), esc)]);
  if (d.wiki) rows.push(['Wikipedia', link(d.wiki, wikiTitle(d.wiki), esc)]);
  return rows;
}

async function query(at, api) {
  try { await load(); } catch { return [['Airports', 'The airport data did not load. Try again in a moment.']]; }
  const [a, dist] = nearest(at);
  if (!a) return [];
  if (dist >= 0.5) return [['Nearest airport', `${api.esc(a.name)} (${a.iata}): ${num(Math.round(dist))} km away`]];
  let d;
  try { d = await details(a.iata); } catch { return [['Details', 'Did not load. Try again in a moment.']]; }
  return rowsFor(a, d, api.esc);
}

// ---- Pictures, fetched on a click -------------------------------------------------------------------------
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
const getJSON = url => fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))));

// The start of the airport's Wikipedia article: its first sentences, up to about 420 characters.
async function summary(wiki) {
  const u = new URL(wiki), title = u.pathname.replace(/^\/wiki\//, '');
  if (!/\.wikipedia\.org$/.test(u.hostname) || !title) return null;
  const j = await getJSON(`https://${u.hostname}/api/rest_v1/page/summary/${encodeURIComponent(decodeURIComponent(title))}`);
  if (j.type !== 'standard' || !j.extract) return null;
  const sentences = j.extract.match(/[^.!?]+[.!?]+(\s|$)/g) || [j.extract];
  let text = '';
  for (const s of sentences) { if (text && (text + s).length > 420) break; text += s; }
  return { text: text.trim(), lang: j.lang || u.hostname.split('.')[0], url: j.content_urls?.desktop?.page || wiki };
}

// Commons photos, as scripts/build_photos.py filters them: photographs (not maps, logos or diagrams) under a free
// licence, in the shape the app's photo viewer takes.
const NOT_PHOTO = /(?<![a-z])(maps?|karte|carte|mapa|mappa|locator|location|lage|flag|flags|flagge|drapeau|bandera|coat of arms|wappen|blason|escudo|stemma|logo|diagram|schema|scheme|plan|grundriss|seal|emblem|symbol|insignia|infographic|chart|layout)(?![a-z])/;
const isPhotoName = t => { const n = t.toLowerCase().replace(/_/g, ' '); return /\.(jpe?g|png)$/.test(n) && !NOT_PHOTO.test(n); };
const plain = s => { const d = document.createElement('div'); d.innerHTML = s || ''; return d.textContent.replace(/\s+/g, ' ').trim(); };
function licence(m) {
  if ((m.NonFree?.value || '').toLowerCase() === 'true') return null;
  const s = plain(m.LicenseShortName?.value).split(',')[0].trim();
  if (/^cc0\b|^cc zero\b/i.test(s)) return 'CC0';
  if (/^(public domain|pd\b|pd-)/i.test(s)) return 'Public domain';
  const x = s.match(/^cc[- ]by(-sa)?[- ](\d\.\d)(?:[- ]([a-z]{2,3}))?$/i);
  return x ? `CC BY${x[1] ? '-SA' : ''} ${x[2]}${x[3] ? ' ' + x[3].toUpperCase() : ''}` : null;
}
function author(m) {
  let s = plain(m.Artist?.value);
  const x = s.match(/No machine-readable author provided\. (.+?) assumed/);
  if (x) s = x[1];
  if (/^(Unknown author ?)+$/.test(s)) s = 'Unknown author';
  return s.length <= 80 ? s : s.slice(0, 79).trimEnd() + '…';
}
const MAX_PHOTOS = 60;
const II = 'prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=330&iiextmetadatafilter=LicenseShortName|Artist|NonFree&iiextmetadatalanguage=en';
async function commons(cat, img) {
  const q = `${COMMONS}?action=query&format=json&origin=*&${II}`;
  const [members, lead] = await Promise.all([
    cat ? getJSON(`${q}&generator=categorymembers&gcmtype=file&gcmlimit=${MAX_PHOTOS}&gcmtitle=${encodeURIComponent('Category:' + cat)}`).catch(() => null) : null,
    img ? getJSON(`${q}&titles=${encodeURIComponent('File:' + img)}`).catch(() => null) : null
  ]);
  const pages = [...Object.values(lead?.query?.pages || {}), ...Object.values(members?.query?.pages || {}).sort((a, b) => a.title.localeCompare(b.title))];
  const seen = new Set(), out = [];
  for (const p of pages) {
    const i = p.imageinfo?.[0];
    if (!i?.thumburl || seen.has(p.title) || !isPhotoName(p.title) || i.width < 400) continue;
    const lic = licence(i.extmetadata || {});
    if (!lic) continue;
    seen.add(p.title);
    out.push({ title: p.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, '').replace(/_/g, ' '), img: i.thumburl,
      page: i.descriptionurl, author: author(i.extmetadata || {}), licence: lic, w: i.thumbwidth, h: i.thumbheight });
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

// A view from above, 320 by 200 CSS pixels drawn at 3 device pixels each, from Sentinel-2 cloudless tiles (10 m a
// pixel, Web Mercator levels 0 to 14). The frame fits the runways' ends (or the longest runway, or 1.5 km) with a
// margin, and is never enlarged more than twice past level 14, so a small field shows with its surroundings.
const SAT_W = 320, SAT_H = 200, SAT_DPR = 3;
const tile = url => new Promise((ok, no) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => ok(i); i.onerror = no; i.src = url; });
async function satellite(a, d) {
  const [lon, lat, wm, hm] = d.frame || [a.lon, a.lat, d.rw?.[1] || 1500, d.rw?.[1] || 1500];
  const W = SAT_W * SAT_DPR, H = SAT_H * SAT_DPR, cos = Math.cos(lat * D2R);
  // Metres per output pixel to fit the frame with a 30% margin; a Web Mercator pixel at level z is 156543 cos(lat) / 2^z m.
  const want = Math.max(1.3 * Math.max(wm, 300) / W, 1.3 * Math.max(hm, 300) / H, 156543.03 * cos / 2 ** 14 / 2);
  const z = Math.max(0, Math.min(14, Math.ceil(Math.log2(156543.03 * cos / want))));
  const scale = 156543.03 * cos / 2 ** z / want; // output pixels per tile pixel
  const n = 2 ** z, world = 256 * n;
  const cx = (lon + 180) / 360 * world;
  const cy = (1 - Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)) / Math.PI) / 2 * world;
  const x0 = cx - W / 2 / scale, y0 = cy - H / 2 / scale, x1 = cx + W / 2 / scale, y1 = cy + H / 2 / scale;
  const jobs = [];
  for (let ty = Math.floor(y0 / 256); ty <= Math.floor(y1 / 256); ty++) {
    if (ty < 0 || ty >= n) continue;
    for (let tx = Math.floor(x0 / 256); tx <= Math.floor(x1 / 256); tx++) {
      jobs.push(tile(EOX(z, ((tx % n) + n) % n, ty)).then(img => [img, tx, ty]));
    }
  }
  const tiles = await Promise.all(jobs); // one missing tile leaves the whole view out
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  for (const [img, tx, ty] of tiles) g.drawImage(img, (tx * 256 - x0) * scale, (ty * 256 - y0) * scale, 256 * scale + 0.5, 256 * scale + 0.5);
  const blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.86));
  return blob && URL.createObjectURL(blob);
}

// The last few airports' pictures, kept so a redraw of the panel does not fetch them again.
const extras = new Map(); // IATA -> Promise of { sat, photos, about }
let current = null, asked = 0; // the photos of the airport the panel shows, for the photo viewer
function picturesFor(a, d) {
  if (!extras.has(a.iata)) {
    const quiet = p => within(p, 10000).catch(() => null);
    extras.set(a.iata, Promise.all([quiet(satellite(a, d)), quiet(d.cat || d.img ? commons(d.cat, d.img) : []), quiet(d.wiki ? summary(d.wiki) : null)])
      .then(([sat, photos, about]) => {
        if (!sat || !photos) extras.delete(a.iata); // timed out or failed: the next opening asks again
        return { sat, photos: photos || [], about };
      }));
    if (extras.size > 8) {
      const [old, job] = extras.entries().next().value;
      extras.delete(old);
      job.then(x => x.sat && URL.revokeObjectURL(x.sat));
    }
  }
  return extras.get(a.iata);
}

const photoButton = (p, i, esc) => `<div class="photo"><button type="button" data-photo="map|airports|${i}" aria-label="${esc(`Photo: ${p.title}. Open the photo`)}" title="${esc(p.title)}">
  <img src="${esc(p.img.replace(/\/\d+px-/, '/330px-'))}" alt="" loading="lazy" decoding="async" width="${p.w}" height="${p.h}"></button></div>`;

// HTML for under the panel's facts: the view from above, the photos (six, then "Show all") and the article's start.
async function more(at, api) {
  const me = ++asked; // only the latest opening sets the viewer's photos: an earlier one may finish later
  await load();
  const [a, dist] = nearest(at);
  if (!a || dist >= 0.5) { if (me === asked) current = null; return ''; }
  const d = await details(a.iata).catch(() => null);
  if (!d) return '';
  const x = await picturesFor(a, d), esc = api.esc;
  if (me !== asked) return '';
  current = { iata: a.iata, photos: x.photos };
  let html = '';
  if (x.sat) html += `<h3>From above</h3><img data-eox src="${x.sat}" alt="${esc(`Satellite view of ${a.name}`)}" width="${SAT_W}" height="${SAT_H}" style="display:block;width:100%;max-width:${SAT_W}px;height:auto;border-radius:6px">`;
  if (x.photos.length) {
    const items = x.photos.map((p, i) => photoButton(p, i, esc)).join('');
    const label = `Show all ${x.photos.length}`;
    html += `<h3>Photos</h3>${x.photos.length <= 6 ? `<div class="photos">${items}</div>`
      : `<div class="photos capped cap6">${items}</div><button type="button" class="link more" data-more="${label}" data-key="airport-photos" aria-expanded="false">${label}</button>`}`;
  }
  if (x.about) html += `<h3>About</h3><p lang="${esc(x.about.lang)}">${esc(x.about.text)}</p>`;
  return html;
}

// ---- Key ---------------------------------------------------------------------------------------------------
const icon = s => `<span style="display:inline-flex;justify-content:center;width:16px;flex:none"><svg width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><path d="${PLANE}" fill="currentColor" stroke="var(--panel)" stroke-width="1.5" paint-order="stroke"/></svg></span>`;
function legend() {
  if (loadFailed) return '<p class="note keep">The airport data did not load. Choose the map again to retry.</p>';
  if (!airports.length) return '<p class="note keep">Loading airports…</p>';
  const n = [0, 0, 0];
  for (const a of airports) n[a.tier]++;
  const rows = [['Large airports', 0], ['Medium airports', 1], [airports.some(a => a.t === 'H' || a.t === 'W') ? 'Small airports, heliports and seaplane bases' : 'Small airports', 2]];
  return `<ul class="swatches ord">${rows.map(([l, t]) => `<li>${icon(SIZE[t])}${l} (${num(n[t])})</li>`).join('')}</ul>`;
}

export default {
  id: 'airports', name: 'Airports', group: 'Transport', dataMap: true,
  // A getter, so Sources shows the copy date once the data has loaded.
  get credit() {
    return `Airports, runways and codes: <a href="https://ourairports.com/data/">OurAirports</a> (public domain${built ? `, copied ${built}` : ''}). ` +
      'Opening dates, operators, passengers, airline hubs and Commons categories: <a href="https://www.wikidata.org/">Wikidata</a> (CC0). ' +
      'Photos: <a href="https://commons.wikimedia.org/">Wikimedia Commons</a>, each under its own free licence (shown with the photo). ' +
      'Summaries: <a href="https://www.wikipedia.org/">Wikipedia</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>. ' +
      `Views from above: EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), ${BY_NC_SA}. ` +
      'Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>';
  },
  // EOX's credit, while an airport's view from above is in the open panel (the app re-reads it as the panel renders).
  onMap: () => (document.querySelector('#info:not([hidden]) img[data-eox]') ? S2_ON_MAP : ''),
  layers: () => [], vector: 'full', click: 'point',
  query, more, featureAt, legend,
  // Searched while the map is shown: every airport by name and IATA code.
  places: () => (airports.length ? (placeList ||= airports.map(featureOf)) : null),
  state: () => (loadFailed ? 'did not load' : airports.length ? '' : 'loading'),
  // The photos of the open airport, for the app's photo viewer (data-photo="map|airports|i").
  photo: i => current?.photos[i] || null,
  overlay: { load: api => load().then(() => api.refresh()), draw, pick },
  placeLabels, namesFirst: true, drawSel
};

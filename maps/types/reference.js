// Reference globe: the look of a printed political desk globe. Pastel countries (neighbours never share a
// tint), a flat pale sea, a 15-degree graticule with the equator, tropics and polar circles named along their
// lines, rivers and lakes, capitals with stars, and serif lettering: country names in spaced capitals, oceans
// and seas in italics set along the parallels. Data: Natural Earth (public domain), scripts/build_reference.py.

import { MAP_FONT as FONT, textWidth } from '../fonts.js';
const SEA = '#a9d4ea';
const INK = '#3b2d26';
const WATER_INK = '#285b84';
const LINE = '#3f7099';
const PAPER = 'rgba(255, 253, 245, 0.6)';
// Six printed-globe tints; no two neighbours share one.
const TINTS = ['#f6dd8c', '#f3b3a6', '#bfdc9a', '#f5bf80', '#cdbbe0', '#e6cfa8'];
const POLAR = '#f3f5f6';
const PARALLELS = [
  [0, 'Equator', true], [23.4363, 'Tropic of Cancer'], [-23.4363, 'Tropic of Capricorn'],
  [66.5637, 'Arctic Circle'], [-66.5637, 'Antarctic Circle']
];
// Oceans are wide, so they get a second label where the first would be on the far side for half the views.
const EXTRA_WATER = [
  { n: 'North Pacific Ocean', cls: 'ocean', r: 0, at: [165, 28] },
  { n: 'South Pacific Ocean', cls: 'ocean', r: 0, at: [-160, -18] }
];

let data = null;
let tint = null; // feature -> tint
const areaOf = new Map(); // ISO3 -> area (steradians), for thinning capitals on the whole-globe view
let starred = new Set(); // ISO3 of the countries the last labels() pass named: below k 1.6 only their capitals get a star

// Largest country first, each taking, of the tints none of its neighbours has, the one used least so far,
// so no tint takes over the globe (greedy colouring with balancing).
function tints(features) {
  if (tint) return tint;
  tint = new Map();
  const used = new Map(TINTS.map(t => [t, 0]));
  const order = features.map((f, i) => i).sort((a, b) => features[b].area - features[a].area);
  for (const i of order) {
    const f = features[i];
    if (f.d.iso3) areaOf.set(f.d.iso3, Math.max(areaOf.get(f.d.iso3) || 0, f.area));
    if (f.d.name === 'Antarctica') { tint.set(f, POLAR); continue; }
    const near = new Set(f.nb.map(j => tint.get(features[j])));
    const free = TINTS.filter(t => !near.has(t));
    const pick = (free.length ? free : TINTS).reduce((a, b) => (used.get(b) < used.get(a) ? b : a));
    used.set(pick, used.get(pick) + f.area);
    tint.set(f, pick);
  }
  return tint;
}
// Which cities can be marked: capitals (on the whole globe only those of countries big enough to be named; the
// draw pass then stars only the countries actually named), and other cities by rank as the globe is zoomed in.
// Only those in the window: zoomed in, the rest of the hemisphere's cities would be projected and drawn off screen.
// Worked out once per frame (the marks and the lettering share it); the near side is a dot product with the view's centre.
const RAD = Math.PI / 180, unitVec = ([lon, lat]) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
let citiesAt = null, citiesNow = [];
function shownCities(k, { center, seen }) {
  if (center === citiesAt) return citiesNow;
  const cmax = k < 1.6 ? -1 : k < 3 ? 2 : k < 6 ? 4 : k < 15 ? 6 : 10;
  const [nx, ny, nz] = unitVec(center), near = Math.sin(0.02); // the app's visible(): under 90 degrees less 0.02 from the centre
  citiesAt = center;
  return (citiesNow = data.cities.filter(c => (c.cap ? k >= 1.6 || (areaOf.get(c.iso) || 0) * k * k >= 0.0004 : c.r <= cmax) && nx * c.v[0] + ny * c.v[1] + nz * c.v[2] > near && seen(c.pt)));
}

// Label boxes ([x0, y0, x1, y1]) are looked up through a grid of 64 px cells, so a test costs the same with
// ten boxes or two thousand. The app and this file both push to `boxes`; new ones are indexed on the next test.
const CELL = 64, grids = new WeakMap();
function* cellsOf(b) {
  for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[2] / CELL); x++)
    for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[3] / CELL); y++) yield (x + 1000) * 10000 + y + 1000;
}
function overlaps(boxes, b) {
  let g = grids.get(boxes);
  if (!g) grids.set(boxes, g = { n: 0, cells: new Map() });
  for (; g.n < boxes.length; g.n++) for (const key of cellsOf(boxes[g.n])) { if (!g.cells.has(key)) g.cells.set(key, []); g.cells.get(key).push(boxes[g.n]); }
  for (const key of cellsOf(b)) for (const o of g.cells.get(key) || []) if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
  return false;
}
// Every fourth point of a line or ring (ends kept), drawn while the globe moves; a ring keeps at least four points.
const thin = l => (l.length <= 8 ? l : l.filter((p, i) => i % 4 === 0 || i === l.length - 1));

// Text set letter by letter along a parallel, centred on a longitude, reading left to right on screen.
// Draws nothing (returns false) when the horizon cuts the line, the line is too short or bent, or the space is taken.
function onParallel(api, text, lat, lon, { font, color, spacing = 0, boxes }) {
  if (api.moving) return false; // ocean, sea and parallel names come back when the globe stops
  const { ctx, proj, visible } = api;
  ctx.font = font;
  // Each letter measured once (cached), with the letter spacing the canvas has now, so nothing is drawn differently.
  const ls = parseFloat(ctx.letterSpacing) || 0, chars = [...text], widths = chars.map(ch => textWidth(ctx, font, ls, ch));
  const W = widths.reduce((s, w) => s + w, 0) + spacing * (chars.length - 1);
  // Degrees of longitude the text can span here (with room to spare), sampled about 64 times.
  const span = Math.min(80, Math.max(4, 1.5 * W / (proj.scale() * Math.cos(lat * Math.PI / 180) || 1) * 180 / Math.PI));
  const pts = [];
  for (let i = -32; i <= 32; i++) { const p = [lon + i * span / 32, lat]; pts.push(visible(p) ? proj(p) : null); }
  const mid = pts.length >> 1;
  if (!pts[mid]) return false;
  let a = mid, b = mid;
  while (a > 0 && pts[a - 1]) a--;
  while (b < pts.length - 1 && pts[b + 1]) b++;
  let run = pts.slice(a, b + 1), c = mid - a;
  if (run.length < 3) return false;
  if (run[run.length - 1][0] < run[0][0]) { run = run.reverse(); c = run.length - 1 - c; } // keep the letters upright
  const len = [0];
  for (let i = 1; i < run.length; i++) len.push(len[i - 1] + Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]));
  let s = len[c] - W / 2;
  if (s < 0 || s + W > len[len.length - 1]) return false;
  const at = t => {
    let i = 1;
    while (i < len.length - 1 && len[i] < t) i++;
    const f = (t - len[i - 1]) / (len[i] - len[i - 1] || 1);
    const [x0, y0] = run[i - 1], [x1, y1] = run[i];
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.atan2(y1 - y0, x1 - x0)];
  };
  const placed = chars.map((ch, k) => { const m = s + widths[k] / 2; s += widths[k] + spacing; return [ch, ...at(m)]; });
  if (Math.abs(placed[placed.length - 1][3] - placed[0][3]) > 1.1) return false; // too bent (near a pole)
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
  const xs = placed.map(p => p[1]), ys = placed.map(p => p[2]);
  const box = [Math.min(...xs) - size / 2, Math.min(...ys) - size / 2, Math.max(...xs) + size / 2, Math.max(...ys) + size / 2];
  if (overlaps(boxes, box)) return false;
  boxes.push(box);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const halo of [true, false]) {
    for (const [ch, x, y, ang] of placed) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
      if (halo) { ctx.lineWidth = 2.4; ctx.strokeStyle = PAPER; ctx.strokeText(ch, 0, 0); } else { ctx.fillStyle = color; ctx.fillText(ch, 0, 0); }
      ctx.restore();
    }
  }
  return true;
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a));
  }
  ctx.closePath();
}

// Meridians and parallels every 15 degrees; meridians stop short of the poles, as on printed gores.
const GRID = (() => {
  const lines = [];
  for (let lon = -180; lon < 180; lon += 15) { const l = []; for (let y = -80; y <= 80; y += 2) l.push([lon, y]); lines.push(l); }
  for (let y = -75; y <= 75; y += 15) { if (y === 0) continue; const l = []; for (let x = -180; x <= 180; x += 2) l.push([x, y]); lines.push(l); }
  return { type: 'MultiLineString', coordinates: lines };
})();
const parallel = lat => { const l = []; for (let x = -180; x <= 180; x += 1) l.push([x, lat]); return { type: 'LineString', coordinates: l }; };
// Under a moving finger: every fourth point (8 and 4 degrees apart), a curve still smooth to under a pixel on a phone.
const GRID_LITE = { type: 'MultiLineString', coordinates: GRID.coordinates.map(thin) };
const PARALLELS_LITE = new Map(PARALLELS.map(([lat]) => [lat, { type: 'LineString', coordinates: thin(parallel(lat).coordinates) }]));

export default {
  id: 'reference', name: 'Atlas', group: 'Countries and borders',
  credit: '<a href="https://www.naturalearthdata.com/">Natural Earth</a> (public domain)',
  layers: () => [], vector: 'none', click: 'country', drawsCapitals: true,
  ink: { text: INK, halo: 'rgba(255, 253, 245, 0.85)' }, // the globe is light in both themes, so the app's names use its ink
  // With a colouring set the colouring's key is the one that matters: the star and dot need no key beside it, and the
  // sentence about the tints would be wrong, so the map's own key is left out.
  legend: ({ mode } = {}) => mode && mode !== 'none' ? '' : `<ul class="swatches reflegend">
      <li><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5l1.8 4.3 4.6.3-3.6 2.9 1.2 4.5L8 11l-4 2.5 1.2-4.5L1.6 6.1l4.6-.3z" fill="#8b1d1d" stroke="rgba(255, 253, 245, 0.85)" stroke-width="1.2" stroke-linejoin="round" paint-order="stroke"/></svg>National capital</li>
      <li><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6" fill="${INK}" stroke="rgba(255, 253, 245, 0.85)"/></svg>City</li>
    </ul><p class="note keep">The tints only tell neighbours apart; they carry no meaning.</p>`,

  overlay: {
    async load() {
      const [json] = await Promise.all([
        fetch('data/maps/reference/reference.json').then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status)))),
        document.fonts?.load(`600 12px ${FONT}`), document.fonts?.load(`italic 500 12px ${FONT}`)
      ]);
      data = { ...json, water: [...json.water, ...EXTRA_WATER] };
      for (const c of data.cities) { c.v = unitVec(c.at); c.pt = { c: c.at, r: 0 }; } // pt: one cap object per city, so seen() keeps its vector
      // Each river and lake gets a bounding cap, so a frame draws only the rivers and lakes that can be on screen.
      const capOf = pts => { const c = pts[pts.length >> 1], u = unitVec(c); return { c, r: Math.acos(Math.max(-1, Math.min(...pts.map(p => { const v = unitVec(p); return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; })))) }; };
      for (const r of data.rivers) { r.cap = capOf(r.c.flat()); r.lite = r.c.map(thin); }
      for (const l of data.lakes) l.cap = capOf(l.c.flat(2));
      // A thinned ring whose winding flips would fill the rest of the sphere (d3-geo reads winding as inside/outside): keep those rings whole.
      const side = g => d3.geoArea({ type: 'Polygon', coordinates: [g] }) > 2 * Math.PI;
      for (const l of data.lakes) { l.lite = l.c.map(poly => poly.map(ring => { const t = thin(ring); return side(t) === side(ring) ? t : ring; })); l.area = d3.geoArea({ type: 'MultiPolygon', coordinates: l.c }); }
    },
    // Lakes, rivers, capitals and cities: over the countries, under the app's own markers.
    draw(api) {
      if (!data) return;
      const { ctx, proj, k, visible, seen, projected, paint: draw } = api;
      const m = api.moving;
      // A phone finger on the globe (api.lite): lakes under 3 square pixels wait, and lake shores are not drawn.
      const px = proj.scale() ** 2;
      const lakes = projected(`ref:lakes:${k >= 3}`, () => data.lakes.filter(l => (l.r <= 2 || k >= 3) && (!api.lite || l.area * px >= 3) && visible(l.at) && seen(l.cap)).map(l => ({ type: 'MultiPolygon', coordinates: m ? l.lite : l.c })));
      ctx.fillStyle = SEA; draw(lakes, 'fill');
      if (!api.lite) { ctx.lineWidth = 0.6; ctx.strokeStyle = LINE; draw(lakes, 'stroke'); }
      const rmax = (k < 1.6 ? 3 : k < 3 ? 5 : 9) - (api.lite ? 2 : 0);
      const rivers = projected(`ref:rivers:${rmax}`, () => data.rivers.filter(r => r.r <= rmax && seen(r.cap)).map(r => ({ type: 'MultiLineString', coordinates: m ? r.lite : r.c })));
      ctx.lineWidth = k < 3 ? 0.7 : 1; ctx.strokeStyle = '#4f95c8'; ctx.lineJoin = 'round'; draw(rivers, 'stroke');
      for (const c of shownCities(k, api)) {
        if (c.cap && k < 1.6 && !starred.has(c.iso)) continue; // whole globe: no star for a country left unnamed
        const [x, y] = proj(c.at);
        if (c.cap) {
          star(ctx, x, y, k < 2 ? 3.6 : 4.6);
          ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255, 253, 245, 0.85)'; ctx.stroke();
          ctx.fillStyle = '#8b1d1d'; ctx.fill();
        } else {
          ctx.beginPath(); ctx.arc(x, y, k < 6 ? 2 : 2.4, 0, 2 * Math.PI);
          ctx.fillStyle = INK; ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255, 253, 245, 0.85)'; ctx.stroke();
        }
      }
    }
  },

  // The sea, the graticule and the countries, in place of the app's own sea and fills. Under a colouring
  // the countries take the app's colours (fill) in place of the tints, which would muddy the data.
  paint(api) {
    const { ctx, features, fillShape: shape, seen, borders, coast, inScope, fill, out, projected, paint: draw } = api;
    ctx.fillStyle = SEA; draw(projected('ref:sphere', () => ({ type: 'Sphere' })), 'fill');
    ctx.lineWidth = 0.5; ctx.strokeStyle = 'rgba(63, 112, 153, 0.45)'; draw(api.lite ? GRID_LITE : projected(GRID, () => GRID), 'stroke');
    const t = tints(features), groups = new Map();
    for (const f of features) {
      if (!seen(f.cap)) continue;
      const g = shape(f);
      if (!g) continue;
      const col = fill ? fill(f) : inScope(f) ? t.get(f) : out;
      if (!groups.has(col)) groups.set(col, []);
      groups.get(col).push(projected(f, () => g));
    }
    // One path per tint (Path2D pieces joined at rest, GeoJSON while moving).
    for (const [col, ps] of groups) {
      let x = ps;
      if (ps[0] instanceof Path2D) { x = new Path2D(); for (const p of ps) x.addPath(p); }
      ctx.fillStyle = col; draw(x, 'fill');
    }
    ctx.lineWidth = 0.7; ctx.strokeStyle = '#8b6f5a'; draw(borders, 'stroke');
    ctx.lineWidth = 0.8; ctx.strokeStyle = LINE; draw(coast, 'stroke');
    // The equator solid; tropics and polar circles dashed, as printed.
    for (const [lat, , solid] of PARALLELS) {
      ctx.setLineDash(solid ? [] : [5, 4]); ctx.lineWidth = solid ? 1.1 : 0.8; ctx.strokeStyle = LINE;
      draw(api.lite ? PARALLELS_LITE.get(lat) : projected(`ref:parallel:${lat}`, () => parallel(lat)), 'stroke');
    }
    ctx.setLineDash([]);
  },

  // Lettering, placed before the app's hot-spot names, which take the room left (a selected country's name comes first).
  labels(api) {
    if (!data) return;
    const { ctx, proj, k, visible, boxes, byArea, center } = api;
    // Under a colouring a name on a deep fill takes light ink on a dark halo (api.inkOf); otherwise the globe's own ink.
    const inkOf = api.inkOf || (() => null), fOf = api.inkOf ? new Map(byArea.map(f => [f.d.iso3, f])) : null;
    // The app's own names (a selected or compared country) are centred on the country's label point, as these are.
    const app = boxes.slice(), byApp = (x, y) => app.some(b => Math.abs(b[0] + b[2] - 2 * x) < 2 && Math.abs(b[1] + b[3] - 2 * y) < 2);
    // The capital stars and city dots are already drawn (or could be): keep the lettering off them. On the whole globe
    // a star shows only for a named country, so those boxes wait until the names are placed.
    const cities = shownCities(k, api), early = k >= 1.6;
    const dot = c => { const [x, y] = proj(c.at); boxes.push([x - 4, y - 4, x + 4, y + 4]); };
    if (early) cities.forEach(dot);
    const named = [];
    for (const w of data.water) {
      if (w.cls !== 'ocean' || !visible(w.at)) continue;
      // One label per ocean in view (the extra labels are for when the first is round the back).
      if (named.includes(w.n)) continue;
      const size = Math.min(19, 13 + 2.5 * Math.log2(k + 1));
      if (onParallel(api, w.n.toUpperCase(), w.at[1], w.at[0], { font: `italic 500 ${size}px ${FONT}`, color: WATER_INK, spacing: size * 0.32, boxes })) named.push(w.n);
    }
    // Countries in spaced capitals, sized by area; the smallest only when there is room.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const now = new Set(), capOf = new Map(cities.filter(c => c.cap).map(c => [c.iso, c]));
    for (const f of byArea) {
      if (!visible(f.label)) continue;
      if (f.area * k * k < 0.0004) continue;
      // While the globe moves, sizes go in whole pixels and widths are scaled from one measure at 20px, so a pinch
      // reuses a few fonts and measures nothing new.
      const exact = Math.min(22, 8.5 + 26 * Math.sqrt(f.area) * k), size = api.moving ? Math.round(exact) : exact;
      const [x, y] = proj(f.label);
      const text = f.d.name.toUpperCase();
      const est = textWidth(ctx, `600 20px ${FONT}`, 2.4, text) * size / 20;
      const h = size * 0.6;
      // The country's own star stays clear of its name: where they meet, the name moves just past the star.
      const cap = capOf.get(f.d.iso3), s = cap && proj(cap.at);
      const nearStar = w => s && Math.abs(s[0] - x) < w / 2 + 6 && Math.abs(s[1] - y) < h + 4;
      const place = w => (nearStar(w) ? (s[1] < y ? [1, -1] : [-1, 1]).map(d => s[1] + d * (h + 5)) : [y])
        .map(v => [x - w / 2 - 2, v - h, x + w / 2 + 2, v + h]).find(b => b[0] >= 4 && b[2] <= api.w - 4 && api.onFace(b) && !overlaps(boxes, b)); // not cut by the window edge or the limb
      const mine = byApp(x, y); // the app has named it already (a compared country whose name would step past its star)
      // At rest the exact width needs this size's font, which costs about a millisecond on a phone the first time. A name
      // that cannot fit even at a lower bound of the scaled width is not measured: a wider box cannot fit either.
      const lo = est * 0.97 - 1, hi = est * 1.03 + 1;
      const fit = !mine && (api.moving ? place(est)
        : (nearStar(lo) !== nearStar(hi) || place(lo)) && place(textWidth(ctx, `600 ${size}px ${FONT}`, size * 0.12, text)));
      if (fit) {
        boxes.push(fit); now.add(f.d.iso3);
        const ty = (fit[1] + fit[3]) / 2;
        ctx.font = `600 ${size}px ${FONT}`; ctx.letterSpacing = `${size * 0.12}px`;
        const on = inkOf(f);
        ctx.lineWidth = on ? 3 : 2.5; ctx.strokeStyle = on ? on.halo : PAPER; ctx.strokeText(text, x, ty);
        ctx.fillStyle = on ? on.text : INK; ctx.fillText(text, x, ty);
      } else if (mine) now.add(f.d.iso3);
      if (!early && cap && now.has(f.d.iso3)) dot(cap); // later names, seas, parallels and hot-spot names keep off the star
      ctx.letterSpacing = '0px';
    }
    // The stars were drawn from the previous pass's names; when the names changed, draw once more so they match
    // (the names do not depend on the stars, so the second pass finds the same names and stops).
    const changed = [...now].join() !== [...starred].join();
    starred = now;
    if (changed && k < 1.6) api.draw();
    // Seas, gulfs and bays in italic, more of them as the globe is zoomed in.
    const wmax = k < 1.3 ? 0 : k < 2.2 ? 1 : k < 4 ? 2 : k < 8 ? 3 : 9;
    for (const w of data.water) {
      if (w.cls === 'ocean' || w.r > wmax || !visible(w.at)) continue;
      onParallel(api, w.n, w.at[1], w.at[0], { font: `italic 500 ${w.r <= 1 ? 12.5 : 11.5}px ${FONT}`, color: WATER_INK, spacing: 0.6, boxes });
    }
    // The named parallels, lettered a little east of the middle of the view.
    for (const [lat, name] of PARALLELS) {
      const lon = center[0] + 25;
      if (visible([lon, lat])) onParallel(api, name.toUpperCase(), lat, lon, { font: `italic 500 9px ${FONT}`, color: LINE, spacing: 1.6, boxes });
    }
    if (api.moving) return; // city names come back when the globe stops
    // City names, capitals first; on the whole globe the stars stand alone.
    ctx.textAlign = 'left';
    for (const c of cities) {
      if (k < (c.cap ? 1.8 : 3)) continue;
      const [x, y] = proj(c.at);
      ctx.font = `${c.cap ? 'italic 500 11.5px' : '500 11px'} ${FONT}`;
      const w = ctx.measureText(c.n).width, box = [x + 5, y - 7, x + 7 + w, y + 7];
      if (box[2] > api.w - 4 || x < 4 || !api.onFace(box) || overlaps(boxes, box)) continue; // not cut by the window edge or the limb
      boxes.push(box);
      const on = fOf && inkOf(fOf.get(c.iso));
      ctx.lineWidth = on ? 3 : 2.5; ctx.strokeStyle = on ? on.halo : 'rgba(255, 253, 245, 0.7)'; ctx.strokeText(c.n, x + 6, y);
      ctx.fillStyle = on ? on.text : INK; ctx.fillText(c.n, x + 6, y);
    }
    ctx.textAlign = 'center';
  }
};

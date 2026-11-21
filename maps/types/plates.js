// Plate tectonics: Peter Bird's PB2002 model (2003). Boundaries are drawn step by step (each 30-100 km), coloured
// by Bird's class; subduction zones carry teeth on the overriding plate; arrows show the modelled relative motion.
// Data: data/maps/plates/ (scripts/build_plates.py). steps.json loads with the map, plates.json on the first click.

import { terrainSource } from '../relief.js';

const DATA = new URL('../../data/maps/plates/', import.meta.url);
const RELIEF = terrainSource('bathy'); // same id as the Bathymetric map's source, so their tiles are shared
import { MAP_FONT as FONT } from '../fonts.js';
const CASING = 'rgba(0, 0, 0, 0.55)';
const R_KM = 6371.0088;

// Bird's step classes, in the order the build script writes them. Colours: Okabe-Ito (colour-blind safe);
// dashed where the boundary runs through continental crust.
const KINDS = [
  { code: 'OSR', name: 'Spreading ridge', c: '#f0e442' },
  { code: 'CRB', name: 'Continental rift', c: '#f0e442', dash: [5, 3] },
  { code: 'OTF', name: 'Transform fault, oceanic', c: '#009e73' },
  { code: 'CTF', name: 'Transform fault, continental', c: '#009e73', dash: [5, 3] },
  { code: 'SUB', name: 'Subduction zone', c: '#d55e00' },
  { code: 'OCB', name: 'Convergent, oceanic', c: '#cc79a7' },
  { code: 'CCB', name: 'Collision zone, continental', c: '#cc79a7', dash: [5, 3] }
];
const SUB = 4;
const arrowLen = mm => 4 + 2.2 * Math.sqrt(mm); // px; 20 mm a year is 14 px, 80 is 24 px

let steps = [], plates = [], chains = [], outlines = null;
const recent = []; // boundary points just picked: a click there reads the boundary, not the plate on one side

const plateName = i => `${plates[i].name} plate`;
const compass = az => ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east',
  'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west',
  'north-north-west'][Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

const D2R = Math.PI / 180;
const xyz = ([lon, lat]) => { const c = Math.cos(lat * D2R); return [c * Math.cos(lon * D2R), c * Math.sin(lon * D2R), Math.sin(lat * D2R)]; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const FRONT = Math.sin(0.02); // as app.js's visible(): more than 0.02 rad in front of the horizon

// Steps joined into short runs of one class (at most 24 steps, so runs off screen can be skipped cheaply).
// Points carry unit vectors, so "is it in front" is one dot product rather than a great-circle distance.
function buildChains() {
  chains = [];
  let cur = null;
  steps.forEach((s, i) => {
    const prev = steps[i - 1];
    if (!cur || s.k !== prev.k || s.a[0] !== prev.b[0] || s.a[1] !== prev.b[1] || cur.ids.length >= 24) {
      cur = { k: s.k, ids: [], line: [s.a] };
      chains.push(cur);
    }
    cur.ids.push(i);
    cur.line.push(s.b);
  });
  for (const ch of chains) {
    ch.v = ch.line.map(xyz);
    ch.mid = xyz(steps[ch.ids[ch.ids.length >> 1]].m);
    ch.r = Math.max(...ch.v.map(p => Math.acos(Math.min(1, dot(p, ch.mid)))));
  }
}

// The part of the globe that can be on screen, as an angle from the centre (as app.js does for countries).
function viewRadius(api) {
  const [tx, ty] = api.proj.translate(), k = api.proj.scale();
  const corner = Math.max(Math.hypot(tx, ty), Math.hypot(api.w - tx, ty), Math.hypot(tx, api.h - ty), Math.hypot(api.w - tx, api.h - ty));
  return corner >= k ? Math.PI / 2 : Math.asin(corner / k);
}

// Projects the runs within `reach` radians of `at` (and in front of the globe); each gets xy: [x, y] or null per point.
function project(api, at, reach) {
  const cv = xyz(api.center), av = xyz(at), out = [];
  for (const ch of chains) {
    if (Math.acos(Math.min(1, dot(ch.mid, av))) - ch.r > reach) continue;
    ch.xy = ch.line.map((p, j) => (dot(ch.v[j], cv) > FRONT ? api.proj(p) : null));
    out.push(ch);
  }
  return out;
}

// The steps of a run on screen: ends, length, middle and left-hand normal (left as seen walking from start to end).
function* onScreen(ch) {
  for (let j = 0; j < ch.ids.length; j++) {
    const p = ch.xy[j], q = ch.xy[j + 1];
    if (!p || !q) continue;
    const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy);
    if (L < 0.01) continue;
    yield { s: steps[ch.ids[j]], p, q, L, m: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], n: [dy / L, -dx / L] };
  }
}

// The part of segment v (0..1) inside the screen plus a 12 px margin, or null (Liang-Barsky).
function clip(v, W, H) {
  let t0 = 0, t1 = 1;
  const dx = v.q[0] - v.p[0], dy = v.q[1] - v.p[1];
  for (const [p, q] of [[-dx, v.p[0] + 12], [dx, W + 12 - v.p[0]], [-dy, v.p[1] + 12], [dy, H + 12 - v.p[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [t0, t1];
}

// Calls fn(x, y, v) every `gap` px along a run's on-screen steps, starting `first` px in; the spacing carries from
// one step to the next, so marks keep their rhythm however long a step is on screen.
function along(ch, gap, first, api, fn) {
  let next = first; // distance into the current step of the next mark
  for (const v of onScreen(ch)) {
    const c = clip(v, api.w, api.h);
    if (c) {
      let d = next;
      if (d < c[0] * v.L) d += Math.ceil((c[0] * v.L - d) / gap) * gap;
      for (; d <= c[1] * v.L; d += gap) fn(v.p[0] + (v.q[0] - v.p[0]) * d / v.L, v.p[1] + (v.q[1] - v.p[1]) * d / v.L, v);
    }
    next = next > v.L ? next - v.L : gap - ((v.L - next) % gap);
  }
}

function draw(api) {
  const { ctx, k } = api;
  const shown = project(api, api.center, viewRadius(api) + 0.01);
  const w = Math.min(2.6, 1.4 + 0.35 * Math.log2(Math.max(1, k)));
  ctx.lineJoin = 'round';
  // Straight segments between projected points: steps are at most about 100 km, so the curve is not visible.
  // Each step is cut to the window, so a step that runs far off screen at house zoom does not cost its dashes.
  KINDS.forEach((kind, i) => {
    ctx.beginPath();
    let any = false;
    for (const ch of shown) {
      if (ch.k !== i) continue;
      let pen = false;
      for (let j = 0; j + 1 < ch.xy.length; j++) {
        const p = ch.xy[j], q = ch.xy[j + 1], c = p && q && clip({ p, q }, api.w, api.h);
        if (!c) { pen = false; continue; }
        const at = t => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        if (!pen || c[0] > 0) { ctx.moveTo(...at(c[0])); any = true; }
        ctx.lineTo(...at(c[1]));
        pen = c[1] === 1;
      }
    }
    if (!any) return;
    ctx.setLineDash([]); ctx.lineWidth = w + 2; ctx.strokeStyle = CASING; ctx.stroke();
    ctx.setLineDash(kind.dash || []); ctx.lineWidth = w; ctx.strokeStyle = kind.c; ctx.stroke();
  });
  ctx.setLineDash([]);

  // Teeth on the overriding plate, every 18 px along each subduction zone (at 9, 27, 45... px: the arrow pairs
  // below sit at 54, 144... px, halfway between two teeth).
  const t = Math.min(5, 2.5 + 0.4 * Math.log2(Math.max(1, k)));
  ctx.beginPath();
  for (const ch of shown) {
    if (ch.k !== SUB) continue;
    along(ch, 18, 9, api, (x, y, v) => {
      const side = v.s.over === v.s.left ? 1 : -1, n = [v.n[0] * side, v.n[1] * side], u = [-v.n[1], v.n[0]];
      const mx = x + n[0] * w / 2, my = y + n[1] * w / 2;
      ctx.moveTo(mx + u[0] * t, my + u[1] * t);
      ctx.lineTo(mx + n[0] * t * 1.5, my + n[1] * t * 1.5);
      ctx.lineTo(mx - u[0] * t, my - u[1] * t);
      ctx.closePath();
    });
  }
  ctx.lineWidth = 1; ctx.strokeStyle = CASING; ctx.stroke();
  ctx.fillStyle = KINDS[SUB].c; ctx.fill();

  // Relative motion, zoomed in and at rest: a pair of arrows every 90 px along each boundary.
  if (k >= 2.5 && !api.moving) {
    const deg = Math.min(0.05, 600 / api.proj.scale()); // about 10 px on screen, to find the arrow's direction
    ctx.beginPath();
    for (const ch of shown) {
      along(ch, 90, 54, api, (x, y, v) => {
        const s = v.s, at = api.proj.invert([x, y]);
        if (s.v < 0.5 || !at || Number.isNaN(at[0])) return;
        const az = s.az * D2R, c = Math.max(0.05, Math.cos(at[1] * D2R));
        const to = [at[0] + deg * Math.sin(az) / c, at[1] + deg * Math.cos(az)];
        if (!api.visible(to)) return;
        const b = api.proj(to), d = Math.hypot(b[0] - x, b[1] - y);
        if (d < 1e-6) return;
        const u = [(b[0] - x) / d, (b[1] - y) / d], len = arrowLen(s.v);
        const off = 4 + Math.abs(u[0] * v.n[0] + u[1] * v.n[1]) * len / 2;
        // The left plate moves along u relative to the right one; each side gets its own arrow.
        for (const sg of [1, -1]) arrow(ctx, x + v.n[0] * off * sg, y + v.n[1] * off * sg, u[0] * sg, u[1] * sg, len);
      });
    }
    ctx.lineCap = 'round';
    ctx.lineWidth = 3.5; ctx.strokeStyle = api.C.halo; ctx.stroke();
    ctx.lineWidth = 1.4; ctx.strokeStyle = api.C.text; ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // Plate names, largest first, where they fit.
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `italic 600 12px ${FONT}`;
  const boxes = [], [cx, cy] = api.proj.translate(), R = api.proj.scale();
  for (const i of plates.order) {
    const p = plates[i];
    if (p.sr * k * k < 0.05) break;
    if (!api.visible(p.at)) continue;
    const [x, y] = api.proj(p.at), text = plateName(i), half = ctx.measureText(text).width / 2 + 3;
    const box = [x - half, y - 9, x + half, y + 9];
    // Whole names only: none cut by the screen edge or running off the globe.
    if (box[0] < 0 || box[1] < 0 || box[2] > api.w || box[3] > api.h || Math.hypot(x - cx, y - cy) + half > R) continue;
    if (boxes.some(o => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
    boxes.push(box);
    ctx.lineWidth = 3; ctx.strokeStyle = api.C.halo; ctx.strokeText(text, x, y);
    ctx.fillStyle = api.C.text; ctx.fillText(text, x, y);
  }
}

function arrow(ctx, cx, cy, ux, uy, len) {
  const hx = cx + ux * len / 2, hy = cy + uy * len / 2, h = Math.min(5, len * 0.35);
  ctx.moveTo(cx - ux * len / 2, cy - uy * len / 2); ctx.lineTo(hx, hy);
  ctx.moveTo(hx - ux * h - uy * h * 0.6, hy - uy * h + ux * h * 0.6); ctx.lineTo(hx, hy);
  ctx.lineTo(hx - ux * h + uy * h * 0.6, hy - uy * h - ux * h * 0.6);
}

function pick(x, y, api) {
  const ll = api.proj.invert([x, y]);
  if (!ll || Number.isNaN(ll[0])) return null;
  let best = null, bd = 8, bt = 0;
  // Only the runs near the pointer; 40 px of slack covers the squeeze towards the rim.
  for (const ch of project(api, ll, 0.01 + 40 / api.proj.scale())) {
    for (const v of onScreen(ch)) {
      const t = Math.max(0, Math.min(1, ((x - v.p[0]) * (v.q[0] - v.p[0]) + (y - v.p[1]) * (v.q[1] - v.p[1])) / (v.L * v.L)));
      const d = Math.hypot(v.p[0] + t * (v.q[0] - v.p[0]) - x, v.p[1] + t * (v.q[1] - v.p[1]) - y);
      if (d < bd) { bd = d; best = v.s; bt = t; }
    }
  }
  if (!best) return null;
  const s = best, kind = KINDS[s.k], L = plateName(s.left), Rt = plateName(s.right);
  const at = d3.geoInterpolate(s.a, s.b)(bt);
  recent.push(at); if (recent.length > 30) recent.shift();
  const mm = v => `${Math.abs(v).toLocaleString('en', { maximumFractionDigits: 1 })} mm a year`;
  const under = s.over === s.left ? Rt : L;
  const rows = [
    ['Plates', `${L} and ${Rt}`],
    ...(s.k === SUB ? [['Overriding plate', plateName(s.over)], ['Sinking plate', under]] : []),
    ['Relative speed', mm(s.v)],
    ['Direction', `The ${L} moves towards ${s.az}° (${compass(s.az)}) relative to the ${Rt}`],
    [s.di >= 0 ? 'Opening' : 'Closing', `${mm(s.di)} (across the boundary)`],
    ['Sliding', `${mm(s.ri)} (along the boundary)${Math.abs(s.ri) >= 0.05 ? `, ${s.ri > 0 ? 'right' : 'left'}-lateral: seen from either side, the other plate moves to the ${s.ri > 0 ? 'right' : 'left'}` : ''}`],
    ...(s.orogen ? [['Orogen', 'Inside one of the model\'s orogens, wide belts of deformation where rigid-plate speeds are less reliable']] : []),
    ['Model', `PB2002 class ${kind.code}. Speeds at this spot are computed from the model's plate rotations (2003)`]
  ];
  return {
    title: kind.name,
    sub: s.k === SUB ? `The ${under} sinks under the ${plateName(s.over)}` : `Between the ${L} and the ${Rt}`,
    at, rows
  };
}

// Point-in-polygon on the plate outlines (cut at the antimeridian, so a flat lon/lat test is right).
function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function query(at) {
  if (recent.some(p => Math.abs(p[0] - at[0]) < 1e-7 && Math.abs(p[1] - at[1]) < 1e-7)) return [];
  await plateType.overlay.loading; // app.js's load of steps.json: a point opened from the URL can come first
  if (!plates.length) return [['Plate', 'The plate data did not load. Choose the map again to retry.']];
  if (!outlines) {
    outlines = fetch(new URL('plates.json', DATA)).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    outlines.catch(() => { outlines = null; });
  }
  let o;
  try { o = await outlines; } catch { return [['Plate', 'The plate outlines did not load. Try again in a moment.']]; }
  const [lon, lat] = at;
  const code = o.codes.find(c => o.polys[c].some(poly => inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h))));
  const i = plates.findIndex(p => p.code === code);
  if (i < 0) return [['Plate', 'Not on any plate in the model (a gap at the edge of an outline)']];
  const near = [...new Set(steps.flatMap(s => (s.left === i ? [s.right] : s.right === i ? [s.left] : [])))].map(j => plates[j].name).sort();
  const km2 = plates[i].km2; // three figures: the outline is rounded to 0.01°
  return [
    ['Plate', plateName(i)],
    ['Plate area', `${km2 >= 1e6 ? `${+(km2 / 1e6).toPrecision(3)} million` : (+km2.toPrecision(3)).toLocaleString('en')} km² (from the PB2002 outline)`],
    ['Borders', near.join(', ')]
  ];
}

const line = (kind, extra = '') => `<svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true" style="flex:none">
  <path d="M1 6H21" stroke="${CASING}" stroke-width="4.5"/><path d="M1 6H21" stroke="${kind.c}" stroke-width="2.5"${kind.dash ? ' stroke-dasharray="5 3"' : ''}/>${extra}</svg>`;
const arrowSvg = mm => { const l = arrowLen(mm); return `<svg width="${l + 4}" height="10" viewBox="0 0 ${l + 4} 10" aria-hidden="true" style="flex:none;vertical-align:middle"><path d="M2 5H${l + 2}M${l - 2} 2L${l + 2} 5L${l - 2} 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`; };

const plateType = {
  id: 'plates', name: 'Plate tectonics', group: 'Earth science', dataMap: true,
  credit: 'Plates and boundaries: <a href="https://doi.org/10.1029/2001GC000252">Bird (2003), PB2002</a>, GeoJSON by Hugo Ahlenius, Nordpil and Peter Bird (<a href="https://github.com/fraxen/tectonicplates">fraxen/tectonicplates</a>, <a href="https://opendatacommons.org/licenses/by/1-0/">ODC-BY 1.0</a>). Relief: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen on AWS: SRTM, GMTED2010, ETOPO1, GEBCO and <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">others</a>). Borders: <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
  countryLabels: false, // plate names instead of country names (takes effect with the app.js change in the report)
  // A quiet relief base: sea-floor depth at half strength, so ridges and trenches show under the lines.
  layers: () => [{ src: RELIEF, opacity: 0.55 }],
  vector: 'full', click: 'point',
  query,
  legend: () => `<ul class="swatches">${KINDS.map((kind, i) => `<li>${line(kind, i === SUB ? `<path d="M9 4.5L11 0.5L13 4.5Z" fill="${kind.c}" stroke="${CASING}" stroke-width="1"/>` : '')}${kind.name}</li>`).join('')}</ul>
    <p class="note keep">Closer in, arrows show the two plates' relative motion. ${arrowSvg(20)} 20 mm a year, ${arrowSvg(80)} 80 mm a year.</p>`,
  overlay: {
    async load() {
      const r = await fetch(new URL('steps.json', DATA));
      if (!r.ok) throw new Error(`plates ${r.status}`);
      const d = await r.json();
      plates = d.plates.map(([code, name, at, km2]) => ({ code, name, at, km2, sr: km2 / (R_KM * R_KM) }));
      steps = d.steps.map(([x1, y1, x2, y2, k, left, right, over, v, az, di, ri, orogen]) => ({
        a: [x1, y1], b: [x2, y2], m: d3.geoInterpolate([x1, y1], [x2, y2])(0.5), k, left, right, over, v, az, di, ri, orogen
      }));
      buildChains();
      // Labels are drawn largest first; steps refer to plates by index, so the order is kept apart.
      plates.order = plates.map((p, i) => i).sort((a, b) => plates[b].sr - plates[a].sr);
    },
    draw, pick
  }
};
export default plateType;

// Geologic: Macrostrat's blended geologic map (800+ source maps, CC BY 4.0) as 512 px raster tiles, and the
// Macrostrat API for the rock unit at a clicked point. Both send CORS headers, so nothing is self-hosted.

const API = 'https://macrostrat.org/api/v2/mobile/map_query_v2';
// No TileJSON exists (carto.json is a 404), so the template and zoom range are fixed here. Low-zoom tiles are
// heavy (150 to 420 KB each), which the engine's cap on parallel loads keeps in check.
const CARTO = { id: 'macrostrat-carto', url: 'https://tiles.macrostrat.org/carto/{z}/{x}/{y}.png', tileSize: 512, maxZoom: 14 };

// International periods and Precambrian eras: names, ages in millions of years (top, base) and the standard
// chart colours, as Macrostrat's /defs/intervals gives them (international periods and eras, read 2026-11-16).
const PERIODS = [
  ['Quaternary', 0, 2.58, '#F9F97F', 'Cenozoic'], ['Neogene', 2.58, 23.04, '#FFE619', 'Cenozoic'],
  ['Paleogene', 23.04, 66, '#FD9A52', 'Cenozoic'], ['Cretaceous', 66, 143.1, '#7FC64E', 'Mesozoic'],
  ['Jurassic', 143.1, 201.4, '#34B2C9', 'Mesozoic'], ['Triassic', 201.4, 251.902, '#812B92', 'Mesozoic'],
  ['Permian', 251.902, 298.9, '#F04028', 'Paleozoic'], ['Carboniferous', 298.9, 358.86, '#67A599', 'Paleozoic'],
  ['Devonian', 358.86, 419.62, '#CB8C37', 'Paleozoic'], ['Silurian', 419.62, 443.1, '#B3E1B6', 'Paleozoic'],
  ['Ordovician', 443.1, 486.85, '#009270', 'Paleozoic'], ['Cambrian', 486.85, 538.8, '#7FA056', 'Paleozoic'],
  ['Ediacaran', 538.8, 635, '#FFC3E1', 'Neoproterozoic'], ['Cryogenian', 635, 720, '#FFAFD7', 'Neoproterozoic'],
  ['Tonian', 720, 1000, '#FFA5D2', 'Neoproterozoic'], ['Stenian', 1000, 1200, '#FFA5D2', 'Mesoproterozoic'],
  ['Ectasian', 1200, 1400, '#FF98CC', 'Mesoproterozoic'], ['Calymmian', 1400, 1600, '#FF8BC5', 'Mesoproterozoic'],
  ['Statherian', 1600, 1800, '#EE93C1', 'Paleoproterozoic'], ['Orosirian', 1800, 2050, '#E874AF', 'Paleoproterozoic'],
  ['Rhyacian', 2050, 2300, '#EB84B8', 'Paleoproterozoic'], ['Siderian', 2300, 2500, '#E874AF', 'Paleoproterozoic']
];
const ERAS = [
  ['Cenozoic', 0, 66], ['Mesozoic', 66, 251.902], ['Paleozoic', 251.902, 538.8], ['Neoproterozoic', 538.8, 1000, '#FF9BCD'],
  ['Mesoproterozoic', 1000, 1600, '#FF7EBF'], ['Paleoproterozoic', 1600, 2500, '#E665A6'],
  ['Neoarchean', 2500, 2800], ['Mesoarchean', 2800, 3200], ['Paleoarchean', 3200, 3600], ['Eoarchean', 3600, 4031]
];

// Line colours of the Macrostrat raster tiles (style.mss in UW-Macrostrat/macrostrat, legacy-tileserver).
const LINES = [
  ['#777777', 'Unit boundary'], ['#000000', 'Fault (break)'], ['#F012BE', 'Fold (bent layers)'],
  ['#FF4136', 'Dike, vein or lava'], ['#3498DB', 'Glacial moraine']
];

const ma = n => `${(+n).toLocaleString('en', { maximumFractionDigits: n < 10 ? 3 : 2 })}`;
// Names of the intervals in a table that overlap an age range, oldest first: "Cambrian" or "Triassic to Jurassic".
function span(table, young, old) {
  const hit = table.filter(([, t, b]) => (b > young && t < old) || (young === old && t <= young && young <= b));
  if (!hit.length) return '';
  const a = hit[hit.length - 1][0], z = hit[0][0];
  return a === z ? a : `${a} to ${z}`;
}
const SCALES = { large: 'large scale (local, most detailed)', medium: 'medium scale (regional)', small: 'small scale (national or continental)', tiny: 'very small scale (global, coarse)' };

// The web-map zoom of the view at a latitude, used only to say when the answer is more detailed than the screen.
const zoomOf = (api, lat) => Math.max(0, Math.min(16, Math.round(Math.log2(2 * Math.PI * api.proj.scale() * Math.max(0.15, Math.cos(lat * Math.PI / 180)) / 512))));

const answers = new Map();
function unitsAt(lon, lat, z) {
  const url = `${API}?lat=${lat.toFixed(5)}&lng=${lon.toFixed(5)}&z=${z}`;
  if (!answers.has(url)) {
    answers.set(url, fetch(url, { signal: AbortSignal.timeout(10000) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then(j => Object.assign(j.success.data.mapData || [], { elevation: j.success.data.elevation })) // height in m: land or sea
      .catch(e => { answers.delete(url); throw e; }));
    if (answers.size > 30) answers.delete(answers.keys().next().value);
  }
  return answers.get(url);
}

async function query([lon, lat], api) {
  const esc = api.esc;
  // Most detailed map first, then coarser. Not tied to the view: a point opened from a link is read before the fly.
  let units, z;
  try {
    for (z of [12, 7, 3]) { units = await unitsAt(lon, lat, z); if (units.length) break; }
  } catch {
    return [['Geology', 'The Macrostrat geologic data did not load. Try again in a moment.']];
  }
  const u = units[0];
  if (!u) return [['Geology', 'No rock unit is mapped here. The map covers land only.']];
  const old = u.b_int?.b_age, young = u.t_int?.t_age;
  const names = [u.b_int?.int_name, u.t_int?.int_name].filter(Boolean);
  const named = names[0] === names[1] ? names[0] : names.join(' to ');
  const rows = [['Rock unit', esc(u.name || u.strat_name || 'Unnamed unit')]];
  const liths = (u.liths || []).map(l => l.lith);
  const lith = u.lith && u.lith.length > liths.join(', ').length ? u.lith : (liths.join(', ') || u.lith);
  if (lith) rows.push(['Rock type', esc(lith[0].toUpperCase() + lith.slice(1))]);
  if (old != null && young != null) {
    rows.push(['Age', `${esc(named)}, ${ma(old)} to ${ma(young)} million years ago`]);
    // The Archean has no periods, so a period span is only given for ranges inside the last 2,500 million years.
    const per = old <= 2500 && span(PERIODS, young, old), era = span(ERAS, young, old);
    rows.push(['Era and period', esc([era && `${era} era`, per && per !== named && `${per} period`].filter(Boolean).join(', ') || 'Not known')]);
  } else rows.push(['Age', 'Not given in the source map']);
  if (u.descrip) rows.push(['Description', esc(u.descrip.length > 420 ? u.descrip.slice(0, 400).replace(/\s+\S*$/, '') + '…' : u.descrip)]);
  const r = u.ref || {};
  const title = [r.authors, r.ref_year && `(${r.ref_year})`, r.ref_title].filter(Boolean).join(' ');
  if (title) rows.push(['Source map', `${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(title)}</a>` : esc(title)}${r.ref_source?.trim() ? `, ${esc(r.ref_source.trim())}` : ''}`]);
  if (u.scale) rows.push(['Map scale', esc(SCALES[u.scale] || u.scale)]);
  // shortcut: the zoom each scale starts at is approximate (Macrostrat does not publish exact ranges).
  if (({ tiny: 0, small: 3, medium: 6, large: 9 }[u.scale] ?? 0) > zoomOf(api, lat) + 1) rows.push(['Note', 'This is the most detailed map here. At this zoom the colours on screen may come from a coarser map.']);
  rows.push(['More', `<a href="https://macrostrat.org/map/loc/${lon.toFixed(4)}/${lat.toFixed(4)}" target="_blank" rel="noopener">Open this place in Macrostrat</a>`]);
  return rows;
}

// Land in the middle of the view with no source map at this zoom (the coarse world map stops at zoom 6, so
// Arabia goes blank): the map says so there and in the key's title. Read once the globe stops.
let gapAt = '', gapHere = false;
function gapNote(api) {
  // The tiles' level (the engine counts device pixels), which matches the API's zoom: over Oman both go empty at 6.
  const c = api.center, z = Math.min(14, zoomOf(api, c[1]) + Math.round(Math.log2(api.dpr))), at = `${c},${z}`;
  if (!api.moving && at !== gapAt) {
    gapAt = at;
    unitsAt(c[0], c[1], z).then(u => {
      const gap = !u.length && u.elevation > 0;
      if (gapAt === at && gap !== gapHere) { gapHere = gap; api.refresh(); }
    }).catch(() => {});
  }
}
// Drawn in the app's label pass, so country names keep clear of it. On the app's own land, so in its theme colours.
function gapLabel(api) {
  if (!gapHere || api.moving) return;
  const { ctx, boxes, C } = api, [x, y] = api.proj(api.center);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.letterSpacing = '0px';
  [['600 14px', 'No detailed geologic map here', -40], ['500 12.5px', 'Zoom out for the world map', -21]].forEach(([f, t, dy]) => {
    ctx.font = `${f} "Plus Jakarta Sans", system-ui, sans-serif`;
    const w = ctx.measureText(t).width / 2 + 4;
    boxes.push([x - w, y + dy - 9, x + w, y + dy + 9]);
    ctx.lineWidth = 3; ctx.strokeStyle = C.halo; ctx.strokeText(t, x, y + dy);
    ctx.fillStyle = C.text; ctx.fillText(t, x, y + dy);
  });
}

function legend() {
  // Rounded for the key; the point panel gives exact ages. Precambrian rock is keyed by era, as most maps date it.
  const r = n => n.toLocaleString('en', { maximumFractionDigits: n < 10 ? 1 : 0 });
  const li = ([n, t, b, c]) => `<li><i style="--c:${c}"></i><span>${n}<br>${r(b)}–${r(t)}</span></li>`;
  return `<p>Rock age, millions of years ago</p>
    <ul class="swatches">${PERIODS.slice(0, 12).map(li).join('')}${ERAS.filter(e => e[3]).map(li).join('')}${li(['Archean', 2500, 4031, '#FF3399'])}</ul>
    <p>Lines</p>
    <ul class="swatches">${LINES.map(([c, t]) => `<li><i style="--c:${c}"></i>${t}</li>`).join('')}</ul>`;
}

export default {
  id: 'geologic', name: 'Geologic', group: 'Earth science', dataMap: true,
  ownsColour: true,
  credit: '<a href="https://macrostrat.org">Macrostrat</a> and the <a href="https://macrostrat.org/maps">original source maps</a> it compiles (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)',
  // The tiles are the whole map, CC BY 4.0 (tiles.macrostrat.org: "required to cite Macrostrat"), so credited on it.
  onMap: '<a href="https://macrostrat.org">Macrostrat</a>, <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>',
  layers: () => [{ src: CARTO }],
  vector: 'lines', click: 'point', query, legend,
  state: () => (gapHere ? 'no detailed map here' : ''),
  overlay: { load() {}, draw: gapNote },
  placeLabels: gapLabel
};

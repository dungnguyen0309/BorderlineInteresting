// Photographic: the Earth as photographed from space, in three views chosen in the map's tools.
//   Cloud-free mosaic   NASA Blue Marble (MODIS, August 2004, 500 m) for the whole globe, handing over to
//                       Sentinel-2 cloudless 2025 by EOX (10 m) as the view zooms in, then, where a government
//                       publishes its aerial photographs openly and without a key, to those (8 cm to 2 m, AERIAL).
//   One day from space  one UTC day's true-colour image from NASA GIBS: NOAA-20 VIIRS from 2018, Terra MODIS before.
//   Earth at night      NASA Black Marble 2016 (Suomi NPP VIIRS Day/Night Band).
// Esri World Imagery, Google, Bing, Mapbox and MapTiler need an API key or account, so they are not used.
// All NASA layers use GIBS's cached Web Mercator tiles (its WMS took 650 ms a tile and failed on 10 of 20 daily-image
// requests in testing). Web Mercator stops at 85°, so Blue Marble's polar caps come from the lon/lat WMS, and only there.
import { elevationAt } from '../relief.js';
import { SCHEMES } from '../engine.js';

const R = 6371008.8; // mean Earth radius in metres: at the centre of the globe one CSS pixel covers R / scale
const D2R = Math.PI / 180;
const MERC = 85.0511; // where Web Mercator tiles stop
const GIBS_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const GIBS_WMTS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const GIBS = 'via <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>';
const NASA = `${GIBS} (no restrictions on use)`;
// Earthdata: data from NASA-led missions are CC0 unless marked otherwise, and GIBS asks for no credit on the map.
const BM_CREDIT = `NASA Blue Marble ${GIBS} (CC0)`;
// EOX's required wording (cloudless.eox.at/documentation/license), with the licence of the 2018 and later mosaics.
// EOX asks for it in the map interface wherever the mosaic shows: S2_ON_MAP, worded as on the Physical map.
const BY_NC_SA = '<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA 4.0</a>';
const S2_CREDIT = `EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), ${BY_NC_SA}`;
const S2_ON_MAP = '<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)';
// The outlines the photographs are cut to (coverage.json) come from these; ODbL asks for the credit on the map
// (osmfoundation.org/wiki/Licence/Attribution_Guidelines), so it shows while photographs do.
const OSM = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BORDERS = `<a href="https://www.naturalearthdata.com/">Natural Earth</a> and ${OSM} (ODbL)`;

const VIEWS = [['mosaic', 'Cloud-free mosaic'], ['day', 'One day from space'], ['night', 'Earth at night']];
let view = 'mosaic';

// A tile that fails is asked for once more after a second, then counted against its source (failures within a minute),
// so the legend can say so.
let shared = null, P = null, pending = 0, shownKey = '';
// Not a debounce: tiles arriving redraw the globe many times a second, which would keep pushing it back.
const later = () => { pending ||= setTimeout(sync, 200); };
const image = (url, tries) => new Promise((ok, fail) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => ok(img);
  img.onerror = fail;
  img.src = url;
}).catch(e => (tries ? new Promise(r => setTimeout(r, 1000)).then(() => image(url, tries - 1)) : Promise.reject(e)));
// A tiny canvas, one pixel wide, with one colour per row (stretched over a whole tile).
const pixels = (...fills) => { const c = document.createElement('canvas'); c.width = 1; c.height = fills.length || 1; const g = c.getContext('2d'); fills.forEach((f, i) => { g.fillStyle = f; g.fillRect(0, i, 1, 1); }); return c; };
const BLANK = pixels();
// `get` fetches one tile (an aerial source brings its own, which treats "nothing here" as a blank tile, not a failure).
// `waits`: an aerial source's requests in flight, so the key can say when one is slow (a frame is drawn at 4 s to check).
const SLOW = 4000;
// `streak`: an aerial source's failures since its last tile arrived, so a few bad tiles (IGN answers 400 now and then)
// do not take the whole service off the map.
const counted = src => Object.assign(src, {
  fails: 0, failedAt: 0, streak: 0, waits: new Set(),
  // An empty url is a tile the source leaves blank (the polar caps' WMS outside the caps, an aerial service abroad).
  load: (url, t) => (!url ? Promise.resolve(BLANK) : !src.get ? image(url, 1) : (() => {
    const job = { at: Date.now() };
    src.waits.add(job);
    setTimeout(() => src.waits.has(job) && shared?.draw(), SLOW + 100);
    return src.get(url, t).then(v => { src.streak = 0; return v; }).finally(() => src.waits.delete(job));
  })()).catch(e => {
    const now = Date.now(), fresh = now - src.failedAt < 6e4;
    src.fails = fresh ? src.fails + 1 : 1;
    src.streak = fresh ? src.streak + 1 : 1;
    src.failedAt = now;
    if (src.fails === 1) later();
    if (strikes(src) === 3) { later(); setTimeout(later, 6e4 + 500); } // and again once the minute is over
    throw e;
  })
});
// The engine never asks for a failed tile again: after 3 failures in a minute (for an aerial source, 3 in a row) a
// source is rebuilt under a new id once that minute is over. Meanwhile it is left out: Sentinel-2 for Blue Marble (EOX
// slows traffic spikes on its free service), an aerial service for Sentinel-2.
const strikes = s => (s.get ? s.streak : s.fails);
const down = s => strikes(s) >= 3 && Date.now() - s.failedAt < 6e4;
const pool = new Map();
function source(key, make) {
  let s = pool.get(key);
  if (!s || (strikes(s) >= 3 && !down(s))) {
    const gen = s ? s.gen + 1 : 0;
    pool.set(key, s = counted({ ...make(), id: gen ? `${key}~${gen}` : key, gen }));
  }
  return s;
}
const S2 = () => source('eox-s2-2025', () => ({ maxZoom: 14, url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg' })); // EOX serves Web Mercator levels 0-14
// minZoom 2: the engine picks level 0 for a view centred near a pole, a single 256 px tile for the world.
const BM = () => source('gibs-bmng', () => ({ maxZoom: 8, minZoom: 2, url: `${GIBS_WMTS}/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg` }));
// Lon/lat WMS tiles for the caps beyond 85°; in WMS 1.3.0, EPSG:4326 boxes are south, west, north, east.
const CAP = () => source('gibs-bmng-cap', () => ({
  scheme: 'geo', maxZoom: 7,
  url: (z, x, y) => {
    const w = 180 / 2 ** z, west = -180 + x * w, north = 90 - y * w;
    return north <= MERC && north - w >= -MERC ? '' : `${GIBS_WMS}?service=WMS&version=1.3.0&request=GetMap&styles=&crs=EPSG:4326&width=256&height=256` +
      `&layers=BlueMarble_NextGeneration&format=image/jpeg&bbox=${north - w},${west},${north},${west + w}`;
  }
}));
const NIGHT = () => source('gibs-blackmarble-2016', () => ({ maxZoom: 8, url: `${GIBS_WMTS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png` }));
// Under Black Marble, so the caps beyond 85° are not a pale disc of the sea colour: its black sea in the north, and
// the flat blue it gives Antarctica (#2b3355) in the south. Two rows over the whole height of a level-0 tile.
const NIGHT_CAPS = pixels('#000', '#2b3355');
const NIGHT_CAP = { id: 'photo-night-caps', scheme: 'geo', maxZoom: 0, url: () => '', load: () => Promise.resolve(NIGHT_CAPS) };

// One day: NOAA-20 from its first day, Terra before it. `domain` is NASA's list of days with an image ([from, to] pairs).
const N20 = {
  id: 'n20', layer: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', start: '2018-01-05', res: 375, time: '13:30',
  name: 'NOAA-20 (VIIRS)', credit: 'NOAA-20 VIIRS Corrected Reflectance'
};
const TERRA = {
  id: 'terra', layer: 'MODIS_Terra_CorrectedReflectance_TrueColor', start: '2000-02-24', res: 250, time: '10:30',
  name: 'Terra (MODIS)', credit: 'Terra MODIS Corrected Reflectance'
};
const satOf = d => (d >= N20.start ? N20 : TERRA);
const iso = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (d, n) => iso(Date.parse(d) + n * 864e5);
const long = d => new Date(`${d}T12:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// GIBS gets imagery about 3 to 5 hours after each pass, so a UTC day counts as complete 6 hours after it ends.
const latest = () => { const d = iso(Date.now() - 30 * 36e5), end = N20.domain?.at(-1)?.[1]; return end && end < d ? end : d; };
const has = d => { const s = satOf(d); return !s.domain || s.domain.some(([a, b]) => a <= d && d <= b); };
const inRange = d => d >= TERRA.start && d <= latest();
// The day with an image nearest to d: only earlier or later ones when dir is -1 or 1. d itself when none is within 60 days.
function snap(d, dir) {
  if (has(d)) return d;
  for (let i = 1; i <= 60; i++) for (const s of dir ? [dir] : [-1, 1]) {
    const n = addDays(d, s * i);
    if (inRange(n) && has(n)) return n;
  }
  return d;
}
let day = null; // null: the latest complete day
const shownDay = () => day ?? snap(latest(), -1);
// The day shown before the last change, kept under the new one for 3 s so the map is not blank while it loads.
let prevDay = null, prevTimer = 0;
function pick(d, dir) {
  const was = shownDay();
  d = d < TERRA.start ? TERRA.start : d > latest() ? latest() : d;
  day = snap(d, dir);
  if (day !== was) {
    prevDay = was;
    clearTimeout(prevTimer);
    prevTimer = setTimeout(() => { prevDay = null; shared?.draw(); }, 3000);
  }
}

let daysAsked = false;
function loadDays() {
  if (daysAsked) return;
  daysAsked = true;
  const to = iso(Date.now() + 864e5);
  Promise.all([N20, TERRA].map(s => fetch(`${GIBS_WMTS}/1.0.0/${s.layer}/default/GoogleMapsCompatible_Level9/all/${s.start}--${to}.xml`, { signal: AbortSignal.timeout(10000) })
    .then(r => (r.ok ? r.text() : Promise.reject(new Error(`GIBS ${r.status}`))))
    .then(x => { s.domain = x.match(/<Domain>([^<]+)<\/Domain>/)[1].split(',').map(v => { const [a, b = a] = v.split('/'); return [a, b]; }); s.failed = false; })
    .catch(e => { console.warn(e); s.failed = true; daysAsked = false; }))) // choosing the view again retries
    .then(() => { if (day) pick(day, 0); tools(); sync(); });
}

const daySrc = d => { const s = satOf(d); return source(`gibs-${s.id}-${d}`, () => ({ maxZoom: 9, url: `${GIBS_WMTS}/${s.layer}/default/${d}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpeg` })); };

// Aerial photographs: national and state services that publish their orthophotos openly, with no key or account.
// Each is drawn over Sentinel-2 from Web Mercator level 14 (about 10 m a pixel, where Sentinel-2 runs out) up to its
// own last level, and only where its outline in data/maps/photographic/coverage.json (scripts/build_photographic.py)
// meets the tile. Later rows draw over earlier ones: services that show filler or blurred imagery past their border
// come first (their outlines follow the real border), so a neighbour's photos cover it, and Berlin's 2026 photos go
// over Brandenburg's.
//   url    {z} {x} {y}, {-y} (TMS row), {zz} (NRW's level, z - 5), {bbox} (the tile in EPSG:3857 metres), {searchid}
//   fill   colours a service paints where it has no photo (white, black, a flat sea): keyed out near the outline
//   res    metres per pixel at its finest, so the key can say when the view only enlarges it
//   onMap  true: its credit shows in the map's corner while its photos do, as its terms ask (IGN Spain's licence,
//          "a pie de mapa"; swisstopo's FSDI terms, lower right of the map; LandsD, logo on the map face; basemap.at's
//          usage examples). The other services' licences (CC BY, dl-de, Etalab, OGL, CC0) ask for credit, not where.
// Credits are worded as each licence asks. Services checked and left out (Flanders, Denmark, Norway, Sweden, Finland,
// Schleswig-Holstein, Saxony-Anhalt, Croatia, Italy beyond South Tyrol, the UK, New Zealand, Victoria and others)
// need a key, send no CORS header, answer too slowly or have no open licence.
// WMS tiles are asked for at 512 px, as JPEG on black: a quarter of the requests and a tenth of the bytes of 256 px
// PNGs (Hesse's took 5 s and 200 kB a tile), with the black keyed out like any other fill.
const WMS = (base, layers, extra = '') => `${base}${base.includes('?') ? '&' : '?'}LAYERS=${layers}${extra}&SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:3857&BBOX={bbox}&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg&BGCOLOR=0x000000`;
const big = d => !!d.url?.includes('{bbox}'); // a 512 px tile, one level up
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
const AIR = 'aerial photographs';
const STATE = '20 cm per pixel';
const NO_DATE = 'recently; the service does not give dates';
const AERIAL = [
  { id: 'es', name: 'PNOA (IGN Spain)', max: 20, res: 0.15, detail: '15 to 25 cm per pixel', dates: 'on the most recent PNOA flight over each area, so dates vary', fill: [[32, 26, 38]],
    url: 'https://www.ign.es/wmts/pnoa-ma?request=GetTile&service=WMTS&VERSION=1.0.0&Layer=OI.OrthoimageCoverage&Style=default&Format=image/jpeg&TileMatrixSet=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}',
    credit: 'PNOA cedido por © Instituto Geográfico Nacional de España, CC BY 4.0 scne.es', onMap: true },
  { id: 'ch', name: 'SWISSIMAGE (swisstopo)', max: 20, res: 0.1, detail: '10 cm per pixel', dates: 'on the flights in the current mosaic; years vary by area',
    url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg', credit: '© Data: swisstopo', onMap: true },
  { id: 'tw', name: 'Taiwan orthophoto (NLSC)', max: 19, res: 0.25, detail: 'about 25 cm per pixel', dates: 'for the latest yearly mosaic', fill: [[24, 60, 76]],
    url: 'https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', credit: '內政部國土測繪中心 (NLSC, Taiwan) 正射影像' },
  // LandsD asks for its logo on the map face as well as the notice: both go in the map's corner.
  { id: 'hk', name: 'Hong Kong aerial photographs (Lands Department)', max: 19, res: 0.2, detail: 'about 20 cm per pixel', dates: NO_DATE, fill: [WHITE],
    url: 'https://mapapi.hkmapservice.gov.hk/gs/api/v1.0.0/xyz/imagery/WGS84/{z}/{x}/{y}.png',
    credit: '<img src="https://api.hkmapservice.gov.hk/mapapi/landsdlogo.jpg" alt="Lands Department logo" width="15" height="15" style="vertical-align:-3px"> Aerial Photograph from Lands Department', onMap: true },
  { id: 'qld', name: 'Queensland Imagery', kind: 'aerial photographs, with Planet satellite images where none were flown', max: 19, detail: '2 cm to 2.4 m per pixel, by project',
    dates: 'at least three years ago (up to about 2023); the satellite fill in 2017',
    url: 'https://spatial-img.information.qld.gov.au/arcgis/rest/services/Basemaps/LatestStateProgram_AllUsers/ImageServer/tile/{z}/{y}/{x}',
    credit: '© State of Queensland (Department of Natural Resources and Mines, Manufacturing and Regional and Rural Development), CC BY 4.0; © Planet Labs (2017 mosaic)' },
  { id: 'uy', name: 'Uruguay orthophotos (IDE)', max: 19, res: 0.32, detail: '32 cm per pixel, finer in towns', dates: 'in 2017 and 2018', fill: [[106, 107, 92]],
    url: 'https://mapas.ide.uy/geoserver-raster/gwc/service/wmts/rest/ortofotos:ORTOFOTOS_2019/raster/EPSG:3857/EPSG:3857:{z}/{y}/{x}?format=image/jpeg',
    credit: 'IDE Uruguay (Infraestructura de Datos Espaciales), Ortofotos 2017-2018' },
  { id: 'fr', name: 'IGN BD ORTHO', where: 'France', max: 19, res: 0.2, detail: '20 cm per pixel (50 cm in older areas)', dates: 'on the latest flight over each département, so dates vary by area', fill: [WHITE],
    url: 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image/jpeg',
    credit: '<a href="https://geoservices.ign.fr/cgu-licences">© IGN – BD ORTHO (Géoplateforme), Licence Ouverte Etalab 2.0</a>' },
  { id: 'nl', name: 'Luchtfoto (Beeldmateriaal Nederland, PDOK)', max: 21, res: 0.08, detail: '8 cm per pixel', dates: 'in winter 2025', fill: [WHITE],
    url: 'https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/Actueel_orthoHR/EPSG:3857/{z}/{x}/{y}.jpeg', credit: 'Beeldmateriaal.nl / PDOK, CC BY 4.0' },
  { id: 'lu', name: 'Luxembourg orthophoto (ACT)', max: 21, res: 0.1, detail: 'about 10 to 20 cm per pixel', dates: 'in summer 2025', fill: [WHITE],
    url: 'https://wmts1.geoportail.lu/opendata/wmts/ortho_latest/GLOBAL_WEBMERCATOR_4_V3/{z}/{x}/{y}.jpeg',
    credit: '© Administration du cadastre et de la topographie (ACT), Luxembourg, CC0' },
  { id: 'at', name: 'basemap.at Orthofoto', max: 19, res: 0.15, detail: '29 cm per pixel (15 cm in some regions)', dates: 'on each state\'s latest flight campaign, so dates vary by area', fill: [WHITE],
    url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg', credit: 'Datenquelle: <a href="https://basemap.at">basemap.at</a>', onMap: true },
  { id: 'pl', name: 'Ortofotomapa (GUGiK)', max: 19, res: 0.25, detail: 'about 25 cm per pixel', dates: 'on the latest flight over each area, so dates vary', fill: [[0, 0, 0]],
    url: 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WMTS/StandardResolution?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTOFOTOMAPA&STYLE=default&FORMAT=image/jpeg&tileMatrixSet=EPSG:3857&tileMatrix=EPSG:3857:{z}&tileRow={y}&tileCol={x}',
    credit: 'Główny Urząd Geodezji i Kartografii (geoportal.gov.pl)' },
  { id: 'ee', name: 'Estonian orthophoto (Maa- ja Ruumiamet)', max: 18, res: 0.25, detail: '25 to 30 cm per pixel', dates: 'on recent national flights; dates vary by area', fill: [[34, 56, 70]],
    url: 'https://tiles.maaamet.ee/tm/tms/1.0.0/foto@GMC/{z}/{x}/{-y}.png', credit: 'Orthophoto, Republic of Estonia Land and Spatial Development Board' },
  { id: 'pt', name: 'OrtoSat 2023 (DGT)', kind: 'satellite images', max: 19, res: 0.3, detail: '30 cm per pixel', dates: 'between May and October 2023',
    url: WMS('https://ortos.dgterritorio.gov.pt/wms/ortosat2023', 'ortoSat2023-CorVerdadeira'),
    credit: 'OrtoSat 2023 © Direção-Geral do Território (DGT), CC BY 4.0' },
  { id: 'wal', name: 'Wallonia orthophotos (SPW)', max: 19, res: 0.25, detail: '25 cm per pixel', dates: 'in 2026',
    url: WMS('https://geoservices.wallonie.be/arcgis/services/IMAGERIE/ORTHO_LAST/MapServer/WMSServer', '0'),
    credit: '© SPW – Service public de Wallonie, orthophotos 2026' },
  { id: 'bru', name: 'Brussels UrbIS Ortho', max: 21, detail: 'very fine (the service does not give the pixel size)', dates: 'in 2024',
    url: WMS('https://geoservices-grid.irisnet.be/geoserver/urbisgrid/ows', 'Ortho'),
    credit: 'Realized by means of Brussels UrbIS® – Distribution & Copyright CIRB/paradigm.brussels (CC0)' },
  { id: 'nrw', name: 'DOP North Rhine-Westphalia (Geobasis NRW)', max: 21, res: 0.1, detail: '10 cm per pixel', dates: 'in 2024 or 2025 (half the state is flown each year)',
    url: 'https://www.wmts.nrw.de/geobasis/wmts_nw_dop/tiles/nw_dop/EPSG_3857_16/{zz}/{x}/{y}', credit: '© GeoBasis-DE / NRW, dl-de/zero-2-0' },
  { id: 'by', name: 'DOP20 Bavaria', max: 19, res: 0.2, detail: STATE, dates: 'in the last two years (half of Bavaria is flown each year)',
    url: WMS('https://geoservices.bayern.de/od/wms/dop/v1/dop20', 'by_dop20c'), credit: '© Bayerische Vermessungsverwaltung (geodaten.bayern.de), CC BY 4.0' },
  { id: 'bb', name: 'DOP20 Brandenburg and Berlin (LGB)', max: 19, res: 0.2, detail: STATE, dates: 'between about 2020 and 2023',
    url: WMS('https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms', 'bebb_dop20c'), credit: '© GeoBasis-DE/LGB, dl-de/by-2-0' },
  { id: 'be', name: 'TrueDOP 2026 Berlin', max: 20, res: 0.2, detail: STATE, dates: 'in 2026',
    url: WMS('https://gdi.berlin.de/services/wms/truedop_2026', 'truedop_2026'), credit: 'Geoportal Berlin / Digitale farbige TrueOrthophotos 2026, dl-de/zero-2-0' },
  { id: 'sn', name: 'DOP Saxony (GeoSN)', max: 19, res: 0.2, detail: STATE, dates: 'between about 2022 and 2023',
    url: WMS('https://geodienste.sachsen.de/wms_geosn_dop-rgb/guest', 'sn_dop_020'), credit: 'Quelle: GeoSN, dl-de/by-2-0' },
  { id: 'th', name: 'DOP Thuringia (GDI-Th)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE, fill: [WHITE], // white past the state, black past the service
    url: WMS('https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP', 'th_dop'), credit: '© GDI-Th, CC BY 4.0' },
  { id: 'he', name: 'DOP Hesse (HVBG)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE,
    url: WMS('https://www.gds-srv.hessen.de/cgi-bin/lika-services/ogc-free-images.ows', 'he_dop_rgb'), credit: '© Hessische Verwaltung für Bodenmanagement und Geoinformation (HVBG)' },
  { id: 'ni', name: 'DOP20 Lower Saxony (LGLN)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE,
    url: WMS('https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms', 'ni_dop20'), credit: 'LGLN (2026), CC BY 4.0' },
  { id: 'mv', name: 'DOP Mecklenburg-Western Pomerania (LAiV)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE,
    url: WMS('https://www.geodaten-mv.de/dienste/adv_dop', 'mv_dop'), credit: '© GeoBasis-DE/M-V 2026, CC BY 4.0' },
  { id: 'rp', name: 'DOP20 Rhineland-Palatinate (LVermGeo)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE,
    url: WMS('https://geo4.service24.rlp.de/wms/rp_dop20.fcgi', 'rp_dop20'), credit: '© GeoBasis-DE / LVermGeoRP 2026, dl-de/by-2-0' },
  { id: 'bw', name: 'DOP20 Baden-Württemberg (LGL)', max: 19, res: 0.2, detail: STATE, dates: NO_DATE,
    url: WMS('https://owsproxy.lgl-bw.de/owsproxy/ows/WMS_LGL-BW_ATKIS_DOP_20_C', 'IMAGES_DOP_20_RGB'), credit: '© LGL-BW (2026), dl-de/by-2-0' },
  { id: 'sl', name: 'DOP20 Saarland (LVGL)', max: 19, res: 0.2, detail: STATE, dates: 'on 11 May 2025',
    url: WMS('https://geoportal.saarland.de/freewms/truedop', 'sl_dop20_rgb'), credit: '© GeoBasis DE/LVGL-SL (2025), dl-de/by-2-0' },
  // TIME pinned to an LGV flight: the capabilities name Maxar, under a closed licence, for part of the series.
  { id: 'hh', name: 'DOP Hamburg (LGV)', max: 20, res: 0.2, detail: STATE, dates: 'in 2026, with the trees bare',
    url: WMS('https://geodienste.hamburg.de/wms_dop_zeitreihe_unbelaubt', 'dop_zeitreihe_unbelaubt', '&TIME=2026'),
    credit: 'Freie und Hansestadt Hamburg, Landesbetrieb Geoinformation und Vermessung (LGV), dl-de/by-2-0' },
  { id: 'cz', name: 'Ortofoto ČR (ČÚZK)', max: 20, res: 0.125, detail: '12.5 to 25 cm per pixel', dates: 'within the last three years (a third of the country is flown each year)',
    url: 'https://ags.cuzk.gov.cz/arcgis1/rest/services/ORTOFOTO_WM/MapServer/tile/{z}/{y}/{x}', credit: '© ČÚZK, CC BY 4.0' },
  { id: 'sk', name: 'ZBGIS orthophoto mosaic (ÚGKK SR)', max: 19, res: 0.2, detail: '20 to 25 cm per pixel', dates: 'between 2020 and 2025 (the west in 2023, the centre in 2024)',
    url: WMS('https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get', '1'), credit: '© ÚGKK SR (ZBGIS Ortofotomozaika), CC BY 4.0' },
  { id: 'si', name: 'DOF025 (GURS)', max: 19, res: 0.25, detail: '25 cm per pixel', dates: 'in the latest national cycle; the service does not give dates',
    url: WMS('https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms', 'SI.GURS.ZPDZ:DOF025'), credit: '© Geodetska uprava Republike Slovenije, DOF025, CC BY 4.0' },
  { id: 'bz', name: 'South Tyrol orthophoto 2023', max: 20, res: 0.2, detail: STATE, dates: 'in September 2023',
    url: WMS('https://geoservices.buergernetz.bz.it/mapproxy/p_bz-Orthoimagery/wms', 'Aerial-2023-RGB'), credit: '© Autonome Provinz Bozen – Provincia autonoma di Bolzano, CC BY 4.0' },
  // The United States: NAIP through Planetary Computer, whose mosaic search is registered on first use (see naipReady).
  { id: 'us' },
  { id: 'jp', name: 'GSI seamless photos', max: 18, res: 0.5, detail: 'about 50 cm per pixel (the tiles stop there)', dates: 'on the latest photo of each area, from about 2007 to now',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', credit: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル (国土地理院)</a>, GRUS画像 (© Axelspace)' },
  { id: 'nsw', name: 'NSW Imagery (Spatial Services)', max: 20, res: 0.1, detail: '50 cm per pixel, 10 cm in towns', dates: 'on the latest capture of each area; dates vary widely',
    url: 'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: '© State of New South Wales (Spatial Services, a business unit of the Department of Customer Service NSW), CC BY 4.0' },
  { id: 'act', name: 'ACT aerial imagery', max: 20, detail: 'very fine (the service does not give the pixel size)', dates: 'in December 2025, towns again in March 2026',
    url: 'https://tiles.arcgis.com/tiles/E5n4f1VY84i0xSjy/arcgis/rest/services/ACT_Aerial_Imagery_Current_3857/MapServer/tile/{z}/{y}/{x}',
    credit: '© Australian Capital Territory and MetroMap (Aerometrex), CC BY 4.0' },
  // CC BY-NC-ND: its tiles are only keyed and cut for display in the viewer's browser, never stored or passed on.
  { id: 'tas', name: 'Tasmania orthophoto (TheLIST)', max: 19, detail: 'varies by area, finest in towns', dates: 'on the latest photo of each area; dates vary',
    url: 'https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/Orthophoto/MapServer/tile/{z}/{y}/{x}', credit: '© State of Tasmania, CC BY-NC-ND 3.0 AU' },
  { id: 'on', name: 'Ontario Imagery (LIO)', max: 19, detail: 'varies by area, finest in cities', dates: 'in many years up to 2025, by area',
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_Imagery/Ontario_Imagery_Web_Map_Service/MapServer/tile/{z}/{y}/{x}',
    credit: 'Contains information licensed under the Open Government Licence - Ontario (© King\'s Printer for Ontario)' }
];
const NAIP = { id: 'naip', cov: 'us', name: 'NAIP (USDA)', max: 18, res: 0.3, detail: '60 cm per pixel (30 cm in some states)',
  dates: 'on the newest NAIP flight over each state since 2018 (states are flown every 2 to 3 years)',
  url: 'https://planetarycomputer.microsoft.com/api/data/v1/mosaic/{searchid}/tiles/WebMercatorQuad/{z}/{x}/{y}?collection=naip&assets=image&asset_bidx=image%7C1,2,3',
  credit: 'USDA NAIP imagery via <a href="https://planetarycomputer.microsoft.com">Microsoft Planetary Computer</a>' };
// Only while NAIP is not loading: a cached copy of the same photographs, coarser and stopping at level 16.
const USGS = { id: 'usgs', cov: 'us', name: 'USGS National Map imagery', kind: 'aerial photographs (a cached copy of NAIP)', max: 16, res: 2, detail: 'about 2 m per pixel',
  dates: 'in mixed years (the cache was refreshed in June 2024)',
  url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', credit: 'USDA, USGS The National Map: Orthoimagery' };
const AIR_FROM = 14; // the first level with photographs (Sentinel-2 stops at 14)
const ROOM = 0.04; // degrees: a tile this close to an outline is checked (outlines run up to 2 km past land)
const lift = d => (big(d) ? 1 : 0); // a 512 px tile's level is one below the 256 px level of the same detail

// NAIP's mosaic search, registered with Planetary Computer on first use; its id expires (pc1.<unix time>.<hash>).
const PC = 'https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register';
const NAIP_SEARCH = JSON.stringify({ collections: ['naip'], 'filter-lang': 'cql2-json', sortby: [{ field: 'datetime', direction: 'desc' }],
  filter: { op: 'anyinteracts', args: [{ property: 'datetime' }, { interval: ['2018-01-01T00:00:00Z', '2026-12-31T00:00:00Z'] }] } }); // newest first, nothing before 2018
const naip = { id: '', exp: 0, asking: false, failedAt: 0 };
function naipReady() {
  if (naip.id && naip.exp - Date.now() / 1000 > 600) return true;
  if (!naip.asking && Date.now() - naip.failedAt > 6e4) {
    naip.asking = true;
    fetch(PC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: NAIP_SEARCH, signal: AbortSignal.timeout(15000) })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`Planetary Computer ${r.status}`))))
      .then(j => { naip.id = j.searchid || j.id; naip.exp = +naip.id.split('.')[1] || Date.now() / 1000 + 3600; })
      .catch(e => { console.warn(e); naip.failedAt = Date.now(); })
      .finally(() => { naip.asking = false; later(); shared?.draw(); });
  }
  return false;
}

// Outlines: { key: { bbox: [w, s, e, n], rings: [[lon, lat, lon, lat, …]] } }, each ring given its own box on load.
let COV = null, covAsked = false;
function loadCoverage() {
  if (covAsked) return;
  covAsked = true;
  fetch(new URL('../../data/maps/photographic/coverage.json', import.meta.url))
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`coverage ${r.status}`))))
    .then(j => {
      for (const c of Object.values(j)) for (const g of c.rings) {
        g.box = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < g.length; i += 2) { g.box[0] = Math.min(g.box[0], g[i]); g.box[1] = Math.min(g.box[1], g[i + 1]); g.box[2] = Math.max(g.box[2], g[i]); g.box[3] = Math.max(g.box[3], g[i + 1]); }
      }
      COV = j; later(); shared?.draw();
    })
    .catch(e => { console.warn(e); covAsked = false; }); // choosing the map again retries
}
const meets = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
// Even-odd over all rings, so holes (Bremen inside Lower Saxony) are outside. A ring whose box misses the point
// adds an even number of crossings, so it is skipped.
function inside(c, x, y) {
  let inn = false;
  for (const g of c.rings) {
    if (x < g.box[0] || x > g.box[2] || y < g.box[1] || y > g.box[3]) continue;
    for (let i = 0, j = g.length - 2; i < g.length; j = i, i += 2) {
      if ((g[i + 1] > y) !== (g[j + 1] > y) && x < (g[j] - g[i]) * (y - g[i + 1]) / (g[j + 1] - g[i + 1]) + g[i]) inn = !inn;
    }
  }
  return inn;
}
// Does any edge of the outline pass through box b? (Liang-Barsky, after a quick test of the edge's own box.)
function crosses(c, [w, s, e, n]) {
  for (const g of c.rings) {
    if (g.box[0] > e || g.box[2] < w || g.box[1] > n || g.box[3] < s) continue;
    for (let i = 0, j = g.length - 2; i < g.length; j = i, i += 2) {
      const x0 = g[j], y0 = g[j + 1], x1 = g[i], y1 = g[i + 1];
      if ((x0 < w && x1 < w) || (x0 > e && x1 > e) || (y0 < s && y1 < s) || (y0 > n && y1 > n)) continue;
      let t0 = 0, t1 = 1, ok = true;
      for (const [p, q] of [[x0 - x1, x0 - w], [x1 - x0, e - x0], [y0 - y1, y0 - s], [y1 - y0, n - y0]]) {
        if (p === 0) { if (q < 0) { ok = false; break; } continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) { ok = false; break; } t0 = Math.max(t0, t); } else { if (t < t0) { ok = false; break; } t1 = Math.min(t1, t); }
      }
      if (ok) return true;
    }
  }
  return false;
}
const touches = (c, b) => meets(c.bbox, b) && (crosses(c, b) || inside(c, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2));
const tileBox = (z, x, y) => { const [w, e, n, s] = SCHEMES.xyz.bounds(z, x, y); return [w, s, e, n]; };
const mercY = lat => { const s = Math.sin(lat * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };

const M3857 = 20037508.342789244;
function tileUrl(d, z, x, y) {
  if (z + lift(d) < AIR_FROM || !COV || !touches(COV[d.cov || d.id], tileBox(z, x, y))) return '';
  const n = 2 ** z, w = 2 * M3857 / n;
  return d.url.replace('{bbox}', [-M3857 + x * w, M3857 - (y + 1) * w, -M3857 + (x + 1) * w, M3857 - y * w].join())
    .replace('{zz}', String(z - 5).padStart(2, '0')).replace('{-y}', n - 1 - y)
    .replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{searchid}', naip.id);
}
// One tile, or null where the service has nothing: 404 or 204 outside its area, or a body that is not an image
// (Poland answers outside with an XML error). Other answers count as failures. Premultiplied, as the engine blends.
const grab = (url, tries = 1) => fetch(url, { signal: AbortSignal.timeout(20000) })
  .then(r => (r.status === 404 || r.status === 204 ? null : r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then(b => (b?.size ? createImageBitmap(b, { premultiplyAlpha: 'premultiply' }).catch(() => null) : null))
  .catch(e => (tries ? new Promise(r => setTimeout(r, 1000)).then(() => grab(url, tries - 1)) : Promise.reject(e)));
// Near its outline a service's tile is checked. One flat colour all over (nothing photographed): dropped. A colour it
// paints where it has no photo: keyed out with its JPEG fringe, so Sentinel-2 shows there, not white, black or a flat
// sea. Those colours are the row's `fill`, black for WMS tiles, and any one exact colour that runs flat over part of
// the tile with hardly any near shades (software paints one value; JPEG keeps it exact, while smooth photographed water
// spreads over many). Overexposed snow is near white but never pure white, so glaciers stay. Then the tile is cut to
// the outline with a soft edge, so photos of a neighbour end along it rather than in tile-shaped steps. Tiles well
// inside the outline are used as they come. All of this happens in the viewer's browser, for display only.
const TOL = 8, SOFT = 3; // SOFT: the cut's blur, in tile pixels
const snow = (r, gr, bl) => Math.min(r, gr, bl) >= 255 - TOL && r + gr + bl < 765;
function finish(img, t, d) {
  if (!img) return BLANK;
  const c = COV[d.cov || d.id], b = tileBox(t.z, t.x, t.y);
  if (!crosses(c, [b[0] - ROOM, b[1] - ROOM, b[2] + ROOM, b[3] + ROOM]) && inside(c, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2)) return img;
  const S = t.src.tileSize || 256, n = S * S;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, S, S);
  img.close?.();
  const im = g.getImageData(0, 0, S, S), p = im.data, u = new Uint32Array(p.buffer), o0 = (8 * S + 8) * 4;
  let flat = true;
  for (let y = 8; y < S && flat; y += 16) for (let x = 8; x < S && flat; x += 16) {
    const o = (y * S + x) * 4;
    flat = Math.abs(p[o] - p[o0]) <= 3 && Math.abs(p[o + 1] - p[o0 + 1]) <= 3 && Math.abs(p[o + 2] - p[o0 + 2]) <= 3 && p[o + 3] === p[o0 + 3];
  }
  if (flat && !snow(p[o0], p[o0 + 1], p[o0 + 2])) return BLANK;
  const runs = new Map(); // opaque pixels equal to the ones right of and below them, by colour
  for (let i = 0; i < n - S - 1; i++) { const v = u[i]; if (v >>> 24 === 255 && v === u[i + 1] && v === u[i + S]) runs.set(v, (runs.get(v) || 0) + 1); }
  // [r, g, b, the share of the tile its flat runs must cover]. A photographed white roof can run flat too, so a given
  // colour counts from 2% of the tile, black (which photographs hardly reach) from 0.05%, and a colour found running
  // flat from 0.5% (pure white or black from 0.1%: Thuringia's small white blocks), if at least 60% of its flat runs
  // within 2 of it are that one value.
  const rgb = v => [v & 255, v >> 8 & 255, v >> 16 & 255];
  const fills = [...(d.fill || []), ...(big(d) ? [BLACK] : [])].map(([r, gr, bl]) => [r, gr, bl, Math.max(r, gr, bl) <= TOL ? 1 / 2000 : 1 / 50]);
  for (const [v, k] of runs) {
    const [r, gr, bl] = rgb(v), share = v === 0xffffffff || v === 0xff000000 ? 1 / 1000 : 1 / 200;
    if (k <= n * share || snow(r, gr, bl)) continue;
    let shades = 0;
    for (const [w, j] of runs) { const [a, b2, c2] = rgb(w); if (Math.abs(a - r) <= 2 && Math.abs(b2 - gr) <= 2 && Math.abs(c2 - bl) <= 2) shades += j; }
    if (k >= 0.6 * shades) fills.push([r, gr, bl, share]);
  }
  // A fill is keyed from its flat runs (within 2 of it) outwards, through pixels of about its colour, so lone pixels of
  // that colour in the photograph stay. Its JPEG fringe, roughly that colour, goes with it (two pixels), so no pale or
  // dark line is left along the edge.
  const key = new Uint8Array(n);
  let keyed = false;
  for (const [r, gr, bl, share] of fills) {
    const near = (i, tol) => p[i * 4 + 3] && Math.abs(p[i * 4] - r) <= tol && Math.abs(p[i * 4 + 1] - gr) <= tol && Math.abs(p[i * 4 + 2] - bl) <= tol;
    const run = i => u[i] === u[i + 1] && u[i] === u[i + S] && near(i, 2);
    let seeds = 0;
    for (let i = 0; i < n - S - 1; i++) if (run(i)) seeds++;
    if (seeds <= n * share) continue;
    keyed = true;
    const stack = [];
    for (let i = 0; i < n - S - 1; i++) if (!key[i] && run(i)) { key[i] = 1; stack.push(i); }
    const visit = j => { if (!key[j] && near(j, TOL)) { key[j] = 1; stack.push(j); } };
    while (stack.length) {
      const i = stack.pop(), x = i % S;
      if (x > 0) visit(i - 1);
      if (x < S - 1) visit(i + 1);
      if (i >= S) visit(i - S);
      if (i < n - S) visit(i + S);
    }
    for (let pass = 0; pass < 2; pass++) {
      const add = [];
      for (let i = S; i < n - S; i++) if (!key[i] && (key[i - 1] || key[i + 1] || key[i - S] || key[i + S]) && near(i, 48)) add.push(i);
      for (const i of add) key[i] = 1;
    }
  }
  if (keyed) {
    // A near-white or near-black collar along a fill (Brussels draws a white one round its region) goes too, up to 16
    // pixels, then one more pixel all round for the blend into the photograph.
    const edges = () => { const e = []; for (let i = 0; i < n; i++) if (key[i] && ((i % S && !key[i - 1]) || (i % S < S - 1 && !key[i + 1]) || (i >= S && !key[i - S]) || (i < n - S && !key[i + S]))) e.push(i); return e; };
    const grow = (front, test, layers) => {
      for (let l = 0; l < layers && front.length; l++) {
        const next = [];
        for (const i of front) {
          const x = i % S;
          for (const j of [x > 0 ? i - 1 : -1, x < S - 1 ? i + 1 : -1, i - S, i + S]) if (j >= 0 && j < n && !key[j] && test(j)) { key[j] = 1; next.push(j); }
        }
        front = next;
      }
    };
    const collar = j => { const o = j * 4, lo = Math.min(p[o], p[o + 1], p[o + 2]), hi = Math.max(p[o], p[o + 1], p[o + 2]); return lo >= 235 || hi <= 20; };
    grow(edges(), collar, 16);
    grow(edges(), () => true, 1);
    for (let i = 0; i < n; i++) if (key[i]) u[i] = 0;
    g.putImageData(im, 0, 0);
  }
  if (crosses(c, b)) {
    // The outline drawn on a larger canvas, so the blur near the tile's edges matches the next tile's.
    const k = 2 ** t.z, pad = 4 * SOFT, e = (b[2] - b[0]) * pad / S, near = [b[0] - e, b[1] - e, b[2] + e, b[3] + e];
    const m = document.createElement('canvas');
    m.width = m.height = S + 2 * pad;
    const mg = m.getContext('2d');
    mg.beginPath();
    for (const ring of c.rings) {
      if (!meets(ring.box, near)) continue;
      for (let i = 0; i < ring.length; i += 2) mg[i ? 'lineTo' : 'moveTo'](pad + (ring[i] - b[0]) / (b[2] - b[0]) * S, pad + (mercY(ring[i + 1]) * k - t.y) * S);
      mg.closePath();
    }
    mg.fill('evenodd');
    g.globalCompositeOperation = 'destination-in';
    g.filter = `blur(${SOFT}px)`;
    g.drawImage(m, -pad, -pad);
  }
  return cv;
}
// A tile missing below the first level is a hole in the service's finest levels, not the edge of its area (NSW has no
// level 18 at Tweed Heads): its parent, enlarged, stands in, up to three levels up. Parents are shared by their children.
const parents = new Map();
async function deeper(d, t) {
  const S = t.src.tileSize || 256;
  for (let up = 1; up <= 3; up++) {
    const url = tileUrl(d, t.z - up, t.x >> up, t.y >> up);
    if (!url) return null;
    if (!parents.has(url)) {
      parents.set(url, grab(url).catch(() => null));
      if (parents.size > 64) parents.delete(parents.keys().next().value);
    }
    const bm = await parents.get(url);
    if (!bm) continue;
    const q = bm.width >> up, cv = document.createElement('canvas'), part = (1 << up) - 1;
    cv.width = cv.height = S;
    cv.getContext('2d').drawImage(bm, (t.x & part) * q, (t.y & part) * q, q, q, 0, 0, S, S);
    return cv;
  }
  return null;
}
// Where a service has nothing ('none': empty, or flat) or only an enlarged parent ('up'), by tile, so the key and the
// point panel do not claim its detail there.
async function photoTile(d, url, t) {
  let img = await grab(url), gap = '';
  if (!img && t.z + lift(d) > AIR_FROM) { img = await deeper(d, t); gap = 'up'; }
  img = finish(img, t, d);
  const gaps = (d.gaps ||= new Map()), k = `${t.z}/${t.x}/${t.y}`;
  if (gaps.size > 4000) gaps.clear();
  if (img === BLANK) gaps.set(k, 'none'); else if (gap) gaps.set(k, gap); else gaps.delete(k);
  return img;
}
function gapAt(d, lon, lat, zf) {
  if (!d.gaps?.size) return '';
  const z = Math.max(AIR_FROM, Math.min(d.max, Math.round(zf))) - lift(d), n = 2 ** z;
  return d.gaps.get(`${z}/${Math.floor((lon + 180) / 360 * n)}/${Math.floor(mercY(lat) * n)}`) || '';
}
const photoSrc = d => source(d.id === 'naip' ? `air-naip-${naip.id}` : `air-${d.id}`, () => ({
  maxZoom: d.max - lift(d), tileSize: big(d) ? 512 : 256, url: (z, x, y) => tileUrl(d, z, x, y), get: (url, t) => photoTile(d, url, t)
}));
// The service drawn for a row: the US row is NAIP once its search is registered, USGS while NAIP fails, else nothing yet.
function live(d) {
  if (d.id !== 'us') return d;
  if (naipReady() && !down(photoSrc(NAIP))) return NAIP;
  return naip.asking && !naip.failedAt ? null : USGS;
}

// What the view shows at this zoom. m: metres per device pixel at the centre of the view; s2: Sentinel-2's opacity
// (it fades in from 1000 m to 500 m a pixel, where Blue Marble runs out of detail); polar: the view reaches past 85°,
// where only Blue Marble has tiles; enlarged: zoomed in past the detail. air: the photographs' opacity (they fade in
// over level 14); seen: the services whose outline meets the view, bottom first; here: the one at the centre (named
// once the photographs are at least half opaque); gone: services left out after failing; slow: services with a
// request out for over 4 s.
function look(k) {
  let m = R / (400 * k * Math.min(devicePixelRatio || 1, 2)), polar = true; // device pixels as the app counts them
  let air = 0, seen = [], gone = [], here = null, zf = 0, lon = 0, lat = 0;
  if (P) {
    const s = P.scale(), [tx, ty] = P.translate();
    m = R / (s * Math.min(devicePixelRatio || 1, 2));
    const corner = Math.max(Math.hypot(tx, ty), Math.hypot(innerWidth - tx, ty), Math.hypot(tx, innerHeight - ty), Math.hypot(innerWidth - tx, innerHeight - ty));
    const reach = corner >= s ? 90 : Math.asin(corner / s) / D2R;
    polar = Math.abs(P.rotate()[1]) + reach > MERC;
    // The level the engine picks for a Web Mercator layer here, unrounded: photographs from halfway to level 14.
    lon = (((-P.rotate()[0] + 180) % 360) + 360) % 360 - 180; lat = -P.rotate()[1]; // d3 lets the rotation run past ±180
    zf = Math.log2(2 * Math.PI * R * Math.max(0.15, Math.cos(lat * D2R)) / (256 * m));
    air = view === 'mosaic' && COV && !polar ? Math.max(0, Math.min(1, zf - AIR_FROM + 0.5)) : 0;
    if (air > 0) {
      const dl = reach / Math.max(0.01, Math.cos(lat * D2R)), b = [lon - dl, lat - reach, lon + dl, lat + reach];
      for (const d of AERIAL) {
        const c = COV[d.cov || d.id], v = c && touches(c, b) && live(d);
        if (!v) continue;
        if (down(photoSrc(v))) { gone.push(v); continue; }
        seen.push(v);
        if (inside(c, lon, lat) && gapAt(v, lon, lat, zf) !== 'none') here = v;
      }
    }
  }
  const now = Date.now(), slow = seen.filter(d => [...photoSrc(d).waits].some(w => now - w.at > SLOW));
  let s2 = 0, band = view, res = view === 'day' ? satOf(shownDay()).res : 500;
  if (view === 'mosaic') {
    s2 = down(S2()) ? 0 : Math.max(0, Math.min(1, Math.log(1000 / m) / Math.LN2));
    band = s2 <= 0 ? 'bm' : s2 < 1 ? 'mix' : here && air >= 0.5 ? 'air' : 's2';
    if (s2 >= 1) res = 10;
  }
  // Past a service's detail at this zoom and point: beyond its last level or pixel size, or where it has a hole there.
  const past = (d, x = lon, y = lat) => Math.round(zf) > d.max || m < (d.res || 0) / 2 || gapAt(d, x, y, zf) === 'up';
  const enlarged = band === 'air' ? past(here) : band !== 'mix' && m < res / 2;
  return { m, s2, band, polar, enlarged, air, seen, gone, slow, here, zf, past,
    key: `${band}|${enlarged}|${band === 's2' && polar}|${here?.id}|${seen.map(d => d.id)}|${gone.map(d => d.id)}|${slow.map(d => d.id)}` };
}

const keep = t => `<p class="note keep">${t}</p>`; // a status line on the card
const names = list => list.map(d => d.name).join('; ');
// What shows where a photograph is missing: Sentinel-2, or Blue Marble while EOX is down too.
const under = () => (down(S2()) ? 'Blue Marble' : 'Sentinel-2');
// Aerial services left out after failing, or slow to answer.
const status = s => (s.gone.length ? keep(`${names(s.gone)} did not load, so ${under()} shows there. The next try is a minute after the last failure.`) : '') +
  (s.slow.length ? keep(`${names(s.slow)} ${s.slow.length > 1 ? 'are' : 'is'} slow to answer: ${under()} shows until the photographs arrive.`) : '');
// A GIBS source's failures: a few tiles, or the whole layer (tried again a minute after the last failure).
const gibsFails = (src, what) => (!src.fails ? '' : keep(src.fails >= 3
  ? `${what} did not load from NASA GIBS, so the map is blank or blurred. The next try is a minute after the last failure.`
  : `Some ${what} tiles did not load from NASA GIBS, so parts of the map are blank or blurred. Reload the page to try again.`));
const cap = t => t[0].toUpperCase() + t.slice(1);

function legend() {
  const s = look(1);
  shownKey = s.key;
  if (view === 'night') {
    return `<p>NASA Black Marble 2016 shows the Earth's lights at night as a composite of cloud-free nights through 2016 seen by the VIIRS Day/Night Band on the Suomi NPP satellite.</p>` +
      gibsFails(NIGHT(), 'Black Marble');
  }
  if (view === 'day') {
    const d = shownDay(), sat = satOf(d);
    return `<p>${sat.name} true-colour image of ${long(d)} (UTC day), with its clouds.</p>` +
      (N20.failed || TERRA.failed ? keep('NASA\'s list of days with images did not load, so a day without one shows blank. Choose this view again to reload the list.') : '') +
      gibsFails(daySrc(d), 'This day\'s image');
  }
  if (s.band === 'air') {
    const h = s.here, src = photoSrc(h);
    return `<p>${h.name}: ${h.kind || AIR}, ${h.detail}, taken ${h.dates}.</p>` +
      (s.enlarged ? keep('You are zoomed in past its detail here, so the image is only enlarged.') : '') +
      status(s) +
      (h === USGS ? keep('NAIP tiles did not load from Microsoft Planetary Computer, so this coarser copy is shown. NAIP is asked for again after a minute.') : '') +
      (src.fails ? keep(`Some ${h.name} tiles did not load, so ${under()} shows in their place.`) : '');
  }
  const head = {
    bm: '<p>NASA Blue Marble is a cloud-free mosaic of MODIS satellite images taken in August 2004, 500 m per pixel.</p>',
    mix: '<p>Blue Marble (August 2004, 500 m per pixel) giving way to Sentinel-2 cloudless (2025, 10 m per pixel).</p>',
    s2: '<p>Sentinel-2 cloudless 2025 by EOX: a cloud-free mosaic of Sentinel-2 images taken during 2025, 10 m per pixel. Each place is an average of its cloud-free passes, weighted towards the clearest, so changes during the year are blended.</p>'
  }[s.band];
  return head + (view === 'mosaic' ? status(s) : '') +
    (down(S2()) ? keep('Sentinel-2 tiles did not load from EOX, which limits traffic on its free service, so Blue Marble (500 m) is shown at every zoom. After a minute the map asks EOX again.') : '') +
    ((s.s2 < 1 ? gibsFails(BM(), 'Blue Marble') : '') || (s.polar ? gibsFails(CAP(), 'Blue Marble near the poles') : ''));
}

// The point under a click: which image is there at this zoom, from when, how sharp, and its coordinates.
const SEA = { bm: 'NASA Blue Marble colours the open sea one flat colour', mix: 'Blue Marble colours the open sea one flat colour and EOX colours it by depth', s2: 'EOX colours the open sea by depth' };
async function query([lon, lat], api) {
  const s = look(api.k), off = Math.abs(lat) > MERC;
  const detail = (res, enlarged) => ['Detail', `About ${res} m per pixel${enlarged ? '; zoomed in past that, so the image is only enlarged' : ''}`];
  // "Enlarged" is asked again when the zoom crosses into another band (sync), so it stays true while the panel is open.
  if (view !== 'mosaic' && off) return [['Imagery', 'None here: these tiles stop at 85° N and S']];
  if (view === 'day') {
    const d = shownDay(), sat = satOf(d);
    return [['Imagery', `${sat.name} true-colour image, NASA`], ['Taken', `${long(d)}, at about ${sat.time} local solar time`], detail(sat.res, s.enlarged)];
  }
  if (view === 'night') return [['Imagery', 'NASA Black Marble, Suomi NPP VIIRS Day/Night Band'], ['Taken', 'Composite of cloud-free nights in 2016'], detail(500, s.enlarged)];
  // The aerial service at the point (the top one where outlines overlap), and whether this zoom shows it yet.
  let photo = null;
  if (COV && !off) {
    for (const d of AERIAL) {
      const c = COV[d.cov || d.id], v = c && inside(c, lon, lat) && live(d);
      if (v && !down(photoSrc(v)) && gapAt(v, lon, lat, s.zf) !== 'none') photo = v;
    }
  }
  if (photo && s.air >= 0.5 && s.s2 >= 1) {
    return [['Imagery', `${photo.name}, ${photo.kind || AIR}`], ['Taken', cap(photo.dates)],
      ['Detail', `${cap(photo.detail)}${s.past(photo, lon, lat) ? '; zoomed in past that, so the image is only enlarged' : ''}`]];
  }
  const band = off ? 'bm' : s.band === 'air' ? 's2' : s.band;
  const what = { bm: 'NASA Blue Marble mosaic, MODIS', mix: 'NASA Blue Marble fading into Sentinel-2 cloudless by EOX', s2: 'Sentinel-2 cloudless mosaic by EOX' }[band];
  let when = { bm: 'August 2004', mix: 'August 2004 (Blue Marble) and 2025 (Sentinel-2)', s2: '2025: an average of the year\'s cloud-free passes, so changes during the year are blended' }[band];
  const res = band === 's2' ? 10 : 500, enlarged = band === 'bm' ? s.m < 250 : s.enlarged;
  const closer = photo ? [['Closer in', `${photo.name}, ${photo.kind || AIR}: ${photo.detail}`]] : [];
  // Neither mosaic photographs the open sea. Below 1500 m it is open ocean; shallower water may be coast or a lake.
  const h = await elevationAt(lon, lat).catch(() => 0);
  if (h < -1500) return [['Imagery', what], ['Taken', `Not photographed: ${SEA[band]}`], ['Detail', 'No photographic detail at sea']];
  if (band === 's2' && (lat > 84 || lat < -60)) when += '. Sentinel-2 does not image much of the polar ice, which EOX fills in, so this may not be a photograph';
  if (h < -50) when += `. If this is open sea, it is not a photograph: ${SEA[band]}`;
  return [['Imagery', what], ['Taken', when], detail(res, enlarged), ...closer];
}

// The date row under the view menu: shown for "One day from space" only. While the field has focus its value is left
// alone, so typing a date is not overwritten; it is tidied on blur. Setting min or max, even unchanged, rebuilds
// Chrome's date fields and drops the focus, so they are set only when they change.
function tools() {
  const row = shared?.tools.querySelector('#photoDay');
  if (!row) return;
  row.hidden = view !== 'day';
  const input = row.querySelector('input'), d = shownDay(), hi = latest();
  if (input.min !== TERRA.start) input.min = TERRA.start;
  if (input.max !== hi) input.max = hi;
  if (document.activeElement !== input) input.value = d;
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page when it is the one just pressed.
  row.querySelector('[data-step="-1"]').setAttribute('aria-disabled', d <= TERRA.start);
  row.querySelector('[data-step="1"]').setAttribute('aria-disabled', d >= hi);
}
// Legend, open point panel, globe, corner credit and address follow a change of view, day or zoom band (the app's
// refresh rewrites the corner, which here follows what is on screen).
function sync() {
  clearTimeout(pending);
  pending = 0;
  if (!shared?.tools.querySelector('#photoView')) return; // another map type is shown
  // shortcut: the app rebuilds the phone legend folded; reopen it here until renderLegend keeps it open (reported).
  const open = document.querySelector('#legendCard details.maplegend')?.open;
  shared.refresh();
  if (open) document.querySelector('#legendCard details.maplegend')?.setAttribute('open', '');
}

// Open sea in the middle of the view, zoomed in past Blue Marble: neither mosaic photographs it (EOX fills it dark
// blue, then black), so the map says so there and in the key's title. The depth is read once the globe stops.
let seaAt = '', seaHere = false;
function seaNote(api) {
  if (view !== 'mosaic' || look(api.k).band !== 's2') { seaAt = ''; seaHere = false; return; } // a band change syncs the key
  const c = api.center, at = String(c);
  if (!api.moving && at !== seaAt) {
    seaAt = at;
    elevationAt(c[0], c[1]).then(h => {
      if (seaAt === at && (h < -1500) !== seaHere) { seaHere = h < -1500; sync(); }
    }).catch(() => {});
  }
  if (!seaHere || api.moving) return;
  const { ctx, C } = api, [x, y] = api.proj(c);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; ctx.letterSpacing = '0px';
  [['600 14px', 'Open sea: not photographed', -40], ['500 12.5px', 'Zoom out, or move to a coast', -21]].forEach(([f, t, dy]) => {
    ctx.font = `${f} "Plus Jakarta Sans", system-ui, sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = C.halo; ctx.strokeText(t, x, y + dy);
    ctx.fillStyle = C.text; ctx.fillText(t, x, y + dy);
  });
}

const chevron = d => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
// No font here: style.css sets it, at 16px on touch screens so iOS does not zoom the page on focus.
const BOX = 'flex:1;min-width:0;min-height:36px;padding:0 8px;color:inherit;background:var(--panel);border:1px solid var(--field);border-radius:6px';

const photographic = {
  id: 'photographic', name: 'Photographic', group: 'Land and sea',
  // Every source of all three views, for the Sources section.
  credit: `Cloud-free mosaic: ${BM_CREDIT}; ${S2_CREDIT}; aerial photographs: ` +
    `${[...AERIAL, NAIP, USGS].filter(d => d.credit).map(d => d.credit).join('; ')}; photo borders: ${BORDERS}. ` +
    `One day from space: ${N20.credit} and ${TERRA.credit} ${NASA}. Earth at night: NASA Black Marble 2016 (Earth Observatory, Goddard) ${NASA}.`,
  // Only what is on screen and asks to be credited on the map; sync() rewrites the corner when that changes.
  get onMap() {
    if (view !== 'mosaic') return '';
    const s = look(1), photos = s.air > 0 ? s.seen : [];
    return [...photos.filter(d => d.onMap).map(d => d.credit), s.s2 > 0 && S2_ON_MAP, photos.length && OSM].filter(Boolean).join('; ');
  },
  // Zoom stops where a device pixel covers 8 cm, the finest photographs (PDOK), and not before the old 120000.
  maxK: ({ base, dpr }) => Math.max(120000, R / (base * dpr * 0.08)),
  // The key's title, which phones show while the key is folded: a line above says what did not load.
  state() {
    if (view === 'night') return NIGHT().fails ? 'some images did not load' : '';
    if (view === 'day') return daySrc(shownDay()).fails || N20.failed || TERRA.failed ? 'some images did not load' : '';
    const s = look(1), h = s.band === 'air' && s.here;
    const bad = s.gone.length || down(S2()) || (s.s2 < 1 && BM().fails) || (s.polar && CAP().fails) || (h && (h === USGS || photoSrc(h).fails));
    return bad ? 'some images did not load' : seaHere && s.band === 's2' ? 'open sea, not photographed' : '';
  },
  layers({ k }) {
    const s = look(k);
    if (s.key !== shownKey) later(); // crossed into another band: the legend and corner follow within 0.2 s
    if (view === 'day') return [...(prevDay && prevDay !== shownDay() ? [{ src: daySrc(prevDay) }] : []), { src: daySrc(shownDay()) }];
    if (view === 'night') return [{ src: NIGHT_CAP }, { src: NIGHT() }];
    // Once Sentinel-2 is opaque, Blue Marble is needed only for the caps, and its tiles would take EOX's load slots.
    // Sentinel-2 stays under the photographs: it fills their gaps, their edges and the time they take to load.
    return [...(s.polar ? [{ src: CAP() }] : []), ...(s.s2 < 1 ? [{ src: BM() }] : []), ...(s.s2 > 0 ? [{ src: S2(), opacity: s.s2 }] : []),
      ...s.seen.map(d => ({ src: photoSrc(d), opacity: s.air }))];
  },
  vector: 'lines', click: 'point', query, legend,
  overlay: { load() {}, draw: seaNote },
  // In the address: the view when it is not the mosaic, and a day once one is picked (none means the newest).
  params: () => (view === 'mosaic' ? {} : { view, day: view === 'day' ? day : null }),
  setup(api) {
    shared = api; P = api.proj;
    loadCoverage();
    // A link or reload to this map: start on its view and day.
    const q = new URLSearchParams(location.search);
    if (q.get('map') === 'photographic') {
      if (VIEWS.some(([v]) => v === q.get('view'))) view = q.get('view');
      const d = q.get('day');
      if (view === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(d || '')) { pick(d, 0); prevDay = null; }
    }
    api.tools.innerHTML = `<div style="margin-bottom:12px"><label for="photoView" class="field">View</label>
      <select id="photoView">${VIEWS.map(([v, n]) => `<option value="${v}"${v === view ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <div id="photoDay" style="display:flex;gap:8px;margin-top:8px" hidden>
        <button type="button" class="icon" data-step="-1" aria-label="Previous day" style="height:auto">${chevron('M15 6l-6 6 6 6')}</button>
        <input type="date" aria-label="Day shown, UTC" required style="${BOX}">
        <button type="button" class="icon" data-step="1" aria-label="Next day" style="height:auto">${chevron('M9 6l6 6-6 6')}</button>
      </div><p id="photoSay" class="sr" aria-live="polite"></p></div>`;
    const t = api.tools, input = t.querySelector('input');
    t.querySelector('#photoView').addEventListener('change', e => { view = e.target.value; if (view === 'day') loadDays(); tools(); sync(); });
    // Chrome fires change for each typed year digit (0002, 0020, 0201, 2015): only a day in range is acted on while
    // typing. On leaving the field a full year out of range goes to the first or newest day; anything else is undone.
    input.addEventListener('change', () => { const v = input.value; if (v >= input.min && v <= input.max) { pick(v, 0); tools(); sync(); } });
    input.addEventListener('blur', () => {
      const v = input.value;
      if (v >= '1000' && (v < input.min || v > input.max)) { pick(v, 0); sync(); }
      input.value = shownDay();
    });
    for (const b of t.querySelectorAll('[data-step]')) {
      b.addEventListener('click', () => {
        if (b.getAttribute('aria-disabled') === 'true') return; // first or newest day
        const dir = +b.dataset.step;
        pick(addDays(shownDay(), dir), dir); tools(); sync();
        t.querySelector('#photoSay').textContent = long(shownDay());
      });
    }
    if (view === 'day') loadDays();
    tools();
  }
};
export default photographic;

// The map types the globe can show, and what each one needs.
//
// A type is:
//   id, name, group           shown in the "Map type" menu, grouped (repeated in the stub below for a module loaded later)
//   live                      optional true: a live feed; the menu, the search and the key add "(live)" to the name (label)
//   credit                    HTML naming all the map's sources, with links, dataset versions and download dates:
//                             listed under Maps in the Sources section, the only place a map names its sources
//   onMap                     optional short HTML: only the credit a licence requires on the map itself (OpenStreetMap,
//                             OpenTopoMap, EOX, some aerial services), shown in the bottom corner while the type is
//                             shown. Empty or missing: the corner stays empty. May be a function ({ k }) of the zoom, so a
//                             tile credit shows only once those tiles fade in, or a getter that follows other state
//                             (the corner is re-read every frame)
//   layers({ k, dark })       tile layers to drape, bottom first: [{ src, opacity }] (engine.js explains sources)
//   vector                    how much of the country layer is drawn over the tiles:
//                             'full' (fills and borders), 'lines' (borders and coast only), 'none'
//   click                     'country' (a click opens the country) or 'point' (a click reads the map there)
//   query(at)                 async: [[label, html], ...] for a clicked point [lon, lat] (point maps)
//   more(at, api)             optional async: HTML shown under those rows once ready (Airports: view from above, photos)
//   featureAt(at)             optional async: the feature standing at a clicked or linked point, as overlay.pick
//                             returns one, or null. The panel then takes its title and subtitle, and the address its
//                             own position, so a click beside its marker or a link opens it as if picked (Airports)
//   places()                  optional: features searched (Ctrl K) while this type is shown, or null until loaded;
//                             each also has names (strings matched), kind (shown beside it), rank (lower first) and
//                             k (the zoom it opens at). Return the same array each time: it is indexed once
//   photo(i)                  optional: the i-th photo record { title, img, page, author, licence, w, h } for the
//                             lightbox; buttons carry data-photo="map|<type id>|<i>"
//   legend({ mode })          HTML key for the legend card, or ''; mode is the app's colouring (a figure or a group).
//                             Only short status or unit lines (<p class="note keep">); no notes on method or caveats
//   ownsColour                optional true (or a getter): the map colours the countries itself, so the app hides
//                             Colour by figure, Or show a group and their key on this type
//   drawsCapitals             optional true: the map draws capitals itself, so the app hides its Capitals layer
//   darkTiles                 optional true: the tiles are light street-map tiles only, so in dark mode the app
//                             inverts them (style.css), keeping hues, instead of a bright map under the dark chrome
//   paper                     optional true: the globe is light in both themes (the Atlas, light relief), so in dark mode
//                             the app fills, marks and names it in the light theme's colours and tones it down a little
//   ink                       optional { text, halo }: the app's own names in the map's ink instead (a paper map)
//   dataMap                   optional true: the map itself shows data (hazards, weather, zones, airports), so hot-spot
//                             markers step back as under a colouring (small, grey, shape only) and the key matches
//   overlay                   optional data drawn on the 2D canvas over the tiles:
//                               load(api)            Promise, called once when the type is first shown
//                               draw(api)            draws on api.ctx with api.proj / api.path
//                               pick(x, y, api)      the feature under the pointer:
//                                                    { title, sub, at: [lon, lat], rows: [[label, html]] } or null
//   paint(api)                optional: draws the sea and the countries itself (the app then skips its own fills)
//   labels(api)               optional: letters the map itself in place of the app's country and capital names
//   placeLabels(api)          optional: places the map's own labels in the app's label pass, before the country names
//                             (api.boxes: the boxes taken so far; push each label's box)
//   namesFirst                optional true: placeLabels runs after the country names, so they keep their places
//   drawSel(api)              optional: draws the open point's own marker (api.sel), over the hot spots and under its ring
//   setup(api)                optional, called each time the type is shown (e.g. to add a control); it reads its
//                             starting settings from the address when ?map= is this type
//   params()                  optional: the type's own settings for the address, e.g. { view: 'day', day: '2026-11-14' }
//                             (null values are left out); api.refresh() writes them
//   state()                   optional, for live feeds: '' | 'loading' | 'did not load', or a few words on what is
//                             drawn in this view ('density only here'), shown in the key's title
//   maxK                      optional: how far the map zooms in, as k (default 30000, about a street), or
//                             ({ base, dpr }) => k for a limit that follows the globe's size and the screen
//   countryLabels             optional false: the tiles name the countries, so the app does not
// api (from app.js): { ctx, proj, path, k, w, h, dpr, center, visible(p), dark, C, sel, moving, lite, draw(), esc, fmt }
// (dark and C are the ground's: a paper globe, and any colouring, is light in both themes)
// (lite: a finger is moving the globe on a touch screen, so the frame should be as light as the map allows)

import { terrainSource, reliefLegend } from './relief.js';
import reference from './types/reference.js';

// The entry map (Reference) comes with the page. The other modules in types/ are fetched the first time they are
// shown (loadType), so the entry screen does not wait for 14 files it does not draw. Until then each is a stub whose
// id, name, group and live flag list it in the "Map type" menu and the search; they must match the module's own.
const later = (id, name, group, live) => ({ id, name, group, live, later: true });
const timezones = later('timezones', 'Time zones', 'Countries and borders');
const postal = later('postal', 'Postal codes', 'Countries and borders');
const income = later('income', 'GDP per person by region', 'Economy');
const resources = later('resources', 'Resources', 'Economy');
const photographic = later('photographic', 'Photographic', 'Land and sea');
const geologic = later('geologic', 'Geologic', 'Earth science');
const plates = later('plates', 'Plate tectonics', 'Earth science');
const earthquakes = later('earthquakes', 'Earthquakes', 'Earth science', true);
const volcanoes = later('volcanoes', 'Volcanic hazard', 'Earth science');
const weather = later('weather', 'Weather', 'Weather and life', true);
const hardiness = later('hardiness', 'Plant hardiness zones', 'Weather and life');
const species = later('species', 'Species distribution', 'Weather and life');
const airports = later('airports', 'Airports', 'Transport');

export const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const TERRAIN_CREDIT = '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen on AWS: SRTM, GMTED2010, ETOPO1, GEBCO and <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">others</a>)';

// OpenStreetMap's own tiles: free for light use with the credit always visible (tile usage policy).
export const OSM = { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 };
// OpenTopoMap: contours, hillshade and names from OpenStreetMap and SRTM (CC BY-SA), to zoom 17.
const OPENTOPO = { id: 'opentopo', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17 };
// NASA Blue Marble with shaded relief and bathymetry (public domain), to zoom 8; WMTS order is row then column.
const BLUE_MARBLE = {
  id: 'gibs-bluemarble', maxZoom: 8,
  url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'
};
// Sentinel-2 cloudless 2025 by EOX (CC BY-NC-SA 4.0): 10 m imagery. EOX's level 15 is sharper in some tiles than
// others, so level 14 is enlarged past it, as on the Photographic map.
const S2 = { id: 'eox-s2-2025', maxZoom: 14, url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg' };
const TERRAIN = { topo: terrainSource('topo'), bathy: terrainSource('bathy') };
// Web Mercator tiles stop at 85° N and S. Under them each polar cap gets the colour its layer has at 85° (averaged
// round the globe), so the page does not show through at the poles: one lon/lat tile of 180 one-degree rows.
function caps(id, north, south) {
  let c = null;
  const paint = () => {
    c = document.createElement('canvas'); c.width = 1; c.height = 180;
    const g = c.getContext('2d');
    g.fillStyle = north; g.fillRect(0, 0, 1, 6);
    g.fillStyle = south; g.fillRect(0, 174, 1, 6);
    return c;
  };
  return { id: `caps-${id}`, scheme: 'geo', maxZoom: 0, url: () => '', load: () => Promise.resolve(c || paint()) };
}
const OSM_CAPS = caps('osm', '#aad3df', '#f2efe9');
const BM_CAPS = caps('bluemarble', '#0e244d', '#e9eaeb');
const TERRAIN_CAPS = { topo: caps('topo', '#97c3e4', '#c5a77c'), bathy: caps('bathy', '#397cb5', '#dbd9d1') };

// Detail fades in as the globe is zoomed in: none below k = a, all of it from k = b.
export const fade = (k, a, b) => Math.max(0, Math.min(1, (Math.log(k) - Math.log(a)) / (Math.log(b) - Math.log(a))));

const political = {
  id: 'political', name: 'Plain borders', group: 'Countries and borders',
  credit: `<a href="https://www.naturalearthdata.com/">Natural Earth</a> borders; ${OSM_CREDIT}`,
  onMap: ({ k }) => (k < 4 ? '' : OSM_CREDIT),
  // Below k = 4 the globe is the hand-made country map; from there OpenStreetMap fades in under the borders.
  layers: ({ k }) => (k < 4 ? [] : [{ src: OSM_CAPS, opacity: fade(k, 4, 7) }, { src: OSM, opacity: fade(k, 4, 7) }]),
  vector: 'full', click: 'country', legend: () => '', darkTiles: true, maxK: 120000 // OpenStreetMap's level 19, enlarged twice
};

const physical = {
  id: 'physical', name: 'Physical', group: 'Land and sea',
  credit: '<a href="https://earthdata.nasa.gov/gibs">NASA Blue Marble via GIBS</a>; <a href="https://cloudless.eox.at">Sentinel-2 cloudless 2025</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025, CC BY-NC-SA 4.0)',
  // EOX's licence asks for this text wherever the imagery is shown (cloudless.eox.at/documentation/license).
  onMap: ({ k }) => (k < 22 ? '' : '<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)'),
  layers: ({ k }) => [{ src: BM_CAPS }, { src: BLUE_MARBLE }, ...(k < 22 ? [] : [{ src: S2, opacity: fade(k, 22, 40) }])],
  vector: 'lines', click: 'point', legend: () => ''
};

const topographic = {
  id: 'topographic', name: 'Topographic', group: 'Land and sea',
  credit: `${TERRAIN_CREDIT}. Topographic detail: map data ${OSM_CREDIT}, SRTM; map style © <a href="https://opentopomap.org/about">OpenTopoMap</a> (CC BY-SA)`,
  // OpenTopoMap asks for this notice, clearly visible (opentopomap.org/about).
  onMap: ({ k }) => (k < 22 ? '' : `Map data ${OSM_CREDIT}, SRTM; map style © <a href="https://opentopomap.org/about">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</a>)`),
  layers: ({ k }) => [{ src: TERRAIN_CAPS.topo }, { src: TERRAIN.topo }, ...(k < 22 ? [] : [{ src: OPENTOPO, opacity: fade(k, 22, 45) }])],
  vector: 'lines', click: 'point', paper: true,
  legend: () => reliefLegend('topo', { from: -3000, to: 6500 })
};

const bathymetric = {
  id: 'bathymetric', name: 'Bathymetric', group: 'Land and sea',
  credit: TERRAIN_CREDIT,
  layers: () => [{ src: TERRAIN_CAPS.bathy }, { src: TERRAIN.bathy }],
  vector: 'lines', click: 'point',
  legend: () => reliefLegend('bathy', { from: -11000, to: 0 })
};

const roads = {
  id: 'roads', name: 'Roads, streets and highways', group: 'Countries and borders',
  credit: OSM_CREDIT, onMap: OSM_CREDIT,
  layers: () => [{ src: OSM_CAPS }, { src: OSM }],
  vector: 'lines', click: 'point', legend: () => '', darkTiles: true,
  countryLabels: false, maxK: 120000 // the tiles name countries and cities; OpenStreetMap's level 19, enlarged twice
};

const flags = {
  id: 'flags', name: 'Flags', group: 'Countries and borders',
  credit: '<a href="https://github.com/lipis/flag-icons">flag-icons</a> (MIT)',
  layers: () => [], vector: 'full', click: 'country', legend: () => '', flags: true, ownsColour: true
};

export const MAP_TYPES = [
  reference, political, roads, airports, timezones, postal, income, resources, flags,
  physical, photographic, topographic, bathymetric,
  geologic, plates, earthquakes, volcanoes,
  weather, hardiness, species
];
export const GROUP_ORDER = ['Countries and borders', 'Economy', 'Transport', 'Land and sea', 'Earth science', 'Weather and life'];
// The name as the menu, the search and the key show it.
export const label = t => (t.live ? `${t.name} (live)` : t.name);
export const mapType = id => MAP_TYPES.find(t => t.id === id) || political;
// The full map type for an id, its module fetched first if it has not come yet (undefined for an unknown id).
export async function loadType(id) {
  const i = MAP_TYPES.findIndex(t => t.id === id), stub = MAP_TYPES[i];
  if (!stub?.later) return stub;
  const t = (await import(`./types/${id}.js`)).default;
  if (t.name !== stub.name || t.group !== stub.group || !t.live !== !stub.live) console.warn(`maps/types.js: the stub for ${id} does not match its module`);
  return (MAP_TYPES[i] = t);
}

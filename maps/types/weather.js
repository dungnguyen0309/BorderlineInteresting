// Weather: satellite precipitation (NASA GPM IMERG via GIBS) or infrared clouds (EUMETSAT) over a dimmed
// Blue Marble, each labelled with the time it is valid for; a click reads Open-Meteo's forecast for the point.
import { SCHEMES } from '../engine.js';

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const IMERG = 'IMERG_Precipitation_Rate_30min';
const EUM_WMS = 'https://view.eumetsat.int/geoserver/wms';
const EUM_LAYER = 'mumi:worldcloudmap_ir108';
const BLUE_MARBLE = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';

const LAYERS = [
  ['rain', 'Precipitation now'],
  ['clouds', 'Clouds'],
  ['both', 'Clouds and precipitation']
];
let layer = 'rain';

// Latest valid time of each image, as ISO strings; null while unknown, 'error' if the lookup failed.
const T = { rain: null, clouds: null };
let asked = 0, timer = 0;
const getText = url => fetch(url, { signal: AbortSignal.timeout(10000) }).then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status))));
const day = ms => new Date(ms).toISOString().slice(0, 10);

// IMERG: GIBS lists the times it holds for a date range; the end of the last interval is the newest half hour.
// The newest listed half hours can still be missing most of their tiles (seen: 05:30 6 of 8, 05:00 none, 04:30 all),
// so each candidate is checked with four tiles spread over the globe and the newest complete one is used.
const PROBES = ['2/1/1', '2/1/2', '2/2/1', '2/2/2'];
const complete = t => Promise.all(PROBES.map(p => fetch(`${GIBS}/${IMERG}/default/${t}/GoogleMapsCompatible_Level6/${p}.png`, { signal: AbortSignal.timeout(10000) }).then(r => r.ok, () => false)))
  .then(oks => oks.every(Boolean));
const imergTime = () => getText(`${GIBS}/1.0.0/${IMERG}/default/GoogleMapsCompatible_Level6/all/${day(Date.now() - 864e5)}--${day(Date.now() + 864e5)}.xml`)
  .then(async x => {
    const d = x.match(/<Domain>([^<]+)<\/Domain>/)?.[1].split(',').pop().split('/');
    if (!d) throw new Error('no IMERG time');
    const newest = new Date(d.length > 1 ? d[1] : d[0]).getTime();
    for (let i = 0; i < 8; i++) { // back half an hour at a time, up to 4 hours
      const t = new Date(newest - i * 18e5).toISOString().replace('.000Z', 'Z');
      if (await complete(t)) return t;
    }
    throw new Error('no complete IMERG half hour in the last 4 hours');
  });
// EUMETSAT: the layer's own capabilities (6 KB) name its newest time as the default. That newest image is
// filled in region by region (parts of it are still the image before), so the complete step 3 hours earlier is used.
const cloudTime = () => getText(`https://view.eumetsat.int/geoserver/mumi/worldcloudmap_ir108/ows?service=WMS&version=1.3.0&request=GetCapabilities`)
  .then(x => {
    const d = x.match(/<Dimension name="time"[^>]*default="([^"]+)"/)?.[1];
    if (!d) throw new Error('no cloud time');
    return new Date(new Date(d).getTime() - 108e5).toISOString().replace('.000Z', 'Z');
  });

// Looks the times up again after 10 minutes, or straight away after a failure.
function loadTimes(api) {
  if (Date.now() - asked < 6e5 && T.rain !== 'error' && T.clouds !== 'error') return;
  asked = Date.now();
  for (const [key, get] of [['rain', imergTime], ['clouds', cloudTime]]) {
    if (T[key] === 'error') T[key] = null;
    get().then(t => { T[key] = t; }, e => { console.warn(e); T[key] = 'error'; }).then(() => api.refresh());
  }
}

// Tile sources, made once per time (the time is part of the id, so a newer image never mixes with an older one).
const sources = new Map();
const once = (id, make) => sources.get(id) || sources.set(id, make()).get(id);

// Loads one tile image; failures are counted on the source (so per time) and the legend is told on the first one.
let shared = null; // the api from the latest setup()
const loadImg = (src, url) => new Promise((ok, fail) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => ok(img);
  img.onerror = e => { if (!src.fails++) shared?.refresh(); fail(e); };
  img.src = url;
});
// An empty url is a tile left blank without asking (see rainSrc).
const NONE = Object.assign(document.createElement('canvas'), { width: 1, height: 1 });
const counted = src => Object.assign(src, { fails: 0, load: url => (url ? loadImg(src, url) : Promise.resolve(NONE)) });

// IMERG stops at 60° N and S: GIBS answers 404, with no CORS header, for tiles wholly beyond, so they are not asked for.
const rainSrc = t => once(`imerg-${t}`, () => counted({
  id: `imerg-${t}`, maxZoom: 6,
  url: (z, x, y) => {
    const [, , n, s] = SCHEMES.xyz.bounds(z, x, y);
    return s >= 60 || n <= -60 ? '' : `${GIBS}/${IMERG}/default/${t}/GoogleMapsCompatible_Level6/${z}/${y}/${x}.png`;
  }
}));
// A WMS asked for one 256 px image per lon/lat tile; in WMS 1.3.0, EPSG:4326 boxes are south, west, north, east.
const wms = (base, query) => (z, x, y) => {
  const w = 180 / 2 ** z, west = -180 + x * w, north = 90 - y * w;
  return `${base}?service=WMS&version=1.3.0&request=GetMap&styles=&crs=EPSG:4326&width=256&height=256&${query}` +
    `&bbox=${north - w},${west},${north},${west + w}`;
};
const cloudSrc = t => once(`eum-ir108-${t}`, () => counted({
  id: `eum-ir108-${t}`, scheme: 'geo', maxZoom: 5,
  url: wms(EUM_WMS, `layers=${EUM_LAYER}&format=image/png&transparent=true&time=${t}`)
}));
// Blue Marble, greyed and dimmed so the rain colours stand out (darker in the dark theme). Lon/lat tiles, so the
// poles are covered too (Web Mercator tiles stop at 85°).
const baseSrc = dark => once(`weather-base-${dark ? 'dark' : 'light'}`, () => ({
  id: `weather-base-${dark ? 'dark' : 'light'}`, scheme: 'geo', maxZoom: 7, url: wms(BLUE_MARBLE, 'layers=BlueMarble_ShadedRelief_Bathymetry&format=image/jpeg'),
  load: url => new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = fail;
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      g.globalCompositeOperation = 'saturation'; g.fillStyle = 'rgba(128,128,128,0.8)'; g.fillRect(0, 0, c.width, c.height);
      g.globalCompositeOperation = 'source-over'; g.fillStyle = dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.25)'; g.fillRect(0, 0, c.width, c.height);
      ok(c);
    };
    img.src = url;
  })
}));

const known = t => t && t !== 'error';

// Times: "16 Nov 2026, 04:30 UTC" and how long ago.
const utc = iso => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()}, ${iso.slice(11, 16)} UTC`;
};
const ago = iso => {
  const h = (Date.now() - new Date(iso)) / 36e5;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes ago` : `about ${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'} ago`;
};
const plus30 = iso => new Date(new Date(iso).getTime() + 18e5).toISOString().slice(11, 16);

// IMERG colour map (GIBS GPM_Precipitation_Rate): sample colours at the labelled steps, in mm per hour.
const RAIN = [['#00764e', '0.1'], ['#45c000', '0.5'], ['#c3e400', '1'], ['#ffb006', '2'], ['#ff4730', '5'], ['#e70000', '10'], ['#9c0000', '20'], ['#390000', '53 and over']];
const SNOW = [['#b1faee', '0.1'], ['#66abdc', '0.5'], ['#4f73c4', '1'], ['#4048d2', '2'], ['#5f2fe4', '5'], ['#770bd1', '10'], ['#770792', '20'], ['#3a0330', '53 and over']];
// One column, so each scale reads straight down (style.css .ord).
const sw = rows => `<ul class="swatches ord">${rows.map(([c, t]) => `<li><i style="--c:${c}"></i>${t}</li>`).join('')}</ul>`;

function timeNote(key, what) {
  const t = T[key];
  if (t === 'error') return `<p class="note keep">The time of the latest ${what} did not load, so it is not shown. Retrying every 10 minutes; to retry now, choose another layer and back.</p>`;
  if (!t) return `<p class="note keep">Finding the time of the latest ${what}…</p>`;
  const fails = (key === 'rain' ? rainSrc(t) : cloudSrc(t)).fails
    ? `<p class="note keep">Some image tiles did not load from ${key === 'rain' ? 'NASA GIBS' : 'EUMETSAT'}, so parts of the map are blank.</p>` : '';
  return (key === 'rain'
    ? `<p class="note keep">Valid for ${t.slice(11, 16)} to ${plus30(t)} UTC on ${utc(t).split(',')[0]} (${ago(t)}).</p>`
    : `<p class="note keep">Image taken at ${utc(t)} (${ago(t)}).</p>`) + fails;
}
const rainLegend = () => `${timeNote('rain', 'precipitation estimate')}
  <p>Rain, mm per hour</p>${sw(RAIN.slice().reverse())}
  <p>Snow, mm of melted water per hour</p>${sw(SNOW.slice().reverse())}`;
const cloudLegend = () => `${timeNote('clouds', 'cloud image')}
  ${sw([['#ffffff', 'Cold, high cloud tops (storms, fronts)'], ['#a6a6a6', 'Lower, warmer cloud'], ['#4d4d4d', 'Clear sky: warm land or sea']])}`;

// Open-Meteo forecast for a clicked point, kept for 10 minutes per 0.01° square.
const FC = 'https://api.open-meteo.com/v1/forecast';
const forecasts = new Map();
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const from = deg => `from the ${COMPASS[Math.round(deg / 22.5) % 16]} (${Math.round(deg)}°)`;
const minus = s => String(s).replace('-', '−'); // a true minus sign, as in the UTC offsets
const r0 = v => minus(Math.round(v) || 0); // || 0 turns -0 into 0
const r1 = v => minus((Math.round(v * 10) / 10 || 0).toFixed(1));

async function query([lon, lat]) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = forecasts.get(key);
  let d;
  if (hit && Date.now() - hit.at < 6e5) d = hit.d;
  else {
    const p = new URLSearchParams({
      latitude: lat.toFixed(4), longitude: lon.toFixed(4), timezone: 'auto', forecast_days: 8,
      current: 'temperature_2m,apparent_temperature,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
      daily: 'temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,wind_speed_10m_max,wind_direction_10m_dominant,pressure_msl_mean,cloud_cover_mean'
    });
    try {
      const r = await fetch(`${FC}?${p}`, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      d = await r.json();
    } catch (e) {
      console.warn(e);
      return [['Forecast', 'Did not load from Open-Meteo. Try again in a moment.']];
    }
    forecasts.set(key, { at: Date.now(), d });
    if (forecasts.size > 50) forecasts.delete(forecasts.keys().next().value);
  }
  const c = d.current, y = d.daily;
  const m = Math.abs(d.utc_offset_seconds) / 60;
  const zone = `UTC${d.utc_offset_seconds >= 0 ? '+' : '−'}${Math.floor(m / 60)}${m % 60 ? ':' + String(m % 60).padStart(2, '0') : ''}`;
  const dayName = (iso, i) => (i === 0 ? 'Today' : new Date(`${iso}T12:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }));
  return [
    ['Forecast for', `${c.time.slice(11, 16)} local time (${zone}), ${c.time.slice(0, 10)}, from weather models`],
    ['Temperature', `${r1(c.temperature_2m)} °C, feels like ${r1(c.apparent_temperature)} °C`],
    ['Precipitation', `${r1(c.precipitation)} mm in the last ${r0(c.interval / 60)} minutes`],
    ['Wind', `${r0(c.wind_speed_10m)} km/h ${from(c.wind_direction_10m)}, gusts ${r0(c.wind_gusts_10m)} km/h`],
    ['Pressure', `${r0(c.pressure_msl)} hPa at sea level`],
    ['Cloud cover', `${r0(c.cloud_cover)}%`],
    ...y.time.map((t, i) => [dayName(t, i),
      `${r0(y.temperature_2m_max[i])} / ${r0(y.temperature_2m_min[i])} °C (feels ${r0(y.apparent_temperature_max[i])} / ${r0(y.apparent_temperature_min[i])} °C), ` +
      `${r1(y.precipitation_sum[i])} mm, wind up to ${r0(y.wind_speed_10m_max[i])} km/h ${from(y.wind_direction_10m_dominant[i])}, ` +
      `${r0(y.pressure_msl_mean[i])} hPa, ${r0(y.cloud_cover_mean[i])}% cloud`])
  ];
}

export default {
  id: 'weather', name: 'Weather', group: 'Weather and life', live: true, dataMap: true,
  credit: 'Precipitation: <a href="https://gpm.nasa.gov/data/imerg">NASA GPM IMERG</a> (early run) and Blue Marble via <a href="https://earthdata.nasa.gov/gibs">NASA GIBS</a>; ' +
    `clouds: © <a href="https://view.eumetsat.int/">EUMETSAT</a> ${new Date().getUTCFullYear()} (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>); ` +
    'forecast: <a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>)',
  // Open-Meteo's licence asks for a link next to wherever its data shows (open-meteo.com/en/licence): the forecast
  // opens from this map. NASA (no restrictions) and EUMETSAT (CC BY 4.0) ask for credit, not on the map.
  onMap: '<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>',
  layers: ({ dark }) => [
    { src: baseSrc(dark) },
    // Clouds a little fainter under precipitation, so the light snow colours still show on white cloud tops.
    ...(layer !== 'rain' && known(T.clouds) ? [{ src: cloudSrc(T.clouds), opacity: layer === 'both' ? 0.7 : 1 }] : []),
    ...(layer !== 'clouds' && known(T.rain) ? [{ src: rainSrc(T.rain) }] : [])
  ],
  vector: 'lines', click: 'point', query,
  setup(api) {
    shared = api;
    api.tools.innerHTML = `<label for="weatherLayer" class="field">Weather layer</label>
      <select id="weatherLayer" style="margin-bottom:12px">${LAYERS.map(([v, n]) => `<option value="${v}"${v === layer ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    const select = api.tools.querySelector('select');
    select.addEventListener('change', e => { layer = e.target.value; loadTimes(api); api.refresh(); });
    loadTimes(api);
    // Times (and "hours ago") refresh on their own while the page stays open; stops once another map type is chosen.
    clearInterval(timer);
    timer = setInterval(() => (select.isConnected ? loadTimes(api) : clearInterval(timer)), 61e4);
  },
  legend: () => (layer === 'rain' ? rainLegend() : layer === 'clouds' ? cloudLegend() : `${cloudLegend()}${rainLegend()}`)
};

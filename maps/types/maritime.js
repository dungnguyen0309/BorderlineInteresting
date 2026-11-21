// Shipping (live): vessel positions from the two open, keyless AIS feeds there are, Finland's Digitraffic (Baltic
// Sea) and Norway's Kystverket (Norwegian coast and Svalbard), read every 60 s while the map is shown (Kystverket
// every 5 minutes while its area is out of view), over the IMF and World Bank density of all AIS position reports
// from January 2015 to February 2021 (where AIS recorded ships worldwide; it depends on receiver coverage).
// scripts/build_maritime.py makes density.webp (0.05° cells) and overview.webp (0.25°) from it; both hold a class
// per cell (0 = none, 1 to 10 by the limits in BOUNDS), coloured here per theme.
import { MAP_FONT } from '../fonts.js';

const DT = 'https://meri.digitraffic.fi/api/ais/v1/';
const DT_INIT = { headers: { 'Digitraffic-User': 'Borderline-Interesting-research-map/1.0' } }; // their header, no personal data
const KV = 'https://kystdatahuset.kystverket.no/ws/api/ais/realtime/geojson';
// Kystverket's real-time address is the one its own map uses, not a documented service: it is read only on this
// computer (scripts/serve.py), not on the public site, until Kystverket agrees.
const KV_ON = ['localhost', '127.0.0.1'].includes(location.hostname);
const DATA = new URL('../../data/maps/maritime/', import.meta.url);
const EVERY = 60e3;          // positions: both feeds change about once a minute (Digitraffic caches for 60 s)
const META_EVERY = 10 * 60e3; // Digitraffic names and types (sent by ships every 6 minutes)
const MAX_AGE = 60 * 60e3;   // positions older than this are left out (Digitraffic keeps 24 hours)
const LABEL_K = 24;          // ship names from this zoom
const LAND_SHOW = 0.15;      // how much of the density shows through the land fill (lakes, rivers)
const D2R = Math.PI / 180, NM_KM = 1.852;
const COARSE = matchMedia('(pointer: coarse)').matches;
const OSM = { id: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19 };
const fade = (k, a, b) => Math.max(0, Math.min(1, (Math.log(k) - Math.log(a)) / (Math.log(b) - Math.log(a))));

// Density classes: class 1 is above 0 and under BOUNDS[0], class i + 1 from BOUNDS[i - 1]. AIS position reports
// per km² per year. Most open ocean is 10,000 to 300,000 and whole seas such as the Baltic are over 1 million, so
// the steps are half decades at the top. The build script reads this list.
const BOUNDS = [1, 100, 1e4, 1e5, 3e5, 1e6, 3e6, 1e7, 3e7];
// One ink per theme, more opaque for busier water: it reads by lightness alone and leaves hue to the vessels.
const INK = { light: [24, 46, 70], dark: [205, 220, 233] };
// Classes 1 to 3 share one tint: finer steps that faint could not be told apart from each other or the sea.
const ALPHA = [0, 0.05, 0.05, 0.05, 0.09, 0.13, 0.18, 0.26, 0.36, 0.48, 0.62];

// Ship type groups (AIS type codes), Okabe-Ito colours: told apart by people with any common colour blindness.
const GROUPS = [
  { c: '#0072b2', label: 'Cargo' },
  { c: '#e69f00', label: 'Tanker' },
  { c: '#cc79a7', label: 'Passenger' },
  { c: '#009e73', label: 'Fishing' },
  { c: '#f0e442', label: 'Tug and service' },
  { c: '#a3a3a3', label: 'Other or unknown' }
];
const groupOf = t => (t >= 70 && t < 80 ? 0 : t >= 80 && t < 90 ? 1 : (t >= 60 && t < 70) || (t >= 40 && t < 50) ? 2
  : t === 30 ? 3 : (t >= 31 && t <= 34) || (t >= 50 && t < 60) ? 4 : 5);

const TYPE_NAMES = {
  30: 'Fishing', 31: 'Towing', 32: 'Towing, tow over 200 m long or 25 m wide', 33: 'Dredging or underwater operations',
  34: 'Diving operations', 35: 'Military operations', 36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel',
  51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement',
  58: 'Medical transport', 59: 'Non-combatant ship (under the Geneva Conventions)'
};
const DECADE = { 20: 'Wing-in-ground craft', 40: 'High-speed craft', 60: 'Passenger', 70: 'Cargo', 80: 'Tanker', 90: 'Other type' };
const HAZARD = { 1: 'A', 2: 'B', 3: 'C', 4: 'D' };
function typeText(t) {
  if (!t) return 'Not stated';
  const d = DECADE[t - (t % 10)];
  if (d) return `${d}${HAZARD[t % 10] ? `, carrying dangerous goods (IMO hazard category ${HAZARD[t % 10]})` : ''} (AIS type ${t})`;
  return `${TYPE_NAMES[t] || 'Reserved code'} (AIS type ${t})`;
}
const NAV = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted in her ability to manoeuvre',
  'Constrained by her draught', 'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing', 'Reserved code 9',
  'Reserved code 10', 'Towing astern', 'Pushing ahead or towing alongside', 'Reserved code 13',
  'Emergency beacon active (AIS-SART, man overboard or EPIRB)', 'Not set (the default)'];
const STILL = new Set([1, 5, 6]); // at anchor, moored, aground: drawn as dots

// Flag from the MMSI's first digits (ITU maritime identification digits).
const MID_TEXT = "Albania 201;Andorra 202;Austria 203;Portugal (Azores) 204;Belgium 205;Belarus 206;Bulgaria 207;Vatican City 208;Cyprus 209 210 212;Germany 211 218;Georgia 213;Moldova 214;Malta 215 229 248 249 256;Armenia 216;Denmark 219 220;Spain 224 225;France 226 227 228;Finland 230;Faroe Islands 231;United Kingdom 232 233 234 235;Gibraltar 236;Greece 237 239 240 241;Croatia 238;Morocco 242;Hungary 243;Netherlands 244 245 246;Italy 247;Ireland 250;Iceland 251;Liechtenstein 252;Luxembourg 253;Monaco 254;Portugal (Madeira) 255;Norway 257 258 259;Poland 261;Montenegro 262;Portugal 263;Romania 264;Sweden 265 266;Slovakia 267;San Marino 268;Switzerland 269;Czech Republic 270;Turkey 271;Ukraine 272;Russia 273;North Macedonia 274;Latvia 275;Estonia 276;Lithuania 277;Slovenia 278;Serbia 279;Anguilla 301;United States (Alaska) 303;Antigua and Barbuda 304 305;Caribbean Netherlands, Curaçao or Sint Maarten 306;Aruba 307;Bahamas 308 309 311;Bermuda 310;Belize 312;Barbados 314;Canada 316;Cayman Islands 319;Costa Rica 321;Cuba 323;Dominica 325;Dominican Republic 327;Guadeloupe 329;Grenada 330;Greenland 331;Guatemala 332;Honduras 334;Haiti 336;United States 338 366 367 368 369;Jamaica 339;Saint Kitts and Nevis 341;Saint Lucia 343;Mexico 345;Martinique 347;Montserrat 348;Nicaragua 350;Panama 351 352 353 354 355 356 357 370 371 372 373 374;Puerto Rico 358;El Salvador 359;Saint Pierre and Miquelon 361;Trinidad and Tobago 362;Turks and Caicos Islands 364;Saint Vincent and the Grenadines 375 376 377;British Virgin Islands 378;United States Virgin Islands 379;Afghanistan 401;Saudi Arabia 403;Bangladesh 405;Bahrain 408;Bhutan 410;China 412 413 414;Taiwan 416;Sri Lanka 417;India 419;Iran 422;Azerbaijan 423;Iraq 425;Israel 428;Japan 431 432;Turkmenistan 434;Kazakhstan 436;Uzbekistan 437;Jordan 438;South Korea 440 441;Palestine 443;North Korea 445;Kuwait 447;Lebanon 450;Kyrgyzstan 451;Macau 453;Maldives 455;Mongolia 457;Nepal 459;Oman 461;Pakistan 463;Qatar 466;Syria 468;United Arab Emirates 470 471;Tajikistan 472;Yemen 473 475;Hong Kong 477;Bosnia and Herzegovina 478;France (Adélie Land) 501;Australia 503;Myanmar 506;Brunei 508;Micronesia 510;Palau 511;New Zealand 512;Cambodia 514 515;Christmas Island 516;Cook Islands 518;Fiji 520;Cocos (Keeling) Islands 523;Indonesia 525;Kiribati 529;Laos 531;Malaysia 533;Northern Mariana Islands 536;Marshall Islands 538;New Caledonia 540;Niue 542;Nauru 544;French Polynesia 546;Philippines 548;Timor-Leste 550;Papua New Guinea 553;Pitcairn Islands 555;Solomon Islands 557;American Samoa 559;Samoa 561;Singapore 563 564 565 566;Thailand 567;Tonga 570;Tuvalu 572;Vietnam 574;Vanuatu 576 577;Wallis and Futuna 578;South Africa 601;Angola 603;Algeria 605;France (Saint Paul and Amsterdam Islands) 607;Ascension Island 608;Burundi 609;Benin 610;Botswana 611;Central African Republic 612;Cameroon 613;Republic of the Congo 615;Comoros 616 620;Cape Verde 617;France (Crozet Islands) 618;Côte d'Ivoire 619;Djibouti 621;Egypt 622;Ethiopia 624;Eritrea 625;Gabon 626;Ghana 627;Gambia 629;Guinea-Bissau 630;Equatorial Guinea 631;Guinea 632;Burkina Faso 633;Kenya 634;France (Kerguelen Islands) 635;Liberia 636 637;South Sudan 638;Libya 642;Lesotho 644;Mauritius 645;Madagascar 647;Mali 649;Mozambique 650;Mauritania 654;Malawi 655;Niger 656;Nigeria 657;Namibia 659;Réunion 660;Rwanda 661;Sudan 662;Senegal 663;Seychelles 664;Saint Helena 665;Somalia 666;Sierra Leone 667;São Tomé and Príncipe 668;Eswatini 669;Chad 670;Togo 671;Tunisia 672;Tanzania 674 677;Uganda 675;Democratic Republic of the Congo 676;Zambia 678;Zimbabwe 679;Argentina 701;Brazil 710;Bolivia 720;Chile 725;Colombia 730;Ecuador 735;Falkland Islands 740;French Guiana 745;Guyana 750;Paraguay 755;Peru 760;Suriname 765;Uruguay 770;Venezuela 775";
const MID = new Map(MID_TEXT.split(';').flatMap(s => { const m = s.match(/^(.*?) ([\d ]+)$/); return m[2].split(' ').map(c => [c, m[1]]); }));
// [country, what the number says about the station]; a ship's MMSI is MID + 6 digits.
function flagOf(mmsi) {
  const s = String(mmsi).padStart(9, '0');
  const mid = /^[2-7]/.test(s) ? s.slice(0, 3) : /^(98|99)/.test(s) ? s.slice(2, 5) : /^111/.test(s) ? s.slice(3, 6) : '';
  const kind = /^98/.test(s) ? 'a craft carried by a ship' : /^99/.test(s) ? 'an aid to navigation (buoy or beacon)'
    : /^111/.test(s) ? 'a search and rescue aircraft' : /^97/.test(s) ? 'an emergency beacon' : '';
  return [MID.get(mid) || '', kind];
}

const clean = s => (s || '').replace(/@+$/, '').replace(/\s+/g, ' ').trim();
const valid = (lon, lat) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && (lon !== 0 || lat !== 0);
// AIS ETA (month, day, hour, minute in UTC, no year), packed as Digitraffic sends it; the year nearest now.
function etaOf(n) {
  const mo = (n >> 16) & 15, d = (n >> 11) & 31, h = (n >> 6) & 31, mi = n & 63;
  if (!mo || !d || h > 23 || mi > 59) return null;
  const now = new Date(), y = now.getUTCFullYear();
  return [y - 1, y, y + 1].map(yy => Date.UTC(yy, mo - 1, d, h, mi)).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
}

// ---------- data ----------

const feeds = {
  dt: { name: 'Digitraffic', list: null, read: 0, error: '', busy: false, done: 0 },
  ...(KV_ON ? { kv: { name: 'Kystverket', list: null, read: 0, error: '', busy: false, done: 0 } } : {})
};
const meta = { map: new Map(), done: 0, busy: false };
let timer = 0, statusEl = null, alertEl = null, lastApi = null, all = null;

const getJson = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30e3) })
  .then(r => { if (!r.ok) throw new Error(`answered ${r.status}`); return r.json(); });
const why = e => (e.name === 'TimeoutError' ? 'no answer in 30 seconds' : e instanceof TypeError ? 'network error'
  : e instanceof SyntaxError ? 'it sent a page instead of vessel data' : e.message);

function readMeta() {
  meta.busy = true;
  return getJson(`${DT}vessels`, DT_INIT).then(list => {
    meta.map = new Map(list.map(v => [v.mmsi, v]));
    all = null;
  }, e => console.warn('Digitraffic vessels', e)).finally(() => { meta.busy = false; meta.done = Date.now(); });
}

function fromDigitraffic(j) {
  const out = [], old = Date.now() - MAX_AGE;
  for (const f of j.features || []) {
    const p = f.properties, [lon, lat] = f.geometry?.coordinates || [];
    if (!p || !Number.isInteger(p.mmsi) || !valid(lon, lat) || p.timestampExternal < old) continue; // mmsi goes into panel HTML
    const m = meta.map.get(p.mmsi) || {};
    out.push({
      mmsi: p.mmsi, lon, lat, t: p.timestampExternal, sog: p.sog, cog: p.cog, hdg: p.heading, nav: p.navStat,
      name: clean(m.name), imo: m.imo, call: clean(m.callSign), type: m.shipType ?? null, dest: clean(m.destination),
      eta: m.eta != null ? etaOf(m.eta) : null, draught: m.draught ? m.draught / 10 : null,
      len: m.referencePointA + m.referencePointB || null, beam: m.referencePointC + m.referencePointD || null, src: 'dt'
    });
  }
  return out;
}

function fromKystverket(j) {
  const out = [], old = Date.now() - MAX_AGE;
  for (const f of j.features || []) {
    const p = f.properties, c = f.geometry?.coordinates;
    if (!p || !Number.isInteger(p.mmsi) || !c?.length) continue; // mmsi goes into panel HTML
    const [lon, lat] = c[c.length - 1]; // the track runs oldest to newest
    const t = Date.parse(`${p.date_time_utc}Z`);
    if (!valid(lon, lat) || !(t >= old)) continue;
    out.push({
      mmsi: p.mmsi, lon, lat, t, sog: p.speed, cog: p.cog, hdg: p.true_heading, nav: p.status,
      name: clean(p.ship_name), imo: p.imo, call: clean(p.callsign), type: p.ship_type ?? null, dest: clean(p.destination),
      eta: null, draught: p.draught || null, len: p.length || null, beam: p.breadth || null, cls: p.ais_class, src: 'kv'
    });
  }
  return out;
}

function read(key) {
  const f = feeds[key], first = !f.list;
  f.busy = true;
  const job = key === 'dt'
    ? (Date.now() - meta.done > META_EVERY && !meta.busy ? readMeta() : Promise.resolve())
      .then(() => getJson(`${DT}locations`, DT_INIT)).then(fromDigitraffic)
    : getJson(KV).then(fromKystverket);
  return job.then(list => { f.list = list; f.read = Date.now(); f.error = ''; },
    e => { console.warn(f.name, e); f.error = why(e); })
    // The first answer also re-reads an open point panel ("nearest live vessel"); later ones only redraw.
    .finally(() => { f.busy = false; f.done = Date.now(); all = null; show(); first && f.list ? lastApi?.refresh() : lastApi?.draw(); });
}

// Every vessel to draw, one per MMSI (the newest position wins), still ones first so moving ones are drawn on top.
// Rebuilt at least once a minute so positions past an hour drop out while a feed is failing.
let allAt = 0;
function vessels() {
  if (!all || Date.now() - allAt > EVERY) {
    const by = new Map(), old = Date.now() - MAX_AGE;
    allAt = Date.now();
    for (const f of Object.values(feeds)) for (const v of f.list || []) { const o = by.get(v.mmsi); if (v.t >= old && (!o || v.t > o.t)) by.set(v.mmsi, v); }
    all = [...by.values()];
    for (const v of all) {
      v.g = groupOf(v.type);
      v.dir = STILL.has(v.nav) ? null : v.sog >= 0.5 && v.sog < 102.3 && v.cog < 360 ? v.cog : v.hdg >= 0 && v.hdg < 360 ? v.hdg : null;
    }
    all.sort((a, b) => (b.dir == null) - (a.dir == null));
  }
  return all;
}

const num = n => Math.round(n).toLocaleString('en');
const pad = n => String(n).padStart(2, '0');
const hm = t => { const d = new Date(t); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const day = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} minute${m === 1 ? '' : 's'} ago` : `${Math.round(m / 60)} hours ago`;
}

// Runs every 5 s while this map is shown and the tab is visible: re-reads a feed 60 s after its last answer (or
// failure) and keeps the ages true. Stops for good once another map type is chosen (setup starts it again).
function tick() {
  if (!statusEl?.isConnected || document.getElementById('mapType')?.value !== 'maritime') { clearInterval(timer); timer = 0; return; }
  if (document.hidden) return;
  for (const key of Object.keys(feeds)) {
    const f = feeds[key], every = key === 'kv' && !kvInView() ? 5 * EVERY : EVERY; // Kystverket's answer is 0.5 to 1.2 MB
    if (!f.busy && Date.now() - f.done >= every) read(key);
  }
  show();
}
// Where the two live feeds report ships, drawn dashed on the map: traced by hand around one reading of both feeds
// (18 November 2026), so approximate. [lon, lat] rings, closed.
const DT_AREA = [[17.6, 58.6], [17.6, 60.6], [16.9, 61.6], [17.6, 63.0], [20.2, 64.2], [21.2, 65.3], [22.5, 66.0], [25.8, 66.0],
  [25.8, 64.6], [23.4, 63.4], [22.0, 62.5], [21.9, 60.8], [24.0, 60.6], [27.0, 60.9], [29.0, 61.2], [30.5, 60.2], [30.5, 59.6],
  [28.0, 59.3], [24.0, 59.2], [23.3, 58.8], [22.0, 58.2], [18.5, 58.2], [17.6, 58.6]];
const KV_AREA = [[1.0, 55.8], [3.8, 55.8], [8.0, 57.0], [10.8, 57.6], [11.4, 58.6], [11.6, 59.9], [11.0, 60.3], [10.0, 60.1],
  [9.0, 59.5], [8.0, 59.3], [6.6, 59.6], [7.2, 60.3], [7.8, 61.3], [8.8, 62.6], [11.8, 63.6], [12.6, 64.9], [14.6, 66.4], [16.2, 67.5],
  [17.8, 68.4], [19.0, 69.0], [21.0, 69.4], [25.0, 69.8], [29.0, 69.4], [33.0, 69.6], [33.0, 71.6], [34.5, 76.0], [34.5, 80.8],
  [9.5, 80.8], [9.5, 76.0], [15.0, 72.5], [12.0, 70.5], [8.5, 67.5], [4.5, 64.5], [3.0, 62.5], [1.0, 61.8], [1.0, 55.8]];
// An area is on screen: the view centre is inside its box, or one of its corners is on screen.
function inView(ring) {
  const a = lastApi;
  if (!a) return true;
  const [lon, lat] = a.center, lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  if (lon > Math.min(...lons) && lon < Math.max(...lons) && lat > Math.min(...lats) && lat < Math.max(...lats)) return true;
  return ring.some(p => { const s = a.visible(p) && a.proj(p); return s && s[0] > 0 && s[1] > 0 && s[0] < a.w && s[1] < a.h; }); // a corner just off screen counted at Hormuz
}
const kvInView = () => KV_ON && inView(KV_AREA);
const liveInView = () => kvInView() || inView(DT_AREA);

// The live feeds' state for the key's title (types.js): when no feed has given vessels yet, or when neither live
// area is in view (a change redraws the key, so its line on coverage follows the view).
const state = () => { const fs = Object.values(feeds); return fs.every(f => f.error) ? 'did not load' : fs.every(f => !f.list) ? 'loading' : liveInView() ? '' : 'density only here'; };
// The corner credit (types.js onMap): OpenStreetMap once its tiles fade in (ODbL; the OSMF's guidelines put the notice
// on the map, osmfoundation.org/wiki/Licence/Attribution_Guidelines). Digitraffic's terms (digitraffic.fi/en/
// terms-of-service) ask for its wording on the web page or app, Kystverket's NLOD and the World Bank's CC BY 4.0 for
// credit, none of them on the map: they are in Sources.
const cornerCredit = () => ((lastApi?.k || 1) > 30 ? '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' : '');
let lastState = '', lastCorner = '';
// Problems are said once in the app's live region (#mapSays); the visible line stays in the map's tools.
const say = t => { const el = document.getElementById('mapSays'); if (el && t) el.textContent = t; };

function show() {
  if (!statusEl?.isConnected) return;
  if (state() !== lastState || cornerCredit() !== lastCorner) { lastState = state(); lastCorner = cornerCredit(); lastApi?.refresh(); }
  // One line: the count and the newest read.
  const got = Object.values(feeds).filter(f => f.list), loading = Object.values(feeds).some(f => !f.list && !f.error);
  statusEl.textContent = got.length
    ? `${num(vessels().length)} live vessels${liveInView() ? '' : ', none in this view'}, read ${ago(Math.max(...got.map(f => f.read)))}.${loading ? ' Loading the other feed…' : ''}`
    : loading ? 'Loading live vessels…' : '';
  const bad = Object.values(feeds).filter(f => f.error);
  const text = bad.length
    ? `${bad.map(f => `${f.name} did not answer (${f.error})`).join('; ')}. Trying again every minute${feeds.kv?.error && !kvInView() ? ' (Kystverket every 5 minutes while its area is out of view)' : ''}${bad.some(f => f.list) ? '; the last positions are shown with their age' : ''}. The density map is not affected.`
    : '';
  if (alertEl.textContent !== text) { alertEl.textContent = text; say(text); }
}

// ---------- density raster ----------

const W = 7200, H = 3600;
const images = {};
let densityFailed = false, gen = 0;
function image(name) {
  // Decoded off the main thread (an <img> of the 7200 by 3600 image blocks it for about 110 ms on first draw);
  // no colour conversion, so each pixel keeps its exact class.
  return images[name] ||= fetch(new URL(name, DATA)).then(r => { if (!r.ok) throw new Error(`maritime ${name}`); return r.blob(); })
    .then(b => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })).then(img => {
    if (densityFailed) { densityFailed = false; gen++; lastApi?.refresh(); } // the engine never re-asks a failed tile: new ids
    return img;
  }, e => { images[name] = null; if (!densityFailed) { densityFailed = true; lastApi?.refresh(); } throw e; });
}
// Class -> RGBA, per theme.
const luts = {};
function lut(dark) {
  return luts[dark] ||= Array.from({ length: 256 }, (_, i) => [...INK[dark ? 'dark' : 'light'], Math.round(255 * (ALPHA[Math.min(i, ALPHA.length - 1)] ?? 0))]);
}
// geo tiles cut from one of the two images: overview.webp (0.25°) up to level 2, density.webp (0.05°) beyond; smoothed
// when shrunk, sharp when enlarged so cells stay square.
const sources = new Map();
function densitySrc(dark) {
  const id = `maritime-${dark ? 'dark' : 'light'}-${gen}`;
  if (!sources.has(id)) sources.set(id, {
    id, scheme: 'geo', tileSize: 256, maxZoom: 6, url: (z, x, y) => `${id}/${z}/${x}/${y}`,
    async load(url, t) {
      const small = t.z <= 2, img = await image(small ? 'overview.webp' : 'density.webp'), s = (small ? H / 5 : H) / 2 ** t.z;
      await new Promise(r => setTimeout(r)); // tiles waiting on the same image are cut in separate tasks, not one long one
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingEnabled = s > 256;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, t.x * s, t.y * s, s, s, 0, 0, 256, 256);
      const d = g.getImageData(0, 0, 256, 256), px = d.data, L = lut(dark);
      for (let i = 0; i < px.length; i += 4) { const v = L[px[i]]; px[i] = v[0]; px[i + 1] = v[1]; px[i + 2] = v[2]; px[i + 3] = v[3]; }
      g.putImageData(d, 0, 0);
      return c;
    }
  });
  return sources.get(id);
}
let probe = null;
async function densityAt([lon, lat]) {
  const img = await image('density.webp');
  probe ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  probe.canvas.width = probe.canvas.height = 1;
  const x = Math.min(W - 1, Math.floor((lon + 180) / 360 * W)), y = Math.min(H - 1, Math.floor((90 - lat) / 180 * H));
  probe.clearRect(0, 0, 1, 1);
  probe.drawImage(img, x, y, 1, 1, 0, 0, 1, 1);
  return probe.getImageData(0, 0, 1, 1).data[0];
}
const big = v => (v >= 1e6 ? `${v / 1e6} million` : num(v));
const classText = k => (k === 1 ? `under ${big(BOUNDS[0])}` : k > BOUNDS.length ? `${big(BOUNDS[BOUNDS.length - 1])} and over`
  : `${big(BOUNDS[k - 2])} to ${big(BOUNDS[k - 1])}`);

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

// Hull length in CSS pixels: 5 at the whole globe, up to 15 zoomed in.
const hullSize = k => Math.round(Math.min(15, 5 + Math.log2(Math.max(1, k)) * 1.2));
// A hull in a 24-unit box, bow up.
const HULL = 'M0-11L4.5-3.5V10H-4.5V-3.5Z';
const hullPath = new Path2D(HULL);
const STEP = 10; // a sprite per 10° of course
// Outline: faint on small glyphs, so thousands of them at the whole-globe view keep their colours.
const stroke = (dark, a = 0.9) => (dark ? `rgba(236,240,244,${a})` : `rgba(20,26,32,${a})`);

const sprites = new Map();
function sprite(g, deg, size, dark, dpr) {
  const q = deg == null ? -1 : ((Math.round(deg / STEP) % 36) + 36) % 36, key = `${g}|${q}|${size}|${dark}|${dpr}`;
  let c = sprites.get(key);
  if (!c) {
    if (sprites.size > 3000) sprites.clear();
    const side = Math.ceil(size + 4);
    c = document.createElement('canvas');
    c.width = c.height = Math.ceil(side * dpr);
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, side * dpr / 2, side * dpr / 2);
    x.fillStyle = GROUPS[g].c; x.strokeStyle = stroke(dark, size < 9 ? 0.4 : 0.9); x.lineJoin = 'round';
    if (q < 0) {
      x.beginPath(); x.arc(0, 0, Math.max(1.6, size * 0.2), 0, 2 * Math.PI); x.lineWidth = size < 9 ? 0.6 : 1; x.fill(); x.stroke();
    } else {
      x.rotate(q * STEP * D2R); x.scale(size / 24, size / 24); x.lineWidth = (size < 9 ? 0.6 : 1) * 24 / size;
      x.fill(hullPath); x.stroke(hullPath);
    }
    c.size = side; c.half = side / 2;
    sprites.set(key, c);
  }
  return c;
}

// A grid of placed boxes, so names neither overlap each other nor cover vessels.
function boxes(cell = 48) {
  const cells = new Map();
  const keys = b => { const out = []; for (let i = Math.floor(b[0] / cell); i <= Math.floor(b[2] / cell); i++) for (let j = Math.floor(b[1] / cell); j <= Math.floor(b[3] / cell); j++) out.push(i * 1e5 + j); return out; };
  return {
    hit: b => keys(b).some(k => (cells.get(k) || []).some(o => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1])),
    add: b => keys(b).forEach(k => (cells.get(k) || cells.set(k, []).get(k)).push(b))
  };
}
const LABEL_FONT = `italic 600 12px ${MAP_FONT}`;
const widths = new Map();

let drawn = [];
function draw(api) {
  lastApi = api;
  drawn = [];
  const { ctx, w, h, dark, dpr, C } = api;
  // The areas the live feeds cover, dashed as on Flights: outside them the sea shows density only.
  api.proj.clipExtent([[-8, -8], [w + 8, h + 8]]);
  ctx.beginPath(); api.path({ type: 'MultiLineString', coordinates: KV_ON ? [DT_AREA, KV_AREA] : [DT_AREA] });
  api.proj.clipExtent(null);
  ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.strokeStyle = C.muted; ctx.stroke(); ctx.setLineDash([]);
  if (!api.moving && (state() !== lastState || cornerCredit() !== lastCorner)) setTimeout(show); // the view left or reached a live area, or OpenStreetMap: the key and corner follow
  const list = vessels();
  if (!list.length) return;
  const at = projector(api), size = hullSize(api.k), m = size;
  const quick = api.moving && list.length > 1500, squares = quick && GROUPS.map(() => new Path2D());
  // Small glyphs: one dot and one hull per screen pixel; thousands stack up in ports at the whole-globe view.
  const taken = size <= 6 && new Set();
  for (const v of list) {
    const p = at(v.lon, v.lat);
    if (!p || p[0] < -m || p[1] < -m || p[0] > w + m || p[1] > h + m) continue;
    drawn.push([v, p[0], p[1]]);
    if (quick) { const r = size * 0.22; squares[v.g].rect(p[0] - r, p[1] - r, 2 * r, 2 * r); continue; }
    if (taken) { const key = ((p[0] + m) | 0) * 32768 + ((p[1] + m) | 0) * 2 + (v.dir != null); if (taken.has(key)) continue; taken.add(key); }
    let deg = v.dir;
    if (v.dir != null && size > 6) { // a 5 or 6 px hull's turn near the limb cannot be seen: skip the second projection
      // North turns across an orthographic globe: the course on screen comes from a point a little ahead.
      const r = v.dir * D2R, q = at(v.lon + 0.01 * Math.sin(r) / Math.max(0.01, Math.cos(v.lat * D2R)), v.lat + 0.01 * Math.cos(r));
      deg = q ? Math.atan2(q[0] - p[0], p[1] - q[1]) / D2R : v.dir;
    }
    const s = sprite(v.g, deg, size, dark, dpr);
    ctx.drawImage(s, p[0] - s.half, p[1] - s.half, s.size, s.size);
  }
  if (quick) { GROUPS.forEach((g, i) => { ctx.fillStyle = g.c; ctx.fill(squares[i]); }); return; }
  if (api.moving || api.k < LABEL_K) return;

  // Names: longest ships first, then nearest the centre; none over another name or vessel; at most 150.
  const [cx, cy] = api.proj.translate(), half = size / 2, g = boxes();
  if (drawn.length < 4000) for (const d of drawn) g.add([d[1] - half, d[2] - half, d[1] + half, d[2] + half]);
  const cands = drawn.filter(d => d[0].name).sort((p, q) => (q[0].len || 0) - (p[0].len || 0) || Math.hypot(p[1] - cx, p[2] - cy) - Math.hypot(q[1] - cx, q[2] - cy));
  ctx.font = LABEL_FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
  let n = 0;
  for (const [v, x, y] of cands) {
    if (n >= 150) break;
    let tw = widths.get(v.name);
    if (tw == null) { tw = ctx.measureText(v.name).width; if (widths.size > 5000) widths.clear(); widths.set(v.name, tw); }
    const right = [x + half + 3, y - 7, x + half + 5 + tw, y + 7], left = [x - half - 5 - tw, y - 7, x - half - 3, y + 7];
    const b = !g.hit(right) ? right : !g.hit(left) ? left : null;
    if (!b) continue;
    g.add(b); n++;
    ctx.lineWidth = 3; ctx.strokeStyle = C.halo; ctx.strokeText(v.name, b[0] + 1, y);
    ctx.fillStyle = C.text; ctx.fillText(v.name, b[0] + 1, y);
  }
}

// ---------- reading ----------

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const deg = d => `${Math.round(d) % 360}° (${COMPASS[Math.round(d / 22.5) % 16]})`;

const feats = new Map();
function feature(v, esc) {
  const key = `${v.mmsi}|${v.t}|${v.src}|${Math.floor(Date.now() / 30e3)}`;
  let f = feats.get(v.mmsi);
  if (f?.key === key) return f;
  const [flag, kind] = flagOf(v.mmsi), group = GROUPS[v.g].label;
  const rows = [
    ['MMSI', `${v.mmsi}${kind ? `, the number of ${kind}` : ''}`],
    ['IMO number', v.imo >= 1000000 && v.imo <= 9999999 ? String(v.imo) : 'Not broadcast'],
    ['Call sign', v.call ? esc(v.call) : 'Not broadcast'],
    ['Ship type', esc(typeText(v.type))],
    ['Flag', flag ? `${esc(flag)}, from the MMSI's first three digits (the country that issued it, usually the flag state)` : 'Not identifiable from the MMSI'],
    ['Speed', v.sog == null || v.sog >= 102.3 ? 'Not reported'
      : `${v.sog >= 102.2 ? '102.2 kn or more over the ground (the highest AIS can report)' : `${v.sog.toFixed(1)} kn (${(v.sog * NM_KM).toFixed(1)} km/h) over the ground`}${
        v.sog > 50 && !(v.type >= 40 && v.type < 50) ? '; not plausible for this ship, so the position is probably false (GNSS jamming or spoofing)' : ''}`],
    ['Course', v.cog == null || v.cog >= 360 ? 'Not reported' : `${deg(v.cog)} over the ground`],
    ['Heading', v.hdg == null || v.hdg >= 360 ? 'Not reported' : `${deg(v.hdg)}, where the bow points`],
    ['Status', `${esc(NAV[v.nav] ?? 'Not reported')}, as set by the crew`],
    ['Destination', v.dest ? `${esc(v.dest)}, as typed by the crew` : 'Not given'],
    ['ETA', v.eta ? `${day(v.eta)}, ${hm(v.eta)} UTC, the crew's estimate` : v.src === 'kv' ? 'Not in this feed' : 'Not given']
  ];
  if (v.len) rows.push(['Size', `${num(v.len)} m long${v.beam ? `, ${num(v.beam)} m wide` : ''}, as broadcast over AIS`]);
  if (v.draught) rows.push(['Draught', `${v.draught.toFixed(1)} m, as entered by the crew`]);
  rows.push(
    ['Position', `Reported ${day(v.t)}, ${hm(v.t)} UTC, ${ago(v.t).replace(' ago', '')} before you clicked. This panel does not update: click the ship again for its latest position`],
    ...(v.cls ? [['AIS class', `${esc(v.cls)}${v.cls === 'B' ? ' (small-craft transponder)' : ''}`]] : []),
    ['More', `<a href="https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}" target="_blank" rel="noopener">MarineTraffic</a> (commercial site, a few details free)`]
  );
  f = { key, title: v.name || `MMSI ${v.mmsi}`, sub: [group, flag && `${flag} flag`].filter(Boolean).join(', '), at: [v.lon, v.lat], rows };
  feats.set(v.mmsi, f);
  if (feats.size > 500) feats.delete(feats.keys().next().value);
  return f;
}

function km(a, b) {
  const s1 = Math.sin((b[1] - a[1]) * D2R / 2), s2 = Math.sin((b[0] - a[0]) * D2R / 2);
  return 12742 * Math.asin(Math.min(1, Math.sqrt(s1 * s1 + Math.cos(a[1] * D2R) * Math.cos(b[1] * D2R) * s2 * s2)));
}

async function query(at, api) {
  const rows = [];
  try {
    const k = await densityAt(at);
    const cell = `0.05° cell, ${(5.57 * Math.cos(at[1] * D2R)).toFixed(1)} by 5.6 km`;
    // The receiver caveat ("compare nearby waters only") is in the key.
    rows.push(['Shipping density', k
      ? `${classText(k)} AIS reports per km² a year, 2015–2021 (${cell})`
      : `No AIS reports, 2015–2021 (${cell})`]);
  } catch {
    rows.push(['Shipping density', 'The density map did not load. Try again in a moment.']);
  }
  const list = vessels();
  let best = null, bd = 500, self = false; // km
  for (const v of list) { const d = km(at, [v.lon, v.lat]); if (d <= 0.05) self = true; else if (d < bd) { bd = d; best = v; } }
  const none = Object.values(feeds).every(f => !f.list)
    ? (Object.values(feeds).some(f => f.error) ? 'The live feeds did not answer.' : 'Live vessels are still loading.')
    : 'Not available here: the map shows density only.';
  const where = KV_ON ? 'Live positions cover only the dashed areas, Finnish and northern Baltic waters and the Norwegian coast'
    : 'Live positions cover only the dashed area, Finnish and northern Baltic waters';
  rows.push([self ? 'Nearest other live vessel' : 'Nearest live vessel', best
    ? `${api.esc(best.name || `MMSI ${best.mmsi}`)} (${GROUPS[best.g].label.toLowerCase()}), ${bd < 10 ? bd.toFixed(1) : num(bd)} km away, ${api.esc(NAV[best.nav] ?? 'status not reported').toLowerCase()}, reported ${ago(best.t)}. ${where}`
    : `${none} ${where}`]);
  return rows;
}

const icon = (fill, dot, dark) => `<svg width="18" height="18" viewBox="-12 -12 24 24" aria-hidden="true" style="flex:none">${dot
  ? `<circle r="4.5" fill="${fill}" stroke="${stroke(dark)}" stroke-width="1.2"/>`
  : `<path d="${HULL}" fill="${fill}" stroke="${stroke(dark)}" stroke-width="1.2" stroke-linejoin="round" transform="rotate(45)"/>`}</svg>`;
function legend() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const sea = getComputedStyle(document.documentElement).getPropertyValue('--ocean').trim() || (dark ? '#121a21' : '#d3e0e9');
  const [r, g, b] = INK[dark ? 'dark' : 'light'];
  const swatch = i => `color-mix(in srgb, rgb(${r} ${g} ${b}) ${Math.round(ALPHA[i] * 100)}%, ${sea})`;
  const row = (i, text) => `<li><i style="--c:${swatch(i)}"></i>${text}</li>`;
  const steps = [...ALPHA.keys()].slice(4).reverse().map(i => row(i, classText(i)[0].toUpperCase() + classText(i).slice(1))).join('')
    + row(3, `Under ${big(BOUNDS[2])}`);
  const failed = densityFailed ? '<p class="note keep">The density map did not load. Move the globe to try again.</p>' : '';
  const outside = liveInView() ? '' : `<p class="note keep">No live ships in this view. Live positions cover only the dashed area${KV_ON ? 's' : ''}; here the map shows density from 2015 to 2021.</p>`;
  return `${outside}<p>Live vessels by ship type</p>
    <ul class="swatches">${GROUPS.map(gr => `<li>${icon(gr.c, false, dark)}${gr.label}</li>`).join('')}
      <li>${icon(GROUPS[5].c, true, dark)}Anchored, moored or no direction</li>
      <li><svg width="18" height="18" viewBox="-12 -12 24 24" aria-hidden="true" style="flex:none"><circle r="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 3"/></svg>Area with live positions (approximate)</li></ul>
    <p>Shipping density, AIS position reports per km² a year</p>
    <ul class="swatches ord">${steps}</ul>${failed}`;
}

export default {
  id: 'maritime', name: 'Shipping', group: 'Live traffic', live: true,
  // Digitraffic's required wording ("Source: …, license CC 4.0 BY") is kept whole inside the brackets.
  credit: 'Live vessels (Source: <a href="https://www.digitraffic.fi/en/marine-traffic/">Fintraffic / digitraffic.fi</a>, license <a href="https://creativecommons.org/licenses/by/4.0/">CC 4.0 BY</a>; older than 1 hour left out); ' +
    (KV_ON ? 'contains data under the Norwegian licence for Open Government data (<a href="https://data.norge.no/nlod/en/1.0">NLOD</a>) distributed by <a href="https://kystdatahuset.kystverket.no/">Kystverket</a>. ' : '') +
    'Density: IMF and <a href="https://datacatalog.worldbank.org/search/dataset/0037580">World Bank</a> (<a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>), summed to 0.05°. ' +
    '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; <a href="https://www.naturalearthdata.com/">Natural Earth</a>',
  get onMap() { return cornerCredit(); },

  layers({ k, dark }) {
    const src = densitySrc(dark), osm = fade(k, 30, 80) * (dark ? 0.7 : 1); // dimmer in the dark theme, as on Flights
    // The app fills the countries to 1 minus the bottom layer's opacity. Until OpenStreetMap is past 0.15 the bottom
    // layer is the density at 0.15, so the land fill is 0.85: lanes on lakes and rivers inside country shapes show
    // faintly, and dry land (no density there) takes only a slight even tint of the sea.
    return [...(osm < LAND_SHOW ? [{ src, opacity: LAND_SHOW }] : []), { src: OSM, opacity: osm }, { src, opacity: 1 - 0.75 * osm }];
  },
  vector: 'full', click: 'point', query, legend, state,

  setup(api) {
    lastApi = api;
    api.tools.innerHTML = '<p class="note" style="margin:0 0 12px"><span id="shipStatus"></span> <span id="shipAlert"></span></p>';
    statusEl = api.tools.querySelector('#shipStatus');
    alertEl = api.tools.querySelector('#shipAlert');
    for (const f of Object.values(feeds)) if (f.error) f.done = 0; // choosing the map again retries at once
    lastState = state(); lastCorner = cornerCredit(); // the app draws the key and corner after setup
    clearInterval(timer);
    timer = setInterval(tick, 5e3);
    tick();
  },

  overlay: {
    load: () => {},
    draw,
    pick(x, y, api) {
      let best = null, bd = Math.max(hullSize(api.k) * 0.6, COARSE ? 16 : 7);
      for (const d of drawn) { const dd = Math.hypot(d[1] - x, d[2] - y); if (dd <= bd) { bd = dd; best = d; } } // later (on top) wins ties
      return best && feature(best[0], api.esc);
    }
  }
};

// Self-checks: an ETA of 11 Nov 09:00 as Digitraffic packs it, flags from MMSIs, type groups and density classes.
{
  const e = new Date(etaOf((11 << 16) | (11 << 11) | (9 << 6)));
  console.assert(e.getUTCMonth() === 10 && e.getUTCDate() === 11 && e.getUTCHours() === 9, 'eta');
  console.assert(etaOf(1596) === null && flagOf(230123456)[0] === 'Finland' && flagOf(992301234)[1].startsWith('an aid'), 'mmsi');
  console.assert(groupOf(70) === 0 && groupOf(84) === 1 && groupOf(41) === 2 && groupOf(30) === 3 && groupOf(52) === 4 && groupOf(35) === 5 && groupOf(0) === 5, 'groups');
  console.assert(classText(1) === 'under 1' && classText(10) === '30 million and over' && classText(5) === '100,000 to 300,000' && ALPHA.length === BOUNDS.length + 2, 'classes');
}

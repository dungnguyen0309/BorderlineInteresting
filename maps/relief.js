// Elevation and depth, coloured in the browser from open elevation tiles (Terrarium PNGs on AWS: land from
// SRTM and other surveys, sea floor from ETOPO1 and GEBCO). Each pixel holds a height in metres, so the
// same tiles give the colours, the hillshade and the exact figure at a clicked point.
// Tiles are fetched and coloured in a worker (shading-worker.js); without workers, on the main thread.

import { tileAt } from './engine.js';
import { PALETTES, metres, shadeTile } from './shading.js';

export { PALETTES };
export const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
// The sea floor is only right to zoom 10 (about 150 m pixels): finer tiles hold 0 or stray values offshore.
export const TERRAIN_MAX_ZOOM = 10;

let worker = null, nextId = 0;
const waiting = new Map();
try {
  worker = new Worker(new URL('./shading-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    waiting.delete(data.id);
    if (w) (data.error ? w.fail(new Error(data.error)) : w.ok(data.bitmap));
  };
  worker.onerror = () => { worker = null; for (const w of waiting.values()) w.fail(new Error('worker')); waiting.clear(); };
} catch { worker = null; }

function onMainThread(url, z, y, palette) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, 256, 256);
      shadeTile(data.data, z, y, palette);
      g.putImageData(data, 0, 0);
      ok(c);
    };
    img.onerror = () => fail(new Error('elevation tile'));
    img.src = url;
  });
}

// A tile source coloured with one palette (see shading.js).
export function terrainSource(palette) {
  return {
    id: `terrain-${palette}`, url: TERRARIUM, maxZoom: TERRAIN_MAX_ZOOM,
    load(url, t) {
      if (!worker) return onMainThread(url, t.z, t.y, palette);
      const id = nextId++;
      return new Promise((ok, fail) => {
        waiting.set(id, { ok, fail });
        worker.postMessage({ id, url, z: t.z, y: t.y, palette });
      }).catch(() => onMainThread(url, t.z, t.y, palette));
    }
  };
}

// Height or depth at a point, in metres: the sea from zoom-10 tiles (where depths are reliable), land from
// zoom-13 tiles (about 15 m pixels at the equator), unless those disagree badly (bad offshore data).
export async function elevationAt(lon, lat) {
  const coarse = await sample(lon, lat, 10);
  if (coarse < -5) return coarse;
  const fine = await sample(lon, lat, 13).catch(() => coarse);
  return fine < -50 || Math.abs(fine - coarse) > 2500 ? coarse : fine;
}
const pointTiles = new Map();
async function sample(lon, lat, z) {
  const t = tileAt('xyz', z, lon, lat);
  const key = `${z}/${t.x}/${t.y}`;
  if (!pointTiles.has(key)) {
    pointTiles.set(key, new Promise((ok, fail) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 256;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        ok(g.getImageData(0, 0, 256, 256).data);
      };
      img.onerror = () => { pointTiles.delete(key); fail(new Error('elevation tile')); };
      img.src = TERRARIUM.replace('{z}', z).replace('{x}', t.x).replace('{y}', t.y);
    }));
    if (pointTiles.size > 40) pointTiles.delete(pointTiles.keys().next().value);
  }
  const d = await pointTiles.get(key), p = (t.py * 256 + t.px) * 4;
  return Math.round(metres(d[p], d[p + 1], d[p + 2]));
}

// A key for the legend: the palette's stops as swatches with their heights.
export function reliefLegend(palette, { from = -6000, to = 5000 } = {}) {
  const stops = PALETTES[palette].filter(([m]) => m >= from && m <= to);
  const fmt = m => (m < 0 ? `${(-m).toLocaleString('en')} m deep` : m === 0 ? 'Sea level' : `${m.toLocaleString('en')} m`);
  return `<ul class="swatches relief">${stops.slice().reverse().map(([m, c]) => `<li><i style="--c:${c}"></i>${fmt(m)}</li>`).join('')}</ul>`;
}

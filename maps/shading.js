// Shared by the page and the shading worker: elevation palettes and the hillshade for one Terrarium tile.

// Colour stops: [metres, '#rrggbb'], lowest first.
export const PALETTES = {
  // Hypsometric tints as on printed atlases; the sea in pale blues so the land reads first.
  topo: [
    [-11000, '#5d93c2'], [-6000, '#79abd6'], [-3000, '#94c2e6'], [-1000, '#aed4f0'], [-200, '#c4e2f6'], [-1, '#d6ecfa'],
    [0, '#93bf87'], [100, '#a9cc94'], [300, '#c3d6a0'], [600, '#dbdfab'], [1000, '#e8dcac'], [1500, '#ddc796'],
    [2000, '#cfae7f'], [3000, '#b98d66'], [4000, '#a8826c'], [5000, '#c9c0bb'], [6500, '#ffffff']
  ],
  // Depth first: strong blues stepped every 1,000 m below 200 m; land in quiet greys.
  bathy: [
    [-11000, '#06214a'], [-8000, '#0b2f63'], [-6000, '#123f7c'], [-5000, '#1a5090'], [-4000, '#2463a3'], [-3000, '#3277b4'],
    [-2000, '#448cc3'], [-1000, '#5ea3d1'], [-200, '#86c0e1'], [-50, '#a9d5ec'], [-1, '#c8e6f4'],
    [0, '#e4e2dc'], [2000, '#d6d3cb'], [6500, '#f4f3ef']
  ],
  // Land in natural greens and browns, as a physical wall map.
  physical: [
    [-11000, '#1f4f8c'], [-4000, '#2f6aa8'], [-1000, '#4c8cc4'], [-200, '#77b0d8'], [-1, '#9ccbe6'],
    [0, '#6f9e5b'], [200, '#88ad62'], [500, '#a9b56c'], [1000, '#c2b479'], [1800, '#b5976a'], [2800, '#9a7a5f'],
    [4000, '#8a7266'], [5200, '#d8d2cd'], [6500, '#ffffff']
  ]
};

export const metres = (r, g, b) => r * 256 + g + b / 256 - 32768;

// 1-metre lookup tables per palette, -11,000 to 6,500 m. Sea and land do not blend across the shoreline.
const tables = {};
function table(name) {
  if (tables[name]) return tables[name];
  const stops = PALETTES[name].map(([m, hex]) => [m, parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
  const lut = new Uint8Array(17501 * 3);
  for (let m = -11000, k = 0; m <= 6500; m++) {
    let i = stops.findIndex(s => s[0] >= m);
    if (i < 0) i = stops.length - 1;
    const b = stops[i], a = stops[Math.max(0, i - 1)];
    const t = b[0] === a[0] || (a[0] < 0) !== (b[0] < 0) ? 1 : (m - a[0]) / (b[0] - a[0]);
    for (let c = 1; c <= 3; c++) lut[k++] = Math.round(a[c] + (b[c] - a[c]) * t);
  }
  return (tables[name] = lut);
}

// Colours a 256 x 256 Terrarium tile in place: tinted by height, shaded with light from the north-west.
// Relief is exaggerated when zoomed out, or mountains would vanish.
export function shadeTile(d, z, y, palette) {
  const lut = table(palette);
  const h = new Float32Array(256 * 256);
  for (let i = 0, p = 0; i < h.length; i++, p += 4) h[i] = metres(d[p], d[p + 1], d[p + 2]);
  const n = 2 ** z;
  const exag = z < 4 ? 14 : z < 7 ? 8 : z < 10 ? 3 : 1.5;
  for (let row = 0; row < 256; row++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + (row + 0.5) / 256) / n)));
    const mpp = 40075016.7 * Math.cos(lat) / (256 * n);
    for (let x = 0; x < 256; x++) {
      const i = row * 256 + x;
      const e = h[i];
      const l = h[row * 256 + Math.max(0, x - 1)], r = h[row * 256 + Math.min(255, x + 1)];
      const u = h[Math.max(0, row - 1) * 256 + x], dn = h[Math.min(255, row + 1) * 256 + x];
      const dzdx = (r - l) / (2 * mpp) * exag, dzdy = (dn - u) / (2 * mpp) * exag;
      // Lambert shading: surface normal against a light from the north-west, 45 degrees up.
      const nz = 1 / Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
      const lit = Math.max(0, Math.min(1.2, (0.5 * dzdx + 0.5 * dzdy + 0.7071) * nz / 0.7071));
      const k = e < 0 ? 0.55 + 0.45 * lit : 0.35 + 0.65 * lit;
      const m = (Math.max(-11000, Math.min(6500, Math.round(e))) + 11000) * 3;
      const p = i * 4;
      d[p] = Math.min(255, lut[m] * k);
      d[p + 1] = Math.min(255, lut[m + 1] * k);
      d[p + 2] = Math.min(255, lut[m + 2] * k);
      d[p + 3] = 255;
    }
  }
  return d;
}

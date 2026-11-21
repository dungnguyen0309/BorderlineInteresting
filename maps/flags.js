// Flags laid over country shapes. Images: flag-icons (MIT), 4:3 SVGs from jsDelivr.
const URL = a2 => `https://cdn.jsdelivr.net/npm/flag-icons@7.5.0/flags/4x3/${a2}.svg`;
const images = new Map(); // a2 -> Image (null once it has failed)

function image(a2, onLoad) {
  if (!images.has(a2)) {
    const img = new Image();
    img.decoding = 'async';
    img.onload = onLoad;
    img.onerror = () => images.set(a2, null);
    img.src = URL(a2);
    images.set(a2, img);
  }
  const img = images.get(a2);
  return img?.complete && img.naturalWidth ? img : null;
}

// While the globe moves a flag up to 1024 pixels wide is drawn from a bitmap of the next power-of-two width, so the SVG
// is not rasterised afresh at every size. The bitmaps go when the globe stops; at rest the SVG itself is drawn.
const bitmaps = new Map(); // a2 -> canvas
function bitmap(a2, img, w) {
  const W = 2 ** Math.ceil(Math.log2(Math.max(16, w)));
  let c = bitmaps.get(a2);
  if (!c || c.width !== W) {
    c = document.createElement('canvas');
    c.width = W; c.height = Math.round(W * img.naturalHeight / img.naturalWidth);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    bitmaps.set(a2, c);
  }
  return c;
}

// Each flag fills the bounding box of the country's main body ("cover", centred), clipped to the whole country,
// so a country's outlying islands show the part of the flag that falls over them.
// items: [{ shape, core, a2 }]; bounds(core) gives the screen box, clip(shape) clips the context to the shape.
export function drawFlags(ctx, items, bounds, clip, onLoad, moving) {
  if (!moving) bitmaps.clear();
  const px = ctx.getTransform().a; // device pixels per CSS pixel
  for (const { shape, core, a2 } of items) {
    const img = a2 && image(a2, onLoad);
    if (!img) continue;
    const [[x0, y0], [x1, y1]] = bounds(core);
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 1 && h > 1)) continue;
    const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s;
    ctx.save();
    clip(shape);
    const src = moving && dw * px <= 1024 ? bitmap(a2, img, dw * px) : img;
    ctx.drawImage(src, x0 + (w - dw) / 2, y0 + (h - dh) / 2, dw, dh);
    ctx.restore();
  }
}

export const flagsMissing = items => items.filter(i => i.a2 && images.get(i.a2) === null).length;

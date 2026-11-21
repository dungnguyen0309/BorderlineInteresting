// The lettering on every map, in the manner of a printed desk globe: EB Garamond (loaded from Google Fonts in
// index.html), country names in spaced capitals, water in italics. The panels and controls use Plus Jakarta Sans.
export const MAP_FONT = '"EB Garamond", Garamond, "Times New Roman", serif';
// The faces the maps use, loaded before the first draw (a canvas does not load a web font by itself).
export const MAP_FACES = ['500 12px', '600 12px', 'italic 500 12px', 'italic 600 12px'].map(f => `${f} ${MAP_FONT}`);
// Letter spacing for names set in capitals, as a share of the font size.
export const CAPS_TRACKING = 0.12;

// Text widths, measured once per font, spacing and text: measureText is slow, and the globe letters the same names
// every frame. A web font arriving changes the widths, so the cache starts again.
const widths = new Map();
document.fonts?.addEventListener('loadingdone', () => widths.clear());
export function textWidth(ctx, font, spacing, text) {
  const key = `${font}|${spacing}|${text}`;
  let w = widths.get(key);
  if (w === undefined) {
    ctx.font = font; ctx.letterSpacing = `${spacing}px`;
    w = ctx.measureText(text).width;
    if (widths.size > 5000) widths.clear();
    widths.set(key, w);
  }
  return w;
}

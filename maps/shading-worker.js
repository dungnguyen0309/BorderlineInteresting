// Fetches and colours elevation tiles off the main thread, so the globe keeps turning smoothly while they load.
import { shadeTile } from './shading.js';

const canvas = new OffscreenCanvas(256, 256);
const g = canvas.getContext('2d', { willReadFrequently: true });

self.onmessage = async ({ data: { id, url, z, y, palette } }) => {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob());
    g.clearRect(0, 0, 256, 256);
    g.drawImage(bmp, 0, 0, 256, 256);
    bmp.close();
    const img = g.getImageData(0, 0, 256, 256);
    shadeTile(img.data, z, y, palette);
    g.putImageData(img, 0, 0);
    const out = canvas.transferToImageBitmap();
    self.postMessage({ id, bitmap: out }, [out]);
  } catch (e) {
    self.postMessage({ id, error: String(e) });
  }
};

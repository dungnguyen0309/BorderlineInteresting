"""Build data/maps/hardiness/: plant hardiness zones from ERA5 TNn 1991-2020 (World Bank CCKP, CC BY 4.0).

Run: python scripts/build_hardiness.py
Needs numpy, scipy (netCDF3 reader) and Pillow. Downloads two files once into the system temp folder:
the CCKP climatology (4 MB) and Natural Earth 1:50m land from world-atlas (for the coast mask).
Writes:
  zones.png  5760 x 2880 RGBA, lon -180..180, lat 90..-90, 4 pixels per 0.25 degree cell, sea transparent
  tnn.png    1440 x 721 RGB, one pixel per cell centre (row 0 = 90 N, column 0 = 180 W):
             R * 256 + G = round(TNn in degrees C * 10) + 1000, 0 = no data
The zone colours are read from maps/types/hardiness.js, so the image and the legend cannot drift apart.
"""
import json
import pathlib
import re
import tempfile
import urllib.request

import numpy as np
from PIL import Image, ImageDraw
from scipy.io import netcdf_file

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "hardiness"
CACHE = pathlib.Path(tempfile.gettempdir()) / "hinterland-build"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
TNN_URL = ("https://wbg-cckp.s3.amazonaws.com/data/era5-x0.25/tnn/era5-x0.25-historical/"
           "climatology-tnn-annual-mean_era5-x0.25_era5-x0.25-historical_climatology_mean_1991-2020.nc")
LAND_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json"
COLS, ROWS, PX = 1440, 721, 4
W, H = COLS * PX, (ROWS - 1) * PX
SUPER = 2  # coast mask drawn at twice the size, then averaged, for a smooth edge


def fetch(url):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        print("downloading", url)
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
            path.write_bytes(r.read())
    return path


def palette():
    js = (ROOT / "maps" / "types" / "hardiness.js").read_text(encoding="utf-8")
    body = re.search(r"const PALETTE = \[(.*?)\];", js, re.S).group(1)
    cols = re.findall(r"#([0-9a-f]{6})", body)
    assert len(cols) == 28, len(cols)
    return np.array([[int(c[i:i + 2], 16) for i in (0, 2, 4)] for c in cols], dtype=np.uint8)


def read_tnn():
    with netcdf_file(fetch(TNN_URL), "r", mmap=False) as nc:
        var = nc.variables["climatology-tnn-annual-mean"]
        t = np.array(var.data[0], dtype=np.float64)
        fill = getattr(var, "_FillValue", None)
        lat, lon = np.array(nc.variables["lat"].data), np.array(nc.variables["lon"].data)
    if fill is not None:
        t[t == fill] = np.nan
    t[np.abs(t) > 200] = np.nan
    assert t.shape == (ROWS, COLS) and abs(lon[0] + 180) < 1e-6 and abs(lon[1] - lon[0] - 0.25) < 1e-6, (t.shape, lon[:2])
    if lat[0] < lat[-1]:
        t = t[::-1]  # north up
    return t


def classes(tenths):
    """Zone class per cell from the stored tenths, exactly as the browser computes it (see classOf in hardiness.js)."""
    c = (tenths - 1000) / 10
    k = np.floor((c * 9 / 5 + 32 + 60) / 5) + 1
    return np.clip(k, 0, 27).astype(np.uint8)


def land_mask():
    topo = json.loads(fetch(LAND_URL).read_text(encoding="utf-8"))
    (sx, sy), (tx, ty) = topo["transform"]["scale"], topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        a = np.cumsum(np.array(arc, dtype=np.float64), axis=0)
        arcs.append(np.column_stack([a[:, 0] * sx + tx, a[:, 1] * sy + ty]))
    rings = []
    for g in topo["objects"]["land"]["geometries"]:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            for ring in poly:
                pts = [arcs[i] if i >= 0 else arcs[~i][::-1] for i in ring]
                rings.append(np.concatenate(pts))
    w, h = W * SUPER, H * SUPER
    mask = np.zeros((h, w), dtype=bool)
    for r in rings:
        if np.ptp(r[:, 1]) < 0.01:
            continue  # a zero-area sliver round the South Pole
        # world-atlas joins shapes across 180 degrees (Chukotka, Fiji): unwrap, then draw each copy that shows.
        r = np.column_stack([np.degrees(np.unwrap(np.radians(r[:, 0]))), r[:, 1]])
        # Antarctica runs the full 360 degrees: close it along the South Pole, not across the sea.
        if np.ptp(r[:, 0]) > 359:
            r = np.vstack([r, [[r[-1, 0], -90], [r[0, 0], -90]]])
        for shift in (-360, 0, 360):
            x = (r[:, 0] + shift + 180) / 360 * w
            y = (90 - r[:, 1]) / 180 * h
            x0, y0 = max(0, int(x.min())), max(0, int(y.min()))
            x1, y1 = min(w, int(np.ceil(x.max())) + 1), min(h, int(np.ceil(y.max())) + 1)
            if x1 <= x0 or y1 <= y0:
                continue
            img = Image.new("1", (x1 - x0, y1 - y0), 0)
            ImageDraw.Draw(img).polygon(list(zip(x - x0, y - y0)), fill=1)
            mask[y0:y1, x0:x1] ^= np.array(img, dtype=bool)  # even-odd: holes (the Caspian) cancel out
    return (mask.reshape(H, SUPER, W, SUPER).mean(axis=(1, 3)) * 255).round().astype(np.uint8)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    t = read_tnn()
    ok = ~np.isnan(t)
    tenths = np.where(ok, np.round(np.nan_to_num(t) * 10) + 1000, 0).astype(np.int32)
    assert tenths[ok].min() > 0 and tenths.max() < 65536

    rgb = np.zeros((ROWS, COLS, 3), dtype=np.uint8)
    rgb[..., 0], rgb[..., 1] = tenths >> 8, tenths & 255
    Image.fromarray(rgb, "RGB").save(OUT / "tnn.png", optimize=True)

    k = classes(tenths)
    # Pixel x covers lon -180 + x/16; cell c is centred on -180 + c/4, so its 4 pixels start at x = 4c - 2.
    col = ((np.arange(W) + PX // 2) // PX) % COLS
    row = np.minimum((np.arange(H) + PX // 2) // PX, ROWS - 1)
    kk, okk = k[row][:, col], ok[row][:, col]
    alpha = land_mask()
    rgba = np.zeros((H, W, 4), dtype=np.uint8)
    rgba[..., :3] = palette()[kk]
    rgba[..., 3] = np.where(okk, alpha, 0)
    Image.fromarray(rgba, "RGBA").save(OUT / "zones.png", optimize=True)

    # Spot checks against the research notes (Berlin 7b, Moscow 5a, Minneapolis 5a, London 9a).
    names = lambda v: "below 1a" if v == 0 else "above 13b" if v == 27 else f"{(v + 1) // 2}{'a' if v % 2 else 'b'}"
    for place, lon, lat, want in [("Berlin", 13.4, 52.52, "7b"), ("Moscow", 37.62, 55.75, "5a"),
                                  ("Minneapolis", -93.27, 44.98, "5a"), ("London", -0.13, 51.51, "9a")]:
        c, r = round((lon + 180) / 0.25) % COLS, round((90 - lat) / 0.25)
        got = names(k[r, c])
        print(f"{place}: {(tenths[r, c] - 1000) / 10} C -> {got}")
        assert got == want, (place, got, want)
    for f in ("zones.png", "tnn.png"):
        print(f, (OUT / f).stat().st_size, "bytes")


if __name__ == "__main__":
    main()

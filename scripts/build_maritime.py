"""Build data/maps/maritime/density.webp: where ships went from January 2015 to February 2021, from the IMF and
World Bank Global Shipping Traffic Density (all ship types, CC BY 4.0).

Run: python scripts/build_maritime.py
Needs numpy and Pillow. Downloads shipdensity_global.zip (535 MB) once into the system temp folder, then reads the
9.8 GB GeoTIFF inside it as a stream, without unpacking it to disk (a few minutes). The sums are kept in the same
folder, so a second run (new class limits) takes seconds.

The source counts AIS positions (the IMF's hourly positions, Jan 2015 to Feb 2021, moving and stationary ships) per
0.005 degree cell. This script adds them up per 0.05 degree cell and divides by the area of sea the source covers in
that cell and by the 74 months, giving positions per km2 per year. Each cell's class (0 = none recorded, 1 to N =
the limits in BOUNDS in maps/types/maritime.js, so the image and the legend cannot drift apart) is written as one
grey pixel in a lossless WebP (a third the size of a PNG of it): density.webp 7200 x 3600, lon -180..180,
lat 90..-90 (the source stops at 85 N and S), and overview.webp 1440 x 720 with the density of each 0.25 degree
cell, for the whole-globe view.
The reduced copies shipped with the file (.ovr) were made by nearest-neighbour sampling, so they are not used.
"""
import pathlib
import re
import struct
import tempfile
import urllib.request
import zipfile

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "maritime"
CACHE = pathlib.Path(tempfile.gettempdir()) / "hinterland-build"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
ZIP_URL = "https://datacatalogfiles.worldbank.org/ddh-published/0037580/5/DR0045406/shipdensity_global.zip"
TIF = "shipdensity_global.tif"
STEP = 0.05                      # output cell, degrees
COLS, ROWS = 7200, 3600
YEARS = 74 / 12                  # January 2015 to February 2021
NODATA = 2147483647
KM_PER_DEG = 111.32


def fetch(url):
    CACHE.mkdir(exist_ok=True)
    path = CACHE / url.rsplit("/", 1)[1]
    if not path.exists():
        print("downloading", url, "(535 MB)")
        part = path.with_suffix(".part")
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(part, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        part.rename(path)
    return path


def bounds():
    js = (ROOT / "maps" / "types" / "maritime.js").read_text(encoding="utf-8")
    body = re.search(r"const BOUNDS = \[(.*?)\];", js, re.S).group(1)
    b = [float(v) for v in re.findall(r"[\d.e+-]+", body)]
    assert b == sorted(b) and len(b) >= 4, b
    return np.array(b)


def skip(f, n):
    """Reads past n bytes in small pieces (ZipExtFile.seek asks for one large buffer)."""
    while n > 0:
        got = len(f.read(min(n, 1 << 18)))
        if not got:
            raise EOFError("the GeoTIFF ended early")
        n -= got


def read_ifd(f):
    """The full-resolution image's tags (BigTIFF, little-endian, IFD at the end of the file)."""
    head = f.read(16)
    assert head[:4] == b"II+\x00", head[:4]
    first = struct.unpack("<Q", head[8:16])[0]
    skip(f, first - 16)
    tail = f.read()
    at = lambda off, n: tail[off - first:off - first + n]
    tags = {}
    for i in range(struct.unpack("<Q", tail[:8])[0]):
        tag, typ, count = struct.unpack("<HHQ", tail[8 + i * 20:20 + i * 20])
        raw = tail[20 + i * 20:28 + i * 20]
        width = {2: 1, 3: 2, 4: 4, 12: 8, 16: 8}[typ]
        fmt = {2: "s", 3: "H", 4: "I", 12: "d", 16: "Q"}[typ]
        data = raw if width * count <= 8 else at(struct.unpack("<Q", raw)[0], width * count)
        tags[tag] = data[:count] if typ == 2 else struct.unpack(f"<{count}{fmt}", data[:width * count])
    w, h, (tw,), (th,) = tags[256][0], tags[257][0], tags[322], tags[323]
    assert tags[258] == (32,) and tags[259] == (1,) and tags[339] == (2,), "expected uncompressed int32 tiles"
    assert tags[33550][:2] == (STEP / 10, STEP / 10), tags[33550]
    assert tags[42113].rstrip(b"\x00") == str(NODATA).encode(), tags[42113]
    x0, y0 = tags[33922][3], tags[33922][4]
    return w, h, tw, th, x0, y0, np.array(tags[324], dtype=np.int64), np.array(tags[325], dtype=np.int64)


def aggregate():
    """Sum of positions and number of source cells with data, per 0.05 degree cell (cached)."""
    cached = CACHE / "shipdensity-0.05.npz"
    if cached.exists():
        z = np.load(cached)
        return z["sums"], z["cells"]
    with zipfile.ZipFile(fetch(ZIP_URL)) as zf:
        with zf.open(TIF) as f:
            w, h, tw, th, x0, y0, offs, sizes = read_ifd(f)
        f = zf.open(TIF)
        print(f"{w} x {h} cells from {x0:.4f} E, {y0:.4f} N; {len(offs)} tiles")
        assert np.all(sizes == tw * th * 4)
        across = -(-w // tw)
        src = STEP / 10
        # Source columns 72000 and up repeat columns 0 to 5 (the grid starts 0.015 degrees west of 180 W).
        keep = int(round(360 / src))
        col = (np.floor((x0 + (np.arange(across * tw) + 0.5) * src + 180) / STEP).astype(np.int64)) % COLS
        row = np.clip(np.floor((90 - (y0 - (np.arange(-(-h // th) * th) + 0.5) * src)) / STEP).astype(np.int64), 0, ROWS - 1)
        sums = np.zeros((ROWS, COLS), dtype=np.float32)
        cells = np.zeros((ROWS, COLS), dtype=np.uint8)
        pos = 0
        for n, t in enumerate(np.argsort(offs)):
            assert offs[t] >= pos
            skip(f, offs[t] - pos)
            tile = np.frombuffer(f.read(tw * th * 4), "<i4").reshape(th, tw)
            pos = offs[t] + tw * th * 4
            ty, tx = divmod(int(t), across)
            r0, c0 = ty * th, tx * tw
            nr, nc = min(th, h - r0), min(tw, w - c0, keep - c0)
            if nc <= 0:
                continue
            v = tile[:nr, :nc]
            ok = (v != NODATA) & (v >= 0)
            if not ok.any():
                continue
            rr, cc = row[r0:r0 + nr], col[c0:c0 + nc]
            # A tile spans at most a few output cells each way (and wraps at 180 degrees): bin it locally.
            ur, ir = np.unique(rr, return_inverse=True)
            uc, ic = np.unique(cc, return_inverse=True)
            idx = (ir[:, None] * len(uc) + ic[None, :])[ok]
            s = np.bincount(idx, weights=v[ok].astype(np.float64), minlength=len(ur) * len(uc)).reshape(len(ur), len(uc))
            k = np.bincount(idx, minlength=len(ur) * len(uc)).reshape(len(ur), len(uc))
            sums[np.ix_(ur, uc)] += s.astype(np.float32)
            cells[np.ix_(ur, uc)] += k.astype(np.uint8)
            if n % 20000 == 0:
                print(f"  {n} / {len(offs)} tiles")
        f.close()
    np.savez(cached, sums=sums, cells=cells)
    return sums, cells


def density(sums, cells, f=1):
    """AIS positions per km2 per year in each cell of f x f output cells (0 where nothing was recorded)."""
    if f > 1:
        sums = sums.astype(np.float64).reshape(ROWS // f, f, COLS // f, f).sum(axis=(1, 3))
        cells = cells.astype(np.int64).reshape(ROWS // f, f, COLS // f, f).sum(axis=(1, 3))
    lat = 90 - (np.arange(ROWS // f) + 0.5) * STEP * f
    src_km2 = (STEP / 10 * KM_PER_DEG) ** 2 * np.cos(np.radians(lat))[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(cells > 0, sums / (cells * src_km2) / YEARS, 0)


def classes(d, b):
    """Class 1 is above zero and under the first limit, class i + 1 from limit i up."""
    return np.where(d > 0, np.searchsorted(b, d, side="right") + 1, 0).clip(0, len(b) + 1).astype(np.uint8)


def save(k, name):
    Image.fromarray(k, "L").convert("RGB").save(OUT / name, "WEBP", lossless=True, quality=100, method=6)
    back = np.array(Image.open(OUT / name).convert("L"))
    assert np.array_equal(back, k), name  # lossless: the browser reads the class back from the red channel


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sums, cells = aggregate()
    d, b = density(sums, cells), bounds()
    k = classes(d, b)
    save(k, "density.webp")
    # The whole-globe view: the density of each 0.25 degree cell (not a thinned copy, so thin lanes still show).
    save(classes(density(sums, cells, 5), b), "overview.webp")
    print("classes:", np.bincount(k.ravel(), minlength=len(b) + 2).tolist())
    q = np.quantile(d[d > 0], [0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999])
    print("positions per km2 per year, quantiles 10 25 50 75 90 99 99.9 %:", [f"{v:.3g}" for v in q])

    # Spot checks: the Singapore Strait and the Dover Strait are among the busiest waters; the South Pacific far
    # from any route is nearly empty; the middle of the Sahara has no data at all.
    def at(lon, lat):
        return int(k[int((90 - lat) / STEP), int((lon + 180) / STEP) % COLS])
    checks = [("Singapore Strait", 103.9, 1.2, "high"), ("Dover Strait", 1.45, 51.0, "high"),
              ("South Pacific", -120.0, -45.0, "low"), ("Sahara", 13.0, 23.0, "none")]
    for name, lon, lat, want in checks:
        got = at(lon, lat)
        print(f"{name}: class {got}")
        assert {"high": got >= len(b) - 1, "low": got <= 3, "none": got == 0}[want], (name, got)
    for name in ("density.webp", "overview.webp"):
        print(name, (OUT / name).stat().st_size, "bytes")


if __name__ == "__main__":
    main()

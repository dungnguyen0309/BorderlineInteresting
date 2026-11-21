"""Build data/maps/timezones/: time-zone areas from timezone-boundary-builder, simplified for the globe.

Run: python scripts/build_timezones.py [--cache DIR]
Standard library, plus mapshaper through npx (Node.js) for topology-preserving simplification.

The release zip (about 25 MB) has no CORS headers, so it is fetched once here and two TopoJSON files are written:
  zones-lo.json   light, for the whole-globe view (loaded with the map type)
  zones-hi.json   finer, for zoomed-in views (loaded the first time the globe is zoomed in)
Each zone keeps only its IANA name (tzid); the browser works out offsets and daylight saving with Intl, so the
colours stay right as long as the browser's own time-zone data is current. Re-run when a new release changes
boundaries (pin RELEASE). Data: (c) OpenStreetMap contributors, ODbL 1.0; the outputs are offered under ODbL too.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "timezones"
RELEASE = "2026f"
# The full set: one area per IANA zone, so a click names the zone that place really uses. (timezones-now merges
# every zone that keeps the same clock from now on into one, e.g. Asia/Manila for all of China: too coarse to name.)
URL = f"https://github.com/evansiroky/timezone-boundary-builder/releases/download/{RELEASE}/timezones.geojson.zip"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
MAPSHAPER = "mapshaper@0.7.101"
# Share of vertices kept (mapshaper weighted Visvalingam) and coordinate grid, per level of detail.
LEVELS = {"zones-lo.json": ("0.6%", 20000), "zones-hi.json": ("6%", 200000)}


def fetch(cache: pathlib.Path) -> pathlib.Path:
    cache.mkdir(parents=True, exist_ok=True)
    zpath = cache / f"timezones-{RELEASE}.geojson.zip"
    if not zpath.exists():
        print("downloading", URL)
        req = urllib.request.Request(URL, headers=UA)
        with urllib.request.urlopen(req, timeout=300) as r, open(zpath.with_suffix(".part"), "wb") as f:
            shutil.copyfileobj(r, f)
        zpath.with_suffix(".part").rename(zpath)
    src = cache / f"timezones-{RELEASE}.json"
    if not src.exists():
        with zipfile.ZipFile(zpath) as z:
            name = next(n for n in z.namelist() if n.endswith(".json") and "/" not in n.strip("/"))
            with z.open(name) as i, open(src, "wb") as o:
                shutil.copyfileobj(i, o)
    return src


def simplify(src: pathlib.Path, dest: pathlib.Path, keep: str, quant: int) -> None:
    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        raise SystemExit("npx (Node.js) is needed for mapshaper")
    subprocess.run([
        npx, "--yes", MAPSHAPER, "-i", str(src), "name=zones",
        "-simplify", "weighted", keep, "keep-shapes",
        "-filter-fields", "tzid",
        # A point well inside each zone, for its offset label.
        "-each", "lx=+this.innerX.toFixed(2), ly=+this.innerY.toFixed(2)",
        "-o", str(dest), "format=topojson", f"quantization={quant}", "force",
    ], check=True)
    topo = json.loads(dest.read_text(encoding="utf-8"))
    names = [g["properties"]["tzid"] for g in topo["objects"]["zones"]["geometries"]]
    assert len(names) > 250 and "Asia/Kolkata" in names and "Europe/Paris" in names, len(names)
    dest.write_text(json.dumps(topo, separators=(",", ":")), encoding="utf-8")
    print(dest.name, len(names), "zones", dest.stat().st_size, "bytes")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / "hinterland-timezones")
    args = ap.parse_args()
    src = fetch(args.cache)
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (keep, quant) in LEVELS.items():
        simplify(src, OUT / name, keep, quant)


if __name__ == "__main__":
    main()

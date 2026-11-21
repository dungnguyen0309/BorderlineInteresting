"""Build data/maps/photographic/coverage.json: where each aerial photo service on the Photographic map has imagery.

Run: python scripts/build_photographic.py [--cache DIR]
Needs shapely. Natural Earth 1:10m countries and states (public domain) and, for the MASK services, OpenStreetMap
boundaries (ODbL, through Nominatim) are fetched once into the cache.

maps/types/photographic.js asks a service for a tile only where the tile meets that service's outline here, cuts its
tiles to the outline and names the service under a point by it. Natural Earth borders are generalised, up to about a
kilometre off (Irun, Menton), so outlines run about 1.5 km into neighbouring land and 2 km out to sea (LOOSE); further
out, the services' sea is mostly filler and flight seams, and Sentinel-2's is cleaner. Services that show blurred or
older imagery of their neighbours (MASK) are cut 20 m outside their OpenStreetMap boundary instead, so that filler stays
out of view. Keys match AERIAL there. The page credits OpenStreetMap for these outlines.
"""
import argparse
import json
import pathlib
import shutil
import tempfile
import time
import urllib.request

from shapely.geometry import Point, box, shape
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "photographic" / "coverage.json"
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/{}.geojson"
NOMINATIM = "https://nominatim.openstreetmap.org/lookup?osm_ids={}&format=geojson&polygon_geojson=1&polygon_threshold=0.0002"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}

# key: (countries by ADM0_A3, states by ISO 3166-2, optional [west, south, east, north] to keep)
MASK = {
    "es": (["ESP"], [], None),
    "ch": (["CHE", "LIE"], [], None),
    "tw": (["TWN"], [], None),
    "hk": (["HKG"], [], None),
    "qld": ([], ["AU-QLD"], None),
    "uy": (["URY"], [], None),
}
# OpenStreetMap boundary relations of the MASK services (countries' include their territorial sea).
OSM = {"es": [1311341], "ch": [51701, 1155955], "tw": [449220], "hk": [913110], "qld": [2316595], "uy": [287072]}
LOOSE = {
    "fr": (["FRA"], [], None),
    "pt": (["PRT"], [], [-9.7, 36.8, -6.0, 42.3]),  # mainland only
    "nl": (["NLD"], [], [3.0, 50.6, 7.4, 53.8]),  # European part only
    "wal": ([], ["BE-WHT", "BE-WNA", "BE-WLX", "BE-WLG", "BE-WBR"], None),
    "bru": ([], ["BE-BRU"], None),
    "lu": (["LUX"], [], None),
    "at": (["AUT"], [], None),
    "nrw": ([], ["DE-NW"], None),
    "by": ([], ["DE-BY"], None), "bb": ([], ["DE-BB", "DE-BE"], None), "be": ([], ["DE-BE"], None),
    "sn": ([], ["DE-SN"], None), "th": ([], ["DE-TH"], None), "he": ([], ["DE-HE"], None),
    "ni": ([], ["DE-NI"], None), "mv": ([], ["DE-MV"], None), "rp": ([], ["DE-RP"], None),
    "bw": ([], ["DE-BW"], None), "sl": ([], ["DE-SL"], None), "hh": ([], ["DE-HH"], None),
    "cz": (["CZE"], [], None),
    "pl": (["POL"], [], None),
    "sk": (["SVK"], [], None), "si": (["SVN"], [], None),
    "ee": (["EST"], [], None),
    "bz": ([], ["IT-BZ"], None),
    "us": (["USA", "PRI", "VIR"], [], None),  # NAIP, cut to US_PARTS
    "jp": (["JPN"], [], None),
    "nsw": ([], ["AU-NSW"], None), "act": ([], ["AU-ACT"], None), "tas": ([], ["AU-TAS"], None),
    "on": ([], ["CA-ON"], None),
}
# NAIP's extent on Planetary Computer (STAC search): the lower 48 with the Florida Keys, Puerto Rico and St Croix.
# Hawaii has no NAIP there.
US_PARTS = [box(-124.8, 24.4, -66.9, 49.4), box(-67.4, 17.8, -65.5, 18.6), box(-65.0, 17.6, -64.5, 17.9)]
SEA, LAND, TOL = 0.02, 0.015, 0.008  # degrees: margin out to sea, into neighbouring land, simplification
SEA_MASK = 0.05  # MASK services keep 5 km of sea: islands Natural Earth leaves out (Cheung Chau) stay in
SEA_BY = {"tas": 0.01}  # Tasmania's own sea is a coarse green and olive filler a kilometre out
CUT, CUT_TOL = 0.0002, 0.0001  # MASK services: 20 m past the OpenStreetMap boundary, simplified by 10 m

# Places that must fall inside (lon, lat), or outside (key prefixed with !), checked on every build.
CHECK = {
    "qld": [(145.7710, -16.9203), (153.5330, -28.1655), (142.2180, -10.5810)],  # Cairns, Coolangatta, Thursday Island
    "fr": [(7.5170, 43.7816), (-1.7700, 43.3600)],  # Menton-Garavan, Hendaye
    "cz": [(18.6230, 49.7460)],  # Český Těšín
    "hk": [(114.0280, 22.2100)],  # Cheung Chau
    "us": [(-81.7800, 24.5551)],  # Key West
    "es": [(-1.7890, 43.3390)],  # Irun
    "nsw": [(153.5410, -28.1760)],  # Tweed Heads
    "!us": [(-155.0868, 19.7241)],  # Hilo
    "!hk": [(114.1180, 22.5450)],  # Shenzhen, a kilometre past the river at Lo Wu
    "!es": [(1.5218, 42.5063)],  # Andorra la Vella
}


def fetch(cache: pathlib.Path, name: str, url: str) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"{name}.geojson"
    if not path.exists():
        print("downloading", name)
        time.sleep(1.1)  # Nominatim allows one request a second
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r, open(path.with_suffix(".part"), "wb") as f:
            shutil.copyfileobj(r, f)
        path.with_suffix(".part").rename(path)
    return json.loads(path.read_text(encoding="utf-8"))


def rings(geom) -> list:
    out = []
    for poly in getattr(geom, "geoms", [geom]):
        for ring in [poly.exterior, *poly.interiors]:
            out.append([round(v, 4) for xy in ring.coords[:-1] for v in xy])
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / "hinterland-naturalearth")
    cache = ap.parse_args().cache
    adm0 = {f["properties"]["ADM0_A3"]: shape(f["geometry"]) for f in fetch(cache, "ne_10m_admin_0_countries", NE.format("ne_10m_admin_0_countries"))["features"]}
    adm1 = {}
    for f in fetch(cache, "ne_10m_admin_1_states_provinces", NE.format("ne_10m_admin_1_states_provinces"))["features"]:
        code = f["properties"]["iso_3166_2"]
        adm1[code] = unary_union([adm1[code], shape(f["geometry"])]) if code in adm1 else shape(f["geometry"])
    land = list(adm0.values())

    out = {}
    for key, (a0, a1, keep) in {**MASK, **LOOSE}.items():
        g = unary_union([adm0[c] for c in a0] + [adm1[c] for c in a1])
        if keep:
            g = g.intersection(box(*keep))
        if key == "us":
            g = unary_union([g.intersection(b) for b in US_PARTS])
        g = g.simplify(TOL / 2, preserve_topology=True)
        # Out to sea, and into other land only as far as LAND: the neighbours' land, shrunk by that margin, is cut away.
        sea = SEA_MASK if key in MASK else SEA_BY.get(key, SEA)
        area = box(*g.buffer(sea + LAND).bounds)
        others = unary_union([c for c in land if c.intersects(area)]).intersection(area).difference(g)
        reach = g.buffer(sea, quad_segs=2).difference(others.buffer(-(LAND + TOL), quad_segs=2))
        if key in MASK:
            osm = unary_union([shape(f["geometry"]) for f in fetch(cache, f"osm-{key}", NOMINATIM.format(",".join(f"R{r}" for r in OSM[key])))["features"]])
            reach = reach.intersection(osm.buffer(CUT, quad_segs=2)).simplify(CUT_TOL, preserve_topology=True)
        else:
            reach = reach.simplify(TOL, preserve_topology=True)
        w, s, e, n = reach.bounds
        out[key] = {"bbox": [round(w, 4), round(s, 4), round(e, 4), round(n, 4)], "rings": rings(reach)}
        print(f"{key:4} {sum(len(r) // 2 for r in out[key]['rings']):6} points", flush=True)
        for name, pts in CHECK.items():
            if name.lstrip("!") == key:
                for p in pts:
                    assert reach.contains(Point(p)) != name.startswith("!"), f"{name}: {p}"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(OUT, OUT.stat().st_size, "bytes")


if __name__ == "__main__":
    main()

"""Builds data/maps/reference/reference.json for the Reference globe: rivers, lakes, cities and the names of
oceans and seas, from Natural Earth (public domain), kept small enough to load at once.

    python scripts/build_reference.py
"""
import json
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}


def get(name, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(NE + name + ".geojson", headers=UA), timeout=120) as r:
                return json.load(r)
        except Exception as e:  # network hiccups and 5xx: back off and retry
            if i == tries - 1:
                raise
            print("retry", name, e)
            time.sleep(2 * (i + 1))


def line(coords, nd=2):
    """Rounds to nd decimals (about 1 km at 2) and drops repeated points."""
    out = []
    for x, y in coords:
        p = [round(x, nd), round(y, nd)]
        if not out or out[-1] != p:
            out.append(p)
    return out


def lines_of(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def ring_area_centroid(ring):
    """Planar area and centroid of a lon/lat ring (fine for placing a label)."""
    a = cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(ring, ring[1:]):
        f = x0 * y1 - x1 * y0
        a += f
        cx += (x0 + x1) * f
        cy += (y0 + y1) * f
    if abs(a) < 1e-12:
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        return 0.0, [sum(xs) / len(xs), sum(ys) / len(ys)]
    return abs(a) / 2, [cx / (3 * a), cy / (3 * a)]


# Natural Earth places filed under another city's name, by name and rounded position: Maradi (Niger) is listed as a
# second Niamey, and places in Amapá, Amazonas and Sonora carry the name and population of Vila Velha, Natal and
# Mazatlán, which are listed again at their real positions. None drops the entry.
CITY_FIXES = {
    ("Niamey", 7.096, 13.492): "Maradi",
    ("Vila Velha", -51.217, 3.217): None,
    ("Natal", -60.27, -6.984): None,
    ("Mazatlán", -110.133, 29.017): None,
}


def main():
    rivers = []
    for f in get("ne_50m_rivers_lake_centerlines")["features"]:
        p = f["properties"]
        ls = [line(l) for l in lines_of(f["geometry"])]
        ls = [l for l in ls if len(l) > 1]
        if ls:
            rivers.append({"n": p.get("name_en") or p.get("name") or "", "r": p.get("scalerank", 9), "c": ls})

    lakes = []
    for f in get("ne_50m_lakes")["features"]:
        p = f["properties"]
        polys = [[line(r) for r in poly] for poly in rings_of(f["geometry"])]
        polys = [[r for r in poly if len(r) > 3] for poly in polys]
        polys = [poly for poly in polys if poly]
        if polys:
            big = max(polys, key=lambda poly: ring_area_centroid(poly[0])[0])
            lakes.append({"n": p.get("name") or "", "r": p.get("scalerank", 9), "c": polys,
                          "at": [round(v, 2) for v in ring_area_centroid(big[0])[1]]})

    cities = []
    for f in get("ne_10m_populated_places_simple")["features"]:
        p = f["properties"]
        cap = int(p.get("adm0cap") or 0)
        rank = int(p.get("scalerank") or 10)
        pop = int(p.get("pop_max") or 0)
        # Capitals, and cities big enough to be printed on a desk globe or a regional map.
        if not (cap or rank <= 6 or pop >= 500000):
            continue
        at = [round(p["longitude"], 3), round(p["latitude"], 3)]
        name = CITY_FIXES.get((p["name"], *at), p["name"])
        if name is None:
            continue
        cities.append({"n": name, "at": at, "pop": pop, "cap": cap, "r": rank, "iso": p.get("adm0_a3") or ""})
    cities.sort(key=lambda c: (-c["cap"], c["r"], -c["pop"]))

    water = []
    for f in get("ne_50m_geography_marine_polys")["features"]:
        p = f["properties"]
        cls = p.get("featurecla")
        if cls not in ("ocean", "sea", "bay", "gulf", "strait", "channel", "sound"):
            continue
        polys = rings_of(f["geometry"])
        if not polys:
            continue
        best = max((ring_area_centroid(poly[0]) + (poly[0],) for poly in polys), key=lambda t: t[0])
        xs = [pt[0] for pt in best[2]]
        # "North Atlantic Ocean" as printed on globes, not the shorter English name "Atlantic Ocean".
        name = p.get("name") or p.get("name_en") or ""
        water.append({"n": name.title() if name.isupper() else name, "cls": cls, "r": p.get("scalerank", 9),
                      "at": [round(v, 2) for v in best[1]], "span": round(min(70, max(xs) - min(xs)), 1)})

    out = {
        "built": time.strftime("%Y-%m-%d"),
        "source": "Natural Earth 1:50m rivers, lakes and marine areas; 1:10m populated places (v5.1.2, public domain)",
        "rivers": rivers, "lakes": lakes, "cities": cities, "water": water,
    }
    path = ROOT / "data" / "maps" / "reference" / "reference.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path}: {path.stat().st_size // 1024} KB, {len(rivers)} rivers, {len(lakes)} lakes, "
          f"{len(cities)} cities, {len(water)} water names")


# Self-checks: the label centroid of a square, and rounding with repeated points dropped.
assert ring_area_centroid([[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]) == (4.0, [1.0, 1.0])
assert line([[0.001, 0.002], [0.003, 0.004], [1, 1]]) == [[0.0, 0.0], [1, 1]]

if __name__ == "__main__":
    main()

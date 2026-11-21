"""Build data/labels.json: where each country's name goes on the globe.

The point is the pole of inaccessibility of the country's largest polygon (the inside point farthest from its
outline), so a name sits on the country's own land; the centroid of Vietnam is in Laos. It is worked in km on an
azimuthal equidistant projection centred on the polygon, so high latitudes and the antimeridian do not skew it.
Needs shapely. Run again only when the app's MAP_URL changes:  python scripts/build_labels.py

Output: {"map": the world-atlas file, "labels": [[lon, lat] or null, one per shape in the file's order]}
"""
import json
import math
import pathlib
import urllib.request

from shapely.geometry import Point, Polygon
from shapely.ops import polylabel
from shapely.validation import make_valid

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAP_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"  # MAP_URL in app.js
EARTH_KM = 6371


def polygons(topo, geom):
    """A TopoJSON geometry's polygons, each a list of rings of (lon, lat), as topojson-client stitches them."""
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]

    def arc(i):
        x = y = 0
        pts = []
        for dx, dy in topo["arcs"][i if i >= 0 else ~i]:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        return pts if i >= 0 else pts[::-1]

    def ring(ids):
        out = []
        for i in ids:
            pts = arc(i)
            out.extend(pts[1:] if out else pts)
        return out

    if geom.get("type") == "Polygon":
        return [[ring(r) for r in geom["arcs"]]]
    if geom.get("type") == "MultiPolygon":
        return [[ring(r) for r in p] for p in geom["arcs"]]
    return []


def sphere_area(ring):
    """Approximate area on the unit sphere, the smaller side of the ring (as polyArea in app.js)."""
    a = 0.0
    for (l1, p1), (l2, p2) in zip(ring, ring[1:]):
        d = math.radians((l2 - l1 + 540) % 360 - 180)
        a += d * (2 + math.sin(math.radians(p1)) + math.sin(math.radians(p2)))
    a = abs(a) / 2
    return min(a, 4 * math.pi - a)


def projection(lon0, lat0):
    """Azimuthal equidistant projection in km centred on (lon0, lat0), and its inverse."""
    l0, p0 = math.radians(lon0), math.radians(lat0)
    s0, c0 = math.sin(p0), math.cos(p0)

    def fwd(pt):
        l, p = math.radians(pt[0]) - l0, math.radians(pt[1])
        cosc = max(-1.0, min(1.0, s0 * math.sin(p) + c0 * math.cos(p) * math.cos(l)))
        c = math.acos(cosc)
        k = c / math.sin(c) if c > 1e-12 else 1.0
        return (EARTH_KM * k * math.cos(p) * math.sin(l), EARTH_KM * k * (c0 * math.sin(p) - s0 * math.cos(p) * math.cos(l)))

    def inv(xy):
        x, y = xy[0] / EARTH_KM, xy[1] / EARTH_KM
        c = math.hypot(x, y)
        if c < 1e-12:
            return (lon0, lat0)
        p = math.asin(max(-1.0, min(1.0, math.cos(c) * s0 + y * math.sin(c) * c0 / c)))
        l = l0 + math.atan2(x * math.sin(c), c * c0 * math.cos(c) - y * s0 * math.sin(c))
        return ((math.degrees(l) + 540) % 360 - 180, math.degrees(p))

    return fwd, inv


def label(poly):
    """The pole of inaccessibility of one polygon (outer ring first), as (lon, lat)."""
    outer = poly[0]
    # Centre the projection on the outer ring's mean point, longitudes taken relative to its first point.
    ref = outer[0][0]
    lons = [ref + (lon - ref + 540) % 360 - 180 for lon, _ in outer]
    fwd, inv = projection(sum(lons) / len(lons), sum(lat for _, lat in outer) / len(outer))
    shape = make_valid(Polygon([fwd(p) for p in outer], [[fwd(p) for p in r] for r in poly[1:]]))
    if shape.geom_type != "Polygon":  # a ring that touches itself: keep its largest piece
        shape = max((g for g in getattr(shape, "geoms", []) if g.geom_type == "Polygon"), key=lambda g: g.area)
    x0, y0, x1, y1 = shape.bounds
    pt = polylabel(shape, tolerance=min(x1 - x0, y1 - y0) / 100)
    assert shape.contains(pt), "label point outside its polygon"
    back = fwd(inv((pt.x, pt.y)))
    assert math.dist(back, (pt.x, pt.y)) < 0.01, "projection does not round-trip"
    return inv((pt.x, pt.y))


def main():
    # Self-check: a U whose centroid falls in the gap gets its label inside the U.
    u = [[(0, 0), (3, 0), (3, 3), (2, 3), (2, 1), (1, 1), (1, 3), (0, 3), (0, 0)]]
    lon, lat = label(u)
    assert Polygon(u[0]).contains(Point(lon, lat)) and Polygon(u[0]).centroid.within(Polygon(u[0])) is False

    req = urllib.request.Request(MAP_URL, headers={"User-Agent": "Borderline-Interesting-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        topo = json.load(r)
    out = []
    for geom in topo["objects"]["countries"]["geometries"]:
        polys = polygons(topo, geom)
        if not polys:
            out.append(None)
            continue
        main_poly = max(polys, key=lambda p: sphere_area(p[0]))
        lon, lat = label(main_poly)
        out.append([round(lon, 3), round(lat, 3)])
    path = ROOT / "data" / "labels.json"
    path.write_text(json.dumps({"map": MAP_URL, "labels": out}, separators=(",", ":")) + "\n", encoding="utf-8", newline="\n")
    print(f"{path}: {sum(1 for x in out if x)} of {len(out)} shapes")


if __name__ == "__main__":
    main()

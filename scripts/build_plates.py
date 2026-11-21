"""Builds the plate tectonics map data from Peter Bird's PB2002 model.

Source: Bird, P. (2003), An updated digital model of plate boundaries, G-cubed 4(3), 1027,
doi:10.1029/2001GC000252, as GeoJSON by Hugo Ahlenius, Nordpil (github.com/fraxen/tectonicplates, ODC-BY 1.0),
pinned to one commit and fetched through jsDelivr.

Writes, under data/maps/plates/:
  steps.json   every PB2002 boundary step (about 5,800, 30-100 km long): ends, class, the plates on its left
               and right, which one rides over a subduction zone, and the modelled relative velocity
  plates.json  the 52 plates as polygons (for "which plate is this point on"), with a label point and area

Run: python scripts/build_plates.py   (stdlib only; the 10 MB steps file is downloaded once and kept in the temp dir)
"""
import json
import math
import os
import random
import tempfile
import urllib.request

COMMIT = '339b0c56563c118307b1f4542703047f5f698fae'  # fraxen/tectonicplates master, 2014-10-06
BASE = f'https://cdn.jsdelivr.net/gh/fraxen/tectonicplates@{COMMIT}/GeoJSON/'
UA = 'Borderline-Interesting-research-map/1.0 (static site build script)'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'maps', 'plates')
CACHE = os.path.join(tempfile.gettempdir(), 'hinterland-plates-' + COMMIT[:8])
CLASSES = ['OSR', 'CRB', 'OTF', 'CTF', 'SUB', 'OCB', 'CCB']


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        req = urllib.request.Request(BASE + name, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def wrap(lon):
    return (lon + 540) % 360 - 180


def in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_plate(lon, lat, plate):
    w, s, e, n = plate['bbox']
    if lon < w or lon > e or lat < s or lat > n:
        return False
    for poly in plate['polys']:
        if in_ring(lon, lat, poly[0]) and not any(in_ring(lon, lat, h) for h in poly[1:]):
            return True
    return False


def ring_area(ring):
    """Area of a lon/lat ring in steradians (signed by winding), as in Mapbox geojson-area."""
    a = 0.0
    for i in range(len(ring) - 1):
        (x1, y1), (x2, y2) = ring[i], ring[i + 1]
        a += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return a / 2


def label_point(plate):
    """A point well inside the plate's largest part: on a grid over its box, the one farthest from any real edge."""
    part = max(plate['polys'], key=lambda poly: abs(ring_area(poly[0])))
    xs, ys = [x for x, _ in part[0]], [y for _, y in part[0]]
    w, s, e, n = min(xs), min(ys), max(xs), max(ys)
    plate = {'polys': [part], 'bbox': (w, s, e, n)}
    edges = []
    for poly in plate['polys']:
        for ring in poly:
            for a, b in zip(ring, ring[1:]):
                if abs(a[0]) > 179.99 and abs(b[0]) > 179.99:
                    continue  # the antimeridian cut, not a plate edge
                if a[1] < -89.99 and b[1] < -89.99:
                    continue  # the south pole, not a plate edge
                edges.append((a, b))
    best, bd = None, -1
    steps = 28
    for i in range(steps + 1):
        for j in range(steps + 1):
            lon, lat = w + (e - w) * (i + 0.5) / (steps + 1), s + (n - s) * (j + 0.5) / (steps + 1)
            if not in_plate(lon, lat, plate):
                continue
            c = max(0.05, math.cos(math.radians(lat)))
            d = min(seg_dist(lon, lat, a, b, c) for a, b in edges)
            if d > bd:
                best, bd = (lon, lat), d
    if best is None:  # a sliver: the mean of its vertices
        pts = [p for poly in plate['polys'] for p in poly[0]]
        best = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    return [round(best[0], 2), round(best[1], 2)]


def seg_dist(lon, lat, a, b, c):
    ax, ay, bx, by = (a[0] - lon) * c, a[1] - lat, (b[0] - lon) * c, b[1] - lat
    dx, dy = bx - ax, by - ay
    t = 0 if dx == dy == 0 else max(0, min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
    return math.hypot(ax + t * dx, ay + t * dy)


def main():
    plates = {}
    for f in fetch('PB2002_plates.json')['features']:
        code, g = f['properties']['Code'], f['geometry']
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        p = plates.setdefault(code, {'code': code, 'name': f['properties']['PlateName'], 'polys': []})
        p['polys'] += polys  # already cut at the antimeridian, lon in [-180, 180]
    for p in plates.values():
        pts = [pt for poly in p['polys'] for pt in poly[0]]
        p['bbox'] = (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))

    # Self-check: the plates tile the globe, so a random point is on exactly one of them.
    rnd = random.Random(1)
    hits = [sum(in_plate(lon, lat, p) for p in plates.values())
            for lon, lat in ((rnd.uniform(-180, 180), math.degrees(math.asin(rnd.uniform(-1, 1)))) for _ in range(3000))]
    ok = sum(h == 1 for h in hits) / len(hits)
    assert ok > 0.995, f'plates do not tile the globe ({ok:.3f} of points on exactly one plate)'

    codes = sorted(plates)
    index = {c: i for i, c in enumerate(codes)}

    steps, agree, total = [], 0, 0
    for f in fetch('PB2002_steps.json')['features']:
        q = f['properties']
        bound = q['PLATEBOUND']
        sep = '/' if '/' in bound else '\\' if '\\' in bound else '-'
        a, b = bound.split(sep)
        # Bird's names for subduction zones draw the slab: the plate at the low end of the slash rides over it.
        over = a if sep == '/' else b if sep == '\\' else None
        lon1, lat1, lon2, lat2 = q['STARTLONG'], q['STARTLAT'], q['FINALLONG'], q['FINALLAT']
        # Bird names the plate on the left (walking from start to end) first; the velocity is its motion relative
        # to the second. (A point-in-polygon siding agreed on 5,823 of 5,824 steps; the odd one was a corner case.)
        left, right = a, b
        # Check the velocity convention: the left plate's motion relative to the right one, so its part along the
        # left normal is the opening rate (VELOCITYDI > 0 for spreading).
        v, az, di = q['VELOCITYLE'], q['VELOCITYAZ'], q['VELOCITYDI']
        if abs(di) > 2:
            total += 1
            agree += (v * math.cos(math.radians(az - (q['AZIMUTHCEN'] - 90))) > 0) == (di > 0)
        steps.append([
            round(lon1, 3), round(lat1, 3), round(lon2, 3), round(lat2, 3),
            CLASSES.index(q['STEPCLASS']), index[left], index[right],
            -1 if over is None else index[over],
            round(v, 1), round(az), round(di, 1), round(q['VELOCITYRI'], 1),
            1 if q['OROGEN'] == 'TRUE' else 0
        ])
    assert agree / total > 0.97, f'velocity convention check failed ({agree}/{total})'

    os.makedirs(OUT, exist_ok=True)
    meta = {
        'source': 'Bird (2003) PB2002, GeoJSON by Hugo Ahlenius, Nordpil (ODC-BY 1.0), commit ' + COMMIT,
        'classes': CLASSES,
        'fields': ['lon1', 'lat1', 'lon2', 'lat2', 'class', 'left', 'right', 'over', 'mm_per_yr', 'azimuth',
                   'opening', 'right_lateral', 'orogen'],
        'note': 'Velocity: the left plate relative to the right one (left as seen from start to end), mm/yr, from '
                'the PB2002 Euler poles. opening > 0 diverging, < 0 converging; right_lateral < 0 is left-lateral.',
        # Antarctica's best inner point is at the pole, out of sight in most views: put its name on the continent.
        'plates': [[c, plates[c]['name'], [30, -76] if c == 'AN' else label_point(plates[c]),
                    round(sum(abs(ring_area(poly[0])) for poly in plates[c]['polys']) * 6371.0088 ** 2)]
                   for c in codes]
    }
    with open(os.path.join(OUT, 'steps.json'), 'w', encoding='utf-8') as f:
        json.dump({**meta, 'steps': steps}, f, separators=(',', ':'), ensure_ascii=False)
    polys = {c: [[[[round(x, 2), round(y, 2)] for x, y in ring] for ring in poly] for poly in plates[c]['polys']]
             for c in codes}
    with open(os.path.join(OUT, 'plates.json'), 'w', encoding='utf-8') as f:
        json.dump({'codes': codes, 'polys': polys}, f, separators=(',', ':'), ensure_ascii=False)
    print(f'{len(steps)} steps, {len(codes)} plates; velocity check {agree}/{total}')


if __name__ == '__main__':
    main()

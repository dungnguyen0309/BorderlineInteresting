"""Postal code points for the 'Postal codes' map type, from the GeoNames postal code dump (CC BY 4.0).

GeoNames sends no CORS headers, so the dump is downloaded once here and split into one small file per country and 5-degree cell under
data/maps/postal/, which the browser loads only for the cells in view once zoomed in.

    python scripts/build_postal.py            # uses a cached download if it is under 30 days old
    python scripts/build_postal.py --fresh    # downloads again

Output:
    data/maps/postal/index.json   per country: number of codes, format, coverage notes, 5-degree cells it has files for;
                                  plus world-atlas country ids -> ISO 3166 alpha-2, for colouring countries
    data/maps/postal/CC-cell.tsv.gz  one country's codes in one 5-degree cell (cell = row * 72 + column, counted from
                                  90 S and 180 W): gzipped UTF-8 text (the browser unzips it with DecompressionStream;
                                  static hosts do not add Content-Encoding to .gz files, and the browser copes if one does).
                                  line 1: admin1 names, line 2: admin2 names (tab-separated), then one row per code:
                                  code, place, lat, lon, admin1 index, admin2 index, extra, accuracy
                                  lat/lon are differences from the previous row in 1/1000 degree; an empty place,
                                  admin index or accuracy means "same as the row above"; extra is the number of other
                                  places that share the code, or for grouped countries "codes first last"; accuracy is
                                  the best GeoNames position accuracy among the code's rows (1 estimated .. 6 centroid
                                  of addresses or shape, 0 not given).
"""
import argparse, collections, gzip, io, json, statistics, tempfile, time, urllib.request, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'maps' / 'postal'
URL = 'https://download.geonames.org/export/zip/allCountries.zip'
UA = 'Borderline-Interesting-research-map/1.0 (static site build script)'
PREC = 1000  # 0.001 degree, about 110 m (GeoNames positions are estimates, often several km off)

# From the GeoNames readme (download.geonames.org/export/zip/readme.txt).
PARTIAL = {
    'AR': 'Only the old 4-digit codes; the full CPA (e.g. C1425ABC) is not in GeoNames.',
    'BR': 'Only major codes: those ending in -000 and the main code of each municipality.',
    'CA': 'Only the first half of each code (the forward sortation area, e.g. K1A).',
    'CL': 'Only the first digits of each code.',
    'CN': 'Only the first digits of each code, ending in 00.',
    'GB': 'Only the first half of each code (the outward code, e.g. SW1A).',
    'IE': 'Only the first 3 characters of each Eircode (the routing key).',
    'MT': 'Only the letters at the start of each code.',
    'NL': 'Only the 4 digits at the start of each code, without the 2 letters.',
    'US': 'Military codes (APO, FPO and DPO) are left out: GeoNames places them at bases abroad.',
}
# How codes are really written where the GeoNames rows are cut short (see PARTIAL); None: no national system.
FORMAT = {'NL': '9999 AA', 'AR': 'A9999AAA', 'CA': 'A9A 9A9', 'GB': 'A9 9AA to AA9A 9AA', 'IE': 'A99 A9A9',
          'MT': 'AAA 9999', 'AE': None}
MILITARY = ('APO ', 'FPO ', 'DPO ')
# Countries whose codes go down to streets or buildings (100,000 or more in GeoNames) are grouped to a district
# level here, to keep the files small: (key of a row, what the group is, how the code is written).
GROUPS = {
    'PT': (lambda r: r[1][:4], 'Codes are grouped by their first 4 digits (the CP4 postal area).', '{}-xxx'),
    'JP': (lambda r: r[1][:3], 'Codes are grouped by their first 3 digits (the delivery area).', '{}-xxxx'),
    'SG': (lambda r: r[1][:2], 'Codes are grouped by their first 2 digits (the postal sector).', '{}xxxx'),
    'AE': (lambda r: r[7] or r[2], 'GeoNames lists address codes here, grouped by community. The UAE has no national postal code system.', '{}'),
}


def fetch(cache, fresh):
    cache.mkdir(parents=True, exist_ok=True)
    z = cache / 'allCountries.zip'
    if fresh or not z.exists() or time.time() - z.stat().st_mtime > 30 * 86400:
        print('downloading', URL)
        req = urllib.request.Request(URL, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(z, 'wb') as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
    return z


def pattern(code):
    return ''.join('9' if c.isdigit() else 'A' if c.isalpha() else c for c in code)


def kind(pat):
    if 'A' in pat:
        return 'alnum'
    d = pat.count('9')
    return 'd4' if d <= 4 else 'd5' if d == 5 else 'd6' if d == 6 else 'd7'


def mode(xs):
    return collections.Counter(xs).most_common(1)[0][0]


def acc(r):
    return int(r[11]) if len(r) > 11 and r[11].isdigit() else 0


def records(cc, rows):
    """One record per code (or per group): [code, place, lat, lon, admin1, admin2, extra]."""
    group = GROUPS.get(cc)
    key = group[0] if group else (lambda r: r[1])
    by = collections.defaultdict(list)
    for r in rows:
        by[key(r)].append(r)
    out = []
    for k in sorted(by):
        rs = by[k]
        # Median, so a few far rows (e.g. Tokyo's outlying islands in group 100) do not pull the dot away.
        lat = statistics.median(float(r[9]) for r in rs)
        lon = statistics.median(float(r[10]) for r in rs)
        if group:
            codes = sorted({r[1] for r in rs})
            extra = f'{len(codes)} {codes[0]} {codes[-1]}'
            label = group[2].format(k)
        else:
            places = {r[2] for r in rs}
            extra = str(len(places) - 1) if len(places) > 1 else ''
            label = k
        # The place most rows give, with its own admin areas; ties go to the most accurate row, then the shortest name.
        count = collections.Counter(r[2] for r in rs)
        first = min(rs, key=lambda r: (-count[r[2]], -acc(r), len(r[2]), r[2]))
        out.append([label, first[2], lat, lon, first[3], first[5], extra, max(acc(r) for r in rs)])
    return out


def encode(recs):
    a1, a2 = {}, {}
    lines = []
    prev = [None, None, 0, 0, None, None, None]
    for code, place, lat, lon, n1, n2, extra, ac in recs:
        la, lo = round(lat * PREC), round(lon * PREC)
        i1, i2 = a1.setdefault(n1, len(a1)), a2.setdefault(n2, len(a2))
        f = [code, '' if place == prev[1] else place, str(la - prev[2]), str(lo - prev[3]),
             '' if i1 == prev[4] else str(i1), '' if i2 == prev[5] else str(i2), extra, '' if ac == prev[6] else str(ac)]
        lines.append('\t'.join(f).rstrip('\t'))
        prev = [code, place, la, lo, i1, i2, ac]
    return '\n'.join(['\t'.join(a1), '\t'.join(a2), *lines]) + '\n'


def decode(text):
    """The browser's parser, in Python, for the self-check."""
    ls = text.rstrip('\n').split('\n')
    a1, a2 = ls[0].split('\t'), ls[1].split('\t')
    out, la, lo, place, i1, i2, ac = [], 0, 0, '', 0, 0, 0
    for line in ls[2:]:
        f = line.split('\t') + [''] * 8
        place = f[1] or place
        la += int(f[2]); lo += int(f[3])
        i1 = int(f[4]) if f[4] else i1
        i2 = int(f[5]) if f[5] else i2
        ac = int(f[7]) if f[7] else ac
        out.append([f[0], place, la / PREC, lo / PREC, a1[i1], a2[i2], f[6], ac])
    return out


def atlas_ids():
    """ISO alpha-2 -> world-atlas ids, from the country data the app already ships."""
    countries = json.loads((ROOT / 'data' / 'countries.json').read_text('utf-8'))['countries']
    atlas = json.loads((ROOT / 'data' / 'atlas.json').read_text('utf-8'))['countries']
    a2 = {iso3: c.get('a2') for iso3, c in atlas.items()}
    ids = {}
    for key, c in countries.items():
        code = a2.get(c.get('iso3'))
        if code:
            ids[key] = code
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', type=Path, default=Path(tempfile.gettempdir()) / 'hinterland-geonames-postal')
    ap.add_argument('--fresh', action='store_true')
    args = ap.parse_args()

    by = collections.defaultdict(list)
    with zipfile.ZipFile(fetch(args.cache, args.fresh)) as z, z.open('allCountries.txt') as f:
        for line in io.TextIOWrapper(f, encoding='utf-8'):
            r = line.rstrip('\n').split('\t')
            if len(r) >= 11 and r[9] and r[10] and not (r[0] == 'US' and r[2].startswith(MILITARY)):
                by[r[0]].append(r)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in [*OUT.glob('*.tsv'), *OUT.glob('*.tsv.gz')]:
        old.unlink()
    index = {}
    total = 0
    for cc in sorted(by):
        rows = by[cc]
        recs = records(cc, rows)
        # One file per country and 5-degree cell, so a view loads only the parts of big countries it shows.
        by_cell = collections.defaultdict(list)
        for r in recs:
            by_cell[int((min(89.99, r[2]) + 90) // 5) * 72 + int((min(179.99, r[3]) + 180) // 5)].append(r)
        size = 0
        for cell, part in by_cell.items():
            text = encode(part)
            # Self-check: the file decodes back to the records, within the rounding.
            back = decode(text)
            assert len(back) == len(part) and all(
                b[0] == r[0] and b[1] == r[1] and b[4] == r[4] and b[5] == r[5] and b[6] == r[6] and b[7] == r[7] and abs(b[2] - r[2]) <= 0.5 / PREC + 1e-9 and abs(b[3] - r[3]) <= 0.5 / PREC + 1e-9
                for b, r in zip(back, part)), (cc, cell)
            gz = gzip.compress(text.encode('utf-8'), 9, mtime=0)
            (OUT / f'{cc}-{cell}.tsv.gz').write_bytes(gz)
            size += len(gz)
        total += size
        codes = {r[1] for r in rows}
        # The usual format, leaving out France's CEDEX business codes (e.g. 75700 CEDEX 07).
        pat = mode(pattern(c) for c in codes if 'CEDEX' not in c)
        same = sorted(c for c in codes if pattern(c) == pat)
        cells = sorted(by_cell)
        fmt = FORMAT.get(cc, pat)
        entry = {'codes': len(codes), 'dots': len(recs), 'fmt': fmt, 'kind': fmt and kind(fmt),
                 'ex': same[len(same) // 3], 'bytes': size, 'cells': cells}
        if fmt != pat:
            entry['gfmt'] = pat  # the form of the codes GeoNames has, which 'ex' follows
        if cc in PARTIAL:
            entry['partial'] = PARTIAL[cc]
        if cc in GROUPS:
            entry['grouped'] = GROUPS[cc][1]
        index[cc] = entry
    ids = atlas_ids()
    doc = {'built': time.strftime('%Y-%m-%d'), 'source': URL, 'countries': index,
           'ids': {k: v for k, v in ids.items() if v in index}}
    (OUT / 'index.json').write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), 'utf-8')
    print(f'{len(index)} countries, {sum(len(e["cells"]) for e in index.values())} files, {sum(e["dots"] for e in index.values())} dots, {total / 1e6:.2f} MB gzipped')


if __name__ == '__main__':
    main()

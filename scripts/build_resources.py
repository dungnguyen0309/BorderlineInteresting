"""Builds the Resources map type's data in data/maps/resources/.

  rents.json   natural resource rents, % of GDP, 2021 or each country's latest year since 2015 (World Bank WDI,
               CC BY 4.0), keyed by the world-atlas country id (ISO 3166 numeric), joined through data/countries.json;
               each entry is the six rents then their year
  plants.json  power plants (WRI Global Power Plant Database v1.3.0, CC BY 4.0): positions, fuel, capacity
  plants-info.json  names, owners, years and sources for the same plants, loaded on the first click
  mrds-codes.json   USGS MRDS commodity codes and names (public domain), for click details

Run from the hinterland folder:  python scripts/build_resources.py
"""
import csv
import io
import json
import re
import html
import http.client
import time
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'maps' / 'resources'
UA = 'Borderline-Interesting-research-map/1.0 (static site build script)'
YEAR = 2021  # the latest year with rents data (checked 2026-11-16: nothing after 2021)
FIRST = 2015  # oldest year used for a country with no figure for YEAR
RENTS = ['NY.GDP.TOTL.RT.ZS', 'NY.GDP.PETR.RT.ZS', 'NY.GDP.NGAS.RT.ZS', 'NY.GDP.COAL.RT.ZS', 'NY.GDP.MINR.RT.ZS', 'NY.GDP.FRST.RT.ZS']
GPPD = 'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv'
MRDS_CODES = 'https://mrdata.usgs.gov/mrds/commodity-codes.html'


def get(url, tries=4):
    # The World Bank API often answers 502 or stalls for a while; wait and ask again, at most `tries` times.
    for n in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as r:
                return r.read()
        except (OSError, http.client.HTTPException) as e:  # URLError, HTTPError and timeouts are OSErrors
            if n == tries - 1:
                raise
            print(f'{e}; trying again in {15 * (n + 1)} s')
            time.sleep(15 * (n + 1))


def rents():
    """Each country's six rents from one year: YEAR, or its latest earlier year with a total (back to FIRST)."""
    countries = json.loads((ROOT / 'data' / 'countries.json').read_text(encoding='utf-8'))['countries']
    by_iso3 = {c['iso3']: key for key, c in countries.items() if c.get('iso3')}
    vals = {}  # (key, year) -> six values
    for i, ind in enumerate(RENTS):
        page = json.loads(get(f'https://api.worldbank.org/v2/country/all/indicator/{ind}?format=json&date={FIRST}:{YEAR}&per_page=3000'))
        assert page[0]['pages'] == 1, page[0]
        for row in page[1]:
            key = by_iso3.get(row['countryiso3code'])  # aggregates (regions, income groups) have no key
            if key and row['value'] is not None:
                vals.setdefault((key, int(row['date'])), [None] * len(RENTS))[i] = round(row['value'], 2)
        time.sleep(1)  # the API rate-limits
    out = {}
    for (key, year), v in sorted(vals.items(), key=lambda kv: kv[0][1]):  # oldest first, so later years win
        if key not in out or v[0] is not None or out[key][0] is None:  # but never over a year that has a total
            out[key] = v + [year]
    assert len(out) > 150 and all(len(v) == len(RENTS) + 1 for v in out.values()), len(out)
    print(f'rents: {len(out)} countries, {sum(v[-1] < YEAR for v in out.values())} from before {YEAR}')
    return {'year': YEAR, 'first': FIRST, 'built': date.today().isoformat(), 'indicators': RENTS, 'countries': out}


def plants():
    rows = list(csv.DictReader(io.StringIO(get(GPPD).decode('utf-8'))))
    assert len(rows) > 30000 and 'primary_fuel' in rows[0], len(rows)
    rows.sort(key=lambda r: -float(r['capacity_mw'] or 0))  # big plants first, so small ones are drawn on top
    fuels = sorted({r['primary_fuel'] for r in rows})
    sources, owners = {}, {}
    idx = lambda d, v: d.setdefault(v, len(d))
    pts = {'fuels': fuels, 'lon': [], 'lat': [], 'fuel': [], 'mw': []}
    info = {'name': [], 'id': [], 'country': [], 'owner': [], 'year': [], 'source': [], 'capyear': []}
    for r in rows:
        pts['lon'].append(round(float(r['longitude']), 4))
        pts['lat'].append(round(float(r['latitude']), 4))
        pts['fuel'].append(fuels.index(r['primary_fuel']))
        mw = float(r['capacity_mw'] or 0)
        pts['mw'].append(round(mw, 1) if mw < 100 else round(mw))
        info['name'].append(r['name'])
        info['id'].append(r['gppd_idnr'])
        info['country'].append(r['country'])
        info['owner'].append(idx(owners, r['owner']))
        # A fractional year is the capacity-weighted average of the units' years; kept so the panel can say so.
        y = round(float(r['commissioning_year']), 2) if r['commissioning_year'] else 0
        info['year'].append(int(y) if float(y).is_integer() else y)
        info['source'].append(idx(sources, r['source']))
        info['capyear'].append(int(float(r['year_of_capacity_data'])) if r['year_of_capacity_data'] else 0)
    info['owners'] = list(owners)
    info['sources'] = list(sources)
    return pts, info


def codes():
    page = get(MRDS_CODES).decode('utf-8', 'replace')
    out = {}
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', page, re.S):
        cells = [html.unescape(re.sub(r'<[^>]+>', '', c)).strip() for c in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)]
        if len(cells) >= 2 and cells[0]:
            out[cells[0]] = cells[1]
    assert out.get('AU') == 'Gold' and len(out) > 100, len(out)
    return out


def write(name, obj):
    p = OUT / name
    p.write_text(json.dumps(obj, separators=(',', ':'), ensure_ascii=False), encoding='utf-8')
    print(f'{p.relative_to(ROOT)}: {p.stat().st_size:,} bytes')


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    write('rents.json', rents())
    pts, info = plants()
    write('plants.json', pts)
    write('plants-info.json', info)
    write('mrds-codes.json', codes())

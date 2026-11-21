"""Build data/maps/airports/: every open airport with an IATA code, for the Airports map.

Run: python scripts/build_airports.py
Standard library only. Takes about five minutes (the Wikidata queries are spaced out). Re-run to refresh.
Sources:
  OurAirports (public domain, ourairports.com/data): airports.csv, runways.csv and countries.csv from the daily
  copy at davidmegginson.github.io/ourairports-data. Kept: large, medium and small airports with an IATA code that
  are not closed, and heliports and seaplane bases with an IATA code and scheduled flights.
  Wikidata (CC0), matched on the IATA code (P238) and checked against the ICAO code (P239): Commons category (P373),
  image (P18), opening date (P1619), operator (P137), yearly passengers (P3872 with its P585 date, the latest year),
  airlines that name the airport as a hub (P113, airlines with no end date P576), and the English Wikipedia article.
Writes:
  markers.json   what the globe draws, as columns: iata, name, lon, lat, t (L, M, S, H heliport, W seaplane base),
                 p (latest yearly passengers in thousands, 0 when not known)
  details/X.json the panel's facts for every airport whose IATA code starts with X, keyed by code; loaded on a click
"""
import csv
import datetime
import http.client
import io
import json
import math
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "airports"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
OURAIRPORTS = "https://davidmegginson.github.io/ourairports-data/"
SPARQL = "https://query.wikidata.org/sparql"
BATCH = 250
TYPES = {"large_airport": "L", "medium_airport": "M", "small_airport": "S", "heliport": "H", "seaplane_base": "W"}
# OurAirports' surface field is free text; only the words and codes whose meaning is plain are named.
SURFACE = {"ASP": "asphalt", "ASPH": "asphalt", "ASPHALT": "asphalt", "BIT": "bitumen", "PAVED": "paved",
           "CON": "concrete", "CONC": "concrete", "CONCRETE": "concrete", "TURF": "grass", "GRS": "grass",
           "GRASS": "grass", "GVL": "gravel", "GRVL": "gravel", "GRAVEL": "gravel", "DIRT": "dirt", "EARTH": "earth",
           "SAND": "sand", "WATER": "water", "WAT": "water", "COR": "coral", "CORAL": "coral", "LAT": "laterite",
           "SNOW": "snow", "ICE": "ice", "CLAY": "clay", "GRAVEL/GRASS": "gravel"}


def get(url, data=None, tries=5, raw=False):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data and urllib.parse.urlencode(data).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
                return body.decode("utf-8") if raw else json.loads(body)
        except urllib.error.HTTPError as e:
            if (e.code != 429 and e.code < 500) or i == tries - 1:
                raise
            # Wikimedia rate-limits bursts (429): wait as long as it asks, or longer each time.
            wait = e.headers.get("Retry-After")
            time.sleep(int(wait) if wait and wait.isdigit() else 10 * 2 ** i)
        except (urllib.error.URLError, TimeoutError, http.client.HTTPException, ValueError):
            if i == tries - 1:
                raise
            time.sleep(10 * 2 ** i)


def sparql(query):
    rows = get(SPARQL, {"format": "json", "query": query})["results"]["bindings"]
    time.sleep(3)  # the query service allows a minute of query time per minute; leave room
    return [{k: v["value"].replace("http://www.wikidata.org/entity/", "") for k, v in r.items()} for r in rows]


def table(name):
    return list(csv.DictReader(io.StringIO(get(OURAIRPORTS + name, raw=True))))


def surfaces(texts):
    """'ASPH-G', 'CONC/ GRS' -> the plain words, in order of first use; codes with no plain meaning are left out."""
    out = []
    for t in texts:
        for tok in re.split(r"[-/,; ]+", t.upper()):
            w = SURFACE.get(tok)
            if w and w not in out:
                out.append(w)
    return out


def span(rws, lat):
    """Centre [lon, lat] and east-west and north-south extent in metres of the runway ends, or None."""
    pts = []
    for r in rws:
        for e in ("le", "he"):
            try:
                pts.append((float(r[f"{e}_longitude_deg"]), float(r[f"{e}_latitude_deg"])))
            except ValueError:
                pass
    if len(pts) < 2:
        return None
    lo = [p[0] for p in pts]
    la = [p[1] for p in pts]
    if max(lo) - min(lo) > 1 or max(la) - min(la) > 1:  # a mistyped end: no frame from it
        return None
    m = 111320
    return [round((max(lo) + min(lo)) / 2, 5), round((max(la) + min(la)) / 2, 5),
            round((max(lo) - min(lo)) * m * math.cos(math.radians(lat))), round((max(la) - min(la)) * m)]


def date_text(value, precision):
    """A Wikidata time at its own precision: '1946', '1946-05' or '1946-05-31'."""
    v = value.lstrip("+")[:10]
    p = int(precision or 11)
    return None if p < 9 or v.startswith("-") else v[:4] if p == 9 else v[:7] if p == 10 else v


assert surfaces(["ASPH-G", "CONC/ GRS", "PEM", "UNK"]) == ["asphalt", "concrete", "grass"]
assert date_text("1946-01-01T00:00:00Z", "9") == "1946" and date_text("1946-05-31T00:00:00Z", "11") == "1946-05-31"
assert span([{"le_longitude_deg": "0", "le_latitude_deg": "0", "he_longitude_deg": "0.01", "he_latitude_deg": "0"}], 0) == [0.005, 0.0, 1113, 0]


def chunks(xs, n=BATCH):
    return [xs[i:i + n] for i in range(0, len(xs), n)]


def wikidata(airports):
    """IATA code -> Wikidata facts, for the airports Wikidata knows by that code (and, where both have one, the same
    ICAO code)."""
    cand = {}
    for part in chunks(sorted(airports)):
        values = " ".join(f'"{c}"' for c in part)
        for r in sparql(f"""SELECT ?item ?iata ?icao ?sl ?end WHERE {{
  VALUES ?iata {{ {values} }}
  ?item wdt:P238 ?iata ; wikibase:sitelinks ?sl .
  OPTIONAL {{ ?item wdt:P239 ?icao }}
  OPTIONAL {{ ?item wdt:P3999 ?end }}
}}"""):
            cand.setdefault(r["iata"], {}).setdefault(r["item"], {"sl": int(r["sl"]), "icao": set(), "end": False})
            c = cand[r["iata"]][r["item"]]
            if r.get("icao"):
                c["icao"].add(r["icao"])
            c["end"] |= bool(r.get("end"))
        print(f"  matched codes: {len(cand)}")
    match = {}
    for iata, items in cand.items():
        icao = airports[iata]["icao"]
        same = [q for q, c in items.items() if icao and icao in c["icao"]]
        # Items with another ICAO code are other airports (an old one that had the code first); open ones are preferred.
        fits = same or [q for q, c in items.items() if not c["icao"] or not icao]
        fits.sort(key=lambda q: (items[q]["end"], -items[q]["sl"]))
        if fits:
            match[fits[0]] = iata
    qids = sorted(match)
    facts = {match[q]: {"qid": q} for q in qids}

    for part in chunks(qids):
        values = " ".join("wd:" + q for q in part)
        for r in sparql(f"""SELECT ?item ?cat ?img ?open ?prec ?en WHERE {{
  VALUES ?item {{ {values} }}
  OPTIONAL {{ ?item wdt:P373 ?cat }}
  OPTIONAL {{ ?item wdt:P18 ?img }}
  OPTIONAL {{ ?item p:P1619/psv:P1619 [ wikibase:timeValue ?open ; wikibase:timePrecision ?prec ] }}
  OPTIONAL {{ ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }}
}}"""):
            f = facts[match[r["item"]]]
            f.setdefault("cat", r.get("cat"))
            if r.get("img") and "img" not in f:
                f["img"] = urllib.parse.unquote(r["img"].rsplit("/", 1)[-1])
            if r.get("open"):
                d = date_text(r["open"], r.get("prec"))
                if d and (not f.get("open") or d < f["open"]):  # the earliest of several opening dates
                    f["open"] = d
            f.setdefault("en", r.get("en"))
        for r in sparql(f"""SELECT ?item ?op WHERE {{
  VALUES ?item {{ {values} }}
  ?item wdt:P137 ?o . ?o rdfs:label ?op . FILTER(LANG(?op) = "en")
}}"""):
            f = facts[match[r["item"]]]
            if r["op"] not in f.setdefault("op", []):
                f["op"].append(r["op"])
        for r in sparql(f"""SELECT ?item ?n ?t WHERE {{
  VALUES ?item {{ {values} }}
  ?item p:P3872 ?s . ?s ps:P3872 ?n ; pq:P585 ?t .
}}"""):
            f, y = facts[match[r["item"]]], int(r["t"][:4])
            n = round(float(r["n"]))
            if n > 0 and (not f.get("pax") or y > f["pax"][1]):
                f["pax"] = [n, y]
        for r in sparql(f"""SELECT ?item ?al WHERE {{
  VALUES ?item {{ {values} }}
  ?a wdt:P113 ?item . FILTER NOT EXISTS {{ ?a wdt:P576 ?gone }}
  ?a rdfs:label ?al . FILTER(LANG(?al) = "en")
}}"""):
            f = facts[match[r["item"]]]
            if r["al"] not in f.setdefault("hubs", []):
                f["hubs"].append(r["al"])
        print(f"  facts: {len(facts)} items, batch to {part[-1]}")
    for f in facts.values():
        for k in ("op", "hubs"):
            if k in f:
                f[k].sort()
    return facts


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    name_of = {c["iso3"]: c["name"] for c in countries.values() if c.get("iso3")}
    atlas = json.loads((ROOT / "data" / "atlas.json").read_text(encoding="utf-8"))["countries"]
    iso3_of = {c["a2"]: k for k, c in atlas.items() if c.get("a2")}
    oa_country = {c["code"]: c["name"] for c in table("countries.csv")}

    runways = {}
    for r in table("runways.csv"):
        if r["closed"] != "1":
            runways.setdefault(r["airport_ref"], []).append(r)

    airports = {}
    for a in table("airports.csv"):
        iata, t = a["iata_code"].strip(), TYPES.get(a["type"])
        if not iata or not t or (t in "HW" and a["scheduled_service"] != "yes"):
            continue
        lat, lon = float(a["latitude_deg"]), float(a["longitude_deg"])
        rws = runways.get(a["id"], [])
        lengths = [int(r["length_ft"]) for r in rws if r["length_ft"].isdigit()]
        iso3 = iso3_of.get(a["iso_country"])
        d = {"iata": iata, "icao": a["icao_code"].strip() or None, "name": a["name"].strip(), "t": t,
             "lon": round(lon, 5), "lat": round(lat, 5), "city": a["municipality"].strip() or None,
             "iso3": iso3, "country": name_of.get(iso3) or oa_country.get(a["iso_country"]),
             "elev": round(int(a["elevation_ft"]) * 0.3048) if a["elevation_ft"].lstrip("-").isdigit() else None,
             "sched": a["scheduled_service"] == "yes", "wiki": a["wikipedia_link"].strip() or None,
             "web": a["home_link"].strip() or None}
        if rws:
            d["rw"] = [len(rws), round(max(lengths) * 0.3048) if lengths else None, surfaces(r["surface"] for r in rws)]
        frame = span(rws, lat)
        if frame:
            d["frame"] = frame
        airports[iata] = d
    print(f"OurAirports: {len(airports)} airports")

    for iata, f in wikidata(airports).items():
        d = airports[iata]
        d.update({k: v for k, v in f.items() if v and k != "en"})
        if f.get("en") and not (d["wiki"] or "").startswith("https://en.wikipedia.org/"):
            d["wiki"] = f["en"]  # the English article, for the English summary

    rows = sorted(airports.values(), key=lambda d: d["iata"])
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "details").mkdir(exist_ok=True)
    built = datetime.date.today().isoformat()
    markers = {"built": built, **{k: [d[k] for d in rows] for k in ("iata", "name", "lon", "lat", "t")},
               "p": [round(d["pax"][0] / 1000) if d.get("pax") else 0 for d in rows]}  # thousands: which code wins label space
    (OUT / "markers.json").write_text(json.dumps(markers, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")
    for old in (OUT / "details").glob("*.json"):
        old.unlink()
    by_letter = {}
    for d in rows:
        by_letter.setdefault(d["iata"][0], {})[d["iata"]] = {k: v for k, v in d.items() if v is not None and k not in ("iata", "lon", "lat", "t", "name")}
    for letter, part in by_letter.items():
        (OUT / "details" / f"{letter}.json").write_text(json.dumps(part, ensure_ascii=False, separators=(",", ":")), encoding="utf-8", newline="\n")

    counts = {t: sum(d["t"] == t for d in rows) for t in TYPES.values()}
    size = lambda p: f"{p.stat().st_size / 1024:.0f} KB"
    print(f"types: {counts}; with Wikidata: {sum('qid' in d for d in rows)}; Commons category: {sum('cat' in d for d in rows)}; "
          f"passengers: {sum('pax' in d for d in rows)}; hubs: {sum('hubs' in d for d in rows)}")
    print(f"markers.json {size(OUT / 'markers.json')}; details: {len(by_letter)} files, "
          f"largest {size(max((OUT / 'details').glob('*.json'), key=lambda p: p.stat().st_size))}, total "
          f"{sum(p.stat().st_size for p in (OUT / 'details').glob('*.json')) / 1024:.0f} KB")


if __name__ == "__main__":
    main()

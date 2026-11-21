"""Build data/countries.json from the World Bank API and mledoze/countries.

Run from anywhere: python scripts/build_data.py
Standard library only. Also checks that every country code used in
data/hotspots.json and data/blocs.json exists in the built file.
"""
import datetime
import json
import pathlib
import unicodedata
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MAP_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"
MLEDOZE_URL = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
WB = "https://api.worldbank.org/v2"

# key -> (World Bank code, label, format used by the app, unit note)
INDICATORS = {
    "pop": ("SP.POP.TOTL", "Population", "count", ""),
    "gdp": ("NY.GDP.MKTP.CD", "GDP", "usd", "current US$"),
    "gdppc": ("NY.GDP.PCAP.CD", "GDP per person", "usd", "current US$"),
    "life": ("SP.DYN.LE00.IN", "Life expectancy", "years", ""),
    "mil": ("MS.MIL.XPND.GD.ZS", "Military spending", "pct", "% of GDP"),
    "fuel": ("TX.VAL.FUEL.ZS.UN", "Fuel exports", "pct", "% of goods exports"),
}
OLDEST_YEAR = 2015  # older "latest" values would mislead on a current map

# Map features without an ISO numeric code that the World Bank still covers.
NO_ID = {"Kosovo": "XKX"}
# Capital points the World Bank lacks, or gives as a point near the country's centre instead of the city.
CAPITAL_AT = {
    "TWN": [121.565, 25.033], "VAT": [12.453, 41.904], "PSE": [35.204, 31.904],
    "PAK": [73.05, 33.68], "VEN": [-66.90, 10.48], "BOL": [-68.12, -16.49], "MMR": [96.13, 19.76],
    "CIV": [-5.28, 6.83], "HND": [-87.21, 14.07], "MLI": [-8.00, 12.64], "LAO": [102.63, 17.98],
    "PLW": [134.62, 7.50], "CAF": [18.56, 4.39], "MDG": [47.52, -18.91], "TUR": [32.85, 39.93],
    "GNB": [-15.60, 11.86], "SWZ": [31.14, -26.31], "CRI": [-84.09, 9.93], "LSO": [27.48, -29.32],
    "GNQ": [10.82, 1.58],
}
# Capitals that moved after the World Bank list was written (Equatorial Guinea: decree of January 2026).
CAPITAL_BY_ISO = {"GNQ": "Ciudad de la Paz"}
# Natural Earth abbreviations for shapes with no country record (keys stay as they are).
NAME_FIX = {"N. Cyprus": "Northern Cyprus", "Indian Ocean Ter.": "Australian Indian Ocean Territories"}
# Alternative spellings that are ordinary words and would hijack search.
ALT_STOPWORDS = {"island"}
# States with limited recognition whose capitals still belong on the Capitals layer.
LIMITED_RECOGNITION = {"TWN", "XKX", "PSE"}
# Outdated or garbled World Bank capital names (coordinates stay theirs).
CAPITAL_NAME_FIX = {"Kiev": "Kyiv", "Noum'ea": "Nouméa", "Agana": "Hagåtña", "Koror": "Ngerulmud"}
# Sovereignty tiers beyond UN membership, and former names people still search for.
PATCHES = json.loads((ROOT / "scripts" / "patches.json").read_text(encoding="utf-8"))


def plain(s):
    return unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()


def capital_name(wb_name, m):
    """World Bank names drop accents; use mledoze's spelling when it is the same city."""
    for name in (m or {}).get("capital") or []:
        if plain(name) == plain(wb_name):
            return name
    return CAPITAL_NAME_FIX.get(wb_name, wb_name)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "borderline-interesting-data-build"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def main():
    topo = get(MAP_URL)
    mledoze = get(MLEDOZE_URL)
    by_ccn3 = {c["ccn3"]: c for c in mledoze if c.get("ccn3")}
    by_name = {c["name"]["common"]: c for c in mledoze}

    wb_countries = {c["id"]: c for c in get(f"{WB}/country?format=json&per_page=400")[1]}
    values = {}
    for key, (code, *_) in INDICATORS.items():
        rows = get(f"{WB}/country/all/indicator/{code}?format=json&mrnev=1&per_page=400")[1] or []
        for r in rows:
            if r["value"] is not None and int(r["date"]) >= OLDEST_YEAR:
                values.setdefault(r["countryiso3code"], {})[key] = [r["value"], int(r["date"])]

    out = {}
    for g in topo["objects"]["countries"]["geometries"]:
        name = g["properties"]["name"]
        key = g.get("id") or name
        m = by_ccn3.get(g.get("id")) or by_name.get(name)
        iso3 = NO_ID.get(name) or (m["cca3"] if m else None)
        rec = {"name": m["name"]["common"] if m else NAME_FIX.get(name, name)}
        if iso3:
            wb = wb_countries.get(iso3)
            rec["iso3"] = iso3
            capital = (wb and wb["capitalCity"] and capital_name(wb["capitalCity"], m)) or (m and (m.get("capital") or [None])[0])
            capital = CAPITAL_BY_ISO.get(iso3, capital)
            if capital:
                rec["capital"] = capital
            if iso3 in CAPITAL_AT:
                rec["capitalAt"] = CAPITAL_AT[iso3]
            elif wb and wb["longitude"]:
                rec["capitalAt"] = [round(float(wb["longitude"]), 3), round(float(wb["latitude"]), 3)]
            if m:
                rec["region"] = m.get("subregion") or m.get("region")
                rec["landlocked"] = m["landlocked"]
                rec["area"] = m.get("area")
                rec["sov"] = bool(m.get("independent") or m.get("unMember")) or iso3 in LIMITED_RECOGNITION
                # Other names people search for: ISO2, official name, common alternatives.
                alt = {m["cca2"], m["name"]["official"], *m.get("altSpellings", []), *PATCHES["aliases"].get(iso3, [])} - {rec["name"], ""}
                rec["alt"] = sorted(a for a in alt if len(a) > 1 and a.lower() not in ALT_STOPWORDS)
            elif iso3 in LIMITED_RECOGNITION:
                rec["sov"] = True
            # un, observer, defacto, special or dependent; the app's "UN 193" filter keeps only "un".
            rec["status"] = PATCHES["status"].get(iso3) or ("un" if m and m.get("unMember") else "defacto" if rec.get("sov") else "dependent")
            if wb and wb["incomeLevel"]["value"] not in ("", "Not classified", "Aggregates"):
                rec["income"] = wb["incomeLevel"]["value"]
            if iso3 in values:
                rec["v"] = values[iso3]
        out[key] = rec

    years = sorted({v[1] for c in out.values() for v in c.get("v", {}).values()})
    data = {
        "built": datetime.date.today().isoformat(),
        "years": [years[0], years[-1]] if years else [],
        "indicators": {k: {"code": c, "name": n, "fmt": f, "note": u} for k, (c, n, f, u) in INDICATORS.items()},
        "countries": out,
    }

    # Self-checks: wrong joins or an API change would show up here.
    iso = {c.get("iso3") for c in out.values()}
    assert len(out) >= 230, len(out)
    assert out["704"]["iso3"] == "VNM" and out["704"]["capital"] == "Hanoi"
    assert out["068"]["landlocked"] is True
    assert out["804"]["capital"] == "Kyiv" and out["076"]["capital"] == "Brasília"
    assert "US" in out["840"]["alt"] and "GB" in out["826"]["alt"]
    assert 190 <= sum(bool(c.get("sov")) for c in out.values()) <= 205
    un = {c["iso3"] for c in out.values() if c.get("status") == "un"}
    print(f"UN members on the map: {len(un)}")
    assert 185 <= len(un) <= 193 and {"DEU", "SWZ", "NRU"} <= un and not un & {"TWN", "XKX", "PSE", "VAT"}
    assert "Swaziland" in out["748"]["alt"] and "Persia" in out["364"]["alt"]
    assert all(c.get("capitalAt") for c in out.values() if c.get("sov")), "sovereign state without a capital point"
    assert "Island" not in out["352"]["alt"] and out["N. Cyprus"]["name"] == "Northern Cyprus"
    assert out["586"]["capitalAt"] == [73.05, 33.68] and out["585"]["capital"] == "Ngerulmud"
    assert out["140"]["capitalAt"] == [18.56, 4.39] and out["226"]["capital"] == "Ciudad de la Paz"
    assert sum("gdppc" in c.get("v", {}) for c in out.values()) >= 180
    assert out["840"]["v"]["gdp"][0] > out["156"]["v"]["gdp"][0] > 1e13
    for f in ("hotspots.json", "blocs.json"):
        p = ROOT / "data" / f
        if p.exists():
            doc = json.loads(p.read_text(encoding="utf-8"))
            items = (doc.get("items") or doc.get("blocs")) + doc.get("contested", [])
            used = {c for it in items for k in ("countries", "members", "partners", "also") for c in it.get(k, [])}
            used |= {it[k] for it in items for k in ("holder", "claimant") if k in it}
            assert not used - iso, f"{f}: unknown codes {sorted(used - iso)}"

    path = ROOT / "data" / "countries.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({len(out)} countries, data years {data['years']})")


if __name__ == "__main__":
    main()

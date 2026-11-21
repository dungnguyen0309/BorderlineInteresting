"""Build data/atlas.json: names, codes, capitals, 50-year trends, age pyramid, economy mix and military series per country.

Run after build_data.py: python scripts/build_atlas.py
Standard library only. app.js fetches the file the first time a country panel opens.
"""
import concurrent.futures
import datetime
import json
import pathlib
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
MLEDOZE_URL = "https://raw.githubusercontent.com/mledoze/countries/master/countries.json"
WB = "https://api.worldbank.org/v2"
FIRST_YEAR = 1976
OLDEST_YEAR = 2010  # latest values older than this are left out
PATCHES = json.loads((ROOT / "scripts" / "patches.json").read_text(encoding="utf-8"))
# Kosovo: the World Bank and this app use XKX, mledoze uses UNK.
MLEDOZE_CODE = {"XKX": "UNK"}

# Latest values for the People and Economy tabs: key -> World Bank code.
LATEST = {
    "growth": "SP.POP.GROW", "urban": "SP.URB.TOTL.IN.ZS", "lifeM": "SP.DYN.LE00.MA.IN", "lifeF": "SP.DYN.LE00.FE.IN",
    "fert": "SP.DYN.TFRT.IN", "birth": "SP.DYN.CBRT.IN", "death": "SP.DYN.CDRT.IN", "infant": "SP.DYN.IMRT.IN",
    "ppp": "NY.GDP.MKTP.PP.CD", "gdpGrowth": "NY.GDP.MKTP.KD.ZG", "infl": "FP.CPI.TOTL.ZG", "unemp": "SL.UEM.TOTL.ZS",
    "net": "IT.NET.USER.ZS", "gini": "SI.POV.GINI", "forest": "AG.LND.FRST.ZS", "co2": "EN.GHG.CO2.PC.CE.AR5",
    "agri": "NV.AGR.TOTL.ZS", "ind": "NV.IND.TOTL.ZS", "serv": "NV.SRV.TOTL.ZS",
    "fossil": "EG.ELC.FOSL.ZS", "nuc": "EG.ELC.NUCL.ZS", "ren": "EG.ELC.RNEW.ZS",
    # Security tab: military spending as a share of government spending (SIPRI), armed forces share of the labour force (IISS).
    "milGov": "MS.MIL.XPND.ZS", "milLab": "MS.MIL.TOTL.TF.ZS",
}
SERIES = {"pop": "SP.POP.TOTL", "gdp": "NY.GDP.MKTP.CD"}
# Security tab yearly series from MIL_FIRST_YEAR, stored under "mil" and aligned to the top-level "milYears".
# gdp: % of GDP; usd: millions of current US$; pers: armed forces personnel; imp/exp: millions of SIPRI TIV.
MIL_FIRST_YEAR = 1990
MIL_SERIES = {"gdp": "MS.MIL.XPND.GD.ZS", "usd": "MS.MIL.XPND.CD", "pers": "MS.MIL.TOTL.P1",
              "imp": "MS.MIL.MPRT.KD", "exp": "MS.MIL.XPRT.KD"}
MIL_ROUND = {"gdp": lambda v: round(v, 2), "usd": lambda v: round(v / 1e6) if v >= 1e8 else round(v / 1e6, 1),
             "pers": round, "imp": lambda v: round(v / 1e6), "exp": lambda v: round(v / 1e6)}
# 100% bars are built only from a year every part shares, so shares from different years never add up.
MIXES = {"elec": ["fossil", "nuc", "ren"], "sec": ["agri", "ind", "serv"]}
# Lowest believable total for a bar: sector shares leave out only taxes less subsidies (every real row is 78+).
MIX_FLOOR = {"elec": 0, "sec": 75}
# Five-year age bands; each value is the band's share of that sex's population.
BANDS = ["0004", "0509", "1014", "1519", "2024", "2529", "3034", "3539", "4044", "4549",
         "5054", "5559", "6064", "6569", "7074", "7579", "80UP"]


def get(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "borderline-interesting-data-build"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


def latest(code):
    rows = get(f"{WB}/country/all/indicator/{code}?format=json&mrnev=1&per_page=500")[1] or []
    return {r["countryiso3code"]: [round(r["value"], 2), int(r["date"])]
            for r in rows if r["value"] is not None and int(r["date"]) >= OLDEST_YEAR}


def series(code, start=FIRST_YEAR):
    year = datetime.date.today().year
    rows = get(f"{WB}/country/all/indicator/{code}?format=json&date={start}:{year}&per_page=20000")[1] or []
    out = {}
    for r in rows:
        if r["value"] is not None:
            out.setdefault(r["countryiso3code"], {})[int(r["date"])] = r["value"]
    return out


def calling(idd):
    root, suf = idd.get("root") or "", idd.get("suffixes") or []
    if not root:
        return []
    # NANP and similar plans list hundreds of area codes; the country code alone is what people dial first.
    return [root] if len(suf) != 1 else [root + suf[0]]


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    isos = sorted({c["iso3"] for c in countries.values() if c.get("iso3")})
    mledoze = {c["cca3"]: c for c in get(MLEDOZE_URL)}

    codes = {**{k: ("latest", v) for k, v in LATEST.items()},
             **{k: ("series", v) for k, v in SERIES.items()},
             **{"y_" + k: ("recent", LATEST[k]) for parts in MIXES.values() for k in parts},
             **{f"{b}{s}": ("latest", f"SP.POP.{b}.{s}.5Y") for b in BANDS for s in ("MA", "FE")},
             **{"m_" + k: ("mil", v) for k, v in MIL_SERIES.items()}}
    fetch = {"latest": latest, "series": series, "recent": lambda code: series(code, OLDEST_YEAR),
             "mil": lambda code: series(code, MIL_FIRST_YEAR)}
    with concurrent.futures.ThreadPoolExecutor(6) as pool:
        futures = {k: pool.submit(fetch[kind], code) for k, (kind, code) in codes.items()}
        got = {k: f.result() for k, f in futures.items()}

    last_year = max(y for s in SERIES for c in got[s].values() for y in c)
    years = list(range(FIRST_YEAR, last_year + 1))
    mil_years = list(range(MIL_FIRST_YEAR, max(y for k in MIL_SERIES for c in got["m_" + k].values() for y in c) + 1))
    left = set(PATCHES["leftDriving"])
    out = {}
    for iso in isos:
        m = mledoze.get(MLEDOZE_CODE.get(iso, iso)) or {}
        rec = {}
        if m:
            natives = {}
            for lang, n in (m["name"].get("native") or {}).items():
                natives.setdefault(n["official"], lang)
            dem = (m.get("demonyms") or {}).get("eng") or {}
            rec.update({
                "official": m["name"]["official"],
                "native": [[lang, name] for name, lang in natives.items() if name != m["name"]["official"]],
                "demonym": dem.get("m") if dem.get("m") == dem.get("f") else " / ".join(x for x in (dem.get("m"), dem.get("f")) if x),
                "a2": m.get("cca2"), "num": m.get("ccn3"), "ioc": m.get("cioc") or None,
                "tld": m.get("tld") or [], "call": calling(m.get("idd") or {}),
                "cur": [[k, v.get("name"), v.get("symbol")] for k, v in (m.get("currencies") or {}).items()],
                "lang": list((m.get("languages") or {}).values()),
                "drive": "left" if iso in left else "right",
            })
        if iso in PATCHES["capitals"]:
            rec["caps"] = PATCHES["capitals"][iso]
        if iso in PATCHES["aliases"]:
            rec["also"] = PATCHES["aliases"][iso]
        rec["doubly"] = iso in PATCHES["doublyLandlocked"] or None
        for k in SERIES:
            s = got[k].get(iso, {})
            if len(s) >= 2:
                # GDP in millions of US$ keeps the file small; the app scales it back.
                rec[k] = [None if y not in s else round(s[y] / 1e6) if k == "gdp" else round(s[y]) for y in years]
        mil = {}
        for k in MIL_SERIES:
            s = got["m_" + k].get(iso, {})
            if s:
                mil[k] = [MIL_ROUND[k](s[y]) if y in s else None for y in mil_years]
                while mil[k][-1] is None:  # trailing gaps only cost bytes; the app pads to milYears
                    mil[k].pop()
        if mil:
            rec["mil"] = mil
        pyr = [[got[f"{b}MA"].get(iso), got[f"{b}FE"].get(iso)] for b in BANDS]
        if all(m_ and f_ for m_, f_ in pyr):
            rec["pyr"] = [[m_[0], f_[0]] for m_, f_ in pyr]
            rec["pyrYear"] = pyr[0][0][1]
        x = {k: got[k][iso] for k in LATEST if iso in got[k]}
        if x:
            rec["x"] = x
        for mix, parts in MIXES.items():
            by_year = [got["y_" + p].get(iso, {}) for p in parts]
            shared = set.intersection(*(set(s) for s in by_year))
            if shared:
                y = max(shared)
                vals = [round(s[y], 2) for s in by_year]
                if not any(vals):
                    # An all-zero row (Venezuela's sectors, 2011) is a gap in the source, not a real 0%.
                    for p in parts:
                        if x.get(p, [None, None])[1] == y and not x[p][0]:
                            x.pop(p)
                    continue
                # Shares above 100, or sectors far below it (Lebanon's broken 2024 rows), are inconsistent
                # source rows: the app then lists the parts as separate figures instead of drawing a bar.
                if MIX_FLOOR[mix] < sum(vals) <= 100.5:
                    rec[mix] = [y, *vals]
        if x:
            rec["x"] = x
        else:
            rec.pop("x", None)
        out[iso] = {k: v for k, v in rec.items() if v not in (None, [], "")}

    data = {"built": datetime.date.today().isoformat(), "years": [years[0], years[-1]],
            "milYears": [mil_years[0], mil_years[-1]], "countries": out}

    # Self-checks: a changed source shape or a wrong join would show up here.
    assert len(out) >= 230, len(out)
    assert [c["name"] for c in out["ZAF"]["caps"]] == ["Pretoria", "Cape Town", "Bloemfontein"]
    assert out["NRU"]["caps"][0]["type"] == "De facto capital"
    assert out["USA"]["call"] == ["+1"] and out["DEU"]["call"] == ["+49"]
    assert out["GBR"]["drive"] == "left" and out["DEU"]["drive"] == "right"
    assert out["DEU"]["pop"][-1] > 80e6 and sum(v is not None for v in out["DEU"]["pop"]) >= 40
    assert out["CHN"]["gdp"][-1] > 1e7  # millions of US$
    assert abs(sum(m_ for m_, _ in out["JPN"]["pyr"]) - 100) < 1.5
    assert "lang" in out["XKX"] and out["UZB"]["doubly"] is True
    assert out["SWZ"]["also"] == ["Swaziland"]
    assert all(MIX_FLOOR[m] < sum(c[m][1:]) <= 100.5 for c in out.values() for m in MIXES if m in c)
    assert "sec" not in out["VEN"] and "sec" not in out["LBN"]
    assert out["DEU"]["elec"][0] <= min(out["DEU"]["x"][k][1] for k in MIXES["elec"])
    assert out["USA"]["mil"]["usd"][0] > 250000 and out["USA"]["mil"]["gdp"][0] > 4  # 1990, millions of US$
    assert all(len(v) <= len(mil_years) for c in out.values() for v in c.get("mil", {}).values())
    assert out["DEU"]["mil"]["pers"][-1] > 100000 and "milGov" in out["DEU"]["x"]
    assert max(v or 0 for v in out["USA"]["mil"]["exp"]) > 5000  # millions of TIV
    print("military series:", {k: sum(k in c.get("mil", {}) for c in out.values()) for k in MIL_SERIES})
    print("100% bars:", {m: sum(m in c for c in out.values()) for m in MIXES})

    path = ROOT / "data" / "atlas.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {path} ({len(out)} countries, {path.stat().st_size // 1024} KB, years {data['years']})")


if __name__ == "__main__":
    main()

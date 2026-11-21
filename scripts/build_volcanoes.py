"""Build data/maps/volcanoes/volcanoes.json: every Holocene volcano in the Smithsonian Global Volcanism Program's
Volcanoes of the World, with the people living near it and, where it was scored, the GAR15 Volcanic Hazard Index.

Run: python scripts/build_volcanoes.py
Standard library only. Re-run when GVP publishes a new Volcanoes of the World version (set VOTW below).
Sources:
  GVP GeoServer WFS (no CORS, so it is snapshotted here): Holocene volcanoes, and population within 10/30/100 km.
  GVM / IAVCEI for UNISDR GAR15 (2015), from HDX: hazard class (VHI I-III) and Population Exposure Index (PEI 1-7).
  Volcanoes are joined on the GVP volcano number (GAR15 VolcanoID). Names always come from GVP.
"""
import datetime
import json
import math
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "volcanoes" / "volcanoes.json"
UA = "Borderline-Interesting-research-map/1.0 (static site build script)"
VOTW = "5.4.0 (7 Aug 2026)"
WFS = "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows"
GAR15 = ("https://data.humdata.org/dataset/a60ac839-920d-435a-bf7d-25855602699d/resource/"
         "7234d067-2d74-449a-9c61-22ae6d98d928/download/volcano.json")
VOLCANO_FIELDS = ["Volcano_Number", "Volcano_Name", "Country", "Primary_Volcano_Type", "Longitude", "Latitude",
                  "Elevation", "Last_Eruption_Year", "Evidence_Category", "Tectonic_Setting", "Major_Rock_Type"]
POP_FIELDS = ["VolcanoNumber", "Within_10km", "Within_30km", "Within_100km"]
COLS = ["n", "name", "country", "type", "lon", "lat", "elev", "last", "evidence", "setting", "rock",
        "vhi", "pei", "p10", "p30", "p100"]


def get_json(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))


def wfs(layer, fields):
    q = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeName": f"GVP-VOTW:{layer}",
         "outputFormat": "application/json", "propertyName": ",".join(fields)}
    return [f["properties"] for f in get_json(f"{WFS}?{urllib.parse.urlencode(q)}")["features"]]


def whole(v):
    """GAR15 writes missing values as the text 'NULL'."""
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def km(la1, lo1, la2, lo2):
    """Great-circle distance in km."""
    p1, p2, dl = math.radians(la1), math.radians(la2), math.radians(lo2 - lo1)
    c = math.sin(p1) * math.sin(p2) + math.cos(p1) * math.cos(p2) * math.cos(dl)
    return 6371 * math.acos(max(-1.0, min(1.0, c)))


def main():
    volcanoes = wfs("Smithsonian_VOTW_Holocene_Volcanoes", VOLCANO_FIELDS)
    time.sleep(2)
    pop = {p["VolcanoNumber"]: p for p in wfs("E3WebApp_HoloceneVolcanoes", POP_FIELDS)}
    time.sleep(2)
    gar = {f["properties"]["VolcanoID"]: f["properties"] for f in get_json(GAR15)["features"]}

    # Scored GAR15 volcanoes whose number is no longer in GVP's Holocene list. Checked 2026-11-16: none has a GVP
    # volcano within 3 km (nearest: 264200 21.7 km, 290170 3.2 km Milna, 311161 5.7 km Atka complex, 355070 94 km),
    # so their scores are not moved to another volcano. A new number here means GVP changed again: check it by hand.
    numbers = {v["Volcano_Number"] for v in volcanoes}
    lost = sorted(k for k, g in gar.items() if k not in numbers and whole(g.get("hazard")))
    for k in lost:
        g, la, lo = gar[k], float(gar[k]["Latitude"]), float(gar[k]["Longitude"])
        near = min(volcanoes, key=lambda v: km(la, lo, v["Latitude"], v["Longitude"]))
        print(f'scored in GAR15, not in GVP Holocene list: {k}; nearest GVP {near["Volcano_Number"]} '
              f'{near["Volcano_Name"]} {km(la, lo, near["Latitude"], near["Longitude"]):.1f} km')
    assert lost == [264200, 290170, 311161, 355070], lost

    rows = []
    for v in sorted(volcanoes, key=lambda v: v["Volcano_Number"]):
        n, p, g = v["Volcano_Number"], pop.get(v["Volcano_Number"], {}), gar.get(v["Volcano_Number"], {})
        hazard = whole(g.get("hazard"))
        rows.append([
            n, v["Volcano_Name"], v["Country"], v["Primary_Volcano_Type"],
            round(v["Longitude"], 3), round(v["Latitude"], 3), v["Elevation"], v["Last_Eruption_Year"],
            v["Evidence_Category"], v["Tectonic_Setting"], v["Major_Rock_Type"],
            # 0 = in GAR15 but not scored (too little eruption history); None = not in GAR15 at all.
            hazard if hazard else (0 if g else None), whole(g.get("PEI")),
            p.get("Within_10km"), p.get("Within_30km"), p.get("Within_100km"),
        ])

    # Self-check: the snapshot is whole and the joins worked.
    assert len(rows) > 1100, len(rows)
    assert all(-180 <= r[4] <= 180 and -90 <= r[5] <= 90 for r in rows)
    scored = sum(1 for r in rows if r[11])
    in_gar = sum(1 for r in rows if r[11] is not None)
    with_pop = sum(1 for r in rows if r[13] is not None)
    assert scored > 250 and with_pop > 1000, (scored, with_pop)
    assert abs(km(0, 0, 0, 1) - 111.19) < 0.01  # distance helper sanity

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out = {"votw": VOTW, "fetched": datetime.date.today().isoformat(), "cols": COLS, "rows": rows}
    OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{len(rows)} volcanoes, {in_gar} in GAR15 ({scored} with a hazard class), {with_pop} with population;"
          f" {OUT.stat().st_size:,} bytes -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

"""Build data/maps/earthquakes/m6-since-1900.json: every magnitude 6+ event in the USGS ComCat catalogue since 1900.

Run: python scripts/build_earthquakes.py
Standard library only. The Earthquakes map type loads the file when "Since 1900" is chosen; the recent periods
come live from the USGS feeds instead. Events before about 1973 are mostly ISC-GEM (CC BY-SA 3.0), the rest
U.S. public domain, so the file is offered under CC BY-SA 3.0.
"""
import csv
import datetime
import io
import json
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "maps" / "earthquakes" / "m6-since-1900.json"
FDSN = "https://earthquake.usgs.gov/fdsnws/event/1/query"
UA = "Borderline-Interesting-research-map/1.0 (static site build script)"
MIN_MAG = 6
STEP_YEARS = 20  # about 3,000 events a window, well under the service's 20,000 limit


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180) as r:
                return r.read().decode("utf-8")
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(10 * (i + 1))


def num(s, nd):
    return round(float(s), nd) if s not in ("", None) else None


def main():
    today = datetime.date.today()
    rows, seen = [], set()
    for start in range(1900, today.year + 1, STEP_YEARS):
        end = min(start + STEP_YEARS, today.year + 1)
        q = urllib.parse.urlencode({"format": "csv", "starttime": f"{start}-01-01", "endtime": f"{end}-01-01",
                                    "minmagnitude": MIN_MAG, "orderby": "time-asc"})
        text = get(f"{FDSN}?{q}")
        n = 0
        for r in csv.DictReader(io.StringIO(text)):
            if r["id"] in seen or not r["mag"]:
                continue
            seen.add(r["id"])
            t = datetime.datetime.fromisoformat(r["time"].replace("Z", "+00:00"))
            rows.append([num(r["longitude"], 3), num(r["latitude"], 3), num(r["depth"], 1), num(r["mag"], 2),
                         r["magType"], int(t.timestamp()), r["id"], r["place"], r["status"],
                         "" if r["type"] == "earthquake" else r["type"]])
            n += 1
        print(f"{start}-{end - 1}: {n} events")
        time.sleep(2)  # be gentle with the service
    rows.sort(key=lambda r: r[5])
    assert len(rows) > 10000 and all(r[3] >= MIN_MAG for r in rows), "unexpected catalogue response"
    nets = {}
    for r in rows:
        net = "iscgem" if r[6].startswith("iscgem") else "other"
        nets[net] = nets.get(net, 0) + 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "built": today.isoformat(), "minMag": MIN_MAG, "count": len(rows), "iscgem": nets.get("iscgem", 0),
        "fields": ["lon", "lat", "depthKm", "mag", "magType", "timeUnix", "id", "place", "status", "type"],
        "source": "USGS ANSS ComCat (FDSN event service); ISC-GEM events CC BY-SA 3.0",
        "rows": rows,
    }, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} events, {nets.get('iscgem', 0)} from ISC-GEM, {OUT.stat().st_size:,} bytes -> {OUT}")


if __name__ == "__main__":
    main()

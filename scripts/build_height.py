"""Build data/people/height.json: mean adult height of men and women by country and birth year.

Source: NCD Risk Factor Collaboration (NCD-RisC), "A century of trends in adult human height",
eLife 2016;5:e13410 (CC BY 4.0). Estimates come from NCD-RisC's CSV, which states no licence of its
own (the paper has no source-data file); the number of measurement studies per country comes from the
paper's Supplementary file 3. Standard library only.
Run after build_data.py, which provides the list of countries:  python scripts/build_height.py
"""
import collections
import csv
import datetime
import html
import http.client
import io
import json
import pathlib
import re
import time
import urllib.parse
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
# The bare domain: www.ncdrisc.org answers 421 Misdirected Request more often.
CSV_URL = "https://ncdrisc.org/downloads/height/NCD_RisC_eLife_2016_height_age18_countries.csv"
STUDIES_URL = "https://cdn.elifesciences.org/articles/13410/elife-13410-supp3-v2.xlsx"
PAPER_URL = "https://doi.org/10.7554/eLife.13410"
# Every second birth year (1896, 1898 ... 1996): every year doubles the file to about 1 MB.
# The model's trends are smooth, so the skipped years sit between their neighbours.
STEP = 2


def get(url, tries=8):
    # http.client, not urllib: urllib always sends "Connection: close", and ncdrisc.org resets those requests.
    u = urllib.parse.urlsplit(url)
    for i in range(tries):
        wait = None
        try:
            c = http.client.HTTPSConnection(u.netloc, timeout=90)
            c.request("GET", u.path, headers=UA)
            r = c.getresponse()
            body, wait = r.read(), r.getheader("Retry-After")
            c.close()
        except OSError as e:  # connection reset or timeout
            err = e
        else:
            if r.status == 200:
                return body
            if r.status < 500 and r.status not in (421, 429):
                # A moved or missing file will not come back on a retry; redirects are not followed.
                loc = r.getheader("Location")
                raise RuntimeError(f"HTTP {r.status} for {url}" + (f" (Location: {loc})" if loc else ""))
            err = OSError(f"HTTP {r.status} for {url}")
        if i == tries - 1:
            raise err
        # ncdrisc.org answers about half of all requests with 421 Misdirected Request; 429 asks us to slow down.
        time.sleep(int(wait) if wait and wait.isdigit() else 3 * (i + 1))


def estimates(text):
    """{ISO3: {"name": ..., "men": [[year, cm, lo, hi], ...], "women": [...]}} from the NCD-RisC CSV."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        year = int(r["Year of birth"])
        rec = out.setdefault(r["ISO"], {"name": r["Country"], "men": [], "women": []})
        assert rec["name"] == r["Country"], (r["ISO"], rec["name"], r["Country"])
        if (year - 1896) % STEP == 0:
            rec[r["Sex"].lower()].append([year] + [round(float(r[k]), 1) for k in (
                "Mean height (cm)",
                "Mean height lower 95% uncertainty interval (cm)",
                "Mean height upper 95% uncertainty interval (cm)")])
    return out


def studies(xlsx):
    """{country name: [studies with men, studies with women]} from Supplementary file 3 (one row per study)."""
    z = zipfile.ZipFile(io.BytesIO(xlsx))
    strings = [html.unescape(re.sub(r"<[^>]+>", "", s))
               for s in re.findall(r"<si>(.*?)</si>", z.read("xl/sharedStrings.xml").decode("utf-8"), re.S)]
    count = collections.defaultdict(lambda: [0, 0])
    for row in re.findall(r"<row[^>]*>(.*?)</row>", z.read("xl/worksheets/sheet1.xml").decode("utf-8"), re.S):
        cells = {}
        for col, attrs, inner in re.findall(r'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)', row, re.S):
            v = re.search(r"<v>(.*?)</v>", inner)
            v = v.group(1) if v else ""
            cells[col] = (strings[int(v)] if 't="s"' in attrs and v else v).strip()
        # Columns: A country, H men's sample size, I women's. The two header rows have no numbers.
        for i, col in enumerate("HI"):
            if re.fullmatch(r"\d+(\.\d+)?", cells.get(col, "")) and float(cells[col]) > 0:
                count[cells["A"]][i] += 1
    return count


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    app = {c["iso3"]: c["name"] for c in countries.values() if c.get("iso3")}
    est = estimates(get(CSV_URL).decode("utf-8-sig"))
    n_studies = studies(get(STUDIES_URL))

    # The CSV carries its own ISO3 codes; print where its name differs from ours so a wrong code shows up.
    for iso, rec in sorted(est.items()):
        if iso not in app:
            print("not on the map, left out:", iso, rec["name"])
        elif app[iso] != rec["name"]:
            print("name differs:", iso, rec["name"], "/", app[iso])
    by_name = {rec["name"]: iso for iso, rec in est.items()}
    unmatched = sorted(set(n_studies) - set(by_name))
    assert not unmatched, unmatched  # Supplementary file 3 uses the CSV's country names

    out = {}
    for iso, rec in sorted(est.items()):
        if iso in app:
            men, women = n_studies.get(rec["name"], [0, 0])
            out[iso] = {"men": rec["men"], "women": rec["women"], "studies": {"men": men, "women": women}}

    # Self-checks against figures printed in the paper: a changed file or a bad join shows up here.
    def at(iso, sex, year):
        return next(p[1:] for p in out[iso][sex] if p[0] == year)
    assert at("SWE", "women", 1896) == [160.3, 158.2, 162.4]
    assert at("LAO", "men", 1896) == [152.9, 147.9, 157.9]
    assert at("GTM", "women", 1896) == [140.3, 135.8, 144.8]
    assert at("NLD", "men", 1996) == [182.5, 180.6, 184.5]
    assert abs(at("KOR", "women", 1996)[0] - at("KOR", "women", 1896)[0] - 20.2) <= 0.1
    assert abs(at("IRN", "men", 1996)[0] - at("IRN", "men", 1896)[0] - 16.5) <= 0.1
    assert len(est) == 200 and len(out) >= 195, (len(est), len(out))
    assert sum(1 for r in est.values() if n_studies.get(r["name"])) == 179  # "data for 179 of the 200 countries"
    assert all(len(r[s]) == 100 // STEP + 1 for r in out.values() for s in ("men", "women"))
    assert all(p[2] <= p[1] <= p[3] for r in out.values() for s in ("men", "women") for p in r[s])

    data = {
        "built": datetime.date.today().isoformat(),
        "source": "NCD Risk Factor Collaboration (NCD-RisC), A century of trends in adult human height, eLife 2016;5:e13410",
        "url": PAPER_URL,
        "data": CSV_URL,
        "licence": "Paper and supplementary files: CC BY 4.0. The CSV on ncdrisc.org states no licence of its own.",
        "credit": ("Height: NCD Risk Factor Collaboration (NCD-RisC), A century of trends in adult human height, eLife 2016 "
                   "(CC BY 4.0). Estimates from ncdrisc.org, rounded to 0.1 cm, every second birth year."),
        "basis": ("Modelled mean height at age 18 of people born in a given year (1896-1996, every second year), "
                  "in cm, with the 95% credible interval. Not current measurements: the latest cohort turned 18 in 2014. "
                  "Only 72 of the 200 countries have any measurements of people born in 1920 or earlier, and 134 of "
                  "people born 1921-1945; elsewhere, early values come mostly from the model. "
                  "NCD-RisC now lists this adult release among its archived estimates; its newer height release "
                  "(Lancet 2020) covers ages 5-19 only."),
        "studies": ("Number of measurement studies with data for each sex (eLife 2016, Supplementary file 3). "
                    "0 means no measured data for that sex in this country; the estimate is borrowed from other "
                    "countries' data, mostly from the same region."),
        "countries": out,
    }
    path = ROOT / "data" / "people" / "height.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    no_data = sorted(iso for iso, r in out.items() if not any(r["studies"].values()))
    print(f"wrote {path} ({len(out)} countries, {path.stat().st_size // 1024} KB; no data at all: {' '.join(no_data)})")


if __name__ == "__main__":
    main()

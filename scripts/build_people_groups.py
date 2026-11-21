"""Build data/people/ethnic.json and data/people/blood.json.

Ethnic groups: CIA World Factbook through the factbook/factbook.json mirror (public domain).
Blood groups: Wikipedia, "Blood type distribution by country" (CC BY-SA 4.0), pinned to one revision.
That table is disputed and 10 of 25 rows checked against their cited source were wrong, so only rows
checked by hand (CHECKED) are kept. Standard library only. Run after build_data.py:  python scripts/build_people_groups.py
"""
import concurrent.futures
import datetime
import html
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from build_profiles import ALIAS, BACK, FACTBOOK_RAW, FACTBOOK_TREE, FIPS_FALLBACK, plain, religion_record

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "people"
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
SPARQL = "https://query.wikidata.org/sparql?format=json&query="
BLOOD_PAGE = "Blood type distribution by country"
BLOOD_REVID = 1378379911  # the revision the CHECKED rows were compared against; re-check before moving it
TYPES = ["O+", "A+", "B+", "AB+", "O-", "A-", "B-", "AB-"]
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
# Rows whose eight figures were compared by hand with the page they cite (November 2026) and match it.
# All nine pages state a share of the national population and give no method or sample size.
CHECKED = {
    "GBR": "NHS Blood and Transplant", "USA": "Stanford Blood Center", "NLD": "Sanquin",
    "DEU": "DRK-Blutspendedienst", "CHE": "Blutspende SRK Schweiz", "CZE": "Czech Red Cross (Prague 1)",
    "FIN": "Finnish Red Cross Blood Service", "POL": "krwiodawcy.org", "SWE": "Geblod.nu",
}
# Rows checked by hand against the source they cite (November 2026) that do not match it.
MISMATCH = {
    "Canada": "Canadian Blood Services now gives O+ 37%, A+ 31%; the table has 39% and 36%",
    "Hong Kong": "the paper gives ABO totals for Chinese donors (A 25.8%, B 25.5%); the table swaps A and B and adds Rh- on top",
    "Mexico": "the paper gives O+ 59.26%, A+ 26.08%, O- 2.56%; the table has 59.09%, 26.23%, 2.73%",
    "Austria": "the archived Red Cross chart gives A+ 33, AB+ 6, O- 7, A- 8, B- 3, AB- 1; the table has 37, 5, 6, 7, 2, 0.45",
    "Iceland": "the Blodbankinn archive gives A+ 26.4, B+ 9.3, AB+ 1.6, A- 4.6, B- 1.7; the table has 27.2, 9.0, 2.0, 4.8, 1.6",
    "Turkey": "the kangrubu.com archive gives O+ 29.8, A+ 37.8, B+ 14.2, AB+ 7.2 and different Rh- figures; all 8 differ",
    "Jordan": "Table 1 of the paper gives AB- 3073 of 365,029 donors (0.84%); the table has 0.04%",
    "Philippines": "the Red Cross page gives only ranges and 'less than 1 percent' for Rh-negative",
    "Uganda": "Table 2 of the paper gives O+ 49.26, O- 1.09, A+ 24.54; the table has 49.29, 1.01, 24.11",
    "Sri Lanka": "the cited DOI is a two-page letter on dengue patients at one hospital, not the paper named in the ref",
}


def get(url, raw=False, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                body = r.read().decode("utf-8")
                return body if raw else json.loads(body)
        except urllib.error.HTTPError as e:
            if (e.code != 429 and e.code < 500) or i == tries - 1:
                raise
            wait = e.headers.get("Retry-After")
            time.sleep(int(wait) if wait and wait.isdigit() else 5 * (i + 1))
        except (urllib.error.URLError, TimeoutError):
            if i == tries - 1:
                raise
            time.sleep(5 * (i + 1))


def fips_codes(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    q = f"""SELECT ?iso ?fips WHERE {{ VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso . FILTER NOT EXISTS {{ ?c wdt:P576 ?gone }} ?c wdt:P901 ?fips }}"""
    out = {}
    for r in get(SPARQL + urllib.parse.quote(q))["results"]["bindings"]:
        iso = BACK.get(r["iso"]["value"], r["iso"]["value"])
        out.setdefault(iso, set()).add(r["fips"]["value"].upper())
    for iso, f in FIPS_FALLBACK.items():
        out.setdefault(iso, {f})
    return out


# What the shares count when it is not ethnicity, read from the Factbook note ("data represent population
# by country of birth"). Set by hand where the note is missing or misleading:
BASIS = {
    "ARE": "nationality", "QAT": "nationality", "KWT": "nationality", "BHR": "nationality",  # citizens vs foreign residents, no note
    "IMN": None,  # note says nationality, but the groups are census ethnic categories (White, Asian, Mixed, Black)
    "SVK": None,  # Slovak census "nationality" (narodnost) is ethnic affiliation, not citizenship
}
# Factbook wording that comes from discredited racial typology; the app should quote it, never reuse it.
DATED = r"racially|Negrito|\bstock\b|admixture|homogeneous mixture|Caucasian"
# The Factbook files Palestine as two entries with no figures.
PARTS = {"PSE": {"WE": "West Bank", "GZ": "Gaza Strip"}}
# A country name among nationality adjectives in the Factbook's list ("Romanian 1%, Poland 1%").
ADJECTIVE = {"DEU": {"Poland": "Polish"}, "JPN": {"Vietnam": "Vietnamese"}, "LUX": {"Romania": "Romanian"}}


def ethnic_record(fb, iso=None):
    eth = (fb.get("People and Society") or {}).get("Ethnic groups") or {}
    text = plain(eth.get("text")).replace("\xa0", " ")
    if not text:
        return None
    # Same "Name 12.3%" sentence shape as Religions; that parser reads "about 50%" but not "~50%".
    rec = {**religion_record(text.replace("~", "about ")), "text": text}
    for item in rec.get("items", []):
        item[0] = re.sub(r"^And o", "O", item[0])  # "Indo-Aryan 72%, Dravidian 25%, and other 3%"
        if re.match(r"[A-Z]{2}[a-z]", item[0]) and item[0][0].lower() + item[0][1:] in text:
            item[0] = item[0][0].lower() + item[0][1:]  # the parser capitalises "iTaukei" to "ITaukei"
        item[0] = ADJECTIVE.get(iso, {}).get(item[0], item[0])
    if iso == "TZA":
        rec.pop("items", None)  # shares cover the mainland only; Zanzibar has names but no figures
    note = plain(eth.get("note")).replace("\xa0", " ")
    if note:
        rec["note"] = re.sub(r"^note( \d+)?:\s*", "", note)
        # Censuses that let people tick several origins: the shares overlap and are not parts of a whole.
        if "items" in rec and re.search(r"more than (one|100)|two ancestries|multiple", note, re.I):
            rec["multi"] = True
    m = re.search(r"data represent[^;]*?\b(nationality|country of birth|country of origin|citizenship|ancestry)\b", note)
    basis = BASIS.get(iso, m and m.group(1))
    if basis:
        rec["basis"] = basis
    if re.search(DATED, text):
        rec["dated_terms"] = True
    return rec


def ethnic(isos):
    tree = get(FACTBOOK_TREE)["tree"]
    fb_path = {pathlib.PurePosixPath(t["path"]).stem.upper(): t["path"] for t in tree
               if t["path"].endswith(".json") and "/" in t["path"]}
    fips = fips_codes(isos)

    def one(iso):
        if iso in PARTS:  # text only, one sentence per part, never added together
            recs = {name: ethnic_record(get(FACTBOOK_RAW + fb_path[f])) for f, name in PARTS[iso].items()}
            names = " and the ".join(recs)
            return iso, {"text": "; ".join(f"{n}: {r['text']}" for n, r in recs.items() if r),
                         "note": f"the Factbook lists the {names} separately"}
        paths = [fb_path[f] for f in sorted(fips.get(iso, ())) if f in fb_path]
        if len(paths) != 1:  # none, or an ambiguous join: leave the country out
            return iso, None
        try:
            return iso, ethnic_record(get(FACTBOOK_RAW + paths[0]), iso)
        except Exception as e:
            print("no factbook entry for", iso, e)
            return iso, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        return {iso: rec for iso, rec in pool.map(one, isos) if rec}


def text_of(s):
    s = re.sub(r"<(style|sup)[^>]*>.*?</\1>", "", s, flags=re.S)
    s = re.sub(r'<span class="(mw-cite-backlink|cs1-visible-error|cs1-maint)[^"]*">.*?</span>', "", s, flags=re.S)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", s))).strip()


def ref_year(ref):
    """Publication year of a citation. Archive and access dates say when Wikipedia looked, not when
    the source was published, so they are removed first; no date left means no year."""
    t = re.sub(rf"(Archived(?: from the original)?(?: \(PDF\))? on|Archived|Retrieved) (\d{{1,2}} )?{MONTH}( \d{{1,2}},)? \d{{4}}", "", ref)
    m = re.search(rf"\((?:\d{{1,2}} )?(?:{MONTH} )?(?:\d{{1,2}}, )?((?:19|20)\d\d)[a-z]?\)"
                  rf"|(?:\d{{1,2}} )?{MONTH} (?:\d{{1,2}}, )?((?:19|20)\d\d)\b|\. ((?:19|20)\d\d)\.", t)
    return next(g for g in m.groups() if g) if m else None


def rh_split_uniform(vals):
    """True when Rh- is the same share of O, A, B and AB: the mark of an editor multiplying ABO totals by one rate."""
    r = [100 * vals[i + 4] / (vals[i] + vals[i + 4]) for i in range(4) if vals[i] + vals[i + 4]]
    return max(r) - min(r) < 0.3


def blood(countries):
    d = get("https://en.wikipedia.org/w/api.php?action=parse&prop=text|revid&format=json"
            f"&formatversion=2&oldid={BLOOD_REVID}")["parse"]
    page = html.unescape(d["text"])
    refs = dict(re.findall(r'<li id="cite_note-([^"]+)">(.*?)</li>', page, re.S))
    by_name = {}
    for c in countries.values():
        if c.get("iso3"):
            for n in [c["name"], *c.get("alt", [])]:
                by_name.setdefault(n.lower(), c["iso3"])
    # The first wikitable is ABO with Rh by country; the second is ABO only, by people group.
    table = re.findall(r'<table class="[^"]*wikitable.*?</table>', page, re.S)[0]
    out, skipped = {}, {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S)[1:]:
        head = re.search(r"<th[^>]*>(.*?)</th>", row, re.S).group(1)
        name = re.search(r'<a href="/wiki/(?!Wikipedia:)[^"]+" title="([^"]+)"', head).group(1)
        iso = by_name.get(re.sub(r" \(country\)$", "", name).lower())
        cells = [text_of(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)][1:9]
        vals = [float(m.group(1)) if (m := re.fullmatch(r"(\d+(?:\.\d+)?)\s*%?", v.replace(",", "."))) else None for v in cells]
        cites = re.findall(r'href="#cite_note-([^"]+)"', row)
        flags = re.findall(r'<a href="/wiki/Wikipedia:[^"]+"[^>]*>(?:<span[^>]*>)?([^<]+)', row)
        ref = " / ".join(text_of(refs[c]) for c in cites if c in refs)
        why = ("not a country" if not iso else "a figure missing or not exact" if len(vals) != 8 or None in vals
               else "no survey cited" if not cites else "tagged: " + flags[0] if flags
               else "does not match its source: " + MISMATCH[name] if name in MISMATCH
               else "Rh split worked out by an editor" if "assuming" in ref or (rh_split_uniform(vals) and iso not in CHECKED)
               else "adds up to %.1f%%" % sum(vals) if not 95 <= sum(vals) <= 105
               else "not checked by hand against its source yet" if iso not in CHECKED else None)
        if why:
            skipped[name] = why
            continue
        rec = dict(zip(TYPES, vals))
        rec["ref"] = ref
        url = re.search(r'href="(https?://[^"]+)"', refs.get(cites[0], ""))
        if url:
            rec["url"] = url.group(1)
        year = ref_year(rec["ref"])
        seen = re.findall(rf"Retrieved (?:\d{{1,2}} )?{MONTH} (?:\d{{1,2}}, )?(\d{{4}})", rec["ref"])
        if year:
            rec["year"] = year
        elif seen:
            rec["accessed"] = seen[0]  # undated web page: only the date Wikipedia read it is known
        else:
            skipped[name] = "citation gives no date"
            continue
        rec.update(publisher=CHECKED[iso], checked="2026-11",
                   sample="share of the national population as stated by the publisher; no method or sample size given")
        if rh_split_uniform(vals):  # USA: the source itself gives Rh- as one rate across O, A, B and AB
            rec["note"] = ("the source gives Rh- as the same %.0f%% of every ABO group, so its eight figures are "
                           "probably ABO shares multiplied by one Rh-negative rate" % (100 * vals[4] / (vals[0] + vals[4])))
        out[iso] = rec
    return out, skipped, d["revid"]


# Self-checks for the citation year: access and archive dates must not count.
assert ref_year('"Dhuroni gjak". 26 April 2015. Retrieved 28 August 2020.') == "2015"
assert ref_year('Valenzuela, Carlos (April 1987). "Gradiente". Revista Médica de Chile. 115: 295–9.') == "1987"
assert ref_year('"Study of Blood Immunogenetical Markers in Armenian Population" (PDF). 1989.') == "1989"
assert ref_year('Tipos Sanguíneos Archived 9 March 2013 at the Wayback Machine') is None
assert ref_year('"Croix Rouge". Archived from the original on 1 January 2017. Retrieved 21 January 2017.') is None
assert ref_year('"X" (PDF). Archived from the original (PDF) on 28 March 2018.') is None
assert rh_split_uniform([60 * .88, 22 * .88, 14 * .88, 4 * .88, 60 * .12, 22 * .12, 14 * .12, 4 * .12])
assert not rh_split_uniform([36, 30, 8, 2, 8, 9, 2, 1])


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    isos = sorted({c["iso3"] for c in countries.values() if c.get("iso3")})
    today = datetime.date.today().isoformat()
    OUT.mkdir(parents=True, exist_ok=True)

    eth = ethnic(isos)
    assert len(eth) >= 200, len(eth)
    assert eth["VNM"]["items"][0] == ["Kinh", 85.3] and eth["VNM"]["year"] == "2019", eth["VNM"]
    assert eth["SYR"]["items"][0] == ["Arab", 50.0, "~"] and eth["IND"]["items"][2] == ["Other", 3.0]
    assert all(85 <= sum(i[1] for i in r["items"]) <= 110 for r in eth.values() if "items" in r)
    assert eth["FJI"]["items"][0][0] == "iTaukei" and "items" not in eth["TZA"], (eth["FJI"], eth["TZA"])
    assert eth["SWE"]["basis"] == "country of birth" and eth["QAT"]["basis"] == "nationality" and "basis" not in eth["SVK"]
    assert {"PRK", "PNG", "MLT", "PLW", "FJI", "MDV"} <= {k for k, r in eth.items() if r.get("dated_terms")}
    assert eth["PSE"]["text"].startswith("West Bank: ") and "Gaza Strip: " in eth["PSE"]["text"], eth["PSE"]
    (OUT / "ethnic.json").write_text(json.dumps({
        "built": today,
        "source": "CIA World Factbook, final edition (January 2026), People and Society: Ethnic groups; "
                  "via github.com/factbook/factbook.json",
        "licence": "Public domain",
        "url": "https://github.com/factbook/factbook.json",
        "countries": eth}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    bl, skipped, revid = blood(countries)
    assert set(bl) == set(CHECKED), set(CHECKED) ^ set(bl)
    assert all(95 <= sum(r[t] for t in TYPES) <= 105 and r["ref"] for r in bl.values())
    (OUT / "blood.json").write_text(json.dumps({
        "built": today,
        "source": f'Wikipedia, "{BLOOD_PAGE}" (revision {revid}), which compiles the survey cited for each country; '
                  "only rows checked by hand against that survey are included",
        "licence": "CC BY-SA 4.0",
        "licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "url": f"https://en.wikipedia.org/w/index.php?title={urllib.parse.quote(BLOOD_PAGE.replace(' ', '_'))}&oldid={revid}",
        "countries": bl}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"ethnic: {len(eth)} countries, {sum('items' in r for r in eth.values())} with shares, "
          f"{sum('basis' in r for r in eth.values())} with a basis, {sum('dated_terms' in r for r in eth.values())} with dated terms")
    print(f"blood: {len(bl)} countries, {sum('year' in r for r in bl.values())} with a citation year, "
          f"{sum('accessed' in r for r in bl.values())} with only an access year; left out:")
    for name, why in sorted(skipped.items()):
        print(f"  {name}: {why}")


if __name__ == "__main__":
    main()

"""Build data/profiles.json: overview, institutions, religion and first-level divisions per country.

Sources: Wikipedia page summaries (CC BY-SA 4.0), Wikidata (CC0) and the CIA World Factbook
through the factbook/factbook.json mirror (public domain). Standard library only.
Run after build_data.py, which provides the list of countries:  python scripts/build_profiles.py
"""
import collections
import concurrent.futures
import datetime
import html
import json
import pathlib
import re
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "borderline-interesting-data-build/1.0 (static map app)"}
SPARQL = "https://query.wikidata.org/sparql?format=json&query="
FACTBOOK_TREE = "https://api.github.com/repos/factbook/factbook.json/git/trees/master?recursive=1"
FACTBOOK_RAW = "https://raw.githubusercontent.com/factbook/factbook.json/master/"
# Instance-of labels that describe size or status rather than the kind of division.
GENERIC_TYPES = {
    "big city", "megacity", "metropolis", "city", "largest city", "island", "community", "human settlement",
    "capital city", "global city", "port settlement", "million city", "disputed territory", "metropolitan area",
}
# Entries listed under P150 that are not administrative units (Lorraine, Taiwan Area, Yesha).
NOT_DIVISIONS = {"cultural region", "political term", "occupied territory", "historical region", "geographic region"}
# Wikidata files Kosovo under the ISO code XKS; the rest of the app uses the World Bank's XKX.
ALIAS = {"XKX": "XKS"}
BACK = {v: k for k, v in ALIAS.items()}
OVERVIEW_MAX = 700


def get(url, raw=False, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read().decode("utf-8") if raw else json.load(r)
        except Exception as e:
            if i == tries - 1:
                raise
            # Wikimedia rate-limits bursts (429): wait as long as it asks, or longer each time.
            wait = getattr(e, "headers", None) and e.headers.get("Retry-After")
            time.sleep(int(wait) if wait and wait.isdigit() else 5 * (i + 1))


def sparql(query):
    return get(SPARQL + urllib.parse.quote(query))["results"]["bindings"]


def val(row, key):
    return row[key]["value"] if key in row else None


def institutions(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""
SELECT ?iso ?c ?fips ?article ?formLabel ?legLabel WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso .
  FILTER NOT EXISTS {{ ?c wdt:P576 ?dissolved }}
  OPTIONAL {{ ?c wdt:P901 ?fips }}
  OPTIONAL {{ ?article schema:about ?c ; schema:isPartOf <https://en.wikipedia.org/> }}
  OPTIONAL {{ ?c wdt:P122 ?form }}
  OPTIONAL {{ ?c wdt:P194 ?leg }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    # Several items can carry one ISO code; keep the one with the most facts.
    items = collections.defaultdict(lambda: collections.defaultdict(lambda: collections.defaultdict(list)))
    for r in rows:
        rec = items[BACK.get(val(r, "iso"), val(r, "iso"))][val(r, "c")]
        for key, field in (("fips", "fips"), ("article", "article"), ("formLabel", "form"), ("legLabel", "leg")):
            v = val(r, key)
            if v and v not in rec[field] and not re.fullmatch(r"Q\d+", v):
                rec[field].append(v)
    out = {}
    for iso, cands in items.items():
        qid, best = max(cands.items(), key=lambda kv: sum(len(v) for v in kv[1].values()))
        out[iso] = {k: v for k, v in best.items() if v}
        out[iso]["qid"] = qid
    for prop, field in (("P35", "hos"), ("P6", "hog")):
        for iso, names in office_holders(values, prop).items():
            if iso in out and out[iso]["qid"] in names:
                out[iso][field] = names[out[iso]["qid"]]
    for rec in out.values():
        rec.pop("qid")
    return out


def office_holders(values, prop):
    """Current holders of an office, by item. Many old statements lack an end date, so the
    preferred-rank statement wins; failing that, the holder with the latest start date."""
    rows = sparql(f"""
SELECT ?iso ?c ?pLabel ?rank ?start WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso . ?c p:{prop} ?s . ?s ps:{prop} ?p ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  FILTER NOT EXISTS {{ ?s pq:P582 ?end }}
  OPTIONAL {{ ?s pq:P580 ?start }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    found = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        name = val(r, "pLabel")
        if name and not re.fullmatch(r"Q\d+", name):
            found[BACK.get(val(r, "iso"), val(r, "iso"))][val(r, "c")].append((val(r, "rank").endswith("PreferredRank"), val(r, "start") or "", name))
    out = collections.defaultdict(dict)
    for iso, by_item in found.items():
        for qid, cands in by_item.items():
            preferred = [c for c in cands if c[0]]
            pool = preferred or cands
            latest = max(c[1] for c in pool)
            out[iso][qid] = sorted({c[2] for c in pool if c[1] == latest})
    return out


def divisions(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""
SELECT ?iso ?d ?dLabel ?tLabel WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso . FILTER NOT EXISTS {{ ?c wdt:P576 ?dissolved }}
  ?c p:P150 ?st . ?st ps:P150 ?d .
  FILTER NOT EXISTS {{ ?st pq:P582 ?e }}
  FILTER NOT EXISTS {{ ?d wdt:P576 ?gone }}
  OPTIONAL {{ ?d wdt:P31 ?t }}
  SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en,mul". }}
}}""")
    by = collections.defaultdict(dict)
    for r in rows:
        d = by[BACK.get(val(r, "iso"), val(r, "iso"))].setdefault(val(r, "d"), {"name": val(r, "dLabel"), "types": set(), "skip": False})
        t = val(r, "tLabel")
        if t in NOT_DIVISIONS:
            d["skip"] = True
        if t and t not in GENERIC_TYPES and not re.fullmatch(r"Q\d+", t):
            d["types"].add(t)
    out = {}
    for iso, divs in by.items():
        divs = {k: d for k, d in divs.items() if not d["skip"] and d["name"] not in ("Taiwan", "Kosovo", "State of Palestine", "West Bank", "Gaza Strip")}
        names = sorted({d["name"] for d in divs.values() if d["name"] and not re.fullmatch(r"Q\d+", d["name"])})
        types = collections.Counter(t for d in divs.values() for t in d["types"])
        if not names:
            continue
        rec = {"n": len(names), "names": names}
        if types:
            rec["type"] = types.most_common(1)[0][0]
        out[iso] = rec
    return out


def overview(article_url):
    title = urllib.parse.unquote(article_url.rsplit("/wiki/", 1)[1])
    d = get("https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title, safe=""))
    text = (d.get("extract") or "").strip()
    text = re.sub(r"\s*—\s*", ", ", text)  # the app's text uses no em dashes; a comma reads the same here
    if len(text) > OVERVIEW_MAX:
        # Cut at the last full sentence that fits.
        cut = text[:OVERVIEW_MAX]
        text = cut[: cut.rfind(". ") + 1] or cut
    return {"wiki": title, "overview": text} if text else {}


INFOBOX_ROW = re.compile(
    r'<tr[^>]*>\s*<th[^>]*class="infobox-label"[^>]*>(.*?)</th>\s*<td[^>]*class="infobox-data[^"]*"[^>]*>(.*?)</td>\s*</tr>', re.S)


def cell(s):
    s = re.sub(r"<(sup|style)[^>]*>.*?</\1>", "", s, flags=re.S)
    s = re.sub(r"<br\s*/?>|</li>", ", ", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ")
    s = re.sub(r"\[[a-z0-9 ]{1,4}\]", "", s)  # footnote markers like [a] or [12]
    return re.sub(r"\s+", " ", s).strip(" ,")


def government(title):
    """The Government block of a country's Wikipedia infobox: its type, the leaders with their
    titles, and the legislature. Wikipedia updates these faster than Wikidata (a new prime
    minister appeared there within days; Wikidata still listed the old one months later)."""
    d = get("https://en.wikipedia.org/w/api.php?action=parse&prop=text&section=0&redirects=1"
            "&format=json&formatversion=2&page=" + urllib.parse.quote(title, safe=""))
    out, block = {}, None
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", d.get("parse", {}).get("text", ""), re.S):
        m = INFOBOX_ROW.search("<tr>" + tr + "</tr>")
        if not m:
            if "infobox-header" in tr:
                block = None  # a section header (History, Area, ...) ends the Government and Legislature blocks
            continue
        label, data = cell(m.group(1)), cell(m.group(2))
        bullet = label.startswith("•")
        name = label.lstrip("• ").strip()
        if not bullet:
            block = name if name in ("Government", "Legislature") else None
            if name == "Government" and data:
                out["gov"] = data
            elif name == "Legislature" and data:
                out["leg"] = [data]
        elif block == "Government" and data:
            out.setdefault("leaders", []).append([name, data])
        elif block == "Legislature" and data:
            out.setdefault("houses", []).append([name, data])
    return out


def plain(s):
    s = re.sub(r"<br\s*/?>", " ", s or "")
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def religion_items(text):
    """Top-level "Name 12.3%" shares from a Factbook sentence, or None when they do not cover the population.

    Items are [name, share] or [name, share, "<", ">" or "~"] for "less than 1%", "more than 90%" and "about 10%".
    Ranges ("95-98%") and source typos ("93/1%", "89.5") are not guessed at: the item is dropped, the
    total then falls short, and the app prints the Factbook sentence instead of a partial chart.
    """
    # Anything inside parentheses is a breakdown and is skipped.
    depth, top = 0, []
    for ch in text:
        depth += ch == "("
        if depth == 0:
            top.append(ch)
        depth -= ch == ")" and depth > 0
    # A semicolon starts a tail ("; less than 1 percent: Orthodox, ..."), not another share.
    head = "".join(top).split(";")[0]
    items = []
    # Split only after a "%", so a label with commas in it ("ancestral, tribal, animist, or other ...") stays whole.
    for part in re.split(r"(?<=%)[,.]?\s+", head):
        m = re.match(r"\s*(.+?)\s+(?:(<|less than|under|>|more than|over|approximately|about|roughly)\s*)?(\d*\.?\d+)%\s*$", part.strip())
        if not m:
            continue
        name = re.sub(r"\s+", " ", m.group(1))
        name = re.sub(r"\s+est\.?$", "", name, flags=re.I).strip(" :,")
        if not name or re.search(r"[\d%]", name):
            continue
        item = [name[:1].upper() + name[1:], float(m.group(3))]
        if m.group(2):
            item.append("<" if m.group(2) in ("<", "less than", "under") else ">" if m.group(2) in (">", "more than", "over") else "~")
        items.append(item)
    return items if items and 85 <= sum(i[1] for i in items) <= 110 else None


def religion_record(text):
    rec = {"text": text}
    items = religion_items(text)
    if items:
        rec["items"] = items
    year = re.findall(r"\((\d{4}(?:-\d{2,4})?)(?: est\.?)?\)", text)
    if year:
        rec["year"] = year[-1]
    return rec


def religion(fb):
    rel = (fb.get("People and Society") or {}).get("Religions") or {}
    text = plain(rel.get("text"))
    if not text:
        return {}
    rec = religion_record(text)
    note = plain(rel.get("note"))
    if note:
        rec["note"] = re.sub(r"^note( \d+)?:\s*", "", note)
    return rec


# Wikidata's item for the Netherlands is the Kingdom, which carries no FIPS code.
FIPS_FALLBACK = {"NLD": "NL"}

# Antarctica has no first-level divisions; Wikidata's one entry is a French territory.
NO_DIVISIONS = {"ATA"}


def reparse():
    """Re-derive the religion shares from the sentences already in profiles.json. No network."""
    path = ROOT / "data" / "profiles.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    for iso, rec in data["countries"].items():
        r = rec.get("religion")
        if r and r.get("text"):
            rec["religion"] = {**religion_record(r["text"]), **({"note": r["note"]} if r.get("note") else {})}
        if iso in NO_DIVISIONS:
            rec.pop("div", None)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = sum(1 for r in data["countries"].values() if r.get("religion", {}).get("items"))
    print("reparsed:", n, "countries with religion shares")


# Self-check: the sentences that used to produce partial or broken charts.
assert religion_items("Muslim (official) 95-98% (Shia 61-64%), Christian 1%, other 1-4% (2015 est.)") is None
assert religion_items("Christian 93/1% (Roman Catholic 29.9%), Kimbanguist 2.8%, Muslim 1.3% (2014 est.)") is None
assert religion_items("Christian 86%, ancestral, tribal, animist, or other traditional African religions 5.4%, Muslim 1.9%, other 1.5%, nothing in particular 5.2% (2015 est.)")[1]     == ["Ancestral, tribal, animist, or other traditional African religions", 5.4]
assert religion_items("Roman Catholic (official) more than 90% (2006 est.)") == [["Roman Catholic", 90.0, ">"]]
assert religion_items("Roman Catholic 70.7%, refused to answer 20.9%, no religion 6.9%; less than 1 percent: Orthodox, other")[2] == ["No religion", 6.9]
assert religion_items("Muslim 99%, other <1% (2012 est.)") == [["Muslim", 99.0], ["Other", 1.0, "<"]]
assert religion_items("Buddhist 90%, folk religion approximately 10%, other .06%") == [["Buddhist", 90.0], ["Folk religion", 10.0, "~"], ["Other", 0.06]]
assert religion_record("Christian 93.9%, other 6.1% (2016-17 est.)")["year"] == "2016-17"


def main():
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    isos = sorted({c["iso3"] for c in countries.values() if c.get("iso3")})

    # Batches of 40: one query for every country runs into Wikidata's 60-second limit and comes back cut off.
    inst, divs = {}, {}
    for i in range(0, len(isos), 40):
        inst.update(institutions(isos[i:i + 40]))
        divs.update(divisions(isos[i:i + 40]))
    tree = get(FACTBOOK_TREE)["tree"]
    fb_path = {pathlib.PurePosixPath(t["path"]).stem.upper(): t["path"] for t in tree
               if t["path"].endswith(".json") and "/" in t["path"]}

    # Reuse overviews from the last build so a rerun only asks Wikipedia for what is missing.
    path = ROOT / "data" / "profiles.json"
    cache = json.loads(path.read_text(encoding="utf-8"))["countries"] if path.exists() else {}

    def build(iso):
        w = inst.get(iso, {})
        rec = {}
        if cache.get(iso, {}).get("overview"):
            rec.update({k: cache[iso][k] for k in ("wiki", "overview")})
        elif w.get("article"):
            try:
                rec.update(overview(w["article"][0]))
            except Exception as e:  # one missing page should not stop the build
                print("no overview for", iso, e)
            time.sleep(0.3)
        # Institutions from the infobox; Wikidata only fills what the infobox lacks.
        i = {}
        if rec.get("wiki"):
            try:
                i = government(rec["wiki"])
            except Exception as e:
                print("no infobox for", iso, e)
            time.sleep(0.3)
        if "gov" not in i and "form" in w:
            i["form"] = w["form"]
        if "leaders" not in i:
            i.update({k: w[k] for k in ("hos", "hog") if k in w})
        if "leg" not in i and "leg" in w:
            i["leg"] = w["leg"]
        if i:
            rec["inst"] = i
        fips = (w.get("fips") or [FIPS_FALLBACK.get(iso)])[0]
        if fips and fips.upper() in fb_path:
            try:
                rel = religion(get(FACTBOOK_RAW + fb_path[fips.upper()]))
                if rel:
                    rec["religion"] = rel
            except Exception as e:
                print("no factbook entry for", iso, e)
        if iso in divs and iso not in NO_DIVISIONS:
            rec["div"] = divs[iso]
        return iso, rec

    # Four countries at a time: polite to Wikipedia and GitHub, and minutes instead of most of an hour.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        out = {iso: rec for iso, rec in pool.map(build, isos) if rec}

    # Self-checks: a changed source format or a bad join shows up here.
    assert len(out) >= 200, len(out)
    assert out["VNM"]["div"]["n"] == 34 and out["JPN"]["div"]["n"] == 47
    assert "Vietnam" in out["VNM"]["overview"] and out["GBR"]["inst"].get("leaders")
    assert all(len(r.get("inst", {}).get("houses", [])) <= 3 for r in out.values()), "houses picked up other rows"
    assert any(name.startswith("Catholic") for name, _ in out["VNM"]["religion"]["items"])
    assert sum("overview" in r for r in out.values()) >= 190
    assert sum("religion" in r for r in out.values()) >= 170
    assert ["Prime Minister", "Lê Minh Hưng"] in out["VNM"]["inst"]["leaders"]
    assert out["IRN"]["inst"]["leaders"][0][0] == "Supreme Leader"
    assert sum("leaders" in r.get("inst", {}) for r in out.values()) >= 180

    data = {"built": datetime.date.today().isoformat(), "countries": out}
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = {k: sum(k in r for r in out.values()) for k in ("overview", "inst", "religion", "div")}
    print(f"wrote {path} ({len(out)} countries; {counts})")


if __name__ == "__main__":
    import sys
    reparse() if "--reparse" in sys.argv else main()

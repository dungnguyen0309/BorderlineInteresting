"""Build data/photos.json: up to three photos per country in four groups (nature, culture, cities, getting around).

Sources: Wikidata (CC0) picks the subjects, places located in the country (P17) or inside a territory's
administrative area (P131) that carry an image (P18), ranked by sitelink count (cities by population, capital
first). Wikimedia Commons gives each file's licence, author and a 640 px thumbnail. Only freely licensed
photographs are kept. Standard library only. Run after build_data.py:  python scripts/build_photos.py
"""
import collections
import datetime
import html
import http.client
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Borderline-Interesting-research-map/1.0 (static site build script)"}
SPARQL = "https://query.wikidata.org/sparql"
COMMONS = "https://commons.wikimedia.org/w/api.php"
# Wikidata files Kosovo under the ISO code XKS; the rest of the app uses the World Bank's XKX.
ALIAS = {"XKX": "XKS"}
BACK = {v: k for k, v in ALIAS.items()}
# Wikidata's item for the Netherlands is the Kingdom, which carries the ISO code; places name the country.
EXTRA_QIDS = {"Q55": "NLD"}
PER_GROUP = 6
POOL = 18  # candidates per country and group checked on Commons; some fail the licence or size rules

# Subject classes by group, then by kind. Kinds keep a group varied: one mountain, one lake, one park
# before a second mountain.
CLASSES = {
    "nature": {
        "mountain": ["Q8502", "Q8072", "Q169358"],  # mountain, volcano, stratovolcano
        "water": ["Q23397", "Q34038", "Q204324", "Q45776"],  # lake, waterfall, crater lake, fjord
        "island": ["Q23442", "Q42523"],  # island, atoll
        "park": ["Q46169", "Q179049", "Q473972", "Q4421"],  # national park, nature reserve, protected area, forest
        "land": ["Q35666", "Q150784", "Q35509", "Q40080", "Q8514", "Q39816", "Q43742", "Q25391"],  # glacier .. dune
    },
    "culture": {
        "faith": ["Q16970", "Q2977", "Q163687", "Q32815", "Q44613", "Q5393308", "Q842402", "Q44539",
                  "Q845945", "Q34627", "Q199451"],  # church .. pagoda
        "museum": ["Q33506", "Q207694"],
        "palace": ["Q16560", "Q53536964", "Q23413", "Q57821", "Q1785071"],  # palace, royal palace, castle, forts
        "heritage": ["Q839954", "Q162875", "Q4989906"],  # archaeological site, mausoleum, monument
        "stage": ["Q153562", "Q24354"],  # opera house, theatre
    },
    # City and every subclass of it (big city, charter city, city of Japan ...), from a subquery.
    "cities": {"city": ["Q515"]},
    "transport": {
        "airport": ["Q644371", "Q1248784"],
        "station": ["Q55488", "Q55485"],
        "port": ["Q44782", "Q15310171"],
        "bridge": ["Q12280", "Q12570", "Q158218", "Q158438", "Q181348"],
    },
}
KIND = {q: (g, k) for g, kinds in CLASSES.items() for k, qs in kinds.items() for q in qs}
# Queries, each under Wikidata's 60-second limit: the big classes alone, the small ones together.
# (group, classes, minimum sitelinks)
BATCHES = [
    ("nature", ["Q8502"], 5), ("nature", ["Q23442"], 5), ("nature", ["Q23397"], 5),
    ("nature", CLASSES["nature"]["park"], 3),
    ("nature", ["Q8072", "Q169358", "Q34038", "Q204324", "Q45776", "Q42523"] + CLASSES["nature"]["land"], 3),
    ("culture", ["Q16970"], 5),
    ("culture", [q for q in CLASSES["culture"]["faith"] if q != "Q16970"], 3),
    ("culture", CLASSES["culture"]["museum"] + CLASSES["culture"]["palace"], 3),
    ("culture", CLASSES["culture"]["heritage"] + CLASSES["culture"]["stage"], 3),
    ("cities", ["Q515"], 3),
    ("transport", ["Q55488"], 4),
    ("transport", ["Q55485"] + CLASSES["transport"]["airport"] + CLASSES["transport"]["port"], 3),
    ("transport", ["Q12280"], 4),
    ("transport", [q for q in CLASSES["transport"]["bridge"] if q != "Q12280"], 3),
]
# World Heritage selection criteria (vii) to (x) are natural, (i) to (vi) cultural.
NATURAL_CRITERIA = {"Q23038981", "Q23038983", "Q23038985", "Q23038986"}
CULTURAL_CRITERIA = {"Q23038972", "Q23038976", "Q23038977", "Q23038978", "Q23038979", "Q23038980"}
# For sites without criteria: natural ones carry classes like these or say so in their name.
NATURAL_NAME = re.compile(r"National Park|Nature|Wildlife|Marine|Forest|Mountain|Island|Falls|Lake|Volcan|Glacier|"
                          r"Desert|Reef|Biosphere|Rainforest|Wetland|Delta|Valley|Canyon|Gorge|Caves?\b", re.I)
# File names of maps, flags, arms, logos, diagrams and plans, in the languages Commons uses most.
NOT_PHOTO = re.compile(r"(?<![a-z])(maps?|karte|carte|mapa|mappa|locator|location|lage|flag|flags|flagge|drapeau|"
                       r"bandera|coat of arms|wappen|blason|escudo|stemma|logo|diagram|schema|scheme|plan|grundriss|"
                       r"seal|emblem|symbol|insignia|infographic|chart)(?![a-z])")
# Metropolitan areas and French intercommunal "métropoles" are tagged as cities but are not one.
NOT_CITY = re.compile(r"(?i)metropolitan|métropole|metropolis of|urban area|agglomeration")


def get(url, data=None, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, data=data and urllib.parse.urlencode(data).encode(), headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.load(r)
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


def sparql(query, tries=3):
    rows = get(SPARQL, {"format": "json", "query": query}, tries)["results"]["bindings"]
    time.sleep(3)  # the query service allows a minute of query time per minute; leave room
    return [{k: v["value"].replace("http://www.wikidata.org/entity/", "") for k, v in r.items()} for r in rows]


def typed(classes, min_sl, tries=3):
    """Items of these classes with an image, and the country (P17) they are in."""
    values = "VALUES ?type { " + " ".join("wd:" + q for q in classes) + " }"
    pop = extra = ""
    if classes == ["Q515"]:
        values = "{ SELECT DISTINCT ?type WHERE { ?type wdt:P279* wd:Q515 } }"
        pop = "?item wdt:P1082 ?pop . FILTER(?pop >= 10000)"
    # Towns tagged as ports (Saint-Tropez), ancient harbours (Berenice) and air bases are not ways to get around.
    if all(KIND[q][0] == "transport" for q in classes):
        extra = ("FILTER NOT EXISTS { ?item wdt:P1082 ?p } FILTER NOT EXISTS { ?item wdt:P31 wd:Q839954 } "
                "FILTER NOT EXISTS { ?item wdt:P31 wd:Q695850 }")
    return sparql(f"""
SELECT ?item ?c ?type ?img ?sl ?en {"?pop" if pop else ""} WHERE {{
  hint:Query hint:optimizer "None" .
  {values}
  ?item wdt:P31 ?type .
  {pop}
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= {min_sl})
  ?item wdt:P18 ?img .
  ?item wdt:P17 ?c .
  {extra}
  FILTER NOT EXISTS {{ ?item wdt:P576 ?gone }}
  OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
}}""", tries)


def typed_split(classes, min_sl):
    """Run a batch; if it times out, run its halves instead."""
    try:
        # A single big class (church buildings) runs close to the time limit: give it more tries.
        return typed(classes, min_sl, 3 if len(classes) > 1 else 5)
    except Exception as e:
        if len(classes) == 1:
            print("query failed for", classes, e)
            return []
        print("splitting", classes, e)
        half = len(classes) // 2
        return typed_split(classes[:half], min_sl) + typed_split(classes[half:], min_sl)


def same_subject(a, b):
    """One title inside the other, as whole words: "Mount Kenya" and "Mount Kenya National Park", two "Tokyo"s."""
    a, b = a.lower(), b.lower()
    short, long_ = sorted((a, b), key=len)
    return re.search(r"(?<!\w)" + re.escape(short) + r"(?!\w)", long_) is not None


def plain(s):
    s = re.sub(r"<br\s*/?>", " ", s or "")
    return re.sub(r"\s+([,.;)])", r"\1", re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s)))).strip()


def author(meta):
    s = plain(meta.get("Artist", {}).get("value"))
    # Commons' fallback text when a file names its uploader only: keep the name.
    m = re.match(r"No machine-readable author provided\. (.+?) assumed", s)
    s = m.group(1) if m else s
    s = "Unknown author" if re.fullmatch(r"(Unknown author ?)+", s) else s
    # Wiki user-page leftovers: "Name ( talk)Name", "The original uploader was Name at English Wikipedia."
    s = re.sub(r"\s*\(\s*(?:talk|contribs|website|mail)\b[^)]*\)", "", s, flags=re.I).replace("~commonswiki", "")
    s = re.sub(r"^(.{4,})\1$", r"\1", s)
    s = re.sub(r"(?i)^(.+?);\s*(the )?original uploader was.*$", r"\1", s)
    m = re.match(r"(?i)(?:(?:the )?original uploader was )?(.+?) at (?:[a-z]+ wikipedia|[a-z]{2,3}\.wikipedia)\b", s) or \
        re.match(r"(?i)this image photographed by (.+?) with permission", s)
    s = (m.group(1) if m else s).strip(" .")
    if len(s) > 80:  # cut at a word, not inside one
        s = s[:80].rsplit(" ", 1)[0].rstrip(" ,;:(") + "…"
    return s


assert author({"Artist": {"value": "Hisamikabunomura ( talk)Hisamikabunomura"}}) == "Hisamikabunomura"
assert author({"Artist": {"value": "U.S. Navy; The original uploader was Cobatfor at English Wikipedia. (Transferred)"}}) == "U.S. Navy"
assert author({"Artist": {"value": "The original uploader was Mottld at English Wikipedia."}}) == "Mottld"
assert author({"Artist": {"value": "Original uploader was Mottld at en.wikipedia"}}) == "Mottld"
assert author({"Artist": {"value": "Mr Bullitt~commonswiki"}}) == "Mr Bullitt" and author({"Artist": {"value": "A. Smith"}}) == "A. Smith"
assert not author({"Artist": {"value": "word " * 30}}).endswith(" …")


def licence(meta):
    """Short licence name for a free licence, or None for anything non-free or unclear."""
    if meta.get("NonFree", {}).get("value", "").lower() == "true":
        return None
    s = plain(meta.get("LicenseShortName", {}).get("value")).split(",")[0].strip()
    if re.match(r"(?i)^cc0\b|^cc zero\b", s):
        return "CC0"
    if re.match(r"(?i)^(public domain|pd\b|pd-)", s):
        return "Public domain"
    m = re.match(r"(?i)^cc[- ]by(-sa)?[- ](\d\.\d)(?:[- ]([a-z]{2,3}))?$", s)
    if m:
        return "CC BY" + ("-SA" if m.group(1) else "") + " " + m.group(2) + (" " + m.group(3).upper() if m.group(3) else "")
    return None


def is_photo_name(file):
    name = file.lower().replace("_", " ")
    return name.endswith((".jpg", ".jpeg", ".png")) and not NOT_PHOTO.search(name)


assert licence({"LicenseShortName": {"value": "CC BY-SA 4.0"}}) == "CC BY-SA 4.0"
assert licence({"LicenseShortName": {"value": "CC-BY-SA-3.0-de"}}) == "CC BY-SA 3.0 DE"
assert licence({"LicenseShortName": {"value": "CC BY 2.0"}}) == "CC BY 2.0"
assert licence({"LicenseShortName": {"value": "Public domain"}}) == "Public domain"
assert licence({"LicenseShortName": {"value": "CC0"}}) == "CC0"
assert licence({"LicenseShortName": {"value": "CC BY-NC 2.0"}}) is None
assert licence({"LicenseShortName": {"value": "GFDL"}}) is None
assert licence({"LicenseShortName": {"value": "CC BY-SA 4.0"}, "NonFree": {"value": "true"}}) is None
assert not is_photo_name("Chad location map.png") and not is_photo_name("Flag_of_Chad.svg")
assert not is_photo_name("Coat of arms of Chad.jpg") and not is_photo_name("Lake Chad map.jpg")
assert author({"Artist": {"value": "No machine-readable author provided. Jlmoncada assumed (based on copyright claims)."}}) == "Jlmoncada"
assert author({"Artist": {"value": "<span>Unknown author</span><span>Unknown author</span>"}}) == "Unknown author"
assert author({"Artist": {"value": '<a href="x">Diego Delso</a>'}}) == "Diego Delso"
assert same_subject("Mount Kenya", "Mount Kenya National Park") and same_subject("Tokyo", "Tokyo")
assert not same_subject("Bath", "Bathurst Island") and not same_subject("Lake Taupō", "Mount Cook")
assert is_photo_name("Mont Blanc from Aiguille du Midi.JPG") and is_photo_name("Mapusaurus.jpg")


def countries_and_capitals(isos, territories):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""
SELECT ?iso ?c ?item ?img ?en WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso . FILTER NOT EXISTS {{ ?c wdt:P576 ?gone }}
  OPTIONAL {{ ?c wdt:P36 ?item . ?item wdt:P18 ?img .
             OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }} }}
}}""")
    qid_iso, capitals = dict(EXTRA_QIDS), []
    for r in rows:
        qid_iso[r["c"]] = BACK.get(r["iso"], r["iso"])
        if "img" in r:
            capitals.append({**r, "sl": "inf"})  # capitals go first, whatever their class
    # The states that territories belong to: their places may sit inside a territory.
    values = " ".join("wd:" + q for q, i in qid_iso.items() if i in territories)
    parents = {qid_iso.get(r["p"]) for r in sparql(f"SELECT ?p WHERE {{ VALUES ?t {{ {values} }} ?t wdt:P17 ?p }}")}
    return qid_iso, capitals, parents - set(territories) - {None}


def territory_of(items, territories):
    """Item -> the territory (from `territories`) its administrative chain (P131) runs through."""
    out = {}
    for i in range(0, len(items), 1000):
        values = " ".join("wd:" + q for q in items[i:i + 1000])
        for r in sparql(f"""
SELECT DISTINCT ?item ?iso WHERE {{
  hint:Query hint:optimizer "None" .
  VALUES ?item {{ {values} }}
  ?item wdt:P131+ ?t . ?t wdt:P298 ?iso .
}}"""):
            iso = BACK.get(r["iso"], r["iso"])
            if iso in territories:
                out[r["item"]] = iso
    return out


def main():
    started = time.time()
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"]
    isos = sorted({c["iso3"] for c in countries.values() if c.get("iso3")})
    territories = {c["iso3"] for c in countries.values() if c.get("iso3") and not c.get("sov")}
    qid_iso, capitals, parents = countries_and_capitals(isos, territories)

    # pool[iso][group][item] = candidate
    pool = collections.defaultdict(lambda: collections.defaultdict(dict))
    located = collections.defaultdict(set)  # item -> countries it is in

    def add(rows, group):
        for r in rows:
            iso, title = qid_iso.get(r["c"]), r.get("en")
            # A territory's own item (Montserrat under the UK) is a country here, not a sight.
            if not iso or not title or re.fullmatch(r"Q\d+", title) or r["item"] in qid_iso:
                continue
            if group == "cities" and NOT_CITY.search(title):
                continue
            located[r["item"]].add(iso)
            file = urllib.parse.unquote(r["img"].rsplit("/Special:FilePath/", 1)[1])
            old = pool[iso][group].get(r["item"])
            score = float(r.get("pop") or r["sl"])
            if old and old["score"] >= score:
                continue
            kind = KIND.get(r.get("type"), (group, "heritage" if group == "culture" else "park"))[1]
            pool[iso][group][r["item"]] = {"item": r["item"], "title": title, "file": file, "score": score, "kind": kind}

    add(capitals, "cities")
    for group, classes, min_sl in BATCHES:
        rows = typed_split(classes, min_sl)
        print(f"{group}: {len(rows)} rows for {len(classes)} classes")
        add(rows, group)

    # World Heritage sites: natural ones go to nature, the rest to culture.
    rows = sparql("""
SELECT ?item ?c ?type ?crit ?img ?sl ?en WHERE {
  ?item wdt:P1435 wd:Q9259 ; wdt:P18 ?img ; wdt:P17 ?c ; wikibase:sitelinks ?sl .
  FILTER NOT EXISTS { ?item wdt:P576 ?gone }
  OPTIONAL { ?item wdt:P31 ?type }
  OPTIONAL { ?item wdt:P2614 ?crit }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
}""")
    crits, guess = collections.defaultdict(set), set()
    for r in rows:
        crits[r["item"]].add(r.get("crit"))
        if KIND.get(r.get("type"), ("",))[0] == "nature" or NATURAL_NAME.search(r.get("en") or ""):
            guess.add(r["item"])
        r["type"] = None
    # Criteria decide; mixed sites (Machu Picchu) count as culture. Without criteria, classes and name decide.
    natural = {q for q, c in crits.items()
               if (c & NATURAL_CRITERIA and not c & CULTURAL_CRITERIA) or (q in guess and not c - {None})}
    add([r for r in rows if r["item"] in natural], "nature")
    add([r for r in rows if r["item"] not in natural], "culture")
    print(f"world heritage: {len(rows)} rows, {len(natural)} natural")

    # Places inside a territory are often filed under the state it belongs to (Hong Kong's airport under
    # China, San Juan under the United States). Find them through the administrative chain and move them.
    inside = territory_of(sorted({q for iso in parents for items in pool[iso].values() for q in items}), territories)
    for iso in parents:
        for g, items in pool[iso].items():
            for q in [q for q in items if q in inside]:
                pool[inside[q]][g].setdefault(q, items.pop(q))
    print(f"moved {len(inside)} places from {len(parents)} states to their territories")

    # Shortlist per group, then ask Commons about every shortlisted file at once.
    short = {}
    for iso, groups in pool.items():
        for g, items in groups.items():
            seen, lst = set(), []
            for c in sorted(items.values(), key=lambda c: -c["score"]):
                # A place spread over three or more countries (Sahara, Lake Victoria) has one photo, likely taken
                # in another of them.
                if c["file"] not in seen and is_photo_name(c["file"]) and len(located[c["item"]]) < 3:
                    seen.add(c["file"])
                    lst.append(c)
            short[iso, g] = lst[:POOL]
    files = sorted({c["file"] for lst in short.values() for c in lst})
    print(f"checking {len(files)} files on Commons")
    info = {}
    for i in range(0, len(files), 50):
        batch = files[i:i + 50]
        d = get(COMMONS, {"action": "query", "format": "json", "formatversion": "2", "prop": "imageinfo",
                          "iiprop": "url|extmetadata|size|mime", "iiurlwidth": "640", "iiextmetadatalanguage": "en",
                          "iiextmetadatafilter": "LicenseShortName|Artist|NonFree",
                          "titles": "|".join("File:" + f for f in batch)})
        q = d.get("query", {})
        norm = {n["to"]: n["from"] for n in q.get("normalized", [])}
        for p in q.get("pages", []):
            if p.get("imageinfo"):
                info[norm.get(p["title"], p["title"])[5:]] = p["imageinfo"][0]
        time.sleep(0.5)

    def photo(c):
        ii = info.get(c["file"])
        if not ii or ii.get("mime") not in ("image/jpeg", "image/png") or max(ii["width"], ii["height"]) < 800:
            return None
        meta = ii.get("extmetadata", {})
        lic, by = licence(meta), author(meta)
        # Commons now serves thumbnails only at standard widths (640 is refused; 640 comes back as 960) and from
        # thumb.wikimedia.org with tracking parameters; the same path works on upload.wikimedia.org.
        thumb = (ii.get("thumburl") or ii.get("url", "")).split("?")[0].replace("https://thumb.wikimedia.org/", "https://upload.wikimedia.org/")
        if not lic or not by or not thumb.startswith("https://upload.wikimedia.org/"):
            return None
        px = re.search(r"/(\d+)px-[^/]+$", thumb)
        w = int(px.group(1)) if px else ii["width"]
        return {"title": c["title"], "img": thumb, "page": ii["descriptionurl"],
                "author": by, "licence": lic,
                "w": w, "h": round(ii["height"] * w / ii["width"])}

    out = {}
    for iso in isos:
        rec, used_items, used_files, used_titles = {}, set(), set(), set()
        for g in ("cities", "culture", "nature", "transport"):  # capital first; a site counts once per country
            cands = []
            for c in short.get((iso, g), []):
                p = (c["item"] not in used_items and c["file"] not in used_files and c["title"] not in used_titles
                     and photo(c))
                if p:
                    # Panels are wide: a portrait photo needs twice the standing to beat a landscape one.
                    cands.append((c["score"] * (0.5 if p["h"] > p["w"] else 1), c, p))
            cands.sort(key=lambda x: -x[0])
            # Take kinds in turn (a mountain, a lake, a park, then a second of each) so the grid is varied.
            n_kind, ranked = collections.Counter(), []
            for score, c, p in cands:
                ranked.append((n_kind[c["kind"]], -score, c, p))
                n_kind[c["kind"]] += 1
            ranked.sort(key=lambda x: x[:2])
            chosen = []
            for _, _, c, p in ranked:
                if not any(same_subject(c["title"], o["title"]) for o, _ in chosen):
                    chosen.append((c, p))
                if len(chosen) == PER_GROUP:
                    break
            for c, _ in chosen:
                used_items.add(c["item"])
                used_files.add(c["file"])
                used_titles.add(c["title"])
            rec[g] = [p for _, p in chosen]
        if any(rec.values()):
            out[iso] = {g: rec[g] for g in ("nature", "culture", "cities", "transport")}

    # Self-checks: a changed source format or a bad join shows up here.
    assert len(out) >= 200, len(out)
    assert all(out["FRA"][g] for g in ("nature", "culture", "cities", "transport"))
    assert out["FRA"]["cities"][0]["title"] == "Paris" and out["JPN"]["cities"][0]["title"] == "Tokyo"
    assert not any("Hong Kong" in p["title"] for g in out["CHN"].values() for p in g)
    assert out["UKR"]["cities"][0]["title"] == "Kyiv" and out["NLD"]["cities"]  # Amsterdam's photo has an unclear licence
    assert not any(p["title"] == "Montserrat" for g in out["GBR"].values() for p in g)
    assert not any(NOT_CITY.search(p["title"]) for r in out.values() for p in r["cities"])
    for iso, rec in out.items():
        files = [p["page"] for g in rec.values() for p in g]
        assert len(files) == len(set(files)), iso
        assert all(p["title"] and p["author"] and p["licence"] for g in rec.values() for p in g), iso
        assert all(len(g) <= PER_GROUP for g in rec.values()), iso

    data = {"built": datetime.date.today().isoformat(), "countries": out}
    path = ROOT / "data" / "photos.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    counts = {g: sum(bool(r[g]) for r in out.values()) for g in ("nature", "culture", "cities", "transport")}
    print(f"wrote {path} ({len(out)} countries; {counts}; {time.time() - started:.0f} s)")


if __name__ == "__main__":
    main()

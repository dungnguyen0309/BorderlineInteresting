"""Build data/security-photos.json: photos of each country's armed forces and of equipment in their service.

Sources: Wikidata (CC0) names the subjects. Forces are items in the country (P17) that are armed forces or one of
their main branches (army, navy, air force, marines, coast guard and so on), not dissolved or replaced. Equipment
is aircraft, ship, submarine, vehicle, artillery and missile types (and recent individual warships) whose operator
(P137) is the country or one of those forces, with no end time on that statement, kept only when the operator
lists (or ship infobox) in the English Wikipedia article show the country using it now. Wikimedia Commons gives each
file's licence, author and a thumbnail. Only freely licensed photographs are kept. Standard library only.
Run after build_data.py:  python scripts/build_military_photos.py
"""
import collections
import datetime
import difflib
import json
import pathlib
import re
import sys
import time
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_photos import ALIAS, BACK, COMMONS, EXTRA_QIDS, ROOT, author, get, is_photo_name, licence, same_subject, sparql  # noqa: E402

MAX_FORCES, MAX_EQUIPMENT = 6, 12
# Equipment whose type came into service (or first flew, or was designed) before this is left out: Wikidata often
# keeps an operator without an end time long after the type was retired (Hawker Hurricane in India).
FIRST_YEAR = 1960
SHIP_YEAR = 1985  # individual ships: commissioned since, as old hulls are rarely marked decommissioned

# Force classes and the kind shown for them, most specific first.
FORCE_KINDS = [
    ("Q137259222", "Rocket force"), ("Q1898583", "Marines"), ("Q1353040", "Coast guard"),
    ("Q1047180", "Air defence force"), ("Q133505337", "Air and space force"), ("Q1274955", "Space force"),
    ("Q61883", "Air force"), ("Q4508", "Navy"), ("Q1622314", "Navy"), ("Q3746790", "Navy"), ("Q3746796", "Navy"),
    ("Q37726", "Army"), ("Q1365383", "Army"), ("Q772547", "Armed forces"), ("Q1261096", "Armed forces"),
    ("Q204310", "Gendarmerie"), ("Q16948751", "Cyber force"),
    # Generic "military branch" items are often corps, schools or old regiments: only well-known ones count.
    ("Q136532437", "Branch"), ("Q781132", "Branch"), ("Q690109", "Branch"), ("Q8473", "Branch"),
]
FORCE_RANK = {q: i for i, (q, _) in enumerate(FORCE_KINDS)}
BRANCH_MIN_SL = 25
# Equipment: type and model classes, and the classes individual warships are instances of.
MODEL_CLASSES = ["Q15056995", "Q15056993", "Q559026", "Q121289722", "Q18758641", "Q1428357", "Q18487055",
                 "Q18487018", "Q124056273", "Q124056256", "Q100710213", "Q100709275", "Q137188246", "Q15142894"]
SHIP_CLASSES = ["Q11446", "Q170013", "Q161705", "Q4818021", "Q4161425", "Q331795", "Q843215", "Q11229656",
                "Q11479409", "Q2607934", "Q15140918", "Q174736", "Q2811", "Q17205", "Q162986", "Q1499623",
                "Q182531", "Q683570", "Q757587", "Q1186981", "Q474748", "Q650761", "Q474733", "Q2074370",
                "Q869923", "Q1430687"]
NOT_IN_SERVICE = ["Q575727", "Q130326199", "Q852190", "Q11639308"]  # museum ship, preserved, shipwreck, decommissioned
DECOMMISSIONING = ["Q7497952", "Q1786766", "Q906512"]  # ship decommissioning, scuttling, shipwrecking (P793 significant event)
# Superclass words -> kind shown, in order. The first match over an item's classes wins.
EQUIP_KINDS = [
    (r"aircraft carrier", "Aircraft carrier", "sea"), (r"submarine", "Submarine", "sea"),
    (r"destroyer", "Destroyer", "sea"), (r"frigate", "Frigate", "sea"), (r"corvette", "Corvette", "sea"),
    (r"cruiser", "Cruiser", "sea"), (r"amphibious|landing (ship|platform|craft|helicopter)|dock", "Amphibious ship", "sea"),
    (r"mine ?(sweeper|hunter|countermeasure|layer)", "Mine warfare ship", "sea"), (r"missile boat|fast attack", "Missile boat", "sea"),
    (r"patrol (boat|vessel|ship|craft)|cutter", "Patrol vessel", "sea"),
    (r"oiler|replenishment|supply ship|tanker ship|auxiliary", "Support ship", "sea"),
    (r"attack helicopter|armed helicopter", "Attack helicopter", "air"), (r"helicopter", "Helicopter", "air"),
    (r"unmanned|drone|uav", "Drone", "air"), (r"fighter|multi-?role combat", "Fighter aircraft", "air"),
    (r"bomber", "Bomber", "air"), (r"attack (aircraft|jet)|ground.attack", "Attack aircraft", "air"),
    (r"early warning|awacs|aew", "Early warning aircraft", "air"), (r"tanker aircraft|aerial refuel", "Tanker aircraft", "air"),
    (r"trainer", "Trainer aircraft", "air"), (r"maritime patrol|patrol aircraft|anti-submarine warfare aircraft", "Patrol aircraft", "air"),
    (r"reconnaissance aircraft|surveillance aircraft", "Reconnaissance aircraft", "air"),
    (r"transport|cargo|airlifter", "Transport aircraft", "air"),
    (r"surface-to-air|air defen[cs]e|anti-aircraft missile|anti-ballistic", "Air defence system", "missile"),
    (r"anti-aircraft gun|anti-aircraft cannon", "Air defence gun", "land"),
    (r"ballistic missile", "Ballistic missile", "missile"), (r"cruise missile", "Cruise missile", "missile"),
    (r"anti-ship missile", "Anti-ship missile", "missile"), (r"air-to-air", "Air-to-air missile", "missile"),
    (r"anti-tank|antitank", "Anti-tank missile", "missile"),
    (r"main battle tank|\btank\b", "Tank", "land"), (r"infantry fighting vehicle", "Infantry fighting vehicle", "land"),
    (r"armou?red personnel carrier", "Armoured personnel carrier", "land"),
    (r"rocket launcher|rocket artillery|multiple rocket", "Rocket artillery", "land"),
    (r"self-propelled", "Self-propelled artillery", "land"), (r"howitzer|field gun|gun-howitzer|mortar|artillery", "Artillery", "land"),
    (r"armou?red|mrap|reconnaissance vehicle|combat vehicle", "Armoured vehicle", "land"),
    (r"missile", "Missile", "missile"), (r"\bship\b|vessel|watercraft|warship|boat", "Ship", "sea"),
    (r"aircraft|airplane|aeroplane|jet", "Aircraft", "air"),
]
# Generic fallbacks by the item's own model class when no superclass says more.
MODEL_KIND = {"Q15056995": ("Aircraft", "air"), "Q15056993": ("Aircraft", "air"), "Q559026": ("Ship", "sea"),
              "Q121289722": ("Ship", "sea"), "Q18758641": ("Ship", "sea"), "Q1428357": ("Submarine", "sea"),
              "Q18487055": ("Missile", "missile"), "Q18487018": ("Missile", "missile"),
              "Q124056273": ("Artillery", "land"), "Q124056256": ("Artillery", "land"),
              "Q100710213": ("Armoured vehicle", "land"), "Q100709275": ("Armoured vehicle", "land"),
              "Q137188246": ("Military vehicle", "land")}
# Classes that are weapons but not the equipment asked for here.
NOT_EQUIPMENT = re.compile(r"(?i)rifle|pistol|firearm|machine gun|carbine|shotgun|cartridge|ammunition|grenade|"
                           r"knife|bayonet|sword|torpedo|bomb\b|naval mine|satellite|rocket engine|radar|cannon\b")
# Insignia, roundels, ribbons and the like are not photos of a force.
NOT_PHOTO_EXTRA = re.compile(r"(?i)roundel|badge|patch|ribbon|medal|cockade|ensign|jack|racing stripe|"
                             r"insignia|emblem|logo|seal|flag|coat of arms|crest|graphic|poster|recruit|"
                             r"museum|derelict|on display|headquarters")
# Checked by hand: Wikidata subjects or files that are wrong for the country they are filed under.
DROP_ITEMS = {
    "Q383108": "Afghan National Army: the republic's army, dissolved in 2021",
    "Q1814147": "Afghan Air Force: the republic's air force, dissolved in 2021",
    "Q11062919": "Afghan Armed Forces: the republic's forces, dissolved in 2021",
}
# Force photos checked against their Commons page: another country's forces, a place or building, an old or
# retired subject shown as today's force, or no sign of the force named.
DROP_FILES = {
    "Bodri2005.jpg": "Vietnam People's Navy: a Bulgarian Navy ship at Burgas",
    "Caspian Frigate Dagestan.jpg": "Vietnam People's Navy: a Russian Caspian Flotilla frigate",
    "Victory Portsmouth um 1900.jpg": "Royal Navy: HMS Victory around 1900",
    "LÉ 'Eithne', Tall Ships Belfast 2009 - geograph.org.uk - 1450163.jpg": "Irish Army: a Naval Service ship",
    "Belgian sharpshooters defending a street in Aalst Belgium 1914.jpg": "Belgian Armed Forces: 1914",
    "Armed Forces of Belarus in 2021 (en).png": "Belarusian Armed Forces: a chart",
    "第六屆軍事夏令營學員大合照.jpg": "PLA Hong Kong Garrison: summer camp students",
    "Ugandan service members prepare to board a target vessel during exercise Cutlass Express 2013 in the Gulf of "
    "Tadjoura off the coast of Djibouti Nov. 14, 2013 131114-F-NJ596-095.jpg": "Djiboutian Navy: Ugandan troops",
    "Malta - Floriana - Xatt it-Tiben + Sliema - Tigné Point (Xatt it-Tiben) 01 ies.jpg": "Malta: a harbour view",
    "Dog Island New Zealand.jpg": "Maritime New Zealand: a lighthouse island",
    "Mirage F1 Qatar.jpg": "Qatar Emiri Air Force: Mirage F1, retired in 1994",
    "Waddington Viggen (6) 060713.jpg": "Swedish Air Force: Viggen, retired in 2005",
    "A-4KUs 13Feb1991.jpg": "Kuwait: A-4KU in 1991, long retired",
    "Edificio de Aduanas desde el pueto.JPG": "Prefectura Nacional: the customs building",
    "Albanian army deploys T-59 tanks near Kosovo border, May 1999 (Robert Wright).jpg": "Albania: 1999, tanks retired",
    "1917 921a Alpini.jpg": "Alpini: 1917",
    "Nigerian Airforce Headquarters, Yenogoa, Bayelsa state.jpg": "Nigerian Air Force: a building",
    "Nigerian Army headquarters building.jpg": "Nigerian Army: a building",
    "Toby jeneraly Randrianasoavina.jpg": "Madagascar gendarmerie: a regional headquarters building",
    "110407-A-HM954-005 (5617028210).jpg": "UAE: a coalition soldier in Afghanistan, force not named",
    "SIAI-Marchetti SF-260WL Warrior (modified).jpg": "Burkina Faso Air Force: no sign it is that air force",
    "20140418 corfu266.JPG": "Hellenic Navy: a view of Corfu town",
    "Sea Cup 2021 opening ceremony in Anzali (13).jpg": "Azerbaijani Navy: an Iranian navy event",
    "У Києві на Хрещатику пройшов військовий парад з нагоди 27-ї річниці Незалежності України (43414556415).jpg":
        "Moldova: a Ukrainian parade in Kyiv",
    "25 річниці незалежності Молдови 08.jpg": "Moldovan Air Force: a Ukrainian minister's visit",
    "Estacionamiento en el Aeropuerto Internacional de Mazatlán, 19 de julio de 2023 03.jpg": "Mexico: an airport car park",
    "JULIO HDEZJCH 0738 (21960912172).jpg": "Mexican Armed Forces: a trade congress",
    "Ali Khamenei at Afsari University 2019 3.jpg": "Iran: a portrait of the leader",
    "Kikwete and Obama at JNIA.jpg": "Tanzania: two presidents at an airport",
    "Evacuation at Hamid Karzai International Airport; Image 4 of 16.jpg": "Turkish Land Forces: mixed coalition troops",
    "Counter-IED training, Nairobi, Kenya, April 2011 - Flickr - US Army Africa (2).jpg": "Burundi: troops of five countries",
    "Rangers in Action 22-African Land Forces Summit-US Army Africa-13 MAY 2010.jpg": "Eswatini: force not named",
    "US Navy 100303-N-8463W-079 Students admire their course completion certificates during a graduation ceremony "
    "aboard high-speed vessel HSV 2 Swift.jpg": "Seychelles: students on a US ship",
    "Defense.gov photo essay 110530-N-TT977-021.jpg": "United States Navy: a joint colour guard",
}


def year(v):
    m = re.match(r"-?(\d{1,4})-", v or "")
    return int(m.group(1)) if m else None


def force_kind(types):
    ts = sorted((t for t in types if t in FORCE_RANK), key=FORCE_RANK.get)
    if "Q1274955" in types and "Q61883" in types:
        return "Air and space force"
    return dict(FORCE_KINDS)[ts[0]] if ts else None


def equip_kind(labels, own_types):
    for pat, kind, cat in EQUIP_KINDS:
        if any(re.search(pat, s, re.I) for s in labels):
            return kind, cat
    for t in own_types:
        if t in MODEL_KIND:
            return MODEL_KIND[t]
    return None


assert force_kind({"Q772547", "Q1261096"}) == "Armed forces" and force_kind({"Q61883", "Q1274955"}) == "Air and space force"
assert force_kind({"Q4508", "Q136532437"}) == "Navy" and force_kind({"Q5"}) is None
assert equip_kind(["fourth-generation fighter"], []) == ("Fighter aircraft", "air")
assert equip_kind(["nuclear-powered attack submarine"], []) == ("Submarine", "sea")
assert equip_kind(["S-300", "surface-to-air missile"], []) == ("Air defence system", "missile")
assert equip_kind(["Dhruv", "armed helicopter"], []) == ("Attack helicopter", "air")
assert equip_kind(["main battle tank"], []) == ("Tank", "land") and equip_kind(["frigate"], []) == ("Frigate", "sea")
assert equip_kind(["Su-27/30"], ["Q15056995"]) == ("Aircraft", "air")
assert equip_kind(["military cargo transport aircraft"], []) == ("Transport aircraft", "air")
assert year("1979-01-01T00:00:00Z") == 1979 and year(None) is None


def file_of(url):
    return urllib.parse.unquote(url.rsplit("/Special:FilePath/", 1)[1]).replace("_", " ")


def countries(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""SELECT ?iso ?c WHERE {{ VALUES ?iso {{ {values} }} ?c wdt:P298 ?iso .
      FILTER NOT EXISTS {{ ?c wdt:P576 ?gone }} }}""")
    out = dict(EXTRA_QIDS)
    out.update({r["c"]: BACK.get(r["iso"], r["iso"]) for r in rows})
    return out


def forces(qid_iso):
    """Force items filed under exactly one country, not dissolved or replaced: their types, image and sitelinks."""
    types = " ".join("wd:" + q for q, _ in FORCE_KINDS)
    rows = sparql(f"""SELECT ?item ?en ?type ?c ?img ?sl WHERE {{
  VALUES ?type {{ {types} }}
  hint:Query hint:optimizer "None" .
  ?item wdt:P31 ?type ; wdt:P17 ?c ; wikibase:sitelinks ?sl .
  FILTER NOT EXISTS {{ ?item wdt:P17 ?c2 FILTER(?c2 != ?c) }}
  FILTER NOT EXISTS {{ ?item wdt:P576 ?gone }}
  FILTER NOT EXISTS {{ ?item wdt:P582 ?end }}
  FILTER NOT EXISTS {{ ?item wdt:P1366 ?next }}
  OPTIONAL {{ ?item wdt:P18 ?img }}
  OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
}}""", 5)
    out = {}
    for r in rows:
        iso = qid_iso.get(r["c"])
        if not iso or r["item"] in DROP_ITEMS:
            continue
        f = out.setdefault(r["item"], {"item": r["item"], "iso": iso, "title": r.get("en"), "sl": int(r["sl"]),
                                       "types": set(), "files": set()})
        f["types"].add(r["type"])
        if "img" in r:
            f["files"].add(file_of(r["img"]))
    return out


def operated(ops):
    """(item, operator) pairs for equipment with an image, whose operator statement has no end and is not deprecated."""
    classes = " ".join("wd:" + q for q in MODEL_CLASSES + SHIP_CLASSES)
    out = []
    ops = sorted(ops)
    for i in range(0, len(ops), 150):
        values = " ".join("wd:" + q for q in ops[i:i + 150])
        out += sparql(f"""SELECT DISTINCT ?item ?op ?type ?img ?sl ?en WHERE {{
  VALUES ?op {{ {values} }}
  ?item p:P137 ?st . ?st ps:P137 ?op ; wikibase:rank ?rank .
  FILTER(?rank != wikibase:DeprecatedRank)
  FILTER NOT EXISTS {{ ?st pq:P582 ?end }}
  ?item wdt:P31 ?type . VALUES ?type {{ {classes} }}
  ?item wdt:P18 ?img ; wikibase:sitelinks ?sl .
  OPTIONAL {{ ?item rdfs:label ?en FILTER(LANG(?en) = "en") }}
}}""", 5)
    return out


def details(items):
    """Item -> all its classes (P31 and P279) with English labels, earliest date, and whether it is out of service."""
    out = collections.defaultdict(lambda: {"labels": set(), "types": set(), "supers": set(), "year": None, "ship_year": None, "gone": False})
    items = sorted(items)
    gone = " ".join("wd:" + q for q in NOT_IN_SERVICE)
    events = " ".join("wd:" + q for q in DECOMMISSIONING)
    for i in range(0, len(items), 200):
        values = " ".join("wd:" + q for q in items[i:i + 200])
        for r in sparql(f"""SELECT ?item ?p ?v ?l WHERE {{
  VALUES ?item {{ {values} }}
  VALUES ?p {{ wdt:P31 wdt:P279 }}
  ?item ?p ?v . OPTIONAL {{ ?v rdfs:label ?l FILTER(LANG(?l) = "en") }}
}}"""):
            d = out[r["item"]]
            d["types" if r["p"].endswith("P31") else "supers"].add(r["v"])
            if r.get("l"):
                d["labels"].add(r["l"])
        for r in sparql(f"""SELECT ?item ?p ?v WHERE {{
  VALUES ?item {{ {values} }}
  {{ VALUES ?p {{ wdt:P729 wdt:P606 wdt:P571 wdt:P730 wdt:P576 }} ?item ?p ?v }}
  UNION {{ VALUES ?v {{ {gone} }} ?item wdt:P31|wdt:P5817 ?v . BIND("gone" AS ?p) }}
  UNION {{ VALUES ?v {{ {events} }} ?item wdt:P793 ?v . BIND("gone" AS ?p) }}
}}"""):
            d, p = out[r["item"]], r["p"].rsplit("/", 1)[-1]
            if p in ("gone", "P730", "P576"):
                d["gone"] = True
                continue
            y = year(r["v"])
            if y and (d.setdefault(p, None) is None or y < d[p]):
                d[p] = y
    for d in out.values():
        d["year"] = d.get("P729") or d.get("P606") or d.get("P571")
        d["ship_year"] = d.get("P729")
    return out


def commons(files):
    info = {}
    files = sorted(files)
    for i in range(0, len(files), 50):
        d = get(COMMONS, {"action": "query", "format": "json", "formatversion": "2", "prop": "imageinfo",
                          "iiprop": "url|extmetadata|size|mime", "iiurlwidth": "640", "iiextmetadatalanguage": "en",
                          "iiextmetadatafilter": "LicenseShortName|Artist|NonFree",
                          "titles": "|".join("File:" + f for f in files[i:i + 50])})
        q = d.get("query", {})
        norm = {n["to"]: n["from"] for n in q.get("normalized", [])}
        for p in q.get("pages", []):
            if p.get("imageinfo"):
                info[norm.get(p["title"], p["title"])[5:]] = p["imageinfo"][0]
        time.sleep(0.5)
    return info


def photo(file, title, kind, info):
    ii = info.get(file)
    if not ii or ii.get("mime") not in ("image/jpeg", "image/png") or max(ii["width"], ii["height"]) < 640:
        return None
    meta = ii.get("extmetadata", {})
    short = meta.get("LicenseShortName", {}).get("value", "")
    lic = licence(meta) or ("Attribution" if short == "Attribution" else None)
    by = author(meta)
    # As in build_photos.py: the thumbnail path works on upload.wikimedia.org without tracking parameters.
    thumb = (ii.get("thumburl") or ii.get("url", "")).split("?")[0].replace("https://thumb.wikimedia.org/", "https://upload.wikimedia.org/")
    if not lic or not by or not thumb.startswith("https://upload.wikimedia.org/"):
        return None
    px = re.search(r"/(\d+)px-[^/]+$", thumb)
    w = int(px.group(1)) if px else ii["width"]
    return {"title": title, "kind": kind, "img": thumb, "page": ii["descriptionurl"], "author": by, "licence": lic,
            "w": w, "h": round(ii["height"] * w / ii["width"])}


def good_file(f):
    return f not in DROP_FILES and is_photo_name(f) and not NOT_PHOTO_EXTRA.search(f)


# English Wikipedia's operator lists decide whether a country still uses a type: Wikidata keeps most former
# operators with no end date (Mirage III in Australia, Iroquois-class destroyers in Canada).
WIKI = "https://en.wikipedia.org/w/api.php"
WIKIDATA = "https://www.wikidata.org/w/api.php"
# Words a country is written as in those lists, when not just its name; its flag code ({{AUS}}) always counts.
COUNTRY_WORDS = {
    "USA": ["United States", r"U\.S\.", r"US\b", "American"], "GBR": ["United Kingdom", "British", r"UK\b", "Britain",
    "Royal Navy", "Royal Air Force", "Royal Marines"], "CHN": [r"(?<!Republic of )China", "People's Republic of China",
    "Chinese", "People's Liberation Army"], "TWN": ["Taiwan", r"(?<!People's )Republic of China", r"\{\{ROC\b"], "KOR": ["South Korea",
    r"(?<!People's )Republic of Korea", r"ROK\b"], "PRK": ["North Korea", "Korean People's", "DPRK"], "RUS": ["Russia"],
    "FRA": ["France", "French"], "DEU": ["German"], "NLD": ["Netherlands", "Dutch"], "CHE": ["Swiss", "Switzerland"],
    "SWE": ["Swed"], "ESP": ["Spanish", "Spain"], "DNK": ["Danish", "Denmark"], "FIN": ["Finnish", "Finland"],
    "NOR": ["Norw"], "POL": ["Polish", "Poland"], "TUR": ["Turk", "Türkiye"], "GRC": ["Greek", "Greece", "Hellenic"],
    "JPN": ["Japan"], "THA": ["Thai"], "IRL": ["Irish", "Ireland"], "PRT": ["Portug"], "BEL": ["Belgi"],
    "MEX": ["Mexic"], "ARG": ["Argentin"], "PER": ["Peru"], "PHL": ["Philippin", "Filipino"], "MYS": ["Malaysia"],
    "VNM": ["Vietnam", "Viet Nam"], "CZE": ["Czech"], "SVK": ["Slovak"], "SAU": ["Saudi"], "ARE": ["United Arab Emirates",
    r"UAE\b", "Emirati"], "LBN": ["Leban"], "MAR": ["Morocc"], "UKR": ["Ukrain"], "KAZ": ["Kazakh"], "UZB": ["Uzbek"],
    "AFG": ["Afghan"], "MMR": ["Myanmar", "Burm"], "CIV": ["Ivory Coast", "Ivorian", "Côte d'Ivoire"],
    "COD": ["Democratic Republic of the Congo", "DR Congo", r"DRC\b"], "COG": ["Republic of the Congo"], "CHL": ["Chile", r"\{\{CHI\b"], "SGP": ["Singapore", r"\{\{SIN\b"],
    "NER": [r"Niger(?!ia)"], "NZL": ["New Zealand"], "ZAF": ["South Africa"], "BIH": ["Bosnia"], "IRN": ["Iran"],
}
FORMER = re.compile(r"(?i)former|past\b|retired|historic|previous|withdrawn|ex-")
NOT_CURRENT = re.compile(r"(?i)future|potential|planned|order|cancel|fail|evaluat|prospective|propos|\bbid|"
                         r"civil|commercial|airline|government|non-state|display|survivor|preserved|museum|accident")
HEAD = re.compile(r"(?m)^(=+)\s*(.*?)\s*\1\s*$")
LISTED = "Operators from the list article"


def country_re(iso, name):
    words = COUNTRY_WORDS.get(iso) or [re.escape(name)]
    return re.compile(r"(?<![A-Za-z])(?:" + "|".join(words) + r")|\{\{\s*" + iso + r"\s*[|}]")


def strip_wiki(s):
    s = re.sub(r"(?s)<!--.*?-->|<ref[^>/]*/>|<ref[^>]*>.*?</ref>", "", s)
    return re.sub(r"(?m)^\s*\[\[(?:File|Image):.*$|\{\{legend-inline[^}]*\}\}", "", s)


def operators(wt):
    """(current, former, split) text of the operator sections, or None when the article has none. split: the article
    says which operators are current, not one list that may mix in past ones."""
    parts = {"current": [], "former": [], "skip": [], "list": []}
    stack, found, split, heads = [], False, False, list(HEAD.finditer(wt))
    for i, h in enumerate(heads):
        level, title = len(h.group(1)), h.group(2)
        while stack and stack[-1][0] >= level:
            stack.pop()
        parent = stack[-1][1] if stack else None
        ops, now = re.search(r"(?i)\boperators?\b|\busers\b", title), re.search(r"(?i)\bcurrent\b|\bactive\b|in service", title)
        found = found or bool(ops)
        if title == LISTED:
            cls = "list"  # a separate list article: only its own current or former headings count, not one long list
        elif not (ops or parent):
            cls = None
        elif parent == "skip" or NOT_CURRENT.search(title):
            cls = "skip"
        elif FORMER.search(title):
            cls = "former"
        elif now or (ops and parent != "list"):
            cls = "current"
        else:
            cls = parent
        stack.append((level, cls))
        split = split or cls == "former" or bool(cls == "current" and now)
        if cls:
            body = wt[h.end():heads[i + 1].start() if i + 1 < len(heads) else len(wt)]
            # Lists without sub-headings switch with a bold or ";" line: ;Former operators
            for j, chunk in enumerate(re.split(r"(?im)^\s*(?:;|''')\s*((?:former|retired|past|future|potential)[^\n{]*)$", body)):
                if j % 2 == 0:
                    parts[cls if j == 0 else mode].append((";" + title if j == 0 and cls == parent else "") + "\n" + chunk)
                else:
                    mode = "skip" if NOT_CURRENT.search(chunk) else "former"
                    split = True
    return ("\n".join(parts["current"]), "\n".join(parts["former"]), bool(split)) if found else None


def field(wt, *names):
    """An infobox field's value, or None when the article has no such field."""
    for n in names:
        m = re.search(r"(?im)^\s*\|\s*" + n + r"\s*=(.*?)(?=^\s*\||^\s*\}\}|\Z)", wt, re.S | re.M)
        if m:
            return strip_wiki(m.group(1)).strip()
    return None


def in_service(wt, iso, name, ship, old=False):
    """True when Wikipedia shows the country using it now, False when it shows otherwise, None when it does not say.
    old: the type dates from before 1990, so one operator list with no current or former split proves nothing."""
    cre = country_re(iso, name)
    wt = strip_wiki(wt)
    if ship:  # one ship: its last career section must be this country's and not ended
        career = last_career(wt)
        if career is None:
            return None
        names = ("Ship country", "country", "Ship flag", "flag", "Ship operator", "operator")
        if not cre.search(" ".join(field(career, n) or "" for n in names)):
            return False
        ended = " ".join(field(career, n) or "" for n in ("Ship decommissioned", "decommissioned", "Ship fate", "fate",
                                                          "Ship captured", "captured"))
        status = field(career, "Ship status", "status") or ""
        return not (re.search(r"\w", ended) or re.search(r"(?i)decommission|scrap|sunk|sold|museum|reserve|laid up|"
                                                         r"retired|wreck|transferred|captured|seized|destroyed|unknown", status))
    status = field(wt, "status")
    if status and re.search(r"(?i)retired|out of service|withdrawn", status) and not re.search(r"(?i)in service|active|in use", status):
        return False
    active, retired = field(wt, "total_ships_active", "Ship active"), field(wt, "total_ships_retired", "Ship retired")
    if re.fullmatch(r"(?i)\W*(0|none|nil)?\W*", active or "") and retired:
        return False  # a class with ships retired and none listed as active
    if active and re.search(r"[A-Za-z]{3}", active):
        return bool(cre.search(active))
    users = field(wt, "operators", "Ship operators") or ""
    if active and re.search(r"[1-9]", active) and len(re.findall(r"\{\{|\[\[", users)) == 1 and cre.search(users):
        return True  # a class with one navy, still active
    ops = operators(wt)
    if not ops:
        return None
    current, former = (cre.search(leads(t)) for t in ops[:2])
    if current and not former:
        return True if ops[2] or not old else None
    return False if former else None


def last_career(wt):
    cut = [m.start() for m in re.finditer(r"(?i)infobox ship[ /]career", wt)]
    if not cut:
        return None
    career = wt[cut[-1]:]
    return career[:re.search(r"(?i)infobox ship[ /]characteristics|$", career).start()]


def ship_title(wt, label):
    """A ship sold on keeps its first name on Wikidata: show the name it serves under now."""
    name = (field(last_career(strip_wiki(wt)) or "", "Ship name", "name") or "").strip().split("\n")[0]
    name = re.sub(r"\s+", " ", re.sub(r"'{2,}|\{\{[^{}]*\}\}|\[\[|\]\]|\([^)]*\)|^\W+", "", name)).strip(" *,")
    a, b = name.lower(), label.lower()
    if not re.search(r"\w{3}", name) or len(name) > 40 or a in b or b in a or difflib.SequenceMatcher(None, a, b).ratio() > 0.75:
        return label
    return f"{name} (formerly {label})"


assert ship_title("{{Infobox ship/career\n|name = ''Swordsman''\n}}", "HSwMS Västergötland") == "Swordsman (formerly HSwMS Västergötland)"
assert ship_title("{{Infobox ship/career\n|name = ''Tubbataha''\n}}", "BRP Tubbataha") == "BRP Tubbataha"
assert ship_title("{{Infobox ship/career\n|name = *''Liaoning''\n * {{nobold|(辽宁)}}\n}}", "Chinese aircraft carrier Liaoning") == "Chinese aircraft carrier Liaoning"
assert ship_title("{{Infobox ship/career\n|name = {{lang|ru|x}} ()\n}}", "Admiral Kuznetsov") == "Admiral Kuznetsov"
assert ship_title("{{Infobox ship/career\n|name = EML Admiral Cowan (M313)\n}}", "EML Admiral Cowan") == "EML Admiral Cowan"
assert ship_title("{{Infobox ship/career\n|name = ''Lissus''\n}}", "Lisus") == "Lisus"


def leads(text):
    """What each list line starts with: the flag, link or name that says whose entry it is."""
    return "\n".join(re.findall(r"(?m)^\s*[;*#|]+\s*(\{\{[^{}]*\}\}|\[\[[^\]]*\]\]|[^\n–—:,(|{\[]+)", text))


_OPS = """==Operators==
[[File:Map.svg|thumb|Australia]]
;{{AUS}}
* [[Royal Australian Air Force]]
;{{flag|Pakistan}}
* [[Pakistan Air Force]]
===Former operators===
;{{flag|Switzerland}}
* [[Swiss Air Force]]
==Aircraft on display==
;{{CAN}}
"""
assert in_service(_OPS, "AUS", "Australia", False) and in_service(_OPS, "PAK", "Pakistan", False)
assert in_service(_OPS, "CHE", "Switzerland", False) is False and in_service(_OPS, "CAN", "Canada", False) is None
assert in_service(_OPS.replace("Switzerland}}", "Switzerland}}\n;{{AUS}}"), "AUS", "Australia", False) is False  # in both
assert in_service("==Operators==\n* {{flag|Belgium}}: 50 ex-British\n", "GBR", "United Kingdom", False) is None
assert in_service("no sections here", "CAN", "Canada", False) is None
assert in_service("==Operators==\n;{{CAN}}\n;{{MEX}}\n", "CAN", "Canada", False, old=True) is None
assert in_service("==Operators==\n===Current===\n;{{CAN}}\n", "CAN", "Canada", False, old=True)
_LIST = f"==Operators==\n;{{{{FRA}}}}\n={LISTED}=\n==Europe==\n;{{{{BEL}}}}\n==Mirage III operators==\n;{{{{GAB}}}}\n==Current operators==\n;{{{{PAK}}}}\n"
assert in_service(_LIST, "BEL", "Belgium", False) is None and in_service(_LIST, "GAB", "Gabon", False) is None
assert in_service(_LIST, "PAK", "Pakistan", False) and in_service(_LIST, "FRA", "France", False)
assert in_service("==Operators==\n===Civilian operators===\n;{{USA}}\n===Military===\n;{{CAN}}\n", "CAN", "Canada", False, old=True) is None
assert in_service("{{Infobox ship/class overview\n| total_ships_active = *2 (Egypt)\n*5 (Taiwan)\n| x = 1\n}}", "TWN", "Taiwan", False)
assert in_service("{{Infobox ship/class overview\n| total_ships_active = *2 (Egypt)\n| x = 1\n}}", "GRC", "Greece", False) is False
assert in_service("| total_ships_active = \n| total_ships_retired = 26\n}}", "CHL", "Chile", False) is False
_SHIP = "{{Infobox ship/career\n|country = Australia\n|operator = [[Royal Australian Navy]]\n|decommissioned = %s\n|status = %s\n}}"
assert in_service(_SHIP % ("", "{{Ship in active service}}"), "AUS", "Australia", True)
assert in_service(_SHIP % ("", "Active"), "NZL", "New Zealand", True) is False
assert in_service(_SHIP % ("2024", "Scrapped"), "AUS", "Australia", True) is False
assert country_re("NER", "Niger").search("Nigeria") is None and country_re("CHN", "China").search("Republic of China") is None
assert country_re("CHN", "China").search("People's Republic of China") and country_re("USA", "United States").search("{{USA}}")


def wiki_texts(items):
    """Item -> English Wikipedia wikitext, following one link to a separate 'List of ... operators' article."""
    titles = {}
    items = sorted(items)
    for i in range(0, len(items), 50):
        d = get(WIKIDATA, {"action": "wbgetentities", "format": "json", "props": "sitelinks", "sitefilter": "enwiki",
                           "ids": "|".join(items[i:i + 50])})
        for q, e in d.get("entities", {}).items():
            t = e.get("sitelinks", {}).get("enwiki", {}).get("title")
            if t:
                titles[q] = t
        time.sleep(0.5)

    def fetch(names):
        out, names = {}, sorted(set(names))
        for i in range(0, len(names), 20):
            d = get(WIKI, {"action": "query", "format": "json", "formatversion": "2", "redirects": "1", "prop": "revisions",
                           "rvprop": "content", "rvslots": "main", "titles": "|".join(names[i:i + 20])})
            q = d.get("query", {})
            back = {}
            for n in q.get("normalized", []) + q.get("redirects", []):
                back[n["to"]] = back.get(n["from"], n["from"])
            for p in q.get("pages", []):
                if p.get("revisions"):
                    out[back.get(p["title"], p["title"])] = p["revisions"][0]["slots"]["main"]["content"]
            time.sleep(0.5)
        return out

    text = fetch(titles.values())
    lists = {}
    for t, wt in text.items():
        m = re.search(r"(?i)\{\{\s*(?:main|further|see also)\s*\|\s*(list of [^}|]*operators[^}|]*)", wt)
        if m:
            lists[t] = m.group(1).strip()
    extra = fetch(lists.values())
    for t, lt in lists.items():
        if lt in extra:  # the list article's own headings sit under one heading that operators() knows
            text[t] += f"\n={LISTED}=\n" + extra[lt]
    return {q: text[t] for q, t in titles.items() if t in text}


def main():
    started = time.time()
    names = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"].values()
    isos = sorted({c["iso3"] for c in names if c.get("iso3")})
    qid_iso = countries(isos)
    force = forces(qid_iso)
    print(f"{len(force)} force items in {len({f['iso'] for f in force.values()})} countries")

    # Operators: every force item, and the country itself.
    op_iso = {q: f["iso"] for q, f in force.items()}
    op_iso.update(qid_iso)
    rows = operated(op_iso)
    equip = {}
    for r in rows:
        iso = op_iso[r["op"]]
        e = equip.setdefault(r["item"], {"item": r["item"], "title": r.get("en"), "sl": int(r["sl"]),
                                          "isos": set(), "files": set()})
        e["isos"].add(iso)
        e["files"].add(file_of(r["img"]))
    det = details(list(equip))
    print(f"{len(rows)} operator rows, {len(equip)} equipment items")

    # Equipment candidates per country.
    dropped = collections.Counter()
    cand = collections.defaultdict(list)
    for q, e in equip.items():
        d = det[q]
        title = e["title"]
        if not title or re.fullmatch(r"Q\d+", title) or q in DROP_ITEMS:
            dropped["no label"] += 1
            continue
        if d["gone"]:
            dropped["out of service"] += 1
            continue
        is_model = bool(d["types"] & set(MODEL_CLASSES))
        if is_model:
            if d["year"] is None or d["year"] < FIRST_YEAR:
                dropped["old or undated type"] += 1
                continue
        elif not d["ship_year"] or d["ship_year"] < SHIP_YEAR:
            dropped["old or undated ship"] += 1
            continue
        if any(NOT_EQUIPMENT.search(s) for s in d["labels"]):
            dropped["not equipment"] += 1
            continue
        k = equip_kind(sorted(d["labels"]), sorted(d["types"]))
        if not k:
            dropped["no kind"] += 1
            continue
        files = sorted(f for f in e["files"] if good_file(f))
        if not files:
            dropped["no photo file"] += 1
            continue
        for iso in e["isos"]:
            cand[iso].append({"item": q, "title": title, "kind": k[0], "cat": k[1], "sl": e["sl"], "files": files,
                              "supers": d["supers"], "ship": not is_model, "old": (d["year"] or 0) < 1990})

    # Keep only what English Wikipedia lists as in this country's service now.
    wt = wiki_texts({c["item"] for cs in cand.values() for c in cs})
    iso_name = {c["iso3"]: c["name"] for c in names if c.get("iso3")}
    for iso, cs in cand.items():
        keep = [c for c in cs if c["item"] in wt and in_service(wt[c["item"]], iso, iso_name.get(iso, iso), c["ship"], c["old"])]
        dropped["not shown in service on Wikipedia"] += len(cs) - len(keep)
        cs[:] = [{**c, "title": ship_title(wt[c["item"]], c["title"])} if c["ship"] else c for c in keep]
    print("equipment dropped:", dict(dropped))

    fcand = collections.defaultdict(list)
    for q, f in force.items():
        kind = force_kind(f["types"])
        files = sorted(x for x in f["files"] if good_file(x))
        if not kind or not files or not f["title"] or (kind == "Branch" and f["sl"] < BRANCH_MIN_SL):
            continue
        fcand[f["iso"]].append({**f, "kind": kind, "files": files})

    info = commons({x for c in list(cand.values()) + list(fcand.values()) for e in c for x in e["files"]})
    print(f"{len(info)} files checked on Commons")

    out = {}
    for iso in isos:
        used = set()
        forces_out = []
        # The armed forces as a whole first, then branches by standing.
        for f in sorted(fcand.get(iso, []), key=lambda f: (f["kind"] != "Armed forces", -f["sl"])):
            p = next((photo(x, f["title"], f["kind"], info) for x in f["files"]
                      if info.get(x, {}).get("descriptionurl") not in used and photo(x, f["title"], f["kind"], info)), None)
            if p:
                used.add(p["page"])
                forces_out.append(p)
            if len(forces_out) == MAX_FORCES:
                break
        # A specific model (Su-30MKI) beats its family (Su-30) when the country has both.
        cs = cand.get(iso, [])
        parents = {s for c in cs for s in c["supers"]}
        cs = [c for c in cs if c["item"] not in parents]
        by_cat = collections.defaultdict(list)
        for c in sorted(cs, key=lambda c: -c["sl"]):
            by_cat[c["cat"]].append(c)
        # Take categories in turn (air, sea, land, missile) so the grid is varied.
        chosen, titles = [], []
        queues = [by_cat[k] for k in ("air", "sea", "land", "missile")]
        while len(chosen) < MAX_EQUIPMENT and any(queues):
            for qu in queues:
                while qu:
                    c = qu.pop(0)
                    if any(same_subject(c["title"], t) for t in titles):
                        continue
                    p = next((photo(x, c["title"], c["kind"], info) for x in c["files"]
                              if info.get(x, {}).get("descriptionurl") not in used and photo(x, c["title"], c["kind"], info)), None)
                    if p:
                        used.add(p["page"])
                        titles.append(c["title"])
                        chosen.append(p)
                        break
                if len(chosen) == MAX_EQUIPMENT:
                    break
        if forces_out or chosen:
            out[iso] = {"forces": forces_out, "equipment": chosen}

    # Self-checks: a changed source format or a bad join shows up here.
    assert len(out) >= 120, len(out)
    for iso in ("USA", "RUS", "CHN", "IND", "FRA"):
        assert len(out[iso]["equipment"]) >= 5 and out[iso]["forces"], iso
    assert not any(p["title"].startswith("Afghan National Army") for p in out.get("AFG", {}).get("forces", []))
    for iso, rec in out.items():
        ps = rec["forces"] + rec["equipment"]
        assert len({p["page"] for p in ps}) == len(ps), iso
        assert len(rec["forces"]) <= MAX_FORCES and len(rec["equipment"]) <= MAX_EQUIPMENT, iso
        assert all(p["title"] and p["kind"] and p["author"] and p["licence"] for p in ps), iso
        assert all(p["img"].startswith("https://upload.wikimedia.org/") and "?" not in p["img"] for p in ps), iso
        assert not any(p["img"].lower().endswith(".svg") for p in ps), iso

    data = {"built": datetime.date.today().isoformat(), "countries": out}
    path = ROOT / "data" / "security-photos.json"
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    nf = sum(bool(r["forces"]) for r in out.values())
    ne = sum(bool(r["equipment"]) for r in out.values())
    tf = sum(len(r["forces"]) for r in out.values())
    te = sum(len(r["equipment"]) for r in out.values())
    print(f"wrote {path} ({path.stat().st_size / 1e6:.2f} MB; {len(out)} countries; forces in {nf} ({tf} photos), "
          f"equipment in {ne} ({te} photos); {time.time() - started:.0f} s)")


if __name__ == "__main__":
    main()

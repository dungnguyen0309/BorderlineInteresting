"""Build data/symbols.json: each country's flag and coat of arms (or emblem, or seal), where it has one.

Sources: Wikidata (CC0) names the files, flag image (P41) and coat of arms image (P94); Wikimedia Commons gives
each file's licence, author and a 640 px rendering. Only freely licensed files are kept. Flags keep their true
proportions. Standard library only. Run after build_data.py:  python scripts/build_symbols.py
"""
import datetime
import json
import pathlib
import re
import sys
import urllib.parse

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from build_photos import ALIAS, BACK, COMMONS, ROOT, author, get, licence, sparql  # noqa: E402

PROPS = {"P41": "flag", "P94": "arms"}


def files(isos, prop):
    """ISO3 -> Commons file name: no end date first, then preferred rank, then the oldest item (the country itself)."""
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""SELECT ?iso ?c ?file ?rank ?end WHERE {{
      VALUES ?iso {{ {values} }} ?c wdt:P298 ?iso; p:{prop} ?st. ?st ps:{prop} ?file; wikibase:rank ?rank.
      OPTIONAL {{ ?st pq:P582 ?end }} FILTER(?rank != wikibase:DeprecatedRank) }}""")
    best = {}
    for r in rows:
        key = ("end" in r, not r["rank"].endswith("PreferredRank"), int(r["c"].lstrip("Q")))
        iso = BACK.get(r["iso"], r["iso"])
        if iso not in best or key < best[iso][0]:
            best[iso] = (key, urllib.parse.unquote(r["file"].rsplit("/", 1)[-1]).replace("_", " "))
    return {iso: f for iso, (_, f) in best.items()}


def commons(names):
    """File name -> imageinfo (640 px url, size, extmetadata), 50 titles a request."""
    out, names = {}, sorted(set(names))
    for i in range(0, len(names), 50):
        q = get(COMMONS, {"action": "query", "format": "json", "prop": "imageinfo", "iiprop": "url|size|extmetadata",
                          "iiurlwidth": "640", "titles": "|".join("File:" + n for n in names[i:i + 50])})["query"]
        back = {n["to"]: n["from"] for n in q.get("normalized", [])}
        for p in q["pages"].values():
            if p.get("imageinfo"):
                out[back.get(p["title"], p["title"]).removeprefix("File:")] = p["imageinfo"][0]
    return out


def kind(file):
    return "Emblem" if re.search(r"(?i)emblem", file) else "Seal" if re.search(r"(?i)\bseal\b", file) else "Crest" if re.search(r"(?i)\bcrest\b|\bkamon\b", file) else "Coat of arms"


def arms_names(isos):
    """ISO3 -> English name of the country's coat of arms item (P237), which names emblems and seals as such."""
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""SELECT ?iso ?label WHERE {{ VALUES ?iso {{ {values} }} ?c wdt:P298 ?iso; wdt:P237 ?a.
      ?a rdfs:label ?label. FILTER(lang(?label) = "en") }}""")
    return {BACK.get(r["iso"], r["iso"]): r["label"] for r in rows}


assert kind("Emblem of Vietnam.svg") == "Emblem" and kind("Coat of arms of Chad.svg") == "Coat of arms" and kind("Imperial crest of Japan") == "Crest"


def main():
    countries = json.loads((ROOT / "data/countries.json").read_text(encoding="utf-8"))["countries"].values()
    names = {c["iso3"]: c["name"] for c in countries if c.get("iso3")}  # shapes with no code (-99) have no symbols
    picked = {prop: files(list(names), prop) for prop in PROPS}
    arms = arms_names(list(names))
    info = commons([f for got in picked.values() for f in got.values()])
    out, dropped = {}, []
    for iso, name in names.items():
        row = []
        for prop, slot in PROPS.items():
            f = picked[prop].get(iso)
            ii = info.get(f) if f else None
            meta = ii.get("extmetadata", {}) if ii else {}
            # Two free licences national symbols use that the photo rules do not list.
            short = meta.get("LicenseShortName", {}).get("value", "")
            lic = ii and (licence(meta) or (short if short in ("Attribution", "OGL-om 1.0") else None))
            if f and not lic:
                dropped.append(f"{iso} {slot}: {f}")
            if not lic:
                continue
            k = "Flag" if slot == "flag" else kind(arms.get(iso, f))
            who = author(meta)
            row.append({"kind": k, "title": f"{k} of {name}", "img": ii["thumburl"].split("?")[0], "page": ii["descriptionurl"],
                        "author": "" if who.startswith("See File history") else who, "licence": lic,
                        "w": ii["thumbwidth"], "h": ii["thumbheight"]})
        if row:
            out[iso] = row
    (ROOT / "data/symbols.json").write_text(json.dumps({"built": datetime.date.today().isoformat(), "countries": out},
                                                       ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    flags = sum(any(s["kind"] == "Flag" for s in r) for r in out.values())
    print(f"{len(out)} of {len(names)} countries; {flags} flags, {sum(len(r) for r in out.values()) - flags} arms or emblems")
    for d in dropped:
        print("  not free or not found:", d)


if __name__ == "__main__":
    main()

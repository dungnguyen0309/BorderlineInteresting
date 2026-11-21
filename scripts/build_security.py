"""Fill data/security.json with the CIA World Factbook's Military and Security fields per country.

The nuclear lists and the sources at the top of data/security.json are curated by hand and kept as they are;
this script rewrites only "countries" (Factbook text), "factbookDate" and the NPT parties list, which it
derives from the curated non-parties and the UN members and observer states in data/countries.json.
Source: the CIA World Factbook (public domain) through the factbook/factbook.json mirror. Standard library only.
Run after build_data.py:  python scripts/build_security.py
"""
import concurrent.futures
import html
import json
import pathlib
import re

from build_profiles import ALIAS, BACK, FACTBOOK_RAW, FACTBOOK_TREE, FIPS_FALLBACK, get, sparql, val

ROOT = pathlib.Path(__file__).resolve().parent.parent
PATH = ROOT / "data" / "security.json"
FIELDS = {
    "forces": "Military and security forces",
    "personnel": "Military and security service personnel strengths",
    "equipment": "Military equipment inventories and acquisitions",
    "service": "Military service age and obligation",
    "deploy": "Military deployments",
}
YEAR = re.compile(r"\s*\((\d{4}(?:-\d{2,4})?)(?: est\.?)?\)\s*$")


def clean(s):
    """Factbook HTML to plain text: paragraphs become new lines and tags go."""
    s = re.sub(r"(<br\s*/?>\s*)+", "\n", s or "")
    s = html.unescape(re.sub(r"<[^>]+>", "", s)).replace("\xa0", " ")
    s = re.sub(r"\s*—\s*|\s+–\s+", ", ", s)  # no em dashes (or spaced en dashes) in the app's text; a comma reads the same
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in s.split("\n") if line.strip())


def entry(field):
    text = clean(field.get("text"))
    if not text or re.fullmatch(r"(estimates )?not available", text, re.I):
        return None
    rec = {"text": text}
    m = YEAR.search(text)
    if m:
        rec["text"], rec["year"] = text[: m.start()].rstrip(" ;,"), m.group(1)
    notes = [re.sub(r"^note( \d+)?:\s*", "", n, flags=re.I) for n in clean(field.get("note")).split("\n") if n]
    if notes:
        rec["notes"] = notes
    return rec


def military(fb):
    sec = fb.get("Military and Security") or {}
    out = {}
    for key, name in FIELDS.items():
        e = entry(sec.get(name) or {})
        if e:
            out[key] = e
    return out


def fips_codes(isos):
    values = " ".join(f'"{ALIAS.get(i, i)}"' for i in isos)
    rows = sparql(f"""
SELECT ?iso ?fips WHERE {{
  VALUES ?iso {{ {values} }}
  ?c wdt:P298 ?iso ; wdt:P901 ?fips . FILTER NOT EXISTS {{ ?c wdt:P576 ?dissolved }}
}}""")
    out = {}
    for r in rows:
        out.setdefault(BACK.get(val(r, "iso"), val(r, "iso")), val(r, "fips").upper())
    return {**{k: v for k, v in FIPS_FALLBACK.items() if k in isos}, **out}


def write(data):
    """Curated keys stay indented for hand editing; each country's Factbook text is one line."""
    head = {k: v for k, v in data.items() if k != "countries"}
    body = ",\n".join(f"  {json.dumps(k)}: {json.dumps(v, ensure_ascii=False, separators=(',', ':'))}" for k, v in sorted(data["countries"].items()))
    text = json.dumps(head, ensure_ascii=False, indent=1)[:-2] + ',\n "countries": {\n' + body + "\n }\n}\n"
    json.loads(text)  # the hand-built join must still be valid JSON
    PATH.write_bytes(text.encode("utf-8"))


# Self-checks on the cleaner, from real Factbook strings.
assert entry({"text": "approximately 185,000 active-duty military personnel (2025)"}) == {"text": "approximately 185,000 active-duty military personnel", "year": "2025"}
assert entry({"text": "a<br><br>b (2024 est.)", "note": "<strong>note 1:</strong> x<br><br><strong>note 2: </strong>y"}) == {"text": "a\nb", "year": "2024", "notes": ["x", "y"]}
assert entry({"text": "estimates not available"}) is None
assert clean("Coast Guard—under the Navy") == "Coast Guard, under the Navy"
assert clean("three forces – the Federal Police – have") == "three forces, the Federal Police, have" and clean("1990–2000") == "1990–2000"


def main():
    data = json.loads(PATH.read_text(encoding="utf-8"))
    countries = json.loads((ROOT / "data" / "countries.json").read_text(encoding="utf-8"))["countries"].values()
    isos = sorted({c["iso3"] for c in countries if c.get("iso3")})

    npt = data["nuclear"]["npt"]
    outside = set(npt["nonParties"]) | set(npt["withdrew"])
    npt["parties"] = sorted(c["iso3"] for c in countries if c.get("status") in ("un", "observer") and c["iso3"] not in outside)

    fips = {}
    for i in range(0, len(isos), 80):
        fips.update(fips_codes(isos[i:i + 80]))
    tree = get(FACTBOOK_TREE)["tree"]
    fb_path = {pathlib.PurePosixPath(t["path"]).stem.upper(): t["path"] for t in tree
               if t["path"].endswith(".json") and "/" in t["path"]}
    commit = get("https://api.github.com/repos/factbook/factbook.json/commits/master")
    data["factbookDate"] = commit["commit"]["committer"]["date"][:10]

    def build(iso):
        code = fips.get(iso)
        if not code or code not in fb_path:
            return iso, {}
        try:
            return iso, military(get(FACTBOOK_RAW + fb_path[code]))
        except Exception as e:  # one missing file should not stop the build
            print("no factbook entry for", iso, e)
            return iso, {}

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        data["countries"] = {iso: rec for iso, rec in pool.map(build, isos) if rec}
    out = data["countries"]

    # Self-checks: a changed source format or a bad join shows up here.
    assert len(npt["parties"]) == 189, len(npt["parties"])  # 190 in the treaty; Tuvalu is not on this map
    assert "Bundeswehr" in out["DEU"]["forces"]["text"] and out["DEU"]["service"]["notes"]
    assert "People's Army of Vietnam" in out["VNM"]["forces"]["text"]
    assert "UNISFA" in out["VNM"]["deploy"]["text"]
    assert not any(d in json.dumps(r, ensure_ascii=False) for r in out.values() for d in ("—", " – "))
    assert sum("forces" in r for r in out.values()) >= 170

    write(data)
    counts = {k: sum(k in r for r in out.values()) for k in FIELDS}
    print(f"wrote {PATH} ({len(out)} countries; {counts}; {PATH.stat().st_size // 1024} KB; Factbook {data['factbookDate']})")


if __name__ == "__main__":
    main()
